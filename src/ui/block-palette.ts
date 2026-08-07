import type {
  CatalogPresetBlock,
  LearningCatalog,
  LearningCatalogSnapshot,
} from "../learning/index.js";
import {
  ENGLISH_BUILTIN_PRESET_PRESENTATIONS,
  presentPresetBlock,
} from "./builtin-preset-presentations.js";

export type LearningStageFilter = "all" | string;
type BlockPaletteLocale = "zh-CN" | "en";

interface BlockPaletteCopy {
  readonly rootAria: string;
  readonly stageLabel: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly listAria: string;
  readonly allStages: string;
  readonly empty: string;
  readonly dragPrefix: string;
  readonly virtualSource: string;
  readonly dragToCanvas: string;
  readonly insertAtSelection: string;
  readonly virtualRole: string;
  readonly sourceRole: string;
  readonly codeBlock: string;
  readonly structureBlock: string;
  readonly runtimeMarker: string;
  dragAria(label: string, virtual: boolean): string;
}

const BLOCK_PALETTE_COPY: Readonly<Record<BlockPaletteLocale, BlockPaletteCopy>> = Object.freeze({
  "zh-CN": Object.freeze({
    rootAria: "可拖拽积木库",
    stageLabel: "学习阶段",
    searchLabel: "筛选积木",
    searchPlaceholder: "筛选积木",
    listAria: "可用积木",
    allStages: "全部阶段",
    empty: "当前筛选下没有可用积木。",
    dragPrefix: "拖拽",
    virtualSource: "虚拟控制节点 · 不改变 C 语义",
    dragToCanvas: "拖到画布",
    insertAtSelection: "插入所选位置",
    virtualRole: "可拖拽虚拟流程节点",
    sourceRole: "可拖拽 C 积木",
    codeBlock: "代码块",
    structureBlock: "结构块",
    runtimeMarker: "运行标记",
    dragAria: (label: string, virtual: boolean) =>
      virtual ? `${label}，可拖到自由画布，不生成 C 源码` : `${label}，可拖到组装插槽或自由画布`,
  }),
  en: Object.freeze({
    rootAria: "Draggable block library",
    stageLabel: "Learning stage",
    searchLabel: "Filter blocks",
    searchPlaceholder: "Filter blocks",
    listAria: "Available blocks",
    allStages: "All stages",
    empty: "No blocks match the current filters.",
    dragPrefix: "Drag",
    virtualSource: "Virtual control node · Does not change C semantics",
    dragToCanvas: "Drag to Canvas",
    insertAtSelection: "Insert at Selection",
    virtualRole: "draggable virtual flow node",
    sourceRole: "draggable C block",
    codeBlock: "Code Block",
    structureBlock: "Structure Block",
    runtimeMarker: "Runtime Marker",
    dragAria: (label: string, virtual: boolean) =>
      virtual
        ? `${label}, drag to the free canvas; does not generate C source`
        : `${label}, drag to an assembly slot or the free canvas`,
  }),
});
export interface BlockPaletteCompatibilityFilter {
  readonly direction: "input" | "output";
  readonly channel: "control" | "data";
  /** Optional exact placement gate supplied by the source-authoritative assembly planner. */
  readonly presetIds?: readonly string[] | undefined;
}
export type BlockPaletteCategory =
  | "all"
  | "search"
  | "flow-c-basics"
  | "data-memory"
  | "recent-favorites"
  | "flow-control"
  | "c-basics"
  | "functions-io"
  | "arrays-strings"
  | "pointers-memory"
  | "data-structures"
  | "algorithm-patterns"
  | "testing-analysis"
  | "custom-lifecycle";

export interface BlockPaletteCallbacks {
  readonly onTemplateDragStart: (templateId: string) => void;
  readonly onTemplateDragEnd: () => void;
  readonly onInsertSelected: (templateId: string) => void;
}

