import type {
  RegisteredInspectorView,
  RegisteredWorkbenchPage,
  WorkbenchRegistrySnapshot,
} from "../workbench/contracts.js";
import { APP_PRODUCT_NAME, type AppInfoSnapshot } from "../shared/app-info.js";
import type { InterfaceLocale } from "./interface-preferences.js";
import {
  createWorkbenchMenu,
  workbenchMenuDefinitionsFromRegistry,
  type WorkbenchMenuController,
  type WorkbenchMenuSelection,
} from "./workbench-menu.js";
import { installCodeTextareaIndentation } from "./code-textarea-keymap.js";

export interface WorkbenchElements {
  readonly shell: HTMLElement;
  readonly startupRoot: HTMLElement;
  readonly startupProgress: HTMLProgressElement;
  readonly startupStatus: HTMLOutputElement;
  readonly openButton: HTMLButtonElement;
  readonly pasteButton: HTMLButtonElement;
  readonly themeButton: HTMLButtonElement;
  readonly languageSelect: HTMLSelectElement;
  readonly backgroundSelect: HTMLSelectElement;
  readonly aiProviderSettingsHost: HTMLElement;
  readonly aiAssistantButton: HTMLButtonElement;
  readonly fileName: HTMLElement;
  readonly sourceMeta: HTMLElement;
  readonly parserStatus: HTMLOutputElement;
  readonly workspaceSaveStatus: HTMLOutputElement;
  readonly workspaceRecoveryButton: HTMLButtonElement;
  readonly importStatus: HTMLOutputElement;
  readonly blockPalette: HTMLElement;
  readonly blockTree: HTMLElement;
  readonly flowCanvas: HTMLElement;
  readonly tracePrimaryButton: HTMLButtonElement;
  readonly manualRunInputHost: HTMLElement;
  readonly codePane: HTMLElement;
  readonly buildLayout: HTMLElement;
  readonly workArea: HTMLElement;
  readonly primaryWorkspace: HTMLElement;
  readonly leftPane: HTMLElement;
  readonly centerPane: HTMLElement;
  readonly rightPane: HTMLElement;
  readonly bottomPane: HTMLElement;
  readonly scenarioHost: HTMLElement;
  readonly traceHost: HTMLElement;
  readonly metricsHost: HTMLElement;
  readonly diagnosticsHost: HTMLElement;
  readonly mentorHost: HTMLElement;
  readonly analysisHost: HTMLElement;
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
  readonly applyLayoutPreset: (layoutId: string, options?: ApplyLayoutPresetOptions) => void;
  readonly executeMenuAction: (rootId: string, branchId: string) => void;
  readonly setAppInfo: (info: AppInfoSnapshot) => void;
  readonly setLocale: (locale: InterfaceLocale) => void;
  readonly destroy: () => void;
}

export interface ApplyLayoutPresetOptions {
  /**
   * User-invoked layout changes activate the workspace by default. Background state restoration
   * must opt out so a late sidecar read cannot steal navigation from Library or Analysis.
   */
  readonly activateWorkspace?: boolean;
}

export const WORKBENCH_REVEAL_FLOW_DETAIL_EVENT = "workbench-reveal-flow-detail";

interface NavigationModel {
  readonly pages: readonly RegisteredWorkbenchPage[];
  readonly inspectorViews: readonly RegisteredInspectorView[];
}

const FULL_PAGE_IDS = Object.freeze([
  "dashboard",
  "build",
  "analysis",
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
  mentor: "mentor-hints-host",
});

const FOCUS_PANEL_VISIBILITY: Readonly<Record<string, string>> = Object.freeze({
  presets: "presets",
  canvas: "canvas",
  code: "code",
  inspector: "properties",
  runtime: "flow",
  metrics: "metrics",
  mentor: "ai-hints",
});

const MENU_PANEL_IDS: Readonly<Record<string, string>> = Object.freeze({
  project: "project",
  presets: "presets",
  canvas: "canvas",
  code: "code",
  inspector: "properties",
  runtime: "flow",
  metrics: "metrics",
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
  "ai-hints": "mentor",
});

