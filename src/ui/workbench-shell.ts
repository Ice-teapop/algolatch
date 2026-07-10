import type {
  RegisteredDockGroup,
  RegisteredInspectorView,
  RegisteredWorkbenchPage,
  WorkbenchRegistrySnapshot,
} from "../workbench/contracts.js";

export interface WorkbenchElements {
  readonly shell: HTMLElement;
  readonly openButton: HTMLButtonElement;
  readonly pasteButton: HTMLButtonElement;
  readonly themeButton: HTMLButtonElement;
  readonly fileName: HTMLElement;
  readonly sourceMeta: HTMLElement;
  readonly parserStatus: HTMLOutputElement;
  readonly importStatus: HTMLOutputElement;
  readonly blockPalette: HTMLElement;
  readonly blockTree: HTMLElement;
  readonly codePane: HTMLElement;
  readonly dropOverlay: HTMLElement;
  readonly pasteDialog: HTMLDialogElement;
  readonly pasteSource: HTMLTextAreaElement;
  readonly pasteError: HTMLElement;
  readonly pasteConfirm: HTMLButtonElement;
  readonly pasteCancel: HTMLButtonElement;
  readonly currentPage: string;
  readonly showPage: (pageId: string) => void;
  readonly getPageHost: (pageId: string) => HTMLElement;
  /** Compatibility alias for the explanation/edit/run pages. */
  readonly showInspector: (viewId: string) => void;
  /** Compatibility alias for the explanation/edit/run page hosts. */
  readonly getInspectorHost: (viewId: string) => HTMLElement;
  readonly destroy: () => void;
}

interface MountedPage {
  readonly pageId: string;
  readonly tab: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly host: HTMLElement;
}

interface NavigationModel {
  readonly groups: readonly RegisteredDockGroup[];
  readonly pages: readonly RegisteredWorkbenchPage[];
  readonly inspectorViews: readonly RegisteredInspectorView[];
}

