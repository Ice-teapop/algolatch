export interface CodeTextareaIndentationController {
  destroy(): void;
}

export interface CodeTextareaIndentationEdit {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/** Adds editor-style Tab indentation only to a textarea that contains source code. */
export function installCodeTextareaIndentation(
  textarea: HTMLTextAreaElement,
  indent = "  ",
): CodeTextareaIndentationController {
  if (!isTextareaHost(textarea)) {
    throw new TypeError("代码缩进只能安装到 textarea");
  }
  if (indent.length === 0 || /[^ \t]/u.test(indent)) {
    throw new TypeError("indent 必须由空格或制表符组成");
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    applyCodeTextareaIndentation(textarea, event.shiftKey, indent);
  };
  textarea.addEventListener("keydown", onKeydown);
  return Object.freeze({
    destroy(): void {
      textarea.removeEventListener("keydown", onKeydown);
    },
  });
}

function isTextareaHost(textarea: HTMLTextAreaElement | null): boolean {
  if (textarea === null) return false;
  const element = textarea as HTMLTextAreaElement & {
    readonly nodeName?: unknown;
    readonly tagName?: unknown;
  };
  if (typeof element.nodeName === "string") return element.nodeName === "TEXTAREA";
  return typeof element.tagName === "string" && element.tagName.toUpperCase() === "TEXTAREA";
}

export function applyCodeTextareaIndentation(
  textarea: HTMLTextAreaElement,
  outdent: boolean,
  indent = "  ",
): void {
  const edit = planCodeTextareaIndentation(
    textarea.value,
    textarea.selectionStart,
    textarea.selectionEnd,
    outdent,
    indent,
  );
  textarea.value = edit.value;
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  dispatchTextareaInput(textarea);
}

export function planCodeTextareaIndentation(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
  indent = "  ",
): CodeTextareaIndentationEdit {
  if (indent.length === 0 || /[^ \t]/u.test(indent)) {
    throw new TypeError("indent 必须由空格或制表符组成");
  }
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(selectionStart) ||
    !Number.isSafeInteger(selectionEnd) ||
    selectionStart < 0 ||
    selectionEnd < selectionStart ||
    selectionEnd > value.length
  ) {
    throw new TypeError("textarea selection 无效");
  }
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const selected = value.slice(lineStart, selectionEnd);
  const spansLines = selected.includes("\n");

  if (!outdent && !spansLines && selectionStart === selectionEnd) {
    return Object.freeze({
      value: `${value.slice(0, selectionStart)}${indent}${value.slice(selectionEnd)}`,
      selectionStart: selectionStart + indent.length,
      selectionEnd: selectionEnd + indent.length,
    });
  }

  const lineEndIndex = value.indexOf("\n", selectionEnd);
  const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  let removedBeforeStart = 0;
  let totalDelta = 0;
  const nextLines = lines.map((line, index) => {
    if (!outdent) {
      totalDelta += indent.length;
      return `${indent}${line}`;
    }
    const removable = line.startsWith("\t")
      ? 1
      : Math.min(indent.length, /^ */u.exec(line)?.[0].length ?? 0);
    if (index === 0) removedBeforeStart = removable;
    totalDelta -= removable;
    return line.slice(removable);
  });
  const replacement = nextLines.join("\n");
  const nextStart = outdent
    ? Math.max(lineStart, selectionStart - removedBeforeStart)
    : selectionStart + indent.length;
  const nextEnd = Math.max(nextStart, selectionEnd + totalDelta);
  return Object.freeze({
    value: `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`,
    selectionStart: nextStart,
    selectionEnd: nextEnd,
  });
}

function dispatchTextareaInput(textarea: HTMLTextAreaElement): void {
  const EventConstructor = textarea.ownerDocument.defaultView?.Event ?? Event;
  textarea.dispatchEvent(new EventConstructor("input", { bubbles: true }));
}
