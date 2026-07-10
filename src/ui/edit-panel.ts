import { BINARY_OPERATORS, type BinaryOperator } from "../core/editing/operators.js";
import type { EditTarget } from "../core/editing/targets.js";

export type EditPanelStatusKind =
  "idle" | "ready" | "working" | "success" | "error" | "parse-error";

export interface EditPanelStatus {
  readonly kind: EditPanelStatusKind;
  readonly message: string;
}

export interface EditHistoryDepth {
  readonly undo: number;
  readonly redo: number;
}

interface EditRequestBase {
  readonly baseRevision: number;
  readonly targetId: string;
}

export interface ReplaceLiteralRequest extends EditRequestBase {
  readonly kind: "replace-literal";
  readonly newText: string;
}

export interface ReplaceBinaryOperatorRequest extends EditRequestBase {
  readonly kind: "replace-binary-operator";
  readonly newOperator: BinaryOperator;
}

export interface ReplaceForFieldsRequest extends EditRequestBase {
  readonly kind: "replace-for-fields";
  readonly initializerText: string;
  readonly conditionText: string;
  readonly updateText: string;
}

export interface ReplaceIfConditionRequest extends EditRequestBase {
  readonly kind: "replace-if-condition";
  readonly conditionText: string;
}

export type EditPanelRequest =
  | ReplaceLiteralRequest
  | ReplaceBinaryOperatorRequest
  | ReplaceForFieldsRequest
  | ReplaceIfConditionRequest;

export type EditPanelDraft =
  | { readonly kind: "literal"; readonly newText: string }
  | { readonly kind: "binary-expression"; readonly newOperator: string }
  | {
      readonly kind: "for-statement";
      readonly initializerText: string;
      readonly conditionText: string;
      readonly updateText: string;
    }
  | { readonly kind: "if-statement"; readonly conditionText: string };

export interface EditPanelRange {
  readonly from: number;
  readonly to: number;
}

export interface EditPanelDiff {
  readonly beforeRange: EditPanelRange;
  readonly afterRange: EditPanelRange;
  readonly beforeText: string;
  readonly afterText: string;
}

/** Plans may carry additional engine-specific fields; the panel reads only exact diffs. */
export interface EditConfirmationPlan {
  readonly diffs: readonly EditPanelDiff[];
}

export interface EditConfirmationRow extends EditPanelDiff {
  readonly index: number;
}

export interface EditPanelCallbacks<P extends EditConfirmationPlan = EditConfirmationPlan> {
  readonly plan: (request: EditPanelRequest) => P | Promise<P>;
  readonly commit: (plan: P) => void | Promise<void>;
  readonly undo: () => void | Promise<void>;
  readonly redo: () => void | Promise<void>;
}

export interface EditPanel<P extends EditConfirmationPlan = EditConfirmationPlan> {
  setTarget(target: EditTarget | null): void;
  setHistoryDepth(depth: EditHistoryDepth): void;
  setStatus(status: EditPanelStatus | string | Error): void;
  /** Opens the shared exact-diff dialog for non-M3a operations such as statement edits. */
  confirmExternal(plan: EditConfirmationPlan): Promise<boolean>;
  confirm(plan: P): Promise<boolean>;
  destroy(): void;
}

export type EditWorkflowResult = "committed" | "cancelled" | "stale";

interface RenderedForm {
  readonly form: HTMLFormElement;
  readonly fieldset: HTMLFieldSetElement;
  readonly submitButton: HTMLButtonElement;
  readonly readDraft: () => EditPanelDraft;
}

let nextPanelId = 1;

const binaryOperatorSet: ReadonlySet<string> = new Set(BINARY_OPERATORS);

