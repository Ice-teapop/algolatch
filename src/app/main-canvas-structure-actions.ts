import * as editTargetSelection from "./edit-target-selection.js";
import type { LearningSurface } from "./learning-surface.js";
import type { ReadySession } from "./program-analysis-session.js";
import type { SourceSelectionController } from "./source-selection-controller.js";
import type { StructureEditController } from "./structure-edit-controller.js";
import {
  createCanvasStructureActionController,
  type CanvasStructureActionController,
} from "./canvas-structure-action-controller.js";
import type { FlowProjection } from "../flow/index.js";
import type { FlowEdge, FlowNode } from "../flow/index.js";
import type {
  CanvasEdgeInsertionAvailability,
  CanvasEdgeInsertPreset,
  CanvasEdgeInsertRequest,
  CanvasStructureAction,
  CanvasStructureAvailability,
} from "../ui/canvas-structure-actions.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import type { CAnalysisSnapshot } from "../core/index.js";
import type { CanvasSlotInsertRequest } from "./canvas-slot-inventory.js";

export interface MainCanvasStructureActionsOptions {
  /** Brings the edit inspector forward; the edit confirmation renders inside it. */
  readonly showEditInspector: () => void;
  readonly getSession: () => ReadySession | null;
  readonly getProjection: () => FlowProjection | null;
  readonly structureEdits: StructureEditController;
  readonly sourceSelection: SourceSelectionController;
  readonly getLearningSurface: () => LearningSurface | null;
  readonly onError: (error: Error) => void;
}

export interface MainCanvasStructureActions {
  handleStructureAction(action: CanvasStructureAction): boolean;
  handleEdgeInsertRequest(request: CanvasEdgeInsertRequest): boolean;
  listCompatiblePresets(
    request: CanvasEdgeInsertRequest,
    locale?: InterfaceLocale,
  ): readonly CanvasEdgeInsertPreset[];
  handleEdgePresetInsertRequest(request: CanvasEdgeInsertRequest, presetId: string): boolean;
  inspectNode(node: FlowNode, locale?: InterfaceLocale): CanvasStructureAvailability;
  inspectEdge(edge: FlowEdge, locale?: InterfaceLocale): CanvasEdgeInsertionAvailability;
  canInsertOnEdge(edge: FlowEdge): boolean;
  /** Statement targets the canvas drop strips are derived from. */
  getStatementAnalysis(): CAnalysisSnapshot | null;
  handleSlotInsertRequest(request: CanvasSlotInsertRequest): boolean;
  destroy(): void;
}

export function mainCanvasStructureActionBindings(
  getActions: () => MainCanvasStructureActions | null,
) {
  return Object.freeze({
    onCanvasStructureAction: (action: CanvasStructureAction) =>
      getActions()?.handleStructureAction(action) ?? false,
    onCanvasEdgeInsertRequest: (request: CanvasEdgeInsertRequest) =>
      getActions()?.handleEdgeInsertRequest(request) ?? false,
    getCanvasEdgeInsertPresets: (request: CanvasEdgeInsertRequest, locale: InterfaceLocale) =>
      getActions()?.listCompatiblePresets(request, locale) ?? Object.freeze([]),
    onCanvasEdgePresetInsert: (request: CanvasEdgeInsertRequest, presetId: string) =>
      getActions()?.handleEdgePresetInsertRequest(request, presetId) ?? false,
    inspectCanvasNode: (node: FlowNode, locale: InterfaceLocale) =>
      getActions()?.inspectNode(node, locale),
    inspectCanvasEdge: (edge: FlowEdge, locale: InterfaceLocale) =>
      getActions()?.inspectEdge(edge, locale),
    getStatementAnalysis: () => getActions()?.getStatementAnalysis() ?? null,
    onCanvasSlotInsertRequest: (request: CanvasSlotInsertRequest) =>
      getActions()?.handleSlotInsertRequest(request) ?? false,
  });
}

