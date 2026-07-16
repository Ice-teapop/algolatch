import type {
  CatalogLearningTemplate,
  LearningCatalog,
  LearningCatalogSnapshot,
  LearningFragmentKind,
  LearningTemplateDefinition,
  RetiredLearningTemplateTombstone,
} from "../learning/index.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import { installCodeTextareaIndentation } from "./code-textarea-keymap.js";

export type BlockLibraryManagerStatus = "ready" | "success" | "error";

export interface BlockSourceValidationResult {
  readonly fragmentKind: LearningFragmentKind;
}

export interface BlockLibraryManagerCallbacks {
  readonly validateSource: (source: string) => BlockSourceValidationResult;
  readonly confirmRetire: (
    message: string,
    template: CatalogLearningTemplate,
  ) => boolean | Promise<boolean>;
  readonly onCatalogChange: (snapshot: LearningCatalogSnapshot) => void;
  readonly idFactory?: () => string;
}

export interface BlockLibraryManager {
  readonly element: HTMLElement;
  refresh(): void;
  setStatus(message: string, status?: BlockLibraryManagerStatus): void;
  destroy(): void;
}

const CUSTOM_TEMPLATE_VERSION = "1.0.0";

type BlockLibraryOperation = "deprecate" | "reactivate" | "retire";

interface BlockLibraryManagerCopy {
  readonly rootAria: string;
  readonly heading: string;
  readonly formAria: string;
  readonly nameAria: string;
  readonly namePlaceholder: string;
  readonly stageAria: string;
  readonly categoryAria: string;
  readonly categoryPlaceholder: string;
  readonly sourceAria: string;
  readonly sourcePlaceholder: string;
  readonly nameLabel: string;
  readonly stageLabel: string;
  readonly categoryLabel: string;
  readonly sourceLabel: string;
  readonly save: string;
  readonly listAria: string;
  readonly activeGroup: string;
  readonly deprecatedGroup: string;
  readonly retiredGroup: string;
  readonly empty: string;
  readonly builtinReadonly: string;
  readonly manage: string;
  readonly retiredNote: string;
  readonly activeLifecycle: string;
  readonly deprecatedLifecycle: string;
  readonly retiredLifecycle: string;
  readonly ready: string;
  readonly missingFields: string;
  readonly retirementCancelled: string;
  readonly invalidFragmentKind: string;
  readonly retirementUnavailable: string;
  readonly operationFailed: string;
  readonly deprecationReason: string;
  readonly retirementReason: string;
  action(operation: BlockLibraryOperation): string;
  confirmRetirement(label: string): string;
  callbackFailed(detail: string): string;
  deprecated(label: string): string;
  reactivated(label: string): string;
  retired(label: string): string;
  created(label: string): string;
  customDescription(label: string): string;
}

const BLOCK_LIBRARY_MANAGER_COPY: Readonly<
  Record<InterfaceLocale, Readonly<BlockLibraryManagerCopy>>
