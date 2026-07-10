import * as core from "./core/index.js";
import * as editTargetSelection from "./app/edit-target-selection.js";
import { INITIAL_SOURCE } from "./app/initial-source.js";
import { createLearningSurface, type LearningSurface } from "./app/learning-surface.js";
import { createProjectionPresenter, type ProjectionPresenter } from "./app/projection-presenter.js";
import { sourceMetadata } from "./app/source-display.js";
import { createSourceImportController } from "./app/source-import-controller.js";
import {
  createStructureEditController,
  type StructureEditController,
  type StructureEditSession,
} from "./app/structure-edit-controller.js";
import { createSourceSyncController } from "./app/source-sync-controller.js";
import {
  canSelectAnalyzedSource,
  structureEditSelectionAtOffset,
  structureEditSelectionForBlock,
} from "./app/structure-edit-selection.js";
import { createWorkbenchRuntime } from "./app/workbench-runtime.js";
import { createBrowserCParser } from "./renderer/c-parser.js";
import { validateSourceText } from "./shared/source-import.js";
import type { ImportedSource } from "./shared/api.js";
import { createBlockTree } from "./ui/block-tree.js";
import { createCodePane, type CodeHighlight, type CodeSourceChangeReason } from "./ui/code-pane.js";
import { createEditPanel, type EditPanel, type EditPanelRequest } from "./ui/edit-panel.js";
import { renderExplanationView } from "./ui/explanation-view.js";
import { createProjectionStatus } from "./ui/projection-status.js";
import { createRunPanel } from "./ui/run-panel.js";
import {
  createStructureEditPanel,
  type StructureEditPanel,
  type StructureEditSelection,
} from "./ui/structure-edit-panel.js";

type ReadySession = StructureEditSession & { readonly blockIndex: core.BlockIndex };

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("缺少应用挂载节点 #app");

const runtime = createWorkbenchRuntime(app);
const { elements, startupLoader } = runtime;
const explanationHost = elements.getInspectorHost("explanation");
let parser: core.CParser | null = null;
let session: ReadySession | null = null;
let destroyed = false;
let editPanel: EditPanel<core.StructuredEditPlan> | null = null;
let structureEditPanel: StructureEditPanel | null = null;
let structureEdits: StructureEditController | null = null;
let projectionPresenter: ProjectionPresenter | null = null;
let learningSurface: LearningSurface | null = null;

const projectionStatus = createProjectionStatus(elements.codePane);
const codePane = createCodePane(elements.codePane, {
  editable: true,
  validateSource: assertEditableSource,
  onInputRejected: onDirectInputRejected,
  onSourceOffset: selectFromCode,
  onSourceChange: onCodeSourceChange,
});
const blockTree = createBlockTree(
  elements.blockTree,
  (entry) => {
    const target =
      session === null
        ? null
        : editTargetSelection.editTargetForBlock(session.analysis.editTargets, entry);
    const structureSelection =
      session === null ? null : structureEditSelectionForBlock(session.analysis, entry);
    selectBlock(
      entry,
      true,
      null,
      target,
      target === null && structureSelection === null ? "explanation" : "edit",
      structureSelection,
    );
  },
  (sourceEntry, targetEntry) => {
    elements.showInspector("edit");
    void requireStructureEdits().move(sourceEntry, targetEntry);
  },
  (intent) => {
    void learningSurface?.insert(intent);
  },
);
editPanel = createEditPanel<core.StructuredEditPlan>(elements.getInspectorHost("edit"), {
  plan: planPanelEdit,
  commit: commitPanelEdit,
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
const runPanel = createCurrentRunPanel();
const sourceImport = createSourceImportController(elements, { load: loadSource });
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
  validateSource: assertEditableSource,
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
  validateSource: assertEditableSource,
  applyPatches: (patches) => codePane.applyPatches(patches),
  confirm: (plan) => requireEditPanel().confirmExternal(plan),
  adopt: (imported, analysis) => adoptAnalysis(imported, analysis, false, null),
  onSuccess: () => {
    editPanel?.setStatus({ kind: "success", message: "结构修改已提交；可随时撤销。" });
    sourceImport.setStatus("结构修改已提交；可使用撤销恢复上一版本。", "ready");
    elements.showPage("build");
  },
  onError: (error) => {
    editPanel?.setStatus(error);
    sourceImport.setStatus(error.message, "error");
  },
});
learningSurface = createLearningSurface({
  elements,
  blockTree,
  structureEdits: requireStructureEdits(),
  getAnalysis: () => session?.analysis ?? null,
  getAnalyzer: () => parser,
  onError: (error) => {
    editPanel?.setStatus(error);
    sourceImport.setStatus(error.message, "error");
  },
});

