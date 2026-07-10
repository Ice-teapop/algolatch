export interface StructureEditRange {
  readonly from: number;
  readonly to: number;
}

export interface StructureEditDiff {
  readonly beforeRange: StructureEditRange;
  readonly afterRange: StructureEditRange;
  readonly beforeText: string;
  readonly afterText: string;
}

/** Engine plans may carry any extra validated facts; this panel only requires exact diffs. */
export interface StructureEditConfirmationPlan {
  readonly diffs: readonly StructureEditDiff[];
}

export type StructureEditBlocker =
  "multiline-block-comment" | "not-line-exclusive" | "parse-recovery" | "preprocessor-context";

export type StructureEditParentMode = "statement-list" | "required-body";

export interface StructureEditNeighborSelection {
  readonly id: string;
  readonly text: string;
}

export interface StructureEditStatementSelection {
  readonly id: string;
  readonly text: string;
  readonly parentMode: StructureEditParentMode;
  readonly blocker: StructureEditBlocker | null;
  readonly previous: StructureEditNeighborSelection | null;
  readonly next: StructureEditNeighborSelection | null;
}

export interface StructureEditRenameSelection {
  readonly symbolId: string;
  readonly name: string;
}

export interface StructureEditSelection {
  readonly revision: number;
  readonly statement?: StructureEditStatementSelection;
  readonly localVariable?: StructureEditRenameSelection;
}

interface StructureEditRequestBase {
  readonly baseRevision: number;
  readonly targetId: string;
  readonly expectedTargetText: string;
}

export interface StructureInsertStatementRequest extends StructureEditRequestBase {
  readonly kind: "insert-statement";
  readonly position: "before" | "after";
  readonly statementText: string;
}

export interface StructureDeleteStatementRequest extends StructureEditRequestBase {
  readonly kind: "delete-statement";
}

export interface StructureSwapStatementsRequest extends StructureEditRequestBase {
  readonly kind: "swap-adjacent-statements";
  readonly adjacentTargetId: string;
  readonly expectedAdjacentTargetText: string;
}

export interface StructureRenameRequest {
  readonly kind: "local-variable-rename";
  readonly baseRevision: number;
  readonly symbolId: string;
  readonly expectedOldName: string;
  readonly newName: string;
}

export type StructureEditRequest =
  | StructureInsertStatementRequest
  | StructureDeleteStatementRequest
  | StructureSwapStatementsRequest
  | StructureRenameRequest;

export type StructureEditIntent =
  | { readonly kind: "insert-before"; readonly statementText: string }
  | { readonly kind: "insert-after"; readonly statementText: string }
  | { readonly kind: "delete" }
  | { readonly kind: "move-previous" }
  | { readonly kind: "move-next" }
  | { readonly kind: "rename"; readonly newName: string };

export interface StructureEditPanelCallbacks<
  P extends StructureEditConfirmationPlan = StructureEditConfirmationPlan,
> {
  readonly plan: (request: StructureEditRequest) => P | Promise<P>;
  readonly confirm: (plan: P) => boolean | Promise<boolean>;
  readonly commit: (plan: P) => void | Promise<void>;
}

export interface StructureEditPanel {
  readonly element: HTMLElement;
  setSelection(selection: StructureEditSelection | null): void;
  destroy(): void;
}

export interface StructureEditAvailability {
  readonly insert: boolean;
  readonly delete: boolean;
  readonly movePrevious: boolean;
  readonly moveNext: boolean;
  readonly rename: boolean;
  readonly statementReason: string | null;
}

export type StructureEditWorkflowResult = "committed" | "cancelled" | "stale";

interface RenderedControls {
  readonly insertInput: HTMLInputElement | null;
  readonly insertBefore: HTMLButtonElement | null;
  readonly insertAfter: HTMLButtonElement | null;
  readonly deleteButton: HTMLButtonElement | null;
  readonly movePrevious: HTMLButtonElement | null;
  readonly moveNext: HTMLButtonElement | null;
  readonly renameInput: HTMLInputElement | null;
  readonly renameButton: HTMLButtonElement | null;
}

const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_IMPLEMENTATION_IDENTIFIER = /^(?:__|_[A-Z])/u;
const C17_KEYWORDS = new Set([
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Imaginary",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
]);

