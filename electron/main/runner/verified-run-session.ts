import type { RunResult, RunnerError } from "../../../src/shared/api.js";
import {
  VERIFIED_RUN_BATCH_EVENT_LIMIT,
  VERIFIED_RUN_BYTE_LIMIT,
  VERIFIED_RUN_EVENT_LIMIT,
  isTerminalVerifiedRunStatus,
  type VerifiedRunBatch,
  type VerifiedRunCancelResult,
  type VerifiedRunEvent,
  type VerifiedRunSessionStatus,
} from "../../../src/shared/verified-run.js";

export interface VerifiedRunSessionLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxBatchEvents: number;
  readonly maxSessions: number;
}

export interface VerifiedRunSessionHandle {
  readonly sessionId: string;
  readonly cancelRequested: boolean;
  readonly status: VerifiedRunSessionStatus;
  setRunning(): void;
  append(stream: VerifiedRunEvent["stream"], data: Uint8Array): boolean;
  complete(result: RunResult): void;
  fail(error: RunnerError): void;
}

const DEFAULT_LIMITS: VerifiedRunSessionLimits = Object.freeze({
  maxEvents: VERIFIED_RUN_EVENT_LIMIT,
  maxBytes: VERIFIED_RUN_BYTE_LIMIT,
  maxBatchEvents: VERIFIED_RUN_BATCH_EVENT_LIMIT,
  maxSessions: 8,
});

interface MutableVerifiedRunSession {
  readonly sessionId: string;
  readonly events: VerifiedRunEvent[];
  totalBytes: number;
  status: VerifiedRunSessionStatus;
  cancelRequested: boolean;
  truncated: boolean;
  result: RunResult | null;
  error: RunnerError | null;
}

export class VerifiedRunSessionRegistry {
  readonly #sessions = new Map<string, MutableVerifiedRunSession>();
  readonly #limits: VerifiedRunSessionLimits;

