import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorSource = readFileSync(
  new URL("../../src/ui/c-command-editor.ts", import.meta.url),
  "utf8",
);
const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

describe("C Cell editor contract", () => {
  it("wraps long C input inside the resizable command surface", () => {
    expect(editorSource).toContain("EditorView.lineWrapping");
  });

  it("uses the runtime workspace stdin and args instead of an isolated input source", () => {
    expect(mainSource).toContain("getRuntimeInput: () => {");
    expect(mainSource).toContain("requireRuntimeWorkspace().getRuntimeInput()");
    expect(mainSource).toContain("args: Object.freeze([...input.arguments])");
  });
});