> = Object.freeze({
  "zh-CN": Object.freeze({
    rootAria: "自定义积木管理",
    heading: "积木管理",
    formAria: "新建自定义积木",
    nameAria: "积木名称",
    namePlaceholder: "例如：交换两个变量",
    stageAria: "学习阶段",
    categoryAria: "分类",
    categoryPlaceholder: "例如：array",
    sourceAria: "C 源码片段",
    sourcePlaceholder: "例如：swap(&a, &b);",
    nameLabel: "名称",
    stageLabel: "阶段",
    categoryLabel: "分类",
    sourceLabel: "C 源码",
    save: "保存自定义积木",
    listAria: "积木生命周期列表",
    activeGroup: "启用",
    deprecatedGroup: "已弃用",
    retiredGroup: "已退休",
    empty: "暂无积木。",
    builtinReadonly: "内置 · 只读",
    manage: "管理",
    retiredNote: "定义已移除；已生成 C 源码保持不变。",
    activeLifecycle: "自定义 · 启用",
    deprecatedLifecycle: "自定义 · 已弃用",
    retiredLifecycle: "自定义 · 已退休",
    ready: "目录已就绪。",
    missingFields: "请完整填写名称、阶段、分类和 C 源码。",
    retirementCancelled: "已取消退休操作。",
    invalidFragmentKind: "源码验证器未返回有效 fragmentKind。",
    retirementUnavailable: "该积木已不处于可退休状态，请刷新后重试。",
    operationFailed: "操作失败，请重试。",
    deprecationReason: "由用户在积木管理器中弃用。",
    retirementReason: "由用户在积木管理器中退休。",
    action: (operation: BlockLibraryOperation) => {
      if (operation === "deprecate") return "弃用";
      if (operation === "reactivate") return "恢复";
      return "退休";
    },
    confirmRetirement: (label: string) =>
      `确认退休“${label}”吗？这会移除自定义积木定义，但不会删除已生成 C 源码。`,
    callbackFailed: (detail: string) => `目录已更新，但界面刷新回调失败：${detail}`,
    deprecated: (label: string) => `已弃用“${label}”。`,
    reactivated: (label: string) => `已恢复“${label}”。`,
    retired: (label: string) => `已退休“${label}”；已生成 C 源码保持不变。`,
    created: (label: string) => `已创建“${label}”。`,
    customDescription: (label: string) => `自定义积木：${label}`,
  }),
  en: Object.freeze({
    rootAria: "Custom block management",
    heading: "Block Management",
    formAria: "Create a custom block",
    nameAria: "Block name",
    namePlaceholder: "For example: Swap two variables",
    stageAria: "Learning stage",
    categoryAria: "Category",
    categoryPlaceholder: "For example: array",
    sourceAria: "C source fragment",
    sourcePlaceholder: "For example: swap(&a, &b);",
    nameLabel: "Name",
    stageLabel: "Stage",
    categoryLabel: "Category",
    sourceLabel: "C Source",
    save: "Save Custom Block",
    listAria: "Block lifecycle list",
    activeGroup: "Active",
    deprecatedGroup: "Deprecated",
    retiredGroup: "Retired",
    empty: "No blocks in this state.",
    builtinReadonly: "Built-in · Read-only",
    manage: "Manage",
    retiredNote: "Definition removed; generated C source remains unchanged.",
    activeLifecycle: "Custom · Active",
    deprecatedLifecycle: "Custom · Deprecated",
    retiredLifecycle: "Custom · Retired",
    ready: "Catalog ready.",
    missingFields: "Complete the name, stage, category, and C source fields.",
    retirementCancelled: "Retirement cancelled.",
    invalidFragmentKind: "The source validator returned an invalid fragmentKind.",
    retirementUnavailable: "This block can no longer be retired. Refresh and try again.",
    operationFailed: "The operation failed. Try again.",
    deprecationReason: "Deprecated by the user in Block Management.",
    retirementReason: "Retired by the user in Block Management.",
    action: (operation: BlockLibraryOperation) => {
      if (operation === "deprecate") return "Deprecate";
      if (operation === "reactivate") return "Reactivate";
      return "Retire";
    },
    confirmRetirement: (label: string) =>
      `Retire “${label}”? This removes the custom block definition but keeps generated C source.`,
    callbackFailed: (detail: string) =>
      `Catalog updated, but the interface refresh callback failed: ${detail}`,
    deprecated: (label: string) => `Deprecated “${label}”.`,
    reactivated: (label: string) => `Reactivated “${label}”.`,
    retired: (label: string) => `Retired “${label}”; generated C source remains unchanged.`,
    created: (label: string) => `Created “${label}”.`,
    customDescription: (label: string) => `Custom block: ${label}`,
  }),
});

type ManagerStatusMessage =
  | Readonly<{ readonly kind: "literal"; readonly message: string }>
  | Readonly<{
      readonly kind:
        | "ready"
        | "missingFields"
        | "retirementCancelled"
        | "invalidFragmentKind"
        | "retirementUnavailable"
        | "operationFailed";
    }>
  | Readonly<{
      readonly kind: "callbackFailed";
      readonly detail: string;
    }>
  | Readonly<{
      readonly kind: "deprecated" | "reactivated" | "retired" | "created";
      readonly label: string;
    }>;

