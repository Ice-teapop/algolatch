import type { Block, BlockIndex, BlockIndexEntry, ParseConcern, SourceDoc } from "../core/index.js";

export interface BlockTree {
  setDocument(document: SourceDoc, index: BlockIndex): void;
  setInteractionEnabled(enabled: boolean): void;
  setTemplateDrag(templateId: string | null): void;
  getSelectedEntry(): BlockIndexEntry | null;
  select(entry: BlockIndexEntry | null): void;
  destroy(): void;
}

export type AssemblyInsertPosition = "before" | "after";

export interface AssemblyInsertIntent {
  readonly templateId: string;
  readonly target: BlockIndexEntry;
  readonly position: AssemblyInsertPosition;
}

export function createBlockTree(
  host: HTMLElement,
  onSelect: (entry: BlockIndexEntry) => void,
  onMove?: (source: BlockIndexEntry, target: BlockIndexEntry) => void,
  onInsert?: (intent: AssemblyInsertIntent) => void,
): BlockTree {
  let currentIndex: BlockIndex | null = null;
  let selectedEntry: BlockIndexEntry | null = null;
  let selectedButton: HTMLButtonElement | null = null;
  let buttons: HTMLButtonElement[] = [];
  let draggedEntry: BlockIndexEntry | null = null;
  let draggedButton: HTMLButtonElement | null = null;
  let dropTargetButton: HTMLButtonElement | null = null;
  let draggedTemplateId: string | null = null;
  let templateDropTarget: HTMLElement | null = null;
  let interactionEnabled = true;
  let destroyed = false;
  const onClick = (event: Event) => {
    if (!interactionEnabled) return;
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "button[data-block-index]",
    );
    if (button === null || button === undefined || currentIndex === null) return;
    const entry = currentIndex.entries[Number(button.dataset.blockIndex)];
    if (entry?.kind === "block") onSelect(entry);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!interactionEnabled) return;
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
  const clearDragState = () => {
    draggedButton?.classList.remove("is-dragging");
    dropTargetButton?.classList.remove("is-drop-target");
    draggedEntry = null;
    draggedButton = null;
    dropTargetButton = null;
  };
  const clearTemplateDropTarget = () => {
    templateDropTarget?.classList.remove("is-template-drop-target");
    templateDropTarget = null;
  };
  const setTemplateDropTarget = (slot: HTMLElement | null) => {
    if (templateDropTarget === slot) return;
    clearTemplateDropTarget();
    templateDropTarget = slot;
    templateDropTarget?.classList.add("is-template-drop-target");
  };
  const entryForEvent = (event: Event): BlockIndexEntry | null => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "button[data-block-index]",
    );
    if (button === null || button === undefined || currentIndex === null) return null;
    const entryIndex = Number(button.dataset.blockIndex);
    if (!Number.isSafeInteger(entryIndex)) return null;
    const entry = currentIndex.entries[entryIndex];
    return entry !== undefined && isMovableEntry(entry) ? entry : null;
  };
  const buttonForEvent = (event: Event): HTMLButtonElement | null => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "button[data-block-index]",
    );
    return button !== null && button !== undefined ? button : null;
  };
  const slotForEvent = (event: Event): HTMLElement | null => {
    const target = event.target as Element | null;
    const explicitSlot = target?.closest<HTMLElement>("[data-assembly-slot]") ?? null;
    if (explicitSlot !== null || draggedTemplateId === null) return explicitSlot;

    // A native drag can retain the slot's pre-drag coordinates while CSS expands
    // its hit area. If the enclosing tree node receives the pointer instead, use
    // that node only as a geometric fallback; template identity still comes from
    // the in-memory palette drag session.
    const assemblyTarget = target?.closest<HTMLElement>("[data-assembly-target-index]") ?? null;
    if (assemblyTarget === null) return null;
    const index = assemblyTarget.dataset.assemblyTargetIndex;
    if (index === undefined) return null;
    const position = fallbackAssemblyPosition(event, assemblyTarget, index);
    return directAssemblySlot(assemblyTarget, index, position);
  };
  const templateIntentForEvent = (event: Event): AssemblyInsertIntent | null => {
    const slot = slotForEvent(event);
    if (
      draggedTemplateId === null ||
      slot === null ||
      currentIndex === null ||
      onInsert === undefined
    ) {
      return null;
    }
    const index = Number(slot.dataset.blockIndex);
    const position = slot.dataset.assemblySlot;
    const target = Number.isSafeInteger(index) ? currentIndex.entries[index] : undefined;
    if (
      target === undefined ||
      !isMovableEntry(target) ||
      (position !== "before" && position !== "after")
    ) {
      return null;
    }
    return Object.freeze({ templateId: draggedTemplateId, target, position });
  };
  const setDropTarget = (button: HTMLButtonElement | null) => {
    if (dropTargetButton === button) return;
    dropTargetButton?.classList.remove("is-drop-target");
    dropTargetButton = button;
    dropTargetButton?.classList.add("is-drop-target");
  };
  const onDragStart = (event: DragEvent) => {
    if (!interactionEnabled) return;
    clearDragState();
    const entry = entryForEvent(event);
    const button = buttonForEvent(event);
    if (onMove === undefined || entry === null || button === null || !button.draggable) {
      event.preventDefault();
      return;
    }
    draggedEntry = entry;
    draggedButton = button;
    button.classList.add("is-dragging");
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
      // Chromium only completes a native drag when the source publishes a
      // payload. Authorization still comes solely from our in-memory entry.
      event.dataTransfer.setData("text/plain", "c-block-tree-item");
    }
  };
  const onDragOver = (event: DragEvent) => {
    if (!interactionEnabled) return;
    const templateIntent = templateIntentForEvent(event);
    if (templateIntent !== null) {
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
      setTemplateDropTarget(slotForEvent(event));
      return;
    }
    clearTemplateDropTarget();
    const targetEntry = entryForEvent(event);
    const targetButton = buttonForEvent(event);
    if (
      draggedEntry === null ||
      targetEntry === null ||
      targetButton === null ||
      targetEntry === draggedEntry
    ) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    setDropTarget(targetButton);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!interactionEnabled) return;
    const slot = slotForEvent(event);
    if (slot !== null && slot === templateDropTarget) {
      const relatedTarget = event.relatedTarget;
      if (!(relatedTarget instanceof Node) || !slot.contains(relatedTarget)) {
        clearTemplateDropTarget();
      }
      return;
    }
    const button = buttonForEvent(event);
    if (button === null || button !== dropTargetButton) return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && button.contains(relatedTarget)) return;
    setDropTarget(null);
  };
  const onDrop = (event: DragEvent) => {
    if (!interactionEnabled) return;
    const templateIntent = templateIntentForEvent(event);
    if (templateIntent !== null) {
      event.preventDefault();
      clearDragState();
      clearTemplateDropTarget();
      draggedTemplateId = null;
      delete host.dataset.templateDrag;
      onInsert?.(templateIntent);
      return;
    }
    const sourceEntry = draggedEntry;
    const targetEntry = entryForEvent(event);
    if (sourceEntry === null || targetEntry === null || sourceEntry === targetEntry) {
      clearDragState();
      return;
    }
    event.preventDefault();
    clearDragState();
    onMove?.(sourceEntry, targetEntry);
  };
  const onDragEnd = () => {
    if (!interactionEnabled) {
      clearDragState();
      return;
    }
    clearDragState();
    clearTemplateDropTarget();
  };
  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKeyDown);
  host.addEventListener("dragstart", onDragStart);
  host.addEventListener("dragover", onDragOver);
  host.addEventListener("dragleave", onDragLeave);
  host.addEventListener("drop", onDrop);
  host.addEventListener("dragend", onDragEnd);

  const refreshDraggability = () => {
    for (const button of buttons) {
      const entryIndex = Number(button.dataset.blockIndex);
      const entry =
        currentIndex !== null && Number.isSafeInteger(entryIndex)
          ? currentIndex.entries[entryIndex]
          : undefined;
      button.draggable =
        interactionEnabled && onMove !== undefined && entry !== undefined && isMovableEntry(entry);
    }
  };

  return Object.freeze({
    setDocument(sourceDoc: SourceDoc, index: BlockIndex) {
      assertActive(destroyed);
      clearDragState();
      currentIndex = index;
      selectedEntry = null;
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
      buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button[data-block-index]"));
      for (const [position, button] of buttons.entries()) {
        button.tabIndex = position === 0 ? 0 : -1;
      }
      refreshDraggability();
    },
    setInteractionEnabled(enabled: boolean) {
      assertActive(destroyed);
      if (typeof enabled !== "boolean") {
        throw new TypeError("enabled 必须是布尔值");
      }
      interactionEnabled = enabled;
      clearDragState();
      clearTemplateDropTarget();
      if (!enabled) {
        draggedTemplateId = null;
        delete host.dataset.templateDrag;
      }
      host.inert = !enabled;
      if (enabled) {
        host.removeAttribute("aria-disabled");
      } else {
        host.setAttribute("aria-disabled", "true");
      }
      refreshDraggability();
    },
    setTemplateDrag(templateId: string | null) {
      assertActive(destroyed);
      if (templateId !== null && (typeof templateId !== "string" || templateId.length === 0)) {
        throw new TypeError("templateId 必须是非空字符串或 null");
      }
      clearDragState();
      clearTemplateDropTarget();
      draggedTemplateId = interactionEnabled ? templateId : null;
      if (draggedTemplateId === null) delete host.dataset.templateDrag;
      else host.dataset.templateDrag = "true";
    },
    getSelectedEntry() {
      assertActive(destroyed);
      return selectedEntry;
    },
    select(entry: BlockIndexEntry | null) {
      assertActive(destroyed);
      if (selectedButton !== null) {
        selectedButton.setAttribute("aria-selected", "false");
        selectedButton.classList.remove("is-selected");
      }
      selectedEntry = entry?.kind === "block" ? entry : null;
      selectedButton =
        entry?.kind === "block"
          ? host.querySelector<HTMLButtonElement>(`button[data-block-index="${entry.index}"]`)
          : null;
      if (selectedButton !== null) {
        for (const button of buttons) button.tabIndex = button === selectedButton ? 0 : -1;
        selectedButton.setAttribute("aria-selected", "true");
        selectedButton.classList.add("is-selected");
        selectedButton.scrollIntoView({ block: "nearest" });
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearDragState();
      clearTemplateDropTarget();
      draggedTemplateId = null;
      delete host.dataset.templateDrag;
      host.removeEventListener("click", onClick);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("dragstart", onDragStart);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("dragleave", onDragLeave);
      host.removeEventListener("drop", onDrop);
      host.removeEventListener("dragend", onDragEnd);
      host.inert = false;
      host.removeAttribute("aria-disabled");
      host.replaceChildren();
      buttons = [];
      currentIndex = null;
      selectedEntry = null;
      selectedButton = null;
    },
  });
}

