import type {
  WorkspaceEntrySummary,
  WorkspaceKind,
  WorkspaceSnapshot,
} from "../shared/workspace.js";
import type { InterfaceLocale } from "./interface-preferences.js";

export type WorkspaceDashboardFilter = "recent" | WorkspaceKind;
export type WorkspaceDashboardStatus = "ready" | "loading" | "success" | "error";

export interface WorkspaceDashboardCallbacks {
  readonly onCreate: (kind: WorkspaceKind, title: string) => boolean | Promise<boolean>;
  readonly onCreateSample: () => boolean | Promise<boolean>;
  readonly onOpen: (entryId: string) => void | Promise<void>;
  readonly onRefresh: () => void | Promise<void>;
}

export interface WorkspaceDashboard {
  readonly element: HTMLElement;
  readonly filter: WorkspaceDashboardFilter;
  setSnapshot(snapshot: WorkspaceSnapshot): void;
  setSnapshotUnconfirmed(): void;
  setBusy(busy: boolean): void;
  setStatus(message: string, status?: WorkspaceDashboardStatus): void;
  openCreate(kind?: WorkspaceKind): void;
  destroy(): void;
}

const FILTERS: readonly WorkspaceDashboardFilter[] = Object.freeze([
  "recent",
  "project",
  "sandbox",
  "test",
]);

const COPY = Object.freeze({
  "zh-CN": Object.freeze({
    dashboardLabel: "本地工作区 Dashboard",
    modulesLabel: "工作区模块",
    filters: Object.freeze({ recent: "最近", project: "项目", sandbox: "沙箱", test: "测试" }),
    kinds: Object.freeze({ project: "项目", sandbox: "沙箱", test: "测试" }),
    reading: "正在读取…",
    searchPlaceholder: "筛选名称",
    searchLabel: "筛选工作区条目",
    refresh: "刷新",
    create: "新建",
    tableCaption: "本地工作区条目",
    headings: Object.freeze(["名称", "类型", "修改时间", "同步"]),
    createFirst: "新建第一个条目",
    createSample: "打开插入排序示例",
    emptyAll: "这里还没有本地条目。",
    emptyFilter: "当前筛选没有匹配条目。",
    initialStatus: "正在读取 Documents 工作区…",
    open: "打开",
    saved: "已保存",
    invalidKind: "请选择有效类型。",
    missingTitle: "请输入名称。",
    dialogTitle: "新建工作区条目",
    kindLabel: "条目类型",
    titlePlaceholder: "例如：二分搜索",
    titleLabel: "条目名称",
    type: "类型",
    name: "名称",
    cancel: "取消",
    createAndOpen: "创建并打开",
  }),
  en: Object.freeze({
    dashboardLabel: "Local Workspace Dashboard",
    modulesLabel: "Workspace Sections",
    filters: Object.freeze({
      recent: "Recent",
      project: "Projects",
      sandbox: "Sandboxes",
      test: "Tests",
    }),
    kinds: Object.freeze({ project: "Project", sandbox: "Sandbox", test: "Test" }),
    reading: "Loading…",
    searchPlaceholder: "Filter by name",
    searchLabel: "Filter workspace entries",
    refresh: "Refresh",
    create: "New",
    tableCaption: "Local workspace entries",
    headings: Object.freeze(["Name", "Type", "Modified", "Sync"]),
    createFirst: "Create your first entry",
    createSample: "Open insertion-sort example",
    emptyAll: "No local entries yet.",
    emptyFilter: "No entries match this filter.",
    initialStatus: "Reading the Documents workspace…",
    open: "Open",
    saved: "Saved",
    invalidKind: "Choose a valid type.",
    missingTitle: "Enter a name.",
    dialogTitle: "New Workspace Entry",
    kindLabel: "Entry type",
    titlePlaceholder: "For example: Binary Search",
    titleLabel: "Entry name",
    type: "Type",
    name: "Name",
    cancel: "Cancel",
    createAndOpen: "Create and Open",
  }),
});