const SETTINGS_COPY: Readonly<Record<InterfaceLocale, Readonly<Record<string, string>>>> =
  Object.freeze({
    "zh-CN": Object.freeze({
      general: "语言、背景和明暗主题只影响本机界面，不会写入项目源码。",
      "ai-privacy": "连接你自己的模型，解锁工作区中的 AI 对话与分析页复核。",
      keyboard: "方向键移动菜单焦点；Delete 删除草稿；⌘/Ctrl+K 搜索；⌘/Ctrl+Z 撤销。",
      "about-logs": `${APP_PRODUCT_NAME} · 本地 C 算法学习与设计工作台。`,
    }),
    en: Object.freeze({
      general:
        "Language, background and theme are local UI preferences and never alter source files.",
      "ai-privacy":
        "Connect your own model to unlock workspace chat and optional reviews in Analysis.",
      keyboard:
        "Arrow keys move menu focus; Delete removes drafts; Cmd/Ctrl+K searches; Cmd/Ctrl+Z undoes.",
      "about-logs": `${APP_PRODUCT_NAME} · a local C algorithm learning and design workbench.`,
    }),
  });

const ENGLISH_MENU_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "root:settings": "Settings",
  "root:presets": "Blocks",
  "root:library": "Library",
  "root:panels": "Layout",
  "settings:general": "General",
  "settings:ai-privacy": "AI Assistant",
  "settings:keyboard": "Shortcuts",
  "settings:about-logs": "About",
  "presets:search": "Search",
  "presets:flow-c-basics": "Flow & C Basics",
  "presets:data-memory": "Data & Memory",
  "presets:algorithm-patterns": "Algorithm Patterns",
  "presets:custom-lifecycle": "Custom",
  "library:c-syntax": "Syntax",
  "library:standard-library": "Standard Library",
  "library:data-structure-dictionary": "Data Structures",
  "library:algorithms-complexity": "Algorithms",
  "library:examples": "Examples",
  "library:manual": "Help",
  "panels:build": "Build",
  "panels:debug": "Debug",
  "panels:analyze": "Analyze",
  "panels:minimal": "Canvas Focus",
  "panels:reset-layout": "Reset Sizes",
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
  const generalSettings = required(app, "#general-settings", HTMLElement);
  const languageSelect = required(app, "#interface-language", HTMLSelectElement);
  const backgroundSelect = required(app, "#interface-background", HTMLSelectElement);
  const aiProviderSettingsHost = required(app, "#ai-provider-settings-host", HTMLElement);
  const pasteSource = required(app, "#paste-source", HTMLTextAreaElement);
  const pasteSourceIndentation = installCodeTextareaIndentation(pasteSource);

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
    ["analysis", required(app, "#analysis-tab", HTMLButtonElement)],
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
    ["mentor", required(app, "#mentor-tab", HTMLButtonElement)],
  ]);
  const runtimePanels = new Map<string, HTMLElement>([
    ["run", required(app, "#run-panel", HTMLElement)],
    ["metrics", required(app, "#metrics-panel", HTMLElement)],
    ["mentor", required(app, "#mentor-panel", HTMLElement)],
  ]);
  const panelVisibility = new Map(
    registrySnapshot.panels.map((panel) => [panel.id, panel.defaultVisible] as const),
  );

  let currentPageId = "dashboard";
  let currentLocale: InterfaceLocale = "zh-CN";
  let appInfo: AppInfoSnapshot | null = null;
  let destroyed = false;

  const setLocale = (locale: InterfaceLocale): void => {
    currentLocale = locale === "en" ? "en" : "zh-CN";
    shell.dataset.locale = currentLocale;
    const english = currentLocale === "en";
    const labels: readonly [string, string, string][] = [
      ["#dashboard-tab", "项目", "Projects"],
      ["#build-tab", "工作区", "Workspace"],
      ["#analysis-tab", "分析", "Analysis"],
      ["#ai-assistant-button", "打开 AI 助手", "Open AI Assistant"],
      [".document-identity__label", "当前文件", "Current File"],
      ["#open-source", "打开", "Open"],
      ["#open-paste", "粘贴", "Paste"],
      ["#presets-pane .panel__header h2", "预设块", "Preset Blocks"],
      ["#outline-pane .panel__header h2", "源码结构", "Source Outline"],
      ["#center-canvas-pane .canvas-toolbar h2", "自由画布", "Flow Canvas"],
      ["#trace-primary-action", "运行", "Run"],
      [
        "#center-canvas-pane .canvas-toolbar__hint",
        "拖入积木 · 拖空白平移 · 滚轮缩放",
        "Drag in blocks · drag blank canvas to pan · wheel to zoom",
      ],
      ["#code-panel .panel__header h2", "C 代码", "C Source"],
      ["#run-tab", "运行", "Run"],
      ["#metrics-tab", "指标", "Metrics"],
      ["#mentor-tab", "本地检查", "Local Checks"],
      ["#explanation-tab", "解释", "Explain"],
      ["#edit-tab", "编辑", "Edit"],
      [".canvas-toolbar__actions [data-flow-command='undo']", "撤销", "Undo"],
      [".canvas-toolbar__actions [data-flow-command='align-left']", "左对齐", "Align Left"],
      [
        ".canvas-toolbar__actions [data-flow-command='distribute-y']",
        "纵向分布",
        "Distribute Vertically",
      ],
      [".runtime-advanced > summary", "输出与诊断", "Output & Diagnostics"],
      ["#workbench-drawer-title", "设置", "Settings"],
      ["#general-settings label:first-child > span", "Language / 语言", "Language"],
      ["#general-settings label:nth-child(2) > span", "Background / 背景", "Background"],
      ["#theme-toggle", "切换浅色 / 深色", "Toggle Light / Dark"],
      ["#workspace-recovery", "重新载入磁盘版本", "Reload Disk Version"],
      ["#drop-overlay strong", "放下 .c 文件", "Drop .c File"],
      ["#drop-overlay span", "仅在本机读取", "Read Locally Only"],
      ["#paste-title", "粘贴 C 源码", "Paste C Source"],
      [".paste-dialog__label", "UTF-8 C 源码，最大 512 KiB", "UTF-8 C source, up to 512 KiB"],
      [".paste-dialog__actions [value='cancel']", "取消", "Cancel"],
      ["#paste-confirm", "载入工作台", "Load into Workbench"],
    ];
    for (const [selector, zh, en] of labels) {
      const element = app.querySelector<HTMLElement>(selector);
      if (element !== null) {
        element.textContent = english ? en : zh;
        if (
          selector === "#dashboard-tab" ||
          selector === "#build-tab" ||
          selector === "#analysis-tab"
        ) {
          element.setAttribute("aria-label", english ? en : zh);
        } else if (selector === "#open-source") {
          element.setAttribute("aria-label", english ? "Open C File" : "打开 C 文件");
        } else if (selector === "#open-paste") {
          element.setAttribute("aria-label", english ? "Paste Source" : "粘贴源码");
        } else if (selector === "#ai-assistant-button") {
          element.setAttribute("aria-label", english ? "Open AI Assistant" : "打开 AI 助手");
        }
      }
    }
    const localizedAttributes: readonly [string, string, string, string][] = [
      [".workspace-switcher", "aria-label", "工作区位置", "Workspace Location"],
      [".document-identity", "aria-label", "当前文档", "Current Document"],
      [".app-actions", "aria-label", "源码操作", "Source Actions"],
      ["#workbench-pages", "aria-label", "C 算法工作台", "C Algorithm Workbench"],
      ["#left-pane", "aria-label", "预设与源码结构", "Blocks and Source Outline"],
      ["#center-pane", "aria-label", "自由节点画布", "Free Node Canvas"],
      [".canvas-toolbar__actions", "aria-label", "画布排列与历史", "Canvas Layout and History"],
      [
        ".canvas-toolbar__actions [data-flow-command='undo']",
        "title",
        "撤销（⌘/Ctrl+Z）",
        "Undo (⌘/Ctrl+Z)",
      ],
      [
        ".canvas-toolbar__actions [data-flow-command='align-left']",
        "title",
        "左对齐所选节点",
        "Align Selected Nodes Left",
      ],
      [
        ".canvas-toolbar__actions [data-flow-command='distribute-y']",
        "title",
        "纵向等距分布所选节点",
        "Distribute Selected Nodes Vertically",
      ],
      ["#right-pane", "aria-label", "代码与属性", "Code and Properties"],
      ["#code-pane", "aria-label", "C 代码编辑器", "C Source Editor"],
      ["#inspector-stack .panel-tabs", "aria-label", "节点详情", "Node Details"],
      ["#bottom-pane", "aria-label", "运行流程与证据", "Runtime and Evidence"],
      ["#bottom-pane .runtime-panel-tabs", "aria-label", "运行面板", "Runtime Panels"],
      ["#scenario-workbench-host", "aria-label", "案例与分支执行", "Cases and Branch Execution"],
      ["#trace-workbench-host", "aria-label", "实时运行流程", "Live Runtime Flow"],
      ["#run-host", "aria-label", "编译运行控制", "Compile and Run Controls"],
      ["#runtime-metrics-host", "aria-label", "运行指标", "Runtime Metrics"],
      ["#diagnostics-panel", "aria-label", "诊断兼容面板", "Diagnostics Compatibility Panel"],
      ["#runtime-diagnostics-host", "aria-label", "诊断", "Diagnostics"],
      ["#mentor-hints-host", "aria-label", "本地证据检查", "Local Evidence Checks"],
      ["#block-library-panel", "aria-label", "积木管理", "Block Management"],
      ["#workbench-drawer-close", "aria-label", "关闭设置", "Close Settings"],
      ["#paste-cancel", "aria-label", "关闭", "Close"],
    ];
    for (const [selector, attribute, zh, en] of localizedAttributes) {
      app.querySelector<HTMLElement>(selector)?.setAttribute(attribute, english ? en : zh);
    }
    const defaultFileName = app.querySelector<HTMLElement>("#file-name");
    if (
      defaultFileName !== null &&
      (defaultFileName.textContent === "本地工作区" ||
        defaultFileName.textContent === "Local Workspace")
    ) {
      defaultFileName.textContent = english ? "Local Workspace" : "本地工作区";
    }
    languageSelect.options[0]!.textContent = english ? "Chinese" : "中文";
    languageSelect.options[1]!.textContent = "English";
    backgroundSelect.options[0]!.textContent = english ? "Pure white" : "纯白";
    backgroundSelect.options[1]!.textContent = english ? "Warm paper" : "暖纸";
    backgroundSelect.options[2]!.textContent = english ? "Cool white" : "冷白";
    for (const trigger of dockHost.querySelectorAll<HTMLElement>("[data-menu-root-trigger]")) {
      const id = trigger.dataset.menuRootTrigger;
      const zh = trigger.dataset.labelZh;
      const en = id === undefined ? undefined : ENGLISH_MENU_LABELS[`root:${id}`];
      if (zh !== undefined) trigger.textContent = english ? (en ?? zh) : zh;
    }
    for (const item of dockHost.querySelectorAll<HTMLElement>("[data-menu-branch]")) {
      const rootId = item.dataset.menuRoot;
      const branchId = item.dataset.menuBranch;
      const zh = item.dataset.labelZh;
      const en =
        rootId === undefined || branchId === undefined
          ? undefined
          : ENGLISH_MENU_LABELS[`${rootId}:${branchId}`];
      if (zh !== undefined) item.textContent = english ? (en ?? zh) : zh;
    }
    const branchId = drawer.dataset.menuBranch ?? "";
    if (drawer.dataset.menuRoot === "settings" && branchId.length > 0) {
      const branch = menuDefinitions
        .find((item) => item.id === "settings")
        ?.branches.find((item) => item.id === branchId);
      const branchLabel = english
        ? (ENGLISH_MENU_LABELS[`settings:${branchId}`] ?? branch?.label)
        : branch?.label;
      drawerTitle.textContent =
        branchLabel === undefined
          ? english
            ? "Settings"
            : "设置"
          : `${english ? "Settings" : "设置"} / ${branchLabel}`;
      drawerCopy.textContent = settingsCopy(currentLocale, branchId, appInfo);
    }
    const EventConstructor = shell.ownerDocument.defaultView?.CustomEvent;
    if (EventConstructor !== undefined) {
      shell.dispatchEvent(
        new EventConstructor("workbench-locale-change", {
          detail: Object.freeze({ locale: currentLocale }),
        }),
      );
    }
  };

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
    dockHost
      .querySelector<HTMLElement>("[data-menu-root-trigger='settings']")
      ?.setAttribute("aria-current", "false");
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
    const libraryTrigger = dockHost.querySelector<HTMLElement>(
      "[data-menu-root-trigger='library']",
    );
    libraryTrigger?.setAttribute("aria-current", pageId === "software-library" ? "page" : "false");
    const presetsTrigger = dockHost.querySelector<HTMLElement>(
      "[data-menu-root-trigger='presets']",
    );
    presetsTrigger?.setAttribute("aria-current", pageId === "block-library" ? "page" : "false");
    closeDrawer();
    if (pageId === "software-library") {
      const EventConstructor = shell.ownerDocument.defaultView?.Event;
      if (EventConstructor !== undefined) {
        globalThis.requestAnimationFrame(() =>
          shell.dispatchEvent(new EventConstructor("software-library-activated")),
        );
      }
    }
    const EventConstructor = shell.ownerDocument.defaultView?.Event;
    if (EventConstructor !== undefined) {
      shell.dispatchEvent(new EventConstructor("workbench-page-change"));
    }
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
      // Keep the assistant entry discoverable in every runtime layout. Selecting it opts the
      // panel back in through showRuntimeView without overriding a saved layout at startup.
      tab.hidden = !visible && id !== "mentor";
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

  const applyRegisteredLayout = (
    layoutId: string,
    options: ApplyLayoutPresetOptions = {},
  ): void => {
    const layout = registrySnapshot.layoutPresets.find((candidate) => candidate.id === layoutId);
    if (layout === undefined) throw new RangeError(`未知工作台布局：${layoutId}`);
    const visible = new Set(layout.panelIds);
    for (const panel of registrySnapshot.panels) {
      if (panel.id === "project" || panel.id === "library") continue;
      setPanelVisible(panel.id, visible.has(panel.id));
    }
    if (options.activateWorkspace !== false) showFullPage("build");
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
    const visibilityId = FOCUS_PANEL_VISIBILITY[panelId];
    if (visibilityId !== undefined && panelVisibility.get(visibilityId) !== true) {
      setPanelVisible(visibilityId, true);
    }
    if (panelId === "project") showFullPage("dashboard");
    else showFullPage("build");
    if (panelId === "runtime") showRuntimeView("run");
    else if (panelId === "metrics") showRuntimeView("metrics");
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
    const english = currentLocale === "en";
    const branchLabel = english
      ? (ENGLISH_MENU_LABELS[`settings:${branchId}`] ?? branch?.label)
      : branch?.label;
    drawerTitle.textContent =
      branchLabel === undefined
        ? english
          ? "Settings"
          : "设置"
        : `${english ? "Settings" : "设置"} / ${branchLabel}`;
    drawerCopy.textContent = settingsCopy(currentLocale, branchId, appInfo);
    drawer.dataset.menuRoot = "settings";
    drawer.dataset.menuBranch = branchId;
    drawer.hidden = false;
    dockHost
      .querySelector<HTMLElement>("[data-menu-root-trigger='settings']")
      ?.setAttribute("aria-current", "page");
    generalSettings.hidden = branchId !== "general";
    themeButton.hidden = branchId !== "general";
    aiProviderSettingsHost.hidden = branchId !== "ai-privacy";
    const focusTarget =
      branchId === "general"
        ? languageSelect
        : branchId === "ai-privacy"
          ? (aiProviderSettingsHost.querySelector<HTMLElement>("input, select, button") ??
            drawerClose)
          : drawerClose;
    focusTarget.focus({ preventScroll: true });
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
      if (selection.branchId === "search") {
        globalThis.requestAnimationFrame(() =>
          app.querySelector<HTMLInputElement>("#block-palette input[type='search']")?.focus(),
        );
      }
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
    localeHost: shell,
  });

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
    languageSelect,
    backgroundSelect,
    aiProviderSettingsHost,
    aiAssistantButton: required(app, "#ai-assistant-button", HTMLButtonElement),
    fileName: required(app, "#file-name", HTMLElement),
    sourceMeta: required(app, "#source-meta", HTMLElement),
    parserStatus: required(app, "#parser-status", HTMLOutputElement),
    workspaceSaveStatus: required(app, "#workspace-save-status", HTMLOutputElement),
    workspaceRecoveryButton: required(app, "#workspace-recovery", HTMLButtonElement),
    importStatus: required(app, "#import-status", HTMLOutputElement),
    blockPalette: required(app, "#block-palette", HTMLElement),
    blockTree: required(app, "#block-tree", HTMLElement),
    flowCanvas: required(app, "#flow-canvas", HTMLElement),
    tracePrimaryButton: required(app, "#trace-primary-action", HTMLButtonElement),
    manualRunInputHost: required(app, "#manual-run-input-host", HTMLElement),
    codePane: required(app, "#code-pane", HTMLElement),
    buildLayout: required(app, "#build-layout", HTMLElement),
    workArea: required(app, "#work-area", HTMLElement),
    primaryWorkspace: required(app, "#primary-workspace", HTMLElement),
    leftPane: required(app, "#left-pane", HTMLElement),
    centerPane: required(app, "#center-pane", HTMLElement),
    rightPane: required(app, "#right-pane", HTMLElement),
    bottomPane: required(app, "#bottom-pane", HTMLElement),
    scenarioHost: required(app, "#scenario-workbench-host", HTMLElement),
    traceHost: required(app, "#trace-workbench-host", HTMLElement),
    metricsHost: required(app, "#runtime-metrics-host", HTMLElement),
    diagnosticsHost: required(app, "#runtime-diagnostics-host", HTMLElement),
    mentorHost: required(app, "#mentor-hints-host", HTMLElement),
    analysisHost: required(app, "#analysis-host", HTMLElement),
    dropOverlay: required(app, "#drop-overlay", HTMLElement),
    pasteDialog: required(app, "#paste-dialog", HTMLDialogElement),
    pasteSource,
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
    executeMenuAction(rootId: string, branchId: string): void {
      assertActive(destroyed);
      const definition = menuDefinitions.find((item) => item.id === rootId);
      const branch = definition?.branches.find((item) => item.id === branchId);
      if (definition === undefined || branch === undefined) {
        throw new RangeError(`未知工作台菜单操作：${rootId}/${branchId}`);
      }
      handleMenuSelection(Object.freeze({ rootId: definition.id, branchId: branch.id }));
    },
    setAppInfo(info: AppInfoSnapshot): void {
      assertActive(destroyed);
      appInfo = Object.freeze({ ...info });
      if (drawer.dataset.menuRoot === "settings" && drawer.dataset.menuBranch === "about-logs") {
        drawerCopy.textContent = settingsCopy(currentLocale, "about-logs", appInfo);
      }
    },
    setLocale,
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
      pasteSourceIndentation.destroy();
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
          <button id="dashboard-tab" class="workspace-switcher__button" type="button" role="tab" aria-label="项目" aria-controls="dashboard-panel">项目</button>
          <button id="build-tab" class="workspace-switcher__button" type="button" role="tab" aria-label="工作区" aria-controls="build-panel">工作区</button>
          <button id="analysis-tab" class="workspace-switcher__button" type="button" role="tab" aria-label="分析" aria-controls="analysis-panel">分析</button>
        </nav>
        <div id="workbench-dock" class="dock-bar" data-tour-target="dock"></div>
        <div class="document-identity" aria-label="当前文档">
          <span class="document-identity__label">当前文件</span>
          <span id="file-name">本地工作区</span>
          <span id="source-meta" class="source-meta">—</span>
        </div>
        <nav class="app-actions" aria-label="源码操作" data-tour-target="import-actions">
          <button id="open-source" class="button button--quiet" type="button" aria-label="打开 C 文件" disabled>打开</button>
          <button id="open-paste" class="button button--quiet" type="button" aria-label="粘贴源码" disabled>粘贴</button>
        </nav>
      </header>

      <main id="workbench-pages" class="workbench-pages" aria-label="C 算法工作台">
        <section id="dashboard-panel" class="workbench-page workbench-page--extension" data-workbench-page-id="dashboard" role="tabpanel" aria-labelledby="dashboard-tab">
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

              <div id="work-area" class="work-area">
                <div id="primary-workspace" class="primary-workspace">
                  <section id="center-pane" class="workbench-region workbench-region--center" tabindex="-1" aria-label="自由节点画布">
                    <section id="center-canvas-pane" class="center-canvas-pane">
                      <header class="canvas-toolbar">
                        <h2>自由画布</h2>
                        <button id="trace-primary-action" class="canvas-toolbar__trace-action" type="button" data-primary-action="run" data-tour-target="trace-start">运行</button>
                        <div id="manual-run-input-host" class="manual-run-input-host"></div>
                        <span class="canvas-toolbar__hint">拖入积木 · 拖空白平移 · 滚轮缩放</span>
                        <div class="canvas-toolbar__actions" aria-label="画布排列与历史">
                          <button type="button" data-flow-command="undo" title="撤销（⌘/Ctrl+Z）">撤销</button>
                          <button type="button" data-flow-command="align-left" title="左对齐所选节点">左对齐</button>
                          <button type="button" data-flow-command="distribute-y" title="纵向等距分布所选节点">纵向分布</button>
                        </div>
                      </header>
                      <div id="flow-canvas" class="flow-canvas-host" data-tour-target="assembly-canvas" tabindex="0"></div>
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

                <section id="bottom-pane" class="workbench-region workbench-region--bottom" tabindex="-1" aria-label="运行流程与证据">
                  <header class="runtime-panel-bar">
                    <nav class="panel-tabs runtime-panel-tabs" role="tablist" aria-label="运行面板">
                      <button id="run-tab" type="button" role="tab" aria-controls="run-panel" aria-selected="true">运行</button>
                      <button id="metrics-tab" type="button" role="tab" aria-controls="metrics-panel" aria-selected="false">指标</button>
                      <button id="mentor-tab" type="button" role="tab" aria-controls="mentor-panel" aria-selected="false">本地检查</button>
                    </nav>
                    <button id="ai-assistant-button" class="runtime-ai-action" type="button" aria-label="打开 AI 助手" aria-haspopup="dialog" aria-expanded="false">打开 AI 助手</button>
                  </header>
                  <div class="runtime-grid workbench-scroll-region">
                    <section id="run-panel" role="tabpanel" aria-labelledby="run-tab" data-tour-target="runtime-flow">
                      <div id="scenario-workbench-host" aria-label="案例与分支执行"></div>
                      <div id="trace-workbench-host" aria-label="实时运行流程"></div>
                      <details class="runtime-advanced">
                        <summary>输出与诊断</summary>
                        <div id="run-host" aria-label="编译运行控制"></div>
                      </details>
                    </section>
                    <section id="metrics-panel" role="tabpanel" aria-labelledby="metrics-tab" data-tour-target="runtime-metrics" hidden><div id="runtime-metrics-host" aria-label="运行指标"></div></section>
                    <section id="diagnostics-panel" role="tabpanel" aria-label="诊断兼容面板" hidden><div id="runtime-diagnostics-host" aria-label="诊断"></div></section>
                    <section id="mentor-panel" role="tabpanel" aria-labelledby="mentor-tab" hidden><div id="mentor-hints-host" aria-label="本地证据检查" data-tour-target="mentor-hints"></div></section>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </section>

        <section id="analysis-panel" class="workbench-page workbench-page--extension" data-workbench-page-id="analysis" role="tabpanel" aria-labelledby="analysis-tab" hidden>
          <div id="analysis-host" class="workbench-page__host analysis-dashboard-host" data-tour-target="analysis"></div>
        </section>

        <section id="block-library-panel" class="workbench-page workbench-page--extension" data-workbench-page-id="block-library" role="region" aria-label="积木管理" hidden>
          <div id="block-library-host" class="workbench-page__host block-library" data-tour-target="block-library"></div>
        </section>
        <section id="software-library-panel" class="workbench-page workbench-page--extension" data-workbench-page-id="software-library" role="region" aria-label="Library" hidden>
          <div id="software-library-host" class="workbench-page__host software-library" data-tour-target="software-library"></div>
        </section>
      </main>

      <aside id="workbench-drawer" class="workbench-drawer" aria-labelledby="workbench-drawer-title" hidden>
        <header><h2 id="workbench-drawer-title">设置</h2><button id="workbench-drawer-close" class="icon-button" type="button" aria-label="关闭设置">×</button></header>
        <p id="workbench-drawer-copy"></p>
        <section id="general-settings" class="settings-form" hidden>
          <label><span>Language / 语言</span><select id="interface-language"><option value="zh-CN">中文</option><option value="en">English</option></select></label>
          <label><span>Background / 背景</span><select id="interface-background"><option value="white">纯白</option><option value="paper">暖纸</option><option value="cool">冷白</option></select></label>
          <button id="theme-toggle" class="button button--quiet" type="button" hidden>切换浅色 / 深色</button>
        </section>
        <div id="ai-provider-settings-host" hidden></div>
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
    "analysis",
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

