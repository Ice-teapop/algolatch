import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunner } from "../../electron/main/runner/index.js";
import type { VerifiedRunBatch } from "../../src/shared/verified-run.js";
import { FakeProcessHost, flushAsyncWork } from "./fakes.js";

const ARTIFACT_ID = "artifact_verified_run_00000001";
const SESSION_ID = "run_verified_session_00000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Runner Verified Run sessions", () => {
  it("streams exact stdout and stderr before publishing the final RunResult", async () => {
    const host = new FakeProcessHost([successfulCompile, () => undefined]);
    const runner = testRunner(host);
    const artifactId = await compileArtifact(runner);
    const request = { artifactId, stdin: "input" };

    await expect(runner.startRun(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    const started = await runner.startRun(
      request,
      runner.createTrustedExecutionGrant("run", request),
    );
    expect(started).toEqual({ ok: true, sessionId: SESSION_ID, status: "preparing" });
    if (!started.ok) throw new Error(started.error.message);

    const child = await waitForChild(host, 1);
    child.emitStdout(Uint8Array.from([0xff, 0x41]));
    child.emitStderr("warning\n");
    expect(runner.readRun(started.sessionId, 0)).toMatchObject({
      ok: true,
      status: "running",
      events: [
        { sequence: 1, stream: "stdout", data: Uint8Array.from([0xff, 0x41]) },
        {
          sequence: 2,
          stream: "stderr",
          data: Uint8Array.from(Buffer.from("warning\n")),
        },
      ],
      result: null,
    });

    child.complete(0);
    const terminal = await waitForTerminal(runner, started.sessionId);
    expect(terminal).toMatchObject({
      ok: true,
      status: "completed",
      nextSequence: 2,
      result: {
        ok: true,
        stdout: Uint8Array.from([0xff, 0x41]),
        stderr: Uint8Array.from(Buffer.from("warning\n")),
        outputBytes: 10,
      },
    });
    expect(Buffer.concat(host.children[1]?.inputChunks ?? []).toString("utf8")).toBe("input");
    await runner.dispose();
  });

  it("cancels only the active supervised run and keeps its terminal state", async () => {
    const host = new FakeProcessHost([successfulCompile, () => undefined]);
    const runner = testRunner(host);
    const artifactId = await compileArtifact(runner);
    const request = { artifactId };
    const started = await runner.startRun(
      request,
      runner.createTrustedExecutionGrant("run", request),
    );
    if (!started.ok) throw new Error(started.error.message);
    const child = await waitForChild(host, 1);

    expect(runner.cancelRun(started.sessionId)).toEqual({
      ok: true,
      sessionId: started.sessionId,
      status: "cancelled",
    });
    expect(host.groupKills).toHaveLength(1);
    child.emitClose(null, "SIGKILL");
    const terminal = await waitForTerminal(runner, started.sessionId);
    expect(terminal).toMatchObject({
      ok: true,
      status: "cancelled",
      events: [],
      result: { ok: false, signal: "SIGKILL" },
    });
    expect(runner.cancelRun("run_missing_session_00000000")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await runner.dispose();
  });

  it("cancels during preparation without spawning the program", async () => {
    const host = new FakeProcessHost([successfulCompile]);
    const runner = testRunner(host);
    const artifactId = await compileArtifact(runner);
    const request = { artifactId };
    const started = await runner.startRun(
      request,
      runner.createTrustedExecutionGrant("run", request),
    );
    if (!started.ok) throw new Error(started.error.message);

    expect(runner.cancelRun(started.sessionId)).toMatchObject({
      ok: true,
      status: "cancelled",
    });
    const terminal = await waitForTerminal(runner, started.sessionId);
    expect(terminal).toMatchObject({
      ok: true,
      status: "cancelled",
      result: {
        ok: false,
        termination: "not-started",
        error: { code: "INTERNAL_ERROR" },
      },
    });
    expect(host.specifications).toHaveLength(1);
    expect(host.groupKills).toEqual([]);
    await runner.dispose();
  });
});

function testRunner(host: FakeProcessHost) {
  const root = mkdtempSync(join(tmpdir(), "c-block-verified-run-tests-"));
  roots.push(root);
  return createRunner({
    mode: "trusted-only",
    processHost: host,
    tempRoot: root,
    idGenerator: () => ARTIFACT_ID,
    runSessionIdGenerator: () => SESSION_ID,
    toolchainDetector: () => ({
      available: true,
      detail: "Apple clang version 21.0.0 (Verified Run test double)",
    }),
  });
}

async function compileArtifact(runner: ReturnType<typeof testRunner>): Promise<string> {
  const request = { source: "int main(void) { return 0; }" };
  const result = await runner.compile(
    request,
    runner.createTrustedExecutionGrant("compile", request),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.artifactId;
}

function successfulCompile(
  specification: { readonly cwd: string },
  child: { complete(code?: number): void },
): void {
  const executablePath = join(specification.cwd, "program");
  writeFileSync(executablePath, "fake executable", { mode: 0o700 });
  chmodSync(executablePath, 0o700);
  queueMicrotask(() => child.complete(0));
}

async function waitForChild(host: FakeProcessHost, index: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const child = host.children[index];
    if (child !== undefined) return child;
    await flushAsyncWork();
  }
  throw new Error("Verified Run child did not spawn within the test deadline");
}

async function waitForTerminal(
  runner: ReturnType<typeof testRunner>,
  sessionId: string,
): Promise<VerifiedRunBatch> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const batch = runner.readRun(sessionId, 0);
    if (
      !batch.ok ||
      (["completed", "failed", "cancelled", "truncated"].includes(batch.status) &&
        batch.result !== null)
    ) {
      return batch;
    }
    await flushAsyncWork();
  }
  throw new Error("Verified Run session did not settle");
}
