import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_PRESET_BLOCKS, createLearningCatalog } from "../../src/learning/index.js";
import {
  ENGLISH_BUILTIN_PRESET_PRESENTATIONS,
  presentPresetBlock,
} from "../../src/ui/builtin-preset-presentations.js";
import { createBlockPalette, filterLearningTemplates } from "../../src/ui/block-palette.js";

const source = readFileSync(new URL("../../src/ui/block-palette.ts", import.meta.url), "utf8");

describe("block palette filtering", () => {
  it("shows only active templates for the selected learning stage", () => {
    const catalog = createLearningCatalog();
    catalog.createCustom({
      id: "custom.hidden",
      version: "1.0.0",
      label: "隐藏积木",
      category: "custom",
      stage: "c.basics",
      source: "hidden();",
      description: "即将弃用",
      fragmentKind: "statement",
    });
    catalog.deprecateCustom("custom.hidden", { reason: "测试弃用" });

    const basics = filterLearningTemplates(catalog.snapshot(), "c.basics", "");
    expect(basics.length).toBeGreaterThan(0);
    expect(basics.every((template) => template.stage === "c.basics")).toBe(true);
    expect(basics.map((template) => template.id)).not.toContain("custom.hidden");
  });

  it("searches labels, descriptions, categories and exact C source", () => {
    const snapshot = createLearningCatalog().snapshot();
    expect(filterLearningTemplates(snapshot, "all", "while").map(({ id }) => id)).toContain(
      "builtin.control.while",
    );
    expect(filterLearningTemplates(snapshot, "all", "标准输出").map(({ id }) => id)).toContain(
      "builtin.c.print-integer",
    );
    expect(
      filterLearningTemplates(snapshot, "all", "linear-structure").map(({ id }) => id),
    ).toContain("builtin.linear.advance-node");
    expect(
      filterLearningTemplates(snapshot, "all", "binary search step").map(({ id }) => id),
    ).toContain("builtin.search.binary-step");
  });

  it("exposes virtual Start/End/Pause/Checkpoint controls for canvas dragging", () => {
    const presets = filterLearningTemplates(createLearningCatalog().snapshot(), "all", "");
    expect(presets.filter((preset) => preset.blockKind === "virtual").map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "builtin.flow.start",
        "builtin.flow.end",
        "builtin.flow.pause",
        "builtin.flow.checkpoint",
      ]),
    );
  });

  it("groups Dock categories without hiding their C basics or memory presets", () => {
    const snapshot = createLearningCatalog().snapshot();
    const flowAndBasics = filterLearningTemplates(snapshot, "all", "", "flow-c-basics");
    const dataAndMemory = filterLearningTemplates(snapshot, "all", "", "data-memory");
    expect(flowAndBasics.some(({ category }) => category === "c-basics")).toBe(true);
    expect(flowAndBasics.some(({ blockKind }) => blockKind === "virtual")).toBe(true);
    expect(
      dataAndMemory.some(({ category }) =>
        ["arrays-strings", "pointers-memory", "data-structures"].includes(category),
      ),
    ).toBe(true);
  });

  it("limits quick-add results to presets with a compatible port direction and channel", () => {
    const snapshot = createLearningCatalog().snapshot();
    const compatible = filterLearningTemplates(snapshot, "all", "", "search", {
      direction: "input",
      channel: "control",
    });
    expect(compatible.length).toBeGreaterThan(0);
    expect(
      compatible.every((template) =>
        template.ports.some((port) => port.direction === "input" && port.channel === "control"),
      ),
    ).toBe(true);
  });

  it("intersects coarse port compatibility with exact source-placement candidates", () => {
    const snapshot = createLearningCatalog().snapshot();
    const compatible = filterLearningTemplates(snapshot, "all", "", "search", {
      direction: "input",
      channel: "control",
      presetIds: ["builtin.c.print-integer"],
    });
    expect(compatible.map(({ id }) => id)).toEqual(["builtin.c.print-integer"]);
  });
});