export function createBlockLibraryManager(
  host: HTMLElement,
  catalog: LearningCatalog,
  callbacks: BlockLibraryManagerCallbacks,
): BlockLibraryManager {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const localeHost =
    typeof host.closest === "function"
      ? (host.closest<HTMLElement>("[data-locale]") ?? host)
      : host;
  const documentElement = ownerDocument.documentElement;
  let locale = resolveBlockLibraryManagerLocale(
    localeHost.dataset.locale ?? documentElement?.dataset.locale ?? documentElement?.lang,
  );
  const copy = (): Readonly<BlockLibraryManagerCopy> => BLOCK_LIBRARY_MANAGER_COPY[locale];
  const root = ownerDocument.createElement("section");
  root.className = "block-library-manager";

  const heading = ownerDocument.createElement("h2");
  heading.className = "block-library-manager__heading";

  const form = ownerDocument.createElement("form");
  form.className = "block-library-manager__form";
  form.dataset.tourTarget = "block-library-create";

  const labelInput = createTextInput(ownerDocument);
  const stageSelect = ownerDocument.createElement("select");
  stageSelect.className = "block-library-manager__field-control";
  stageSelect.required = true;
  const categoryInput = createTextInput(ownerDocument);
  const sourceInput = ownerDocument.createElement("textarea");
  sourceInput.className = "block-library-manager__source";
  sourceInput.required = true;
  sourceInput.rows = 5;
  const sourceIndentation = installCodeTextareaIndentation(sourceInput);

  const nameField = createField(ownerDocument, labelInput);
  const stageField = createField(ownerDocument, stageSelect);
  const categoryField = createField(ownerDocument, categoryInput);
  const sourceField = createField(ownerDocument, sourceInput);
  form.append(nameField.element, stageField.element, categoryField.element, sourceField.element);

  const saveButton = ownerDocument.createElement("button");
  saveButton.className = "block-library-manager__save";
  saveButton.type = "submit";
  form.append(saveButton);

  const statusOutput = ownerDocument.createElement("output");
  statusOutput.className = "block-library-manager__status";
  statusOutput.setAttribute("role", "status");
  statusOutput.setAttribute("aria-live", "polite");

  const list = ownerDocument.createElement("div");
  list.className = "block-library-manager__list";
  list.dataset.tourTarget = "block-library-lifecycle";

  root.append(heading, form, statusOutput, list);
  host.append(root);

  const idFactory = callbacks.idFactory ?? defaultIdFactory;
  let destroyed = false;
  let busy = false;
  let operationGeneration = 0;
  let actionButtons: HTMLButtonElement[] = [];
  let currentStatus: ManagerStatusMessage = Object.freeze({ kind: "ready" });
  let currentStatusState: BlockLibraryManagerStatus = "ready";

  const renderStatus = (): void => {
    statusOutput.dataset.state = currentStatusState;
    statusOutput.textContent = statusMessage(currentStatus, copy());
  };

  const setStatus = (message: string, status: BlockLibraryManagerStatus = "ready"): void => {
    assertActive(destroyed);
    currentStatus = Object.freeze({ kind: "literal", message });
    currentStatusState = status;
    renderStatus();
  };

  const setGeneratedStatus = (
    message: ManagerStatusMessage,
    status: BlockLibraryManagerStatus = "ready",
  ): void => {
    assertActive(destroyed);
    currentStatus = message;
    currentStatusState = status;
    renderStatus();
  };

  const setBusy = (nextBusy: boolean): void => {
    busy = nextBusy;
    saveButton.disabled = nextBusy;
    for (const button of actionButtons) button.disabled = nextBusy;
  };

  const notifyCatalogChange = (): void => {
    callbacks.onCatalogChange(catalog.snapshot());
  };

  const completeMutation = (message: ManagerStatusMessage): void => {
    render();
    try {
      notifyCatalogChange();
      setGeneratedStatus(message, "success");
    } catch (cause) {
      setGeneratedStatus(
        Object.freeze({ kind: "callbackFailed", detail: localizedError(cause, locale, copy()) }),
        "error",
      );
    }
  };

  const deprecate = (template: CatalogLearningTemplate): void => {
    if (destroyed || busy) return;
    try {
      catalog.deprecateCustom(template.id, { reason: copy().deprecationReason });
      completeMutation(Object.freeze({ kind: "deprecated", label: template.label }));
    } catch (cause) {
      setStatus(localizedError(cause, locale, copy()), "error");
    }
  };

  const reactivate = (template: CatalogLearningTemplate): void => {
    if (destroyed || busy) return;
    try {
      catalog.reactivateCustom(template.id);
      completeMutation(Object.freeze({ kind: "reactivated", label: template.label }));
    } catch (cause) {
      setStatus(localizedError(cause, locale, copy()), "error");
    }
  };

  const retire = async (template: CatalogLearningTemplate): Promise<void> => {
    if (destroyed || busy || template.lifecycle !== "deprecated") return;
    const generation = ++operationGeneration;
    setBusy(true);
    const message = copy().confirmRetirement(template.label);
    try {
      const confirmed = await callbacks.confirmRetire(message, template);
      if (destroyed || generation !== operationGeneration) return;
      setBusy(false);
      if (!confirmed) {
        setGeneratedStatus(Object.freeze({ kind: "retirementCancelled" }), "ready");
        return;
      }
      const current = catalog.getEntry(template.id);
      if (
        current?.kind !== "template" ||
        current.origin !== "custom" ||
        current.lifecycle !== "deprecated"
      ) {
        setGeneratedStatus(Object.freeze({ kind: "retirementUnavailable" }), "error");
        return;
      }
      catalog.retireCustom(template.id, { reason: copy().retirementReason });
      completeMutation(Object.freeze({ kind: "retired", label: template.label }));
    } catch (cause) {
      if (destroyed || generation !== operationGeneration) return;
      setBusy(false);
      setStatus(localizedError(cause, locale, copy()), "error");
    }
  };

  function render(): void {
    assertActive(destroyed);
    const snapshot = catalog.snapshot();
    renderStaticLocale();
    renderStageOptions(stageSelect, snapshot, locale);
    list.replaceChildren();
    actionButtons = [];

    const active = snapshot.templates.filter((template) => template.lifecycle === "active");
    const deprecated = snapshot.templates.filter((template) => template.lifecycle === "deprecated");
    list.append(
      renderGroup(ownerDocument, copy().activeGroup, "active", active, addAction, copy()),
      renderGroup(
        ownerDocument,
        copy().deprecatedGroup,
        "deprecated",
        deprecated,
        addAction,
        copy(),
      ),
      renderGroup(
        ownerDocument,
        copy().retiredGroup,
        "retired",
        snapshot.tombstones,
        addAction,
        copy(),
      ),
    );
    setBusy(busy);
  }

  function renderStaticLocale(): void {
    const value = copy();
    root.dataset.locale = locale;
    root.setAttribute("aria-label", value.rootAria);
    heading.textContent = value.heading;
    form.setAttribute("aria-label", value.formAria);
    labelInput.setAttribute("aria-label", value.nameAria);
    labelInput.placeholder = value.namePlaceholder;
    stageSelect.setAttribute("aria-label", value.stageAria);
    categoryInput.setAttribute("aria-label", value.categoryAria);
    categoryInput.placeholder = value.categoryPlaceholder;
    sourceInput.setAttribute("aria-label", value.sourceAria);
    sourceInput.placeholder = value.sourcePlaceholder;
    nameField.label.textContent = value.nameLabel;
    stageField.label.textContent = value.stageLabel;
    categoryField.label.textContent = value.categoryLabel;
    sourceField.label.textContent = value.sourceLabel;
    saveButton.textContent = value.save;
    list.setAttribute("aria-label", value.listAria);
  }

  function addAction(
    template: CatalogLearningTemplate,
    operation: "deprecate" | "reactivate" | "retire",
  ): HTMLButtonElement {
    const button = ownerDocument.createElement("button");
    button.className = "block-library-manager__action";
    button.type = "button";
    button.dataset.operation = operation;
    button.dataset.entryId = template.id;
    button.textContent = copy().action(operation);
    button.addEventListener("click", () => {
      if (operation === "deprecate") deprecate(template);
      else if (operation === "reactivate") reactivate(template);
      else void retire(template);
    });
    actionButtons.push(button);
    return button;
  }

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (destroyed || busy) return;
    const label = labelInput.value.trim();
    const category = categoryInput.value.trim();
    const stage = stageSelect.value;
    const source = sourceInput.value;
    if (
      label.length === 0 ||
      category.length === 0 ||
      stage.length === 0 ||
      source.trim().length === 0
    ) {
      setGeneratedStatus(Object.freeze({ kind: "missingFields" }), "error");
      return;
    }

    try {
      const validation = callbacks.validateSource(source);
      if (validation?.fragmentKind !== "statement" && validation?.fragmentKind !== "control") {
        setGeneratedStatus(Object.freeze({ kind: "invalidFragmentKind" }), "error");
        return;
      }
      const definition: LearningTemplateDefinition = {
        id: createCustomTemplateId(idFactory()),
        version: CUSTOM_TEMPLATE_VERSION,
        label,
        category,
        stage,
        source,
        description: copy().customDescription(label),
        fragmentKind: validation.fragmentKind,
      };
      const created = catalog.createCustom(definition);
      labelInput.value = "";
      categoryInput.value = "";
      sourceInput.value = "";
      completeMutation(Object.freeze({ kind: "created", label: created.label }));
    } catch (cause) {
      setStatus(localizedError(cause, locale, copy()), "error");
    }
  };

  form.addEventListener("submit", onSubmit);
  const onLocaleChange = (event?: Event): void => {
    if (destroyed) return;
    const eventLocale = (event as CustomEvent<{ readonly locale?: unknown }> | undefined)?.detail
      ?.locale;
    locale = resolveBlockLibraryManagerLocale(
      eventLocale ??
        localeHost.dataset.locale ??
        documentElement?.dataset.locale ??
        documentElement?.lang,
    );
    render();
    renderStatus();
  };
  localeHost.addEventListener("workbench-locale-change", onLocaleChange);
  const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
  const localeObserver =
    MutationObserverConstructor === undefined || documentElement === undefined
      ? null
      : new MutationObserverConstructor(() => onLocaleChange());
  localeObserver?.observe(documentElement, {
    attributes: true,
    attributeFilter: ["data-locale", "lang"],
  });
  render();
  setGeneratedStatus(Object.freeze({ kind: "ready" }), "ready");

  return Object.freeze({
    element: root,
    refresh(): void {
      assertActive(destroyed);
      operationGeneration += 1;
      busy = false;
      render();
    },
    setStatus,
    destroy(): void {
      if (destroyed) return;
      operationGeneration += 1;
      destroyed = true;
      form.removeEventListener("submit", onSubmit);
      localeHost.removeEventListener("workbench-locale-change", onLocaleChange);
      localeObserver?.disconnect();
      sourceIndentation.destroy();
      actionButtons = [];
      root.remove();
    },
  });
}