void initialize();

async function initialize(): Promise<void> {
  try {
    startupLoader.advance("parser");
    const loadedParser = await createBrowserCParser();
    if (destroyed) {
      loadedParser.dispose();
      return;
    }
    parser = loadedParser;
    startupLoader.advance("parser-ready");
    sourceImport.setEnabled(true);
    startupLoader.advance("source");
    loadSource({ source: INITIAL_SOURCE, displayName: "algorithm-demo.c", origin: "paste" });
    sourceImport.setStatus("示例已载入；可打开、拖入或粘贴自己的 .c 文件。", "ready");
    startupLoader.complete();
  } catch (error: unknown) {
    startupLoader.fail(`启动失败：${errorMessage(error)}`);
    elements.parserStatus.textContent = `C 解析器不可用：${errorMessage(error)}`;
    elements.parserStatus.dataset.state = "error";
    sourceImport.setStatus("解析器初始化失败，源码工作台已停用。", "error");
  }
}

function loadSource(imported: ImportedSource): void {
  if (parser === null) throw new Error("C 解析器尚未加载");
  const analysis = parser.analyze(imported.source, nextSessionRevision());
  const projectionMode = analysis.document.parse.hasError ? "recovery" : "synced";
  sourceSync.reset(projectionMode);
  blockTree.setInteractionEnabled(true);
  adoptAnalysis(imported, analysis, true, null);
  projectionStatus.setState(projectionMode);
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
  session = Object.freeze({ imported, analysis, blockIndex });

  if (resetEditor) codePane.setSource(imported.source);
  blockTree.setDocument(document, blockIndex);
  elements.fileName.textContent = imported.displayName;
  elements.sourceMeta.textContent = sourceMetadata(imported.source);
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());

  const functionCount = blockIndex.entries.filter(
    (entry) => entry.block?.kind === "syntax" && entry.block.role === "function",
  ).length;
  elements.parserStatus.textContent = document.parse.hasError
    ? `C 解析器就绪 · ${document.issues.length} 个恢复提示`
    : "C 解析器已加载 · 语句级无损投影可用";
  elements.parserStatus.dataset.state = document.parse.hasError ? "warning" : "ready";
  elements.parserStatus.dataset.rootType = "translation_unit";
  elements.parserStatus.dataset.functionCount = String(functionCount);
  elements.parserStatus.dataset.roundtrip = "true";

  if (preferredTarget !== null) {
    const preferredEntry = editTargetSelection.blockEntryForTarget(blockIndex, preferredTarget);
    selectBlock(
      preferredEntry,
      false,
      null,
      preferredTarget,
      "edit",
      structureEditSelectionForBlock(analysis, preferredEntry),
    );
  } else {
    const firstFunction = blockIndex.entries.find(
      (entry) => entry.block?.kind === "syntax" && entry.block.role === "function",
    );
    const firstBlock = blockIndex.entries.find((entry) => entry.kind === "block");
    const initialEntry = firstFunction ?? firstBlock ?? blockIndex.entries[0] ?? null;
    const structureSelection = structureEditSelectionForBlock(analysis, initialEntry);
    selectBlock(
      initialEntry,
      false,
      null,
      null,
      structureSelection === null ? "explanation" : "edit",
      structureSelection,
    );
  }
}

