import type { LearningSurface } from "./learning-surface.js";
import type { ReadySession } from "./program-analysis-session.js";
import type { SourceSelectionController } from "./source-selection-controller.js";
import type { StructureEditController } from "./structure-edit-controller.js";
import * as editTargetSelection from "./edit-target-selection.js";
import { structureEditSelectionForBlock } from "./structure-edit-selection.js";
import { createBlockTree, type BlockTree } from "../ui/block-tree.js";

export interface MainBlockTreeOptions {
  readonly host: HTMLElement;
  readonly getSession: () => ReadySession | null;
  readonly getSourceSelection: () => SourceSelectionController;
  readonly getStructureEdits: () => StructureEditController;
  readonly getLearningSurface: () => LearningSurface | null;
  readonly showEditInspector: () => void;
}

/** Keeps the renderer coordinator free of block-tree interaction plumbing. */
export function createMainBlockTree(options: MainBlockTreeOptions): BlockTree {
  return createBlockTree(
    options.host,
    (entry) => {
      const session = options.getSession();
      const target =
        session === null
          ? null
          : editTargetSelection.editTargetForBlock(session.analysis.editTargets, entry);
      const structureSelection =
        session === null ? null : structureEditSelectionForBlock(session.analysis, entry);
      options.getSourceSelection().selectBlock({
        entry,
        reveal: true,
        symbol: null,
        editTarget: target,
        inspector: target === null && structureSelection === null ? "explanation" : "edit",
        structureSelection,
      });
    },
    (sourceEntry, targetEntry) => {
      options.showEditInspector();
      void options.getStructureEdits().move(sourceEntry, targetEntry);
    },
    (intent) => {
      void options.getLearningSurface()?.insert(intent);
    },
  );
}