export function createCustomTemplateId(rawId: string): string {
  if (typeof rawId !== "string") throw new TypeError("idFactory 必须返回字符串");
  const lower = rawId.trim().toLocaleLowerCase("en-US");
  const withoutPrefix = lower.startsWith("custom.") ? lower.slice("custom.".length) : lower;
  const suffix = withoutPrefix
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/[._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (suffix.length === 0) throw new TypeError("idFactory 未生成可用的稳定 id");
  return `custom.${suffix}`;
}

function defaultIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("当前环境不支持 crypto.randomUUID");
  }
  return globalThis.crypto.randomUUID();
}

function createTextInput(ownerDocument: Document): HTMLInputElement {
  const input = ownerDocument.createElement("input");
  input.className = "block-library-manager__field-control";
  input.type = "text";
  input.required = true;
  return input;
}

interface BlockLibraryField {
  readonly element: HTMLLabelElement;
  readonly label: HTMLSpanElement;
}

function createField(
  ownerDocument: Document,
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): BlockLibraryField {
  const field = ownerDocument.createElement("label");
  field.className = "block-library-manager__field";
  const label = ownerDocument.createElement("span");
  label.className = "block-library-manager__field-label";
  field.append(label, control);
  return Object.freeze({ element: field, label });
}

function renderStageOptions(
  select: HTMLSelectElement,
  snapshot: LearningCatalogSnapshot,
  locale: InterfaceLocale,
): void {
  const current = select.value;
  select.replaceChildren();
  for (const stage of snapshot.stages) {
    const option = select.ownerDocument.createElement("option");
    option.value = stage.id;
    option.textContent = localizedStageLabel(stage.id, stage.label, locale);
    select.append(option);
  }
  select.value = snapshot.stages.some((stage) => stage.id === current)
    ? current
    : (snapshot.stages[0]?.id ?? "");
}

