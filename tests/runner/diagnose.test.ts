import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunner, type RunnerOptions } from "../../electron/main/runner/index.js";
import type { DiagnoseRequest } from "../../src/shared/api.js";
import { availableProbe, type FakeChildProcess, FakeProcessHost } from "./fakes.js";

const ARTIFACT_ID = "diagnose_artifact_00000001";
const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("M5b trusted deterministic diagnostics", () => {
  it("runs clang -fsyntax-only and maps a UTF-8 byte column without creating an artifact", async () => {
    const source = "// 中文\nint main(void) { int unused; return 0; }\n";
    const host = new FakeProcessHost([
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStderr("main.c:2:22: warning: unused variable 'unused' [-Wunused-variable]\n");
          child.complete(0);
        });
      },
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source };
    const result = await runner.diagnose(
      request,
      runner.createTrustedExecutionGrant("diagnose", request),
    );

    expect(result).toMatchObject({
      ok: true,
      compilerExitCode: 0,
      hasErrors: false,
      memory: null,
      diagnostics: [
        {
          severity: "warning",
          option: "-Wunused-variable",
          line: 2,
          byteColumn: 22,
        },
      ],
    });
    expect(host.specifications).toHaveLength(1);
    expect(host.specifications[0]?.args).toContain("-fsyntax-only");
    expect(host.specifications[0]?.args).not.toContain("-o");
    expect(host.specifications[0]?.args).toContain("-Wall");
    expect(host.specifications[0]?.args).toContain("-Wextra");
    await runner.dispose();
  });

  it("treats clang exit one as completed diagnostics and skips runtime checks on errors", async () => {
    const host = new FakeProcessHost([
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStderr("main.c:1:17: error: expected expression\n");
          child.complete(1);
        });
      },
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){ return ; }", runtime: {} };

    await expect(
      runner.diagnose(request, runner.createTrustedExecutionGrant("diagnose", request)),
    ).resolves.toMatchObject({
      ok: true,
      compilerExitCode: 1,
      hasErrors: true,
      memory: { status: "skipped", reason: "static-errors" },
    });
    expect(host.specifications).toHaveLength(1);
    await runner.dispose();
  });

  it("fails closed on clang exit one even when no current-source diagnostic can be parsed", async () => {
    const host = new FakeProcessHost([
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStderr("/external/header.h:1:1: error: unavailable header\n");
          child.complete(1);
        });
      },
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };

    await expect(
      runner.diagnose(request, runner.createTrustedExecutionGrant("diagnose", request)),
    ).resolves.toMatchObject({
      ok: true,
      compilerExitCode: 1,
      hasErrors: true,
      diagnostics: [],
      memory: { status: "skipped", reason: "static-errors" },
    });
    expect(host.specifications).toHaveLength(1);
    await runner.dispose();
  });

  it("uses one exact grant for separate sanitizer and plain+leaks gates", async () => {
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      successfulRun,
      (specification, child) => {
        const controlSource = readFileSync(join(specification.cwd, "leak-control.c"), "utf8");
        expect(controlSource).toContain("void *volatile pointer = malloc(32);");
        expect(controlSource).toContain("pointer = NULL;");
        successfulCompile(specification, child);
      },
      leaksFinding("1 leak for 32 total leaked bytes."),
      successfulCompile,
      leaksClean,
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };
    const grant = runner.createTrustedExecutionGrant("diagnose", request);
    const result = await runner.diagnose(request, grant);

    expect(result).toMatchObject({
      ok: true,
      memory: {
        status: "completed",
        clean: true,
        sanitizer: { verdict: "clean" },
        leaks: { verdict: "clean", positiveControl: "passed" },
      },
    });
    expect(host.specifications).toHaveLength(7);
    expect(host.specifications[1]?.args).toContain("-fsanitize=address,undefined");
    expect(host.specifications[3]?.args).not.toContain("-fsanitize=address,undefined");
    expect(host.specifications[5]?.args).not.toContain("-fsanitize=address,undefined");
    expect(host.specifications[4]?.args).toContain("/usr/bin/leaks");
    expect(host.specifications[4]?.args).toContain("--list");
    expect(host.specifications[4]?.args).toContain("--nosources");
    expect(host.specifications[6]?.args).toContain("/usr/bin/leaks");

    await expect(runner.diagnose(request, grant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    await runner.dispose();
  });

  it("reports sanitizer and leaks findings without folding them into tool failure", async () => {
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStderr("ERROR: AddressSanitizer: heap-buffer-overflow\n");
          child.complete(1);
        });
      },
      successfulCompile,
      leaksFinding("Process: leak-control\n1 leak for 32 total leaked bytes."),
      successfulCompile,
      leaksFinding("program: 2 leaks for 64 total leaked bytes."),
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };
    const result = await runner.diagnose(
      request,
      runner.createTrustedExecutionGrant("diagnose", request),
    );

    expect(result).toMatchObject({
      ok: true,
      memory: {
        status: "completed",
        clean: false,
        sanitizer: { verdict: "finding" },
        leaks: { verdict: "finding", positiveControl: "passed" },
      },
    });
    await runner.dispose();
  });

  it("does not classify user stdout text as a sanitizer report", async () => {
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStdout("runtime error: this is ordinary program output\n");
          child.complete(0);
        });
      },
      successfulCompile,
      leaksFinding("Process: leak-control\n1 leak for 32 total leaked bytes."),
      successfulCompile,
      leaksClean,
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };

    await expect(
      runner.diagnose(request, runner.createTrustedExecutionGrant("diagnose", request)),
    ).resolves.toMatchObject({
      ok: true,
      memory: {
        status: "completed",
        clean: true,
        sanitizer: { verdict: "clean" },
      },
    });
    await runner.dispose();
  });

  it("reuses one positive-control artifact after a clean result and runs user code once", async () => {
    let controlCompileCount = 0;
    let userSanitizerRunCount = 0;
    let userLeaksRunCount = 0;
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      (specification, child) => {
        userSanitizerRunCount += 1;
        successfulRun(specification, child);
      },
      (specification, child) => {
        controlCompileCount += 1;
        successfulCompile(specification, child);
      },
      leaksClean,
      leaksFinding("Process: leak-control\n1 leak for 32 total leaked bytes."),
      successfulCompile,
      (specification, child) => {
        userLeaksRunCount += 1;
        leaksClean(specification, child);
      },
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };

    await expect(
      runner.diagnose(request, runner.createTrustedExecutionGrant("diagnose", request)),
    ).resolves.toMatchObject({
      ok: true,
      memory: {
        status: "completed",
        clean: true,
        leaks: { verdict: "clean", positiveControl: "passed" },
      },
    });
    expect(controlCompileCount).toBe(1);
    expect(userSanitizerRunCount).toBe(1);
    expect(userLeaksRunCount).toBe(1);
    expect(host.specifications).toHaveLength(8);
    expect(host.specifications[4]?.args).toContain("/usr/bin/leaks");
    expect(host.specifications[5]?.args).toContain("/usr/bin/leaks");
    expect(host.specifications[7]?.args).toContain("/usr/bin/leaks");
    await runner.dispose();
  });

  it("fails closed when both positive-control attempts report clean", async () => {
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      successfulRun,
      successfulCompile,
      leaksClean,
      leaksClean,
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };

    const result = await runner.diagnose(
      request,
      runner.createTrustedExecutionGrant("diagnose", request),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "LEAK_CHECK_FAILED" },
    });
    if (result.ok) throw new Error("positive-control failure unexpectedly succeeded");
    expect(result.error.message).toContain("尝试1[termination=process-exit");
    expect(result.error.message).toContain("尝试2[termination=process-exit");
    expect(result.error.message).toContain("verdict=clean");
    expect(result.error.message).not.toContain("leak-control.c");
    expect(host.specifications).toHaveLength(6);
    await runner.dispose();
  });

  it("reserves the extended profile for the embedded control and preserves the user limit", async () => {
    const delayedFinding = (_specification: unknown, child: FakeChildProcess): void => {
      setTimeout(() => {
        child.emitStderr("1 leak for 32 total leaked bytes.");
        child.complete(1);
      }, 150);
    };
    const delayedClean = (_specification: unknown, child: FakeChildProcess): void => {
      setTimeout(() => child.complete(0), 150);
    };
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      successfulRun,
      successfulCompile,
      delayedFinding,
      successfulCompile,
      delayedClean,
    ]);
    const runner = createTestRunner({
      mode: "trusted-only",
      processHost: host,
      limits: { runWallTimeMs: 50, rssPollIntervalMs: 1_000 },
    });
    const request = { source: "int main(void){return 0;}", runtime: {} };
    await expect(
      runner.diagnose(request, runner.createTrustedExecutionGrant("diagnose", request)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RESOURCE_LIMIT" },
    });
    expect(host.specifications).toHaveLength(7);
    expect(host.groupKills).toHaveLength(1);
    await runner.dispose();
  });

  it.each([
    ["empty output", ""],
    ["a finding without numeric evidence", "Process: leak-control\nleaks detected."],
  ])("fails closed when an exit-one leaks positive control returns %s", async (_label, report) => {
    const host = new FakeProcessHost([
      successfulSyntax,
      successfulCompile,
      successfulRun,
      successfulCompile,
      leaksFinding(report),
      leaksFinding(report),
    ]);
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const request = { source: "int main(void){return 0;}", runtime: {} };

    await expect(
      runner.diagnose(request, runner.createTrustedExecutionGrant("diagnose", request)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LEAK_CHECK_FAILED" },
    });
    expect(host.specifications).toHaveLength(6);
    await runner.dispose();
  });

  it("rejects unknown fields, NUL input and an altered request before spawning", async () => {
    const host = new FakeProcessHost();
    const runner = createTestRunner({ mode: "trusted-only", processHost: host });
    const valid = { source: "int main(void){return 0;}", runtime: {} };
    const grant = runner.createTrustedExecutionGrant("diagnose", valid);
    const forged = {
      ...valid,
      runtime: { stdin: "changed" },
    };
    const unknown = { ...valid, timeoutMs: 99 } as unknown as DiagnoseRequest;

    await expect(runner.diagnose(unknown)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(
      runner.diagnose({ source: valid.source, runtime: { stdin: "bad\0input" } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    await expect(runner.diagnose(forged, grant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    await expect(runner.diagnose(valid, grant)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });
});

function createTestRunner(options: RunnerOptions) {
  const root = mkdtempSync(join(tmpdir(), "c-block-diagnose-tests-"));
  testRoots.push(root);
  return createRunner({
    idGenerator: () => ARTIFACT_ID,
    tempRoot: root,
    capabilityProbe: availableProbe(),
    toolchainDetector: () => ({
      available: true,
      detail: "Apple clang version 21.0.0 (test double)",
    }),
    ...options,
  });
}

function successfulSyntax(_specification: unknown, child: FakeChildProcess): void {
  queueMicrotask(() => child.complete(0));
}

function successfulCompile(specification: { readonly cwd: string }, child: FakeChildProcess): void {
  const executable = join(specification.cwd, "program");
  writeFileSync(executable, "binary", { mode: 0o700 });
  chmodSync(executable, 0o700);
  queueMicrotask(() => child.complete(0));
}

function successfulRun(_specification: unknown, child: FakeChildProcess): void {
  queueMicrotask(() => child.complete(0));
}

function leaksFinding(report: string) {
  return (_specification: unknown, child: FakeChildProcess): void => {
    queueMicrotask(() => {
      child.emitStderr(report);
      child.complete(1);
    });
  };
}

function leaksClean(_specification: unknown, child: FakeChildProcess): void {
  queueMicrotask(() => {
    child.emitStderr("Process: program\n0 leaks for 0 total leaked bytes.\n");
    child.complete(0);
  });
}
