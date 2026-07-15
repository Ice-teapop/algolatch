import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunner } from "../../electron/main/runner/index.js";
import { fingerprintSource } from "../../src/shared/source-snapshot.js";
import type { TraceBatch, TraceRequest } from "../../src/shared/trace.js";
import { FakeProcessHost, flushAsyncWork } from "./fakes.js";

const TRACE_SESSION_ID = "trace_test_session_00000001";
const ARTIFACT_ID = "artifact_trace_00000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Runner bounded Trace lifecycle", () => {
  it("uses one exact grant, compiles only a shadow source and returns real ordered events", async () => {
    let protocolNonce = "";
    const host = new FakeProcessHost([
      (specification, child) => {
        const shadow = readFileSync(join(specification.cwd, "main.c"), "utf8");
        const match = /CBT:([a-f0-9]{36}):/u.exec(shadow);
        protocolNonce = match?.[1] ?? "";
        expect(protocolNonce).toHaveLength(36);
        expect(shadow).toContain('#line 1 "main.c"');
        expect(shadow).toContain("cb_trace_");
        const executable = join(specification.cwd, "program");
        writeFileSync(executable, "fake executable", { mode: 0o700 });
        chmodSync(executable, 0o700);
        queueMicrotask(() => child.complete(0));
      },
      (_specification, child) => {
        queueMicrotask(() => {
          child.emitStdout("user-output");
          child.emitStderr(`notice\n\u001eCBT:${protocolNonce}:1:L:1\n`);
          child.emitStderr(`\u001eCBT:${protocolNonce}:2:L:2\n`);
          child.emitStderr(`\u001eCBT:${protocolNonce}:3:B:3:1\n`);
          child.emitStderr(`\u001eCBT:${protocolNonce}:4:L:4\n`);
          child.complete(0);
        });
      },
    ]);
    const runner = testRunner(host);
    const request = traceRequest();

    await expect(runner.startTrace(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    const grant = runner.createTrustedExecutionGrant("trace", request);
    const started = await runner.startTrace(request, grant);
    expect(started).toMatchObject({
      ok: true,
      sessionId: TRACE_SESSION_ID,
      sourceFingerprint: request.sourceFingerprint,
      status: "preparing",
    });
    if (!started.ok) throw new Error(started.error.message);

    const batch = await waitForTerminal(runner, started.sessionId);
    expect(batch).toMatchObject({
      ok: true,
      status: "completed",
      truncated: false,
      totalEventCount: 4,
      events: [
        { sequence: 1, kind: "line", line: 1 },
        { sequence: 2, kind: "line", line: 2 },
        { sequence: 3, kind: "branch", line: 3, branchTaken: true },
        { sequence: 4, kind: "line", line: 4 },
      ],
      evidence: { ok: true, outputBytes: 18 },
    });
    expect(request.source).toBe(traceSource());
    expect(host.specifications).toHaveLength(2);
    const reused = await retryAfterRunnerBusy(() => runner.startTrace(request, grant));
    expect(reused).toMatchObject({
      ok: false,
      error: { code: "TRUST_CONFIRMATION_REQUIRED" },
    });
    await runner.dispose();
  });

  it("cancels an in-flight shadow compile and keeps the session cancelled", async () => {
    const request = supportedSwitchTraceRequest();
    const host = new FakeProcessHost([
      (specification) => {
        const shadow = readFileSync(join(specification.cwd, "main.c"), "utf8");
        expect(shadow).toContain("switch ((cb_trace_");
        expect(shadow).not.toBe(request.source);
        const executable = join(specification.cwd, "program");
        writeFileSync(executable, "fake executable", { mode: 0o700 });
        chmodSync(executable, 0o700);
      },
    ]);
    const runner = testRunner(host);
    const started = await runner.startTrace(
      request,
      runner.createTrustedExecutionGrant("trace", request),
    );
    if (!started.ok) throw new Error(started.error.message);
    await waitForChild(host);

    expect(runner.cancelTrace(started.sessionId)).toEqual({
      ok: true,
      sessionId: started.sessionId,
      status: "cancelled",
    });
    host.children[0]?.emitClose(null, "SIGKILL");
    await flushAsyncWork();
    expect(runner.readTrace(started.sessionId, 0)).toMatchObject({
      ok: true,
      status: "cancelled",
      events: [],
    });
    expect(host.groupKills).toHaveLength(1);
    expect(request.source).toBe(supportedSwitchTraceRequest().source);
    await runner.dispose();
  });

  it("rejects stale source fingerprints and recovery-prone layouts before spawning", async () => {
    const host = new FakeProcessHost();
    const runner = testRunner(host);
    const valid = traceRequest();
    const stale = { ...valid, sourceFingerprint: "stale" };
    await expect(
      runner.startTrace(stale, runner.createTrustedExecutionGrant("trace", valid)),
    ).resolves.toMatchObject({ ok: false, error: { code: "TRACE_SOURCE_MISMATCH" } });

    const source = "int main(void) {\n  if (1)\n    return 0;\n}";
    const unsupported: TraceRequest = {
      source,
      sourceFingerprint: fingerprintSource(source),
      sourceName: "main.c",
    };
    await expect(
      runner.startTrace(unsupported, runner.createTrustedExecutionGrant("trace", unsupported)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRACE_UNSUPPORTED" },
      unsupported: { code: "unsupported-control-layout", line: 2 },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });

  it("rejects switch without default before spawning instead of claiming a complete miss path", async () => {
    const host = new FakeProcessHost();
    const runner = testRunner(host);
    const source = [
      "int main(void) {",
      "  int x = 1;",
      "  switch (x) {",
      "  case 1:",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    const request: TraceRequest = {
      source,
      sourceFingerprint: fingerprintSource(source),
      sourceName: "main.c",
    };

    await expect(
      runner.startTrace(request, runner.createTrustedExecutionGrant("trace", request)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRACE_UNSUPPORTED" },
      unsupported: { code: "unsupported-switch", line: 3 },
    });
    expect(host.specifications).toEqual([]);
    await runner.dispose();
  });
});

function traceSource(): string {
  return [
    "int main(void) {",
    "  int x = 1;",
    "  if (x) {",
    "    x += 1;",
    "  }",
    "  return x;",
    "}",
  ].join("\n");
}

function traceRequest(): TraceRequest {
  const source = traceSource();
  return Object.freeze({
    source,
    sourceFingerprint: fingerprintSource(source),
    sourceName: "main.c",
  });
}

function supportedSwitchTraceRequest(): TraceRequest {
  const source = [
    "int main(void) {",
    "  int x = 1;",
    "  switch (x) {",
    "  case 1:",
    "    x += 1;",
    "    break;",
    "  default:",
    "    x = 0;",
    "  }",
    "  return x == 2 ? 0 : 1;",
    "}",
  ].join("\n");
  return Object.freeze({
    source,
    sourceFingerprint: fingerprintSource(source),
    sourceName: "main.c",
  });
}

function testRunner(host: FakeProcessHost) {
  const root = mkdtempSync(join(tmpdir(), "c-block-trace-tests-"));
  roots.push(root);
  return createRunner({
    mode: "trusted-only",
    processHost: host,
    tempRoot: root,
    idGenerator: () => ARTIFACT_ID,
    traceIdGenerator: () => TRACE_SESSION_ID,
    toolchainDetector: () => ({
      available: true,
      detail: "Apple clang version 21.0.0 (trace test double)",
    }),
  });
}

async function waitForTerminal(
  runner: ReturnType<typeof testRunner>,
  sessionId: string,
): Promise<TraceBatch> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const batch = runner.readTrace(sessionId, 0);
    if (!batch.ok || ["completed", "failed", "cancelled", "truncated"].includes(batch.status)) {
      return batch;
    }
    await flushAsyncWork();
  }
  throw new Error("Trace session did not settle");
}

async function waitForChild(host: FakeProcessHost): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (host.children[0] !== undefined) return;
    await flushAsyncWork();
  }
  throw new Error("Trace child did not spawn");
}

async function retryAfterRunnerBusy<
  T extends { readonly ok: boolean; readonly error?: { readonly code: string } },
>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await operation();
    if (result.ok || result.error?.code !== "RUNNER_BUSY") return result;
    await flushAsyncWork();
  }
  throw new Error("Runner stayed busy after terminal Trace batch");
}
