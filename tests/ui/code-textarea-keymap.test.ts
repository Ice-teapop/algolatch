import { describe, expect, it, vi } from "vitest";
import {
  installCodeTextareaIndentation,
  planCodeTextareaIndentation,
} from "../../src/ui/code-textarea-keymap.js";

describe("code textarea indentation", () => {
  it("inserts two spaces at a collapsed cursor without losing focus position", () => {
    expect(planCodeTextareaIndentation("int value;", 4, 4, false)).toEqual({
      value: "int   value;",
      selectionStart: 6,
      selectionEnd: 6,
    });
  });

  it("indents and outdents a multiline selection as one editor operation", () => {
    const source = "a++;\nb++;\nreturn 0;";
    const indented = planCodeTextareaIndentation(source, 0, 9, false);
    expect(indented).toEqual({
      value: "  a++;\n  b++;\nreturn 0;",
      selectionStart: 2,
      selectionEnd: 13,
    });
    expect(
      planCodeTextareaIndentation(
        indented.value,
        indented.selectionStart,
        indented.selectionEnd,
        true,
      ),
    ).toEqual({
      value: source,
      selectionStart: 0,
      selectionEnd: 9,
    });
  });

  it("removes at most one configured indentation unit per selected line", () => {
    expect(planCodeTextareaIndentation(" a++;\n    b++;", 0, 14, true)).toEqual({
      value: "a++;\n  b++;",
      selectionStart: 0,
      selectionEnd: 11,
    });
  });

  it("accepts a lightweight textarea host only when nodeName is unavailable", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const textarea = {
      tagName: "textarea",
      addEventListener,
      removeEventListener,
    } as unknown as HTMLTextAreaElement;

    const controller = installCodeTextareaIndentation(textarea);
    const keydownListener = addEventListener.mock.calls[0]?.[1];
    expect(addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));

    controller.destroy();
    expect(removeEventListener).toHaveBeenCalledWith("keydown", keydownListener);
  });

  it("does not let tagName override an explicit non-textarea nodeName", () => {
    const addEventListener = vi.fn();
    const element = {
      nodeName: "DIV",
      tagName: "textarea",
      addEventListener,
      removeEventListener: vi.fn(),
    } as unknown as HTMLTextAreaElement;

    expect(() => installCodeTextareaIndentation(element)).toThrow("代码缩进只能安装到 textarea");
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
