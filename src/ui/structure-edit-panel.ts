import type { InterfaceLocale } from "../shared/interface-locale.js";
import {
  createStructureInsertEditor,
  isValidStructureInsertText,
} from "./structure-insert-editor.js";

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
  readonly insertInput: HTMLTextAreaElement | null;
  readonly insertBefore: HTMLButtonElement | null;
  readonly insertAfter: HTMLButtonElement | null;
  readonly deleteButton: HTMLButtonElement | null;
  readonly movePrevious: HTMLButtonElement | null;
  readonly moveNext: HTMLButtonElement | null;
  readonly renameInput: HTMLInputElement | null;
  readonly renameButton: HTMLButtonElement | null;
}

interface StructureEditCopy {
  readonly ariaLabel: string;
  readonly unavailable: string;
  readonly status: Readonly<
    Record<"idle" | "ready" | "working" | "committed" | "cancelled", string>
  >;
  readonly statementLegend: string;
  readonly insertBefore: string;
  readonly insertBeforeAria: string;
  readonly insertAfter: string;
  readonly insertAfterAria: string;
  readonly movePrevious: string;
  readonly movePreviousAria: string;
  readonly moveNext: string;
  readonly moveNextAria: string;
  readonly delete: string;
  readonly deleteAria: string;
  readonly moreActions: string;
  readonly localVariableLegend: string;
  readonly renameLabel: (name: string) => string;
  readonly renameAria: (name: string) => string;
  readonly renameButton: string;
  readonly renameButtonAria: (name: string) => string;
  readonly renameHint: string;
  readonly statementReasons: Readonly<
    Record<"required-body" | "inline-required-body" | StructureEditBlocker, string>
  >;
  readonly requestErrors: Readonly<
    Record<
      | "no-renamable-local"
      | "invalid-identifier"
      | "same-name"
      | "no-statement"
      | "insert-disabled"
      | "delete-disabled"
      | "no-adjacent-statement",
      string
    >
  >;
}