export function mountWorkbench(
  app: HTMLElement,
  registrySnapshot: WorkbenchRegistrySnapshot,
): WorkbenchElements {
  const navigation = validateNavigation(registrySnapshot);
  const ownerDocument = app.ownerDocument;

  app.innerHTML = `
    <div id="workbench-shell" class="workbench-shell">
      <header class="app-bar">
        <div class="brand app-navigation" aria-labelledby="app-title">
          <h1 id="app-title">C 积木算法面板</h1>
          <nav id="workbench-dock" class="dock-bar" role="tablist" aria-label="工作台页面"></nav>
        </div>
        <div class="document-identity" aria-label="当前文档">
          <span id="file-name">正在准备示例…</span>
        </div>
        <nav class="app-actions" aria-label="工作台操作">
          <button id="open-source" class="button button--quiet" type="button" disabled>
            打开 C 文件
          </button>
          <button id="open-paste" class="button button--quiet" type="button" disabled>
            粘贴源码
          </button>
          <button id="theme-toggle" class="icon-button" type="button" aria-label="切换界面主题">◐</button>
        </nav>
      </header>

      <main id="workbench-pages" class="workbench-pages" aria-label="C 算法工作台">
        <section
          id="build-panel"
          class="workbench workbench-page workbench-page--build"
          role="tabpanel"
          data-workbench-page-id="build"
        >
          <section class="panel panel--palette panel--blocks" aria-labelledby="palette-title">
            <header class="panel__header">
              <h2 id="palette-title">积木库</h2>
            </header>
            <div id="block-palette" class="block-palette"></div>
          </section>

          <section class="panel panel--blocks" aria-labelledby="blocks-title">
            <header class="panel__header">
              <h2 id="blocks-title">组装画布</h2>
            </header>
            <div id="block-tree" class="block-tree"></div>
          </section>

          <section class="panel panel--code" aria-labelledby="code-title">
            <header class="panel__header panel__header--code">
              <h2 id="code-title">C 代码</h2>
              <span id="source-meta" class="source-meta">—</span>
            </header>
            <div id="code-pane" class="code-pane" aria-label="C 代码编辑器"></div>
          </section>
        </section>
      </main>

      <footer class="status-bar">
        <output id="parser-status" class="status-pill" aria-live="polite" data-state="loading">
          正在加载 C 解析器…
        </output>
        <output id="import-status" class="status-message" aria-live="polite">
          解析器就绪后可打开、拖入或粘贴 .c 文件
        </output>
      </footer>

      <div id="drop-overlay" class="drop-overlay" hidden aria-hidden="true">
        <div class="drop-overlay__card">
          <strong>放下 .c 文件</strong>
          <span>仅在本机读取</span>
        </div>
      </div>

      <dialog id="paste-dialog" class="paste-dialog" aria-labelledby="paste-title">
        <form method="dialog" class="paste-dialog__surface">
          <div class="paste-dialog__header">
            <h2 id="paste-title">粘贴 C 源码</h2>
            <button id="paste-cancel" class="icon-button" value="cancel" aria-label="关闭">×</button>
          </div>
          <label class="paste-dialog__label" for="paste-source">UTF-8 C 源码，最大 512 KiB</label>
          <textarea id="paste-source" spellcheck="false" placeholder="int main(void) {\n  return 0;\n}"></textarea>
          <p id="paste-error" class="form-error" role="alert"></p>
          <div class="paste-dialog__actions">
            <button class="button button--quiet" value="cancel">取消</button>
            <button id="paste-confirm" class="button button--primary" type="button">载入工作台</button>
          </div>
        </form>
      </dialog>
    </div>
  `;

  const dock = required(app, "#workbench-dock", HTMLElement);
  const pageStack = required(app, "#workbench-pages", HTMLElement);
  const buildPanel = required(app, "#build-panel", HTMLElement);
  const mountedById = new Map<string, MountedPage>();
  const clickListeners = new Map<HTMLButtonElement, () => void>();

  for (const page of navigation.pages) {
    const mounted =
      page.id === "build"
        ? mountBuildPage(ownerDocument, buildPanel, page)
        : mountExtensionPage(ownerDocument, pageStack, page);
    mountedById.set(page.id, mounted);
  }

  const mountedPages: MountedPage[] = [];
  for (const group of navigation.groups) {
    const groupPages = navigation.pages.filter((page) => page.groupId === group.id);
    if (groupPages.length === 0) continue;
    const groupElement = ownerDocument.createElement("div");
    groupElement.className = "dock-group";
    groupElement.dataset.dockGroupId = group.id;
    groupElement.setAttribute("role", "group");
    const groupLabel = ownerDocument.createElement("span");
    groupLabel.className = "dock-group__label";
    groupLabel.textContent = group.label;
    groupElement.setAttribute("aria-label", group.label);
    groupElement.append(groupLabel);
    for (const page of groupPages) {
      const mounted = requireMountedPage(mountedById, page.id);
      groupElement.append(mounted.tab);
      mountedPages.push(mounted);
    }
    dock.append(groupElement);
  }

  let currentPageId = "build";
  let destroyed = false;
  const showPage = (pageId: string): void => {
    assertActive(destroyed);
    requireMountedPage(mountedById, pageId);
    currentPageId = pageId;
    for (const item of mountedPages) {
      const active = item.pageId === pageId;
      item.tab.setAttribute("aria-selected", String(active));
      item.tab.tabIndex = active ? 0 : -1;
      item.panel.hidden = !active;
    }
  };
  const getPageHost = (pageId: string): HTMLElement => {
    assertActive(destroyed);
    return requireMountedPage(mountedById, pageId).host;
  };
  const inspectorIds = new Set(navigation.inspectorViews.map((view) => view.id));
  const requireInspectorId = (viewId: string): void => {
    if (!inspectorIds.has(viewId)) throw new RangeError(`未知检查器视图：${viewId}`);
  };
  const showInspector = (viewId: string): void => {
    requireInspectorId(viewId);
    showPage(viewId);
  };
  const getInspectorHost = (viewId: string): HTMLElement => {
    requireInspectorId(viewId);
    return getPageHost(viewId);
  };

  for (const item of mountedPages) {
    const listener = (): void => showPage(item.pageId);
    clickListeners.set(item.tab, listener);
    item.tab.addEventListener("click", listener);
  }
  const handleDockKeydown = (event: KeyboardEvent): void => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const activeIndex = Math.max(
      0,
      mountedPages.findIndex((item) => item.pageId === currentPageId),
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? mountedPages.length - 1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? (activeIndex + 1) % mountedPages.length
            : (activeIndex - 1 + mountedPages.length) % mountedPages.length;
    const next = mountedPages[nextIndex];
    if (next === undefined) return;
    showPage(next.pageId);
    next.tab.focus();
  };
  dock.addEventListener("keydown", handleDockKeydown);
  showPage("build");

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    dock.removeEventListener("keydown", handleDockKeydown);
    for (const [tab, listener] of clickListeners) {
      tab.removeEventListener("click", listener);
    }
    clickListeners.clear();
    mountedById.clear();
    mountedPages.splice(0, mountedPages.length);
  };

  return Object.freeze({
    shell: required(app, "#workbench-shell", HTMLElement),
    openButton: required(app, "#open-source", HTMLButtonElement),
    pasteButton: required(app, "#open-paste", HTMLButtonElement),
    themeButton: required(app, "#theme-toggle", HTMLButtonElement),
    fileName: required(app, "#file-name", HTMLElement),
    sourceMeta: required(app, "#source-meta", HTMLElement),
    parserStatus: required(app, "#parser-status", HTMLOutputElement),
    importStatus: required(app, "#import-status", HTMLOutputElement),
    blockPalette: required(app, "#block-palette", HTMLElement),
    blockTree: required(app, "#block-tree", HTMLElement),
    codePane: required(app, "#code-pane", HTMLElement),
    dropOverlay: required(app, "#drop-overlay", HTMLElement),
    pasteDialog: required(app, "#paste-dialog", HTMLDialogElement),
    pasteSource: required(app, "#paste-source", HTMLTextAreaElement),
    pasteError: required(app, "#paste-error", HTMLElement),
    pasteConfirm: required(app, "#paste-confirm", HTMLButtonElement),
    pasteCancel: required(app, "#paste-cancel", HTMLButtonElement),
    get currentPage(): string {
      return currentPageId;
    },
    showPage,
    getPageHost,
    showInspector,
    getInspectorHost,
    destroy,
  });
}

