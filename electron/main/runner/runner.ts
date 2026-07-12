import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type {
  Capabilities,
  CompileRequest,
  CompileResult,
  DiagnoseMemoryResult,
  DiagnoseRequest,
  DiagnoseResult,
  FixtureInput,
  MemoryStageResult,
  RunRequest,
  RunnerError,
  RunnerMode,
  RunResult,
} from "../../../src/shared/api.js";
import { RUNNER_LIMITS, type RunnerLimits } from "../../../src/shared/limits.js";
import { fingerprintSource } from "../../../src/shared/source-snapshot.js";
import type {
  TraceBatch,
  TraceCancelResult,
  TraceRequest,
  TraceRunEvidence,
  TraceStartResult,
  TraceUnsupportedReason,
} from "../../../src/shared/trace.js";
import { ArtifactRegistry, type ArtifactRuntimeProfile } from "./artifact-registry.js";
import { cleanupStaleWorkDirectories } from "./stale-cleanup.js";
import {
  capabilitiesWithoutProbe,
  COMPILE_EXECUTION_PROFILE,
  DEFAULT_DEVELOPER_ROOT,
  DEFAULT_SUPPORTED_APPLE_CLANG_SANITIZER_RUNTIME,
  detectSupportedAppleClang,
  LEAKS_EXECUTION_PROFILE,
  RUN_EXECUTION_PROFILE,
  SANITIZER_RUN_PROFILE,
  SANDBOX_EXEC_PATH,
  SystemCapabilityProbe,
  toolchainIdentifier,
  type CapabilityProbe,
  type SeatbeltProbeResult,
  type ToolchainDetector,
} from "./capability.js";
import { RunnerFailure } from "./errors.js";
import { parseClangDiagnostics } from "./clang-diagnostics.js";
import {
  SYSTEM_CLOCK,
  SystemProcessHost,
  type ManagedChildProcess,
  type ProcessHost,
  type RunnerClock,
  type SpawnSpecification,
} from "./process-host.js";
import {
  superviseProcess,
  type ProcessObserver,
  type ProcessOutcome,
  type SupervisionLimits,
} from "./supervisor.js";
import { instrumentTraceSource } from "./trace-instrumentation.js";
import {
  TraceProtocolParser,
  TraceSessionRegistry,
  type TraceSessionHandle,
} from "./trace-session.js";
import { validateTraceRequest, type ValidatedTraceRequest } from "./trace-request.js";
import {
  validateCompileRequest,
  validateDiagnoseRequest,
  validateRunRequest,
  validateWritableFiles,
  type ValidatedCompileRequest,
  type ValidatedDiagnoseRequest,
  type ValidatedFixture,
  type ValidatedRunRequest,
} from "./validation.js";

const CLANG_PATH = "/usr/bin/clang";
const BASH_PATH = "/bin/bash";
const EXECUTABLE_NAME = "program";
const LIMITS_SCRIPT_NAME = "runner-limits.sh";
const TEMP_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o700;
const LEAKS_PATH = "/usr/bin/leaks";
const LEAKS_ARGUMENTS = Object.freeze(["--quiet", "--nostacks", "--noContent", "--atExit", "--"]);
const LEAKS_NORMAL_EXIT_REAP_GRACE_MS = 250;
const VERIFIABLE_NON_ZERO_LEAK_REPORT =
  /\b[1-9][0-9]* leaks? for [1-9][0-9]* total leaked bytes\b/iu;

const LIMITS_SCRIPT = `#!/bin/bash
set -o errexit
set -o nounset
umask 077
ulimit -t "$1"
ulimit -f "$2"
ulimit -n "$3"
shift 3
exec "$@"
`;

type ExecutionStrategy = "seatbelt" | "trusted";
export type TrustedOperation = "compile" | "run" | "diagnose" | "trace";

declare const trustedExecutionGrantBrand: unique symbol;

export interface TrustedExecutionGrant {
  readonly [trustedExecutionGrantBrand]: "TrustedExecutionGrant";
}

export interface TrustedRequestSummary {
  readonly operation: TrustedOperation;
  readonly requestDigest: string;
  readonly detailLines: readonly string[];
}

export type VerificationCompilePreset = "asan-ubsan" | "plain";
export type VerificationRunMode = "direct" | "leaks";

export interface VerificationRunRequest {
  readonly artifactId: string;
  readonly args?: readonly string[];
  readonly stdin: Uint8Array;
  readonly fixtures?: readonly FixtureInput[];
  readonly writableFiles: readonly string[];
  readonly mode: VerificationRunMode;
}

export interface VerificationRunResult extends RunResult {
  readonly leakCheck?: {
    readonly ok: boolean;
    readonly verdict: "clean" | "finding" | "tool-error";
    readonly summary: string;
  };
}

interface TrustedGrantRecord {
  readonly operation: TrustedOperation;
  readonly requestDigest: string;
}

export interface RunnerOptions {
  readonly mode?: RunnerMode;
  readonly limits?: Partial<RunnerLimits>;
  readonly clock?: RunnerClock;
  readonly processHost?: ProcessHost;
  readonly capabilityProbe?: CapabilityProbe;
  readonly toolchainDetector?: ToolchainDetector;
  readonly idGenerator?: () => string;
  readonly traceIdGenerator?: () => string;
  readonly tempRoot?: string;
}