const STRUCTURE_EDIT_COPY: Readonly<Record<InterfaceLocale, StructureEditCopy>> = Object.freeze({
  "zh-CN": Object.freeze({
    ariaLabel: "结构编辑",
    unavailable: "选择一条语句或局部变量以使用结构操作。",
    status: Object.freeze({
      idle: "当前选择没有可用的结构操作。",
      ready: "结构操作已就绪；提交前会显示精确差异。",
      working: "正在生成精确修改预览…",
      committed: "修改已提交。",
      cancelled: "已取消；源码未发生变化。",
    }),
    statementLegend: "语句结构",
    insertBefore: "上方插入",
    insertBeforeAria: "在当前语句上方插入一行",
    insertAfter: "下方插入",
    insertAfterAria: "在当前语句下方插入一行",
    movePrevious: "上移",
    movePreviousAria: "将当前语句上移，与上一条交换",
    moveNext: "下移",
    moveNextAria: "将当前语句下移，与下一条交换",
    delete: "删除",
    deleteAria: "删除当前语句",
    moreActions: "更多操作",
    localVariableLegend: "局部变量",
    renameLabel: (name: string) => `重命名 ${name}`,
    renameAria: (name: string) => `局部变量 ${name} 的新名称`,
    renameButton: "预览重命名",
    renameButtonAria: (name: string) => `预览局部变量 ${name} 的重命名`,
    renameHint: "使用非关键字、非实现保留名的 ASCII C 标识符。",
    statementReasons: Object.freeze({
      "required-body": "无大括号控制体只允许删除；插入或移动前请先补大括号。",
      "inline-required-body": "行内控制体只允许安全删除；删除后会保留空语句。",
      "multiline-block-comment": "跨行块注释的附着关系不明确，结构操作已停用。",
      "not-line-exclusive": "该语句未独占源码行，结构操作已停用。",
      "parse-recovery": "该语句位于语法恢复区，结构操作已停用。",
      "preprocessor-context": "该语句邻近预处理或续行边界，结构操作已停用。",
    }),
    requestErrors: Object.freeze({
      "no-renamable-local": "当前选择没有可重命名的局部变量",
      "invalid-identifier": "新名称必须是非保留的 ASCII C 标识符",
      "same-name": "新旧名称相同",
      "no-statement": "当前选择没有可编辑语句",
      "insert-disabled": "当前语句不允许在相邻位置插入",
      "delete-disabled": "当前语句不允许删除",
      "no-adjacent-statement": "当前方向没有可交换的相邻语句",
    }),
  }),
  en: Object.freeze({
    ariaLabel: "Structure editing",
    unavailable: "Select a statement or local variable to use structure actions.",
    status: Object.freeze({
      idle: "No structure actions are available for the current selection.",
      ready: "Structure actions are ready. An exact diff will be shown before commit.",
      working: "Preparing an exact edit preview…",
      committed: "Edit committed.",
      cancelled: "Cancelled; source unchanged.",
    }),
    statementLegend: "Statement structure",
    insertBefore: "Insert above",
    insertBeforeAria: "Insert a line above the current statement",
    insertAfter: "Insert below",
    insertAfterAria: "Insert a line below the current statement",
    movePrevious: "Move up",
    movePreviousAria: "Move the current statement up by swapping with the previous statement",
    moveNext: "Move down",
    moveNextAria: "Move the current statement down by swapping with the next statement",
    delete: "Delete",
    deleteAria: "Delete the current statement",
    moreActions: "More actions",
    localVariableLegend: "Local variable",
    renameLabel: (name: string) => `Rename ${name}`,
    renameAria: (name: string) => `New name for local variable ${name}`,
    renameButton: "Preview rename",
    renameButtonAria: (name: string) => `Preview renaming local variable ${name}`,
    renameHint: "Use an ASCII C identifier that is not a keyword or implementation-reserved name.",
    statementReasons: Object.freeze({
      "required-body":
        "A braceless control body can only be deleted. Add braces before inserting or moving.",
      "inline-required-body":
        "An inline control body can only be deleted safely; deletion leaves an empty statement.",
      "multiline-block-comment":
        "The attachment of a multiline block comment is ambiguous, so structure actions are disabled.",
      "not-line-exclusive":
        "This statement does not occupy its own source line, so structure actions are disabled.",
      "parse-recovery":
        "This statement is inside a parse-recovery region, so structure actions are disabled.",
      "preprocessor-context":
        "This statement is next to a preprocessor or line-continuation boundary, so structure actions are disabled.",
    }),
    requestErrors: Object.freeze({
      "no-renamable-local": "The current selection has no local variable that can be renamed",
      "invalid-identifier": "The new name must be a non-reserved ASCII C identifier",
      "same-name": "The old and new names are the same",
      "no-statement": "The current selection has no editable statement",
      "insert-disabled": "A statement cannot be inserted next to the current statement",
      "delete-disabled": "The current statement cannot be deleted",
      "no-adjacent-statement": "There is no adjacent statement to swap in this direction",
    }),
  }),
});

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
  locale: InterfaceLocale = "zh-CN",
): StructureEditAvailability {
  const statement = selection?.statement;
  const localVariable = selection?.localVariable;
  const statementReason =
    statement === undefined ? null : statementUnavailableReason(statement, locale);
  const statementListReady = statement !== undefined && statement.blocker === null;
  const canReorder = statementListReady && statement.parentMode === "statement-list";
  return Object.freeze({
    insert: canReorder && isValidStructureInsertText(insertText),
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
  locale: InterfaceLocale = "zh-CN",
): StructureEditRequest {
  const errors = STRUCTURE_EDIT_COPY[locale].requestErrors;
  const snapshot = copySelection(selection);
  if (intent.kind === "rename") {
    const localVariable = snapshot.localVariable;
    if (localVariable === undefined) throw new TypeError(errors["no-renamable-local"]);
    if (!isValidRenameIdentifier(intent.newName)) {
      throw new TypeError(errors["invalid-identifier"]);
    }
    if (intent.newName === localVariable.name) throw new TypeError(errors["same-name"]);
    return Object.freeze({
      kind: "local-variable-rename",
      baseRevision: snapshot.revision,
      symbolId: localVariable.symbolId,
      expectedOldName: localVariable.name,
      newName: intent.newName,
    });
  }

  const statement = snapshot.statement;
  if (statement === undefined) throw new TypeError(errors["no-statement"]);
  const availability = getStructureEditAvailability(
    snapshot,
    "statementText" in intent ? intent.statementText : "valid();",
    snapshot.localVariable?.name ?? "",
    locale,
  );
  const base = {
    baseRevision: snapshot.revision,
    targetId: statement.id,
    expectedTargetText: statement.text,
  };
  switch (intent.kind) {
    case "insert-before":
    case "insert-after":
      if (!availability.insert) throw new TypeError(errors["insert-disabled"]);
      return Object.freeze({
        ...base,
        kind: "insert-statement",
        position: intent.kind === "insert-before" ? "before" : "after",
        statementText: intent.statementText,
      });
    case "delete":
      if (!availability.delete) throw new TypeError(errors["delete-disabled"]);
      return Object.freeze({ ...base, kind: "delete-statement" });
    case "move-previous":
    case "move-next": {
      const neighbor = intent.kind === "move-previous" ? statement.previous : statement.next;
      const canMove =
        intent.kind === "move-previous" ? availability.movePrevious : availability.moveNext;
      if (!canMove || neighbor === null) throw new TypeError(errors["no-adjacent-statement"]);
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
  const localeHost = resolveLocaleHost(host);
  let locale = resolveStructureEditLocale(
    localeHost.dataset.locale ??
      ownerDocument.documentElement?.dataset.locale ??
      ownerDocument.documentElement?.lang,
  );
  const copy = (): StructureEditCopy => STRUCTURE_EDIT_COPY[locale];
  const root = ownerDocument.createElement("section");
  root.className = "structure-edit-panel";
  root.dataset.locale = locale;
  root.setAttribute("aria-label", copy().ariaLabel);

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
  type StatusState = "idle" | "ready" | "working" | "success" | "error";
  type StatusCopyKey = keyof StructureEditCopy["status"];
  type StatusSource =
    | { readonly kind: "copy"; readonly key: StatusCopyKey }
    | { readonly kind: "selection" }
    | { readonly kind: "literal"; readonly message: string };
  let statusState: StatusState = "idle";
  let statusSource: StatusSource = Object.freeze({ kind: "copy", key: "idle" });

  const renderStatus = (): void => {
    let message: string;
    switch (statusSource.kind) {
      case "copy":
        message = copy().status[statusSource.key];
        break;
      case "selection":
        message =
          (selection?.statement === undefined
            ? null
            : statementUnavailableReason(selection.statement, locale)) ?? copy().status.ready;
        break;
      case "literal":
        message = statusSource.message;
        break;
    }
    root.dataset.state = statusState;
    status.dataset.state = statusState;
    status.textContent = message;
  };

  const setCopyStatus = (state: StatusState, key: StatusCopyKey): void => {
    statusState = state;
    statusSource = Object.freeze({ kind: "copy", key });
    renderStatus();
  };

  const setSelectionStatus = (): void => {
    statusState = "ready";
    statusSource = Object.freeze({ kind: "selection" });
    renderStatus();
  };

  const setLiteralStatus = (state: StatusState, message: string): void => {
    statusState = state;
    statusSource = Object.freeze({ kind: "literal", message });
    renderStatus();
  };

  const updateControls = (): void => {
    const availability = getStructureEditAvailability(
      selection,
      controls.insertInput?.value ?? "",
      controls.renameInput?.value ?? selection?.localVariable?.name ?? "",
      locale,
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
        String(value.length > 0 && !isValidStructureInsertText(value)),
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
      request = buildStructureEditRequest(selection, intent, locale);
    } catch (error: unknown) {
      setLiteralStatus("error", errorMessage(error));
      updateControls();
      return;
    }

    operationBusy = true;
    const operationId = ++operationSequence;
    setCopyStatus("working", "working");
    updateControls();
    const isCurrent = () =>
      !destroyed && operationId === operationSequence && renderedGeneration === selectionGeneration;
    try {
      const result = await runStructureEditWorkflow(request, callbacks, isCurrent);
      if (!isCurrent()) return;
      setCopyStatus(
        result === "committed" ? "success" : "ready",
        result === "committed" ? "committed" : "cancelled",
      );
    } catch (error: unknown) {
      if (isCurrent()) setLiteralStatus("error", errorMessage(error));
    } finally {
      if (isCurrent()) {
        operationBusy = false;
        updateControls();
      }
    }
  };

  const render = (preserveDraft = false, preserveStatus = false): void => {
    const insertDraft = preserveDraft ? controls.insertInput?.value : undefined;
    const renameDraft = preserveDraft ? controls.renameInput?.value : undefined;
    root.dataset.locale = locale;
    root.setAttribute("aria-label", copy().ariaLabel);
    content.replaceChildren();
    controls = emptyControls();
    const current = selection;
    root.hidden =
      current === null || (current.statement === undefined && current.localVariable === undefined);
    if (
      current === null ||
      (current.statement === undefined && current.localVariable === undefined)
    ) {
      content.append(unavailableMessage(ownerDocument, copy()));
      if (preserveStatus) renderStatus();
      else setCopyStatus("idle", "idle");
      return;
    }
    const renderedGeneration = selectionGeneration;
    if (current.statement !== undefined) {
      const statementControls = renderStatementGroup(
        ownerDocument,
        current.statement,
        (intent) => void execute(intent, renderedGeneration),
        updateControls,
        copy(),
        locale,
        insertDraft,
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
        copy(),
        renameDraft,
      );
      controls = mergeControls(controls, renameControls);
      content.append(renameControls.group);
    }
    if (preserveStatus) renderStatus();
    else setSelectionStatus();
    updateControls();
  };

  const onLocaleChange = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    const candidate =
      typeof detail === "object" && detail !== null && "locale" in detail
        ? detail.locale
        : localeHost.dataset.locale;
    locale = resolveStructureEditLocale(candidate);
    render(true, true);
  };
  const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
  const localeObserver =
    MutationObserverConstructor === undefined
      ? null
      : new MutationObserverConstructor(() => {
          locale = resolveStructureEditLocale(localeHost.dataset.locale);
          render(true, true);
        });
  localeHost.addEventListener("workbench-locale-change", onLocaleChange);
  localeObserver?.observe(localeHost, {
    attributes: true,
    attributeFilter: ["data-locale"],
  });
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
      if (typeof localeHost.removeEventListener === "function") {
        localeHost.removeEventListener("workbench-locale-change", onLocaleChange);
      }
      localeObserver?.disconnect();
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
  copy: StructureEditCopy,
  locale: InterfaceLocale,
  draft?: string,
): RenderedControls & { readonly group: HTMLFieldSetElement } {
  const group = ownerDocument.createElement("fieldset");
  group.className = "structure-edit-panel__group";
  const legend = ownerDocument.createElement("legend");
  legend.className = "structure-edit-panel__legend";
  legend.textContent = copy.statementLegend;
  const target = ownerDocument.createElement("code");
  target.className = "structure-edit-panel__target";
  target.textContent = statement.text;
  target.title = statement.text;

  const insertEditor = createStructureInsertEditor(
    ownerDocument,
    locale,
    draft ?? "",
    onDraftChange,
    statementUnavailableReason(statement, locale),
  );
  const insertInput = insertEditor.input;

  const insertActions = actionRow(ownerDocument);
  const insertBefore = actionButton(ownerDocument, copy.insertBefore, copy.insertBeforeAria);
  const insertAfter = actionButton(ownerDocument, copy.insertAfter, copy.insertAfterAria);
  insertBefore.dataset.operation = "insert-before";
  insertAfter.dataset.operation = "insert-after";
  insertActions.append(insertBefore, insertAfter);

  const moveActions = actionRow(ownerDocument);
  const movePrevious = actionButton(ownerDocument, copy.movePrevious, copy.movePreviousAria);
  const moveNext = actionButton(ownerDocument, copy.moveNext, copy.moveNextAria);
  const deleteButton = actionButton(
    ownerDocument,
    copy.delete,
    copy.deleteAria,
    "structure-edit-panel__button--danger",
  );
  movePrevious.dataset.operation = "move-previous";
  moveNext.dataset.operation = "move-next";
  deleteButton.dataset.operation = "delete";
  moveActions.append(movePrevious, moveNext);
  const moreActions = ownerDocument.createElement("details");
  moreActions.className = "structure-edit-panel__more-actions";
  const moreSummary = ownerDocument.createElement("summary");
  moreSummary.textContent = copy.moreActions;
  moreActions.append(moreSummary, deleteButton);

  group.append(
    legend,
    target,
    insertEditor.field,
    insertActions,
    moveActions,
    moreActions,
    insertEditor.hint,
  );
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
  copy: StructureEditCopy,
  draft?: string,
): RenderedControls & { readonly group: HTMLFieldSetElement } {
  const group = ownerDocument.createElement("fieldset");
  group.className = "structure-edit-panel__group";
  const legend = ownerDocument.createElement("legend");
  legend.className = "structure-edit-panel__legend";
  legend.textContent = copy.localVariableLegend;
  const renameLabel = ownerDocument.createElement("label");
  renameLabel.className = "structure-edit-panel__field";
  const renameLabelText = ownerDocument.createElement("span");
  renameLabelText.className = "structure-edit-panel__field-label";
  renameLabelText.textContent = copy.renameLabel(localVariable.name);
  const renameInput = ownerDocument.createElement("input");
  renameInput.className = "structure-edit-panel__input";
  renameInput.type = "text";
  renameInput.value = draft ?? localVariable.name;
  renameInput.autocomplete = "off";
  renameInput.spellcheck = false;
  renameInput.setAttribute("aria-label", copy.renameAria(localVariable.name));
  renameLabel.append(renameLabelText, renameInput);
  const renameButton = actionButton(
    ownerDocument,
    copy.renameButton,
    copy.renameButtonAria(localVariable.name),
  );
  renameButton.dataset.operation = "rename";
  const hint = ownerDocument.createElement("p");
  hint.className = "structure-edit-panel__hint";
  hint.textContent = copy.renameHint;
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

function unavailableMessage(
  ownerDocument: Document,
  copy: StructureEditCopy,
): HTMLParagraphElement {
  const message = ownerDocument.createElement("p");
  message.className = "structure-edit-panel__unavailable";
  message.textContent = copy.unavailable;
  return message;
}

function statementUnavailableReason(
  statement: StructureEditStatementSelection,
  locale: InterfaceLocale = "zh-CN",
): string | null {
  const reasons = STRUCTURE_EDIT_COPY[locale].statementReasons;
  if (statement.parentMode === "required-body" && statement.blocker === null) {
    return reasons["required-body"];
  }
  if (statement.blocker === null) return null;
  if (statement.blocker === "not-line-exclusive" && statement.parentMode === "required-body") {
    return reasons["inline-required-body"];
  }
  return reasons[statement.blocker];
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

export function resolveStructureEditLocale(value: unknown): InterfaceLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function resolveLocaleHost(host: HTMLElement): HTMLElement {
  if (typeof host.closest !== "function") return host;
  return host.closest<HTMLElement>("[data-locale]") ?? host;
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