function isMovableEntry(entry: BlockIndexEntry): boolean {
  return (
    entry.kind === "block" &&
    entry.block?.kind === "syntax" &&
    (entry.block.role === "statement" || entry.block.role === "declaration")
  );
}

function assertActive(destroyed: boolean): void {
  if (destroyed) {
    throw new Error("BlockTree 已销毁");
  }
}

function renderBlock(
  document: SourceDoc,
  block: Block,
  byBlock: ReadonlyMap<Block, BlockIndexEntry>,
  level: number,
): HTMLLIElement {
  const item = window.document.createElement("li");
  const semanticKind = blockSemanticKind(block);
  item.className = `block-tree-node block-tree-node--${semanticKind}`;
  item.dataset.fragmentKind = semanticKind;
  item.dataset.blockSemantic = semanticKind;
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
  if (entry !== undefined && isMovableEntry(entry)) {
    item.dataset.assemblyTargetIndex = String(entry.index);
    item.append(renderAssemblySlot(window.document, entry, "before"));
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
  if (entry !== undefined && isMovableEntry(entry)) {
    item.append(renderAssemblySlot(window.document, entry, "after"));
  }
  return item;
}

function renderAssemblySlot(
  ownerDocument: Document,
  entry: BlockIndexEntry,
  position: AssemblyInsertPosition,
): HTMLDivElement {
  const slot = ownerDocument.createElement("div");
  slot.className = "assembly-slot";
  slot.dataset.blockIndex = String(entry.index);
  slot.dataset.assemblySlot = position;
  slot.setAttribute("aria-hidden", "true");
  const track = ownerDocument.createElement("span");
  track.className = "assembly-slot__track";
  track.setAttribute("aria-hidden", "true");
  slot.append(track);
  return slot;
}

function directAssemblySlot(
  node: HTMLElement,
  blockIndex: string,
  position: AssemblyInsertPosition,
): HTMLElement | null {
  for (const child of Array.from(node.children)) {
    const candidate = child as HTMLElement;
    if (
      candidate.dataset.blockIndex === blockIndex &&
      candidate.dataset.assemblySlot === position
    ) {
      return candidate;
    }
  }
  return null;
}

function fallbackAssemblyPosition(
  event: Event,
  node: HTMLElement,
  blockIndex: string,
): AssemblyInsertPosition {
  const button = Array.from(node.children).find((child) => {
    const candidate = child as HTMLElement;
    return (
      candidate.tagName.toLocaleLowerCase() === "button" &&
      candidate.dataset.blockIndex === blockIndex
    );
  }) as HTMLElement | undefined;
  const pointerY = (event as DragEvent).clientY;
  if (button === undefined || typeof button.getBoundingClientRect !== "function") return "before";
  if (typeof pointerY !== "number" || !Number.isFinite(pointerY)) return "before";
  const bounds = button.getBoundingClientRect();
  return pointerY >= bounds.top + bounds.height / 2 ? "after" : "before";
}

type BlockSemanticKind = "control" | "declaration" | "function" | "raw" | "statement";

function blockSemanticKind(block: Block): BlockSemanticKind {
  if (block.kind === "raw") return "raw";
  if (block.nodeType === "function_definition") return "function";
  if (CONTROL_SHAPE_NODE_TYPES.has(block.nodeType)) return "control";
  return block.role === "declaration" ? "declaration" : "statement";
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

const CONTROL_SHAPE_NODE_TYPES: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "case_statement",
  "preproc_if",
  "preproc_ifdef",
  "preproc_ifndef",
  "preproc_else",
]);