describe("block palette trust and accessibility contract", () => {
  it("publishes a constant native payload while template identity stays in callbacks", () => {
    expect(source).toContain('setData("text/plain", "c-block-catalog-item")');
    expect(source).not.toContain("getData(");
    expect(source).toContain("callbacks.onTemplateDragStart(template.id)");
  });

  it("limits native dragging to a dedicated surface with stable shape metadata", () => {
    expect(source).toContain("dragSurface.className = `block-palette__drag-surface");
    expect(source).toContain("dragSurface.draggable = true");
    expect(source).not.toContain("row.draggable = true");
    expect(source).toContain("dragSurface.dataset.templateId = template.id");
    expect(source).toContain("dragSurface.dataset.category = template.category");
    expect(source).toContain("dragSurface.dataset.fragmentKind = visualKind");
    expect(source).toContain("dragSurface.dataset.blockKind = template.blockKind");
    expect(source).toContain("dragSurface.dataset.stage = template.stage");
  });

  it("provides a button alternative to drag and writes catalog text via textContent", () => {
    expect(source).toContain(
      "template.source === null ? copy.dragToCanvas : copy.insertAtSelection",
    );
    expect(source).toContain("button[data-template-action='insert']");
    expect(source).toContain("label.textContent = presentation.label");
    expect(source).toContain("category.textContent = `${presetRoleLabel");
    expect(source).not.toContain("innerHTML");
  });

  it("switches palette chrome immediately without translating custom names or source", () => {
    const ownerDocument = new PaletteFakeDocument();
    const shell = ownerDocument.createElement("main");
    shell.dataset.locale = "zh-CN";
    const host = ownerDocument.createElement("div");
    shell.append(host);
    const catalog = createLearningCatalog();
    const palette = createBlockPalette(host as unknown as HTMLElement, catalog, {
      onTemplateDragStart: vi.fn(),
      onTemplateDragEnd: vi.fn(),
      onInsertSelected: vi.fn(),
    });
    const root = palette.element as unknown as PaletteFakeElement;

    expect(root.attribute("aria-label")).toBe("可拖拽积木库");
    expect(findPalette(root, (element) => element.type === "search").placeholder).toBe("筛选积木");
    expect(flatPaletteText(root)).toContain("全部阶段");
    palette.setCategory("custom-lifecycle");
    expect(flatPaletteText(root)).toContain("当前筛选下没有可用积木");

    shell.dataset.locale = "en";
    shell.dispatch("workbench-locale-change", { detail: { locale: "en" } });
    expect(root.attribute("aria-label")).toBe("Draggable block library");
    expect(findPalette(root, (element) => element.type === "search").placeholder).toBe(
      "Filter blocks",
    );
    expect(flatPaletteText(root)).toContain("All stages");
    expect(flatPaletteText(root)).toContain("No blocks match the current filters");

    catalog.createCustom({
      id: "custom.locale-preserved",
      version: "1.0.0",
      label: "我的 Max Block",
      category: "custom",
      stage: "c.basics",
      source: "maximum = value;",
      description: "用户自己的说明",
      fragmentKind: "statement",
    });
    palette.refresh();
    palette.setInsertEnabled(true);
    expect(flatPaletteText(root)).toContain("我的 Max Block");
    expect(flatPaletteText(root)).toContain("maximum = value;");
    expect(flatPaletteText(root)).toContain("用户自己的说明");
    expect(flatPaletteText(root)).toContain("Code Block · C statement slot");
    expect(flatPaletteText(root)).toContain("Insert at Selection");

    palette.destroy();
    expect(shell.listenerCount("workbench-locale-change")).toBe(0);
  });

  it("provides reviewed English label, description and aria copy for every built-in preset", () => {
    const builtinIds = BUILTIN_PRESET_BLOCKS.map(({ id }) => id).sort();
    expect(Object.keys(ENGLISH_BUILTIN_PRESET_PRESENTATIONS).sort()).toEqual(builtinIds);

    for (const preset of BUILTIN_PRESET_BLOCKS) {
      const presentation = presentPresetBlock({ ...preset, origin: "builtin" }, "en");
      expect(presentation.label, preset.id).not.toMatch(/\p{Script=Han}/u);
      expect(presentation.description, preset.id).not.toMatch(/\p{Script=Han}/u);
      expect(presentation.label.trim(), preset.id).not.toBe("");
      expect(presentation.description.trim(), preset.id).not.toBe("");
    }

    const ownerDocument = new PaletteFakeDocument();
    const shell = ownerDocument.createElement("main");
    shell.dataset.locale = "en";
    const host = ownerDocument.createElement("div");
    shell.append(host);
    const palette = createBlockPalette(host as unknown as HTMLElement, createLearningCatalog(), {
      onTemplateDragStart: vi.fn(),
      onTemplateDragEnd: vi.fn(),
      onInsertSelected: vi.fn(),
    });
    const root = palette.element as unknown as PaletteFakeElement;

    expect(flatPaletteText(root)).not.toMatch(/\p{Script=Han}/u);
    const dragSurfaces = findAllPalette(root, (element) =>
      element.className.includes("block-palette__drag-surface"),
    );
    expect(dragSurfaces).toHaveLength(BUILTIN_PRESET_BLOCKS.length);
    for (const dragSurface of dragSurfaces) {
      expect(dragSurface.attribute("aria-label")).not.toMatch(/\p{Script=Han}/u);
    }
    palette.destroy();
  });
});

