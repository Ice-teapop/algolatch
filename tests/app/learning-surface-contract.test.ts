import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/app/learning-surface.ts", import.meta.url), "utf8");

describe("learning surface integration boundary", () => {
  it("routes every palette insertion through the assembly controller", () => {
    expect(source).toContain("createAssemblyController");
    expect(source).toContain("assembly.insert(intent)");
    expect(source).toContain("assembly.insertAfterSelected");
    expect(source).not.toContain("applyPatches");
    expect(source).not.toContain("dispatch(");
  });

  it("refreshes the palette after catalog lifecycle changes and exposes guide reopening", () => {
    expect(source).toContain("palette.refresh()");
    expect(source).toContain('getPageHost("library")');
    expect(source).toContain('getPageHost("guide")');
    expect(source).toContain("onboarding.openFromDock()");
  });
});
