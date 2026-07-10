import {
  createBlockIndex,
  offsetToBlock,
  renderSourceDoc,
  symbolAt,
  type Block,
  type BlockIndex,
  type BlockIndexEntry,
  type CParser,
  type SourceDoc,
  type SymbolRecord,
} from "./core/index.js";
import { createBrowserCParser } from "./renderer/c-parser.js";
import { importPastedSource } from "./shared/source-import.js";
import type { ImportedSource, SourceImportResult } from "./shared/api.js";
import { createBlockTree } from "./ui/block-tree.js";
import { createCodePane, type CodeHighlight } from "./ui/code-pane.js";
import { explainBlock } from "./ui/explanation.js";
import { createRunPanel } from "./ui/run-panel.js";
import { mountWorkbench } from "./ui/workbench-shell.js";

const INITIAL_SOURCE = [
  "#include <stdio.h>",
  "",
  "int main(void) {",
  "  int total = 0;",
  "  for (int i = 0; i < 3; i++) {",
  "    total += i;",
  "  }",
  '  printf("%d\\n", total);',
  "  return 0;",
  "}",
  "",
].join("\n");

interface ReadySession {
  readonly imported: ImportedSource;
  readonly document: SourceDoc;
  readonly blockIndex: BlockIndex;
}

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("缺少应用挂载节点 #app");

const elements = mountWorkbench(app);
let parser: CParser | null = null;
let session: ReadySession | null = null;
let selectedEntry: BlockIndexEntry | null = null;
let selectedSymbol: SymbolRecord | null = null;
let importRequestId = 0;
let dragDepth = 0;
let destroyed = false;

const codePane = createCodePane(elements.codePane, {
  onSourceOffset: selectFromCode,
});
const blockTree = createBlockTree(elements.blockTree, (entry) => {
  selectBlock(entry, true, null);
});
let runPanel = createCurrentRunPanel();

elements.openButton.addEventListener("click", openNativeSource);
elements.pasteButton.addEventListener("click", showPasteDialog);
elements.pasteConfirm.addEventListener("click", confirmPaste);
elements.pasteDialog.addEventListener("close", clearPasteError);
elements.shell.addEventListener("dragenter", onDragEnter);
elements.shell.addEventListener("dragover", onDragOver);
elements.shell.addEventListener("dragleave", onDragLeave);
elements.shell.addEventListener("drop", onDrop);

void initialize();

async function initialize(): Promise<void> {
  try {
    const loadedParser = await createBrowserCParser();
    if (destroyed) {
      loadedParser.dispose();
      return;
    }
    parser = loadedParser;
    elements.openButton.disabled = false;
    elements.pasteButton.disabled = false;
    loadSource({ source: INITIAL_SOURCE, displayName: "algorithm-demo.c", origin: "paste" });
    setImportStatus("示例已载入；可打开、拖入或粘贴自己的 .c 文件。", "ready");
  } catch (error: unknown) {
    elements.parserStatus.textContent = `C 解析器不可用：${errorMessage(error)}`;
    elements.parserStatus.dataset.state = "error";
    setImportStatus("解析器初始化失败，源码工作台已停用。", "error");
  }
}

function loadSource(imported: ImportedSource): void {
  if (parser === null) throw new Error("C 解析器尚未加载");
  const document = parser.project(imported.source);
  if (renderSourceDoc(document) !== imported.source) {
    throw new Error("无损投影未能逐字符重建输入源码");
  }
  const blockIndex = createBlockIndex(document);
  session = Object.freeze({ imported, document, blockIndex });
  selectedEntry = null;
  selectedSymbol = null;
  runPanel.destroy();
  runPanel = createCurrentRunPanel();

  codePane.setSource(imported.source);
  blockTree.setDocument(document, blockIndex);
  elements.fileName.textContent = imported.displayName;
  elements.sourceMeta.textContent = sourceMetadata(imported.source);

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

  const firstFunction = blockIndex.entries.find(
    (entry) => entry.block?.kind === "syntax" && entry.block.role === "function",
  );
  const firstBlock = blockIndex.entries.find((entry) => entry.kind === "block");
  selectBlock(firstFunction ?? firstBlock ?? blockIndex.entries[0] ?? null, false, null);
}

