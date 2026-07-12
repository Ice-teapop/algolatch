import type {
  RegisteredInspectorView,
  RegisteredWorkbenchPage,
  WorkbenchRegistrySnapshot,
} from "../workbench/contracts.js";
import type { OnboardingStepId } from "../onboarding/flow.js";
import {
  createWorkbenchMenu,
  workbenchMenuDefinitionsFromRegistry,
  type WorkbenchMenuController,
  type WorkbenchMenuSelection,
} from "./workbench-menu.js";

export interface WorkbenchElements {
  readonly shell: HTMLElement;
  readonly startupRoot: HTMLElement;
  readonly startupProgress: HTMLProgressElement;
  readonly startupStatus: HTMLOutputElement;
  readonly openButton: HTMLButtonElement;
  readonly pasteButton: HTMLButtonElement;
  readonly themeButton: HTMLButtonElement;
  readonly fileName: HTMLElement;
  readonly sourceMeta: HTMLElement;
  readonly parserStatus: HTMLOutputElement;
  readonly workspaceSaveStatus: HTMLOutputElement;
  readonly workspaceRecoveryButton: HTMLButtonElement;
  readonly importStatus: HTMLOutputElement;
  readonly blockPalette: HTMLElement;
  readonly blockTree: HTMLElement;
  readonly flowCanvas: HTMLElement;
  readonly codePane: HTMLElement;
  readonly buildLayout: HTMLElement;
  readonly leftPane: HTMLElement;
  readonly centerPane: HTMLElement;
  readonly rightPane: HTMLElement;
  readonly bottomPane: HTMLElement;
  readonly scenarioHost: HTMLElement;
  readonly traceHost: HTMLElement;
  readonly metricsHost: HTMLElement;
  readonly diagnosticsHost: HTMLElement;
  readonly mentorHost: HTMLElement;
  readonly dropOverlay: HTMLElement;
  readonly pasteDialog: HTMLDialogElement;
  readonly pasteSource: HTMLTextAreaElement;
  readonly pasteError: HTMLElement;
  readonly pasteConfirm: HTMLButtonElement;
  readonly pasteCancel: HTMLButtonElement;
  readonly currentPage: string;
  readonly showPage: (pageId: string) => void;
  readonly getPageHost: (pageId: string) => HTMLElement;
  readonly showInspector: (viewId: string) => void;
  readonly getInspectorHost: (viewId: string) => HTMLElement;
  readonly focusPanel: (panelId: string) => void;
  readonly getPanelVisibility: () => Readonly<Record<string, boolean>>;
  readonly setPanelVisibility: (value: Readonly<Record<string, boolean>>) => void;
  readonly applyLayoutPreset: (layoutId: string) => void;
  readonly revealOnboardingStep: (stepId: OnboardingStepId) => void;
  readonly finishOnboarding: () => void;
  readonly destroy: () => void;
}

export const WORKBENCH_REVEAL_FLOW_DETAIL_EVENT = "workbench-reveal-flow-detail";

interface NavigationModel {
  readonly pages: readonly RegisteredWorkbenchPage[];
  readonly inspectorViews: readonly RegisteredInspectorView[];
}

const FULL_PAGE_IDS = Object.freeze([
  "dashboard",
  "build",
  "block-library",
  "software-library",
] as const);

const PANEL_FOCUS_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  project: "dashboard-host",
  presets: "block-palette",
  canvas: "flow-canvas",
  code: "code-pane",
  inspector: "inspector-stack",
  runtime: "run-host",
  metrics: "runtime-metrics-host",
  diagnostics: "runtime-diagnostics-host",
  mentor: "mentor-hints-host",
});

const MENU_PANEL_IDS: Readonly<Record<string, string>> = Object.freeze({
  project: "project",
  presets: "presets",
  canvas: "canvas",
  code: "code",
  inspector: "properties",
  runtime: "flow",
  metrics: "metrics",
  diagnostics: "diagnostics",
  mentor: "ai-hints",
  "software-library": "library",
});

const PANEL_ELEMENT_IDS: Readonly<Record<string, string>> = Object.freeze({
  presets: "presets-pane",
  canvas: "center-canvas-pane",
  code: "code-panel",
  properties: "inspector-stack",
});

