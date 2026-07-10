import type {
  CatalogLearningTemplate,
  LearningCatalog,
  LearningCatalogSnapshot,
  LearningFragmentKind,
  LearningTemplateDefinition,
  RetiredLearningTemplateTombstone,
} from "../learning/index.js";

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
const DEPRECATION_REASON = "由用户在积木管理器中弃用。";
const RETIREMENT_REASON = "由用户在积木管理器中退休。";

export function createBlockLibraryManager(
  host: HTMLElement,
  catalog: LearningCatalog,
  callbacks: BlockLibraryManagerCallbacks,
): BlockLibraryManager {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const root = ownerDocument.createElement("section");
  root.className = "block-library-manager";
  root.setAttribute("aria-label", "自定义积木管理");

  const heading = ownerDocument.createElement("h2");
  heading.className = "block-library-manager__heading";
  heading.textContent = "积木管理";

  const form = ownerDocument.createElement("form");
  form.className = "block-library-manager__form";
  form.setAttribute("aria-label", "新建自定义积木");
  form.dataset.tourTarget = "block-library-create";

  const labelInput = createTextInput(ownerDocument, "积木名称", "例如：交换两个变量");
  const stageSelect = ownerDocument.createElement("select");
  stageSelect.className = "block-library-manager__field-control";
  stageSelect.setAttribute("aria-label", "学习阶段");
  stageSelect.required = true;
  const categoryInput = createTextInput(ownerDocument, "分类", "例如：array");
  const sourceInput = ownerDocument.createElement("textarea");
  sourceInput.className = "block-library-manager__source";
  sourceInput.setAttribute("aria-label", "C 源码片段");
  sourceInput.placeholder = "例如：swap(&a, &b);";
  sourceInput.required = true;
  sourceInput.rows = 5;

  form.append(
    createField(ownerDocument, "名称", labelInput),
    createField(ownerDocument, "阶段", stageSelect),
    createField(ownerDocument, "分类", categoryInput),
    createField(ownerDocument, "C 源码", sourceInput),
  );

  const saveButton = ownerDocument.createElement("button");
  saveButton.className = "block-library-manager__save";
  saveButton.type = "submit";
  saveButton.textContent = "保存自定义积木";
  form.append(saveButton);

  const statusOutput = ownerDocument.createElement("output");
  statusOutput.className = "block-library-manager__status";
  statusOutput.setAttribute("role", "status");
  statusOutput.setAttribute("aria-live", "polite");

  const list = ownerDocument.createElement("div");
  list.className = "block-library-manager__list";
  list.setAttribute("aria-label", "积木生命周期列表");
  list.dataset.tourTarget = "block-library-lifecycle";

  root.append(heading, form, statusOutput, list);
  host.append(root);

  const idFactory = callbacks.idFactory ?? defaultIdFactory;
  let destroyed = false;
  let busy = false;
  let operationGeneration = 0;
  let actionButtons: HTMLButtonElement[] = [];

  const setStatus = (message: string, status: BlockLibraryManagerStatus = "ready"): void => {
    assertActive(destroyed);
    statusOutput.dataset.state = status;
    statusOutput.textContent = message;
  };

  const setBusy = (nextBusy: boolean): void => {
    busy = nextBusy;
    saveButton.disabled = nextBusy;
    for (const button of actionButtons) button.disabled = nextBusy;
  };

  const notifyCatalogChange = (): void => {
    callbacks.onCatalogChange(catalog.snapshot());
  };

  const completeMutation = (message: string): void => {
    render();
    try {
      notifyCatalogChange();
      setStatus(message, "success");
    } catch (cause) {
      setStatus(`目录已更新，但界面刷新回调失败：${errorMessage(cause)}`, "error");
    }
  };

  const deprecate = (template: CatalogLearningTemplate): void => {
    if (destroyed || busy) return;
    try {
      catalog.deprecateCustom(template.id, { reason: DEPRECATION_REASON });
      completeMutation(`已弃用“${template.label}”。`);
    } catch (cause) {
      setStatus(errorMessage(cause), "error");
    }
  };

  const reactivate = (template: CatalogLearningTemplate): void => {
    if (destroyed || busy) return;
    try {
      catalog.reactivateCustom(template.id);
      completeMutation(`已恢复“${template.label}”。`);
    } catch (cause) {
      setStatus(errorMessage(cause), "error");
    }
  };

  const retire = async (template: CatalogLearningTemplate): Promise<void> => {
    if (destroyed || busy || template.lifecycle !== "deprecated") return;
    const generation = ++operationGeneration;
    setBusy(true);
    const message = `确认退休“${template.label}”吗？这会移除自定义积木定义，但不会删除已生成 C 源码。`;
    try {
      const confirmed = await callbacks.confirmRetire(message, template);
      if (destroyed || generation !== operationGeneration) return;
      setBusy(false);
      if (!confirmed) {
        setStatus("已取消退休操作。", "ready");
        return;
      }
      const current = catalog.getEntry(template.id);
      if (
        current?.kind !== "template" ||
        current.origin !== "custom" ||
        current.lifecycle !== "deprecated"
      ) {
        throw new Error("该积木已不处于可退休状态，请刷新后重试");
      }
      catalog.retireCustom(template.id, { reason: RETIREMENT_REASON });
      completeMutation(`已退休“${template.label}”；已生成 C 源码保持不变。`);
    } catch (cause) {
      if (destroyed || generation !== operationGeneration) return;
      setBusy(false);
      setStatus(errorMessage(cause), "error");
    }
  };

  function render(): void {
    assertActive(destroyed);
    const snapshot = catalog.snapshot();
    renderStageOptions(stageSelect, snapshot);
    list.replaceChildren();
    actionButtons = [];

    const active = snapshot.templates.filter((template) => template.lifecycle === "active");
    const deprecated = snapshot.templates.filter((template) => template.lifecycle === "deprecated");
    list.append(
      renderGroup(ownerDocument, "启用", "active", active, addAction),
      renderGroup(ownerDocument, "已弃用", "deprecated", deprecated, addAction),
      renderGroup(ownerDocument, "已退休", "retired", snapshot.tombstones, addAction),
    );
    setBusy(busy);
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
    button.textContent = actionLabel(operation);
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
      setStatus("请完整填写名称、阶段、分类和 C 源码。", "error");
      return;
    }

    try {
      const validation = callbacks.validateSource(source);
      if (validation?.fragmentKind !== "statement" && validation?.fragmentKind !== "control") {
        throw new TypeError("源码验证器未返回有效 fragmentKind");
      }
      const definition: LearningTemplateDefinition = {
        id: createCustomTemplateId(idFactory()),
        version: CUSTOM_TEMPLATE_VERSION,
        label,
        category,
        stage,
        source,
        description: `自定义积木：${label}`,
        fragmentKind: validation.fragmentKind,
      };
      const created = catalog.createCustom(definition);
      labelInput.value = "";
      categoryInput.value = "";
      sourceInput.value = "";
      completeMutation(`已创建“${created.label}”。`);
    } catch (cause) {
      setStatus(errorMessage(cause), "error");
    }
  };

  form.addEventListener("submit", onSubmit);
  render();
  setStatus("目录已就绪。", "ready");

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