export function getStructureEditAvailability(
  selection: StructureEditSelection | null,
  insertText = "",
  renameText = selection?.localVariable?.name ?? "",
): StructureEditAvailability {
  const statement = selection?.statement;
  const localVariable = selection?.localVariable;
  const statementReason = statement === undefined ? null : statementUnavailableReason(statement);
  const statementListReady = statement !== undefined && statement.blocker === null;
  const canReorder = statementListReady && statement.parentMode === "statement-list";
  return Object.freeze({
    insert: canReorder && isValidInsertLine(insertText),
    delete:
      statement !== undefined &&
      (statement.blocker === null ||
        (statement.blocker === "not-line-exclusive" && statement.parentMode === "required-body")),
    movePrevious: canReorder && statement.previous !== null,
    moveNext: canReorder && statement.next !== null,
    rename:
      localVariable !== undefined &&
      renameText !== localVariable.name &&
      isValidRenameIdentifier(renameText),
    statementReason,
  });
}

export function buildStructureEditRequest(
  selection: StructureEditSelection,
  intent: StructureEditIntent,
): StructureEditRequest {
  const snapshot = copySelection(selection);
  if (intent.kind === "rename") {
    const localVariable = snapshot.localVariable;
    if (localVariable === undefined) throw new TypeError("当前选择没有可重命名的局部变量");
    if (!isValidRenameIdentifier(intent.newName)) {
      throw new TypeError("新名称必须是非保留的 ASCII C 标识符");
    }
    if (intent.newName === localVariable.name) throw new TypeError("新旧名称相同");
    return Object.freeze({
      kind: "local-variable-rename",
      baseRevision: snapshot.revision,
      symbolId: localVariable.symbolId,
      expectedOldName: localVariable.name,
      newName: intent.newName,
    });
  }

  const statement = snapshot.statement;
  if (statement === undefined) throw new TypeError("当前选择没有可编辑语句");
  const availability = getStructureEditAvailability(
    snapshot,
    "statementText" in intent ? intent.statementText : "valid();",
  );
  const base = {
    baseRevision: snapshot.revision,
    targetId: statement.id,
    expectedTargetText: statement.text,
  };
  switch (intent.kind) {
    case "insert-before":
    case "insert-after":
      if (!availability.insert) throw new TypeError("当前语句不允许在相邻位置插入");
      return Object.freeze({
        ...base,
        kind: "insert-statement",
        position: intent.kind === "insert-before" ? "before" : "after",
        statementText: intent.statementText,
      });
    case "delete":
      if (!availability.delete) throw new TypeError("当前语句不允许删除");
      return Object.freeze({ ...base, kind: "delete-statement" });
    case "move-previous":
    case "move-next": {
      const neighbor = intent.kind === "move-previous" ? statement.previous : statement.next;
      const canMove =
        intent.kind === "move-previous" ? availability.movePrevious : availability.moveNext;
      if (!canMove || neighbor === null) throw new TypeError("当前方向没有可交换的相邻语句");
      return Object.freeze({
        ...base,
        kind: "swap-adjacent-statements",
        adjacentTargetId: neighbor.id,
        expectedAdjacentTargetText: neighbor.text,
      });
    }
  }
}

/** The sole mutation workflow: plan, external confirmation, then commit. */
export async function runStructureEditWorkflow<P extends StructureEditConfirmationPlan>(
  request: StructureEditRequest,
  callbacks: StructureEditPanelCallbacks<P>,
  isCurrent: () => boolean = () => true,
): Promise<StructureEditWorkflowResult> {
  const plan = await callbacks.plan(request);
  assertConfirmationPlan(plan);
  if (!isCurrent()) return "stale";
  const approved = await callbacks.confirm(plan);
  if (!approved) return "cancelled";
  if (!isCurrent()) return "stale";
  await callbacks.commit(plan);
  return "committed";
}