/** Builds a frozen, target-bound request without trimming or normalizing user text. */
export function buildEditRequest(target: EditTarget, draft: EditPanelDraft): EditPanelRequest {
  assertTargetIdentity(target);
  if (target.kind !== draft.kind) {
    throw new TypeError(`draft ${draft.kind} 与 target ${target.kind} 不匹配`);
  }
  const base = { baseRevision: target.revision, targetId: target.id };
  switch (draft.kind) {
    case "literal":
      return Object.freeze({
        ...base,
        kind: "replace-literal",
        newText: requireString(draft.newText, "literal.newText"),
      });
    case "binary-expression": {
      const newOperator = requireString(draft.newOperator, "binary.newOperator");
      if (!binaryOperatorSet.has(newOperator)) {
        throw new TypeError(`不支持二元运算符 ${JSON.stringify(newOperator)}`);
      }
      return Object.freeze({
        ...base,
        kind: "replace-binary-operator",
        newOperator: newOperator as BinaryOperator,
      });
    }
    case "for-statement":
      return Object.freeze({
        ...base,
        kind: "replace-for-fields",
        initializerText: requireString(draft.initializerText, "for.initializerText"),
        conditionText: requireString(draft.conditionText, "for.conditionText"),
        updateText: requireString(draft.updateText, "for.updateText"),
      });
    case "if-statement":
      return Object.freeze({
        ...base,
        kind: "replace-if-condition",
        conditionText: requireString(draft.conditionText, "if.conditionText"),
      });
  }
}

/** Copies and freezes the exact before/after data rendered by the confirmation dialog. */
export function buildConfirmationRows(plan: EditConfirmationPlan): readonly EditConfirmationRow[] {
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.diffs)) {
    throw new TypeError("confirmation plan 必须提供 diffs 数组");
  }
  return Object.freeze(
    plan.diffs.map((diff, index) => {
      if (typeof diff !== "object" || diff === null) {
        throw new TypeError(`diff[${String(index)}] 必须是对象`);
      }
      return Object.freeze({
        index,
        beforeRange: copyRange(diff.beforeRange, `diff[${String(index)}].beforeRange`),
        afterRange: copyRange(diff.afterRange, `diff[${String(index)}].afterRange`),
        beforeText: requireString(diff.beforeText, `diff[${String(index)}].beforeText`),
        afterText: requireString(diff.afterText, `diff[${String(index)}].afterText`),
      });
    }),
  );
}

/**
 * A textarea exposes logical LF line endings. If the user made no logical
 * change, restore the byte-faithful original slot; otherwise return their value
 * exactly and let the diff confirmation expose any newline change.
 */
export function readRawTextareaValue(controlValue: string, originalText: string): string {
  requireString(controlValue, "textarea.value");
  requireString(originalText, "textarea originalText");
  return controlValue === normalizeTextareaNewlines(originalText) ? originalText : controlValue;
}

/** Executes the only allowed mutation sequence: plan, confirm, then commit. */
export async function runEditWorkflow<P extends EditConfirmationPlan>(
  request: EditPanelRequest,
  callbacks: Pick<EditPanelCallbacks<P>, "plan" | "commit">,
  confirm: (plan: P) => boolean | Promise<boolean>,
  isCurrent: () => boolean = () => true,
): Promise<EditWorkflowResult> {
  const plan = await callbacks.plan(request);
  if (!isCurrent()) return "stale";
  const approved = await confirm(plan);
  if (!approved) return "cancelled";
  if (!isCurrent()) return "stale";
  await callbacks.commit(plan);
  return "committed";
}