export class Runner {
  readonly #mode: RunnerMode;
  readonly #limits: RunnerLimits;
  readonly #clock: RunnerClock;
  readonly #processHost: ProcessHost;
  readonly #capabilityProbe: CapabilityProbe;
  readonly #artifactRegistry: ArtifactRegistry;
  readonly #tempRoot: string;
  readonly #clangPath: string;
  readonly #sdkPath: string | undefined;
  readonly #developerRootPath: string;
  readonly #sanitizerRuntimePath: string;
  readonly #toolchainId: string;
  readonly #trustedGrants = new WeakMap<TrustedExecutionGrant, TrustedGrantRecord>();
  readonly #traceSessions = new TraceSessionRegistry();
  readonly #traceIdGenerator: () => string;
  readonly #activeProcesses = new Map<number, ManagedChildProcess>();
  readonly #activeWorkDirectories = new Set<string>();
  readonly #staleCleanupPromise: Promise<number>;
  #probePromise: Promise<SeatbeltProbeResult> | undefined;
  #acceptingRequests = true;
  #activeTask = false;
  #activeTaskCompletion: Promise<void> | undefined;
  #resolveActiveTask: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(options: RunnerOptions = {}) {
    const requestedMode = options.mode ?? "seatbelt-best-effort";
    const toolchain = (options.toolchainDetector ?? detectSupportedAppleClang)();
    this.#mode = toolchain.available ? requestedMode : "disabled";
    this.#toolchainId = toolchainIdentifier(toolchain, this.#mode);
    this.#clangPath = toolchain.executablePath ?? CLANG_PATH;
    this.#sdkPath = toolchain.sdkPath;
    this.#developerRootPath = toolchain.developerRootPath ?? DEFAULT_DEVELOPER_ROOT;
    this.#sanitizerRuntimePath =
      toolchain.sanitizerRuntimePath ?? DEFAULT_SUPPORTED_APPLE_CLANG_SANITIZER_RUNTIME;
    this.#limits = Object.freeze({ ...RUNNER_LIMITS, ...options.limits });
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#processHost = options.processHost ?? new SystemProcessHost();
    this.#capabilityProbe =
      options.capabilityProbe ?? new SystemCapabilityProbe({ detectToolchain: () => toolchain });
    this.#tempRoot = realpathSync(options.tempRoot ?? tmpdir());
    this.#staleCleanupPromise = cleanupStaleWorkDirectories(this.#tempRoot, {
      activeDirectories: this.#activeWorkDirectories,
    });
    this.#artifactRegistry = new ArtifactRegistry(this.#limits, {
      clock: this.#clock,
      idGenerator: options.idGenerator ?? (() => randomBytes(24).toString("base64url")),
    });
    this.#traceIdGenerator =
      options.traceIdGenerator ?? (() => `trace_${randomBytes(24).toString("base64url")}`);
  }

  async getCapabilities(): Promise<Capabilities> {
    await this.#staleCleanupPromise;
    if (this.#mode !== "seatbelt-best-effort") {
      return capabilitiesWithoutProbe(this.#mode, this.#toolchainId);
    }
    const probe = await this.#getSeatbeltProbe();
    return Object.freeze({
      mode: this.#mode,
      runnerEnabled: true,
      toolchainId: this.#toolchainId,
      seatbeltProbe: Object.freeze({
        status: probe.status,
        detail: probe.detail,
      }),
      requiresNativeTrustConfirmation: probe.status === "unavailable",
    });
  }

  describeTrustedRequest(operation: "compile", request: CompileRequest): TrustedRequestSummary;
  describeTrustedRequest(operation: "run", request: RunRequest): TrustedRequestSummary;
  describeTrustedRequest(operation: "diagnose", request: DiagnoseRequest): TrustedRequestSummary;
  describeTrustedRequest(operation: "trace", request: TraceRequest): TrustedRequestSummary;
  describeTrustedRequest(
    operation: TrustedOperation,
    request: CompileRequest | RunRequest | DiagnoseRequest | TraceRequest,
  ): TrustedRequestSummary {
    this.#assertAcceptingRequests();
    if (operation === "compile") {
      return compileRequestSummary(validateCompileRequest(request, this.#limits));
    }
    if (operation === "run") {
      return runRequestSummary(validateRunRequest(request, this.#limits));
    }
    if (operation === "diagnose") {
      return diagnoseRequestSummary(validateDiagnoseRequest(request, this.#limits));
    }
    return traceRequestSummary(validateTraceRequest(request, this.#limits));
  }

  createTrustedExecutionGrant(operation: "compile", request: CompileRequest): TrustedExecutionGrant;
  createTrustedExecutionGrant(operation: "run", request: RunRequest): TrustedExecutionGrant;
  createTrustedExecutionGrant(
    operation: "diagnose",
    request: DiagnoseRequest,
  ): TrustedExecutionGrant;
  createTrustedExecutionGrant(operation: "trace", request: TraceRequest): TrustedExecutionGrant;
  createTrustedExecutionGrant(
    operation: TrustedOperation,
    request: CompileRequest | RunRequest | DiagnoseRequest | TraceRequest,
  ): TrustedExecutionGrant {
    this.#assertAcceptingRequests();
    const requestDigest =
      operation === "compile"
        ? fingerprintCompileRequest(validateCompileRequest(request, this.#limits))
        : operation === "run"
          ? fingerprintRunRequest(validateRunRequest(request, this.#limits))
          : operation === "diagnose"
            ? fingerprintDiagnoseRequest(validateDiagnoseRequest(request, this.#limits))
            : fingerprintTraceRequest(validateTraceRequest(request, this.#limits));
    const grant = Object.freeze({}) as TrustedExecutionGrant;
    this.#trustedGrants.set(grant, Object.freeze({ operation, requestDigest }));
    return grant;
  }

  async compile(
    request: CompileRequest,
    trustedGrant?: TrustedExecutionGrant,
  ): Promise<CompileResult> {
    let releaseTask: (() => void) | undefined;
    try {
      const validated = validateCompileRequest(request, this.#limits);
      const trustedAuthorized = this.#consumeTrustedGrant(
        "compile",
        fingerprintCompileRequest(validated),
        trustedGrant,
      );
      releaseTask = this.#acquireTask();
      await this.#staleCleanupPromise;
      const strategy = await this.#resolveExecutionStrategy(trustedAuthorized);
      return await this.#compileValidated(
        validated.source,
        validated.sourceName,
        strategy,
        "normal",
      );
    } catch (error) {
      return compileFailure(error, "");
    } finally {
      releaseTask?.();
    }
  }

  async run(request: RunRequest, trustedGrant?: TrustedExecutionGrant): Promise<RunResult> {
    let releaseTask: (() => void) | undefined;
    try {
      const validated = validateRunRequest(request, this.#limits);
      const trustedAuthorized = this.#consumeTrustedGrant(
        "run",
        fingerprintRunRequest(validated),
        trustedGrant,
      );
      releaseTask = this.#acquireTask();
      await this.#staleCleanupPromise;
      const strategy = await this.#resolveExecutionStrategy(trustedAuthorized);
      return await this.#runValidated(
        validated.artifactId,
        validated.args,
        Buffer.from(validated.stdin, "utf8"),
        validated.fixtures,
        strategy,
        "direct",
        Object.freeze([]),
      );
    } catch (error) {
      return runFailure(error);
    } finally {
      releaseTask?.();
    }
  }

  async startTrace(
    request: TraceRequest,
    trustedGrant?: TrustedExecutionGrant,
  ): Promise<TraceStartResult> {
    let releaseTask: (() => void) | undefined;
    try {
      const validated = validateTraceRequest(request, this.#limits);
      const trustedAuthorized = this.#consumeTrustedGrant(
        "trace",
        fingerprintTraceRequest(validated),
        trustedGrant,
      );
      releaseTask = this.#acquireTask();
      await this.#staleCleanupPromise;
      const strategy = await this.#resolveExecutionStrategy(trustedAuthorized);
      const protocolNonce = randomBytes(18).toString("hex");
      const instrumentation = instrumentTraceSource(
        validated.source,
        validated.sourceFingerprint,
        validated.sourceName,
        protocolNonce,
      );
      if (!instrumentation.ok) {
        return traceUnsupportedFailure(instrumentation.reason);
      }
      const sessionId = this.#traceIdGenerator();
      const session = this.#traceSessions.create(sessionId, validated.sourceFingerprint);
      const backgroundRelease = releaseTask;
      releaseTask = undefined;
      void this.#executeTraceSession(
        session,
        validated,
        instrumentation.value.source,
        instrumentation.value.protocolNonce,
        instrumentation.value.instrumentedLines,
        strategy,
      ).finally(backgroundRelease);
      return Object.freeze({
        ok: true,
        sessionId,
        sourceFingerprint: validated.sourceFingerprint,
        status: "preparing",
      });
    } catch (error) {
      return traceStartFailure(error);
    } finally {
      releaseTask?.();
    }
  }

  readTrace(sessionId: string, afterSequence: number): TraceBatch {
    this.#assertAcceptingRequests();
    return this.#traceSessions.read(sessionId, afterSequence);
  }

  cancelTrace(sessionId: string): TraceCancelResult {
    this.#assertAcceptingRequests();
    const previousStatus = this.#traceSessions.getStatus(sessionId);
    const result = this.#traceSessions.cancel(sessionId);
    if (result.ok && (previousStatus === "preparing" || previousStatus === "running")) {
      this.#cancelActiveProcesses();
    }
    return result;
  }

  async diagnose(
    request: DiagnoseRequest,
    trustedGrant?: TrustedExecutionGrant,
  ): Promise<DiagnoseResult> {
    let releaseTask: (() => void) | undefined;
    let rawDiagnostics = "";
    try {
      const validated = validateDiagnoseRequest(request, this.#limits);
      const trustedAuthorized = this.#consumeTrustedGrant(
        "diagnose",
        fingerprintDiagnoseRequest(validated),
        trustedGrant,
      );
      releaseTask = this.#acquireTask();
      await this.#staleCleanupPromise;
      const strategy = await this.#resolveExecutionStrategy(trustedAuthorized);
      const syntax = await this.#diagnoseSyntaxValidated(validated, strategy);
      rawDiagnostics = syntax.rawDiagnostics;
      if (!syntax.ok) return syntax;
      if (validated.runtime === null) return Object.freeze({ ...syntax, memory: null });
      if (syntax.hasErrors) {
        return Object.freeze({
          ...syntax,
          memory: Object.freeze({ status: "skipped" as const, reason: "static-errors" as const }),
        });
      }
      const memory = await this.#runMemoryChecks(validated, strategy);
      return Object.freeze({ ...syntax, memory });
    } catch (error) {
      return diagnoseFailure(error, rawDiagnostics);
    } finally {
      releaseTask?.();
    }
  }

  async compileForVerification(
    request: CompileRequest,
    preset: VerificationCompilePreset,
  ): Promise<CompileResult> {
    let releaseTask: (() => void) | undefined;
    try {
      const validated = validateCompileRequest(request, this.#limits);
      releaseTask = this.#acquireTask();
      await this.#staleCleanupPromise;
      const strategy = await this.#resolveExecutionStrategy(false);
      return await this.#compileValidated(validated.source, validated.sourceName, strategy, preset);
    } catch (error) {
      return compileFailure(error, "");
    } finally {
      releaseTask?.();
    }
  }

  async runForVerification(request: VerificationRunRequest): Promise<VerificationRunResult> {
    let releaseTask: (() => void) | undefined;
    try {
      if (!(request.stdin instanceof Uint8Array)) {
        throw new RunnerFailure("INVALID_REQUEST", "verification stdin 必须是 Uint8Array。");
      }
      if (request.stdin.byteLength > this.#limits.maxStdinBytes) {
        throw new RunnerFailure("INVALID_REQUEST", "标准输入超过大小限制。");
      }
      if (request.mode !== "direct" && request.mode !== "leaks") {
        throw new RunnerFailure("INVALID_REQUEST", "verification run mode 无效。");
      }
      const validated = validateRunRequest(
        {
          artifactId: request.artifactId,
          args: request.args,
          fixtures: request.fixtures,
        },
        this.#limits,
      );
      const writableFiles = validateWritableFiles(request.writableFiles, this.#limits);
      releaseTask = this.#acquireTask();
      await this.#staleCleanupPromise;
      const strategy = await this.#resolveExecutionStrategy(false);
      return await this.#runValidated(
        validated.artifactId,
        validated.args,
        Uint8Array.from(request.stdin),
        validated.fixtures,
        strategy,
        request.mode,
        writableFiles,
      );
    } catch (error) {
      return runFailure(error);
    } finally {
      releaseTask?.();
    }
  }

  async cleanupExpiredArtifacts(): Promise<number> {
    return this.#artifactRegistry.cleanupExpired();
  }

  dispose(): Promise<void> {
    this.#acceptingRequests = false;
    this.#disposePromise ??= this.#disposeInternal();
    return this.#disposePromise;
  }

  async #disposeInternal(): Promise<void> {
    this.#cancelActiveProcesses();
    const activeTaskCompletion = this.#activeTaskCompletion;
    if (activeTaskCompletion !== undefined) {
      await activeTaskCompletion;
    }
    let staleCleanupError: unknown;
    try {
      await this.#staleCleanupPromise;
    } catch (error) {
      staleCleanupError = error;
    }
    await this.#artifactRegistry.dispose();
    this.#traceSessions.clear();
    if (staleCleanupError !== undefined) {
      throw staleCleanupError;
    }
  }

  async #executeTraceSession(
    session: TraceSessionHandle,
    request: ValidatedTraceRequest,
    shadowSource: string,
    protocolNonce: string,
    instrumentedLines: readonly number[],
    strategy: ExecutionStrategy,
  ): Promise<void> {
    let artifactId: string | undefined;
    try {
      if (session.cancelRequested) return;
      const compileResult = await this.#compileValidated(
        shadowSource,
        request.sourceName,
        strategy,
        "normal",
      );
      if (!compileResult.ok) {
        session.fail(compileResult.error);
        return;
      }
      artifactId = compileResult.artifactId;
      if (session.cancelRequested) return;
      session.setRunning();
      const startedAtMs = this.#clock.now();
      const parser = new TraceProtocolParser({
        protocolNonce,
        startedAtMs,
        clock: this.#clock,
        allowedLines: new Set(instrumentedLines),
        onEvent: (event) => {
          const accepted = session.append(event);
          if (!accepted) this.#cancelActiveProcesses();
          return accepted;
        },
        onProtocolError: (message) => {
          session.fail(Object.freeze({ code: "TRACE_PROTOCOL_ERROR", message }));
          this.#cancelActiveProcesses();
        },
      });
      const runResult = await this.#runValidated(
        artifactId,
        request.args,
        Buffer.from(request.stdin, "utf8"),
        request.fixtures,
        strategy,
        "direct",
        Object.freeze([]),
        { onStderr: (chunk) => parser.push(chunk) },
      );
      parser.finish();
      if (session.cancelRequested || session.status !== "running") return;
      if (!runResult.ok) {
        session.fail(
          runResult.error ??
            Object.freeze({ code: "INTERNAL_ERROR", message: "Trace 程序未成功完成。" }),
        );
        return;
      }
      const evidence: TraceRunEvidence = Object.freeze({
        ok: runResult.ok,
        exitCode: runResult.exitCode,
        signal: runResult.signal,
        termination: runResult.termination,
        durationMs: runResult.durationMs,
        peakRssBytes: runResult.peakRssBytes ?? 0,
        peakProcessCount: runResult.peakProcessCount ?? 0,
        outputBytes: Math.max(
          0,
          (runResult.outputBytes ?? runResult.stdout.byteLength + runResult.stderr.byteLength) -
            parser.protocolBytes,
        ),
        executedNodeCount: session.uniqueLineCount,
        operationCount: session.eventCount,
      });
      session.complete(evidence);
    } catch (error) {
      session.fail(toRunnerError(error));
    } finally {
      if (artifactId !== undefined) {
        try {
          await this.#artifactRegistry.discard(artifactId);
        } catch {
          // ArtifactRegistry records its cleanup error; never leave a rejected background promise.
        }
      }
    }
  }

  async #compileValidated(
    source: string,
    sourceName: string,
    strategy: ExecutionStrategy,
    preset: "normal" | VerificationCompilePreset,
  ): Promise<CompileResult> {
    const workDirectory = await this.#createPrivateTempDirectory("compile-");
    let registryOwnsDirectory = false;
    let diagnostics = "";
    let compileDurationMs = 0;

    try {
      const sourcePath = join(workDirectory, sourceName);
      const executablePath = join(workDirectory, EXECUTABLE_NAME);
      const limitsScriptPath = join(workDirectory, LIMITS_SCRIPT_NAME);
      await writeFile(sourcePath, source, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      await this.#writeLimitsScript(limitsScriptPath);

      const specification = this.#buildSpawnSpecification(
        workDirectory,
        limitsScriptPath,
        this.#clangPath,
        compilerArguments(sourceName, preset, this.#sdkPath),
        strategy,
        COMPILE_EXECUTION_PROFILE,
        Object.freeze({
          TEMPROOT: this.#tempRoot,
          DEVROOT: this.#developerRootPath,
        }),
      );
      const outcome = await this.#superviseProcess(specification, new Uint8Array(), {
        wallTimeMs: this.#limits.compileWallTimeMs,
        maxOutputBytes: this.#limits.maxOutputBytes,
        maxRssBytes: this.#limits.maxRssBytes,
        maxProcessCount: this.#limits.maxProcessCount,
        rssPollIntervalMs: this.#limits.rssPollIntervalMs,
      });
      compileDurationMs = outcome.durationMs;
      diagnostics = compilerDiagnostics(outcome);
      if (
        outcome.termination !== "process-exit" ||
        outcome.exitCode !== 0 ||
        outcome.processControlFailed
      ) {
        return compileProcessFailure(outcome, diagnostics);
      }

      await access(executablePath, constants.X_OK);
      await chmod(executablePath, PRIVATE_EXECUTABLE_MODE);
      await unlink(sourcePath);
      await unlink(limitsScriptPath);

      const artifact = await this.#artifactRegistry.register(
        workDirectory,
        executablePath,
        runtimeProfileForPreset(preset),
      );
      registryOwnsDirectory = true;
      return Object.freeze({
        ok: true,
        artifactId: artifact.id,
        expiresAtMs: artifact.expiresAtMs,
        diagnostics,
        compileDurationMs,
      });
    } catch (error) {
      return compileFailure(error, diagnostics, compileDurationMs);
    } finally {
      if (!registryOwnsDirectory) {
        await removeDirectory(workDirectory);
      }
      this.#activeWorkDirectories.delete(workDirectory);
    }
  }

  async #runValidated(
    artifactId: string,
    args: readonly string[],
    stdin: Uint8Array,
    fixtures: readonly ValidatedFixture[],
    strategy: ExecutionStrategy,
    mode: VerificationRunMode,
    writableFiles: readonly string[],
    observer?: ProcessObserver,
  ): Promise<VerificationRunResult> {
    const workDirectory = await this.#createPrivateTempDirectory("run-");

    try {
      const lease = await this.#artifactRegistry.acquire(artifactId);
      let artifactRuntimeProfile: ArtifactRuntimeProfile;
      const executablePath = join(workDirectory, EXECUTABLE_NAME);
      const limitsScriptPath = join(workDirectory, LIMITS_SCRIPT_NAME);
      try {
        await copyFile(lease.executablePath, executablePath);
        await chmod(executablePath, PRIVATE_EXECUTABLE_MODE);
        artifactRuntimeProfile = lease.runtimeProfile;
      } finally {
        await lease.release();
      }
      if (mode === "leaks" && artifactRuntimeProfile === "sanitizer") {
        throw new RunnerFailure(
          "INVALID_REQUEST",
          "leaks 必须使用独立 plain 构建，拒绝 sanitizer 制品。",
        );
      }

      await this.#writeFixtures(workDirectory, fixtures);
      await this.#prepareWritableFiles(workDirectory, writableFiles);
      await this.#writeLimitsScript(limitsScriptPath);
      const targetCommand = mode === "leaks" ? LEAKS_PATH : executablePath;
      const targetArguments =
        mode === "leaks" ? [...LEAKS_ARGUMENTS, executablePath, ...args] : args;
      const executionProfile = executionProfileForRun(mode, artifactRuntimeProfile);
      const specification = this.#buildSpawnSpecification(
        workDirectory,
        limitsScriptPath,
        targetCommand,
        targetArguments,
        strategy,
        executionProfile,
        executionProfile === SANITIZER_RUN_PROFILE
          ? Object.freeze({
              SANITIZER_RUNTIME: this.#sanitizerRuntimePath,
            })
          : undefined,
      );
      const outcome = await this.#superviseProcess(
        specification,
        stdin,
        {
          wallTimeMs: this.#limits.runWallTimeMs,
          maxOutputBytes: this.#limits.maxOutputBytes,
          maxRssBytes: this.#limits.maxRssBytes,
          maxProcessCount: this.#limits.maxProcessCount,
          rssPollIntervalMs: this.#limits.rssPollIntervalMs,
          ...(mode === "leaks" ? { normalExitReapGraceMs: LEAKS_NORMAL_EXIT_REAP_GRACE_MS } : {}),
        },
        observer,
      );

      const programStdout = outcome.stdout;
      const programStderr = outcome.stderr;
      const outputLimitExceeded =
        programStdout.byteLength + programStderr.byteLength > this.#limits.maxOutputBytes;
      const leakCheck = mode === "leaks" ? makeLeakCheck(outcome) : undefined;
      const processError = processOutcomeError(outcome, "程序运行失败。");
      const error = outputLimitExceeded
        ? Object.freeze({
            code: "RESOURCE_LIMIT" as const,
            message: "程序输出超过资源限制。",
          })
        : (processError ??
          (leakCheck !== undefined && !leakCheck.ok
            ? Object.freeze({
                code: "LEAK_CHECK_FAILED" as const,
                message:
                  leakCheck.verdict === "finding"
                    ? "leaks 发现内存泄漏。"
                    : "leaks 工具未正常完成。",
              })
            : undefined));
      const reportedStdout = outputLimitExceeded
        ? programStdout.subarray(0, this.#limits.maxOutputBytes)
        : programStdout;
      const reportedStderr = outputLimitExceeded ? new Uint8Array() : programStderr;
      const base = {
        ok:
          !outputLimitExceeded &&
          outcome.termination === "process-exit" &&
          outcome.exitCode === 0 &&
          !outcome.processControlFailed &&
          (leakCheck?.ok ?? true),
        stdout: reportedStdout,
        stderr: reportedStderr,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        termination: outputLimitExceeded ? "output-limit" : outcome.termination,
        durationMs: outcome.durationMs,
        peakRssBytes: outcome.peakRssBytes,
        peakProcessCount: outcome.peakProcessCount,
        outputBytes: reportedStdout.byteLength + reportedStderr.byteLength,
        executedNodeCount: null,
        operationCount: null,
      } as const;
      const withLeakCheck = leakCheck === undefined ? base : { ...base, leakCheck };
      return error === undefined
        ? Object.freeze(withLeakCheck)
        : Object.freeze({ ...withLeakCheck, error });
    } finally {
      await removeDirectory(workDirectory);
      this.#activeWorkDirectories.delete(workDirectory);
    }
  }

  async #diagnoseSyntaxValidated(
    request: ValidatedDiagnoseRequest,
    strategy: ExecutionStrategy,
  ): Promise<DiagnoseResult> {
    const workDirectory = await this.#createPrivateTempDirectory("diagnose-");
    let rawDiagnostics = "";
    try {
      const sourcePath = join(workDirectory, request.sourceName);
      const limitsScriptPath = join(workDirectory, LIMITS_SCRIPT_NAME);
      await writeFile(sourcePath, request.source, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      await this.#writeLimitsScript(limitsScriptPath);
      const specification = this.#buildSpawnSpecification(
        workDirectory,
        limitsScriptPath,
        this.#clangPath,
        syntaxCompilerArguments(request.sourceName, this.#sdkPath),
        strategy,
        COMPILE_EXECUTION_PROFILE,
        Object.freeze({
          TEMPROOT: this.#tempRoot,
          DEVROOT: this.#developerRootPath,
        }),
      );
      const outcome = await this.#superviseProcess(specification, new Uint8Array(), {
        wallTimeMs: this.#limits.compileWallTimeMs,
        maxOutputBytes: this.#limits.maxOutputBytes,
        maxRssBytes: this.#limits.maxRssBytes,
        maxProcessCount: this.#limits.maxProcessCount,
        rssPollIntervalMs: this.#limits.rssPollIntervalMs,
      });
      rawDiagnostics = compilerDiagnostics(outcome);
      const processError = processOutcomeError(outcome, "C 静态诊断失败。");
      if (
        processError !== undefined ||
        outcome.termination !== "process-exit" ||
        (outcome.exitCode !== 0 && outcome.exitCode !== 1)
      ) {
        return diagnoseFailure(
          processError ?? new RunnerFailure("COMPILE_FAILED", "clang 静态诊断未正常完成。"),
          rawDiagnostics,
        );
      }
      const diagnostics = parseClangDiagnostics(rawDiagnostics, request.sourceName, request.source);
      return Object.freeze({
        ok: true,
        sourceFingerprint: fingerprintSource(request.source),
        compilerExitCode: outcome.exitCode,
        hasErrors:
          outcome.exitCode === 1 ||
          diagnostics.some(
            (diagnostic) =>
              diagnostic.severity === "error" || diagnostic.severity === "fatal-error",
          ),
        diagnostics,
        rawDiagnostics,
        memory: null,
      });
    } catch (error) {
      return diagnoseFailure(error, rawDiagnostics);
    } finally {
      await removeDirectory(workDirectory);
      this.#activeWorkDirectories.delete(workDirectory);
    }
  }

  async #runMemoryChecks(
    request: ValidatedDiagnoseRequest,
    strategy: ExecutionStrategy,
  ): Promise<Extract<DiagnoseMemoryResult, { readonly status: "completed" }>> {
    const runtime = request.runtime;
    if (runtime === null) throw new TypeError("内存诊断缺少 runtime 输入");

    const sanitizerCompile = await this.#compileValidated(
      request.source,
      request.sourceName,
      strategy,
      "asan-ubsan",
    );
    const sanitizerArtifactId = requireCompileArtifact(sanitizerCompile, "sanitizer 构建失败。");
    let sanitizerRun: VerificationRunResult;
    try {
      sanitizerRun = await this.#runValidated(
        sanitizerArtifactId,
        runtime.args,
        Buffer.from(runtime.stdin, "utf8"),
        runtime.fixtures,
        strategy,
        "direct",
        Object.freeze([]),
      );
    } finally {
      await this.#artifactRegistry.discard(sanitizerArtifactId);
    }
    const sanitizer = memoryStageFromSanitizer(sanitizerRun);

    await this.#assertLeaksPositiveControl(strategy);

    const plainCompile = await this.#compileValidated(
      request.source,
      request.sourceName,
      strategy,
      "plain",
    );
    const plainArtifactId = requireCompileArtifact(plainCompile, "plain 泄漏检查构建失败。");
    let leaksRun: VerificationRunResult;
    try {
      leaksRun = await this.#runValidated(
        plainArtifactId,
        runtime.args,
        Buffer.from(runtime.stdin, "utf8"),
        runtime.fixtures,
        strategy,
        "leaks",
        Object.freeze([]),
      );
    } finally {
      await this.#artifactRegistry.discard(plainArtifactId);
    }
    const leaks = Object.freeze({
      ...memoryStageFromLeaks(leaksRun),
      positiveControl: "passed" as const,
    });
    return Object.freeze({
      status: "completed",
      clean: sanitizer.verdict === "clean" && leaks.verdict === "clean",
      sanitizer,
      leaks,
    });
  }

  async #assertLeaksPositiveControl(strategy: ExecutionStrategy): Promise<void> {
    const source = [
      "#include <stdlib.h>",
      "int main(void) {",
      "  void *p = malloc(32);",
      "  return p == 0;",
      "}",
    ].join("\n");
    const compiled = await this.#compileValidated(source, "leak-control.c", strategy, "plain");
    const artifactId = requireCompileArtifact(compiled, "leaks 正控构建失败。");
    let result: VerificationRunResult;
    try {
      result = await this.#runValidated(
        artifactId,
        Object.freeze([]),
        new Uint8Array(),
        Object.freeze([]),
        strategy,
        "leaks",
        Object.freeze([]),
      );
    } finally {
      await this.#artifactRegistry.discard(artifactId);
    }
    const leakCheck = result.leakCheck;
    if (
      result.termination !== "process-exit" ||
      result.exitCode !== 1 ||
      result.signal !== null ||
      leakCheck?.verdict !== "finding" ||
      !hasVerifiableNonZeroLeakReport(leakCheck.summary)
    ) {
      throw new RunnerFailure(
        "LEAK_CHECK_FAILED",
        "leaks 正控未检出故意泄漏，拒绝相信本次零泄漏结果。",
      );
    }
  }

  async #resolveExecutionStrategy(trustedAuthorized: boolean): Promise<ExecutionStrategy> {
    if (this.#mode === "disabled") {
      throw new RunnerFailure("RUNNER_DISABLED", "运行器已被禁用。");
    }
    if (this.#mode === "trusted-only") {
      if (!trustedAuthorized) {
        throw new RunnerFailure(
          "TRUST_CONFIRMATION_REQUIRED",
          "当前模式只允许运行经本机原生对话框确认的可信代码。",
        );
      }
      return "trusted";
    }

    const probe = await this.#getSeatbeltProbe();
    if (probe.status === "probe-succeeded") {
      return "seatbelt";
    }
    if (!trustedAuthorized) {
      throw new RunnerFailure(
        "TRUST_CONFIRMATION_REQUIRED",
        "嵌套沙箱不可用；必须在本机原生对话框中确认当前请求。",
      );
    }
    return "trusted";
  }

  async #getSeatbeltProbe(): Promise<SeatbeltProbeResult> {
    this.#probePromise ??= this.#capabilityProbe.probe().catch(() => ({
      status: "unavailable" as const,
      detail: "当前环境无法启动嵌套 sandbox-exec；默认拒绝运行。",
    }));
    return this.#probePromise;
  }

  #assertAcceptingRequests(): void {
    if (!this.#acceptingRequests) {
      throw new RunnerFailure("RUNNER_SHUTTING_DOWN", "应用正在退出，运行器不再接受新任务。");
    }
  }

  #acquireTask(): () => void {
    this.#assertAcceptingRequests();
    if (this.#activeTask) {
      throw new RunnerFailure("RUNNER_BUSY", "运行器正忙；当前仅允许一个编译或运行任务。");
    }

    this.#activeTask = true;
    this.#activeTaskCompletion = new Promise<void>((resolve) => {
      this.#resolveActiveTask = resolve;
    });
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#activeTask = false;
      const resolve = this.#resolveActiveTask;
      this.#resolveActiveTask = undefined;
      this.#activeTaskCompletion = undefined;
      resolve?.();
    };
  }

  #consumeTrustedGrant(
    operation: TrustedOperation,
    requestDigest: string,
    grant: TrustedExecutionGrant | undefined,
  ): boolean {
    if (grant === undefined) {
      return false;
    }
    const record = this.#trustedGrants.get(grant);
    if (record === undefined) {
      return false;
    }
    this.#trustedGrants.delete(grant);
    return record.operation === operation && record.requestDigest === requestDigest;
  }

  async #superviseProcess(
    specification: SpawnSpecification,
    input: Uint8Array,
    limits: SupervisionLimits,
    observer?: ProcessObserver,
  ): Promise<ProcessOutcome> {
    this.#assertAcceptingRequests();
    let processGroupId: number | undefined;
    const trackingHost: ProcessHost = {
      spawn: (spawnSpecification) => {
        const child = this.#processHost.spawn(spawnSpecification);
        if (child.pid !== undefined && child.pid > 1) {
          processGroupId = child.pid;
          this.#activeProcesses.set(child.pid, child);
        }
        return child;
      },
      killProcessGroup: (groupId, signal) => this.#processHost.killProcessGroup(groupId, signal),
      isProcessGroupAlive: (groupId) => this.#processHost.isProcessGroupAlive(groupId),
      sampleProcessGroupResources: (groupId) =>
        this.#processHost.sampleProcessGroupResources(groupId),
    };

    try {
      return await superviseProcess(
        specification,
        input,
        limits,
        {
          clock: this.#clock,
          processHost: trackingHost,
        },
        observer,
      );
    } finally {
      if (processGroupId !== undefined) {
        this.#activeProcesses.delete(processGroupId);
      }
    }
  }

  #cancelActiveProcesses(): void {
    for (const [processGroupId, child] of this.#activeProcesses) {
      try {
        this.#processHost.killProcessGroup(processGroupId, "SIGKILL");
      } catch {
        // The direct child fallback below still runs.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // dispose waits for the existing supervisor to settle.
      }
    }
  }

  #buildSpawnSpecification(
    workDirectory: string,
    limitsScriptPath: string,
    targetCommand: string,
    targetArguments: readonly string[],
    strategy: ExecutionStrategy,
    seatbeltProfile: string,
    seatbeltParameters: Readonly<Record<string, string>> = Object.freeze({}),
  ): SpawnSpecification {
    const limitedArguments = [
      limitsScriptPath,
      String(this.#limits.cpuTimeSeconds),
      String(this.#limits.maxFileSizeBlocks),
      String(this.#limits.maxOpenFiles),
      targetCommand,
      ...targetArguments,
    ];
    const command = strategy === "seatbelt" ? SANDBOX_EXEC_PATH : BASH_PATH;
    const args =
      strategy === "seatbelt"
        ? [
            "-D",
            `WORKDIR=${workDirectory}`,
            ...Object.entries(seatbeltParameters).flatMap(([name, value]) => [
              "-D",
              `${name}=${value}`,
            ]),
            "-p",
            seatbeltProfile,
            BASH_PATH,
            ...limitedArguments,
          ]
        : limitedArguments;

    return Object.freeze({
      command,
      args: Object.freeze(args),
      cwd: workDirectory,
      env: minimalEnvironment(workDirectory),
      detached: true,
      shell: false,
    });
  }

  async #createPrivateTempDirectory(prefix: string): Promise<string> {
    const createdDirectory = await mkdtemp(join(this.#tempRoot, `c-block-${prefix}`));
    try {
      const directory = await realpath(createdDirectory);
      await chmod(directory, TEMP_DIRECTORY_MODE);
      this.#activeWorkDirectories.add(directory);
      return directory;
    } catch (error) {
      await removeDirectory(createdDirectory);
      throw error;
    }
  }

  async #writeLimitsScript(path: string): Promise<void> {
    await writeFile(path, LIMITS_SCRIPT, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_EXECUTABLE_MODE,
    });
  }

  async #prepareWritableFiles(
    workDirectory: string,
    writableFiles: readonly string[],
  ): Promise<void> {
    for (const writableFile of writableFiles) {
      const targetPath = resolve(workDirectory, writableFile);
      if (!targetPath.startsWith(`${workDirectory}${sep}`)) {
        throw new RunnerFailure("INVALID_REQUEST", "writableFiles path 超出运行目录。");
      }
      await mkdir(dirname(targetPath), {
        mode: TEMP_DIRECTORY_MODE,
        recursive: true,
      });
    }
  }

  async #writeFixtures(
    workDirectory: string,
    fixtures: readonly ValidatedFixture[],
  ): Promise<void> {
    for (const fixture of fixtures) {
      const targetPath = resolve(workDirectory, fixture.path);
      if (!targetPath.startsWith(`${workDirectory}${sep}`)) {
        throw new RunnerFailure("INVALID_REQUEST", "fixture path 超出运行目录。");
      }
      await mkdir(dirname(targetPath), {
        mode: TEMP_DIRECTORY_MODE,
        recursive: true,
      });
      await writeFile(targetPath, fixture.contents, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
    }
  }
}

