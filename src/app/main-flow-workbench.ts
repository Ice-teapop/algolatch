import type { PanelApi } from "../shared/api.js";
import type { CodePane } from "../ui/code-pane.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";
import { draftCodePreviewsFor } from "./draft-code-preview.js";
import {
  createFlowWorkbenchController,
  type FlowWorkbenchController,
} from "./flow-workbench-controller.js";
import type { FlowSourceEditor } from "./flow-source-editor.js";
import { forwardFlowLearningObservation } from "./guided-lesson-observation-adapter.js";
import type { GuidedLessonWorkspaceController } from "./guided-lesson-workspace-controller.js";
import type { LearningSurface } from "./learning-surface.js";
import {
  mainCanvasStructureActionBindings,
  type MainCanvasStructureActions,
} from "./main-canvas-structure-actions.js";
import type { MainStatusPresenter } from "./main-status-copy.js";
import type { RuntimeWorkspaceController } from "./runtime-workspace-controller.js";
import type { SourceSelectionController } from "./source-selection-controller.js";

export interface MainFlowWorkbenchOptions {
  readonly elements: WorkbenchElements;
  readonly api: PanelApi;
  readonly codePane: CodePane;
  readonly sourceEditor: FlowSourceEditor;
  readonly status: MainStatusPresenter;
  readonly getSourceSelection: () => SourceSelectionController;
  readonly getLearningSurface: () => LearningSurface | null;
  readonly getGuidedLesson: () => GuidedLessonWorkspaceController | null;
  readonly getRuntime: () => RuntimeWorkspaceController | null;
  readonly getCanvasActions: () => MainCanvasStructureActions | null;
}

/** Keeps the root renderer focused on lifecycle wiring rather than Flow callback plumbing. */
export function createMainFlowWorkbench(
  options: MainFlowWorkbenchOptions,
): FlowWorkbenchController {
  return createFlowWorkbenchController({
    elements: options.elements,
    api: options.api,
    onNodeSelect(node) {
      if (
        node.range.from === node.range.to &&
        node.ownerBlockRange.from === node.ownerBlockRange.to
      ) {
        return;
      }
      options.getSourceSelection().selectFromOffset(node.range.from);
      options.codePane.reveal(node.range);
    },
    onReplaceNodeSource: (node, source) => options.sourceEditor.replaceNodeSource(node, source),
    onDeleteNodes: (nodes) => options.sourceEditor.deleteNodes(nodes),
    onConnectionPreflight: (intent) => options.sourceEditor.assessConnection(intent),
    onConnectionIntent: (intent) => options.sourceEditor.connectNodes(intent),
    resolvePreset: (presetId) => options.getLearningSurface()?.resolvePreset(presetId) ?? null,
    onDraftConnectionIntent: (intent) => options.sourceEditor.connectDraft(intent),
    onDraftPresentationChange: (nodes) =>
      options.codePane.setDraftPreviews(draftCodePreviewsFor(nodes)),
    onLearningObservation: (observation) =>
      forwardFlowLearningObservation(options.getGuidedLesson(), observation),
    onSourceUndo: () => options.codePane.undo(),
    onSourceRedo: () => options.codePane.redo(),
    onVirtualPlaybackNode(node) {
      if (node.presetId === "builtin.flow.pause") options.getRuntime()?.trace.pausePlayback();
    },
    ...mainCanvasStructureActionBindings(options.getCanvasActions),
    onStatus(message, state) {
      options.status.setBanner(message, state, "The flow operation could not be completed.");
    },
  });
}
