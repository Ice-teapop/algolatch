import type { RunResult, RunnerError } from "./api.js";

export const VERIFIED_RUN_EVENT_LIMIT = 4_096;
export const VERIFIED_RUN_BYTE_LIMIT = 1024 * 1024;
export const VERIFIED_RUN_BATCH_EVENT_LIMIT = 256;
export const VERIFIED_RUN_SESSION_LIMIT = 8;

export type VerifiedRunSessionStatus =
  "preparing" | "running" | "completed" | "failed" | "cancelled" | "truncated";

export interface VerifiedRunEvent {
  /** Strictly increasing within one session, beginning at 1. */
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly data: Uint8Array;
}

export type VerifiedRunStartResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly status: "preparing";
    }
  | {
      readonly ok: false;
      readonly error: RunnerError;
    };

export interface SuccessfulVerifiedRunBatch {
  readonly ok: true;
  readonly sessionId: string;
  readonly status: VerifiedRunSessionStatus;
  readonly afterSequence: number;
  readonly nextSequence: number;
  readonly events: readonly VerifiedRunEvent[];
  readonly totalEventCount: number;
  readonly totalEventBytes: number;
  readonly truncated: boolean;
  /** Present after the supervised process settles, including cancellation. */
  readonly result: RunResult | null;
  readonly error: RunnerError | null;
}

export interface FailedVerifiedRunBatch {
  readonly ok: false;
  readonly sessionId: string;
  readonly error: RunnerError;
}

export type VerifiedRunBatch = SuccessfulVerifiedRunBatch | FailedVerifiedRunBatch;

export type VerifiedRunCancelResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly status: VerifiedRunSessionStatus;
    }
  | {
      readonly ok: false;
      readonly sessionId: string;
      readonly error: RunnerError;
    };

export function isTerminalVerifiedRunStatus(status: VerifiedRunSessionStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "truncated"
  );
}

export function verifiedRunBatchHasTerminalEvidence(batch: VerifiedRunBatch): boolean {
  return (
    batch.ok &&
    isTerminalVerifiedRunStatus(batch.status) &&
    (batch.result !== null || batch.error !== null)
  );
}

export function verifiedRunBatchIsFullyDrained(batch: VerifiedRunBatch): boolean {
  return batch.ok && batch.nextSequence >= batch.totalEventCount;
}
