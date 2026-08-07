import * as core from "./core/index.js";
import * as editTargetSelection from "./app/edit-target-selection.js";
import { createCCommandWorkspaceController } from "./app/c-command-workspace-controller.js";
import { createFlowSourceEditor } from "./app/flow-source-editor.js";
import { createMainBlockTree } from "./app/main-block-tree.js";
import { createMainCanvasStructureActions } from "./app/main-canvas-structure-actions.js";
import { createMainFlowWorkbench } from "./app/main-flow-workbench.js";
import type { LearningSurface } from "./app/learning-surface.js";
import type { LoadedLearningCatalogStorage } from "./app/learning-catalog-disk-storage.js";
import { emptyProgramAnalysisSnapshot, type ReadySession } from "./app/program-analysis-session.js";
import { createProgramAnalysisCoordinator } from "./app/program-analysis-coordinator.js";
import { createProjectionPresenter, type ProjectionPresenter } from "./app/projection-presenter.js";
import { sourceMetadata } from "./app/source-display.js";
import { createSourceImportController } from "./app/source-import-controller.js";
import { clearStaleSourcePresentation } from "./app/stale-source-presentation.js";
import { createStructureEditController } from "./app/structure-edit-controller.js";
import { createSourceSyncController } from "./app/source-sync-controller.js";
import { structureEditSelectionForBlock } from "./app/structure-edit-selection.js";
import { createSourceSelectionController } from "./app/source-selection-controller.js";
import { createStructuredEditCoordinator } from "./app/structured-edit-coordinator.js";
import { requireService } from "./app/required-service.js";
import { createRuntimeWorkspaceController } from "./app/runtime-workspace-controller.js";
import type { GuidedLessonWorkspaceController } from "./app/guided-lesson-workspace-controller.js";
import { forwardRuntimeLearningObservation } from "./app/guided-lesson-observation-adapter.js";
import { createWorkbenchRuntime, initializeRendererLocale } from "./app/workbench-runtime.js";
import { createMainStatus } from "./app/main-status-copy.js";
import { createWorkspaceLessonIntegration } from "./app/workspace-lesson-integration.js";
import { createMainAiWorkspace } from "./app/main-ai-workspace.js";
import { installApplicationPersistence } from "./app/application-persistence.js";
import { initializeWorkbenchApplication } from "./renderer/application-bootstrap.js";
import { createFlowProjection } from "./flow/index.js";
import { assertValidSourceText } from "./shared/source-import.js";
import type { ImportedSource } from "./shared/api.js";
import { createCodePane, type CodeSourceChangeReason } from "./ui/code-pane.js";
import { createEditPanel, type EditPanel } from "./ui/edit-panel.js";
import { renderExplanationView } from "./ui/explanation-view.js";
import { createProjectionStatus } from "./ui/projection-status.js";
import { createStructureEditPanel, type StructureEditPanel } from "./ui/structure-edit-panel.js";
const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("缺少应用挂载节点 #app");
const systemLocale = await initializeRendererLocale(window.panelApi);
const runtime = createWorkbenchRuntime(app, window.panelApi, systemLocale);
const { elements, startupLoader } = runtime;
const explanationHost = elements.getInspectorHost("explanation");
let parser: core.CParser | null = null;
let session: ReadySession | null = null;
let destroyed = false;
let editPanel: EditPanel<core.StructuredEditPlan> | null = null;
let structureEditPanel: StructureEditPanel | null = null;
let structureEdits: ReturnType<typeof createStructureEditController> | null = null;
let projectionPresenter: ProjectionPresenter | null = null;
let learningSurface: LearningSurface | null = null;
let learningCatalogStorage: LoadedLearningCatalogStorage | null = null;
let flowWorkbench: ReturnType<typeof createMainFlowWorkbench> | null = null;
let cCommand: ReturnType<typeof createCCommandWorkspaceController> | null = null;
let runtimeWorkspace: ReturnType<typeof createRuntimeWorkspaceController> | null = null;
let sourceSelection: ReturnType<typeof createSourceSelectionController> | null = null;
let canvasStructureActions: ReturnType<typeof createMainCanvasStructureActions> | null = null;
let guidedLesson: GuidedLessonWorkspaceController | null = null;
let aiWorkspace: ReturnType<typeof createMainAiWorkspace> | null = null;
const mainStatus = createMainStatus(elements, (status) => editPanel?.setStatus(status));
const requireEditPanel = () => requireService(editPanel, "编辑检查器不可用");
const requireStructureEditPanel = () => requireService(structureEditPanel, "结构编辑面板不可用");
const requireStructureEdits = () => requireService(structureEdits, "结构编辑控制器不可用");
const requireProjectionPresenter = () => requireService(projectionPresenter, "投影不可用");
const requireFlowWorkbench = () => requireService(flowWorkbench, "自由流程工作台不可用");
const requireRuntimeWorkspace = () => requireService(runtimeWorkspace, "运行工作台不可用");
const requireSourceSelection = () => requireService(sourceSelection, "源码选择控制器不可用");
const projectionStatus = createProjectionStatus(elements.codePane);
const codePane = createCodePane(elements.codePane, {
  editable: true,
  localeHost: elements.shell,
  validateSource: assertValidSourceText,
  onInputRejected: (error) => requireProjectionPresenter().inputRejected(error),
  onSourceOffset: (offset) => sourceSelection?.selectFromOffset(offset),
  onSourceChange: onCodeSourceChange,
});
const blockTree = createMainBlockTree({
  host: elements.blockTree,
  getSession: () => session,
  getSourceSelection: requireSourceSelection,
  getStructureEdits: requireStructureEdits,
  getLearningSurface: () => learningSurface,
  showEditInspector: () => elements.showInspector("edit"),
});
const flowSourceEditor = createFlowSourceEditor({
  getSession: () => session,
  getProjection: () => flowWorkbench?.projection ?? null,
  getParser: () => parser,
  getProjectionMode: () => sourceSync.getMode(),
  getEditorSource: () => codePane.getSource(),
  applyPatches: (patches) => codePane.applyPatches(patches),
  resetProjection: () => sourceSync.reset("synced"),
  nextRevision: nextSessionRevision,
  adopt: (imported, analysis, preferredTarget) =>
    adoptAnalysis(imported, analysis, false, preferredTarget),
  confirmReversibleEdits: true,
  confirm: (message) => globalThis.confirm(message),
  onCommitted: (message) => mainStatus.setBanner(message, "ready", "Source updated."),
});
flowWorkbench = createMainFlowWorkbench({
  elements,
  api: window.panelApi,
  codePane,
  sourceEditor: flowSourceEditor,
  status: mainStatus,
  getSourceSelection: requireSourceSelection,
  getLearningSurface: () => learningSurface,
  getGuidedLesson: () => guidedLesson,
  getRuntime: () => runtimeWorkspace,
  getCanvasActions: () => canvasStructureActions,
});
const programAnalysisCoordinator = createProgramAnalysisCoordinator({
  getSession: () => session,
  setProgramAnalysis(nextAnalysis) {
    if (session === null) throw new Error("源码会话尚未就绪");
    session = Object.freeze({ ...session, programAnalysis: nextAnalysis });
    return session;
  },
  getSelectedBlock: () => blockTree.getSelectedEntry()?.block ?? null,
  onProjection: (current) => {
    requireFlowWorkbench().adoptProjection(
      createFlowProjection(current.programAnalysis, current.analysis.document),
    );
    requireFlowWorkbench().setAnalysis(current.programAnalysis);
    runtimeWorkspace?.setAnalysis(current.programAnalysis);
  },
  onExplanation: (current, block) =>
    renderExplanationView(
      explanationHost,
      current.analysis.document,
      block,
      null,
      current.programAnalysis,
    ),
  onProgress(functionCount, complete) {
    elements.parserStatus.dataset.analysisState = complete ? "complete" : "progressive";
    elements.parserStatus.dataset.analyzedFunctions = String(functionCount);
    if (complete) {
      requireFlowWorkbench().finalizePendingSidecarRestore();
      guidedLesson?.verifyCurrentProjection(sessionRoundTripIsLossless());
    }
  },
  onError(error) {
    elements.parserStatus.dataset.analysisState = "worker-error";
    mainStatus.setLocalizedBanner(
      `后台 CFG 分析不可用：${error.message}。源码编辑与编译运行仍可使用。`,
      "Background CFG analysis is unavailable. Source editing, compiling, and running remain available.",
      "warning",
    );
  },
});
const panelEdits = createStructuredEditCoordinator({
  getSession: () => session,
  getParser: () => parser,
  assertStructureReady: () => requireStructureEdits().assertReady(),
  validateSource: assertValidSourceText,
  getProjectionMode: () => sourceSync.getMode(),
  getEditorSource: () => codePane.getSource(),
  applyPatches: (patches) => codePane.applyPatches(patches),
  resetProjection: () => sourceSync.reset("synced"),
  adopt: (imported, analysis, preferredTarget) =>
    adoptAnalysis(imported, analysis, false, preferredTarget),
  onCommitted() {
    mainStatus.setCommitted("edit");
  },
});
editPanel = createEditPanel<core.StructuredEditPlan>(elements.getInspectorHost("edit"), {
  plan: (request) => panelEdits.plan(request),
  commit: (plan) => panelEdits.commit(plan),
  undo: () => {
    codePane.undo();
    editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  },
  redo: () => {
    codePane.redo();
    editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  },
});
structureEditPanel = createStructureEditPanel<core.M3bEditPlan>(elements.getInspectorHost("edit"), {
  plan: (request) => requireStructureEdits().plan(request),
  confirm: (plan) => requireEditPanel().confirmExternal(plan),
  commit: (plan) => requireStructureEdits().commit(plan),
});
sourceSelection = createSourceSelectionController({
  explanationHost,
  getSession: () => session,
  getProjectionMode: () => sourceSync.getMode(),
  getEditorSource: () => codePane.getSource(),
  getHistoryDepth: () => codePane.getHistoryDepth(),
  getCurrentPage: () => elements.currentPage,
  showInspector: (view) => elements.showInspector(view),
  selectTreeEntry: (entry) => blockTree.select(entry),
  setEditTarget: (target) => editPanel?.setTarget(target),
  setStructureSelection: (selection) => structureEditPanel?.setSelection(selection),
  setInsertEnabled: (enabled) => learningSurface?.setSelectedInsertEnabled(enabled),
  setHistoryDepth: (depth) => editPanel?.setHistoryDepth(depth),
  setParseError: (message) => mainStatus.setParseError(message),
  setHighlights: (highlights) => codePane.setHighlights(highlights),
  reveal: (range) => codePane.reveal(range),
});
runtimeWorkspace = createRuntimeWorkspaceController({
  elements,
  api: window.panelApi,
  codePane,
  blockTree,
  getSource: () => codePane.getSource(),
  getAnalyzedSource: () => session?.imported.source ?? null,
  getDisplayName: () => session?.imported.displayName ?? "main.c",
  getAnalysis: () => session?.programAnalysis ?? null,
  getProjection: () => flowWorkbench?.projection ?? null,
  onSetActivePath: (path, evidence) => requireFlowWorkbench().setActivePath(path, evidence),
  onRevealFlow: () => elements.showSemanticView("flow"),
  onFocusNode: (nodeId) => requireFlowWorkbench().focusNode(nodeId),
  onRevealRange: (range) => codePane.reveal(range),
  onLearningObservation: (observation) =>
    forwardRuntimeLearningObservation(guidedLesson, observation, learningSurface ?? undefined),
});
const workspaceLesson = createWorkspaceLessonIntegration({
  elements,
  api: window.panelApi,
  codePane,
  flow: requireFlowWorkbench(),
  runtime: requireRuntimeWorkspace(),
  loadSource: (document) => loadSource(document, false),
  getCurrentDocument: () =>
    session === null ? null : Object.freeze({ ...session.imported, source: codePane.getSource() }),
  onActiveEntryChange: (entry) => {
    void aiWorkspace?.setWorkspace(entry);
    cCommand?.setWorkspaceEntry(entry?.id ?? null);
  },
  isDestroyed: () => destroyed,
  onError: (message) =>
    mainStatus.setError(message, "The guided workspace operation could not be completed."),
});
const workspaceController = workspaceLesson.workspace;
guidedLesson = workspaceLesson.guidedLesson;
const sourceImport = createSourceImportController(elements, {
  load: async (document, isCurrent) => {
    if (await workspaceController.prepareExternalImport(isCurrent)) loadSource(document);
  },
});
projectionPresenter = createProjectionPresenter({
  elements,
  blockTree,
  editPanel: requireEditPanel(),
  structureEditPanel: requireStructureEditPanel(),
  projectionStatus,
  sourceImport,
  adopt: (source, analysis) => {
    const current = session;
    if (current === null) throw new Error("源码会话尚未就绪");
    adoptAnalysis(Object.freeze({ ...current.imported, source }), analysis, false, null);
  },
  getProjectionMode: () => sourceSync.getMode(),
});
const sourceSync = createSourceSyncController<core.CAnalysisSnapshot>({
  getCurrentSource: () => codePane.getSource(),
  getDisplayedSource: () => session?.imported.source ?? null,
  validateSource: assertValidSourceText,
  analyze: analyzeCurrentSource,
  onPending: (source, reason) => requireProjectionPresenter().pending(source, reason),
  onAdopt: (source, analysis, mode, reason) =>
    requireProjectionPresenter().adopted(source, analysis, mode, reason),
  onHold: (source, detail) => requireProjectionPresenter().held(source, detail),
});
structureEdits = createStructureEditController({
  getSession: () => session,
  getAnalyzer: () => parser,
  getCurrentSource: () => codePane.getSource(),
  getProjectionMode: () => sourceSync.getMode(),
  resetProjection: () => sourceSync.reset("synced"),
  validateSource: assertValidSourceText,
  applyPatches: (patches) => codePane.applyPatches(patches),
  confirm: (plan) => requireEditPanel().confirmExternal(plan),
  adopt: (imported, analysis) => adoptAnalysis(imported, analysis, false, null),
  onSuccess: () => {
    mainStatus.setCommitted("structure");
    elements.showPage("build");
  },
  onError: (error) => mainStatus.setEditError(error, "The structural edit could not be completed."),
});
canvasStructureActions = createMainCanvasStructureActions({
  showEditInspector: () => elements.showInspector("edit"),
  getSession: () => session,
  getProjection: () => flowWorkbench?.projection ?? null,
  structureEdits: requireStructureEdits(),
  sourceSelection: requireSourceSelection(),
  getLearningSurface: () => learningSurface,
  onError: (error) => mainStatus.setEditError(error, "The canvas edit could not be completed."),
});
aiWorkspace = createMainAiWorkspace({
  elements,
  api: window.panelApi,
  codePane,
  getRuntime: () => runtimeWorkspace,
  getSession: () => session,
  getProjection: () => flowWorkbench?.projection ?? null,
  getParser: () => parser,
  getProjectionMode: () => sourceSync.getMode(),
  resetProjection: () => sourceSync.reset("synced"),
  nextRevision: nextSessionRevision,
  adopt: (imported, analysis) => adoptAnalysis(imported, analysis, false, null),
  onStatus: (message) => mainStatus.setBanner(message, "ready", "AI workspace updated."),
});
void initializeWorkbenchApplication({
  elements,
  startupLoader,
  api: window.panelApi,
  blockTree,
  structureEdits: requireStructureEdits(),
  sourceImport,
  workspace: workspaceController,
  getAnalysis: () => session?.analysis ?? null,
  isDestroyed: () => destroyed,
  onStartGuidedLesson: () =>
    void guidedLesson
      ?.startLesson()
      .catch((error: Error) =>
        mainStatus.setBanner(error.message, "error", "The lesson could not be started."),
      ),
  onOpenFoaWorkspace: workspaceLesson.openFoaLesson,
  onReady(loadedParser, surface, storage) {
    parser = loadedParser;
    learningSurface = surface;
    learningCatalogStorage = storage;
    cCommand = createCCommandWorkspaceController({
      host: elements.cCommandHost,
      api: window.panelApi,
      parser: loadedParser,
      nextRevision: nextSessionRevision,
      previewProjection: (projection, analysis) =>
        requireFlowWorkbench().previewProjection(projection, analysis),
      clearProjectionPreview: () => requireFlowWorkbench().clearProjectionPreview(),
      getMainSource: () => codePane.getSource(),
      getRuntimeInput: () => {
        const input = requireRuntimeWorkspace().getRuntimeInput();
        return Object.freeze({
          stdin: input.stdin,
          args: Object.freeze([...input.arguments]),
          fixtures: Object.freeze([]),
        });
      },
      confirmWrite: (plan) => {
        elements.showInspector("edit");
        return requireEditPanel().confirmExternal(plan);
      },
      applyPatches: (patches) => codePane.applyPatches(patches),
      onProjectionError: (error) =>
        mainStatus.setEditError(error, "The C Cell preview could not be generated."),
    });
    cCommand.setWorkspaceEntry(workspaceController.activeEntry?.id ?? null);
  },
  onLearningError(error) {
    mainStatus.setEditError(error, "The learning block operation could not be completed.");
  },
});
function loadSource(imported: ImportedSource, navigate = true): void {
  if (parser === null) throw new Error("C 解析器尚未加载");
  const analysis = parser.analyze(imported.source, nextSessionRevision());
  const projectionMode = analysis.document.parse.hasError ? "recovery" : "synced";
  sourceSync.reset(projectionMode);
  blockTree.setInteractionEnabled(true);
  adoptAnalysis(imported, analysis, true, null);
  projectionStatus.setState(projectionMode);
  if (navigate) {
    elements.showPage("build");
    if (elements.shell.dataset.commandView === "command") elements.showSemanticView("flow");
  }
}
function adoptAnalysis(
  imported: ImportedSource,
  analysis: core.CAnalysisSnapshot,
  resetEditor: boolean,
  preferredTarget: core.EditTarget | null,
): void {
  const { document } = analysis;
  if (core.renderSourceDoc(document) !== imported.source) {
    throw new Error("无损投影未能逐字符重建输入源码");
  }
  if (analysis.editTargets.revision < 0) {
    throw new Error("编辑目标快照缺少合法版本号");
  }
  if (!resetEditor && codePane.getSource() !== imported.source) {
    throw new Error("CodeMirror 精确源码与分析快照不同步");
  }
  const blockIndex = core.createBlockIndex(document);
  const programAnalysis = emptyProgramAnalysisSnapshot(
    imported.source,
    analysis.editTargets.revision,
  );
  session = Object.freeze({ imported, analysis, blockIndex, programAnalysis });
  requireFlowWorkbench().adoptProjection(createFlowProjection(programAnalysis, document));
  requireFlowWorkbench().setAnalysis(programAnalysis);
  programAnalysisCoordinator.schedule(imported, analysis, blockIndex.entries.length);
  if (resetEditor) codePane.setSource(imported.source);
  blockTree.setDocument(document, blockIndex);
  elements.fileName.textContent = imported.displayName;
  elements.sourceMeta.textContent = sourceMetadata(imported.source);
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  const functionCount = blockIndex.entries.filter(
    (entry) => entry.block?.kind === "syntax" && entry.block.role === "function",
  ).length;
  mainStatus.setParserReady(document.parse.hasError, document.issues.length);
  elements.parserStatus.dataset.state = document.parse.hasError ? "warning" : "ready";
  elements.parserStatus.dataset.rootType = "translation_unit";
  elements.parserStatus.dataset.functionCount = String(functionCount);
  elements.parserStatus.dataset.roundtrip = "true";
  if (preferredTarget !== null) {
    const preferredEntry = editTargetSelection.blockEntryForTarget(blockIndex, preferredTarget);
    requireSourceSelection().selectBlock({
      entry: preferredEntry,
      reveal: false,
      symbol: null,
      editTarget: preferredTarget,
      inspector: "edit",
      structureSelection: structureEditSelectionForBlock(analysis, preferredEntry),
    });
  } else {
    const firstFunction = blockIndex.entries.find(
      (entry) => entry.block?.kind === "syntax" && entry.block.role === "function",
    );
    const firstBlock = blockIndex.entries.find((entry) => entry.kind === "block");
    const initialEntry = firstFunction ?? firstBlock ?? blockIndex.entries[0] ?? null;
    const structureSelection = structureEditSelectionForBlock(analysis, initialEntry);
    requireSourceSelection().selectBlock({
      entry: initialEntry,
      reveal: false,
      symbol: null,
      editTarget: null,
      inspector: structureSelection === null ? "explanation" : "edit",
      structureSelection,
    });
  }
  if (resetEditor && elements.shell.dataset.commandView === "command") {
    elements.showSemanticView("flow");
  }
}
function nextSessionRevision(): number {
  const current = session?.analysis.editTargets.revision ?? -1;
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error("源码版本号已达到安全整数上限");
  return current + 1;
}
function onCodeSourceChange(source: string, reason: CodeSourceChangeReason): void {
  if (destroyed) return;
  workspaceLesson.handleSourceChanged(source);
  elements.parserStatus.dataset.analysisState = "pending";
  elements.parserStatus.dataset.analyzedFunctions = "0";
  flowWorkbench?.setAnalysis(null);
  runtimeWorkspace?.invalidateSource();
  aiWorkspace?.invalidateSource();
  if (session?.imported.source !== source) clearStaleSourcePresentation(codePane, explanationHost);
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  sourceSync.handleSourceChange(source, reason);
  workspaceController.handleSourceChange(source);
}
function sessionRoundTripIsLossless(): boolean {
  return (
    session !== null && core.renderSourceDoc(session.analysis.document) === codePane.getSource()
  );
}
function analyzeCurrentSource(source: string): core.CAnalysisSnapshot {
  if (parser === null) throw new Error("C 解析器尚未加载");
  return parser.analyze(source, nextSessionRevision());
}
function destroyApplication(): void {
  if (destroyed) return;
  destroyed = true;
  sourceSync.destroy();
  canvasStructureActions?.destroy();
  structureEdits?.destroy();
  projectionPresenter?.destroy();
  sourceImport.destroy();
  learningSurface?.destroy();
  learningCatalogStorage?.destroy();
  guidedLesson?.destroy();
  aiWorkspace?.destroy();
  void cCommand?.destroy().catch(() => undefined);
  mainStatus.destroy();
  void runtimeWorkspace?.destroy().catch(() => undefined);
  flowWorkbench?.destroy();
  workspaceController.destroy();
  structureEditPanel?.destroy();
  editPanel?.destroy();
  projectionStatus.destroy();
  blockTree.destroy();
  codePane.destroy();
  programAnalysisCoordinator.destroy();
  parser?.dispose();
  runtime.destroy();
}
installApplicationPersistence({
  workspace: workspaceController,
  flow: requireFlowWorkbench(),
  runtime: requireRuntimeWorkspace(),
  guidedLesson: guidedLesson ?? undefined,
  getCatalog: () => learningCatalogStorage,
  onCloseRequested: window.panelApi.onWorkspaceCloseRequested,
  destroy: destroyApplication,
});