function compilerArguments(
  sourceName: string,
  preset: "normal" | VerificationCompilePreset,
  sdkPath: string | undefined,
): readonly string[] {
  const sanitizerFlags =
    preset === "asan-ubsan" ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : [];
  return Object.freeze([
    "-std=c17",
    "-fintegrated-cc1",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-fno-color-diagnostics",
    "-O0",
    "-g0",
    ...(sdkPath === undefined ? [] : ["-isysroot", sdkPath]),
    ...sanitizerFlags,
    "-o",
    EXECUTABLE_NAME,
    sourceName,
  ]);
}

function syntaxCompilerArguments(
  sourceName: string,
  sdkPath: string | undefined,
): readonly string[] {
  return Object.freeze([
    "-std=c17",
    "-fintegrated-cc1",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-fno-color-diagnostics",
    "-O0",
    "-g0",
    ...(sdkPath === undefined ? [] : ["-isysroot", sdkPath]),
    "-fsyntax-only",
    sourceName,
  ]);
}

function runtimeProfileForPreset(
  preset: "normal" | VerificationCompilePreset,
): ArtifactRuntimeProfile {
  return preset === "asan-ubsan" ? "sanitizer" : "standard";
}

function executionProfileForRun(
  mode: VerificationRunMode,
  artifactRuntimeProfile: ArtifactRuntimeProfile,
): string {
  if (mode === "leaks") {
    return LEAKS_EXECUTION_PROFILE;
  }
  return artifactRuntimeProfile === "sanitizer" ? SANITIZER_RUN_PROFILE : RUN_EXECUTION_PROFILE;
}

