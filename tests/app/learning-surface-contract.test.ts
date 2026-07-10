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

  it("refreshes the palette and separates block management from the software Library", () => {
    expect(source).toContain("palette.refresh()");
    expect(source).toContain('getPageHost("block-library")');
    expect(source).toContain('getPageHost("software-library")');
    expect(source).toContain("onboarding.openFromLibrary()");
    expect(source).toContain("startOnboardingIfNeeded");
  });
});
