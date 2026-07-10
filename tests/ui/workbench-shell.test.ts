import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinWorkbenchRegistry } from "../../src/workbench/builtin-modules.js";
import { mountWorkbench } from "../../src/ui/workbench-shell.js";

describe("workbench shell Dock behavior", () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts six grouped tabs with build active and generic extension hosts", () => {
    const shell = mount();
    const tabs = app.findAllByClass("dock-tab");

    expect(app.innerHTML).not.toContain("C 积木算法面板");
    expect(app.innerHTML).not.toContain("app-title");
    expect(shell.startupProgress.id).toBe("startup-progress");
    expect(tabs.map(({ textContent }) => textContent)).toEqual([
      "搭建",
      "积木库",
      "解释",
      "编辑",
      "运行",
      "入门",
    ]);
    expect(tabs.every((tab) => tab.getAttribute("role") === "tab")).toBe(true);
    expect(app.findAllByClass("dock-group__label").map(({ textContent }) => textContent)).toEqual([
      "构建",
      "检查",
      "执行",
      "学习",
    ]);
    expect(shell.currentPage).toBe("build");
    expect(pagePanel("build").hidden).toBe(false);
    expect(pagePanel("library").hidden).toBe(true);
    expect(shell.blockPalette.id).toBe("block-palette");
    expect(shell.getPageHost("library").id).toBe("library-host");
    expect(shell.getPageHost("guide").id).toBe("guide-host");
    expect(shell.getInspectorHost("edit")).toBe(shell.getPageHost("edit"));
  });

  it("switches pages by one click while preserving the mounted build hosts", () => {
    const shell = mount();
    const buildPanel = pagePanel("build");
    const codePane = shell.codePane as unknown as FakeElement;

    tab("library").click();
    expect(shell.currentPage).toBe("library");
    expect(buildPanel.hidden).toBe(true);
    expect(pagePanel("library").hidden).toBe(false);
    expect(shell.codePane).toBe(codePane);
    expect(codePane.removeNodeCount).toBe(0);

    shell.showPage("build");
    expect(shell.currentPage).toBe("build");
    expect(pagePanel("build")).toBe(buildPanel);
    expect(buildPanel.hidden).toBe(false);
    expect(() => shell.showPage("missing")).toThrow(/未知工作台页面/u);
    expect(() => shell.showInspector("library")).toThrow(/未知检查器视图/u);
  });

  it("navigates all Dock tabs with arrows, Home and End", () => {
    const shell = mount();
    const dock = app.require("workbench-dock");

    expect(dock.keydown("ArrowRight").defaultPrevented).toBe(true);
    expect(shell.currentPage).toBe("library");
    expect(document.activeElement).toBe(tab("library"));
    dock.keydown("End");
    expect(shell.currentPage).toBe("guide");
    dock.keydown("ArrowDown");
    expect(shell.currentPage).toBe("build");
    dock.keydown("ArrowLeft");
    expect(shell.currentPage).toBe("guide");
    dock.keydown("ArrowUp");
    expect(shell.currentPage).toBe("run");
    dock.keydown("Home");
    expect(shell.currentPage).toBe("build");
  });

  it("removes every Dock listener during idempotent teardown", () => {
    const shell = mount();
    const dock = app.require("workbench-dock");
    const tabs = app.findAllByClass("dock-tab");

    shell.destroy();
    shell.destroy();
    expect(dock.listenerRemoveCount("keydown")).toBe(1);
    expect(tabs.every((item) => item.listenerRemoveCount("click") === 1)).toBe(true);
    tab("library").click();
    expect(shell.currentPage).toBe("build");
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

  function tab(pageId: string): FakeElement {
    return app.require(`${pageId}-tab`);
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

  createElement(tagName: string): FakeElement {
    if (tagName === "button") return new FakeButton(tagName, this);
    if (tagName === "progress") return new FakeProgress(tagName, this);
    if (tagName === "output") return new FakeOutput(tagName, this);
    if (tagName === "dialog") return new FakeDialog(tagName, this);
    if (tagName === "textarea") return new FakeTextArea(tagName, this);
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string | undefined> = {};
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
  const build = element(document, "section", "build-panel", "workbench workbench-page");
  build.dataset.workbenchPageId = "build";
  const palette = element(document, "div", "block-palette", "block-palette");
  const tree = element(document, "div", "block-tree", "block-tree");
  const code = element(document, "div", "code-pane", "code-pane");
  const fileName = element(document, "span", "file-name");
  const sourceMeta = element(document, "span", "source-meta");
  const startupRoot = element(document, "div", "startup-loader", "startup-loader");
  const startupProgress = identified(document.createElement("progress"), "startup-progress");
  const startupStatus = identified(document.createElement("output"), "startup-status");
  startupRoot.append(startupStatus, startupProgress);
  const dropOverlay = element(document, "div", "drop-overlay");
  const pasteError = element(document, "p", "paste-error");
  build.append(palette, tree, code);
  pageStack.append(build);
  shell.append(
    startupRoot,
    dock,
    pageStack,
    fileName,
    sourceMeta,
    dropOverlay,
    identified(document.createElement("button"), "open-source"),
    identified(document.createElement("button"), "open-paste"),
    identified(document.createElement("button"), "theme-toggle"),
    identified(document.createElement("output"), "parser-status"),
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