const RUNTIME_PANEL_VIEW: Readonly<Record<string, string>> = Object.freeze({
  flow: "run",
  metrics: "metrics",
  diagnostics: "diagnostics",
  "ai-hints": "mentor",
});

const SETTINGS_COPY: Readonly<Record<string, string>> = Object.freeze({
  appearance: "浅色为默认界面。深色主题只在这里切换，并保存在本机。",
  "workspace-files":
    "工作区条目实时保存到 Documents/C Algorithm Workbench；sidecar 与 main.c 分离。",
  "canvas-connections": "节点坐标自由；控制线可编辑，数据关系只读。危险区域始终锁定。",
  execution: "真实运行受资源上限约束；教学模拟与真实性能记录严格分离。",
  "ai-privacy": "当前导师只读取本地分析证据，不联网、不上传源码，也不会自动改写代码。",
  keyboard: "方向键移动焦点；Delete 删除草稿；⌘/Ctrl+C 复制；⌘/Ctrl+Z 撤销。",
  accessibility: "所有菜单、分隔条、画布节点和详情窗均提供键盘路径与可读状态。",
  "about-logs": "C Block Algorithm Panel 0.1.0-beta.6；日志和运行历史保存在项目目录。",
});

export function mountWorkbench(
  app: HTMLElement,
  registrySnapshot: WorkbenchRegistrySnapshot,
): WorkbenchElements {
  const navigation = validateNavigation(registrySnapshot);
  const menuDefinitions = workbenchMenuDefinitionsFromRegistry(registrySnapshot);
  app.innerHTML = workbenchMarkup();

  const shell = required(app, "#workbench-shell", HTMLElement);
  const pageStack = required(app, "#workbench-pages", HTMLElement);
  const dockHost = required(app, "#workbench-dock", HTMLElement);
  const drawer = required(app, "#workbench-drawer", HTMLElement);
  const drawerTitle = required(app, "#workbench-drawer-title", HTMLElement);
  const drawerCopy = required(app, "#workbench-drawer-copy", HTMLElement);
  const drawerClose = required(app, "#workbench-drawer-close", HTMLButtonElement);
  const themeButton = required(app, "#theme-toggle", HTMLButtonElement);

  const pagePanels = new Map<string, HTMLElement>();
  const pageHosts = new Map<string, HTMLElement>();
  for (const pageId of FULL_PAGE_IDS) {
    pagePanels.set(pageId, required(app, `#${pageId}-panel`, HTMLElement));
    pageHosts.set(pageId, required(app, `#${pageId}-host`, HTMLElement));
  }
  pageHosts.set("explanation", required(app, "#explanation-host", HTMLElement));
  pageHosts.set("edit", required(app, "#edit-host", HTMLElement));
  pageHosts.set("run", required(app, "#run-host", HTMLElement));

  const viewTabs = new Map<string, HTMLButtonElement>([
    ["dashboard", required(app, "#dashboard-tab", HTMLButtonElement)],
    ["build", required(app, "#build-tab", HTMLButtonElement)],
  ]);
  const inspectorTabs = new Map<string, HTMLButtonElement>([
    ["explanation", required(app, "#explanation-tab", HTMLButtonElement)],
    ["edit", required(app, "#edit-tab", HTMLButtonElement)],
    ["run", required(app, "#run-tab", HTMLButtonElement)],
  ]);
  const inspectorPanels = new Map<string, HTMLElement>([
    ["explanation", required(app, "#explanation-panel", HTMLElement)],
    ["edit", required(app, "#edit-panel", HTMLElement)],
    ["run", required(app, "#run-panel", HTMLElement)],
  ]);
  const runtimeTabs = new Map<string, HTMLButtonElement>([
    ["run", required(app, "#run-tab", HTMLButtonElement)],
    ["metrics", required(app, "#metrics-tab", HTMLButtonElement)],
    ["diagnostics", required(app, "#diagnostics-tab", HTMLButtonElement)],
    ["mentor", required(app, "#mentor-tab", HTMLButtonElement)],
  ]);
  const runtimePanels = new Map<string, HTMLElement>([
    ["run", required(app, "#run-panel", HTMLElement)],
    ["metrics", required(app, "#metrics-panel", HTMLElement)],
    ["diagnostics", required(app, "#diagnostics-panel", HTMLElement)],
    ["mentor", required(app, "#mentor-panel", HTMLElement)],
  ]);
  const panelVisibility = new Map(
    registrySnapshot.panels.map((panel) => [panel.id, panel.defaultVisible] as const),
  );

  let currentPageId = "dashboard";
  let destroyed = false;
  let onboardingPanelSnapshot: Readonly<Record<string, boolean>> | null = null;
  let onboardingRuntimeView: string | null = null;

  const emitAction = (rootId: string, branchId: string): void => {
    const EventConstructor = shell.ownerDocument.defaultView?.CustomEvent;
    if (EventConstructor === undefined) return;
    shell.dispatchEvent(
      new EventConstructor("workbench-action", {
        detail: Object.freeze({ rootId, branchId }),
      }),
    );
  };

  const closeDrawer = (): void => {
    drawer.hidden = true;
    drawer.dataset.menuRoot = "";
    drawer.dataset.menuBranch = "";
  };

  const showFullPage = (pageId: string): void => {
    const requestedPanel = pagePanels.get(pageId);
    if (requestedPanel === undefined) throw new RangeError(`未知工作台页面：${pageId}`);
    currentPageId = pageId;
    for (const [id, panel] of pagePanels) panel.hidden = id !== pageId;
    for (const [id, tab] of viewTabs) {
      const active = id === pageId;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    closeDrawer();
  };

  const showInspector = (viewId: string): void => {
    assertActive(destroyed);
    if (!inspectorTabs.has(viewId)) throw new RangeError(`未知检查器视图：${viewId}`);
    showFullPage("build");
    if (viewId === "run") {
      showRuntimeView("run");
    } else {
      for (const id of ["explanation", "edit"] as const) {
        const active = id === viewId;
        const tab = inspectorTabs.get(id);
        const panel = inspectorPanels.get(id);
        tab?.setAttribute("aria-selected", String(active));
        if (tab !== undefined) tab.tabIndex = active ? 0 : -1;
        if (panel !== undefined) panel.hidden = !active;
      }
    }
    const tab = inspectorTabs.get(viewId);
    tab?.setAttribute("aria-selected", "true");
  };

  const showRuntimeView = (viewId: string): void => {
    if (!runtimeTabs.has(viewId)) throw new RangeError(`未知运行面板：${viewId}`);
    showFullPage("build");
    const panelId = Object.entries(RUNTIME_PANEL_VIEW).find(([, id]) => id === viewId)?.[0];
    if (panelId !== undefined) panelVisibility.set(panelId, true);
    required(app, "#bottom-pane", HTMLElement).dataset.activeRuntimeView = viewId;
    renderRuntimePanels(viewId);
  };

  const renderRuntimePanels = (preferredViewId?: string): void => {
    const visibleViews = Object.entries(RUNTIME_PANEL_VIEW)
      .filter(([panelId]) => panelVisibility.get(panelId) === true)
      .map(([, viewId]) => viewId);
    const bottom = required(app, "#bottom-pane", HTMLElement);
    bottom.hidden = visibleViews.length === 0;
    const requested = preferredViewId ?? bottom.dataset.activeRuntimeView ?? "run";
    const activeView = visibleViews.includes(requested) ? requested : (visibleViews[0] ?? "run");
    bottom.dataset.activeRuntimeView = activeView;
    for (const [id, tab] of runtimeTabs) {
      const panelIdForView = Object.entries(RUNTIME_PANEL_VIEW).find(
        ([, view]) => view === id,
      )?.[0];
      const visible = panelIdForView === undefined || panelVisibility.get(panelIdForView) === true;
      const active = visible && id === activeView;
      tab.hidden = !visible;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = runtimePanels.get(id);
      if (panel !== undefined) panel.hidden = !active;
    }
  };

  const setPanelVisible = (menuPanelId: string, visible: boolean): void => {
    const panelId = MENU_PANEL_IDS[menuPanelId] ?? menuPanelId;
    if (!panelVisibility.has(panelId)) throw new RangeError(`未知工作台面板：${menuPanelId}`);
    panelVisibility.set(panelId, visible);
    const elementId = PANEL_ELEMENT_IDS[panelId];
    if (elementId !== undefined) required(app, `#${elementId}`, HTMLElement).hidden = !visible;
    if (panelId in RUNTIME_PANEL_VIEW)
      renderRuntimePanels(visible ? RUNTIME_PANEL_VIEW[panelId] : undefined);
    shell.dataset.panelVisibility = JSON.stringify(Object.fromEntries(panelVisibility));
  };

  const restorePanelVisibility = (value: Readonly<Record<string, boolean>>): void => {
    for (const panel of registrySnapshot.panels) {
      const visible = value[panel.id];
      if (typeof visible === "boolean") setPanelVisible(panel.id, visible);
    }
  };

  const applyRegisteredLayout = (layoutId: string): void => {
    const layout = registrySnapshot.layoutPresets.find((candidate) => candidate.id === layoutId);
    if (layout === undefined) throw new RangeError(`未知工作台布局：${layoutId}`);
    const visible = new Set(layout.panelIds);
    for (const panel of registrySnapshot.panels) {
      if (panel.id === "project" || panel.id === "library") continue;
      setPanelVisible(panel.id, visible.has(panel.id));
    }
    showFullPage("build");
    shell.dataset.layoutPreset = layoutId;
  };

  const showPage = (pageId: string): void => {
    assertActive(destroyed);
    if (!navigation.pages.some((page) => page.id === pageId)) {
      throw new RangeError(`未知工作台页面：${pageId}`);
    }
    if (inspectorTabs.has(pageId)) {
      showInspector(pageId);
      return;
    }
    if (!pagePanels.has(pageId)) throw new RangeError(`未知工作台页面：${pageId}`);
    showFullPage(pageId);
  };

  const getPageHost = (pageId: string): HTMLElement => {
    assertActive(destroyed);
    const host = pageHosts.get(pageId);
    if (host === undefined || !navigation.pages.some((page) => page.id === pageId)) {
      throw new RangeError(`未知工作台页面：${pageId}`);
    }
    return host;
  };

  const getInspectorHost = (viewId: string): HTMLElement => {
    assertActive(destroyed);
    if (!navigation.inspectorViews.some((view) => view.id === viewId)) {
      throw new RangeError(`未知检查器视图：${viewId}`);
    }
    return getPageHost(viewId);
  };

  const focusPanel = (panelId: string): void => {
    assertActive(destroyed);
    const targetId = PANEL_FOCUS_TARGETS[panelId];
    if (targetId === undefined) throw new RangeError(`未知工作台面板：${panelId}`);
    if (panelId === "project") showFullPage("dashboard");
    else showFullPage("build");
    if (panelId === "runtime") showRuntimeView("run");
    else if (panelId === "metrics") showRuntimeView("metrics");
    else if (panelId === "diagnostics") showRuntimeView("diagnostics");
    else if (panelId === "mentor") showRuntimeView("mentor");
    const target = required(app, `#${targetId}`, HTMLElement);
    target.classList.add("is-panel-focused");
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    target.focus({ preventScroll: true });
    globalThis.setTimeout(() => target.classList.remove("is-panel-focused"), 700);
  };

  const openSettingsBranch = (branchId: string): void => {
    const definition = menuDefinitions.find((item) => item.id === "settings");
    const branch = definition?.branches.find((item) => item.id === branchId);
    drawerTitle.textContent = branch === undefined ? "设置" : `设置 / ${branch.label}`;
    drawerCopy.textContent = SETTINGS_COPY[branchId] ?? "此设置由工作台扩展贡献，并保存在本机。";
    drawer.dataset.menuRoot = "settings";
    drawer.dataset.menuBranch = branchId;
    drawer.hidden = false;
    themeButton.hidden = branchId !== "appearance";
  };

  const handleMenuSelection = (selection: WorkbenchMenuSelection): void => {
    emitAction(selection.rootId, selection.branchId);
    if (selection.rootId === "settings") {
      openSettingsBranch(selection.branchId);
      return;
    }
    if (selection.rootId === "presets") {
      if (selection.branchId === "custom-lifecycle") showFullPage("block-library");
      else focusPanel("presets");
      shell.dataset.presetCategory = selection.branchId;
      return;
    }
    if (selection.rootId === "library") {
      showFullPage("software-library");
      shell.dataset.libraryBranch = selection.branchId;
      return;
    }
    const panelId = selection.branchId;
    if (["learn", "build", "debug", "analyze", "minimal"].includes(panelId)) {
      applyRegisteredLayout(panelId);
      return;
    }
    if (panelId === "software-library") {
      showFullPage("software-library");
      return;
    }
    if (panelId === "save-layout" || panelId === "reset-layout") {
      shell.dataset.layoutRequest = panelId;
      return;
    }
    const canonicalPanelId = MENU_PANEL_IDS[panelId];
    if (
      canonicalPanelId !== undefined &&
      canonicalPanelId !== "project" &&
      canonicalPanelId !== "library"
    ) {
      const nextVisible = panelVisibility.get(canonicalPanelId) !== true;
      setPanelVisible(panelId, nextVisible);
      if (nextVisible) focusPanel(panelId);
      return;
    }
    focusPanel(panelId);
  };

  const menu: WorkbenchMenuController = createWorkbenchMenu(dockHost, {
    onSelect: handleMenuSelection,
    definitions: menuDefinitions,
  });

  const revealOnboardingStep = (stepId: OnboardingStepId): void => {
    assertActive(destroyed);
    if (onboardingPanelSnapshot === null) {
      onboardingPanelSnapshot = Object.freeze(Object.fromEntries(panelVisibility));
      onboardingRuntimeView =
        required(app, "#bottom-pane", HTMLElement).dataset.activeRuntimeView ?? "run";
    }
    menu.close();
    if (
      ["welcome", "dashboard-modules", "dashboard-create", "dock", "import-source"].includes(stepId)
    ) {
      showFullPage("dashboard");
      if (stepId === "dock") menu.open("panels");
      return;
    }
    if (stepId === "block-lifecycle") {
      showFullPage("block-library");
      return;
    }
    if (stepId === "library") {
      showFullPage("software-library");
      return;
    }
    showFullPage("build");
    if (stepId === "build-presets") setPanelVisible("presets", true);
    else if (stepId === "free-canvas" || stepId === "node-detail") {
      setPanelVisible("canvas", true);
      if (stepId === "node-detail") {
        const EventConstructor = shell.ownerDocument.defaultView?.Event;
        if (EventConstructor !== undefined) {
          shell.dispatchEvent(new EventConstructor(WORKBENCH_REVEAL_FLOW_DETAIL_EVENT));
        }
      }
    } else if (stepId === "code-sync") setPanelVisible("code", true);
    else if (stepId === "runtime-flow") showRuntimeView("run");
    else if (stepId === "runtime-metrics") showRuntimeView("metrics");
    else if (stepId === "runtime-diagnostics") showRuntimeView("diagnostics");
    else if (stepId === "evidence-mentor") showRuntimeView("mentor");
  };

  const finishOnboarding = (): void => {
    assertActive(destroyed);
    menu.close();
    if (onboardingPanelSnapshot !== null) restorePanelVisibility(onboardingPanelSnapshot);
    if (onboardingRuntimeView !== null) renderRuntimePanels(onboardingRuntimeView);
    onboardingPanelSnapshot = null;
    onboardingRuntimeView = null;
  };

  const pageTabListeners = new Map<HTMLButtonElement, () => void>();
  for (const [pageId, tab] of viewTabs) {
    const listener = (): void => showPage(pageId);
    tab.addEventListener("click", listener);
    pageTabListeners.set(tab, listener);
  }
  const inspectorTabListeners = new Map<HTMLButtonElement, () => void>();
  for (const [viewId, tab] of inspectorTabs) {
    const listener = (): void => showInspector(viewId);
    tab.addEventListener("click", listener);
    inspectorTabListeners.set(tab, listener);
  }
  const runtimeTabListeners = new Map<HTMLButtonElement, () => void>();
  for (const [viewId, tab] of runtimeTabs) {
    if (viewId === "run") continue;
    const listener = (): void => showRuntimeView(viewId);
    tab.addEventListener("click", listener);
    runtimeTabListeners.set(tab, listener);
  }
  const onDrawerClose = (): void => closeDrawer();
  drawerClose.addEventListener("click", onDrawerClose);

  applyRegisteredLayout("build");
  showFullPage("dashboard");

  return Object.freeze({
    shell,
    startupRoot: required(app, "#startup-loader", HTMLElement),
    startupProgress: required(app, "#startup-progress", HTMLProgressElement),
    startupStatus: required(app, "#startup-status", HTMLOutputElement),
    openButton: required(app, "#open-source", HTMLButtonElement),
    pasteButton: required(app, "#open-paste", HTMLButtonElement),
    themeButton,
    fileName: required(app, "#file-name", HTMLElement),
    sourceMeta: required(app, "#source-meta", HTMLElement),
    parserStatus: required(app, "#parser-status", HTMLOutputElement),
    workspaceSaveStatus: required(app, "#workspace-save-status", HTMLOutputElement),
    workspaceRecoveryButton: required(app, "#workspace-recovery", HTMLButtonElement),
    importStatus: required(app, "#import-status", HTMLOutputElement),
    blockPalette: required(app, "#block-palette", HTMLElement),
    blockTree: required(app, "#block-tree", HTMLElement),
    flowCanvas: required(app, "#flow-canvas", HTMLElement),
    codePane: required(app, "#code-pane", HTMLElement),
    buildLayout: required(app, "#build-layout", HTMLElement),
    leftPane: required(app, "#left-pane", HTMLElement),
    centerPane: required(app, "#center-pane", HTMLElement),
    rightPane: required(app, "#right-pane", HTMLElement),
    bottomPane: required(app, "#bottom-pane", HTMLElement),
    scenarioHost: required(app, "#scenario-workbench-host", HTMLElement),
    traceHost: required(app, "#trace-workbench-host", HTMLElement),
    metricsHost: required(app, "#runtime-metrics-host", HTMLElement),
    diagnosticsHost: required(app, "#runtime-diagnostics-host", HTMLElement),
    mentorHost: required(app, "#mentor-hints-host", HTMLElement),
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
    focusPanel,
    getPanelVisibility: () => Object.freeze(Object.fromEntries(panelVisibility)),
    setPanelVisibility: restorePanelVisibility,
    applyLayoutPreset: applyRegisteredLayout,
    revealOnboardingStep,
    finishOnboarding,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      drawerClose.removeEventListener("click", onDrawerClose);
      for (const [tab, listener] of pageTabListeners) tab.removeEventListener("click", listener);
      for (const [tab, listener] of inspectorTabListeners) {
        tab.removeEventListener("click", listener);
      }
      for (const [tab, listener] of runtimeTabListeners) {
        tab.removeEventListener("click", listener);
      }
      menu.destroy();
      pagePanels.clear();
      pageHosts.clear();
      viewTabs.clear();
      inspectorTabs.clear();
      inspectorPanels.clear();
      runtimeTabs.clear();
      runtimePanels.clear();
      pageStack.replaceChildren();
    },
  });
}