function makeLeakCheck(outcome: ProcessOutcome): {
  readonly ok: boolean;
  readonly verdict: "clean" | "finding" | "tool-error";
  readonly summary: string;
} {
  const reportBytes = Buffer.concat([Buffer.from(outcome.stderr), Buffer.from(outcome.stdout)]);
  const summary = new TextDecoder("utf-8", { fatal: false }).decode(reportBytes).trim();
  // `leaks(1)` defines exit 0 as "No leaks were detected". On macOS 27,
  // successful --atExit runs can omit the numeric footer entirely, so the
  // exit status is the contract. The acceptance gate separately runs a known
  // leaking positive control so a broken/no-op analysis cannot pass silently.
  const verdict =
    outcome.termination === "process-exit" && !outcome.processControlFailed
      ? outcome.exitCode === 0
        ? "clean"
        : outcome.exitCode === 1
          ? "finding"
          : "tool-error"
      : "tool-error";
  return Object.freeze({
    ok: verdict === "clean",
    verdict,
    summary: summary.length > 0 ? summary : "leaks 未返回可验证报告。",
  });
}

function hasVerifiableNonZeroLeakReport(summary: string): boolean {
  return VERIFIABLE_NON_ZERO_LEAK_REPORT.test(summary);
}

function requireCompileArtifact(result: CompileResult, message: string): string {
  if (!result.ok) throw new RunnerFailure(result.error.code, `${message} ${result.error.message}`);
  return result.artifactId;
}