export interface BlockPalette {
  readonly element: HTMLElement;
  refresh(): void;
  setStage(stageId: LearningStageFilter): void;
  getStage(): LearningStageFilter;
  setCategory(category: BlockPaletteCategory): void;
  getCategory(): BlockPaletteCategory;
  setInsertEnabled(enabled: boolean): void;
  setCompatibilityFilter(filter: BlockPaletteCompatibilityFilter | null): void;
  focusSearch(): void;
  revealPreset(presetId: string): void;
  destroy(): void;
}

export function filterLearningTemplates(
  snapshot: LearningCatalogSnapshot,
  stageId: LearningStageFilter,
  query: string,
  category: BlockPaletteCategory = "all",
  compatibility: BlockPaletteCompatibilityFilter | null = null,
): readonly CatalogPresetBlock[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return Object.freeze(
    snapshot.presets.filter((template) => {
      if (template.lifecycle !== "active") return false;
      if (stageId !== "all" && template.stage !== stageId) return false;
      if (!matchesCategory(template, category)) return false;
      if (
        compatibility !== null &&
        !template.ports.some(
          (port) =>
            port.direction === compatibility.direction && port.channel === compatibility.channel,
        )
      ) {
        return false;
      }
      if (
        compatibility?.presetIds !== undefined &&
        !compatibility.presetIds.includes(template.id)
      ) {
        return false;
      }
      if (normalizedQuery.length === 0) return true;
      const englishPresentation =
        template.origin === "builtin"
          ? ENGLISH_BUILTIN_PRESET_PRESENTATIONS[template.id]
          : undefined;
      return [
        template.id,
        template.label,
        template.description,
        englishPresentation?.label ?? "",
        englishPresentation?.description ?? "",
        template.category,
        template.stage,
        template.source ?? "",
      ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    }),
  );
}

export function createBlockPalette(
  host: HTMLElement,
  catalog: LearningCatalog,
  callbacks: BlockPaletteCallbacks,
): BlockPalette {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const localeHost =
    typeof host.closest === "function"
      ? (host.closest<HTMLElement>("[data-locale]") ?? host)
      : host;
  const documentElement = ownerDocument.documentElement;
  let locale = resolveBlockPaletteLocale(
    localeHost.dataset.locale ?? documentElement?.dataset.locale ?? documentElement?.lang,
  );
  const copy = (): BlockPaletteCopy => BLOCK_PALETTE_COPY[locale];
  const root = ownerDocument.createElement("section");
  root.className = "block-palette";

  const filters = ownerDocument.createElement("div");
  filters.className = "block-palette__filters";
  const stageLabel = ownerDocument.createElement("label");
  stageLabel.className = "visually-hidden";
  const stageSelect = ownerDocument.createElement("select");
  stageSelect.className = "block-palette__select";
  stageLabel.htmlFor = "block-palette-stage";
  stageSelect.id = "block-palette-stage";
  const search = ownerDocument.createElement("input");
  search.className = "block-palette__search";
  search.type = "search";
  filters.append(stageLabel, stageSelect, search);

  const list = ownerDocument.createElement("div");
  list.className = "block-palette__list";
  list.setAttribute("role", "list");
  root.append(filters, list);
  host.append(root);

  let destroyed = false;
  let stageId: LearningStageFilter = "all";
  let category: BlockPaletteCategory = "all";
  let insertEnabled = false;
  let compatibility: BlockPaletteCompatibilityFilter | null = null;
  let visibleTemplates = new Map<string, CatalogPresetBlock>();
  let activeDragSurface: HTMLElement | null = null;

  const renderStaticLocale = (): void => {
    const value = copy();
    root.setAttribute("aria-label", value.rootAria);
    stageLabel.textContent = value.stageLabel;
    stageSelect.setAttribute("aria-label", value.stageLabel);
    search.placeholder = value.searchPlaceholder;
    search.setAttribute("aria-label", value.searchLabel);
    list.setAttribute("aria-label", value.listAria);
  };

  const finishActiveDrag = (): void => {
    if (activeDragSurface === null) return;
    activeDragSurface.classList.remove("is-dragging");
    activeDragSurface = null;
    callbacks.onTemplateDragEnd();
  };

  const render = (): void => {
    assertActive(destroyed);
    finishActiveDrag();
    const snapshot = catalog.snapshot();
    renderStaticLocale();
    renderStageOptions(stageSelect, snapshot, stageId, copy(), locale);
    const templates = filterLearningTemplates(
      snapshot,
      stageId,
      search.value,
      category,
      compatibility,
    );
    root.dataset.category = category;
    root.dataset.compatibility =
      compatibility === null ? "all" : `${compatibility.channel}-${compatibility.direction}`;
    visibleTemplates = new Map(templates.map((template) => [template.id, template]));
    list.replaceChildren();
    if (templates.length === 0) {
      const empty = ownerDocument.createElement("p");
      empty.className = "block-palette__empty";
      empty.textContent = copy().empty;
      list.append(empty);
      return;
    }
    for (const template of templates) {
      list.append(renderTemplateRow(ownerDocument, template, insertEnabled, copy(), locale));
    }
  };

  const onStageChange = (): void => {
    stageId = stageSelect.value;
    category = "all";
    render();
  };
  const onSearchInput = (): void => render();
  const onDragStart = (event: DragEvent): void => {
    const dragSurface = templateDragSurfaceForEvent(event);
    if (dragSurface === null) {
      event.preventDefault();
      return;
    }
    const template = visibleTemplates.get(dragSurface.dataset.templateId ?? "");
    if (template === undefined || template.lifecycle !== "active") {
      event.preventDefault();
      return;
    }
    finishActiveDrag();
    activeDragSurface = dragSurface;
    dragSurface.classList.add("is-dragging");
    callbacks.onTemplateDragStart(template.id);
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", "c-block-catalog-item");
      event.dataTransfer.setData("application/x-c-block-preset", template.id);
    }
  };
  const onDragEnd = (): void => finishActiveDrag();
  const onClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "button[data-template-action='insert']",
    );
    if (button === null || button === undefined || button.disabled) return;
    const templateId = button.dataset.templateId;
    if (templateId !== undefined && visibleTemplates.has(templateId)) {
      callbacks.onInsertSelected(templateId);
    }
  };

  stageSelect.addEventListener("change", onStageChange);
  search.addEventListener("input", onSearchInput);
  list.addEventListener("dragstart", onDragStart);
  list.addEventListener("dragend", onDragEnd);
  list.addEventListener("click", onClick);
  const onLocaleChange = (event?: Event): void => {
    if (destroyed) return;
    const eventLocale = (event as CustomEvent<{ readonly locale?: unknown }> | undefined)?.detail
      ?.locale;
    locale = resolveBlockPaletteLocale(
      eventLocale ??
        localeHost.dataset.locale ??
        documentElement?.dataset.locale ??
        documentElement?.lang,
    );
    render();
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

  return Object.freeze({
    element: root,
    refresh: render,
    setStage(nextStageId: LearningStageFilter): void {
      assertActive(destroyed);
      const snapshot = catalog.snapshot();
      if (nextStageId !== "all" && !snapshot.stages.some((stage) => stage.id === nextStageId)) {
        throw new RangeError(`未知学习阶段：${nextStageId}`);
      }
      stageId = nextStageId;
      render();
    },
    getStage: () => stageId,
    setCategory(nextCategory: BlockPaletteCategory): void {
      assertActive(destroyed);
      if (!BLOCK_PALETTE_CATEGORIES.has(nextCategory)) {
        throw new RangeError(`未知预设分类：${nextCategory}`);
      }
      category = nextCategory;
      stageId = "all";
      compatibility = null;
      render();
    },
    getCategory: () => category,
    setInsertEnabled(enabled: boolean): void {
      assertActive(destroyed);
      if (typeof enabled !== "boolean") throw new TypeError("enabled 必须是布尔值");
      insertEnabled = enabled;
      for (const button of list.querySelectorAll<HTMLButtonElement>(
        "button[data-template-action='insert']",
      )) {
        button.disabled = !enabled;
      }
    },
    setCompatibilityFilter(filter: BlockPaletteCompatibilityFilter | null): void {
      assertActive(destroyed);
      if (
        filter !== null &&
        ((filter.direction !== "input" && filter.direction !== "output") ||
          (filter.channel !== "control" && filter.channel !== "data"))
      ) {
        throw new TypeError("积木兼容筛选无效");
      }
      compatibility = filter === null ? null : Object.freeze({ ...filter });
      category = "search";
      stageId = "all";
      search.value = "";
      render();
    },
    focusSearch(): void {
      assertActive(destroyed);
      search.focus({ preventScroll: true });
      search.select();
    },
    revealPreset(presetId: string): void {
      assertActive(destroyed);
      const preset = catalog.getPreset(presetId);
      if (preset === null || preset.lifecycle !== "active") {
        throw new RangeError(`未知或不可用的预设积木：${presetId}`);
      }
      compatibility = null;
      category = "search";
      stageId = "all";
      search.value = preset.id;
      render();
      const target = [...list.querySelectorAll<HTMLElement>("[data-template-id]")].find(
        (element) => element.dataset.templateId === preset.id && element.tabIndex >= 0,
      );
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (activeDragSurface === null) callbacks.onTemplateDragEnd();
      else finishActiveDrag();
      stageSelect.removeEventListener("change", onStageChange);
      search.removeEventListener("input", onSearchInput);
      list.removeEventListener("dragstart", onDragStart);
      list.removeEventListener("dragend", onDragEnd);
      list.removeEventListener("click", onClick);
      localeHost.removeEventListener("workbench-locale-change", onLocaleChange);
      localeObserver?.disconnect();
      root.remove();
      visibleTemplates.clear();
    },
  });
}

