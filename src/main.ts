import * as core from "./core/index.js";
import * as editTargetSelection from "./app/edit-target-selection.js";
import { sourceMetadata } from "./app/source-display.js";
import { createSourceImportController } from "./app/source-import-controller.js";
import { createWorkbenchRuntime } from "./app/workbench-runtime.js";
import { createBrowserCParser } from "./renderer/c-parser.js";
import { validateSourceText } from "./shared/source-import.js";
import type { ImportedSource } from "./shared/api.js";
import { createBlockTree } from "./ui/block-tree.js";
import { createCodePane, type CodeHighlight, type CodeSourceChangeReason } from "./ui/code-pane.js";
import { createEditPanel, type EditPanel, type EditPanelRequest } from "./ui/edit-panel.js";
import { renderExplanationView } from "./ui/explanation-view.js";
import { createRunPanel } from "./ui/run-panel.js";

const INITIAL_SOURCE = `#include <stdio.h>

int main(void) {
  int total = 0;
  for (int i = 0; i < 3; i++) {
    total += i;
  }
  printf("%d\\n", total);
  return 0;
}
`;

interface ReadySession {
  readonly imported: ImportedSource;
  readonly analysis: core.CAnalysisSnapshot;
  readonly blockIndex: core.BlockIndex;
}

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("缺少应用挂载节点 #app");

const runtime = createWorkbenchRuntime(app);
const { elements } = runtime;
const explanationHost = elements.getInspectorHost("explanation");
let parser: core.CParser | null = null;
let session: ReadySession | null = null;
let destroyed = false;
let editPanel: EditPanel<core.StructuredEditPlan> | null = null;

const codePane = createCodePane(elements.codePane, {
  onSourceOffset: selectFromCode,
  onSourceChange: onCodeSourceChange,
});
const blockTree = createBlockTree(elements.blockTree, (entry) => {
  const target =
    session === null
      ? null
      : editTargetSelection.editTargetForBlock(session.analysis.editTargets, entry);
  selectBlock(entry, true, null, target, target === null ? "explanation" : "edit");
});
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
let runPanel = createCurrentRunPanel();
const sourceImport = createSourceImportController(elements, { load: loadSource });

void initialize();

async function initialize(): Promise<void> {
  try {
    const loadedParser = await createBrowserCParser();
    if (destroyed) {
      loadedParser.dispose();
      return;
    }
    parser = loadedParser;
    sourceImport.setEnabled(true);
    loadSource({ source: INITIAL_SOURCE, displayName: "algorithm-demo.c", origin: "paste" });
    sourceImport.setStatus("示例已载入；可打开、拖入或粘贴自己的 .c 文件。", "ready");
  } catch (error: unknown) {
    elements.parserStatus.textContent = `C 解析器不可用：${errorMessage(error)}`;
    elements.parserStatus.dataset.state = "error";
    sourceImport.setStatus("解析器初始化失败，源码工作台已停用。", "error");
  }
}

