import { Buffer } from "node:buffer";
import type { TerminationReason } from "../../../src/shared/api.js";
import type {
  ManagedChildProcess,
  ProcessHost,
  RemoveListener,
  RunnerClock,
  SpawnSpecification,
  TimerToken,
} from "./process-host.js";

export interface SupervisionLimits {
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxRssBytes: number;
  readonly maxProcessCount: number;
  readonly rssPollIntervalMs: number;
  /** Internal process-profile override; bounded to 250 ms and never disables watchdogs. */
  readonly normalExitReapGraceMs?: number | undefined;
}

export type ProcessTerminationReason =
  Exclude<TerminationReason, "not-started"> | "process-count-limit";

export interface ProcessOutcome {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly termination: ProcessTerminationReason;
  readonly durationMs: number;
  /** Maximum aggregate process-group RSS observed by the bounded watchdog. */
  readonly peakRssBytes: number;
  /** Maximum process-group population observed by the bounded watchdog. */
  readonly peakProcessCount: number;
  readonly processControlFailed: boolean;
}

export interface SupervisorDependencies {
  readonly clock: RunnerClock;
  readonly processHost: ProcessHost;
}

export interface ProcessObserver {
  readonly onStdout?: ((chunk: Uint8Array) => void) | undefined;
  readonly onStderr?: ((chunk: Uint8Array) => void) | undefined;
}

const KILL_REAP_TIMEOUT_MS = 1_000;
const KILL_REAP_POLL_INTERVAL_MS = 10;
// Node's `close` event can precede the kernel removing a just-exited process
// group by a few scheduler ticks on hosted macOS runners. Give normal exits a
// tiny, bounded reap window before treating the group as a surviving child.
// Resource and wall-time watchdogs remain active throughout this window.
const DEFAULT_NORMAL_EXIT_REAP_GRACE_MS = 50;
const MAX_NORMAL_EXIT_REAP_GRACE_MS = 250;
const NORMAL_EXIT_REAP_POLL_INTERVAL_MS = 10;