function nextSessionRevision(): number {
  const current = session?.analysis.editTargets.revision ?? -1;
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("源码版本号已达到安全整数上限");
  }
  return current + 1;
}

function planPanelEdit(request: EditPanelRequest): core.StructuredEditPlan {
  const current = session;
  const currentParser = parser;
  if (current === null || currentParser === null) {
    throw new Error("C 解析器或源码会话尚未就绪");
  }
  requireStructureEdits().assertReady();
  const target = editTargetSelection
    .allEditTargets(current.analysis.editTargets)
    .find((candidate) => candidate.id === request.targetId);
  if (target === undefined) {
    throw new Error("编辑目标已经过期，请重新选择代码");
  }
  const structuredRequest = editTargetSelection.toStructuredEditRequest(request, target);
  return core.planStructuredEdit(
    {
      source: current.imported.source,
      analysis: current.analysis,
      analyzer: currentParser,
      validateSource: assertEditableSource,
    },
    structuredRequest,
  );
}

function commitPanelEdit(plan: core.StructuredEditPlan): void {
  const current = session;
  if (
    current === null ||
    sourceSync.getMode() !== "synced" ||
    current.analysis.editTargets.revision !== plan.baseRevision ||
    codePane.getSource() !== current.imported.source
  ) {
    throw new Error("预览已经过期；源码未修改，请重新选择并预览");
  }
  if (
    plan.candidateAnalysis.editTargets.revision !== plan.candidateRevision ||
    plan.candidateSource !== plan.candidateAnalysis.document.source ||
    core.renderSourceDoc(plan.candidateAnalysis.document) !== plan.candidateSource
  ) {
    throw new Error("候选分析快照无效；源码未修改");
  }

  // Build every derived structure before touching CodeMirror. This keeps a
  // rejected or internally inconsistent plan completely atomic.
  core.createBlockIndex(plan.candidateAnalysis.document);
  const preferredTarget = editTargetSelection.candidateTargetForPlan(
    current.analysis.editTargets,
    plan,
  );
  const changed = codePane.applyPatches(plan.patches);
  if (!changed || codePane.getSource() !== plan.candidateSource) {
    throw new Error("CodeMirror 未能精确应用结构化补丁");
  }

  const imported = Object.freeze({ ...current.imported, source: plan.candidateSource });
  sourceSync.reset("synced");
  adoptAnalysis(imported, plan.candidateAnalysis, false, preferredTarget);
  editPanel?.setStatus({ kind: "success", message: "修改已提交；可随时撤销。" });
  sourceImport.setStatus("修改已提交；可使用撤销恢复上一版本。", "ready");
}

function onCodeSourceChange(source: string, reason: CodeSourceChangeReason): void {
  if (destroyed) return;
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  sourceSync.handleSourceChange(source, reason);
}

function analyzeCurrentSource(source: string): core.CAnalysisSnapshot {
  if (parser === null) throw new Error("C 解析器尚未加载");
  return parser.analyze(source, nextSessionRevision());
}

function onDirectInputRejected(error: unknown): void {
  requireProjectionPresenter().inputRejected(error);
}

function requireEditPanel(): EditPanel<core.StructuredEditPlan> {
  if (editPanel === null) throw new Error("编辑检查器不可用");
  return editPanel;
}

function requireStructureEditPanel(): StructureEditPanel {
  if (structureEditPanel === null) throw new Error("结构编辑面板不可用");
  return structureEditPanel;
}

function requireStructureEdits(): StructureEditController {
  if (structureEdits === null) throw new Error("结构编辑控制器不可用");
  return structureEdits;
}

function requireProjectionPresenter(): ProjectionPresenter {
  if (projectionPresenter === null) throw new Error("投影状态 presenter 不可用");
  return projectionPresenter;
}

