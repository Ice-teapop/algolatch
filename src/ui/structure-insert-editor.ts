import type { InterfaceLocale } from "../shared/interface-locale.js";
import { installCodeTextareaIndentation } from "./code-textarea-keymap.js";

const MIN_ROWS = 2;
const MAX_ROWS = 8;

interface StructureInsertEditorCopy {
  readonly label: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly hint: string;
  readonly inlineControlTraceWarning: string;
  readonly unsupportedDoTraceWarning: string;
}

const COPY: Readonly<Record<InterfaceLocale, StructureInsertEditorCopy>> = Object.freeze({
  "zh-CN": Object.freeze({
    label: "插入 C 语句或控制块",
    placeholder: "例如：total += value; 或多行 for (...) { … }",
    ariaLabel: "要插入的 C 语句或控制块",
    hint: "可输入一条 C 语句或一个多行控制块；首行无需外层缩进。",
    inlineControlTraceWarning: "代码可运行，但需改为多行结构才能使用 Trace。",
    unsupportedDoTraceWarning: "代码可运行，但当前 Trace 尚不支持 do-while。",
  }),
  en: Object.freeze({
    label: "Insert a C statement or control block",
    placeholder: "Example: total += value; or a multiline for (...) { … }",
    ariaLabel: "C statement or control block to insert",
    hint: "Enter one C statement or one multiline control block, without outer indentation on the first line.",
    inlineControlTraceWarning:
      "This code can run, but it must use a multiline control structure before Trace can observe it.",
    unsupportedDoTraceWarning:
      "This code can run, but the current Trace contract does not support do-while.",
  }),
});

export interface StructureInsertEditor {
  readonly field: HTMLLabelElement;
  readonly input: HTMLTextAreaElement;
  readonly hint: HTMLParagraphElement;
  setLocale(locale: InterfaceLocale): void;
  setValue(value: string): void;
  setUnavailableReason(reason: string | null): void;
}

export function createStructureInsertEditor(
  ownerDocument: Document,
  locale: InterfaceLocale,
  initialValue: string,
  onDraftChange: () => void,
  unavailableReason: string | null = null,
): StructureInsertEditor {
  let copy = COPY[locale];
  const field = ownerDocument.createElement("label");
  field.className = "structure-edit-panel__field";
  const label = ownerDocument.createElement("span");
  label.className = "structure-edit-panel__field-label";
  label.textContent = copy.label;
  const input = ownerDocument.createElement("textarea");
  input.className = "structure-edit-panel__input";
  input.value = initialValue;
  input.placeholder = copy.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", copy.ariaLabel);
  const hint = ownerDocument.createElement("p");
  hint.className = "structure-edit-panel__hint";
  field.append(label, input);

  let currentUnavailableReason = unavailableReason;
  const updateRows = (): void => {
    const physicalLineCount = input.value.split(/\r\n|\r|\n/u).length;
    input.rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, physicalLineCount));
  };
  const updateHint = (): void => {
    hint.textContent =
      currentUnavailableReason ??
      (isDoWhileControlBlock(input.value)
        ? copy.unsupportedDoTraceWarning
        : isInlineControlBlock(input.value)
          ? copy.inlineControlTraceWarning
          : copy.hint);
  };
  const notifyChanged = (): void => {
    updateRows();
    updateHint();
    onDraftChange();
  };

  input.addEventListener("input", notifyChanged);
  installCodeTextareaIndentation(input);
  updateRows();
  updateHint();

  return Object.freeze({
    field,
    input,
    hint,
    setLocale(nextLocale: InterfaceLocale): void {
      copy = COPY[nextLocale];
      label.textContent = copy.label;
      input.placeholder = copy.placeholder;
      input.setAttribute("aria-label", copy.ariaLabel);
      updateHint();
    },
    setValue(value: string): void {
      input.value = value;
      updateRows();
      updateHint();
    },
    setUnavailableReason(reason: string | null): void {
      currentUnavailableReason = reason;
      updateHint();
    },
  });
}

export function isValidStructureInsertText(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim().length === 0 ||
    /^[\r\n]|[\r\n]$/u.test(value) ||
    /^[ \t\f\v]|[ \t\f\v]$/u.test(value)
  ) {
    return false;
  }
  const physicalLines = value.split(/\r\n|\r|\n/u);
  for (const [index, line] of physicalLines.entries()) {
    const firstPreprocessingToken = line.replace(/^(?:[ \t\f\v]|\/\*[^\r\n]*?\*\/)+/u, "");
    if (
      ["#", "%:", "??="].some((token) => firstPreprocessingToken.startsWith(token)) ||
      /(?:\\|\?\?\/)[ \t\f\v]*$/u.test(line) ||
      (index === 0 && /^\/\//u.test(line))
    ) {
      return false;
    }
  }
  return true;
}

export function isInlineControlBlock(value: string): boolean {
  if (/[\r\n]/u.test(value)) return false;
  const trimmed = value.trim();
  if (!/^(?:(?:if|for|while|switch)\s*\(|do\b)/u.test(trimmed)) return false;
  const openBrace = trimmed.indexOf("{");
  const closeBrace = trimmed.lastIndexOf("}");
  return openBrace >= 0 && closeBrace > openBrace;
}

function isDoWhileControlBlock(value: string): boolean {
  return /^\s*do\b/u.test(value);
}