export function createEditPanel<P extends EditConfirmationPlan>(
  host: HTMLElement,
  callbacks: EditPanelCallbacks<P>,
): EditPanel<P> {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const panelId = nextPanelId;
  nextPanelId += 1;

  const root = ownerDocument.createElement("section");
  root.className = "edit-panel";
  root.setAttribute("aria-label", "编辑检查器");

  const toolbar = ownerDocument.createElement("div");
  toolbar.className = "edit-panel__toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "编辑历史");
  const undoButton = createButton(ownerDocument, "edit-panel__history-button", "撤销");
  undoButton.title = "撤销";
  const redoButton = createButton(ownerDocument, "edit-panel__history-button", "重做");
  redoButton.title = "重做";
  toolbar.append(undoButton, redoButton);

  const status = ownerDocument.createElement("output");
  status.className = "edit-panel__status";
  status.setAttribute("aria-live", "polite");

  const content = ownerDocument.createElement("div");
  content.className = "edit-panel__content";

  const confirmation = createConfirmationDialog(ownerDocument, panelId);
  root.append(toolbar, status, content, confirmation.dialog);
  host.append(root);

  let destroyed = false;
  let currentTarget: EditTarget | null = null;
  let currentForm: RenderedForm | null = null;
  let parseBlocked = false;
  let operationBusy = false;
  let historyBusy = false;
  let undoDepth = 0;
  let redoDepth = 0;
  let generation = 0;
  let activeConfirmation: ((approved: boolean) => void) | null = null;
  let previousFocus: HTMLElement | null = null;

  const applyStatus = (
    next: EditPanelStatus | string | Error,
    controlsParseBlock = false,
  ): void => {
    const normalized = normalizeStatus(next);
    status.textContent = normalized.message;
    status.dataset.state = normalized.kind;
    const wasParseBlocked = parseBlocked;
    if (normalized.kind === "parse-error") parseBlocked = true;
    else if (controlsParseBlock) parseBlocked = false;
    if (wasParseBlocked !== parseBlocked) renderTarget();
    updateInteractionState();
  };

  const renderTarget = (): void => {
    currentForm = null;
    content.replaceChildren();
    if (parseBlocked) {
      content.append(
        unavailableMessage(ownerDocument, "检测到解析错误；为避免生成错误补丁，当前目标不可编辑。"),
      );
      return;
    }
    if (currentTarget === null) {
      content.append(unavailableMessage(ownerDocument, "未选择可编辑项；代码保持不变。"));
      return;
    }
    const unavailableReason = targetUnavailableReason(currentTarget);
    if (unavailableReason !== null) {
      content.append(unavailableMessage(ownerDocument, unavailableReason));
      return;
    }
    currentForm = renderTargetForm(ownerDocument, panelId, currentTarget, onSubmit);
    content.append(currentForm.form);
    updateInteractionState();
  };

  const updateHistoryButtons = (): void => {
    undoButton.disabled = destroyed || historyBusy || operationBusy || undoDepth === 0;
    redoButton.disabled = destroyed || historyBusy || operationBusy || redoDepth === 0;
    undoButton.setAttribute("aria-label", `撤销，可用 ${String(undoDepth)} 步`);
    redoButton.setAttribute("aria-label", `重做，可用 ${String(redoDepth)} 步`);
  };

  function updateInteractionState(): void {
    if (currentForm !== null) {
      const disabled = destroyed || operationBusy || historyBusy || parseBlocked;
      currentForm.fieldset.disabled = disabled;
      currentForm.submitButton.disabled = disabled;
    }
    updateHistoryButtons();
  }

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (destroyed || operationBusy || parseBlocked || currentTarget === null) return;
    const form = currentForm;
    if (form === null) return;

    let request: EditPanelRequest;
    try {
      request = buildEditRequest(currentTarget, form.readDraft());
    } catch (error: unknown) {
      applyStatus(errorAsStatus(error));
      return;
    }

    operationBusy = true;
    const operationGeneration = generation + 1;
    generation = operationGeneration;
    applyStatus({ kind: "working", message: "正在生成精确修改预览…" });
    updateInteractionState();

    try {
      const result = await runEditWorkflow(
        request,
        callbacks,
        (plan) => confirmPlan(plan),
        () => !destroyed && generation === operationGeneration,
      );
      if (destroyed || generation !== operationGeneration) return;
      if (result === "committed") {
        applyStatus({ kind: "success", message: "修改已提交。" });
      } else if (result === "cancelled") {
        applyStatus({ kind: "ready", message: "已取消；源码未发生变化。" });
      }
    } catch (error: unknown) {
      if (!destroyed && generation === operationGeneration) {
        applyStatus(errorAsStatus(error));
      }
    } finally {
      if (!destroyed && generation === operationGeneration) {
        operationBusy = false;
        updateInteractionState();
      }
    }
  }

  const finishConfirmation = (approved: boolean): void => {
    const resolve = activeConfirmation;
    activeConfirmation = null;
    if (resolve === null) return;
    resolve(approved);
    const focus = previousFocus;
    previousFocus = null;
    if (focus?.isConnected === true) focus.focus();
  };

  const cancelActiveConfirmation = (): void => {
    if (activeConfirmation === null) return;
    const resolve = activeConfirmation;
    activeConfirmation = null;
    if (confirmation.dialog.open) confirmation.dialog.close("cancel");
    resolve(false);
    const focus = previousFocus;
    previousFocus = null;
    if (focus?.isConnected === true) focus.focus();
  };

  const onConfirmationClose = (): void => {
    finishConfirmation(confirmation.dialog.returnValue === "confirm");
  };
  confirmation.dialog.addEventListener("close", onConfirmationClose);

  const openConfirmation = (
    plan: EditConfirmationPlan,
    requireCurrentTarget: boolean,
  ): Promise<boolean> => {
    assertActive(destroyed);
    if (parseBlocked || (requireCurrentTarget && currentTarget === null)) {
      applyStatus({
        kind: parseBlocked ? "parse-error" : "idle",
        message: parseBlocked
          ? "检测到解析错误；修改确认已取消。"
          : "未选择可编辑项；修改确认已取消。",
      });
      return Promise.resolve(false);
    }
    const rows = buildConfirmationRows(plan);
    if (rows.length === 0) {
      applyStatus({ kind: "ready", message: "没有需要提交的变化。" });
      return Promise.resolve(false);
    }
    cancelActiveConfirmation();
    renderConfirmationRows(ownerDocument, confirmation.list, rows);
    const active = ownerDocument.activeElement;
    const htmlElementConstructor = ownerDocument.defaultView?.HTMLElement;
    previousFocus =
      htmlElementConstructor !== undefined && active instanceof htmlElementConstructor
        ? (active as HTMLElement)
        : null;
    confirmation.dialog.returnValue = "cancel";
    confirmation.dialog.showModal();
    confirmation.cancelButton.focus();
    return new Promise<boolean>((resolve) => {
      activeConfirmation = resolve;
    });
  };
  const confirmPlan = (plan: P): Promise<boolean> => openConfirmation(plan, true);

  const invokeHistory = async (
    action: () => void | Promise<void>,
    actionLabel: "撤销" | "重做",
  ): Promise<void> => {
    if (destroyed || historyBusy) return;
    generation += 1;
    operationBusy = false;
    cancelActiveConfirmation();
    historyBusy = true;
    updateHistoryButtons();
    try {
      await action();
      if (!destroyed) {
        applyStatus(
          parseBlocked
            ? { kind: "parse-error", message: `${actionLabel}请求已发送；等待重新解析。` }
            : { kind: "ready", message: `${actionLabel}请求已发送。` },
        );
      }
    } catch (error: unknown) {
      if (!destroyed) applyStatus(errorAsStatus(error));
    } finally {
      historyBusy = false;
      if (!destroyed) updateHistoryButtons();
    }
  };

  const onUndo = (): void => {
    if (undoDepth > 0) void invokeHistory(callbacks.undo, "撤销");
  };
  const onRedo = (): void => {
    if (redoDepth > 0) void invokeHistory(callbacks.redo, "重做");
  };
  undoButton.addEventListener("click", onUndo);
  redoButton.addEventListener("click", onRedo);

  renderTarget();
  applyStatus({ kind: "idle", message: "未选择可编辑项。" });
  updateHistoryButtons();

  return Object.freeze({
    setTarget(target: EditTarget | null): void {
      assertActive(destroyed);
      generation += 1;
      operationBusy = false;
      cancelActiveConfirmation();
      currentTarget = target;
      parseBlocked = false;
      renderTarget();
      const unavailableReason = target === null ? null : targetUnavailableReason(target);
      applyStatus(
        target === null
          ? { kind: "idle", message: "未选择可编辑项。" }
          : unavailableReason === null
            ? { kind: "ready", message: `${targetLabel(target)}可编辑；先预览，再确认。` }
            : { kind: "error", message: unavailableReason },
      );
    },
    setHistoryDepth(depth: EditHistoryDepth): void {
      assertActive(destroyed);
      undoDepth = requireDepth(depth?.undo, "undo");
      redoDepth = requireDepth(depth?.redo, "redo");
      updateHistoryButtons();
    },
    setStatus(next: EditPanelStatus | string | Error): void {
      assertActive(destroyed);
      const normalized = normalizeStatus(next);
      if (normalized.kind === "parse-error") {
        generation += 1;
        operationBusy = false;
        cancelActiveConfirmation();
      }
      applyStatus(normalized, true);
    },
    confirmExternal(plan: EditConfirmationPlan): Promise<boolean> {
      return openConfirmation(plan, false);
    },
    confirm: confirmPlan,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      operationBusy = false;
      historyBusy = false;
      cancelActiveConfirmation();
      undoButton.removeEventListener("click", onUndo);
      redoButton.removeEventListener("click", onRedo);
      confirmation.dialog.removeEventListener("close", onConfirmationClose);
      root.remove();
      currentForm = null;
      currentTarget = null;
    },
  });
}