export function createWorkspaceDashboard(
  host: HTMLElement,
  callbacks: WorkspaceDashboardCallbacks,
): WorkspaceDashboard {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const root = ownerDocument.createElement("section");
  root.className = "workspace-dashboard";
  root.dataset.tourTarget = "dashboard-content";
  const localeHost = host.closest?.<HTMLElement>("[data-locale]") ?? null;
  let locale: InterfaceLocale = localeHost?.dataset.locale === "en" ? "en" : "zh-CN";
  const copy = () => COPY[locale];
  root.setAttribute("aria-label", copy().dashboardLabel);

  const sidebar = ownerDocument.createElement("nav");
  sidebar.className = "workspace-dashboard__sidebar";
  sidebar.setAttribute("aria-label", copy().modulesLabel);
  sidebar.dataset.tourTarget = "dashboard-modules";
  const filterButtons = new Map<WorkspaceDashboardFilter, HTMLButtonElement>();
  for (const filter of FILTERS) {
    const button = ownerDocument.createElement("button");
    button.className = "workspace-dashboard__filter";
    button.type = "button";
    button.dataset.dashboardFilter = filter;
    button.dataset.tourTarget = filter === "recent" ? "dashboard-recent" : filter;
    button.textContent = copy().filters[filter];
    button.setAttribute("aria-label", copy().filters[filter]);
    sidebar.append(button);
    filterButtons.set(filter, button);
  }

  const content = ownerDocument.createElement("section");
  content.className = "workspace-dashboard__content";
  const toolbar = ownerDocument.createElement("header");
  toolbar.className = "workspace-dashboard__toolbar";
  const location = ownerDocument.createElement("div");
  location.className = "workspace-dashboard__location";
  const locationLabel = ownerDocument.createElement("span");
  locationLabel.textContent = "Documents";
  const rootName = ownerDocument.createElement("strong");
  rootName.textContent = copy().reading;
  location.append(locationLabel, ownerDocument.createTextNode(" / "), rootName);

  const search = ownerDocument.createElement("input");
  search.className = "workspace-dashboard__search";
  search.type = "search";
  search.placeholder = copy().searchPlaceholder;
  search.setAttribute("aria-label", copy().searchLabel);

  const refreshButton = textButton(ownerDocument, copy().refresh, "button button--quiet");
  const createButton = textButton(ownerDocument, copy().create, "button button--primary");
  createButton.dataset.tourTarget = "create-entry";
  toolbar.append(location, search, refreshButton, createButton);

  const status = ownerDocument.createElement("output");
  status.className = "workspace-dashboard__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const tableRegion = ownerDocument.createElement("div");
  tableRegion.className = "workspace-dashboard__table-region";
  tableRegion.dataset.tourTarget = "entry-list";
  const table = ownerDocument.createElement("table");
  table.className = "workspace-dashboard__table";
  const caption = ownerDocument.createElement("caption");
  caption.className = "visually-hidden";
  caption.textContent = copy().tableCaption;
  const head = ownerDocument.createElement("thead");
  const headingRow = ownerDocument.createElement("tr");
  const headingCells: HTMLTableCellElement[] = [];
  for (const heading of copy().headings) {
    const cell = ownerDocument.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headingRow.append(cell);
    headingCells.push(cell);
  }
  head.append(headingRow);
  const body = ownerDocument.createElement("tbody");
  table.append(caption, head, body);

  const empty = ownerDocument.createElement("div");
  empty.className = "workspace-dashboard__empty";
  empty.hidden = true;
  const emptyCopy = ownerDocument.createElement("p");
  const emptyCreate = textButton(ownerDocument, copy().createFirst, "button button--primary");
  const emptySample = textButton(ownerDocument, copy().createSample, "button button--quiet");
  empty.append(emptyCopy, emptyCreate, emptySample);
  tableRegion.append(table, empty);
  content.append(toolbar, status, tableRegion);
  root.append(sidebar, content);
  host.append(root);

  const dialog = createNewEntryDialog(ownerDocument, locale);
  host.append(dialog.element);

  let snapshot: WorkspaceSnapshot = Object.freeze({ rootName: "", entries: Object.freeze([]) });
  let snapshotConfirmed = false;
  let filter: WorkspaceDashboardFilter = "recent";
  let busy = false;
  let destroyed = false;
  let operation = 0;

  const setStatus = (message: string, state: WorkspaceDashboardStatus = "ready"): void => {
    assertActive(destroyed);
    if (typeof message !== "string" || !isStatus(state)) {
      throw new TypeError("Dashboard 状态必须提供字符串与合法 state");
    }
    status.textContent = message;
    status.dataset.state = state;
  };

  const setBusy = (nextBusy: boolean): void => {
    assertActive(destroyed);
    if (typeof nextBusy !== "boolean") throw new TypeError("busy 必须是布尔值");
    busy = nextBusy;
    createButton.disabled = nextBusy;
    refreshButton.disabled = nextBusy;
    emptyCreate.disabled = nextBusy;
    emptySample.disabled = nextBusy;
    dialog.submit.disabled = nextBusy;
    root.setAttribute("aria-busy", String(nextBusy));
  };

  const render = (): void => {
    assertActive(destroyed);
    rootName.textContent =
      snapshot.rootName.length === 0 ? "C Algorithm Workbench" : snapshot.rootName;
    for (const [id, button] of filterButtons) {
      const selected = id === filter;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
      const count =
        id === "recent"
          ? snapshot.entries.length
          : snapshot.entries.filter((entry) => entry.kind === id).length;
      button.dataset.count = String(count);
    }
    const entries = filterWorkspaceEntries(snapshot.entries, filter, search.value);
    body.replaceChildren(
      ...entries.map((entry) => renderEntryRow(ownerDocument, entry, openEntry, locale)),
    );
    const isEmpty = entries.length === 0;
    table.hidden = isEmpty;
    empty.hidden = !isEmpty;
    emptyCopy.textContent = snapshot.entries.length === 0 ? copy().emptyAll : copy().emptyFilter;
    emptySample.hidden = !snapshotConfirmed || snapshot.entries.length !== 0;
  };

  const renderLocale = (): void => {
    const localized = copy();
    root.setAttribute("aria-label", localized.dashboardLabel);
    sidebar.setAttribute("aria-label", localized.modulesLabel);
    for (const [id, button] of filterButtons) {
      button.textContent = localized.filters[id];
      button.setAttribute("aria-label", localized.filters[id]);
    }
    if (rootName.textContent === "正在读取…" || rootName.textContent === "Loading…") {
      rootName.textContent = localized.reading;
    }
    search.placeholder = localized.searchPlaceholder;
    search.setAttribute("aria-label", localized.searchLabel);
    refreshButton.textContent = localized.refresh;
    createButton.textContent = localized.create;
    caption.textContent = localized.tableCaption;
    localized.headings.forEach((heading, index) => {
      const cell = headingCells[index];
      if (cell !== undefined) cell.textContent = heading;
    });
    emptyCreate.textContent = localized.createFirst;
    emptySample.textContent = localized.createSample;
    dialog.setLocale(locale);
    render();
  };

  async function runOperation(operationCallback: () => void | Promise<void>): Promise<void> {
    if (destroyed || busy) return;
    const currentOperation = ++operation;
    setBusy(true);
    try {
      await operationCallback();
    } finally {
      if (!destroyed && currentOperation === operation) setBusy(false);
    }
  }

  function openEntry(entryId: string): void {
    void runOperation(() => callbacks.onOpen(entryId));
  }

  const selectFilter = (nextFilter: WorkspaceDashboardFilter): void => {
    if (destroyed || filter === nextFilter) return;
    filter = nextFilter;
    render();
  };
  const filterListeners = new Map<HTMLButtonElement, () => void>();
  for (const [id, button] of filterButtons) {
    const listener = (): void => selectFilter(id);
    filterListeners.set(button, listener);
    button.addEventListener("click", listener);
  }

  const openCreate = (kind: WorkspaceKind = filter === "recent" ? "project" : filter): void => {
    assertActive(destroyed);
    dialog.kind.value = kind;
    dialog.title.value = "";
    if (!dialog.element.open) dialog.element.showModal();
    dialog.title.focus();
  };
  const onCreateClick = (): void => openCreate();
  const onEmptyCreate = (): void => openCreate();
  const onCreateSample = (): void => {
    void runOperation(async () => {
      await callbacks.onCreateSample();
    });
  };
  const onRefresh = (): void => {
    void runOperation(callbacks.onRefresh);
  };
  const onSearch = (): void => render();
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (busy) return;
    const kind = dialog.kind.value;
    if (!isWorkspaceKind(kind)) {
      dialog.error.textContent = copy().invalidKind;
      return;
    }
    const title = dialog.title.value.trim();
    if (title.length === 0) {
      dialog.error.textContent = copy().missingTitle;
      dialog.title.focus();
      return;
    }
    dialog.error.textContent = "";
    void runOperation(async () => {
      const created = await callbacks.onCreate(kind, title);
      if (created && !destroyed && dialog.element.open) dialog.element.close("created");
    });
  };
  const onDialogCancel = (): void => dialog.element.close("cancel");
  const onDialogClose = (): void => {
    dialog.error.textContent = "";
    createButton.focus();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "n") {
      event.preventDefault();
      openCreate();
    }
  };

  createButton.addEventListener("click", onCreateClick);
  emptyCreate.addEventListener("click", onEmptyCreate);
  emptySample.addEventListener("click", onCreateSample);
  refreshButton.addEventListener("click", onRefresh);
  search.addEventListener("input", onSearch);
  dialog.form.addEventListener("submit", onSubmit);
  dialog.cancel.addEventListener("click", onDialogCancel);
  dialog.element.addEventListener("close", onDialogClose);
  root.addEventListener("keydown", onKeydown);
  const onLocaleChange = (event: Event): void => {
    const detail = (event as CustomEvent<{ readonly locale?: unknown }>).detail;
    locale = detail?.locale === "en" ? "en" : "zh-CN";
    renderLocale();
  };
  localeHost?.addEventListener("workbench-locale-change", onLocaleChange);
  render();
  setStatus(copy().initialStatus, "loading");

  return Object.freeze({
    element: root,
    get filter(): WorkspaceDashboardFilter {
      return filter;
    },
    setSnapshot(nextSnapshot: WorkspaceSnapshot): void {
      assertActive(destroyed);
      snapshot = copySnapshot(nextSnapshot);
      snapshotConfirmed = true;
      render();
    },
    setSnapshotUnconfirmed(): void {
      assertActive(destroyed);
      snapshotConfirmed = false;
      render();
    },
    setBusy,
    setStatus,
    openCreate,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      operation += 1;
      for (const [button, listener] of filterListeners) {
        button.removeEventListener("click", listener);
      }
      createButton.removeEventListener("click", onCreateClick);
      emptyCreate.removeEventListener("click", onEmptyCreate);
      emptySample.removeEventListener("click", onCreateSample);
      refreshButton.removeEventListener("click", onRefresh);
      search.removeEventListener("input", onSearch);
      dialog.form.removeEventListener("submit", onSubmit);
      dialog.cancel.removeEventListener("click", onDialogCancel);
      dialog.element.removeEventListener("close", onDialogClose);
      root.removeEventListener("keydown", onKeydown);
      localeHost?.removeEventListener("workbench-locale-change", onLocaleChange);
      if (dialog.element.open) dialog.element.close("destroyed");
      dialog.element.remove();
      root.remove();
    },
  });
}