export function createStructureEditPanel<P extends StructureEditConfirmationPlan>(
  host: HTMLElement,
  callbacks: StructureEditPanelCallbacks<P>,
): StructureEditPanel {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const root = ownerDocument.createElement("section");
  root.className = "structure-edit-panel";
  root.setAttribute("aria-label", "结构编辑");

  const status = ownerDocument.createElement("output");
  status.className = "structure-edit-panel__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const content = ownerDocument.createElement("div");
  content.className = "structure-edit-panel__content";
  root.append(status, content);
  host.append(root);

  let destroyed = false;
  let selection: StructureEditSelection | null = null;
  let selectionGeneration = 0;
  let operationSequence = 0;
  let operationBusy = false;
  let controls: RenderedControls = emptyControls();

  const setStatus = (
    state: "idle" | "ready" | "working" | "success" | "error",
    message: string,
  ) => {
    root.dataset.state = state;
    status.dataset.state = state;
    status.textContent = message;
  };

  const updateControls = (): void => {
    const availability = getStructureEditAvailability(
      selection,
      controls.insertInput?.value ?? "",
      controls.renameInput?.value ?? selection?.localVariable?.name ?? "",
    );
    setDisabled(controls.insertBefore, operationBusy || !availability.insert);
    setDisabled(controls.insertAfter, operationBusy || !availability.insert);
    setDisabled(controls.deleteButton, operationBusy || !availability.delete);
    setDisabled(controls.movePrevious, operationBusy || !availability.movePrevious);
    setDisabled(controls.moveNext, operationBusy || !availability.moveNext);
    setDisabled(controls.renameButton, operationBusy || !availability.rename);
    if (controls.insertInput !== null) {
      const statementCanInsert =
        selection?.statement?.blocker === null &&
        selection.statement.parentMode === "statement-list";
      controls.insertInput.disabled = operationBusy || !statementCanInsert;
      const value = controls.insertInput.value;
      controls.insertInput.setAttribute(
        "aria-invalid",
        String(value.length > 0 && !isValidInsertLine(value)),
      );
    }
    if (controls.renameInput !== null) {
      controls.renameInput.disabled = operationBusy;
      const value = controls.renameInput.value;
      controls.renameInput.setAttribute(
        "aria-invalid",
        String(value !== selection?.localVariable?.name && !isValidRenameIdentifier(value)),
      );
    }
  };

  const execute = async (
    intent: StructureEditIntent,
    renderedGeneration: number,
  ): Promise<void> => {
    if (
      destroyed ||
      operationBusy ||
      selection === null ||
      renderedGeneration !== selectionGeneration
    ) {
      return;
    }
    let request: StructureEditRequest;
    try {
      request = buildStructureEditRequest(selection, intent);
    } catch (error: unknown) {
      setStatus("error", errorMessage(error));
      updateControls();
      return;
    }

    operationBusy = true;
    const operationId = ++operationSequence;
    setStatus("working", "正在生成精确修改预览…");
    updateControls();
    const isCurrent = () =>
      !destroyed && operationId === operationSequence && renderedGeneration === selectionGeneration;
    try {
      const result = await runStructureEditWorkflow(request, callbacks, isCurrent);
      if (!isCurrent()) return;
      setStatus(
        result === "committed" ? "success" : "ready",
        result === "committed" ? "修改已提交。" : "已取消；源码未发生变化。",
      );
    } catch (error: unknown) {
      if (isCurrent()) setStatus("error", errorMessage(error));
    } finally {
      if (isCurrent()) {
        operationBusy = false;
        updateControls();
      }
    }
  };

  const render = (): void => {
    content.replaceChildren();
    controls = emptyControls();
    const current = selection;
    if (
      current === null ||
      (current.statement === undefined && current.localVariable === undefined)
    ) {
      content.append(unavailableMessage(ownerDocument));
      setStatus("idle", "当前选择没有可用的结构操作。");
      return;
    }
    const renderedGeneration = selectionGeneration;
    if (current.statement !== undefined) {
      const statementControls = renderStatementGroup(
        ownerDocument,
        current.statement,
        (intent) => void execute(intent, renderedGeneration),
        updateControls,
      );
      controls = mergeControls(controls, statementControls);
      content.append(statementControls.group);
    }
    if (current.localVariable !== undefined) {
      const renameControls = renderRenameGroup(
        ownerDocument,
        current.localVariable,
        (intent) => void execute(intent, renderedGeneration),
        updateControls,
      );
      controls = mergeControls(controls, renameControls);
      content.append(renameControls.group);
    }
    const availability = getStructureEditAvailability(current);
    setStatus("ready", availability.statementReason ?? "结构操作已就绪；提交前会显示精确差异。");
    updateControls();
  };

  render();

  return Object.freeze({
    element: root,
    setSelection(next: StructureEditSelection | null): void {
      assertActive(destroyed);
      selection = next === null ? null : copySelection(next);
      selectionGeneration += 1;
      operationSequence += 1;
      operationBusy = false;
      render();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      selectionGeneration += 1;
      operationSequence += 1;
      operationBusy = false;
      root.remove();
      selection = null;
      controls = emptyControls();
    },
  });
}