type RenderableEntry = CatalogLearningTemplate | RetiredLearningTemplateTombstone;
type ActionFactory = (
  template: CatalogLearningTemplate,
  operation: BlockLibraryOperation,
) => HTMLButtonElement;

function renderGroup(
  ownerDocument: Document,
  label: string,
  lifecycle: "active" | "deprecated" | "retired",
  entries: readonly RenderableEntry[],
  actionFactory: ActionFactory,
  copy: Readonly<BlockLibraryManagerCopy>,
): HTMLElement {
  const group = ownerDocument.createElement("section");
  group.className = "block-library-manager__group";
  group.dataset.lifecycle = lifecycle;
  const heading = ownerDocument.createElement("h3");
  heading.textContent = `${label} · ${entries.length}`;
  group.append(heading);
  if (entries.length === 0) {
    const empty = ownerDocument.createElement("p");
    empty.className = "block-library-manager__empty";
    empty.textContent = copy.empty;
    group.append(empty);
    return group;
  }
  for (const entry of entries) {
    group.append(renderEntry(ownerDocument, entry, actionFactory, copy));
  }
  return group;
}

function renderEntry(
  ownerDocument: Document,
  entry: RenderableEntry,
  actionFactory: ActionFactory,
  copy: Readonly<BlockLibraryManagerCopy>,
): HTMLElement {
  const item = ownerDocument.createElement("article");
  item.className = "block-library-manager__entry";
  item.dataset.libraryEntryId = entry.id;
  item.dataset.origin = entry.origin;
  item.dataset.lifecycle = entry.lifecycle;

  const title = ownerDocument.createElement("strong");
  title.textContent = entry.label;
  const meta = ownerDocument.createElement("span");
  meta.className = "block-library-manager__entry-meta";
  meta.textContent = `${entry.category} · ${entry.stage}`;
  const state = ownerDocument.createElement("span");
  state.className = "block-library-manager__entry-state";
  state.textContent =
    entry.origin === "builtin" ? copy.builtinReadonly : lifecycleLabel(entry.lifecycle, copy);
  item.append(title, meta, state);

  if (entry.kind === "template") {
    const source = ownerDocument.createElement("code");
    source.className = "block-library-manager__entry-source";
    source.textContent = entry.source;
    item.append(source);
    const lifecycleActions =
      entry.origin === "custom" && entry.lifecycle === "active"
        ? [actionFactory(entry, "deprecate")]
        : entry.origin === "custom" && entry.lifecycle === "deprecated"
          ? [actionFactory(entry, "reactivate"), actionFactory(entry, "retire")]
          : [];
    if (lifecycleActions.length > 0) {
      const management = ownerDocument.createElement("details");
      management.className = "block-library-manager__management";
      const summary = ownerDocument.createElement("summary");
      summary.textContent = copy.manage;
      management.append(summary, ...lifecycleActions);
      item.append(management);
    }
  } else {
    const note = ownerDocument.createElement("p");
    note.textContent = copy.retiredNote;
    item.append(note);
  }
  return item;
}

