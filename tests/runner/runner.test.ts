import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompileRequest } from "../../src/shared/api.js";
import {
  createRunner,
  type RunnerOptions,
  type TrustedExecutionGrant,
} from "../../electron/main/runner/index.js";
import {
  COMPILE_EXECUTION_PROFILE,
  DEFAULT_DEVELOPER_ROOT,
  LEAKS_EXECUTION_PROFILE,
  RUN_EXECUTION_PROFILE,
  SANITIZER_RUN_PROFILE,
} from "../../electron/main/runner/capability.js";
import type { SpawnSpecification } from "../../electron/main/runner/process-host.js";
import {
  availableProbe,
  FakeChildProcess,
  FakeClock,
  FakeProcessHost,
  flushAsyncWork,
  unavailableProbe,
} from "./fakes.js";

const ARTIFACT_ID = "artifact_test_id_00000001";
const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Runner capability gate", () => {
  it("fails closed when nested Seatbelt is unavailable", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: unavailableProbe(),
    });

    const capabilities = await runner.getCapabilities();
    const result = await runner.compile({ source: "int main(void){return 0;}" });

    expect(capabilities).toMatchObject({
      mode: "seatbelt-best-effort",
      runnerEnabled: true,
      requiresNativeTrustConfirmation: true,
      seatbeltProbe: { status: "unavailable" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it("uses trusted fallback only with a main-internal one-request grant", async () => {
    const host = new FakeProcessHost([
      successfulCompile,
      (_specification, child) => queueMicrotask(() => child.complete(0)),
    ]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: unavailableProbe(),
    });

    const request = { source: "int main(void){return 0;}" };
    const grant = runner.createTrustedExecutionGrant("compile", request);
    const result = await runner.compile(request, grant);

    expect(result.ok).toBe(true);
    expect(host.specifications[0]).toMatchObject({
      command: "/bin/bash",
      detached: true,
      shell: false,
    });
    await runner.dispose();
  });

  it("rejects forged, reused, and request-mismatched trusted grants", async () => {
    const host = new FakeProcessHost([successfulCompile]);
    const runner = createTestRunner({
      mode: "trusted-only",
      processHost: host,
    });
    const request = { source: "int main(void){return 0;}" };

    await expect(runner.compile(request, {} as TrustedExecutionGrant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });

    const mismatchedGrant = runner.createTrustedExecutionGrant("compile", request);
    await expect(
      runner.compile({ source: "int main(void){return 1;}" }, mismatchedGrant),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    await expect(runner.compile(request, mismatchedGrant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });

    const oneShotGrant = runner.createTrustedExecutionGrant("compile", request);
    await expect(runner.compile(request, oneShotGrant)).resolves.toMatchObject({
      ok: true,
    });
    await expect(runner.compile(request, oneShotGrant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    expect(host.specifications).toHaveLength(1);
    await runner.dispose();
  });

  it("disables direct Runner instances when supported Apple clang is unavailable", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({
      mode: "trusted-only",
      processHost: host,
      toolchainDetector: () => ({
        available: false,
        detail: "unsupported Apple clang",
      }),
    });

    await expect(runner.compile({ source: "int main(void){return 0;}" })).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNNER_DISABLED" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it("labels Seatbelt success as a probe, not as verified isolation", async () => {
    const host = new FakeProcessHost([
      successfulCompile,
      (_specification, child) => queueMicrotask(() => child.complete(0)),
    ]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
    });

    const capabilities = await runner.getCapabilities();
    const result = await runner.compile({ source: "int main(void){return 0;}" });

    expect(capabilities.seatbeltProbe.status).toBe("probe-succeeded");
    expect(capabilities.seatbeltProbe.detail).toContain("不是完整隔离验证");
    expect(host.specifications[0]?.command).toBe("/usr/bin/sandbox-exec");
    expect(host.specifications[0]?.args).toContain(COMPILE_EXECUTION_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("compile fixture failed");
    }
    await expect(runner.run({ artifactId: result.artifactId })).resolves.toMatchObject({
      ok: true,
    });
    expect(host.specifications[1]?.args).toContain(RUN_EXECUTION_PROFILE);
    await runner.dispose();
  });

  it("never starts a process in disabled mode", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "disabled", processHost: host });

    await expect(runner.compile({ source: "int main(void){return 0;}" })).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNNER_DISABLED" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });
});