export function filterWorkspaceEntries(
  entries: readonly WorkspaceEntrySummary[],
  filter: WorkspaceDashboardFilter,
  search: string,
): readonly WorkspaceEntrySummary[] {
  const query = search.trim().toLocaleLowerCase("zh-Hans-CN");
  return entries.filter(
    (entry) =>
      (filter === "recent" || entry.kind === filter) &&
      (query.length === 0 || entry.title.toLocaleLowerCase("zh-Hans-CN").includes(query)),
  );
}

function renderEntryRow(
  ownerDocument: Document,
  entry: WorkspaceEntrySummary,
  onOpen: (entryId: string) => void,
  locale: InterfaceLocale,
): HTMLTableRowElement {
  const copy = COPY[locale];
  const row = ownerDocument.createElement("tr");
  row.dataset.entryId = entry.id;
  row.dataset.entryKind = entry.kind;
  row.className = "workspace-dashboard__entry";
  row.tabIndex = 0;
  row.setAttribute("role", "link");
  row.setAttribute("aria-label", `${copy.open} ${copy.kinds[entry.kind]} “${entry.title}”`);
  const open = (): void => onOpen(entry.id);
  row.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    open();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    open();
  });
  const nameCell = ownerDocument.createElement("td");
  const name = ownerDocument.createElement("strong");
  name.className = "workspace-dashboard__entry-name";
  name.textContent = entry.title;
  nameCell.append(name);
  const kindCell = ownerDocument.createElement("td");
  kindCell.textContent = copy.kinds[entry.kind];
  const timeCell = ownerDocument.createElement("td");
  const time = ownerDocument.createElement("time");
  time.dateTime = entry.updatedAt;
  time.textContent = formatModifiedTime(entry.updatedAt, locale);
  timeCell.append(time);
  const syncCell = ownerDocument.createElement("td");
  syncCell.textContent = copy.saved;
  syncCell.dataset.state = "saved";
  row.append(nameCell, kindCell, timeCell, syncCell);
  return row;
}