function memoryStageFromSanitizer(result: VerificationRunResult): MemoryStageResult {
  assertMemoryRunInfrastructure(result);
  const stderr = decodeBytes(result.stderr);
  const stdout = decodeBytes(result.stdout);
  const report = [stderr, stdout].filter((part) => part.length > 0).join("\n");
  const hasFinding = /(?:AddressSanitizer|UndefinedBehaviorSanitizer|runtime error:)/u.test(stderr);
  const verdict = hasFinding ? "finding" : result.exitCode === 0 ? "clean" : "inconclusive";
  return Object.freeze({
    verdict,
    stdout: Uint8Array.from(result.stdout),
    stderr: Uint8Array.from(result.stderr),
    exitCode: result.exitCode,
    signal: result.signal,
    termination: result.termination,
    durationMs: result.durationMs,
    summary:
      report.trim().length > 0
        ? report.trim()
        : verdict === "clean"
          ? "ASan/UBSan 未报告内存或未定义行为问题。"
          : "程序非零退出，但未出现可识别的 sanitizer 报告。",
  });
}

function memoryStageFromLeaks(result: VerificationRunResult): MemoryStageResult {
  assertMemoryRunInfrastructure(result);
  const leakCheck = result.leakCheck;
  if (leakCheck === undefined || leakCheck.verdict === "tool-error") {
    throw new RunnerFailure("LEAK_CHECK_FAILED", "leaks 工具未正常完成。");
  }
  return Object.freeze({
    verdict: leakCheck.verdict === "clean" ? "clean" : "finding",
    stdout: Uint8Array.from(result.stdout),
    stderr: Uint8Array.from(result.stderr),
    exitCode: result.exitCode,
    signal: result.signal,
    termination: result.termination,
    durationMs: result.durationMs,
    summary: leakCheck.summary,
  });
}

