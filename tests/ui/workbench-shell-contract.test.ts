import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/ui/workbench-shell.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(
  new URL("../../src/app/workbench-runtime.ts", import.meta.url),
  "utf8",
);

describe("workbench shell extension contract", () => {
  it("mounts the complete registry snapshot and renders contribution labels as text", () => {
    expect(source).not.toContain("createBuiltinWorkbenchRegistry");
    expect(source).toContain("registrySnapshot: WorkbenchRegistrySnapshot");
    expect(source).toContain("snapshot.dockGroups");
    expect(source).toContain("snapshot.pages");
    expect(source).toContain("groupLabel.textContent = group.label");
    expect(source).toContain("tab.textContent = page.label");
    expect(source).toContain("heading.textContent = page.label");
    expect(source).not.toContain("${page.label}");
    expect(runtimeSource).toContain("mountWorkbench(app, registrySnapshot)");
    expect(runtimeSource).not.toContain("mountWorkbench(app, registrySnapshot.inspectorViews)");
  });

  it("keeps build mounted as the fixed three-host work surface without an inspector column", () => {
    expect(source).toContain('id="build-panel"');
    expect(source).toContain('id="block-palette"');
    expect(source).toContain('id="block-tree"');
    expect(source).toContain('id="code-pane" class="code-pane" aria-label="C 代码编辑器"');
    expect(source).not.toContain('aria-label="只读 C 代码编辑器"');
    expect(source).not.toContain("panel--inspector");
    expect(source).not.toContain('id="inspector-tabs"');
  });

  it("publishes page navigation plus inspector compatibility aliases", () => {
    expect(source).toContain("readonly currentPage: string");
    expect(source).toContain("readonly showPage: (pageId: string) => void");
    expect(source).toContain("readonly getPageHost: (pageId: string) => HTMLElement");
    expect(source).toContain("showInspector");
    expect(source).toContain("getInspectorHost");
    expect(source).toContain("requireInspectorId(viewId)");
    expect(source).toContain("return getPageHost(viewId)");
  });

  it("uses Dock tabs and hides inactive page panels without destroying build", () => {
    expect(source).toContain('tab.setAttribute("role", "tab")');
    expect(source).toContain('tab.setAttribute("aria-selected", String(active))');
    expect(source).toContain("item.panel.hidden = !active");
    expect(source).toContain('showPage("build")');
    expect(source).not.toMatch(/replaceChildren\([^)]*panel/gu);
    expect(source).not.toMatch(/item\.panel\.remove\(\)/gu);
  });

  it("supports full directional, Home and End Dock keyboard navigation", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(source).toContain(`"${key}"`);
    }
    expect(source).toContain('dock.addEventListener("keydown", handleDockKeydown)');
    expect(source).toContain("next.tab.focus()");
  });

  it("removes the top-left product brand but preserves functional top-bar controls", () => {
    expect(source).not.toContain("brand__mark");
    expect(source).not.toMatch(/<img\b/gu);
    expect(source).not.toContain('id="app-title"');
    expect(source).not.toContain("C 积木算法面板");
    expect(source).toContain('id="workbench-dock"');
    expect(source).toContain('id="file-name"');
    expect(source).toContain('id="open-source"');
    expect(source).toContain('id="open-paste"');
    expect(source).toContain('id="theme-toggle"');
  });

  it("publishes an idempotent teardown that removes every Dock listener", () => {
    expect(source).toContain("readonly destroy: () => void");
    expect(source).toContain('dock.removeEventListener("keydown", handleDockKeydown)');
    expect(source).toContain('tab.removeEventListener("click", listener)');
    expect(source).toContain("clickListeners.clear()");
    expect(source).toContain("mountedById.clear()");
  });
});