function renderTargetForm(
  ownerDocument: Document,
  panelId: number,
  target: EditTarget,
  onSubmit: (event: SubmitEvent) => void,
): RenderedForm {
  const form = ownerDocument.createElement("form");
  form.className = "edit-panel__form";
  const fieldset = ownerDocument.createElement("fieldset");
  fieldset.className = "edit-panel__fieldset";
  const legend = ownerDocument.createElement("legend");
  legend.className = "edit-panel__legend";
  fieldset.append(legend);

  let readDraft: () => EditPanelDraft;
  switch (target.kind) {
    case "literal": {
      legend.textContent = "字面量";
      const input = ownerDocument.createElement("input");
      input.className = "edit-panel__input";
      input.type = "text";
      input.id = `edit-panel-${String(panelId)}-literal`;
      input.value = target.text;
      input.spellcheck = false;
      input.autocomplete = "off";
      fieldset.append(labeledControl(ownerDocument, input, "原文"));
      readDraft = () => ({ kind: "literal", newText: input.value });
      break;
    }
    case "binary-expression": {
      legend.textContent = "二元运算符";
      const select = ownerDocument.createElement("select");
      select.className = "edit-panel__select";
      select.id = `edit-panel-${String(panelId)}-operator`;
      for (const operator of BINARY_OPERATORS) {
        const option = ownerDocument.createElement("option");
        option.value = operator;
        option.textContent = operator;
        select.append(option);
      }
      select.value = target.operatorText;
      fieldset.append(labeledControl(ownerDocument, select, "运算符"));
      readDraft = () => ({ kind: "binary-expression", newOperator: select.value });
      break;
    }
    case "for-statement": {
      legend.textContent = "for 三段";
      const initializer = rawTextarea(
        ownerDocument,
        panelId,
        "for-initializer",
        target.initializerText,
      );
      const condition = rawTextarea(ownerDocument, panelId, "for-condition", target.conditionText);
      const update = rawTextarea(ownerDocument, panelId, "for-update", target.updateText);
      fieldset.append(
        labeledControl(ownerDocument, initializer.control, "初始化"),
        labeledControl(ownerDocument, condition.control, "条件"),
        labeledControl(ownerDocument, update.control, "更新"),
      );
      readDraft = () => ({
        kind: "for-statement",
        initializerText: initializer.read(),
        conditionText: condition.read(),
        updateText: update.read(),
      });
      break;
    }
    case "if-statement": {
      legend.textContent = "if 条件";
      const condition = rawTextarea(ownerDocument, panelId, "if-condition", target.conditionText);
      fieldset.append(labeledControl(ownerDocument, condition.control, "最外层括号内部"));
      readDraft = () => ({ kind: "if-statement", conditionText: condition.read() });
      break;
    }
  }

  const submitButton = createButton(ownerDocument, "edit-panel__submit", "预览修改");
  submitButton.type = "submit";
  fieldset.append(submitButton);
  form.append(fieldset);
  form.addEventListener("submit", onSubmit);
  return { form, fieldset, submitButton, readDraft };
}

