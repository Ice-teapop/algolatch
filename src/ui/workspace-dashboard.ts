import type {
  WorkspaceEntrySummary,
  WorkspaceKind,
  WorkspaceSnapshot,
} from "../shared/workspace.js";

export type WorkspaceDashboardFilter = "recent" | WorkspaceKind;
export type WorkspaceDashboardStatus = "ready" | "loading" | "success" | "error";

export interface WorkspaceDashboardCallbacks {
  readonly onCreate: (kind: WorkspaceKind, title: string) => boolean | Promise<boolean>;
  readonly onOpen: (entryId: string) => void | Promise<void>;
  readonly onRefresh: () => void | Promise<void>;
}

export interface WorkspaceDashboard {
  readonly element: HTMLElement;
  readonly filter: WorkspaceDashboardFilter;
  setSnapshot(snapshot: WorkspaceSnapshot): void;
  setBusy(busy: boolean): void;
  setStatus(message: string, status?: WorkspaceDashboardStatus): void;
  openCreate(kind?: WorkspaceKind): void;
  destroy(): void;
}

const FILTERS: readonly {
  readonly id: WorkspaceDashboardFilter;
  readonly label: string;
}[] = Object.freeze([
  Object.freeze({ id: "recent", label: "最近" }),
  Object.freeze({ id: "project", label: "项目" }),
  Object.freeze({ id: "sandbox", label: "沙箱" }),
  Object.freeze({ id: "test", label: "测试" }),
]);