function workbenchMarkup(): string {
  return `
    <div id="workbench-shell" class="workbench-shell" data-layout-preset="build">
      <div id="startup-loader" class="startup-loader" role="status" aria-live="polite" aria-busy="true" data-state="loading">
        <div class="startup-loader__background" aria-hidden="true"></div>
        <div class="startup-loader__surface">
          <output id="startup-status" class="startup-loader__status">正在建立本地工作台…</output>
          <progress id="startup-progress" class="startup-loader__progress" max="100" value="8" aria-labelledby="startup-status"></progress>
        </div>
      </div>

      <header class="app-bar">
        <nav class="workspace-switcher" role="tablist" aria-label="工作区位置">
          <button id="dashboard-tab" class="workspace-switcher__button" type="button" role="tab" aria-label="Dashboard" aria-controls="dashboard-panel">⌂</button>
          <button id="build-tab" class="workspace-switcher__button" type="button" role="tab" aria-label="搭建" aria-controls="build-panel">◇</button>
        </nav>
        <div id="workbench-dock" class="dock-bar" data-tour-target="dock"></div>
        <div class="document-identity" aria-label="当前文档">
          <span id="file-name">本地工作区</span>
          <span id="source-meta" class="source-meta">—</span>
        </div>
        <nav class="app-actions" aria-label="源码操作" data-tour-target="import-actions">
          <button id="open-source" class="button button--quiet" type="button" disabled>打开 C 文件</button>
          <button id="open-paste" class="button button--quiet" type="button" disabled>粘贴源码</button>
        </nav>
      </header>

      <main id="workbench-pages" class="workbench-pages" aria-label="C 算法工作台">
        <section id="dashboard-panel" class="workbench-page workbench-page--extension" role="tabpanel" aria-labelledby="dashboard-tab">
          <div id="dashboard-host" class="workbench-page__host dashboard" data-tour-target="dashboard"></div>
        </section>

        <section id="build-panel" class="workbench-page workbench-page--build" role="tabpanel" aria-labelledby="build-tab" hidden>
          <div id="build-host" class="build-workspace">
            <div id="build-layout" class="build-layout" data-tour-target="layout-resize">
              <aside id="left-pane" class="workbench-region workbench-region--left" tabindex="-1" aria-label="预设与源码结构">
                <section id="presets-pane" class="panel panel--palette" data-tour-target="preset-blocks">
                  <header class="panel__header"><h2>预设块</h2></header>
                  <div id="block-palette" class="block-palette workbench-scroll-region"></div>
                </section>
                <section id="outline-pane" class="panel panel--outline">
                  <header class="panel__header"><h2>源码结构</h2></header>
                  <div id="block-tree" class="block-tree workbench-scroll-region"></div>
                </section>
              </aside>

              <section id="center-pane" class="workbench-region workbench-region--center" tabindex="-1" aria-label="自由节点画布">
                <section id="center-canvas-pane" class="center-canvas-pane">
                  <header class="canvas-toolbar">
                    <h2>自由画布</h2>
                    <span class="canvas-toolbar__hint">拖动节点 · 端口连线 · 滚轮缩放</span>
                    <div class="canvas-toolbar__actions" aria-label="画布排列与历史">
                      <button type="button" data-flow-command="undo" title="撤销（⌘/Ctrl+Z）">撤销</button>
                      <button type="button" data-flow-command="align-left" title="左对齐所选节点">左对齐</button>
                      <button type="button" data-flow-command="distribute-y" title="纵向等距分布所选节点">纵向分布</button>
                    </div>
                  </header>
                  <div id="flow-canvas" class="flow-canvas-host" data-tour-target="assembly-canvas" tabindex="0"></div>
                </section>
                <section id="bottom-pane" class="workbench-region workbench-region--bottom" tabindex="-1" aria-label="运行流程与证据">
                  <nav class="panel-tabs" role="tablist" aria-label="运行面板">
                    <button id="run-tab" type="button" role="tab" aria-controls="run-panel" aria-selected="true">运行</button>
                    <button id="metrics-tab" type="button" role="tab" aria-controls="metrics-panel" aria-selected="false">指标</button>
                    <button id="diagnostics-tab" type="button" role="tab" aria-controls="diagnostics-panel" aria-selected="false">诊断</button>
                    <button id="mentor-tab" type="button" role="tab" aria-controls="mentor-panel" aria-selected="false">AI 提示</button>
                  </nav>
                  <div class="runtime-grid workbench-scroll-region">
                    <section id="run-panel" role="tabpanel" aria-labelledby="run-tab" data-tour-target="runtime-flow">
                      <div id="scenario-workbench-host" aria-label="案例与分支执行"></div>
                      <div id="trace-workbench-host" aria-label="实时运行流程"></div>
                      <div id="run-host" aria-label="编译运行控制"></div>
                    </section>
                    <section id="metrics-panel" role="tabpanel" aria-labelledby="metrics-tab" data-tour-target="runtime-metrics" hidden><div id="runtime-metrics-host" aria-label="运行指标"></div></section>
                    <section id="diagnostics-panel" role="tabpanel" aria-labelledby="diagnostics-tab" data-tour-target="runtime-diagnostics" hidden><div id="runtime-diagnostics-host" aria-label="诊断"></div></section>
                    <section id="mentor-panel" role="tabpanel" aria-labelledby="mentor-tab" hidden><div id="mentor-hints-host" aria-label="本地 AI 提示" data-tour-target="mentor-hints"></div></section>
                  </div>
                </section>
              </section>

              <aside id="right-pane" class="workbench-region workbench-region--right" tabindex="-1" aria-label="代码与属性">
                <section id="code-panel" class="panel panel--code" data-tour-target="code-pane">
                  <header class="panel__header"><h2>C 代码</h2></header>
                  <div id="code-pane" class="code-pane workbench-scroll-region" aria-label="C 代码编辑器"></div>
                </section>
                <section id="inspector-stack" class="panel panel--inspector" tabindex="-1">
                  <nav class="panel-tabs" role="tablist" aria-label="节点详情">
                    <button id="explanation-tab" type="button" role="tab" aria-controls="explanation-panel" aria-selected="true">解释</button>
                    <button id="edit-tab" type="button" role="tab" aria-controls="edit-panel" aria-selected="false">编辑</button>
                  </nav>
                  <section id="explanation-panel" class="inspector-view workbench-scroll-region" role="tabpanel" aria-labelledby="explanation-tab"><div id="explanation-host"></div></section>
                  <section id="edit-panel" class="inspector-view workbench-scroll-region" role="tabpanel" aria-labelledby="edit-tab" hidden><div id="edit-host"></div></section>
                </section>
              </aside>
            </div>
          </div>
        </section>

        <section id="block-library-panel" class="workbench-page workbench-page--extension" role="region" aria-label="积木管理" hidden>
          <div id="block-library-host" class="workbench-page__host block-library" data-tour-target="block-library"></div>
        </section>
        <section id="software-library-panel" class="workbench-page workbench-page--extension" role="region" aria-label="Library" hidden>
          <div id="software-library-host" class="workbench-page__host software-library" data-tour-target="software-library"></div>
        </section>
      </main>

      <aside id="workbench-drawer" class="workbench-drawer" aria-labelledby="workbench-drawer-title" hidden>
        <header><h2 id="workbench-drawer-title">设置</h2><button id="workbench-drawer-close" class="icon-button" type="button" aria-label="关闭设置">×</button></header>
        <p id="workbench-drawer-copy"></p>
        <button id="theme-toggle" class="button button--quiet" type="button" hidden>切换浅色 / 深色</button>
      </aside>

      <footer class="status-bar">
        <output id="parser-status" class="status-pill" aria-live="polite" data-state="loading">正在加载 C 解析器…</output>
        <output id="workspace-save-status" class="workspace-save-status" aria-live="polite" data-state="unmanaged" data-tour-target="local-save">本地工作区未打开</output>
        <button id="workspace-recovery" class="workspace-recovery-button" type="button" hidden>重新载入磁盘版本</button>
        <output id="import-status" class="status-message" aria-live="polite">解析器就绪后可打开、拖入或粘贴 .c 文件</output>
      </footer>

      <div id="drop-overlay" class="drop-overlay" hidden aria-hidden="true"><div class="drop-overlay__card"><strong>放下 .c 文件</strong><span>仅在本机读取</span></div></div>
      <dialog id="paste-dialog" class="paste-dialog" aria-labelledby="paste-title">
        <form method="dialog" class="paste-dialog__surface">
          <div class="paste-dialog__header"><h2 id="paste-title">粘贴 C 源码</h2><button id="paste-cancel" class="icon-button" value="cancel" aria-label="关闭">×</button></div>
          <label class="paste-dialog__label" for="paste-source">UTF-8 C 源码，最大 512 KiB</label>
          <textarea id="paste-source" spellcheck="false" placeholder="int main(void) {\n  return 0;\n}"></textarea>
          <p id="paste-error" class="form-error" role="alert"></p>
          <div class="paste-dialog__actions"><button class="button button--quiet" value="cancel">取消</button><button id="paste-confirm" class="button button--primary" type="button">载入工作台</button></div>
        </form>
      </dialog>
    </div>
  `;
}

function validateNavigation(snapshot: WorkbenchRegistrySnapshot): NavigationModel {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new TypeError("工作台注册快照必须是对象");
  }
  const pages = [...snapshot.pages];
  const inspectorViews = [...snapshot.inspectorViews];
  const pageIds = new Set(pages.map((page) => page.id));
  if (pageIds.size !== pages.length) throw new TypeError("工作台页面 id 不得重复");
  for (const requiredId of [
    "dashboard",
    "build",
    "block-library",
    "software-library",
    "explanation",
    "edit",
    "run",
  ]) {
    if (!pageIds.has(requiredId)) throw new TypeError(`工作台缺少页面 ${requiredId}`);
  }
  for (const view of inspectorViews) {
    if (!pageIds.has(view.id)) throw new TypeError(`检查器兼容视图 ${view.id} 缺少同名页面`);
  }
  return Object.freeze({
    pages: Object.freeze(pages),
    inspectorViews: Object.freeze(inspectorViews),
  });
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
  if (!(element instanceof constructor)) throw new Error(`工作台缺少节点 ${selector}`);
  return element;
}
