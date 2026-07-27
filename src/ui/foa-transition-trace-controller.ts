import {
  createTraceController,
  type TraceController,
  type TraceControllerState,
} from "../app/trace-controller.js";
import type { PanelApi } from "../shared/api.js";
import type { TraceSessionStatus } from "../shared/trace.js";
import type { FoaTransitionRuntimePrototype } from "../tutorials/foa-transition-runtime-63-70.js";
import type { FoaTransitionRuntime7580Timeline } from "../tutorials/foa-transition-runtime-75-80.js";
import type {
  FoaTransitionTraceBinding63,
  FoaTransitionTraceBinding70,
  FoaTransitionTraceBinding75,
  FoaTransitionTraceBinding80,
} from "../tutorials/foa-transition-trace-bindings.js";
import {
  createFoaTransitionInputDigest,
  verifyFoaTransitionTrace,
} from "../tutorials/foa-transition-trace-verifier.js";

export type FoaTransitionTraceBinding =
  | FoaTransitionTraceBinding63
  | FoaTransitionTraceBinding70
  | FoaTransitionTraceBinding75
  | FoaTransitionTraceBinding80;

export type FoaTransitionVerifiedModel =
  FoaTransitionRuntimePrototype | FoaTransitionRuntime7580Timeline;

export type FoaTransitionStageTraceStatus =
  "idle" | "unavailable" | "verifying" | "verified" | "failed";

export interface FoaTransitionStageTraceState {
  readonly status: FoaTransitionStageTraceStatus;
  readonly eventCount: number;
  readonly failureCode: string | null;
  readonly model: FoaTransitionVerifiedModel | null;
}

type TraceApi = Pick<PanelApi, "startTrace" | "readTrace" | "cancelTrace">;

export interface FoaTransitionStageTraceControllerOptions {
  readonly api?: TraceApi | undefined;
  readonly getBinding: () => FoaTransitionTraceBinding;
  readonly onStateChange: (state: FoaTransitionStageTraceState) => void;
}

export interface FoaTransitionStageTraceController {
  start(): Promise<void>;
  invalidate(): void;
  getState(): FoaTransitionStageTraceState;
  destroy(): void;
}

/**
 * Owns the explicit, one-run-at-a-time evidence upgrade for the four transition prototypes.
 * It never starts automatically and never turns partial or failed evidence into a real model.
 */