function renderStatementGroup(
  ownerDocument: Document,
  statement: StructureEditStatementSelection,
  execute: (intent: StructureEditIntent) => void,
  onDraftChange: () => void,
): RenderedControls & { readonly group: HTMLFieldSetElement } {
  const group = ownerDocument.createElement("fieldset");
  group.className = "structure-edit-panel__group";
  const legend = ownerDocument.createElement("legend");
  legend.className = "structure-edit-panel__legend";
  legend.textContent = "语句结构";
  const target = ownerDocument.createElement("code");
  target.className = "structure-edit-panel__target";
  target.textContent = statement.text;
  target.title = statement.text;

  const insertLabel = ownerDocument.createElement("label");
  insertLabel.className = "structure-edit-panel__field";
  const insertLabelText = ownerDocument.createElement("span");
  insertLabelText.className = "structure-edit-panel__field-label";
  insertLabelText.textContent = "插入一条语句";
  const insertInput = ownerDocument.createElement("input");
  insertInput.className = "structure-edit-panel__input";
  insertInput.type = "text";
  insertInput.placeholder = "例如：total += value;";
  insertInput.autocomplete = "off";
  insertInput.spellcheck = false;
  insertInput.setAttribute("aria-label", "要插入的单行 C 语句");
  insertLabel.append(insertLabelText, insertInput);

  const insertActions = actionRow(ownerDocument);
  const insertBefore = actionButton(ownerDocument, "上方插入", "在当前语句上方插入一行");
  const insertAfter = actionButton(ownerDocument, "下方插入", "在当前语句下方插入一行");
  insertBefore.dataset.operation = "insert-before";
  insertAfter.dataset.operation = "insert-after";
  insertActions.append(insertBefore, insertAfter);

  const moveActions = actionRow(ownerDocument);
  const movePrevious = actionButton(ownerDocument, "上移", "将当前语句上移，与上一条交换");
  const moveNext = actionButton(ownerDocument, "下移", "将当前语句下移，与下一条交换");
  const deleteButton = actionButton(
    ownerDocument,
    "删除",
    "删除当前语句",
    "structure-edit-panel__button--danger",
  );
  movePrevious.dataset.operation = "move-previous";
  moveNext.dataset.operation = "move-next";
  deleteButton.dataset.operation = "delete";
  moveActions.append(movePrevious, moveNext, deleteButton);

  const hint = ownerDocument.createElement("p");
  hint.className = "structure-edit-panel__hint";
  hint.textContent = statementUnavailableReason(statement) ?? "仅接受一条无外层缩进的物理源码行。";
  group.append(legend, target, insertLabel, insertActions, moveActions, hint);

  insertInput.addEventListener("input", () => {
    onDraftChange();
  });
  insertBefore.addEventListener("click", () =>
    execute({ kind: "insert-before", statementText: insertInput.value }),
  );
  insertAfter.addEventListener("click", () =>
    execute({ kind: "insert-after", statementText: insertInput.value }),
  );
  movePrevious.addEventListener("click", () => execute({ kind: "move-previous" }));
  moveNext.addEventListener("click", () => execute({ kind: "move-next" }));
  deleteButton.addEventListener("click", () => execute({ kind: "delete" }));

  return {
    ...emptyControls(),
    group,
    insertInput,
    insertBefore,
    insertAfter,
    deleteButton,
    movePrevious,
    moveNext,
  };
}