const BLOCK_PALETTE_CATEGORIES = new Set<BlockPaletteCategory>([
  "all",
  "search",
  "flow-c-basics",
  "data-memory",
  "recent-favorites",
  "flow-control",
  "c-basics",
  "functions-io",
  "arrays-strings",
  "pointers-memory",
  "data-structures",
  "algorithm-patterns",
  "testing-analysis",
  "custom-lifecycle",
]);

function matchesCategory(template: CatalogPresetBlock, category: BlockPaletteCategory): boolean {
  if (category === "all" || category === "search" || category === "recent-favorites") return true;
  if (category === "custom-lifecycle") return template.origin === "custom";
  if (category === "flow-c-basics") {
    return (
      [
        "flow-control",
        "control",
        "c-basics",
        "declaration",
        "assignment",
        "functions-io",
        "function-call",
        "function-control",
        "io",
      ].includes(template.category) || template.blockKind === "virtual"
    );
  }
  if (category === "data-memory") {
    return [
      "arrays-strings",
      "array",
      "pointers-memory",
      "data-structures",
      "linear-structure",
      "tree",
    ].includes(template.category);
  }
  const groups: Readonly<
    Record<
      Exclude<
        BlockPaletteCategory,
        "all" | "search" | "flow-c-basics" | "data-memory" | "recent-favorites" | "custom-lifecycle"
      >,
      readonly string[]
    >
  > = {
    "flow-control": ["flow-control", "control"],
    "c-basics": ["c-basics", "declaration", "assignment"],
    "functions-io": ["functions-io", "function-call", "function-control", "io"],
    "arrays-strings": ["arrays-strings", "array"],
    "pointers-memory": ["pointers-memory"],
    "data-structures": ["data-structures", "linear-structure", "tree"],
    "algorithm-patterns": ["algorithm-patterns", "search", "sort", "recursion", "complexity"],
    "testing-analysis": ["testing-analysis", "correctness", "complexity"],
  };
  return (
    groups[category].includes(template.category) ||
    (category === "flow-control" && template.blockKind === "virtual")
  );
}