function formatModifiedTime(timestamp: string, locale: InterfaceLocale): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat(locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function createNewEntryDialog(
  ownerDocument: Document,
  initialLocale: InterfaceLocale,
): {
  readonly element: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly kind: HTMLSelectElement;
  readonly title: HTMLInputElement;
  readonly submit: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly error: HTMLElement;
  readonly setLocale: (locale: InterfaceLocale) => void;
} {
  let locale = initialLocale;
  const copy = () => COPY[locale];
  const element = ownerDocument.createElement("dialog");
  element.className = "workspace-create-dialog";
  element.setAttribute("aria-labelledby", "workspace-create-title");
  const form = ownerDocument.createElement("form");
  form.className = "workspace-create-dialog__surface";
  const heading = ownerDocument.createElement("h2");
  heading.id = "workspace-create-title";
  heading.textContent = copy().dialogTitle;
  const kind = ownerDocument.createElement("select");
  kind.setAttribute("aria-label", copy().kindLabel);
  for (const workspaceKind of WORKSPACE_KINDS_IN_UI_ORDER) {
    const option = ownerDocument.createElement("option");
    option.value = workspaceKind;
    option.textContent = copy().kinds[workspaceKind];
    kind.append(option);
  }
  const title = ownerDocument.createElement("input");
  title.type = "text";
  title.maxLength = 80;
  title.required = true;
  title.placeholder = copy().titlePlaceholder;
  title.setAttribute("aria-label", copy().titleLabel);
  const error = ownerDocument.createElement("p");
  error.className = "form-error";
  error.setAttribute("role", "alert");
  const actions = ownerDocument.createElement("footer");
  actions.className = "workspace-create-dialog__actions";
  const cancel = textButton(ownerDocument, copy().cancel, "button button--quiet");
  const submit = textButton(ownerDocument, copy().createAndOpen, "button button--primary");
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(
    heading,
    field(ownerDocument, copy().type, kind),
    field(ownerDocument, copy().name, title),
    error,
    actions,
  );
  element.append(form);
  const [typeField, nameField] = [...form.querySelectorAll<HTMLLabelElement>("label")];
  return {
    element,
    form,
    kind,
    title,
    submit,
    cancel,
    error,
    setLocale(nextLocale: InterfaceLocale): void {
      locale = nextLocale;
      const localized = copy();
      heading.textContent = localized.dialogTitle;
      kind.setAttribute("aria-label", localized.kindLabel);
      [...kind.options].forEach((option) => {
        const workspaceKind = option.value as WorkspaceKind;
        if (workspaceKind in localized.kinds) option.textContent = localized.kinds[workspaceKind];
      });
      title.placeholder = localized.titlePlaceholder;
      title.setAttribute("aria-label", localized.titleLabel);
      typeField?.querySelector("span")?.replaceChildren(localized.type);
      nameField?.querySelector("span")?.replaceChildren(localized.name);
      cancel.textContent = localized.cancel;
      submit.textContent = localized.createAndOpen;
    },
  };
}

const WORKSPACE_KINDS_IN_UI_ORDER = Object.freeze(["project", "sandbox", "test"] as const);

function field(
  ownerDocument: Document,
  label: string,
  control: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const root = ownerDocument.createElement("label");
  const text = ownerDocument.createElement("span");
  text.textContent = label;
  root.append(text, control);
  return root;
}

function textButton(ownerDocument: Document, label: string, className: string): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  return button;
}

function copySnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  if (snapshot === null || typeof snapshot !== "object" || typeof snapshot.rootName !== "string") {
    throw new TypeError("Dashboard snapshot 无效");
  }
  return Object.freeze({
    rootName: snapshot.rootName,
    entries: Object.freeze(snapshot.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

function assertCallbacks(callbacks: WorkspaceDashboardCallbacks): void {
  for (const name of ["onCreate", "onCreateSample", "onOpen", "onRefresh"] as const) {
    if (typeof callbacks[name] !== "function") {
      throw new TypeError(`Dashboard callbacks.${name} 必须是函数`);
    }
  }
}

function isWorkspaceKind(value: string): value is WorkspaceKind {
  return WORKSPACE_KINDS_IN_UI_ORDER.some((kind) => kind === value);
}

function isStatus(value: string): value is WorkspaceDashboardStatus {
  return value === "ready" || value === "loading" || value === "success" || value === "error";
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("Dashboard 已销毁");
}
