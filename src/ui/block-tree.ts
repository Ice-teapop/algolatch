import type { Block, BlockIndex, BlockIndexEntry, ParseConcern, SourceDoc } from "../core/index.js";

export interface BlockTree {
  setDocument(document: SourceDoc, index: BlockIndex): void;
  select(entry: BlockIndexEntry | null): void;
  destroy(): void;
}

export function createBlockTree(
  host: HTMLElement,
  onSelect: (entry: BlockIndexEntry) => void,
): BlockTree {
  let currentIndex: BlockIndex | null = null;
  let selectedButton: HTMLButtonElement | null = null;
  let buttons: HTMLButtonElement[] = [];
  const onClick = (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "[data-block-index]",
    );
    if (button === null || button === undefined || currentIndex === null) return;
    const entry = currentIndex.entries[Number(button.dataset.blockIndex)];
    if (entry?.kind === "block") onSelect(entry);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const current = event.target as HTMLButtonElement;
    const position = buttons.indexOf(current);
    if (position < 0) return;
    let next = position;
    if (event.key === "ArrowDown") next = Math.min(buttons.length - 1, position + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, position - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };
  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKeyDown);

  return Object.freeze({
    setDocument(sourceDoc: SourceDoc, index: BlockIndex) {
      currentIndex = index;
      selectedButton = null;
      host.replaceChildren();
      const byBlock = new Map<Block, BlockIndexEntry>();
      for (const entry of index.entries) {
        if (entry.block !== null) byBlock.set(entry.block, entry);
      }
      const tree = window.document.createElement("ul");
      tree.className = "block-tree-list";
      tree.setAttribute("role", "tree");
      tree.setAttribute("aria-label", "C 语句积木树");
      for (const block of sourceDoc.blocks) {
        tree.append(renderBlock(sourceDoc, block, byBlock, 1));
      }
      if (sourceDoc.blocks.length === 0) {
        const empty = window.document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "这份文件目前没有可显示的语句积木。";
        host.append(empty);
      } else {
        host.append(tree);
      }
      buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-block-index]"));
      for (const [position, button] of buttons.entries()) {
        button.tabIndex = position === 0 ? 0 : -1;
      }
    },
    select(entry: BlockIndexEntry | null) {
      if (selectedButton !== null) {
        selectedButton.setAttribute("aria-selected", "false");
        selectedButton.classList.remove("is-selected");
      }
      selectedButton =
        entry?.kind === "block"
          ? host.querySelector<HTMLButtonElement>(`[data-block-index="${entry.index}"]`)
          : null;
      if (selectedButton !== null) {
        for (const button of buttons) button.tabIndex = button === selectedButton ? 0 : -1;
        selectedButton.setAttribute("aria-selected", "true");
        selectedButton.classList.add("is-selected");
        selectedButton.scrollIntoView({ block: "nearest" });
      }
    },
    destroy() {
      host.removeEventListener("click", onClick);
      host.removeEventListener("keydown", onKeyDown);
      host.replaceChildren();
      buttons = [];
      currentIndex = null;
      selectedButton = null;
    },
  });
}

function renderBlock(
  document: SourceDoc,
  block: Block,
  byBlock: ReadonlyMap<Block, BlockIndexEntry>,
  level: number,
): HTMLLIElement {
  const item = window.document.createElement("li");
  item.setAttribute("role", "none");
  const button = window.document.createElement("button");
  button.type = "button";
  button.className = `block-card block-card--${block.kind}`;
  button.setAttribute("role", "treeitem");
  button.setAttribute("aria-level", String(level));
  button.setAttribute("aria-selected", "false");
  const entry = byBlock.get(block);
  if (entry !== undefined) button.dataset.blockIndex = String(entry.index);
  button.dataset.nodeType = block.kind === "syntax" ? block.nodeType : "raw";

  const accent = window.document.createElement("span");
  accent.className = "block-card__accent";
  accent.setAttribute("aria-hidden", "true");
  const copy = window.document.createElement("span");
  copy.className = "block-card__copy";
  const title = window.document.createElement("span");
  title.className = "block-card__title";
  title.textContent = blockTitle(block);
  const excerpt = window.document.createElement("code");
  excerpt.className = "block-card__excerpt";
  excerpt.textContent = compactExcerpt(document.source.slice(block.range.from, block.range.to));
  copy.append(title, excerpt);
  button.append(accent, copy);

  const concerns = concernsForBlock(document.concerns, block);
  if (concerns.length > 0) {
    const badge = window.document.createElement("span");
    badge.className = "block-card__badge";
    badge.textContent = "可疑解析";
    badge.title = concerns.map((concern) => concern.message).join("\n");
    button.append(badge);
  }
  item.append(button);

  if (block.children.length > 0) {
    const group = window.document.createElement("ul");
    group.className = "block-tree-children";
    group.setAttribute("role", "group");
    for (const child of block.children) {
      group.append(renderBlock(document, child, byBlock, level + 1));
    }
    item.append(group);
  }
  return item;
}

function concernsForBlock(
  concerns: readonly ParseConcern[],
  block: Block,
): readonly ParseConcern[] {
  return concerns.filter(
    (concern) =>
      concern.blockRange.from >= block.range.from && concern.blockRange.to <= block.range.to,
  );
}

function compactExcerpt(source: string): string {
  const compact = source.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= 76 ? compact : `${compact.slice(0, 73)}…`;
}

function blockTitle(block: Block): string {
  if (block.kind === "raw") {
    if (block.reason === "parse-error") return "原始 C · 解析恢复";
    if (block.reason === "unsupported-syntax") return "原始 C · 暂不结构化";
    return "原始 C";
  }
  return NODE_TITLES[block.nodeType] ?? `${roleTitle(block.role)} · ${block.nodeType}`;
}

function roleTitle(role: "function" | "statement" | "declaration" | "preprocessor"): string {
  if (role === "function") return "函数";
  if (role === "declaration") return "声明";
  if (role === "preprocessor") return "预处理";
  return "语句";
}

const NODE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  function_definition: "函数",
  declaration: "变量声明",
  type_definition: "类型定义",
  preproc_include: "包含头文件",
  preproc_def: "对象宏",
  preproc_ifdef: "条件编译",
  if_statement: "条件判断",
  for_statement: "for 循环",
  while_statement: "while 循环",
  do_statement: "do-while 循环",
  switch_statement: "switch 分支",
  case_statement: "case 分支",
  labeled_statement: "标签",
  expression_statement: "表达式",
  return_statement: "返回",
  break_statement: "跳出",
  continue_statement: "继续下一轮",
  goto_statement: "跳转",
});
