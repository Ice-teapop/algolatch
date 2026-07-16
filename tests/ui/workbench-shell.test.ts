import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinWorkbenchRegistry } from "../../src/workbench/builtin-modules.js";
import { mountWorkbench } from "../../src/ui/workbench-shell.js";

describe("M6 workbench shell behavior", () => {
  let document: FakeDocument;
  let app: FakeApp;

  beforeEach(() => {
    document = new FakeDocument();
    app = new FakeApp(document);
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("HTMLButtonElement", FakeButton);
    vi.stubGlobal("HTMLProgressElement", FakeProgress);
    vi.stubGlobal("HTMLOutputElement", FakeOutput);
    vi.stubGlobal("HTMLDialogElement", FakeDialog);
    vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
    vi.stubGlobal("HTMLSelectElement", FakeSelect);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts four root menus with Dashboard active and embedded workbench hosts", () => {
    const shell = mount();
    const roots = app.findAllByClass("workbench-menu__trigger");

    expect(app.innerHTML).not.toContain("<h1>AlgoLatch</h1>");
    expect(app.innerHTML).not.toContain("app-title");
    expect(app.innerHTML).not.toMatch(/[⌂◇]/u);
    expect(app.innerHTML).toContain(">项目</button>");
    expect(app.innerHTML).toContain(">工作区</button>");
    expect(app.innerHTML).toContain(">打开 AI 助手</button>");
    expect(app.innerHTML).toContain('id="ai-assistant-button" class="runtime-ai-action"');
    expect(app.innerHTML).not.toContain(
      'class="workspace-switcher__button" type="button" aria-label="打开 AI 助手"',
    );
    expect(app.innerHTML).toContain(">打开</button>");
    expect(app.innerHTML).toContain(">粘贴</button>");
    expect(shell.startupProgress.id).toBe("startup-progress");
    expect(roots.map(({ textContent }) => textContent)).toEqual([
      "设置",
      "积木",
      "Library",
      "布局",
    ]);
    expect(roots[0]?.getAttribute("aria-haspopup")).toBe("menu");
    expect(roots[2]?.getAttribute("aria-haspopup")).toBeUndefined();
    expect(shell.currentPage).toBe("dashboard");
    expect(pagePanel("dashboard").hidden).toBe(false);
    expect(pagePanel("build").hidden).toBe(true);
    expect(pagePanel("block-library").hidden).toBe(true);
    expect(shell.blockPalette.id).toBe("block-palette");
    expect(shell.flowCanvas.id).toBe("flow-canvas");
    expect(shell.tracePrimaryButton.id).toBe("trace-primary-action");
    expect(shell.getPageHost("block-library").id).toBe("block-library-host");
    expect(shell.getPageHost("software-library").id).toBe("software-library-host");
    expect(shell.getInspectorHost("edit").id).toBe("edit-host");
  });

  it("switches full pages while inspectors stay inside the mounted build surface", () => {
    const shell = mount();
    const buildPanel = pagePanel("build");
    const codePane = shell.codePane as unknown as FakeElement;

    shell.showPage("block-library");
    expect(shell.currentPage).toBe("block-library");
    expect(buildPanel.hidden).toBe(true);
    expect(pagePanel("block-library").hidden).toBe(false);
    expect(shell.codePane).toBe(codePane);
    expect(codePane.removeNodeCount).toBe(0);

    shell.showPage("build");
    expect(shell.currentPage).toBe("build");
    expect(pagePanel("build")).toBe(buildPanel);
    expect(buildPanel.hidden).toBe(false);
    expect(() => shell.showPage("missing")).toThrow(/未知工作台页面/u);
    expect(() => shell.showInspector("block-library")).toThrow(/未知检查器视图/u);
    shell.showInspector("edit");
    expect(shell.currentPage).toBe("build");
    expect(app.require("edit-panel").hidden).toBe(false);
    expect(app.require("explanation-panel").hidden).toBe(true);
  });

  it("routes command actions through the same settings and layout path as the Dock", () => {
    const shell = mount();
    shell.executeMenuAction("settings", "general");
    expect(app.require("workbench-drawer").hidden).toBe(false);
    expect(app.require("general-settings").hidden).toBe(false);

    shell.executeMenuAction("panels", "minimal");
    expect(shell.currentPage).toBe("build");
    expect((shell.shell as unknown as FakeElement).dataset.layoutPreset).toBe("minimal");
    expect(app.require("presets-pane").hidden).toBe(true);
    shell.focusPanel("presets");
    expect(app.require("presets-pane").hidden).toBe(false);
    expect(() => shell.executeMenuAction("settings", "missing")).toThrow(/未知工作台菜单/u);
  });

  it("shows live version and public project metadata in the localized About view", () => {
    const shell = mount();
    shell.setAppInfo({
      version: "0.0.1",
      license: "PolyForm-Noncommercial-1.0.0",
      repositoryUrl: "https://github.com/Ice-teapop/algolatch",
      releasesUrl: "https://github.com/Ice-teapop/algolatch/releases",
      platform: "darwin",
      architecture: "arm64",
      electronVersion: "43.0.0",
      packaged: true,
    });

    shell.executeMenuAction("settings", "about-logs");
    expect(app.require("workbench-drawer-copy").textContent).toContain("AlgoLatch v0.0.1");
    expect(app.require("workbench-drawer-copy").textContent).toContain("macOS arm64");
    expect(app.require("workbench-drawer-copy").textContent).toContain(
      "github.com/Ice-teapop/algolatch",
    );

    shell.setLocale("en");
    expect(app.require("workbench-drawer-copy").textContent).toContain("AlgoLatch v0.0.1");
    expect(app.require("workbench-drawer-copy").textContent).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("does not let a delayed background layout restore close the active Library page", () => {
    const shell = mount();

    shell.showPage("software-library");
    shell.applyLayoutPreset("minimal", { activateWorkspace: false });

    expect(shell.currentPage).toBe("software-library");
    expect(pagePanel("software-library").hidden).toBe(false);
    expect(pagePanel("build").hidden).toBe(true);
    expect((shell.shell as unknown as FakeElement).dataset.layoutPreset).toBe("minimal");
    expect(app.require("presets-pane").hidden).toBe(true);
  });

  it("removes menu and view listeners during idempotent teardown", () => {
    const shell = mount();
    const dashboardTab = app.require("dashboard-tab");
    const editTab = app.require("edit-tab");

    shell.destroy();
    shell.destroy();
    expect(dashboardTab.listenerRemoveCount("click")).toBe(1);
    expect(editTab.listenerRemoveCount("click")).toBe(1);
    expect(document.listenerRemoveCount("pointerdown")).toBe(1);
    expect(shell.currentPage).toBe("dashboard");
    expect(() => shell.showPage("build")).toThrow(/已销毁/u);
  });

  function mount() {
    return mountWorkbench(
      app as unknown as HTMLElement,
      createBuiltinWorkbenchRegistry().snapshot(),
    );
  }

  function pagePanel(pageId: string): FakeElement {
    return app.require(`${pageId}-panel`);
  }
});

class FakeEvent {
  defaultPrevented = false;

  constructor(readonly key = "") {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly defaultView = undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly removeCounts = new Map<string, number>();

  createElement(tagName: string): FakeElement {
    if (tagName === "button") return new FakeButton(tagName, this);
    if (tagName === "progress") return new FakeProgress(tagName, this);
    if (tagName === "output") return new FakeOutput(tagName, this);
    if (tagName === "dialog") return new FakeDialog(tagName, this);
    if (tagName === "textarea") return new FakeTextArea(tagName, this);
    if (tagName === "select") return new FakeSelect(tagName, this);
    return new FakeElement(tagName, this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
    this.removeCounts.set(type, (this.removeCounts.get(type) ?? 0) + 1);
  }

  listenerRemoveCount(type: string): number {
    return this.removeCounts.get(type) ?? 0;
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string | undefined> = {};
  readonly classList = {
    add: (...classNames: string[]): void => {
      const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
      for (const className of classNames) classes.add(className);
      this.className = [...classes].join(" ");
    },
    remove: (...classNames: string[]): void => {
      const removed = new Set(classNames);
      this.className = this.className
        .split(/\s+/u)
        .filter((className) => className.length > 0 && !removed.has(className))
        .join(" ");
    },
    toggle: (className: string, force: boolean): void => {
      const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
      if (force) classes.add(className);
      else classes.delete(className);
      this.className = [...classes].join(" ");
    },
  };
  id = "";
  className = "";
  textContent = "";
  type = "";
  tabIndex = 0;
  hidden = false;
  disabled = false;
  removeNodeCount = 0;
  private parent: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly removeCounts = new Map<string, number>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  remove(): void {
    this.removeNodeCount += 1;
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
    this.removeCounts.set(type, (this.removeCounts.get(type) ?? 0) + 1);
  }

  click(): void {
    this.emit("click", new FakeEvent());
  }

  keydown(key: string): FakeEvent {
    const event = new FakeEvent(key);
    this.emit("keydown", event);
    return event;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  querySelector(selector: string): FakeElement | null {
    const predicate = selector.startsWith("#")
      ? (element: FakeElement) => element.id === selector.slice(1)
      : selector.startsWith(".")
        ? (element: FakeElement) => element.hasClass(selector.slice(1))
        : () => false;
    return this.find(predicate) ?? null;
  }

  querySelectorAll(selector: string): readonly FakeElement[] {
    if (selector === "[data-menu-root-trigger]") {
      return this.findAll((element) => element.dataset.menuRootTrigger !== undefined);
    }
    if (selector === "[data-menu-branch]") {
      return this.findAll((element) => element.dataset.menuBranch !== undefined);
    }
    return [];
  }

  findAllByClass(className: string): readonly FakeElement[] {
    return this.findAll((element) => element.hasClass(className));
  }

  require(id: string): FakeElement {
    const element = this.find((candidate) => candidate.id === id);
    if (element === undefined) throw new Error(`missing ${id}`);
    return element;
  }

  listenerRemoveCount(type: string): number {
    return this.removeCounts.get(type) ?? 0;
  }

  private emit(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
    }
  }

  private hasClass(className: string): boolean {
    return this.className.split(/\s+/u).includes(className);
  }

  private find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private findAll(predicate: (element: FakeElement) => boolean): readonly FakeElement[] {
    return [
      ...(predicate(this) ? [this] : []),
      ...this.children.flatMap((child) => child.findAll(predicate)),
    ];
  }
}

class FakeButton extends FakeElement {}
class FakeProgress extends FakeElement {
  value = 0;
}
class FakeOutput extends FakeElement {}
class FakeDialog extends FakeElement {}
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {
  readonly options: FakeElement[] = [];
}

class FakeApp extends FakeElement {
  #innerHTML = "";

  constructor(ownerDocument: FakeDocument) {
    super("div", ownerDocument);
  }

  get innerHTML(): string {
    return this.#innerHTML;
  }

  set innerHTML(value: string) {
    this.#innerHTML = value;
    this.replaceChildren(buildStaticShell(this.ownerDocument));
  }
}

function buildStaticShell(document: FakeDocument): FakeElement {
  const shell = element(document, "div", "workbench-shell", "workbench-shell");
  const dock = element(document, "nav", "workbench-dock", "dock-bar");
  const pageStack = element(document, "main", "workbench-pages", "workbench-pages");
  const dashboard = element(document, "section", "dashboard-panel", "workbench-page");
  const dashboardHost = element(document, "div", "dashboard-host");
  dashboard.append(dashboardHost);
  const build = element(document, "section", "build-panel", "workbench-page");
  build.dataset.workbenchPageId = "build";
  const buildHost = element(document, "div", "build-host");
  const buildLayout = element(document, "div", "build-layout");
  const workArea = element(document, "div", "work-area");
  const primaryWorkspace = element(document, "div", "primary-workspace");
  const leftPane = element(document, "aside", "left-pane");
  const centerPane = element(document, "section", "center-pane");
  const rightPane = element(document, "aside", "right-pane");
  const presetsPane = element(document, "section", "presets-pane");
  const outlinePane = element(document, "section", "outline-pane");
  const centerCanvasPane = element(document, "section", "center-canvas-pane");
  const bottomPane = element(document, "section", "bottom-pane");
  const codePanel = element(document, "section", "code-panel");
  const inspectorStack = element(document, "section", "inspector-stack");
  const palette = element(document, "div", "block-palette", "block-palette");
  const tree = element(document, "div", "block-tree", "block-tree");
  const flowCanvas = element(document, "div", "flow-canvas", "flow-canvas-host");
  const tracePrimaryButton = identified(document.createElement("button"), "trace-primary-action");
  const manualRunInputHost = element(document, "div", "manual-run-input-host");
  const code = element(document, "div", "code-pane", "code-pane");
  const explanationPanel = element(document, "section", "explanation-panel");
  const explanationHost = element(document, "div", "explanation-host");
  explanationPanel.append(explanationHost);
  const editPanel = element(document, "section", "edit-panel");
  const editHost = element(document, "div", "edit-host");
  editPanel.append(editHost);
  const runPanel = element(document, "section", "run-panel");
  const scenarioHost = element(document, "div", "scenario-workbench-host");
  const traceHost = element(document, "div", "trace-workbench-host");
  const runHost = element(document, "div", "run-host");
  runPanel.append(scenarioHost, traceHost, runHost);
  const metricsPanel = element(document, "section", "metrics-panel");
  const metricsHost = element(document, "section", "runtime-metrics-host");
  metricsPanel.append(metricsHost);
  const diagnosticsPanel = element(document, "section", "diagnostics-panel");
  const diagnosticsHost = element(document, "section", "runtime-diagnostics-host");
  diagnosticsPanel.append(diagnosticsHost);
  const mentorPanel = element(document, "section", "mentor-panel");
  const mentorHost = element(document, "section", "mentor-hints-host");
  mentorPanel.append(mentorHost);
  presetsPane.append(palette);
  outlinePane.append(tree);
  leftPane.append(presetsPane, outlinePane);
  centerCanvasPane.append(tracePrimaryButton, manualRunInputHost, flowCanvas);
  bottomPane.append(runPanel, metricsPanel, diagnosticsPanel, mentorPanel);
  centerPane.append(centerCanvasPane);
  codePanel.append(code);
  inspectorStack.append(explanationPanel, editPanel);
  rightPane.append(codePanel, inspectorStack);
  primaryWorkspace.append(centerPane, rightPane);
  workArea.append(primaryWorkspace, bottomPane);
  buildLayout.append(leftPane, workArea);
  buildHost.append(buildLayout);
  build.append(buildHost);
  const analysis = element(document, "section", "analysis-panel", "workbench-page");
  analysis.append(element(document, "div", "analysis-host"));
  const blockLibrary = element(document, "section", "block-library-panel");
  blockLibrary.append(element(document, "div", "block-library-host"));
  const softwareLibrary = element(document, "section", "software-library-panel");
  softwareLibrary.append(element(document, "div", "software-library-host"));
  const fileName = element(document, "span", "file-name");
  const sourceMeta = element(document, "span", "source-meta");
  const startupRoot = element(document, "div", "startup-loader", "startup-loader");
  const startupProgress = identified(document.createElement("progress"), "startup-progress");
  const startupStatus = identified(document.createElement("output"), "startup-status");
  startupRoot.append(startupStatus, startupProgress);
  const dropOverlay = element(document, "div", "drop-overlay");
  const pasteError = element(document, "p", "paste-error");
  pageStack.append(dashboard, build, analysis, blockLibrary, softwareLibrary);
  const drawer = element(document, "aside", "workbench-drawer");
  const generalSettings = element(document, "section", "general-settings");
  const language = identified(document.createElement("select"), "interface-language");
  const background = identified(document.createElement("select"), "interface-background");
  (language as FakeSelect).options.push(
    document.createElement("option"),
    document.createElement("option"),
  );
  (background as FakeSelect).options.push(
    document.createElement("option"),
    document.createElement("option"),
    document.createElement("option"),
  );
  const aiSettings = element(document, "div", "ai-provider-settings-host");
  generalSettings.append(
    language,
    background,
    identified(document.createElement("button"), "theme-toggle"),
  );
  drawer.append(
    element(document, "h2", "workbench-drawer-title"),
    element(document, "p", "workbench-drawer-copy"),
    identified(document.createElement("button"), "workbench-drawer-close"),
    generalSettings,
    aiSettings,
  );
  shell.append(
    startupRoot,
    identified(document.createElement("button"), "dashboard-tab"),
    identified(document.createElement("button"), "build-tab"),
    identified(document.createElement("button"), "analysis-tab"),
    identified(document.createElement("button"), "ai-assistant-button"),
    identified(document.createElement("button"), "explanation-tab"),
    identified(document.createElement("button"), "edit-tab"),
    identified(document.createElement("button"), "run-tab"),
    identified(document.createElement("button"), "metrics-tab"),
    identified(document.createElement("button"), "mentor-tab"),
    dock,
    pageStack,
    drawer,
    fileName,
    sourceMeta,
    dropOverlay,
    identified(document.createElement("button"), "open-source"),
    identified(document.createElement("button"), "open-paste"),
    identified(document.createElement("output"), "parser-status"),
    identified(document.createElement("output"), "workspace-save-status"),
    identified(document.createElement("button"), "workspace-recovery"),
    identified(document.createElement("output"), "import-status"),
    identified(document.createElement("dialog"), "paste-dialog"),
    identified(document.createElement("textarea"), "paste-source"),
    pasteError,
    identified(document.createElement("button"), "paste-confirm"),
    identified(document.createElement("button"), "paste-cancel"),
  );
  return shell;
}

function element(document: FakeDocument, tagName: string, id: string, className = ""): FakeElement {
  const value = document.createElement(tagName);
  value.id = id;
  value.className = className;
  return value;
}

function identified(value: FakeElement, id: string): FakeElement {
  value.id = id;
  return value;
}