function assertMemoryRunInfrastructure(result: VerificationRunResult): void {
  if (
    result.termination !== "process-exit" ||
    result.error?.code === "RESOURCE_LIMIT" ||
    result.error?.code === "PROCESS_CONTROL_FAILED" ||
    result.error?.code === "PROCESS_SPAWN_FAILED" ||
    result.error?.code === "INTERNAL_ERROR"
  ) {
    throw new RunnerFailure(
      result.error?.code ?? "INTERNAL_ERROR",
      result.error?.message ?? "内存检查进程未正常完成。",
    );
  }
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function compileRequestSummary(request: ValidatedCompileRequest): TrustedRequestSummary {
  const requestDigest = fingerprintCompileRequest(request);
  return Object.freeze({
    operation: "compile",
    requestDigest,
    detailLines: Object.freeze([
      "操作：编译 C 源码",
      `源文件：${request.sourceName}`,
      `源码大小：${Buffer.byteLength(request.source, "utf8")} UTF-8 字节`,
      `请求 SHA-256：${requestDigest}`,
    ]),
  });
}

function runRequestSummary(request: ValidatedRunRequest): TrustedRequestSummary {
  const requestDigest = fingerprintRunRequest(request);
  const fixtureLines = request.fixtures.map(
    (fixture) => `fixture：${fixture.path}（${fixture.contents.byteLength} 字节）`,
  );
  return Object.freeze({
    operation: "run",
    requestDigest,
    detailLines: Object.freeze([
      "操作：运行已编译程序",
      `artifactId：${request.artifactId}`,
      `参数：${JSON.stringify(request.args)}`,
      `标准输入：${Buffer.byteLength(request.stdin, "utf8")} UTF-8 字节`,
      ...fixtureLines,
      `请求 SHA-256：${requestDigest}`,
    ]),
  });
}

function diagnoseRequestSummary(request: ValidatedDiagnoseRequest): TrustedRequestSummary {
  const requestDigest = fingerprintDiagnoseRequest(request);
  const runtime = request.runtime;
  return Object.freeze({
    operation: "diagnose",
    requestDigest,
    detailLines: Object.freeze([
      runtime === null ? "操作：clang 静态诊断" : "操作：完整诊断（clang + ASan/UBSan + leaks）",
      `源文件：${request.sourceName}`,
      `源码大小：${Buffer.byteLength(request.source, "utf8")} UTF-8 字节`,
      ...(runtime === null
        ? []
        : [
            `参数：${JSON.stringify(runtime.args)}`,
            `标准输入：${Buffer.byteLength(runtime.stdin, "utf8")} UTF-8 字节`,
            `fixtures：${String(runtime.fixtures.length)} 个`,
          ]),
      `请求 SHA-256：${requestDigest}`,
    ]),
  });
}

function traceRequestSummary(request: ValidatedTraceRequest): TrustedRequestSummary {
  const requestDigest = fingerprintTraceRequest(request);
  return Object.freeze({
    operation: "trace",
    requestDigest,
    detailLines: Object.freeze([
      "操作：编译并运行一次临时影子 Trace",
      `源文件：${request.sourceName}`,
      `源码指纹：${request.sourceFingerprint}`,
      `源码大小：${Buffer.byteLength(request.source, "utf8")} UTF-8 字节`,
      `参数：${JSON.stringify(request.args)}`,
      `标准输入：${Buffer.byteLength(request.stdin, "utf8")} UTF-8 字节`,
      `fixtures：${String(request.fixtures.length)} 个`,
      `请求 SHA-256：${requestDigest}`,
    ]),
  });
}

function fingerprintCompileRequest(request: ValidatedCompileRequest): string {
  const hash = createHash("sha256");
  updateFingerprint(hash, "compile");
  updateFingerprint(hash, request.sourceName);
  updateFingerprint(hash, request.source);
  return hash.digest("hex");
}

function fingerprintRunRequest(request: ValidatedRunRequest): string {
  const hash = createHash("sha256");
  updateFingerprint(hash, "run");
  updateFingerprint(hash, request.artifactId);
  updateFingerprint(hash, String(request.args.length));
  for (const argument of request.args) {
    updateFingerprint(hash, argument);
  }
  updateFingerprint(hash, request.stdin);
  updateFingerprint(hash, String(request.fixtures.length));
  for (const fixture of request.fixtures) {
    updateFingerprint(hash, fixture.path);
    updateFingerprint(hash, fixture.contents);
  }
  return hash.digest("hex");
}

function fingerprintDiagnoseRequest(request: ValidatedDiagnoseRequest): string {
  const hash = createHash("sha256");
  updateFingerprint(hash, "diagnose");
  updateFingerprint(hash, request.sourceName);
  updateFingerprint(hash, request.source);
  updateFingerprint(hash, request.runtime === null ? "static" : "memory");
  if (request.runtime !== null) {
    updateFingerprint(hash, String(request.runtime.args.length));
    request.runtime.args.forEach((argument) => updateFingerprint(hash, argument));
    updateFingerprint(hash, request.runtime.stdin);
    updateFingerprint(hash, String(request.runtime.fixtures.length));
    for (const fixture of request.runtime.fixtures) {
      updateFingerprint(hash, fixture.path);
      updateFingerprint(hash, fixture.contents);
    }
  }
  return hash.digest("hex");
}

function fingerprintTraceRequest(request: ValidatedTraceRequest): string {
  const hash = createHash("sha256");
  updateFingerprint(hash, "trace");
  updateFingerprint(hash, request.sourceName);
  updateFingerprint(hash, request.sourceFingerprint);
  updateFingerprint(hash, request.source);
  updateFingerprint(hash, String(request.args.length));
  for (const argument of request.args) updateFingerprint(hash, argument);
  updateFingerprint(hash, request.stdin);
  updateFingerprint(hash, String(request.fixtures.length));
  for (const fixture of request.fixtures) {
    updateFingerprint(hash, fixture.path);
    updateFingerprint(hash, fixture.contents);
  }
  return hash.digest("hex");
}

function updateFingerprint(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function minimalEnvironment(workDirectory: string): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: workDirectory,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: workDirectory,
  });
}