/** Connects the validated canvas intents to the existing inspector and preset surfaces. */
export function createMainCanvasStructureActions(
  options: MainCanvasStructureActionsOptions,
): MainCanvasStructureActions {
  const controller: CanvasStructureActionController = createCanvasStructureActionController({
    getAnalysis: () => options.getSession()?.analysis ?? null,
    getProjection: options.getProjection,
    structureEdits: options.structureEdits,
    onEditTarget(intent) {
      const session = requireSession(options.getSession());
      options.sourceSelection.selectBlock({
        entry: intent.target,
        reveal: true,
        symbol: null,
        editTarget: editTargetSelection.editTargetForBlock(
          session.analysis.editTargets,
          intent.target,
        ),
        inspector: "edit",
        structureSelection: intent.selection,
      });
    },
    onSelectPresetTarget(intent) {
      const session = requireSession(options.getSession());
      const learningSurface = options.getLearningSurface();
      if (learningSurface === null) throw new Error("积木目录尚未准备好");
      options.sourceSelection.selectBlock({
        entry: intent.target,
        reveal: true,
        symbol: null,
        editTarget: editTargetSelection.editTargetForBlock(
          session.analysis.editTargets,
          intent.target,
        ),
        inspector: "edit",
        structureSelection: intent.selection,
      });
      learningSurface.prepareCanvasPresetInsert({
        sourceFingerprint: intent.sourceFingerprint,
        target: intent.target,
        position: intent.position,
      });
    },
    onListPresetTarget(intent, locale) {
      const learningSurface = options.getLearningSurface();
      if (learningSurface === null) throw new Error("积木目录尚未准备好");
      return learningSurface.listCompatibleCanvasPresets(
        {
          sourceFingerprint: intent.sourceFingerprint,
          target: intent.target,
          position: intent.position,
        },
        locale,
      );
    },
    onInsertPresetTarget(intent, presetId) {
      const session = requireSession(options.getSession());
      const learningSurface = options.getLearningSurface();
      if (learningSurface === null) throw new Error("积木目录尚未准备好");
      options.sourceSelection.selectBlock({
        entry: intent.target,
        reveal: true,
        symbol: null,
        editTarget: editTargetSelection.editTargetForBlock(
          session.analysis.editTargets,
          intent.target,
        ),
        inspector: "edit",
        structureSelection: intent.selection,
      });
      return learningSurface.insertCanvasPreset(
        {
          sourceFingerprint: intent.sourceFingerprint,
          target: intent.target,
          position: intent.position,
        },
        presetId,
      );
    },
    onError: options.onError,
  });

  return Object.freeze({
    handleStructureAction: (action: CanvasStructureAction) =>
      controller.handleStructureAction(action),
    handleEdgeInsertRequest: (request: CanvasEdgeInsertRequest) =>
      controller.handleEdgeInsertRequest(request),
    listCompatiblePresets: (request: CanvasEdgeInsertRequest, locale: InterfaceLocale = "zh-CN") =>
      controller.listCompatiblePresets(request, locale),
    handleEdgePresetInsertRequest: (request: CanvasEdgeInsertRequest, presetId: string) =>
      controller.handleEdgePresetInsertRequest(request, presetId),
    inspectNode: (node: FlowNode, locale: InterfaceLocale = "zh-CN") =>
      controller.inspectNode(node, locale),
    inspectEdge: (edge: FlowEdge, locale: InterfaceLocale = "zh-CN") =>
      controller.inspectEdge(edge, locale),
    canInsertOnEdge: (edge: FlowEdge) => controller.canInsertOnEdge(edge),
    getStatementAnalysis: () => options.getSession()?.analysis ?? null,
    handleSlotInsertRequest(request: CanvasSlotInsertRequest) {
      // The confirmation renders inside the edit inspector. A slot drop happens while the
      // canvas owns the semantic monitor, so without revealing that panel first the reader
      // would be left awaiting a dialog that exists but is off screen, and the edit would
      // silently never land. run() then owns plan -> confirm -> commit and reports its own
      // failures through onError, so `true` means "the drop was taken", not "the edit landed".
      options.showEditInspector();
      void options.structureEdits.run(request);
      return true;
    },
    destroy: () => controller.destroy(),
  });
}

function requireSession(session: ReadySession | null): ReadySession {
  if (session === null) throw new Error("源码会话尚未就绪");
  return session;
}
