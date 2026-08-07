import { readFileSync } from "node:fs";
import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { codePaneAriaLabel, createCodePaneInputExtensions } from "../../src/ui/code-pane.js";
import { createExactSourceState, getExactSource } from "../../src/ui/exact-source-history.js";

const codePaneSource = readFileSync(new URL("../../src/ui/code-pane.ts", import.meta.url), "utf8");

describe("code pane direct-input contract", () => {
  it("keeps direct typing read-only by default", () => {
    const source = "int value = 1;\r\n";
    const state = createExactSourceState(source, createCodePaneInputExtensions({}));
    const one = state.doc.toString().indexOf("1");
    const transaction = state.update({
      changes: { from: one, to: one + 1, insert: "2" },
      userEvent: "input.type",
    });

    expect(state.facet(EditorView.editable)).toBe(false);
    expect(transaction.docChanged).toBe(false);
    expect(getExactSource(transaction.state)).toBe(source);
    expect(undoDepth(transaction.state)).toBe(0);
  });

  it("accepts validated direct input into exact source and shared history", () => {
    const source = "int value = 1;\r\n";
    const validateSource = vi.fn();
    const state = createExactSourceState(
      source,
      createCodePaneInputExtensions({ editable: true, validateSource }),
    );
    const one = state.doc.toString().indexOf("1");
    const transaction = state.update({
      changes: { from: one, to: one + 1, insert: "2" },
      userEvent: "input.type",
    });

    expect(state.facet(EditorView.editable)).toBe(true);
    expect(transaction.docChanged).toBe(true);
    expect(getExactSource(transaction.state)).toBe("int value = 2;\r\n");
    expect(undoDepth(transaction.state)).toBe(1);
    expect(validateSource).toHaveBeenCalledWith("int value = 2;\r\n");
  });

  it("rejects a policy failure atomically and leaves no history entry", () => {
    const source = "int value = 1;\r\n";
    const rejection = new Error("NUL is forbidden");
    const onInputRejected = vi.fn();
    const state = createExactSourceState(
      source,
      createCodePaneInputExtensions({
        editable: true,
        validateSource(candidate) {
          if (candidate.includes("\0")) throw rejection;
        },
        onInputRejected,
      }),
    );
    const transaction = state.update({
      changes: { from: state.doc.length, insert: "\0" },
      userEvent: "input.type",
    });

    expect(transaction.docChanged).toBe(false);
    expect(transaction.state.doc.toString()).toBe(state.doc.toString());
    expect(getExactSource(transaction.state)).toBe(source);
    expect(undoDepth(transaction.state)).toBe(0);
    expect(onInputRejected).toHaveBeenCalledOnce();
    expect(onInputRejected).toHaveBeenCalledWith(rejection);
  });

  it("keeps content accessibility metadata aligned with the editable facet", () => {
    expect(codePaneAriaLabel(true, "en")).toBe("C source editor");
    expect(codePaneAriaLabel(false, "en")).toBe("C source (read only)");
    expect(codePaneAriaLabel(true, "en")).not.toMatch(/[\p{Script=Han}]/u);
    expect(codePaneSource).toContain('"aria-label": codePaneAriaLabel(editable, currentLocale())');
    expect(codePaneSource).toContain('"aria-readonly": String(!editable)');
    expect(codePaneSource).toContain('"aria-multiline": "true"');
  });

  it("wraps long source lines inside a resized code pane", () => {
    expect(codePaneSource).toContain("EditorView.lineWrapping");
  });

  it("invalidates stale highlights before mapping a changed source", () => {
    expect(codePaneSource).toContain("selectionHighlights = Object.freeze([])");
    expect(codePaneSource).toContain("diagnosticHighlights = Object.freeze([])");
    expect(codePaneSource).toContain("isHighlightInBounds(highlight, offsetMap.sourceLength)");
  });
});