function renderStageOptions(
  select: HTMLSelectElement,
  snapshot: LearningCatalogSnapshot,
  selected: LearningStageFilter,
  copy: BlockPaletteCopy,
  locale: BlockPaletteLocale,
): void {
  const ownerDocument = select.ownerDocument;
  select.replaceChildren();
  const all = ownerDocument.createElement("option");
  all.value = "all";
  all.textContent = copy.allStages;
  select.append(all);
  for (const stage of snapshot.stages) {
    const option = ownerDocument.createElement("option");
    option.value = stage.id;
    option.textContent = stageLabel(stage.id, stage.label, locale);
    select.append(option);
  }
  select.value = selected;
}

function renderTemplateRow(
  ownerDocument: Document,
  template: CatalogPresetBlock,
  insertEnabled: boolean,
  copy: BlockPaletteCopy,
  locale: BlockPaletteLocale,
): HTMLElement {
  const visualKind = template.fragmentKind ?? "virtual";
  const presentation = presentPresetBlock(template, locale);
  const row = ownerDocument.createElement("article");
  row.className = "block-palette__item";
  row.dataset.templateId = template.id;
  row.dataset.category = template.category;
  row.dataset.fragmentKind = visualKind;
  row.dataset.blockKind = template.blockKind;
  row.dataset.blockRole = presetRole(template);
  row.dataset.stage = template.stage;
  row.setAttribute("role", "listitem");

  const dragSurface = ownerDocument.createElement("div");
  dragSurface.className = `block-palette__drag-surface block-palette__drag-surface--${visualKind}`;
  dragSurface.dataset.templateId = template.id;
  dragSurface.dataset.category = template.category;
  dragSurface.dataset.fragmentKind = visualKind;
  dragSurface.dataset.blockKind = template.blockKind;
  dragSurface.dataset.blockRole = presetRole(template);
  dragSurface.dataset.stage = template.stage;
  dragSurface.draggable = true;
  dragSurface.tabIndex = 0;
  dragSurface.setAttribute(
    "aria-label",
    copy.dragAria(presentation.label, template.source === null),
  );
  dragSurface.setAttribute(
    "aria-roledescription",
    template.source === null ? copy.virtualRole : copy.sourceRole,
  );

  const heading = ownerDocument.createElement("div");
  heading.className = "block-palette__item-heading";
  const label = ownerDocument.createElement("strong");
  label.textContent = presentation.label;
  const category = ownerDocument.createElement("span");
  category.textContent = `${presetRoleLabel(template, copy)} · ${syntaxPlacementSummary(template, locale)}`;
  category.title = `${categoryLabel(template.category, locale)} · ${presentation.description}`;
  heading.append(label, category);
  const source = ownerDocument.createElement("code");
  source.className = "block-palette__source";
  source.textContent =
    template.source === null ? copy.virtualSource : compactSource(template.source);
  const description = ownerDocument.createElement("p");
  description.className = "block-palette__description";
  description.textContent = presentation.description;
  const insert = ownerDocument.createElement("button");
  insert.className = "block-palette__insert";
  insert.type = "button";
  insert.dataset.templateAction = "insert";
  insert.dataset.templateId = template.id;
  insert.textContent = template.source === null ? copy.dragToCanvas : copy.insertAtSelection;
  insert.disabled = template.source === null || !insertEnabled;
  dragSurface.append(heading, source);
  row.append(dragSurface, description, insert);
  return row;
}