function selectFromCode(sourceOffset: number): void {
  if (session === null) return;
  const symbol = symbolAt(session.document.symbols, sourceOffset);
  const entry = offsetToBlock(session.blockIndex, sourceOffset);
  selectBlock(entry, false, symbol);
}

function selectBlock(
  entry: BlockIndexEntry | null,
  reveal: boolean,
  symbol: SymbolRecord | null,
): void {
  if (session === null) return;
  elements.showInspector("explanation");
  selectedEntry = entry;
  selectedSymbol = symbol;
  blockTree.select(entry);

  const highlights: CodeHighlight[] = [];
  if (entry?.block !== null && entry?.block !== undefined) {
    highlights.push({ range: entry.block.range, kind: "primary" });
  }
  if (symbol !== null) {
    for (const occurrence of session.document.symbols.occurrences) {
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
  renderExplanation(entry?.block ?? null, symbol);
}

function renderExplanation(block: Block | null, focusedSymbol: SymbolRecord | null): void {
  const current = session;
  elements.explanation.replaceChildren();
  if (current === null || block === null) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "这里是源码空白或注释区。选择一条语句积木查看作用。";
    elements.explanation.append(empty);
    return;
  }

  const explanation = explainBlock(current.document, block);
  const title = document.createElement("h3");
  title.className = "explanation__title";
  title.textContent =
    focusedSymbol === null ? explanation.title : `${explanation.title} · ${focusedSymbol.name}`;
  const summary = document.createElement("p");
  summary.className = "explanation__summary";
  summary.textContent = explanation.summary;
  elements.explanation.append(title, summary);

  if (explanation.details.length > 0) {
    const details = document.createElement("ul");
    details.className = "explanation__details";
    for (const detail of explanation.details) {
      const item = document.createElement("li");
      item.textContent = detail;
      details.append(item);
    }
    elements.explanation.append(details);
  }

  const symbols = [...explanation.symbols].sort((left, right) => {
    const leftFocused = focusedSymbol?.name === left.name && focusedSymbol.kind === left.kind;
    const rightFocused = focusedSymbol?.name === right.name && focusedSymbol.kind === right.kind;
    return Number(rightFocused) - Number(leftFocused);
  });
  if (symbols.length > 0) {
    const list = document.createElement("ul");
    list.className = "explanation__symbols";
    for (const symbol of symbols) {
      const item = document.createElement("li");
      item.className = "symbol-card";
      if (focusedSymbol?.name === symbol.name && focusedSymbol.kind === symbol.kind) {
        item.dataset.focused = "true";
      }
      const name = document.createElement("code");
      name.textContent =
        symbol.valueText === undefined ? symbol.name : `${symbol.name} = ${symbol.valueText}`;
      const meta = document.createElement("span");
      meta.className = "symbol-card__meta";
      meta.textContent = [
        symbolKindLabel(symbol.kind),
        symbol.header,
        `${symbol.usageCount} 处使用`,
      ]
        .filter((value): value is string => value !== undefined)
        .join(" · ");
      item.append(name, meta);
      if (symbol.signatureText !== undefined) appendText(item, symbol.signatureText);
      if (symbol.description !== undefined) appendText(item, symbol.description);
      list.append(item);
    }
    elements.explanation.append(list);
  }

  if (explanation.concerns.length > 0) {
    const concerns = document.createElement("ul");
    concerns.className = "explanation__concerns";
    for (const message of explanation.concerns) {
      const item = document.createElement("li");
      item.className = "concern-card";
      item.textContent = `低置信度：${message}`;
      concerns.append(item);
    }
    elements.explanation.append(concerns);
  }
}

async function openNativeSource(): Promise<void> {
  const requestId = ++importRequestId;
  setImportStatus("正在等待系统文件选择器…", "loading");
  try {
    const result = await window.panelApi.openSource();
    if (requestId === importRequestId) applyImportResult(result);
  } catch {
    if (requestId === importRequestId) setImportStatus("文件选择器 IPC 调用失败。", "error");
  }
}

function showPasteDialog(): void {
  clearPasteError();
  elements.pasteSource.value = "";
  elements.pasteDialog.showModal();
  elements.pasteSource.focus();
}

function confirmPaste(): void {
  const result = importPastedSource(elements.pasteSource.value);
  if (result.status === "failed") {
    elements.pasteError.textContent = result.error.message;
    return;
  }
  if (result.status === "opened") {
    importRequestId += 1;
    applyImportResult(result);
    elements.pasteDialog.close("loaded");
  }
}

function createCurrentRunPanel() {
  return createRunPanel(elements.runPanel, {
    getSource: () => session?.imported.source ?? "",
    getDisplayName: () => session?.imported.displayName ?? "main.c",
  });
}

function clearPasteError(): void {
  elements.pasteError.textContent = "";
}

function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  elements.dropOverlay.hidden = false;
}