class PaletteFakeDocument {
  createElement(tagName: string): PaletteFakeElement {
    return new PaletteFakeElement(tagName, this);
  }
}

class PaletteFakeClassList {
  private readonly values = new Set<string>();

  set(value: string): void {
    this.values.clear();
    for (const token of value.split(/\s+/u)) if (token.length > 0) this.values.add(token);
  }

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }
}

class PaletteFakeElement {
  readonly children: PaletteFakeElement[] = [];
  readonly dataset: Record<string, string | undefined> = {};
  readonly classList = new PaletteFakeClassList();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event?: unknown) => void>>();
  private parent: PaletteFakeElement | null = null;
  private classValue = "";
  textContent = "";
  value = "";
  type = "";
  placeholder = "";
  title = "";
  id = "";
  htmlFor = "";
  disabled = false;
  draggable = false;
  tabIndex = 0;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: PaletteFakeDocument,
  ) {}

  get className(): string {
    return this.classValue;
  }

  set className(value: string) {
    this.classValue = value;
    this.classList.set(value);
  }

  append(...children: PaletteFakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: PaletteFakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  attribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? new Set<(event?: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event?: unknown) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event?: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  listenerCount(name: string): number {
    return this.listeners.get(name)?.size ?? 0;
  }

  closest<T>(selector: string): T | null {
    let current: PaletteFakeElement | null = this;
    while (current !== null) {
      if (selector === "[data-locale]" && current.dataset.locale !== undefined) {
        return current as T;
      }
      current = current.parent;
    }
    return null;
  }

  querySelectorAll<T>(selector: string): T[] {
    const matches: T[] = [];
    const visit = (element: PaletteFakeElement): void => {
      for (const child of element.children) {
        const insert =
          selector === "button[data-template-action='insert']" &&
          child.tagName === "button" &&
          child.dataset.templateAction === "insert";
        const template =
          selector === "[data-template-id]" && child.dataset.templateId !== undefined;
        if (insert || template) matches.push(child as T);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  focus(): void {}

  select(): void {}

  scrollIntoView(): void {}

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

function findPalette(
  root: PaletteFakeElement,
  predicate: (element: PaletteFakeElement) => boolean,
): PaletteFakeElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return findPalette(child, predicate);
    } catch {
      // Continue through sibling branches.
    }
  }
  throw new Error("palette element not found");
}

function flatPaletteText(root: PaletteFakeElement): string {
  return [root.textContent, ...root.children.map(flatPaletteText)].join(" ");
}

function findAllPalette(
  root: PaletteFakeElement,
  predicate: (element: PaletteFakeElement) => boolean,
): PaletteFakeElement[] {
  return [
    ...(predicate(root) ? [root] : []),
    ...root.children.flatMap((child) => findAllPalette(child, predicate)),
  ];
}