describe("Runner compile and run", () => {
  it("uses private directories, a minimal environment, safe argv, and fixtures", async () => {
    const hostileArgument = "$(touch should-not-exist); --still-one-argument";
    const host = new FakeProcessHost([
      (specification, child) => {
        successfulCompile(specification, child);
        expect(statSync(specification.cwd).mode & 0o777).toBe(0o700);
        expect(Object.keys(specification.env).sort()).toEqual([
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
          "TMPDIR",
        ]);
        expect(specification.args.join(" ")).not.toContain("int main(void){return 0;}");
      },
      (specification, child) => {
        expect(statSync(specification.cwd).mode & 0o777).toBe(0o700);
        expect(specification.shell).toBe(false);
        expect(specification.args).toContain(hostileArgument);
        expect(readFileSync(join(specification.cwd, "data/input.txt"), "utf8")).toBe(
          "fixture-data",
        );
        expect(statSync(join(specification.cwd, "data/input.txt")).mode & 0o777).toBe(0o600);
        queueMicrotask(() => {
          child.emitStdout("runner-ok\n");
          child.complete(0);
        });
      },
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });

    const compileRequest = { source: "int main(void){return 0;}" };
    const compileResult = await runner.compile(
      compileRequest,
      runner.createTrustedExecutionGrant("compile", compileRequest),
    );
    expect(compileResult).toMatchObject({ ok: true, artifactId: ARTIFACT_ID });
    if (!compileResult.ok) {
      throw new Error("compile fixture failed");
    }

    const runRequest = {
      artifactId: compileResult.artifactId,
      args: [hostileArgument],
      stdin: "stdin-data",
      fixtures: [{ path: "data/input.txt", contents: "fixture-data" }],
    } as const;
    const runResult = await runner.run(
      runRequest,
      runner.createTrustedExecutionGrant("run", runRequest),
    );

    expect(runResult).toMatchObject({
      ok: true,
      termination: "process-exit",
      exitCode: 0,
    });
    expect(Buffer.from(runResult.stdout).toString("utf8")).toBe("runner-ok\n");
    expect(Buffer.concat(host.children[1]?.inputChunks ?? []).toString("utf8")).toBe("stdin-data");
    expect(existsSync(join(host.specifications[1]?.cwd ?? "", "should-not-exist"))).toBe(false);
    await runner.dispose();
  });

  it("reports compiler duration and evidence-separated runtime resource metrics", async () => {
    const clock = new FakeClock(1_000);
    const host = new FakeProcessHost([
      (specification) => {
        const executablePath = join(specification.cwd, "program");
        writeFileSync(executablePath, "fake executable", { mode: 0o700 });
        chmodSync(executablePath, 0o700);
      },
      () => undefined,
    ]);
    const runner = createTestRunner({
      mode: "trusted-only",
      processHost: host,
      clock,
      limits: { rssPollIntervalMs: 10 },
    });
    const compileRequest = { source: "int main(void){return 0;}" };
    const compilePromise = runner.compile(
      compileRequest,
      runner.createTrustedExecutionGrant("compile", compileRequest),
    );
    const compileChild = await waitForSpawn(host);
    clock.advanceBy(25);
    compileChild.complete(0);
    const compileResult = await compilePromise;

    expect(compileResult).toMatchObject({ ok: true, compileDurationMs: 25 });
    if (!compileResult.ok) throw new Error("compile fixture failed");

    const runRequest = { artifactId: compileResult.artifactId };
    const runPromise = runner.run(
      runRequest,
      runner.createTrustedExecutionGrant("run", runRequest),
    );
    const runChild = await waitForChild(host, 1);
    host.rssBytes = 65_536;
    host.processCount = 3;
    runChild.emitStdout("abc");
    runChild.emitStderr("de");
    clock.advanceBy(10);
    await flushAsyncWork();
    clock.advanceBy(7);
    runChild.complete(0);

    await expect(runPromise).resolves.toMatchObject({
      ok: true,
      durationMs: 17,
      peakRssBytes: 65_536,
      peakProcessCount: 3,
      outputBytes: 5,
      executedNodeCount: null,
      operationCount: null,
    });
    await runner.dispose();
  });

  it("expires and removes registered artifacts using the injected clock", async () => {
    const clock = new FakeClock(1_000);
    const host = new FakeProcessHost([successfulCompile]);
    const runner = createTestRunner({
      mode: "trusted-only",
      processHost: host,
      clock,
      limits: { artifactTtlMs: 50 },
    });

    const compileRequest = { source: "int main(void){return 0;}" };
    const compileResult = await runner.compile(
      compileRequest,
      runner.createTrustedExecutionGrant("compile", compileRequest),
    );
    expect(compileResult.ok).toBe(true);
    const artifactDirectory = host.specifications[0]?.cwd;
    expect(artifactDirectory).toBeDefined();
    expect(existsSync(artifactDirectory ?? "")).toBe(true);

    clock.advanceBy(50);
    await flushAsyncWork();
    await runner.cleanupExpiredArtifacts();

    expect(existsSync(artifactDirectory ?? "")).toBe(false);
    if (!compileResult.ok) {
      throw new Error("compile fixture failed");
    }
    await expect(
      runner.run(
        { artifactId: compileResult.artifactId },
        runner.createTrustedExecutionGrant("run", {
          artifactId: compileResult.artifactId,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      termination: "not-started",
      error: { code: "ARTIFACT_EXPIRED" },
    });
    expect(host.specifications).toHaveLength(1);
    await runner.dispose();
  });

  it("preserves invalid UTF-8 stdout and stderr as exact bytes", async () => {
    const stdout = Uint8Array.from([0xff, 0xc3, 0x28]);
    const stderr = Uint8Array.from([0xfe, 0x80]);
    const host = new FakeProcessHost([
      successfulCompile,
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStdout(stdout);
          child.emitStderr(stderr);
          child.complete(0);
        });
      },
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const compileRequest = { source: "int main(void){return 0;}" };
    const compileResult = await runner.compile(
      compileRequest,
      runner.createTrustedExecutionGrant("compile", compileRequest),
    );
    if (!compileResult.ok) {
      throw new Error("compile fixture failed");
    }
    const runRequest = { artifactId: compileResult.artifactId };
    const result = await runner.run(
      runRequest,
      runner.createTrustedExecutionGrant("run", runRequest),
    );

    expect(result.stdout).toEqual(stdout);
    expect(result.stderr).toEqual(stderr);
    await runner.dispose();
  });
});

describe("Runner concurrency and shutdown", () => {
  it("allows only one active native task and consumes a losing grant", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const firstRequest = { source: "int main(void){return 0;}" };
    const secondRequest = { source: "int main(void){return 1;}" };
    const firstPromise = runner.compile(
      firstRequest,
      runner.createTrustedExecutionGrant("compile", firstRequest),
    );
    const firstChild = await waitForSpawn(host);
    const secondGrant = runner.createTrustedExecutionGrant("compile", secondRequest);

    await expect(runner.compile(secondRequest, secondGrant)).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNNER_BUSY" },
    });

    firstChild.complete(1);
    await firstPromise;
    await expect(runner.compile(secondRequest, secondGrant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    expect(host.specifications).toHaveLength(1);
    await runner.dispose();
  });

  it("stops accepting work, kills the active process, and waits during dispose", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}" };
    const compilePromise = runner.compile(
      request,
      runner.createTrustedExecutionGrant("compile", request),
    );
    const child = await waitForSpawn(host);

    const disposePromise = runner.dispose();
    expect(host.groupKills).toEqual([{ processGroupId: child.pid, signal: "SIGKILL" }]);
    child.emitExit(null, "SIGKILL");
    child.emitClose(null, "SIGKILL");
    await compilePromise;
    await disposePromise;

    await expect(runner.compile(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNNER_SHUTTING_DOWN" },
    });
    expect(host.specifications).toHaveLength(1);
  });
});