function renderRenameGroup(
  ownerDocument: Document,
  localVariable: StructureEditRenameSelection,
  execute: (intent: StructureEditIntent) => void,
  onDraftChange: () => void,
): RenderedControls & { readonly group: HTMLFieldSetElement } {
  const group = ownerDocument.createElement("fieldset");
  group.className = "structure-edit-panel__group";
  const legend = ownerDocument.createElement("legend");
  legend.className = "structure-edit-panel__legend";
  legend.textContent = "局部变量";
  const renameLabel = ownerDocument.createElement("label");
  renameLabel.className = "structure-edit-panel__field";
  const renameLabelText = ownerDocument.createElement("span");
  renameLabelText.className = "structure-edit-panel__field-label";
  renameLabelText.textContent = `重命名 ${localVariable.name}`;
  const renameInput = ownerDocument.createElement("input");
  renameInput.className = "structure-edit-panel__input";
  renameInput.type = "text";
  renameInput.value = localVariable.name;
  renameInput.autocomplete = "off";
  renameInput.spellcheck = false;
  renameInput.setAttribute("aria-label", `局部变量 ${localVariable.name} 的新名称`);
  renameLabel.append(renameLabelText, renameInput);
  const renameButton = actionButton(
    ownerDocument,
    "预览重命名",
    `预览局部变量 ${localVariable.name} 的重命名`,
  );
  renameButton.dataset.operation = "rename";
  const hint = ownerDocument.createElement("p");
  hint.className = "structure-edit-panel__hint";
  hint.textContent = "使用非关键字、非实现保留名的 ASCII C 标识符。";
  group.append(legend, renameLabel, renameButton, hint);

  renameInput.addEventListener("input", () => {
    onDraftChange();
  });
  renameButton.addEventListener("click", () =>
    execute({ kind: "rename", newName: renameInput.value }),
  );
  return { ...emptyControls(), group, renameInput, renameButton };
}

function actionRow(ownerDocument: Document): HTMLDivElement {
  const row = ownerDocument.createElement("div");
  row.className = "structure-edit-panel__actions";
  return row;
}

function actionButton(
  ownerDocument: Document,
  text: string,
  ariaLabel: string,
  modifier = "",
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = `structure-edit-panel__button${modifier.length > 0 ? ` ${modifier}` : ""}`;
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  button.disabled = true;
  return button;
}

function unavailableMessage(ownerDocument: Document): HTMLParagraphElement {
  const message = ownerDocument.createElement("p");
  message.className = "structure-edit-panel__unavailable";
  message.textContent = "选择一条语句或局部变量以使用结构操作。";
  return message;
}

function statementUnavailableReason(statement: StructureEditStatementSelection): string | null {
  if (statement.parentMode === "required-body" && statement.blocker === null) {
    return "无大括号控制体只允许删除；插入或移动前请先补大括号。";
  }
  if (statement.blocker === null) return null;
  if (statement.blocker === "not-line-exclusive" && statement.parentMode === "required-body") {
    return "行内控制体只允许安全删除；删除后会保留空语句。";
  }
  switch (statement.blocker) {
    case "multiline-block-comment":
      return "跨行块注释的附着关系不明确，结构操作已停用。";
    case "not-line-exclusive":
      return "该语句未独占源码行，结构操作已停用。";
    case "parse-recovery":
      return "该语句位于语法恢复区，结构操作已停用。";
    case "preprocessor-context":
      return "该语句邻近预处理或续行边界，结构操作已停用。";
  }
}

function isValidInsertLine(value: string): boolean {
  const hasValidPhysicalLineShape =
    value.length > 0 && value.trim().length > 0 && value.trim() === value && !/[\r\n]/u.test(value);
  if (!hasValidPhysicalLineShape) return false;
  const firstPreprocessingToken = value.replace(/^(?:[ \t\f\v]|\/\*[^\r\n]*?\*\/)+/u, "");
  return (
    !["#", "%:", "??="].some((token) => firstPreprocessingToken.startsWith(token)) &&
    !/(?:\\|\?\?\/)[ \t\f\v]*$/u.test(value) &&
    !/^\/\//u.test(value)
  );
}

