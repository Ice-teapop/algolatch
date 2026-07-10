import { describe, expect, it, vi } from "vitest";
import { createProjectionPresenter } from "../../src/app/projection-presenter.js";
import type { CAnalysisSnapshot } from "../../src/core/index.js";

describe("projection presenter", () => {
  it("disables structure actions while pending/held and adopts recoverable projections", () => {
    const harness = presenterHarness("synced");
    harness.presenter.pending("int main(", "edit");
    expect(harness.blockInteraction).toHaveBeenLastCalledWith(false);
    expect(harness.structureSelection).toHaveBeenLastCalledWith(null);
    expect(harness.projectionState).toHaveBeenLastCalledWith("pending");
    expect(harness.importStatus).toHaveBeenLastCalledWith(expect.any(String), "loading");

    harness.presenter.held("int main(", {
      kind: "recovery-impact",
      assessment: {
        affectedCodeUnits: 5,
        sourceLength: 10,
        affectedRatio: 0.5,
        holdPreviousTree: true,
      },
    });
    expect(harness.editStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "parse-error" }),
    );
    expect(harness.projectionState).toHaveBeenLastCalledWith("held", expect.any(String));

    const analysis = { document: { parse: { hasError: true } } } as CAnalysisSnapshot;
    harness.presenter.adopted("int main(void) {}", analysis, "recovery", "undo");
    expect(harness.blockInteraction).toHaveBeenLastCalledWith(true);
    expect(harness.adopt).toHaveBeenCalledWith("int main(void) {}", analysis);
    expect(harness.projectionState).toHaveBeenLastCalledWith("recovery");
  });

  it("keeps a rejected transaction in the current synced or recovery mode", () => {
    const clean = presenterHarness("synced");
    clean.presenter.inputRejected(new Error("too large"));
    expect(clean.projectionState).toHaveBeenLastCalledWith("synced");
    expect(clean.editStatus.mock.lastCall?.[0]).toBeInstanceOf(Error);
    expect(clean.blockInteraction).not.toHaveBeenCalled();

    const recovering = presenterHarness("recovery");
    recovering.presenter.inputRejected(new Error("NUL"));
    expect(recovering.projectionState).toHaveBeenLastCalledWith("recovery");
    expect(recovering.editStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "parse-error" }),
    );
    expect(recovering.blockInteraction).not.toHaveBeenCalled();

    for (const mode of ["pending", "held"] as const) {
      const unstable = presenterHarness(mode);
      unstable.presenter.inputRejected(new Error("NUL"));
      expect(unstable.importStatus).toHaveBeenLastCalledWith(
        expect.stringMatching(/未写入/u),
        "error",
      );
      expect(unstable.projectionState).not.toHaveBeenCalled();
      expect(unstable.editStatus).not.toHaveBeenCalled();
    }
  });
});

function presenterHarness(mode: "synced" | "pending" | "held" | "recovery") {
  const blockInteraction = vi.fn();
  const structureSelection = vi.fn();
  const projectionState = vi.fn();
  const importStatus = vi.fn();
  const editStatus = vi.fn();
  const adopt = vi.fn();
  const sourceMeta = { textContent: "", dataset: {} };
  const parserStatus = { textContent: "", dataset: {} as Record<string, string> };
  const presenter = createProjectionPresenter({
    elements: { sourceMeta, parserStatus } as never,
    blockTree: { setInteractionEnabled: blockInteraction },
    editPanel: { setTarget: vi.fn(), setStatus: editStatus },
    structureEditPanel: { setSelection: structureSelection },
    projectionStatus: { setState: projectionState } as never,
    sourceImport: { setStatus: importStatus },
    adopt,
    getProjectionMode: () => mode,
  });
  return {
    presenter,
    blockInteraction,
    structureSelection,
    projectionState,
    importStatus,
    editStatus,
    adopt,
  };
}