function loadSource(imported: ImportedSource): void {
  if (parser === null) throw new Error("C 解析器尚未加载");
  const analysis = parser.analyze(imported.source, nextSessionRevision());
  adoptAnalysis(imported, analysis, true, null);
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
  runPanel.destroy();
  runPanel = createCurrentRunPanel();

  if (resetEditor) codePane.setSource(imported.source);
  blockTree.setDocument(document, blockIndex);
  elements.fileName.textContent = imported.displayName;
  elements.sourceMeta.textContent = sourceMetadata(imported.source);
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());

  const functions = flattenBlocks(document.blocks).filter(
    (block) => block.kind === "syntax" && block.role === "function",
  );
  elements.parserStatus.textContent = document.parse.hasError
    ? `C 解析器就绪 · ${document.issues.length} 个恢复提示`
    : "C 解析器已加载 · 语句级无损投影可用";
  elements.parserStatus.dataset.state = document.parse.hasError ? "warning" : "ready";
  elements.parserStatus.dataset.rootType = "translation_unit";
  elements.parserStatus.dataset.functionCount = String(functions.length);
  elements.parserStatus.dataset.roundtrip = "true";

  if (preferredTarget !== null) {
    const preferredEntry = editTargetSelection.blockEntryForTarget(blockIndex, preferredTarget);
    selectBlock(preferredEntry, false, null, preferredTarget, "edit");
  } else {
    const firstFunction = blockIndex.entries.find(
      (entry) => entry.block?.kind === "syntax" && entry.block.role === "function",
    );
    const firstBlock = blockIndex.entries.find((entry) => entry.kind === "block");
    selectBlock(
      firstFunction ?? firstBlock ?? blockIndex.entries[0] ?? null,
      false,
      null,
      null,
      "explanation",
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
  const target = editTargetSelection
    .allEditTargets(current.analysis.editTargets)
    .find((candidate) => candidate.id === request.targetId);
  if (target === undefined) {
    throw new Error("编辑目标已经过期，请重新选择代码");
  }
  const structuredRequest = toStructuredEditRequest(request, target);
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
  adoptAnalysis(imported, plan.candidateAnalysis, false, preferredTarget);
  editPanel?.setStatus({ kind: "success", message: "修改已提交；可随时撤销。" });
  sourceImport.setStatus("修改已提交；可使用撤销恢复上一版本。", "ready");
}

function onCodeSourceChange(source: string, reason: CodeSourceChangeReason): void {
  if (destroyed) return;
  editPanel?.setHistoryDepth(codePane.getHistoryDepth());
  const current = session;
  const currentParser = parser;
  if (current === null || currentParser === null || current.imported.source === source) return;

  try {
    assertEditableSource(source);
    const analysis = currentParser.analyze(source, nextSessionRevision());
    if (analysis.document.parse.hasError) {
      throw new Error("历史记录产生了含解析错误的版本");
    }
    const imported = Object.freeze({ ...current.imported, source });
    adoptAnalysis(imported, analysis, false, null);
    const action = reason === "undo" ? "撤销" : reason === "redo" ? "重做" : "修改";
    editPanel?.setStatus(`${action}完成。`);
    sourceImport.setStatus(`${action}完成；当前源码已重新解析。`, "ready");
  } catch (error: unknown) {
    const message = `无法同步编辑历史：${errorMessage(error)}`;
    editPanel?.setStatus(new Error(message));
    sourceImport.setStatus(message, "error");
  }
}

function toStructuredEditRequest(
  request: EditPanelRequest,
  target: core.EditTarget,
): core.StructuredEditRequest {
  const base = {
    baseRevision: request.baseRevision,
    targetId: request.targetId,
    expectedTargetText: target.text,
  };
  switch (request.kind) {
    case "replace-literal":
      return { ...base, kind: "literal", newText: request.newText };
    case "replace-binary-operator":
      return { ...base, kind: "binary-operator", newOperator: request.newOperator };
    case "replace-for-fields":
      return {
        ...base,
        kind: "for-fields",
        newInitializer: request.initializerText,
        newCondition: request.conditionText,
        newUpdate: request.updateText,
      };
    case "replace-if-condition":
      return { ...base, kind: "if-condition", newCondition: request.conditionText };
  }
}

function assertEditableSource(source: string): void {
  const validation = validateSourceText(source);
  if (!validation.ok) {
    throw new Error(`${validation.code}：${validation.message}`);
  }
}

function selectFromCode(sourceOffset: number): void {
  if (session === null) return;
  const symbol = core.symbolAt(session.analysis.document.symbols, sourceOffset);
  const entry = core.offsetToBlock(session.blockIndex, sourceOffset);
  const target = editTargetSelection.editTargetAtOffset(session.analysis.editTargets, sourceOffset);
  selectBlock(entry, false, symbol, target, target === null ? "explanation" : "edit");
}

function selectBlock(
  entry: core.BlockIndexEntry | null,
  reveal: boolean,
  symbol: core.SymbolRecord | null,
  editTarget: core.EditTarget | null,
  inspector: "explanation" | "edit",
): void {
  if (session === null) return;
  const sourceDocument = session.analysis.document;
  elements.showInspector(inspector);
  blockTree.select(entry);
  editPanel?.setTarget(editTarget);
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
    getSource: () => session?.imported.source ?? "",
    getDisplayName: () => session?.imported.displayName ?? "main.c",
  });
}

function symbolTooltip(symbol: core.SymbolRecord, role: "declaration" | "use"): string {
  const roleText = role === "declaration" ? "声明" : "使用";
  return symbol.valueText === undefined
    ? `${symbol.name} · ${roleText}`
    : `${symbol.name} = ${symbol.valueText} · ${roleText}`;
}

function flattenBlocks(blocks: readonly core.Block[]): readonly core.Block[] {
  const flattened: core.Block[] = [];
  const stack = [...blocks].reverse();
  while (stack.length > 0) {
    const block = stack.pop();
    if (block === undefined) continue;
    flattened.push(block);
    stack.push(...[...block.children].reverse());
  }
  return flattened;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

window.addEventListener(
  "beforeunload",
  () => {
    destroyed = true;
    sourceImport.destroy();
    parser?.dispose();
    parser = null;
    blockTree.destroy();
    codePane.destroy();
    editPanel?.destroy();
    editPanel = null;
    runPanel.destroy();
    runtime.destroy();
  },
  { once: true },
);