function createTextInput(
  ownerDocument: Document,
  ariaLabel: string,
  placeholder: string,
): HTMLInputElement {
  const input = ownerDocument.createElement("input");
  input.className = "block-library-manager__field-control";
  input.type = "text";
  input.setAttribute("aria-label", ariaLabel);
  input.placeholder = placeholder;
  input.required = true;
  return input;
}

function createField(
  ownerDocument: Document,
  labelText: string,
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): HTMLLabelElement {
  const field = ownerDocument.createElement("label");
  field.className = "block-library-manager__field";
  const label = ownerDocument.createElement("span");
  label.className = "block-library-manager__field-label";
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function renderStageOptions(select: HTMLSelectElement, snapshot: LearningCatalogSnapshot): void {
  const current = select.value;
  select.replaceChildren();
  for (const stage of snapshot.stages) {
    const option = select.ownerDocument.createElement("option");
    option.value = stage.id;
    option.textContent = stage.label;
    select.append(option);
  }
  select.value = snapshot.stages.some((stage) => stage.id === current)
    ? current
    : (snapshot.stages[0]?.id ?? "");
}

type RenderableEntry = CatalogLearningTemplate | RetiredLearningTemplateTombstone;
type ActionFactory = (
  template: CatalogLearningTemplate,
  operation: "deprecate" | "reactivate" | "retire",
) => HTMLButtonElement;

function renderGroup(
  ownerDocument: Document,
  label: string,
  lifecycle: "active" | "deprecated" | "retired",
  entries: readonly RenderableEntry[],
  actionFactory: ActionFactory,
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
    empty.textContent = "暂无积木。";
    group.append(empty);
    return group;
  }
  for (const entry of entries) group.append(renderEntry(ownerDocument, entry, actionFactory));
  return group;
}

function renderEntry(
  ownerDocument: Document,
  entry: RenderableEntry,
  actionFactory: ActionFactory,
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
  state.textContent = entry.origin === "builtin" ? "内置 · 只读" : lifecycleLabel(entry.lifecycle);
  item.append(title, meta, state);

  if (entry.kind === "template") {
    const source = ownerDocument.createElement("code");
    source.className = "block-library-manager__entry-source";
    source.textContent = entry.source;
    item.append(source);
    if (entry.origin === "custom" && entry.lifecycle === "active") {
      item.append(actionFactory(entry, "deprecate"));
    } else if (entry.origin === "custom" && entry.lifecycle === "deprecated") {
      item.append(actionFactory(entry, "reactivate"), actionFactory(entry, "retire"));
    }
  } else {
    const note = ownerDocument.createElement("p");
    note.textContent = "定义已移除；已生成 C 源码保持不变。";
    item.append(note);
  }
  return item;
}

function lifecycleLabel(lifecycle: RenderableEntry["lifecycle"]): string {
  if (lifecycle === "active") return "自定义 · 启用";
  if (lifecycle === "deprecated") return "自定义 · 已弃用";
  return "自定义 · 已退休";
}

function actionLabel(operation: "deprecate" | "reactivate" | "retire"): string {
  if (operation === "deprecate") return "弃用";
  if (operation === "reactivate") return "恢复";
  return "退休";
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