  constructor(limits: Partial<VerifiedRunSessionLimits> = {}) {
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    assertLimits(this.#limits);
  }

  create(sessionId: string): VerifiedRunSessionHandle {
    if (!/^run_[A-Za-z0-9_-]{16,128}$/u.test(sessionId)) {
      throw new TypeError("Verified Run session id 格式无效");
    }
    this.#purgeOldestTerminalUntilCapacity();
    if (this.#sessions.size >= this.#limits.maxSessions) {
      throw new Error("Verified Run session capacity reached");
    }
    if (this.#sessions.has(sessionId)) throw new Error("Verified Run session id collision");
    const session: MutableVerifiedRunSession = {
      sessionId,
      events: [],
      totalBytes: 0,
      status: "preparing",
      cancelRequested: false,
      truncated: false,
      result: null,
      error: null,
    };
    this.#sessions.set(sessionId, session);
    return this.#handle(session);
  }

  read(sessionId: string, afterSequence: number): VerifiedRunBatch {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return missingBatch(sessionId);
    return readSession(session, afterSequence, this.#limits.maxBatchEvents);
  }

  cancel(sessionId: string): VerifiedRunCancelResult {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return missingCancel(sessionId);
    if (!isTerminalVerifiedRunStatus(session.status)) {
      session.cancelRequested = true;
      session.status = "cancelled";
    }
    return Object.freeze({ ok: true, sessionId, status: session.status });
  }

  getStatus(sessionId: string): VerifiedRunSessionStatus | null {
    return this.#sessions.get(sessionId)?.status ?? null;
  }

  clear(): void {
    this.#sessions.clear();
  }

  #handle(session: MutableVerifiedRunSession): VerifiedRunSessionHandle {
    const limits = this.#limits;
    return {
      get sessionId() {
        return session.sessionId;
      },
      get cancelRequested() {
        return session.cancelRequested;
      },
      get status() {
        return session.status;
      },
      setRunning(): void {
        if (session.status === "preparing") session.status = "running";
      },
      append(stream: VerifiedRunEvent["stream"], data: Uint8Array): boolean {
        if (isTerminalVerifiedRunStatus(session.status) || data.byteLength === 0) {
          return !isTerminalVerifiedRunStatus(session.status);
        }
        if (session.events.length >= limits.maxEvents) {
          markTruncated(session);
          return false;
        }
        const remaining = Math.max(0, limits.maxBytes - session.totalBytes);
        const acceptedLength = Math.min(remaining, data.byteLength);
        if (acceptedLength > 0) {
          const event = freezeEvent({
            sequence: session.events.length + 1,
            stream,
            data: data.subarray(0, acceptedLength),
          });
          session.events.push(event);
          session.totalBytes += acceptedLength;
        }
        if (acceptedLength < data.byteLength) {
          markTruncated(session);
          return false;
        }
        return true;
      },
      complete(result: RunResult): void {
        session.result = copyRunResult(result);
        if (session.status === "preparing" || session.status === "running") {
          session.status = "completed";
        }
      },
      fail(error: RunnerError): void {
        if (session.status === "cancelled" || session.status === "truncated") return;
        session.status = "failed";
        session.error = Object.freeze({ ...error });
      },
    };
  }

  #purgeOldestTerminalUntilCapacity(): void {
    if (this.#sessions.size < this.#limits.maxSessions) return;
    for (const [sessionId, session] of this.#sessions) {
      if (isTerminalVerifiedRunStatus(session.status)) {
        this.#sessions.delete(sessionId);
        if (this.#sessions.size < this.#limits.maxSessions) return;
      }
    }
  }
}

function markTruncated(session: MutableVerifiedRunSession): void {
  session.truncated = true;
  session.status = "truncated";
  session.error = runnerError(
    "RESOURCE_LIMIT",
    "Verified Run 实时输出达到事件或字节上限，已停止。",
  );
}

function readSession(
  session: MutableVerifiedRunSession,
  afterSequence: number,
  maxBatchEvents: number,
): VerifiedRunBatch {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    return Object.freeze({
      ok: false,
      sessionId: session.sessionId,
      error: runnerError("INVALID_REQUEST", "afterSequence 必须是非负安全整数。"),
    });
  }
  const latestSequence = session.events.at(-1)?.sequence ?? 0;
  if (afterSequence > latestSequence) {
    return Object.freeze({
      ok: false,
      sessionId: session.sessionId,
      error: runnerError(
        "INVALID_REQUEST",
        `afterSequence 超过当前 Verified Run 末尾 ${String(latestSequence)}。`,
      ),
    });
  }
  const events = session.events
    .filter((event) => event.sequence > afterSequence)
    .slice(0, maxBatchEvents)
    .map(freezeEvent);
  return Object.freeze({
    ok: true,
    sessionId: session.sessionId,
    status: session.status,
    afterSequence,
    nextSequence: events.at(-1)?.sequence ?? afterSequence,
    events: Object.freeze(events),
    totalEventCount: session.events.length,
    totalEventBytes: session.totalBytes,
    truncated: session.truncated,
    result: session.result === null ? null : copyRunResult(session.result),
    error: session.error,
  });
}

function freezeEvent(event: VerifiedRunEvent): VerifiedRunEvent {
  return Object.freeze({
    sequence: event.sequence,
    stream: event.stream,
    data: Uint8Array.from(event.data),
  });
}

function copyRunResult(result: RunResult): RunResult {
  return Object.freeze({
    ...result,
    stdout: Uint8Array.from(result.stdout),
    stderr: Uint8Array.from(result.stderr),
    ...(result.error === undefined ? {} : { error: Object.freeze({ ...result.error }) }),
  });
}

function missingBatch(sessionId: string): VerifiedRunBatch {
  return Object.freeze({
    ok: false,
    sessionId,
    error: runnerError("INVALID_REQUEST", "找不到 Verified Run session，或它已被释放。"),
  });
}

function missingCancel(sessionId: string): VerifiedRunCancelResult {
  return Object.freeze({
    ok: false,
    sessionId,
    error: runnerError("INVALID_REQUEST", "找不到 Verified Run session，或它已被释放。"),
  });
}

function runnerError(code: RunnerError["code"], message: string): RunnerError {
  return Object.freeze({ code, message });
}

function assertLimits(limits: VerifiedRunSessionLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError("Verified Run session limits 必须是正安全整数");
    }
  }
}