function compilerDiagnostics(outcome: ProcessOutcome): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return [outcome.stderr, outcome.stdout]
    .filter((part) => part.byteLength > 0)
    .map((part) => decoder.decode(part))
    .join("\n");
}

function compileProcessFailure(outcome: ProcessOutcome, diagnostics: string): CompileResult {
  const error =
    processOutcomeError(outcome, "C 编译失败。") ??
    Object.freeze({ code: "COMPILE_FAILED" as const, message: "C 编译失败。" });
  return Object.freeze({
    ok: false,
    diagnostics,
    compileDurationMs: outcome.durationMs,
    error,
  });
}

function processOutcomeError(
  outcome: ProcessOutcome,
  fallbackMessage: string,
): RunnerError | undefined {
  if (outcome.processControlFailed) {
    return Object.freeze({
      code: "PROCESS_CONTROL_FAILED",
      message: "无法确认进程组已被完整终止。",
    });
  }
  if (outcome.termination === "spawn-error") {
    return Object.freeze({
      code: "PROCESS_SPAWN_FAILED",
      message: "无法启动本地进程。",
    });
  }
  if (outcome.termination === "input-error") {
    return Object.freeze({ code: "INTERNAL_ERROR", message: "写入标准输入失败。" });
  }
  if (
    outcome.termination === "wall-time-limit" ||
    outcome.termination === "output-limit" ||
    outcome.termination === "rss-limit" ||
    outcome.termination === "process-count-limit" ||
    outcome.termination === "rss-monitor-error"
  ) {
    return Object.freeze({
      code: "RESOURCE_LIMIT",
      message:
        outcome.termination === "rss-monitor-error"
          ? "资源看门狗不可用，已停止进程。"
          : "进程超过资源限制，已停止。",
    });
  }
  if (outcome.termination === "process-exit" && outcome.exitCode !== 0) {
    return undefined;
  }
  if (outcome.termination !== "process-exit") {
    return Object.freeze({ code: "INTERNAL_ERROR", message: fallbackMessage });
  }
  return undefined;
}

