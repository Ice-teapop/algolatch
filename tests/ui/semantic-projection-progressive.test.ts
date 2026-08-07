import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const style = readFileSync(
  new URL("../../src/styles/workbench/semantic-projection-progressive.css", import.meta.url),
  "utf8",
);

describe("semantic projection progressive disclosure", () => {
  it("uses the semantic panel width to contract tabs instead of the window width", () => {
    expect(style).toMatch(
      /\.semantic-monitor\s*\{[^}]*container-name:\s*semantic-monitor;[^}]*container-type:\s*inline-size;/su,
    );
    expect(style).toContain("@container semantic-monitor (max-width: 320px)");
    expect(style).toMatch(
      /@container semantic-monitor \(max-width: 320px\)\s*\{[\s\S]*?\.semantic-monitor__tabs\s*\{[^}]*overflow-x:\s*auto;/u,
    );
    expect(style).toMatch(
      /@container semantic-monitor \(max-width: 320px\)\s*\{[\s\S]*?\.semantic-monitor__tabs > button\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*auto;/u,
    );
  });

  it("anchors the narrow semantic drawer to the complete work area", () => {
    expect(style).toMatch(
      /@media \(max-width: 899px\)\s*\{[\s\S]*?\.work-area\s*\{[^}]*position:\s*relative;/u,
    );
    expect(style).toMatch(
      /@media \(max-width: 899px\)\s*\{[\s\S]*?#primary-workspace\s*\{[^}]*position:\s*static;/u,
    );
  });

  it("removes hidden toolbar actions from the compact title flow", () => {
    expect(style).toMatch(
      /#semantic-flow-panel \.canvas-toolbar__actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*6px;/su,
    );
    expect(style).toMatch(
      /#semantic-flow-panel \.canvas-toolbar h2,[\s\S]*?\.canvas-toolbar__source-badge\s*\{[^}]*text-overflow:\s*ellipsis;/u,
    );
  });

  it("keeps ports and edge insertion affordances hidden only at rest", () => {
    expect(style).toMatch(
      /\.semantic-monitor \.flow-node__port\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/su,
    );
    expect(style).toContain(".semantic-monitor .flow-node:hover > .flow-node__port");
    expect(style).toContain(".semantic-monitor .flow-node.is-selected > .flow-node__port");
    expect(style).toContain(".semantic-monitor .flow-node:focus-within > .flow-node__port");
    expect(style).toContain(
      '.semantic-monitor .flow-canvas[data-interaction-context="wiring"] .flow-node__port',
    );
    expect(style).toMatch(
      /\.semantic-monitor \.flow-canvas__edge-insert\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/su,
    );
    expect(style).toContain(
      '.semantic-monitor .flow-canvas[data-interaction-context="edge"] .flow-canvas__edge-insert',
    );
    expect(style).toContain(
      ".semantic-monitor .flow-canvas.is-preset-drag .flow-canvas__edge-insert",
    );
    expect(style).toContain(".semantic-monitor .flow-canvas__edge-insert:hover");
    expect(style).toContain(".semantic-monitor .flow-canvas__edge-insert:focus-visible");
  });

  it("keeps the C Cell preview read-only even when a node is explored", () => {
    const previewRule = style.indexOf(
      '#semantic-flow-panel:has(.canvas-toolbar[data-presentation="preview"]) .flow-node__port',
    );
    const interactiveRule = style.indexOf(".semantic-monitor .flow-node:hover > .flow-node__port");
    expect(previewRule).toBeGreaterThan(interactiveRule);
    expect(style.slice(previewRule)).toMatch(/opacity:\s*0;\s*pointer-events:\s*none;/su);
  });

  it("visually hides instructions while retaining their accessible text node", () => {
    expect(style).toMatch(
      /#semantic-flow-panel \.canvas-toolbar__hint\s*\{[^}]*width:\s*1px;[^}]*clip-path:\s*inset\(50%\);/su,
    );
    expect(style).not.toMatch(/\.canvas-toolbar__hint\s*\{[^}]*display:\s*none/su);
  });

  it("reveals secondary tools through pointer, selection, and keyboard focus", () => {
    expect(style).toContain(
      "#semantic-flow-panel .canvas-toolbar:focus-within .canvas-toolbar__actions",
    );
    expect(style).toContain(
      '#semantic-flow-panel:has(.flow-canvas[data-interaction-context="multi"])',
    );
    expect(style).toContain(".semantic-monitor .flow-canvas-host:focus-within .flow-minimap");
  });
});