export function createFoaTransitionStageTraceController(
  options: FoaTransitionStageTraceControllerOptions,
): FoaTransitionStageTraceController {
  let destroyed = false;
  let activeBinding: FoaTransitionTraceBinding | null = null;
  let activeSessionId: string | null = null;
  let activeInputDigest: string | null = null;
  let suppressTraceState = false;
  let state = freezeState(options.api === undefined ? unavailableState() : idleState());

  const publish = (next: FoaTransitionStageTraceState): void => {
    state = freezeState(next);
    options.onStateChange(state);
  };

  const trace: TraceController | null =
    options.api === undefined
      ? null
      : createTraceController({
          api: options.api,
          getSource: () => activeBinding?.source ?? options.getBinding().source,
          getDisplayName: () => activeBinding?.lessonId ?? options.getBinding().lessonId,
          resolveTraceEvent: () => null,
          onStateChange: (traceState) => {
            if (suppressTraceState || destroyed) return;
            handleTraceState(traceState);
          },
        });

  options.onStateChange(state);

  return Object.freeze({
    async start(): Promise<void> {
      assertLive();
      if (trace === null) {
        publish(unavailableState());
        return;
      }
      invalidateActiveRun(trace);
      let binding: FoaTransitionTraceBinding;
      try {
        binding = options.getBinding();
      } catch {
        publish(failedState("binding-invalid", 0));
        return;
      }
      activeBinding = binding;
      activeInputDigest = createFoaTransitionInputDigest(binding.stdin);
      publish(verifyingState(0));
      await trace.start({
        stdin: binding.stdin,
        observationProfileId: binding.profileId,
      });
    },
    invalidate(): void {
      assertLive();
      if (trace !== null) invalidateActiveRun(trace);
      publish(trace === null ? unavailableState() : idleState());
    },
    getState(): FoaTransitionStageTraceState {
      assertLive();
      return state;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      activeBinding = null;
      activeSessionId = null;
      activeInputDigest = null;
      trace?.destroy();
    },
  });

  function handleTraceState(traceState: TraceControllerState): void {
    if (traceState.sessionId !== null) activeSessionId = traceState.sessionId;
    if (
      traceState.status === "preparing" ||
      traceState.status === "running" ||
      traceState.status === "branch"
    ) {
      publish(verifyingState(traceState.eventCount));
      return;
    }
    if (traceState.status === "completed") {
      completeVerification(traceState);
      return;
    }
    if (traceState.status === "cancelled" || traceState.status === "idle") {
      publish(idleState());
      return;
    }
    if (
      traceState.status === "error" ||
      traceState.status === "resource" ||
      traceState.status === "truncated" ||
      traceState.status === "unsupported"
    ) {
      publish(
        failedState(
          traceState.error?.code ?? traceState.unsupported?.code ?? traceState.status,
          traceState.eventCount,
        ),
      );
    }
  }

  function completeVerification(traceState: TraceControllerState): void {
    const binding = activeBinding;
    const sessionId = activeSessionId;
    const inputDigest = activeInputDigest;
    const sourceFingerprint = traceState.sourceFingerprint;
    if (
      trace === null ||
      binding === null ||
      sessionId === null ||
      inputDigest === null ||
      sourceFingerprint === null ||
      traceState.inputFingerprint === null ||
      traceState.observationProfileId === null ||
      traceState.observationAuthorizationDigest === null
    ) {
      publish(failedState("missing-run-binding", traceState.eventCount));
      return;
    }
    let result: ReturnType<typeof verifyFoaTransitionTrace>;
    try {
      result = verifyFoaTransitionTrace({
        binding,
        source: binding.source,
        sessionId,
        sourceFingerprint,
        inputDigest,
        inputFingerprint: traceState.inputFingerprint,
        observationProfileId: traceState.observationProfileId,
        observationAuthorizationDigest: traceState.observationAuthorizationDigest,
        status: "completed" satisfies TraceSessionStatus,
        events: trace.getEvents(),
        evidence: traceState.evidence,
      });
    } catch {
      publish(failedState("verification-error", traceState.eventCount));
      return;
    }
    if (!result.ok) {
      publish(failedState(result.code, traceState.eventCount));
      return;
    }
    publish(
      freezeState({
        status: "verified",
        eventCount: traceState.eventCount,
        failureCode: null,
        model: result.model,
      }),
    );
  }

  function invalidateActiveRun(controller: TraceController): void {
    suppressTraceState = true;
    const cancellation = controller.cancel();
    suppressTraceState = false;
    void cancellation.catch(() => undefined);
    activeBinding = null;
    activeSessionId = null;
    activeInputDigest = null;
  }

  function assertLive(): void {
    if (destroyed) throw new Error("FOA transition Trace controller has been destroyed");
  }
}

function idleState(): FoaTransitionStageTraceState {
  return freezeState({ status: "idle", eventCount: 0, failureCode: null, model: null });
}

function unavailableState(): FoaTransitionStageTraceState {
  return freezeState({ status: "unavailable", eventCount: 0, failureCode: null, model: null });
}

function verifyingState(eventCount: number): FoaTransitionStageTraceState {
  return freezeState({ status: "verifying", eventCount, failureCode: null, model: null });
}

function failedState(failureCode: string, eventCount: number): FoaTransitionStageTraceState {
  return freezeState({ status: "failed", eventCount, failureCode, model: null });
}

function freezeState(state: FoaTransitionStageTraceState): FoaTransitionStageTraceState {
  return Object.freeze({ ...state });
}