describe("Runner sample verification path", () => {
  it("uses sanitizer flags and refuses trusted fallback when the canary fails", async () => {
    const unavailableHost = new FakeProcessHost();
    const unavailableRunner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: unavailableHost,
      capabilityProbe: unavailableProbe(),
    });
    await expect(
      unavailableRunner.compileForVerification(
        { source: "int main(void){return 0;}", sourceName: "main.c" },
        "asan-ubsan",
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    expect(unavailableHost.specifications).toEqual([]);
    await unavailableRunner.dispose();

    const host = new FakeProcessHost([
      successfulCompile,
      (_specification, child) => queueMicrotask(() => child.complete(0)),
    ]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
    });
    const compileResult = await runner.compileForVerification(
      { source: "int main(void){return 0;}", sourceName: "main.c" },
      "asan-ubsan",
    );
    expect(compileResult).toMatchObject({ ok: true });
    if (!compileResult.ok) {
      throw new Error("sanitizer verification compile fixture failed");
    }
    expect(host.specifications[0]?.args).toContain("-fsanitize=address,undefined");
    expect(host.specifications[0]?.args).toContain("-fintegrated-cc1");
    expect(host.specifications[0]?.args).toContain(
      `TEMPROOT=${realpathSync(host.specifications[0]?.cwd ?? "").split("/c-block-compile-")[0]}`,
    );
    expect(host.specifications[0]?.args).toContain(`DEVROOT=${DEFAULT_DEVELOPER_ROOT}`);
    expect(host.specifications[0]?.args).toContain(COMPILE_EXECUTION_PROFILE);

    await expect(
      runner.runForVerification({
        artifactId: compileResult.artifactId,
        stdin: new Uint8Array(),
        writableFiles: Object.freeze([]),
        mode: "direct",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(host.specifications[1]?.args).toContain(SANITIZER_RUN_PROFILE);
    expect(host.specifications[1]?.args).not.toContain(RUN_EXECUTION_PROFILE);
    await runner.dispose();
  });

  it("launches the C executable directly under leaks and trusts documented exit zero", async () => {
    const leaksReport =
      "program(123) MallocStackLogging: recording malloc (and VM allocation) stacks using lite mode\n";
    const host = new FakeProcessHost([
      successfulCompile,
      (specification, child) => {
        expect(specification.args).toContain("/usr/bin/leaks");
        expect(specification.args).toContain(LEAKS_EXECUTION_PROFILE);
        expect(specification.args).not.toContain(COMPILE_EXECUTION_PROFILE);
        expect(specification.args).not.toContain("--quiet");
        const atExitIndex = specification.args.indexOf("--atExit");
        expect(specification.args.slice(atExitIndex, atExitIndex + 3)).toEqual([
          "--atExit",
          "--",
          join(specification.cwd, "program"),
        ]);
        expect(specification.args).not.toContain("leaks-runner.sh");
        queueMicrotask(() => {
          child.emitStderr(leaksReport);
          child.complete(0);
        });
      },
    ]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
    });
    const compileResult = await runner.compileForVerification(
      { source: "int main(void){return 0;}", sourceName: "main.c" },
      "plain",
    );
    if (!compileResult.ok) {
      throw new Error("verification compile fixture failed");
    }
    const result = await runner.runForVerification({
      artifactId: compileResult.artifactId,
      stdin: Uint8Array.from([0x00, 0xff]),
      writableFiles: Object.freeze([]),
      mode: "leaks",
    });

    expect(result).toMatchObject({
      ok: true,
      leakCheck: { ok: true, verdict: "clean", summary: leaksReport.trim() },
    });
    expect(Buffer.concat(host.children[1]?.inputChunks ?? [])).toEqual(Buffer.from([0x00, 0xff]));
    await runner.dispose();
  });

  it("uses the bounded 250 ms natural-reap profile only for a leaks run", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost([successfulCompile]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
      clock,
    });
    const compileResult = await runner.compileForVerification(
      { source: "int main(void){return 0;}", sourceName: "main.c" },
      "plain",
    );
    if (!compileResult.ok) throw new Error("verification compile fixture failed");

    host.groupAlive = true;
    host.keepGroupAliveAfterClose = true;
    const resultPromise = runner.runForVerification({
      artifactId: compileResult.artifactId,
      stdin: new Uint8Array(),
      writableFiles: Object.freeze([]),
      mode: "leaks",
    });
    const child = await waitForChild(host, 1);
    child.complete(0);
    clock.advanceBy(200);
    expect(host.groupKills).toEqual([]);
    host.groupAlive = false;
    clock.advanceBy(10);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      termination: "process-exit",
      leakCheck: { verdict: "clean" },
    });
    await runner.dispose();
  });

  it("rejects the documented leaks exit status one", async () => {
    const leaksReport = "Process: program\n2 leaks for 16 total leaked bytes.\n";
    const host = new FakeProcessHost([
      successfulCompile,
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStderr(leaksReport);
          child.complete(1);
        });
      },
    ]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
    });
    const compileResult = await runner.compileForVerification(
      { source: "int main(void){return 0;}", sourceName: "main.c" },
      "plain",
    );
    if (!compileResult.ok) {
      throw new Error("verification compile fixture failed");
    }

    await expect(
      runner.runForVerification({
        artifactId: compileResult.artifactId,
        stdin: new Uint8Array(),
        writableFiles: Object.freeze([]),
        mode: "leaks",
      }),
    ).resolves.toMatchObject({
      ok: false,
      leakCheck: { ok: false, verdict: "finding", summary: leaksReport.trim() },
      error: { code: "LEAK_CHECK_FAILED" },
    });
    await runner.dispose();
  });

  it("distinguishes a leaks tool error from a documented leak finding", async () => {
    const host = new FakeProcessHost([
      successfulCompile,
      (_specification, child) => queueMicrotask(() => child.complete(2)),
    ]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
    });
    const compileResult = await runner.compileForVerification(
      { source: "int main(void){return 0;}", sourceName: "main.c" },
      "plain",
    );
    if (!compileResult.ok) throw new Error("verification compile fixture failed");

    await expect(
      runner.runForVerification({
        artifactId: compileResult.artifactId,
        stdin: new Uint8Array(),
        writableFiles: Object.freeze([]),
        mode: "leaks",
      }),
    ).resolves.toMatchObject({
      ok: false,
      leakCheck: { ok: false, verdict: "tool-error" },
      error: { code: "LEAK_CHECK_FAILED", message: "leaks 工具未正常完成。" },
    });
    await runner.dispose();
  });

  it("refuses to run leaks against a sanitizer artifact", async () => {
    const host = new FakeProcessHost([successfulCompile]);
    const runner = createTestRunner({
      mode: "seatbelt-best-effort",
      processHost: host,
      capabilityProbe: availableProbe(),
    });
    const compileResult = await runner.compileForVerification(
      { source: "int main(void){return 0;}", sourceName: "main.c" },
      "asan-ubsan",
    );
    if (!compileResult.ok) throw new Error("sanitizer compile fixture failed");

    await expect(
      runner.runForVerification({
        artifactId: compileResult.artifactId,
        stdin: new Uint8Array(),
        writableFiles: Object.freeze([]),
        mode: "leaks",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(host.specifications).toHaveLength(1);
    await runner.dispose();
  });
});

describe("Runner input validation", () => {
  it("rejects NUL in source and stdin before process creation", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });

    await expect(runner.compile({ source: "int main(void){\0return 0;}" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(
      runner.run({ artifactId: ARTIFACT_ID, stdin: "before\0after" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it("rejects the removed renderer trustedAcknowledgement field", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = {
      source: "int main(void){return 0;}",
      trustedAcknowledgement: {
        acknowledged: true,
        scope: "this-request",
      },
    } as unknown as CompileRequest;

    await expect(runner.compile(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it.each([
    "../secret.txt",
    "/tmp/secret.txt",
    "data\\secret.txt",
    "program",
    "data/../../secret.txt",
  ])("rejects unsafe fixture path %s before process creation", async (fixturePath) => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });

    await expect(
      runner.run({
        artifactId: ARTIFACT_ID,
        fixtures: [{ path: fixturePath, contents: "x" }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it("rejects file-directory fixture collisions", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });

    await expect(
      runner.run({
        artifactId: ARTIFACT_ID,
        fixtures: [
          { path: "data", contents: "file" },
          { path: "data/input.txt", contents: "nested" },
        ],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it("rejects unknown request fields instead of silently ignoring them", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = {
      source: "int main(void){return 0;}",
      compilerFlags: ["-include", "/Users/example/secret.h"],
    } as unknown as CompileRequest;

    await expect(runner.compile(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });
});

function createTestRunner(options: RunnerOptions) {
  const root = mkdtempSync(join(tmpdir(), "c-block-runner-tests-"));
  testRoots.push(root);
  return createRunner({
    idGenerator: () => ARTIFACT_ID,
    tempRoot: root,
    toolchainDetector: () => ({
      available: true,
      detail: "Apple clang version 21.0.0 (test double)",
    }),
    ...options,
  });
}

async function waitForSpawn(host: FakeProcessHost): Promise<FakeChildProcess> {
  return waitForChild(host, 0);
}

async function waitForChild(host: FakeProcessHost, index: number): Promise<FakeChildProcess> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const child = host.children[index];
    if (child !== undefined) {
      return child;
    }
    await flushAsyncWork();
  }
  throw new Error("runner did not spawn within the test deadline");
}

function successfulCompile(specification: SpawnSpecification, child: FakeChildProcess): void {
  const executablePath = join(specification.cwd, "program");
  writeFileSync(executablePath, "fake executable", { mode: 0o700 });
  chmodSync(executablePath, 0o700);
  queueMicrotask(() => child.complete(0));
}