function presetRole(template: CatalogPresetBlock): "code" | "structure" | "runtime-marker" {
  if (template.blockKind === "virtual") return "runtime-marker";
  return template.blockKind === "control" ? "structure" : "code";
}

function presetRoleLabel(template: CatalogPresetBlock, copy: BlockPaletteCopy): string {
  const role = presetRole(template);
  if (role === "runtime-marker") return copy.runtimeMarker;
  return role === "structure" ? copy.structureBlock : copy.codeBlock;
}

function syntaxPlacementSummary(template: CatalogPresetBlock, locale: BlockPaletteLocale): string {
  if (template.source === null) return locale === "en" ? "Canvas only" : "仅画布";
  if (template.placement.providedSyntaxSlots.length > 0) {
    const branchCount = template.placement.providedSyntaxSlots.length;
    return locale === "en"
      ? `${String(branchCount)} child ${branchCount === 1 ? "slot" : "slots"}`
      : `提供 ${String(branchCount)} 个子插槽`;
  }
  const accepted = new Set(template.placement.acceptedSyntaxSlots);
  if (accepted.size === 1 && accepted.has("loop-body")) {
    return locale === "en" ? "Loop body" : "仅循环体";
  }
  if (accepted.size === 2 && accepted.has("loop-body") && accepted.has("switch-case")) {
    return locale === "en" ? "Loop / switch" : "循环 / switch";
  }
  return locale === "en" ? "C statement slot" : "C 语句插槽";
}