function settingsCopy(
  locale: InterfaceLocale,
  branchId: string,
  appInfo: AppInfoSnapshot | null,
): string {
  if (branchId === "about-logs") return aboutCopy(locale, appInfo);
  return (
    SETTINGS_COPY[locale][branchId] ??
    (locale === "en"
      ? "This setting is contributed by the workbench and stored locally."
      : "此设置由工作台扩展贡献，并保存在本机。")
  );
}

function aboutCopy(locale: InterfaceLocale, info: AppInfoSnapshot | null): string {
  if (info === null) {
    return locale === "en"
      ? `${APP_PRODUCT_NAME}\n\nLocal, source-authoritative C algorithm learning and design workbench.\n\nVersion information is unavailable.`
      : `${APP_PRODUCT_NAME}\n\n本地、源码权威的 C 算法学习与设计工作台。\n\n版本信息暂不可用。`;
  }
  const platform = info.platform === "darwin" ? "macOS" : info.platform;
  const build =
    locale === "en"
      ? info.packaged
        ? "Installed build"
        : "Development build"
      : info.packaged
        ? "安装版本"
        : "开发版本";
  if (locale === "en") {
    return [
      `${APP_PRODUCT_NAME} v${info.version}`,
      "",
      "A local, source-authoritative workbench for learning, visualizing, running, and analyzing C algorithms.",
      "",
      "main.c is the only executable source of truth. Canvas layout, analysis, lessons, run history, and AI conversations remain recoverable supporting data.",
      "",
      `${build} · ${platform} ${info.architecture} · Electron ${info.electronVersion} · ${info.license}`,
      `Source: ${info.repositoryUrl}`,
      `Releases: ${info.releasesUrl}`,
    ].join("\n");
  }
  return [
    `${APP_PRODUCT_NAME} v${info.version}`,
    "",
    "用于学习、可视化、运行和分析 C 算法的本地源码权威工作台。",
    "",
    "main.c 是唯一可执行事实源；画布布局、分析、课程、运行历史和 AI 对话均为可恢复的辅助数据。",
    "",
    `${build} · ${platform} ${info.architecture} · Electron ${info.electronVersion} · ${info.license}`,
    `源码：${info.repositoryUrl}`,
    `版本与下载：${info.releasesUrl}`,
  ].join("\n");
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
