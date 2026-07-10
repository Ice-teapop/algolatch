import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLearningCatalog } from "../../src/learning/index.js";
import { filterLearningTemplates } from "../../src/ui/block-palette.js";

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
    expect(source).toContain("dragSurface.dataset.fragmentKind = template.fragmentKind");
    expect(source).toContain("dragSurface.dataset.stage = template.stage");
  });

  it("provides a button alternative to drag and writes catalog text via textContent", () => {
    expect(source).toContain('insert.textContent = "插入所选位置"');
    expect(source).toContain("button[data-template-action='insert']");
    expect(source).toContain("label.textContent = template.label");
    expect(source).not.toContain("innerHTML");
  });
});
