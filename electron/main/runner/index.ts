import type {
  Capabilities,
  CompileRequest,
  CompileResult,
  DiagnoseRequest,
  DiagnoseResult,
  RunRequest,
  RunResult,
} from "../../../src/shared/api.js";
import type {
  TraceBatch,
  TraceCancelResult,
  TraceRequest,
  TraceStartResult,
} from "../../../src/shared/trace.js";
import type {
  VerifiedRunBatch,
  VerifiedRunCancelResult,
  VerifiedRunStartResult,
} from "../../../src/shared/verified-run.js";
import { detectSupportedHostToolchain, parseRunnerMode } from "./capability.js";
import {
  Runner,
  type RunnerOptions,
  type TrustedExecutionGrant,
  type TrustedOperation,
  type TrustedRequestSummary,
} from "./runner.js";

let defaultRunner: Runner | undefined;

function getDefaultRunner(): Runner {
  if (defaultRunner === undefined) {
    const toolchain = detectSupportedHostToolchain();
    defaultRunner = new Runner({
      platform: process.platform,
      mode: parseRunnerMode(process.env.PANEL_RUNNER_MODE, () => toolchain, process.platform),
      toolchainDetector: () => toolchain,
    });
  }
  return defaultRunner;
}

export async function getCapabilities(): Promise<Capabilities> {
  return getDefaultRunner().getCapabilities();
}

export function describeTrustedRequest(
  operation: "compile",
  request: CompileRequest,
): TrustedRequestSummary;
export function describeTrustedRequest(
  operation: "run",
  request: RunRequest,
): TrustedRequestSummary;
export function describeTrustedRequest(
  operation: "diagnose",
  request: DiagnoseRequest,
): TrustedRequestSummary;
export function describeTrustedRequest(
  operation: "trace",
  request: TraceRequest,
): TrustedRequestSummary;
export function describeTrustedRequest(
  operation: TrustedOperation,
  request: CompileRequest | RunRequest | DiagnoseRequest | TraceRequest,
): TrustedRequestSummary {
  const runner = getDefaultRunner();
  if (operation === "compile") {
    return runner.describeTrustedRequest(operation, request as CompileRequest);
  }
  if (operation === "run") return runner.describeTrustedRequest(operation, request as RunRequest);
  if (operation === "diagnose") {
    return runner.describeTrustedRequest(operation, request as DiagnoseRequest);
  }
  return runner.describeTrustedRequest(operation, request as TraceRequest);
}

export function createTrustedExecutionGrant(
  operation: "compile",
  request: CompileRequest,
): TrustedExecutionGrant;
export function createTrustedExecutionGrant(
  operation: "run",
  request: RunRequest,
): TrustedExecutionGrant;
export function createTrustedExecutionGrant(
  operation: "diagnose",
  request: DiagnoseRequest,
): TrustedExecutionGrant;
export function createTrustedExecutionGrant(
  operation: "trace",
  request: TraceRequest,
): TrustedExecutionGrant;
export function createTrustedExecutionGrant(
  operation: TrustedOperation,
  request: CompileRequest | RunRequest | DiagnoseRequest | TraceRequest,
): TrustedExecutionGrant {
  const runner = getDefaultRunner();
  if (operation === "compile") {
    return runner.createTrustedExecutionGrant(operation, request as CompileRequest);
  }
  if (operation === "run") {
    return runner.createTrustedExecutionGrant(operation, request as RunRequest);
  }
  if (operation === "diagnose") {
    return runner.createTrustedExecutionGrant(operation, request as DiagnoseRequest);
  }
  return runner.createTrustedExecutionGrant(operation, request as TraceRequest);
}

export async function compile(
  request: CompileRequest,
  trustedGrant?: TrustedExecutionGrant,
): Promise<CompileResult> {
  return getDefaultRunner().compile(request, trustedGrant);
}

export async function run(
  request: RunRequest,
  trustedGrant?: TrustedExecutionGrant,
): Promise<RunResult> {
  return getDefaultRunner().run(request, trustedGrant);
}

export async function startRun(
  request: RunRequest,
  trustedGrant?: TrustedExecutionGrant,
): Promise<VerifiedRunStartResult> {
  return getDefaultRunner().startRun(request, trustedGrant);
}

export function readRun(sessionId: string, afterSequence: number): VerifiedRunBatch {
  return getDefaultRunner().readRun(sessionId, afterSequence);
}

export function cancelRun(sessionId: string): VerifiedRunCancelResult {
  return getDefaultRunner().cancelRun(sessionId);
}

export async function diagnose(
  request: DiagnoseRequest,
  trustedGrant?: TrustedExecutionGrant,
): Promise<DiagnoseResult> {
  return getDefaultRunner().diagnose(request, trustedGrant);
}

export async function startTrace(
  request: TraceRequest,
  trustedGrant?: TrustedExecutionGrant,
): Promise<TraceStartResult> {
  return getDefaultRunner().startTrace(request, trustedGrant);
}

export function readTrace(sessionId: string, afterSequence: number): TraceBatch {
  return getDefaultRunner().readTrace(sessionId, afterSequence);
}

export function cancelTrace(sessionId: string): TraceCancelResult {
  return getDefaultRunner().cancelTrace(sessionId);
}

export async function disposeRunner(): Promise<void> {
  if (defaultRunner === undefined) {
    return;
  }
  const runner = defaultRunner;
  await runner.dispose();
}

export function createRunner(options: RunnerOptions = {}): Runner {
  return new Runner(options);
}

export type { RunnerOptions, TrustedExecutionGrant, TrustedOperation, TrustedRequestSummary };