function compactSource(source: string): string {
  const compact = source.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69)}…`;
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

const CATEGORY_LABELS: Readonly<Record<BlockPaletteLocale, Readonly<Record<string, string>>>> =
  Object.freeze({
    "zh-CN": Object.freeze({
      "flow-control": "控制流",
      control: "控制流",
      "c-basics": "C 基础",
      declaration: "声明",
      assignment: "赋值",
      "functions-io": "函数与 I/O",
      "function-call": "函数调用",
      "function-control": "函数控制",
      io: "输入输出",
      "arrays-strings": "数组与字符串",
      array: "数组",
      "pointers-memory": "指针与内存",
      "data-structures": "数据结构",
      "linear-structure": "线性结构",
      tree: "树",
      "algorithm-patterns": "算法模式",
      search: "搜索",
      sort: "排序",
      recursion: "递归",
      complexity: "复杂度",
      "testing-analysis": "测试与分析",
      correctness: "正确性",
      custom: "自定义",
    }),
    en: Object.freeze({
      "flow-control": "Flow Control",
      control: "Flow Control",
      "c-basics": "C Basics",
      declaration: "Declarations",
      assignment: "Assignments",
      "functions-io": "Functions and I/O",
      "function-call": "Function Calls",
      "function-control": "Function Control",
      io: "Input and Output",
      "arrays-strings": "Arrays and Strings",
      array: "Arrays",
      "pointers-memory": "Pointers and Memory",
      "data-structures": "Data Structures",
      "linear-structure": "Linear Structures",
      tree: "Trees",
      "algorithm-patterns": "Algorithm Patterns",
      search: "Search",
      sort: "Sorting",
      recursion: "Recursion",
      complexity: "Complexity",
      "testing-analysis": "Testing and Analysis",
      correctness: "Correctness",
      custom: "Custom",
    }),
  });

function stageLabel(id: string, fallback: string, locale: BlockPaletteLocale): string {
  return locale === "en" ? (ENGLISH_STAGE_LABELS[id] ?? fallback) : fallback;
}

function categoryLabel(category: string, locale: BlockPaletteLocale): string {
  return CATEGORY_LABELS[locale][category] ?? category;
}

function resolveBlockPaletteLocale(value: unknown): BlockPaletteLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function templateDragSurfaceForEvent(event: Event): HTMLElement | null {
  return (
    (event.target as Element | null)?.closest<HTMLElement>(
      ".block-palette__drag-surface[data-template-id][draggable='true']",
    ) ?? null
  );
}

function assertCallbacks(callbacks: BlockPaletteCallbacks): void {
  if (
    typeof callbacks?.onTemplateDragStart !== "function" ||
    typeof callbacks.onTemplateDragEnd !== "function" ||
    typeof callbacks.onInsertSelected !== "function"
  ) {
    throw new TypeError("积木库回调不完整");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("BlockPalette 已销毁");
}