function assertEditableSource(source: string): void {
  const validation = validateSourceText(source);
  if (!validation.ok) {
    throw new Error(`${validation.code}：${validation.message}`);
  }
}

function selectFromCode(sourceOffset: number): void {
  if (
    session === null ||
    !canSelectAnalyzedSource(sourceSync.getMode(), codePane.getSource(), session.imported.source)
  ) {
    return;
  }
  const symbol = core.symbolAt(session.analysis.document.symbols, sourceOffset);
  const entry = core.offsetToBlock(session.blockIndex, sourceOffset);
  const target = editTargetSelection.editTargetAtOffset(session.analysis.editTargets, sourceOffset);
  const structureSelection = structureEditSelectionAtOffset(session.analysis, sourceOffset);
  selectBlock(
    entry,
    false,
    symbol,
    target,
    target === null && structureSelection === null ? "explanation" : "edit",
    structureSelection,
  );
}

function selectBlock(
  entry: core.BlockIndexEntry | null,
  reveal: boolean,
  symbol: core.SymbolRecord | null,
  editTarget: core.EditTarget | null,
  inspector: "explanation" | "edit",
  structureSelection: StructureEditSelection | null,
): void {
  if (session === null) return;
  const sourceDocument = session.analysis.document;
  if (reveal || elements.currentPage !== "build") elements.showInspector(inspector);
  blockTree.select(entry);
  editPanel?.setTarget(editTarget);
  structureEditPanel?.setSelection(
    sourceSync.getMode() === "synced" && !sourceDocument.parse.hasError ? structureSelection : null,
  );
  learningSurface?.setSelectedInsertEnabled(
    structureSelection?.statement?.parentMode === "statement-list" &&
      structureSelection.statement.blocker === null,
  );
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  if (sourceDocument.parse.hasError) {
    editPanel?.setStatus({
      kind: "parse-error",
      message: "当前源码含解析恢复节点；先修复源码，再进行结构化编辑。",
    });
  }

  const highlights: CodeHighlight[] = [];
  if (entry?.block !== null && entry?.block !== undefined) {
    highlights.push({ range: entry.block.range, kind: "primary" });
  }
  if (symbol !== null) {
    for (const occurrence of sourceDocument.symbols.occurrences) {
      if (occurrence.symbolId !== symbol.id) continue;
      highlights.push({
        range: occurrence.range,
        kind: occurrence.role === "declaration" ? "symbol-declaration" : "symbol-use",
        title: symbolTooltip(symbol, occurrence.role),
      });
    }
  }
  codePane.setHighlights(highlights);
  if (reveal && entry?.block !== null && entry?.block !== undefined) {
    codePane.reveal(entry.block.range);
  }
  renderExplanationView(explanationHost, sourceDocument, entry?.block ?? null, symbol);
}

function createCurrentRunPanel() {
  return createRunPanel(elements.getInspectorHost("run"), {
    getSource: () => codePane.getSource(),
    getDisplayName: () => session?.imported.displayName ?? "main.c",
  });
}

function symbolTooltip(symbol: core.SymbolRecord, role: "declaration" | "use"): string {
  const roleText = role === "declaration" ? "声明" : "使用";
  return symbol.valueText === undefined
    ? `${symbol.name} · ${roleText}`
    : `${symbol.name} = ${symbol.valueText} · ${roleText}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

window.addEventListener(
  "beforeunload",
  () => {
    destroyed = true;
    sourceSync.destroy();
    structureEdits?.destroy();
    structureEdits = null;
    projectionPresenter?.destroy();
    projectionPresenter = null;
    sourceImport.destroy();
    learningSurface?.destroy();
    learningSurface = null;
    runPanel.destroy();
    structureEditPanel?.destroy();
    structureEditPanel = null;
    editPanel?.destroy();
    editPanel = null;
    projectionStatus.destroy();
    blockTree.destroy();
    codePane.destroy();
    parser?.dispose();
    parser = null;
    runtime.destroy();
  },
  { once: true },
);
