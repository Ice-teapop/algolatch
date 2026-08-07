import { describe, expect, it, vi } from "vitest";
import { applyFlowWorkspaceAdoptionPresentation } from "../../src/app/flow-workbench-controller.js";
import type { SidecarAdoption } from "../../src/app/workspace-sidecar-persistence.js";

describe("flow workspace first-view adoption", () => {
  it("fits a first projection with no sidecar after resetting inherited layout", () => {
    const events: string[] = [];

    const shouldPersist = applyFlowWorkspaceAdoptionPresentation(
      Object.freeze({ document: null, matchesSource: true }),
      {
        restoreSidecar: vi.fn(),
        resetPresentation: () => events.push("reset"),
        fitFirstProjection: () => events.push("fit"),
      },
    );

    expect(events).toEqual(["reset", "fit"]);
    expect(shouldPersist).toBe(true);
  });

  it("restores an existing sidecar without fitting over its viewport", () => {
    const restoreSidecar = vi.fn();
    const resetPresentation = vi.fn();
    const fitFirstProjection = vi.fn();
    const adoption: SidecarAdoption = Object.freeze({
      document: Object.freeze({
        entryId: "project-a",
        kind: "flow-view",
        revision: 4,
        sourceFingerprint: "sha256:source",
        serialized: '{"viewport":{"x":480,"y":220,"zoom":1.25}}',
        updatedAt: "2026-08-04T00:00:00.000Z",
      }),
      matchesSource: true,
    });

    const shouldPersist = applyFlowWorkspaceAdoptionPresentation(adoption, {
      restoreSidecar,
      resetPresentation,
      fitFirstProjection,
    });

    expect(restoreSidecar).toHaveBeenCalledWith(adoption.document?.serialized, true);
    expect(resetPresentation).not.toHaveBeenCalled();
    expect(fitFirstProjection).not.toHaveBeenCalled();
    expect(shouldPersist).toBe(false);
  });
});
