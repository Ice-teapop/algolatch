import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/shared/api.js";
import {
  verifiedRunBatchHasTerminalEvidence,
  verifiedRunBatchIsFullyDrained,
} from "../../src/shared/verified-run.js";
import { VerifiedRunSessionRegistry } from "../../electron/main/runner/verified-run-session.js";

const SESSION_ID = "run_verified_session_00000001";

describe("VerifiedRunSessionRegistry", () => {
  it("keeps ordered binary stdout and stderr events and stores the final result", () => {
    const registry = new VerifiedRunSessionRegistry({ maxBatchEvents: 1 });
    const session = registry.create(SESSION_ID);
    session.setRunning();

    expect(session.append("stdout", Uint8Array.from([0xff, 0x01]))).toBe(true);
    expect(session.append("stderr", Uint8Array.from([0xfe]))).toBe(true);
    session.complete(runResult());

    const first = registry.read(SESSION_ID, 0);
    expect(first).toMatchObject({
      ok: true,
      status: "completed",
      nextSequence: 1,
      totalEventCount: 2,
      totalEventBytes: 3,
      events: [{ sequence: 1, stream: "stdout", data: Uint8Array.from([0xff, 0x01]) }],
      result: { ok: true, stdout: Uint8Array.from([0x6f, 0x6b]) },
    });
    expect(verifiedRunBatchHasTerminalEvidence(first)).toBe(true);
    expect(verifiedRunBatchIsFullyDrained(first)).toBe(false);
    const second = registry.read(SESSION_ID, 1);
    expect(second).toMatchObject({
      ok: true,
      nextSequence: 2,
      events: [{ sequence: 2, stream: "stderr", data: Uint8Array.from([0xfe]) }],
    });
    expect(verifiedRunBatchHasTerminalEvidence(second)).toBe(true);
    expect(verifiedRunBatchIsFullyDrained(second)).toBe(true);
  });

  it("fails closed at the event and byte bounds without accepting later output", () => {
    const byteBound = new VerifiedRunSessionRegistry({
      maxBytes: 3,
      maxEvents: 8,
      maxBatchEvents: 8,
    });
    const byteSession = byteBound.create(SESSION_ID);
    byteSession.setRunning();

    expect(byteSession.append("stdout", Uint8Array.from([1, 2, 3, 4]))).toBe(false);
    expect(byteSession.append("stderr", Uint8Array.from([5]))).toBe(false);
    byteSession.complete(runResult());
    expect(byteBound.read(SESSION_ID, 0)).toMatchObject({
      ok: true,
      status: "truncated",
      truncated: true,
      totalEventCount: 1,
      totalEventBytes: 3,
      events: [{ data: Uint8Array.from([1, 2, 3]) }],
      result: { ok: true },
      error: { code: "RESOURCE_LIMIT" },
    });

    const eventBound = new VerifiedRunSessionRegistry({
      maxBytes: 100,
      maxEvents: 1,
      maxBatchEvents: 8,
    });
    const eventSession = eventBound.create("run_verified_session_00000002");
    eventSession.setRunning();
    expect(eventSession.append("stdout", Uint8Array.from([1]))).toBe(true);
    expect(eventSession.append("stdout", Uint8Array.from([2]))).toBe(false);
    expect(eventBound.read(eventSession.sessionId, 0)).toMatchObject({
      ok: true,
      status: "truncated",
      totalEventCount: 1,
      totalEventBytes: 1,
    });
  });

  it("preserves cancellation and rejects invalid cursors or missing sessions", () => {
    const registry = new VerifiedRunSessionRegistry();
    const session = registry.create(SESSION_ID);
    session.setRunning();
    expect(registry.cancel(SESSION_ID)).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      status: "cancelled",
    });
    session.complete(runResult());

    expect(registry.read(SESSION_ID, 0)).toMatchObject({
      ok: true,
      status: "cancelled",
      result: { ok: true },
    });
    expect(registry.read(SESSION_ID, 1)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(registry.cancel("run_missing_session_00000000")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });
});

function runResult(): RunResult {
  return Object.freeze({
    ok: true,
    stdout: Uint8Array.from([0x6f, 0x6b]),
    stderr: new Uint8Array(),
    exitCode: 0,
    signal: null,
    termination: "process-exit",
    durationMs: 7,
    peakRssBytes: 1024,
    peakProcessCount: 1,
    outputBytes: 2,
    executedNodeCount: null,
    operationCount: null,
  });
}
