import { describe, expect, it } from "vitest";
import { textRange } from "../../src/core/index.js";
import { createSourceOffsetMap } from "../../src/renderer/source-offset-map.js";
import { sourceRangeToEditorRange } from "../../src/ui/code-pane.js";

describe("code pane display range mapping", () => {
  it("left-biases a read-only range ending between CR and LF", () => {
    const source = "//x\r\nint value;\r\n";
    const map = createSourceOffsetMap(source);

    expect(sourceRangeToEditorRange(map, textRange(0, 4), false)).toEqual({ from: 0, to: 3 });
    expect(sourceRangeToEditorRange(map, textRange(5, source.length), false)).toEqual({
      from: 4,
      to: map.editorLength,
    });
  });

  it("still rejects collapsed non-empty decorations", () => {
    const source = "\r\n";
    const map = createSourceOffsetMap(source);

    expect(() => sourceRangeToEditorRange(map, textRange(0, 1), false)).toThrow(/空范围/u);
    expect(sourceRangeToEditorRange(map, textRange(0, 1), true)).toEqual({ from: 0, to: 0 });
  });
});