const KIND_LABELS: Readonly<Record<WorkspaceKind, string>> = Object.freeze({
  project: "项目",
  sandbox: "沙箱",
  test: "测试",
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
  root.setAttribute("aria-label", "本地工作区 Dashboard");

  const sidebar = ownerDocument.createElement("nav");
  sidebar.className = "workspace-dashboard__sidebar";
  sidebar.setAttribute("aria-label", "工作区模块");
  sidebar.dataset.tourTarget = "dashboard-modules";
  const filterButtons = new Map<WorkspaceDashboardFilter, HTMLButtonElement>();
  for (const filter of FILTERS) {
    const button = ownerDocument.createElement("button");
    button.className = "workspace-dashboard__filter";
    button.type = "button";
    button.dataset.dashboardFilter = filter.id;
    button.dataset.tourTarget = filter.id === "recent" ? "dashboard-recent" : filter.id;
    button.textContent = filter.label;
    button.setAttribute("aria-label", filter.label);
    sidebar.append(button);
    filterButtons.set(filter.id, button);
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
  rootName.textContent = "正在读取…";
  location.append(locationLabel, ownerDocument.createTextNode(" / "), rootName);

  const search = ownerDocument.createElement("input");
  search.className = "workspace-dashboard__search";
  search.type = "search";
  search.placeholder = "筛选名称";
  search.setAttribute("aria-label", "筛选工作区条目");

  const refreshButton = textButton(ownerDocument, "刷新", "button button--quiet");
  const createButton = textButton(ownerDocument, "新建", "button button--primary");
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
  caption.textContent = "本地工作区条目";
  const head = ownerDocument.createElement("thead");
  const headingRow = ownerDocument.createElement("tr");
  for (const heading of ["名称", "类型", "修改时间", "同步"]) {
    const cell = ownerDocument.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headingRow.append(cell);
  }
  head.append(headingRow);
  const body = ownerDocument.createElement("tbody");
  table.append(caption, head, body);

  const empty = ownerDocument.createElement("div");
  empty.className = "workspace-dashboard__empty";
  empty.hidden = true;
  const emptyCopy = ownerDocument.createElement("p");
  const emptyCreate = textButton(ownerDocument, "新建第一个条目", "button button--primary");
  empty.append(emptyCopy, emptyCreate);
  tableRegion.append(table, empty);
  content.append(toolbar, status, tableRegion);
  root.append(sidebar, content);
  host.append(root);

  const dialog = createNewEntryDialog(ownerDocument);
  host.append(dialog.element);

  let snapshot: WorkspaceSnapshot = Object.freeze({ rootName: "", entries: Object.freeze([]) });
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
      ...entries.map((entry) => renderEntryRow(ownerDocument, entry, openEntry)),
    );
    const isEmpty = entries.length === 0;
    table.hidden = isEmpty;
    empty.hidden = !isEmpty;
    emptyCopy.textContent =
      snapshot.entries.length === 0 ? "这里还没有本地条目。" : "当前筛选没有匹配条目。";
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
  const onRefresh = (): void => {
    void runOperation(callbacks.onRefresh);
  };
  const onSearch = (): void => render();
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (busy) return;
    const kind = dialog.kind.value;
    if (!isWorkspaceKind(kind)) {
      dialog.error.textContent = "请选择有效类型。";
      return;
    }
    const title = dialog.title.value.trim();
    if (title.length === 0) {
      dialog.error.textContent = "请输入名称。";
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
  refreshButton.addEventListener("click", onRefresh);
  search.addEventListener("input", onSearch);
  dialog.form.addEventListener("submit", onSubmit);
  dialog.cancel.addEventListener("click", onDialogCancel);
  dialog.element.addEventListener("close", onDialogClose);
  root.addEventListener("keydown", onKeydown);
  render();
  setStatus("正在读取 Documents 工作区…", "loading");

  return Object.freeze({
    element: root,
    get filter(): WorkspaceDashboardFilter {
      return filter;
    },
    setSnapshot(nextSnapshot: WorkspaceSnapshot): void {
      assertActive(destroyed);
      snapshot = copySnapshot(nextSnapshot);
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
      refreshButton.removeEventListener("click", onRefresh);
      search.removeEventListener("input", onSearch);
      dialog.form.removeEventListener("submit", onSubmit);
      dialog.cancel.removeEventListener("click", onDialogCancel);
      dialog.element.removeEventListener("close", onDialogClose);
      root.removeEventListener("keydown", onKeydown);
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
): HTMLTableRowElement {
  const row = ownerDocument.createElement("tr");
  row.dataset.entryId = entry.id;
  row.dataset.entryKind = entry.kind;
  const nameCell = ownerDocument.createElement("td");
  const openButton = textButton(ownerDocument, entry.title, "workspace-dashboard__open");
  openButton.dataset.entryId = entry.id;
  openButton.addEventListener("click", () => onOpen(entry.id), { once: true });
  nameCell.append(openButton);
  const kindCell = ownerDocument.createElement("td");
  kindCell.textContent = KIND_LABELS[entry.kind];
  const timeCell = ownerDocument.createElement("td");
  const time = ownerDocument.createElement("time");
  time.dateTime = entry.updatedAt;
  time.textContent = formatModifiedTime(entry.updatedAt);
  timeCell.append(time);
  const syncCell = ownerDocument.createElement("td");
  syncCell.textContent = "已保存";
  syncCell.dataset.state = "saved";
  row.append(nameCell, kindCell, timeCell, syncCell);
  return row;
}

function formatModifiedTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function createNewEntryDialog(ownerDocument: Document): {
  readonly element: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly kind: HTMLSelectElement;
  readonly title: HTMLInputElement;
  readonly submit: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly error: HTMLElement;
} {
  const element = ownerDocument.createElement("dialog");
  element.className = "workspace-create-dialog";
  element.setAttribute("aria-labelledby", "workspace-create-title");
  const form = ownerDocument.createElement("form");
  form.className = "workspace-create-dialog__surface";
  const heading = ownerDocument.createElement("h2");
  heading.id = "workspace-create-title";
  heading.textContent = "新建工作区条目";
  const kind = ownerDocument.createElement("select");
  kind.setAttribute("aria-label", "条目类型");
  for (const workspaceKind of WORKSPACE_KINDS_IN_UI_ORDER) {
    const option = ownerDocument.createElement("option");
    option.value = workspaceKind;
    option.textContent = KIND_LABELS[workspaceKind];
    kind.append(option);
  }
  const title = ownerDocument.createElement("input");
  title.type = "text";
  title.maxLength = 80;
  title.required = true;
  title.placeholder = "例如：二分搜索";
  title.setAttribute("aria-label", "条目名称");
  const error = ownerDocument.createElement("p");
  error.className = "form-error";
  error.setAttribute("role", "alert");
  const actions = ownerDocument.createElement("footer");
  actions.className = "workspace-create-dialog__actions";
  const cancel = textButton(ownerDocument, "取消", "button button--quiet");
  const submit = textButton(ownerDocument, "创建并打开", "button button--primary");
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(
    heading,
    field(ownerDocument, "类型", kind),
    field(ownerDocument, "名称", title),
    error,
    actions,
  );
  element.append(form);
  return { element, form, kind, title, submit, cancel, error };
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
  for (const name of ["onCreate", "onOpen", "onRefresh"] as const) {
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