function lifecycleLabel(
  lifecycle: RenderableEntry["lifecycle"],
  copy: Readonly<BlockLibraryManagerCopy>,
): string {
  if (lifecycle === "active") return copy.activeLifecycle;
  if (lifecycle === "deprecated") return copy.deprecatedLifecycle;
  return copy.retiredLifecycle;
}

const ENGLISH_STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "c.basics": "C Basics",
  "c.control-flow": "Control Flow",
  "c.functions-arrays": "Functions and Arrays",
  "algorithms.search": "Search",
  "algorithms.sort": "Sorting",
  "algorithms.recursion": "Recursion",
  "data-structures.linear": "Linear Structures",
  "data-structures.trees": "Trees and Graphs",
  "analysis.correctness-complexity": "Correctness and Complexity",
});

function localizedStageLabel(id: string, fallback: string, locale: InterfaceLocale): string {
  return locale === "en" ? (ENGLISH_STAGE_LABELS[id] ?? fallback) : fallback;
}

function statusMessage(
  message: ManagerStatusMessage,
  copy: Readonly<BlockLibraryManagerCopy>,
): string {
  if (message.kind === "literal") return message.message;
  if (message.kind === "callbackFailed") return copy.callbackFailed(message.detail);
  if (message.kind === "deprecated") return copy.deprecated(message.label);
  if (message.kind === "reactivated") return copy.reactivated(message.label);
  if (message.kind === "retired") return copy.retired(message.label);
  if (message.kind === "created") return copy.created(message.label);
  return copy[message.kind];
}

function localizedError(
  cause: unknown,
  locale: InterfaceLocale,
  copy: Readonly<BlockLibraryManagerCopy>,
): string {
  const message = errorMessage(cause);
  if (locale !== "en" || !/[\u3400-\u9fff]/u.test(message)) return message;
  return copy.operationFailed;
}

function resolveBlockLibraryManagerLocale(value: unknown): InterfaceLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function assertCallbacks(callbacks: BlockLibraryManagerCallbacks): void {
  if (
    typeof callbacks?.validateSource !== "function" ||
    typeof callbacks.confirmRetire !== "function" ||
    typeof callbacks.onCatalogChange !== "function" ||
    (callbacks.idFactory !== undefined && typeof callbacks.idFactory !== "function")
  ) {
    throw new TypeError("积木管理器回调不完整");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("BlockLibraryManager 已销毁");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
