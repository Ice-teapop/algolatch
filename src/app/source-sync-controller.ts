import type { ParseSummary } from "../core/model.js";
import { assessParseStability, type ParseStabilityAssessment } from "./parse-stability.js";

export type SourceSyncReason = "edit" | "undo" | "redo";
export type SourceProjectionMode = "synced" | "pending" | "recovery" | "held";

export interface SourceAnalysisLike {
  readonly document: {
    readonly source: string;
    readonly parse: ParseSummary;
  };
}

export type SourceHoldDetail =
  | {
      readonly kind: "recovery-impact";
      readonly assessment: ParseStabilityAssessment;
    }
  | { readonly kind: "analysis-failed"; readonly error: unknown };

export interface SourceSyncControllerOptions<A extends SourceAnalysisLike> {
  readonly delayMs?: number;
  readonly getCurrentSource: () => string;
  readonly getDisplayedSource: () => string | null;
  readonly validateSource: (source: string) => void;
  readonly analyze: (source: string) => A;
  readonly onPending: (source: string, reason: SourceSyncReason) => void;
  readonly onAdopt: (
    source: string,
    analysis: A,
    mode: "synced" | "recovery",
    reason: SourceSyncReason,
  ) => void;
  readonly onHold: (source: string, detail: SourceHoldDetail, reason: SourceSyncReason) => void;
}

export interface SourceSyncController {
  handleSourceChange(source: string, reason: SourceSyncReason): void;
  /** Cancels stale direct-input work after an import or other host-owned replacement. */
  reset(mode?: Extract<SourceProjectionMode, "synced" | "recovery">): void;
  getMode(): SourceProjectionMode;
  destroy(): void;
}

const DEFAULT_EDIT_DELAY_MS = 120;

/** Debounces direct typing and keeps stale analysis results out of the rendered projection. */
export function createSourceSyncController<A extends SourceAnalysisLike>(
  options: SourceSyncControllerOptions<A>,
): SourceSyncController {
  const delayMs = options.delayMs ?? DEFAULT_EDIT_DELAY_MS;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError("source sync delayMs 必须是非负安全整数");
  }
  assertCallbacks(options);

  let mode: SourceProjectionMode = "synced";
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const clearPendingTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const process = (source: string, reason: SourceSyncReason, requestGeneration: number): void => {
    timer = undefined;
    if (destroyed || requestGeneration !== generation) return;
    try {
      if (options.getCurrentSource() !== source) return;
      options.validateSource(source);
      const analysis = options.analyze(source);
      if (analysis.document.source !== source) {
        throw new Error("源码分析器返回了不同的 source snapshot");
      }
      const assessment = assessParseStability(analysis.document.parse, source.length);
      if (assessment.holdPreviousTree) {
        mode = "held";
        options.onHold(source, Object.freeze({ kind: "recovery-impact", assessment }), reason);
        return;
      }
      mode = analysis.document.parse.hasError ? "recovery" : "synced";
      options.onAdopt(source, analysis, mode, reason);
    } catch (error) {
      mode = "held";
      options.onHold(source, Object.freeze({ kind: "analysis-failed", error }), reason);
    }
  };

  return Object.freeze({
    handleSourceChange(source: string, reason: SourceSyncReason): void {
      if (destroyed) return;
      if (typeof source !== "string" || !isReason(reason)) {
        throw new TypeError("source change 必须提供字符串源码与合法 reason");
      }
      if (mode === "synced" && options.getDisplayedSource() === source) return;

      clearPendingTimer();
      generation += 1;
      const requestGeneration = generation;
      mode = "pending";
      options.onPending(source, reason);
      if (reason === "edit" && delayMs > 0) {
        timer = setTimeout(() => process(source, reason, requestGeneration), delayMs);
      } else {
        process(source, reason, requestGeneration);
      }
    },
    reset(nextMode: Extract<SourceProjectionMode, "synced" | "recovery"> = "synced"): void {
      if (destroyed) return;
      if (nextMode !== "synced" && nextMode !== "recovery") {
        throw new TypeError("source sync reset mode 必须是 synced 或 recovery");
      }
      generation += 1;
      clearPendingTimer();
      mode = nextMode;
    },
    getMode(): SourceProjectionMode {
      return mode;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearPendingTimer();
    },
  });
}

function isReason(reason: string): reason is SourceSyncReason {
  return reason === "edit" || reason === "undo" || reason === "redo";
}

function assertCallbacks<A extends SourceAnalysisLike>(
  options: SourceSyncControllerOptions<A>,
): void {
  for (const name of [
    "getCurrentSource",
    "getDisplayedSource",
    "validateSource",
    "analyze",
    "onPending",
    "onAdopt",
    "onHold",
  ] as const) {
    if (typeof options[name] !== "function") {
      throw new TypeError(`source sync options.${name} 必须是函数`);
    }
  }
}