function compileFailure(error: unknown, diagnostics: string, compileDurationMs = 0): CompileResult {
  const runnerError = toRunnerError(error);
  return Object.freeze({ ok: false, diagnostics, compileDurationMs, error: runnerError });
}

function traceUnsupportedFailure(reason: TraceUnsupportedReason): TraceStartResult {
  return Object.freeze({
    ok: false,
    unsupported: Object.freeze({ ...reason }),
    error: Object.freeze({ code: "TRACE_UNSUPPORTED", message: reason.message }),
  });
}

function traceStartFailure(cause: unknown): TraceStartResult {
  const runnerError =
    cause instanceof Error && cause.message === "Trace session capacity reached"
      ? Object.freeze({ code: "TRACE_LIMIT" as const, message: "Trace session 数量达到上限。" })
      : toRunnerError(cause);
  return Object.freeze({ ok: false, unsupported: null, error: runnerError });
}

function diagnoseFailure(error: unknown, rawDiagnostics: string): DiagnoseResult {
  return Object.freeze({
    ok: false,
    rawDiagnostics,
    error: toRunnerError(error),
  });
}

function runFailure(error: unknown): RunResult {
  return Object.freeze({
    ok: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    exitCode: null,
    signal: null,
    termination: "not-started",
    durationMs: 0,
    peakRssBytes: 0,
    peakProcessCount: 0,
    outputBytes: 0,
    executedNodeCount: null,
    operationCount: null,
    error: toRunnerError(error),
  });
}

function toRunnerError(error: unknown): RunnerError {
  if (error instanceof RunnerFailure) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  return Object.freeze({ code: "INTERNAL_ERROR", message: "运行器内部错误。" });
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true });
}