export async function superviseProcess(
  specification: SpawnSpecification,
  input: Uint8Array,
  limits: SupervisionLimits,
  dependencies: SupervisorDependencies,
  observer?: ProcessObserver,
): Promise<ProcessOutcome> {
  const normalExitReapGraceMs = limits.normalExitReapGraceMs ?? DEFAULT_NORMAL_EXIT_REAP_GRACE_MS;
  if (
    !Number.isSafeInteger(normalExitReapGraceMs) ||
    normalExitReapGraceMs < 0 ||
    normalExitReapGraceMs > MAX_NORMAL_EXIT_REAP_GRACE_MS
  ) {
    throw new RangeError("normal-exit reap grace 必须是 0 到 250 ms 的安全整数");
  }
  const startedAt = dependencies.clock.now();
  let child: ManagedChildProcess;

  try {
    child = dependencies.processHost.spawn(specification);
  } catch {
    return makeOutcome("spawn-error", startedAt, dependencies.clock, [], [], null, null, false);
  }

  if (child.pid === undefined || child.pid <= 1) {
    child.kill("SIGKILL");
    return makeOutcome("spawn-error", startedAt, dependencies.clock, [], [], null, null, false);
  }

  const processGroupId = child.pid;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const listeners: RemoveListener[] = [];
  let capturedBytes = 0;
  let wallTimer: TimerToken | undefined;
  let rssTimer: TimerToken | undefined;
  let reapTimer: TimerToken | undefined;
  let reapPollTimer: TimerToken | undefined;
  let normalExitReapTimer: TimerToken | undefined;
  let normalExitReapPollTimer: TimerToken | undefined;
  let winner: ProcessTerminationReason | undefined;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let closeObserved = false;
  let finished = false;
  let terminationInProgress = false;
  let processControlFailed = false;
  let peakRssBytes = 0;
  let peakProcessCount = 0;
  let resolveOutcome: ((outcome: ProcessOutcome) => void) | undefined;

  const outcomePromise = new Promise<ProcessOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const clearLimitTimers = (): void => {
    if (wallTimer !== undefined) {
      dependencies.clock.clearTimeout(wallTimer);
      wallTimer = undefined;
    }
    if (rssTimer !== undefined) {
      dependencies.clock.clearTimeout(rssTimer);
      rssTimer = undefined;
    }
  };

  const removeListeners = (): void => {
    for (const removeListener of listeners.splice(0)) {
      removeListener();
    }
  };

  const clearReapTimers = (): void => {
    if (reapTimer !== undefined) {
      dependencies.clock.clearTimeout(reapTimer);
      reapTimer = undefined;
    }
    if (reapPollTimer !== undefined) {
      dependencies.clock.clearTimeout(reapPollTimer);
      reapPollTimer = undefined;
    }
    if (normalExitReapTimer !== undefined) {
      dependencies.clock.clearTimeout(normalExitReapTimer);
      normalExitReapTimer = undefined;
    }
    if (normalExitReapPollTimer !== undefined) {
      dependencies.clock.clearTimeout(normalExitReapPollTimer);
      normalExitReapPollTimer = undefined;
    }
  };

  const finish = (reason: ProcessTerminationReason): void => {
    if (finished) {
      return;
    }
    finished = true;
    clearLimitTimers();
    clearReapTimers();
    removeListeners();
    resolveOutcome?.(
      makeOutcome(
        reason,
        startedAt,
        dependencies.clock,
        stdoutChunks,
        stderrChunks,
        exitCode,
        exitSignal,
        processControlFailed,
        peakRssBytes,
        peakProcessCount,
      ),
    );
  };

  const observeProcessGroupGone = (): boolean | undefined => {
    try {
      return !dependencies.processHost.isProcessGroupAlive(processGroupId);
    } catch {
      processControlFailed = true;
      return undefined;
    }
  };

  const scheduleReapPoll = (): void => {
    if (finished || !terminationInProgress || reapPollTimer !== undefined) {
      return;
    }
    reapPollTimer = dependencies.clock.setTimeout(() => {
      reapPollTimer = undefined;
      const processGroupGone = observeProcessGroupGone();
      if (closeObserved && processGroupGone === true) {
        finish(winner as ProcessTerminationReason);
        return;
      }
      scheduleReapPoll();
    }, KILL_REAP_POLL_INTERVAL_MS);
  };

  const waitForCloseAndReap = (): void => {
    const processGroupGone = observeProcessGroupGone();
    if (closeObserved && processGroupGone === true) {
      finish(winner as ProcessTerminationReason);
      return;
    }
    scheduleReapPoll();
  };

  const terminate = (
    reason: ProcessTerminationReason,
    forceProcessControlFailure = false,
  ): void => {
    if (finished || terminationInProgress) {
      return;
    }
    terminationInProgress = true;
    winner = reason;
    if (forceProcessControlFailure) {
      processControlFailed = true;
    }
    clearLimitTimers();
    clearReapTimers();
    try {
      dependencies.processHost.killProcessGroup(processGroupId, "SIGKILL");
    } catch {
      processControlFailed = true;
      try {
        if (!child.kill("SIGKILL")) {
          processControlFailed = true;
        }
      } catch {
        processControlFailed = true;
      }
    }
    reapTimer = dependencies.clock.setTimeout(() => {
      reapTimer = undefined;
      const processGroupGone = observeProcessGroupGone();
      if (!closeObserved || processGroupGone !== true) {
        processControlFailed = true;
      }
      finish(reason);
    }, KILL_REAP_TIMEOUT_MS);
    waitForCloseAndReap();
  };

  const waitForNormalExitReap = (): void => {
    if (finished || terminationInProgress || normalExitReapTimer !== undefined) return;

    const poll = (): void => {
      normalExitReapPollTimer = undefined;
      if (finished || terminationInProgress) return;
      const processGroupGone = observeProcessGroupGone();
      if (processGroupGone === true) {
        finish("process-exit");
        return;
      }
      if (processGroupGone === undefined) {
        terminate("process-exit", true);
        return;
      }
      normalExitReapPollTimer = dependencies.clock.setTimeout(
        poll,
        NORMAL_EXIT_REAP_POLL_INTERVAL_MS,
      );
    };

    normalExitReapTimer = dependencies.clock.setTimeout(() => {
      normalExitReapTimer = undefined;
      if (finished || terminationInProgress) return;
      const processGroupGone = observeProcessGroupGone();
      if (processGroupGone === true) {
        finish("process-exit");
        return;
      }
      terminate("process-exit", true);
    }, normalExitReapGraceMs);
    normalExitReapPollTimer = dependencies.clock.setTimeout(
      poll,
      NORMAL_EXIT_REAP_POLL_INTERVAL_MS,
    );
  };

  const capture = (
    chunk: Uint8Array,
    destination: Buffer[],
    channel: "stdout" | "stderr",
  ): void => {
    if (terminationInProgress) {
      return;
    }
    try {
      if (channel === "stdout") observer?.onStdout?.(Uint8Array.from(chunk));
      else observer?.onStderr?.(Uint8Array.from(chunk));
    } catch {
      terminate("rss-monitor-error");
      return;
    }
    const buffer = Buffer.from(chunk);
    const remaining = Math.max(0, limits.maxOutputBytes - capturedBytes);
    if (remaining > 0) {
      const captured = buffer.subarray(0, Math.min(remaining, buffer.byteLength));
      destination.push(Buffer.from(captured));
      capturedBytes += captured.byteLength;
    }
    if ((winner === undefined || winner === "process-exit") && buffer.byteLength > remaining) {
      terminate("output-limit");
    }
  };

  listeners.push(
    child.onStdout((chunk) => capture(chunk, stdoutChunks, "stdout")),
    child.onStderr((chunk) => capture(chunk, stderrChunks, "stderr")),
    child.onError(() => {
      terminate("spawn-error");
    }),
    child.onInputError(() => terminate("input-error")),
    child.onExit((code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (winner === undefined) {
        // "exit" only means the leader ended. Descendants can still hold the
        // stdio pipes open, so resource watchdogs stay active until "close".
        winner = "process-exit";
      }
    }),
    child.onClose((code, signal) => {
      closeObserved = true;
      exitCode = code;
      exitSignal = signal;
      if (winner === undefined) {
        winner = "process-exit";
      }
      if (winner === "process-exit") {
        const processGroupGone = observeProcessGroupGone();
        if (processGroupGone === true) {
          finish("process-exit");
          return;
        }
        if (processGroupGone === undefined) {
          terminate("process-exit", true);
          return;
        }
        // A descendant can close inherited stdio and keep running in the same
        // process group. First allow a bounded natural-reap grace; persistent
        // residue is then killed and still reported as a control failure.
        waitForNormalExitReap();
        return;
      }
      waitForCloseAndReap();
    }),
  );

  wallTimer = dependencies.clock.setTimeout(() => terminate("wall-time-limit"), limits.wallTimeMs);

  const pollRss = (): void => {
    rssTimer = dependencies.clock.setTimeout(() => {
      rssTimer = undefined;
      void dependencies.processHost
        .sampleProcessGroupResources(processGroupId)
        .then(({ rssBytes, processCount }) => {
          if (finished || terminationInProgress) {
            return;
          }
          if (
            !Number.isSafeInteger(rssBytes) ||
            rssBytes < 0 ||
            !Number.isSafeInteger(processCount) ||
            processCount < 0
          ) {
            terminate("rss-monitor-error");
            return;
          }
          peakRssBytes = Math.max(peakRssBytes, rssBytes);
          peakProcessCount = Math.max(peakProcessCount, processCount);
          if (processCount > limits.maxProcessCount) {
            terminate("process-count-limit");
            return;
          }
          if (rssBytes > limits.maxRssBytes) {
            terminate("rss-limit");
            return;
          }
          pollRss();
        })
        .catch(() => terminate("rss-monitor-error"));
    }, limits.rssPollIntervalMs);
  };
  pollRss();

  try {
    child.endInput(input);
  } catch {
    terminate("input-error");
  }

  return outcomePromise;
}

function makeOutcome(
  termination: ProcessTerminationReason,
  startedAt: number,
  clock: RunnerClock,
  stdoutChunks: readonly Buffer[],
  stderrChunks: readonly Buffer[],
  exitCode: number | null,
  signal: string | null,
  processControlFailed: boolean,
  peakRssBytes = 0,
  peakProcessCount = 0,
): ProcessOutcome {
  return Object.freeze({
    stdout: Uint8Array.from(Buffer.concat(stdoutChunks)),
    stderr: Uint8Array.from(Buffer.concat(stderrChunks)),
    exitCode,
    signal,
    termination,
    durationMs: Math.max(0, clock.now() - startedAt),
    peakRssBytes,
    peakProcessCount,
    processControlFailed,
  });
}