function isValidRenameIdentifier(value: string): boolean {
  return (
    C_IDENTIFIER.test(value) &&
    !C17_KEYWORDS.has(value) &&
    !RESERVED_IMPLEMENTATION_IDENTIFIER.test(value)
  );
}

function copySelection(selection: StructureEditSelection): StructureEditSelection {
  if (
    typeof selection !== "object" ||
    selection === null ||
    !Number.isSafeInteger(selection.revision) ||
    selection.revision < 0
  ) {
    throw new TypeError("selection.revision 必须是非负安全整数");
  }
  const statement =
    selection.statement === undefined ? undefined : copyStatement(selection.statement);
  const localVariable =
    selection.localVariable === undefined
      ? undefined
      : Object.freeze({
          symbolId: requireNonEmpty(selection.localVariable.symbolId, "localVariable.symbolId"),
          name: requireNonEmpty(selection.localVariable.name, "localVariable.name"),
        });
  return Object.freeze({
    revision: selection.revision,
    ...(statement === undefined ? {} : { statement }),
    ...(localVariable === undefined ? {} : { localVariable }),
  });
}

function copyStatement(
  statement: StructureEditStatementSelection,
): StructureEditStatementSelection {
  if (statement.parentMode !== "statement-list" && statement.parentMode !== "required-body") {
    throw new TypeError("statement.parentMode 无效");
  }
  if (
    statement.blocker !== null &&
    statement.blocker !== "multiline-block-comment" &&
    statement.blocker !== "not-line-exclusive" &&
    statement.blocker !== "parse-recovery" &&
    statement.blocker !== "preprocessor-context"
  ) {
    throw new TypeError("statement.blocker 无效");
  }
  return Object.freeze({
    id: requireNonEmpty(statement.id, "statement.id"),
    text: requireString(statement.text, "statement.text"),
    parentMode: statement.parentMode,
    blocker: statement.blocker,
    previous: copyNeighbor(statement.previous, "statement.previous"),
    next: copyNeighbor(statement.next, "statement.next"),
  });
}

function copyNeighbor(
  neighbor: StructureEditNeighborSelection | null,
  label: string,
): StructureEditNeighborSelection | null {
  if (neighbor === null) return null;
  return Object.freeze({
    id: requireNonEmpty(neighbor.id, `${label}.id`),
    text: requireString(neighbor.text, `${label}.text`),
  });
}

function assertCallbacks<P extends StructureEditConfirmationPlan>(
  callbacks: StructureEditPanelCallbacks<P>,
): void {
  if (
    typeof callbacks?.plan !== "function" ||
    typeof callbacks.confirm !== "function" ||
    typeof callbacks.commit !== "function"
  ) {
    throw new TypeError("structure edit callbacks 不完整");
  }
}

function assertConfirmationPlan(plan: StructureEditConfirmationPlan): void {
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.diffs)) {
    throw new TypeError("structure edit plan 必须提供 diffs 数组");
  }
}

function emptyControls(): RenderedControls {
  return {
    insertInput: null,
    insertBefore: null,
    insertAfter: null,
    deleteButton: null,
    movePrevious: null,
    moveNext: null,
    renameInput: null,
    renameButton: null,
  };
}

function mergeControls(left: RenderedControls, right: RenderedControls): RenderedControls {
  return {
    insertInput: right.insertInput ?? left.insertInput,
    insertBefore: right.insertBefore ?? left.insertBefore,
    insertAfter: right.insertAfter ?? left.insertAfter,
    deleteButton: right.deleteButton ?? left.deleteButton,
    movePrevious: right.movePrevious ?? left.movePrevious,
    moveNext: right.moveNext ?? left.moveNext,
    renameInput: right.renameInput ?? left.renameInput,
    renameButton: right.renameButton ?? left.renameButton,
  };
}

function setDisabled(button: HTMLButtonElement | null, disabled: boolean): void {
  if (button !== null) button.disabled = disabled;
}

function requireNonEmpty(value: string, label: string): string {
  const checked = requireString(value, label);
  if (checked.length === 0) throw new TypeError(`${label} 不得为空`);
  return checked;
}

function requireString(value: string, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} 必须是字符串`);
  return value;
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("structure edit panel 已销毁");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