function rawTextarea(
  ownerDocument: Document,
  panelId: number,
  field: string,
  originalText: string,
): { readonly control: HTMLTextAreaElement; readonly read: () => string } {
  const control = ownerDocument.createElement("textarea");
  control.className = "edit-panel__textarea";
  control.id = `edit-panel-${String(panelId)}-${field}`;
  control.rows = 3;
  control.wrap = "off";
  control.spellcheck = false;
  control.value = normalizeTextareaNewlines(originalText);
  return {
    control,
    read: () => readRawTextareaValue(control.value, originalText),
  };
}

function labeledControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  ownerDocument: Document,
  control: T,
  labelText: string,
): HTMLLabelElement {
  const label = ownerDocument.createElement("label");
  label.className = "edit-panel__field";
  label.htmlFor = control.id;
  const text = ownerDocument.createElement("span");
  text.className = "edit-panel__field-label";
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function createConfirmationDialog(ownerDocument: Document, panelId: number) {
  const dialog = ownerDocument.createElement("dialog");
  dialog.className = "edit-panel__confirmation";
  const titleId = `edit-panel-${String(panelId)}-confirmation-title`;
  const descriptionId = `edit-panel-${String(panelId)}-confirmation-description`;
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", descriptionId);
  const form = ownerDocument.createElement("form");
  form.method = "dialog";
  form.className = "edit-panel__confirmation-surface";
  const title = ownerDocument.createElement("h3");
  title.id = titleId;
  title.textContent = "确认修改";
  const description = ownerDocument.createElement("p");
  description.id = descriptionId;
  description.textContent = "逐项核对修改前后文本；只有确认后才会写入源码。";
  const list = ownerDocument.createElement("ol");
  list.className = "edit-panel__diff-list";
  const actions = ownerDocument.createElement("div");
  actions.className = "edit-panel__confirmation-actions";
  const cancelButton = createButton(ownerDocument, "button button--quiet", "取消");
  cancelButton.type = "submit";
  cancelButton.value = "cancel";
  const confirmButton = createButton(ownerDocument, "button button--primary", "确认修改");
  confirmButton.type = "submit";
  confirmButton.value = "confirm";
  actions.append(cancelButton, confirmButton);
  form.append(title, description, list, actions);
  dialog.append(form);
  return { dialog, list, cancelButton };
}

function renderConfirmationRows(
  ownerDocument: Document,
  list: HTMLOListElement,
  rows: readonly EditConfirmationRow[],
): void {
  list.replaceChildren();
  for (const row of rows) {
    const item = ownerDocument.createElement("li");
    item.className = "edit-panel__diff";
    const beforeLabel = ownerDocument.createElement("strong");
    beforeLabel.textContent = `修改前 [${String(row.beforeRange.from)}, ${String(row.beforeRange.to)})`;
    const before = ownerDocument.createElement("pre");
    before.className = "edit-panel__diff-text";
    before.textContent = row.beforeText;
    before.dataset.empty = String(row.beforeText.length === 0);
    const afterLabel = ownerDocument.createElement("strong");
    afterLabel.textContent = `修改后 [${String(row.afterRange.from)}, ${String(row.afterRange.to)})`;
    const after = ownerDocument.createElement("pre");
    after.className = "edit-panel__diff-text";
    after.textContent = row.afterText;
    after.dataset.empty = String(row.afterText.length === 0);
    item.append(beforeLabel, before, afterLabel, after);
    list.append(item);
  }
}

function unavailableMessage(ownerDocument: Document, message: string): HTMLParagraphElement {
  const paragraph = ownerDocument.createElement("p");
  paragraph.className = "edit-panel__unavailable";
  paragraph.textContent = message;
  return paragraph;
}

function createButton(
  ownerDocument: Document,
  className: string,
  label: string,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function normalizeTextareaNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function targetLabel(target: EditTarget): string {
  switch (target.kind) {
    case "literal":
      return "字面量";
    case "binary-expression":
      return "二元运算符";
    case "for-statement":
      return "for 三段";
    case "if-statement":
      return "if 条件";
  }
}

function targetUnavailableReason(target: EditTarget): string | null {
  if (target.kind === "literal" && /[\r\n]/u.test(target.text)) {
    return "跨行字面量不能用单行编辑器安全修改；源码保持不变。";
  }
  if (target.kind === "binary-expression" && !binaryOperatorSet.has(target.operatorText)) {
    return "当前二元运算符不在安全编辑集合中；源码保持不变。";
  }
  return null;
}

function normalizeStatus(status: EditPanelStatus | string | Error): EditPanelStatus {
  if (typeof status === "string") {
    return { kind: "ready", message: status };
  }
  if (status instanceof Error) return errorAsStatus(status);
  if (typeof status !== "object" || status === null) {
    throw new TypeError("status 必须是字符串、Error 或状态对象");
  }
  if (!STATUS_KINDS.has(status.kind)) throw new TypeError(`未知状态 ${String(status.kind)}`);
  return { kind: status.kind, message: requireString(status.message, "status.message") };
}

const STATUS_KINDS: ReadonlySet<string> = new Set([
  "idle",
  "ready",
  "working",
  "success",
  "error",
  "parse-error",
]);

function errorAsStatus(error: unknown): EditPanelStatus {
  return {
    kind: "error",
    message: error instanceof Error ? error.message : "无法完成编辑请求。",
  };
}

function copyRange(range: EditPanelRange, label: string): EditPanelRange {
  if (typeof range !== "object" || range === null) throw new TypeError(`${label} 必须是对象`);
  const { from, to } = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new RangeError(`${label} 必须是合法的 UTF-16 半开区间`);
  }
  return Object.freeze({ from, to });
}

function requireDepth(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} history depth 必须是非负安全整数`);
  }
  return value;
}

function requireString(value: string, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} 必须是字符串`);
  return value;
}

function assertTargetIdentity(target: EditTarget): void {
  if (typeof target !== "object" || target === null) throw new TypeError("target 必须是对象");
  if (typeof target.id !== "string" || target.id.length === 0) {
    throw new TypeError("target.id 不得为空");
  }
  if (!Number.isSafeInteger(target.revision) || target.revision < 0) {
    throw new RangeError("target.revision 必须是非负安全整数");
  }
}

function assertCallbacks<P extends EditConfirmationPlan>(callbacks: EditPanelCallbacks<P>): void {
  if (typeof callbacks !== "object" || callbacks === null) {
    throw new TypeError("edit panel callbacks 必须是对象");
  }
  for (const name of ["plan", "commit", "undo", "redo"] as const) {
    if (typeof callbacks[name] !== "function") throw new TypeError(`callbacks.${name} 必须是函数`);
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("EditPanel 已销毁");
}