function mountBuildPage(
  ownerDocument: Document,
  panel: HTMLElement,
  page: RegisteredWorkbenchPage,
): MountedPage {
  const tab = createPageTab(ownerDocument, page);
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", tab.id);
  return Object.freeze({ pageId: page.id, tab, panel, host: panel });
}

function mountExtensionPage(
  ownerDocument: Document,
  pageStack: HTMLElement,
  page: RegisteredWorkbenchPage,
): MountedPage {
  const token = pageDomToken(page.id);
  const tab = createPageTab(ownerDocument, page);
  const panel = ownerDocument.createElement("section");
  panel.id = `${token}-panel`;
  panel.className = "workbench-page workbench-page--extension";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tab.id);
  panel.dataset.workbenchPageId = page.id;
  panel.hidden = true;
  const heading = ownerDocument.createElement("h2");
  heading.className = "workbench-page__title";
  heading.textContent = page.label;
  const host = ownerDocument.createElement("div");
  host.id = `${token}-host`;
  host.className = `workbench-page__host ${token}`;
  host.dataset.workbenchPageId = page.id;
  panel.append(heading, host);
  pageStack.append(panel);
  return Object.freeze({ pageId: page.id, tab, panel, host });
}

function createPageTab(ownerDocument: Document, page: RegisteredWorkbenchPage): HTMLButtonElement {
  const token = pageDomToken(page.id);
  const tab = ownerDocument.createElement("button");
  tab.id = `${token}-tab`;
  tab.className = "dock-tab";
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.textContent = page.label;
  tab.tabIndex = -1;
  tab.setAttribute("aria-selected", "false");
  tab.setAttribute("aria-controls", `${token}-panel`);
  tab.dataset.workbenchPageId = page.id;
  return tab;
}

function validateNavigation(snapshot: WorkbenchRegistrySnapshot): NavigationModel {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new TypeError("工作台注册快照必须是对象");
  }
  const groups = [...snapshot.dockGroups];
  const pages = [...snapshot.pages];
  const inspectorViews = [...snapshot.inspectorViews];
  if (groups.length === 0 || pages.length === 0) {
    throw new TypeError("工作台至少需要一个 Dock 分组和页面");
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const pageIds = new Set(pages.map((page) => page.id));
  if (groupIds.size !== groups.length) throw new TypeError("Dock 分组 id 不得重复");
  if (pageIds.size !== pages.length) throw new TypeError("工作台页面 id 不得重复");
  if (!pageIds.has("build")) throw new TypeError("工作台缺少默认 build 页面");
  for (const page of pages) {
    if (!groupIds.has(page.groupId)) {
      throw new TypeError(`工作台页面 ${page.id} 引用了未知 Dock 分组 ${page.groupId}`);
    }
  }
  for (const view of inspectorViews) {
    if (!pageIds.has(view.id)) {
      throw new TypeError(`检查器兼容视图 ${view.id} 缺少同名页面`);
    }
  }
  return Object.freeze({
    groups: Object.freeze(groups),
    pages: Object.freeze(pages),
    inspectorViews: Object.freeze(inspectorViews),
  });
}

function requireMountedPage(pages: ReadonlyMap<string, MountedPage>, pageId: string): MountedPage {
  const page = pages.get(pageId);
  if (page === undefined) throw new RangeError(`未知工作台页面：${pageId}`);
  return page;
}

function pageDomToken(pageId: string): string {
  if (/^[A-Za-z0-9_.:-]+$/u.test(pageId)) return pageId;
  const codePoints = [...pageId]
    .map((character) => character.codePointAt(0)?.toString(16))
    .join("-");
  return `~${codePoints}`;
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("工作台外壳已销毁");
}

function required<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: abstract new (...args: never[]) => T,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`工作台缺少节点 ${selector}`);
  }
  return element;
}