function onDragOver(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
}

function onDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) elements.dropOverlay.hidden = true;
}

function onDrop(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  elements.dropOverlay.hidden = true;
  const files = event.dataTransfer?.files;
  if (files === undefined || files.length !== 1 || files[0] === undefined) {
    setImportStatus("请一次只拖入一个 .c 文件。", "error");
    return;
  }
  const requestId = ++importRequestId;
  setImportStatus("正在读取拖入的 C 文件…", "loading");
  void window.panelApi
    .openDroppedSource(files[0])
    .then((result) => {
      if (requestId === importRequestId) applyImportResult(result);
    })
    .catch(() => {
      if (requestId === importRequestId) setImportStatus("拖拽导入 IPC 调用失败。", "error");
    });
}

function applyImportResult(result: SourceImportResult): void {
  if (result.status === "cancelled") {
    setImportStatus("已取消文件选择，当前文档保持不变。", "ready");
    return;
  }
  if (result.status === "failed") {
    setImportStatus(`${result.error.code}：${result.error.message}`, "error");
    return;
  }
  try {
    loadSource(result.document);
    setImportStatus(`已载入 ${result.document.displayName}。`, "ready");
  } catch (error: unknown) {
    setImportStatus(`源码解析失败：${errorMessage(error)}；当前文档保持不变。`, "error");
  }
}

function setImportStatus(message: string, state: "loading" | "ready" | "error"): void {
  elements.importStatus.textContent = message;
  elements.importStatus.dataset.state = state;
}

function sourceMetadata(source: string): string {
  const bytes = new TextEncoder().encode(source).byteLength;
  return `${newlineLabel(source)} · ${bytes.toLocaleString("zh-CN")} B · UTF-8`;
}

function newlineLabel(source: string): string {
  const withoutCrlf = source.replaceAll("\r\n", "");
  const hasCrlf = source.includes("\r\n");
  const hasLf = withoutCrlf.includes("\n");
  const hasCr = withoutCrlf.includes("\r");
  if (Number(hasCrlf) + Number(hasLf) + Number(hasCr) > 1) return "混合换行";
  if (hasCrlf) return "CRLF";
  if (hasCr) return "CR";
  if (hasLf) return "LF";
  return "单行";
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

function symbolTooltip(symbol: SymbolRecord, role: "declaration" | "use"): string {
  const roleText = role === "declaration" ? "声明" : "使用";
  return symbol.valueText === undefined
    ? `${symbol.name} · ${roleText}`
    : `${symbol.name} = ${symbol.valueText} · ${roleText}`;
}

function symbolKindLabel(kind: SymbolRecord["kind"]): string {
  const labels: Readonly<Record<SymbolRecord["kind"], string>> = {
    parameter: "参数",
    "local-variable": "局部变量",
    "file-variable": "文件变量",
    "enum-constant": "枚举常量",
    function: "函数",
    typedef: "typedef",
    "object-macro": "对象宏",
    "builtin-function": "标准库函数",
    "builtin-typedef": "标准 typedef",
    "builtin-object-macro": "标准对象宏",
    "unknown-external": "未知外部符号",
  };
  return labels[kind];
}

function appendText(parent: HTMLElement, text: string): void {
  const paragraph = document.createElement("span");
  paragraph.textContent = text;
  parent.append(paragraph);
}

function flattenBlocks(blocks: readonly Block[]): readonly Block[] {
  const flattened: Block[] = [];
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
    importRequestId += 1;
    parser?.dispose();
    parser = null;
    blockTree.destroy();
    codePane.destroy();
    runPanel.destroy();
  },
  { once: true },
);
