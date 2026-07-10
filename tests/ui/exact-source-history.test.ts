import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorState, type StateCommand } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { describe, expect, it } from "vitest";

import { createTextPatch } from "../../src/core/editing/index.js";
import { textRange } from "../../src/core/model.js";
import {
  allowExactSourceInput,
  createExactSourceEdit,
  createExactSourceState,
  exactSourceInputValidator,
  exactSourceExtension,
  getExactSource,
  normalizeSourceForCodeMirror,
  rawSourcePatchesEffect,
} from "../../src/ui/exact-source-history.js";

describe("M3a exact CodeMirror source history", () => {
  it.each([
    ["BOM + LF", "\uFEFFint main(void) {\n  return 0;\n}\n"],
    ["CRLF", "int main(void) {\r\n  return 0;\r\n}\r\n"],
    ["mixed line endings", "a\r\nb\nc\rd\r\n"],
  ])("keeps %s exact while CodeMirror uses logical newlines", (_name, source) => {
    const state = createExactSourceState(source);

    expect(getExactSource(state)).toBe(source);
    expect(state.doc.toString()).toBe(normalizeSourceForCodeMirror(source));
    expect(undoDepth(state)).toBe(0);
    expect(redoDepth(state)).toBe(0);
  });

  it("round-trips BOM and mixed newlines character-for-character through edit, undo and redo", () => {
    const original = "\uFEFFint main(void) {\r\n  int value = 1;\n  return value;\r}\r\n";
    const valueOffset = original.indexOf("1;");
    const insertOffset = original.indexOf("  return");
    let state = createExactSourceState(original);

    const edit = createExactSourceEdit(state, [
      patch(valueOffset, valueOffset + 1, "42"),
      patch(insertOffset, insertOffset, "  // exact\r\n"),
    ]);
    const transaction = state.update(edit);

    expect(transaction.effects.some((effect) => effect.is(rawSourcePatchesEffect))).toBe(true);
    state = transaction.state;
    const edited =
      "\uFEFFint main(void) {\r\n  int value = 42;\n  // exact\r\n  return value;\r}\r\n";
    expect(getExactSource(state)).toBe(edited);
    expect(state.doc.toString()).toBe(normalizeSourceForCodeMirror(edited));
    expect(undoDepth(state)).toBe(1);

    state = runCommand(state, undo);
    expect(getExactSource(state)).toBe(original);
    expect(state.doc.toString()).toBe(normalizeSourceForCodeMirror(original));
    expect(redoDepth(state)).toBe(1);

    state = runCommand(state, redo);
    expect(getExactSource(state)).toBe(edited);
    expect(state.doc.toString()).toBe(normalizeSourceForCodeMirror(edited));
  });

  it("records a multi-patch logical edit as exactly one history event", () => {
    const original = "int a = 1;\r\nint b = 2;\r\nreturn a + b;\r\n";
    let state = createExactSourceState(original);
    const a = original.indexOf("1");
    const b = original.indexOf("2");
    const plus = original.indexOf("+");

    state = state.update(
      createExactSourceEdit(state, [
        patch(a, a + 1, "10"),
        patch(b, b + 1, "20"),
        patch(plus, plus + 1, "-"),
      ]),
    ).state;

    expect(getExactSource(state)).toBe("int a = 10;\r\nint b = 20;\r\nreturn a - b;\r\n");
    expect(undoDepth(state)).toBe(1);
    state = runCommand(state, undo);
    expect(getExactSource(state)).toBe(original);
    expect(undoDepth(state)).toBe(0);
  });

  it("keeps consecutive block edits as separate undo events", () => {
    let state = createExactSourceState("1 + 2\r\n");
    state = state.update(createExactSourceEdit(state, [patch(0, 1, "10")])).state;
    state = state.update(createExactSourceEdit(state, [patch(5, 6, "20")])).state;

    expect(getExactSource(state)).toBe("10 + 20\r\n");
    expect(undoDepth(state)).toBe(2);
    state = runCommand(state, undo);
    expect(getExactSource(state)).toBe("10 + 2\r\n");
    state = runCommand(state, undo);
    expect(getExactSource(state)).toBe("1 + 2\r\n");
  });

  it("tracks exact-only newline edits even when CodeMirror's document is unchanged", () => {
    const original = "a\r\nb\r\nc\n";
    const firstCrlf = original.indexOf("\r\n");
    let state = createExactSourceState(original);

    state = state.update(
      createExactSourceEdit(state, [patch(firstCrlf, firstCrlf + 2, "\n")]),
    ).state;
    const edited = "a\nb\r\nc\n";
    expect(getExactSource(state)).toBe(edited);
    expect(state.doc.toString()).toBe("a\nb\nc\n");
    expect(undoDepth(state)).toBe(1);

    state = runCommand(state, undo);
    expect(getExactSource(state)).toBe(original);
    state = runCommand(state, redo);
    expect(getExactSource(state)).toBe(edited);
  });

  it("rejects document changes that have no matching raw-source effect", () => {
    const source = "int value = 1;\r\n";
    const state = createExactSourceState(source);
    const transaction = state.update({
      changes: {
        from: state.doc.toString().indexOf("1"),
        to: state.doc.toString().indexOf("1") + 1,
        insert: "9",
      },
      userEvent: "input.type",
    });

    expect(transaction.docChanged).toBe(false);
    expect(transaction.state.doc.toString()).toBe(normalizeSourceForCodeMirror(source));
    expect(getExactSource(transaction.state)).toBe(source);
    expect(undoDepth(transaction.state)).toBe(0);
  });

  it("translates opted-in typing into exact CRLF patches and shared history", () => {
    const source = "int value = 1;\r\nreturn value;\r\n";
    let state = createExactSourceState(source, allowExactSourceInput.of(true));
    const one = state.doc.toString().indexOf("1");

    state = state.update({
      changes: { from: one, to: one + 2, insert: "42;\n  value += 1;" },
      userEvent: "input.type",
    }).state;

    expect(getExactSource(state)).toBe("int value = 42;\r\n  value += 1;\r\nreturn value;\r\n");
    expect(state.doc.toString()).toBe("int value = 42;\n  value += 1;\nreturn value;\n");
    expect(undoDepth(state)).toBe(1);
    state = runCommand(state, undo);
    expect(getExactSource(state)).toBe(source);
    state = runCommand(state, redo);
    expect(getExactSource(state)).toContain("42;\r\n  value += 1;");
  });

  it("uses the nearest existing newline convention for mixed-source insertions", () => {
    const source = "a\r\nb\nc\r";
    let state = createExactSourceState(source, allowExactSourceInput.of(true));
    const beforeB = state.doc.toString().indexOf("b");

    state = state.update({
      changes: { from: beforeB, insert: "x\n" },
      userEvent: "input.paste",
    }).state;

    expect(getExactSource(state)).toBe("a\r\nx\nb\nc\r");
  });

  it("rejects an opted-in direct input atomically when a source policy fails", () => {
    const source = "int value = 1;\r\n";
    const state = createExactSourceState(source, [
      allowExactSourceInput.of(true),
      exactSourceInputValidator.of((candidate) => {
        if (candidate.includes("\0")) throw new Error("NUL is forbidden");
      }),
    ]);
    const transaction = state.update({
      changes: { from: state.doc.length, insert: "\0" },
      userEvent: "input.type",
    });

    expect(transaction.docChanged).toBe(false);
    expect(transaction.state.doc.toString()).toBe(normalizeSourceForCodeMirror(source));
    expect(getExactSource(transaction.state)).toBe(source);
    expect(undoDepth(transaction.state)).toBe(0);
  });

  it("rejects a forged effect whose raw candidate disagrees with the CodeMirror change", () => {
    const source = "abc\r\n";
    const state = createExactSourceState(source);
    const transaction = state.update({
      changes: { from: 1, to: 2, insert: "X" },
      effects: rawSourcePatchesEffect.of([patch(1, 2, "Y")]),
    });

    expect(transaction.docChanged).toBe(false);
    expect(getExactSource(transaction.state)).toBe(source);
    expect(transaction.state.doc.toString()).toBe("abc\n");
  });

  it("creates a fresh import state with empty undo and redo branches", () => {
    let editedState = createExactSourceState("old\r\n");
    editedState = editedState.update(
      createExactSourceEdit(editedState, [patch(0, 3, "edited")]),
    ).state;
    editedState = runCommand(editedState, undo);
    expect(redoDepth(editedState)).toBe(1);

    const imported = createExactSourceState("\uFEFFnew\n");
    expect(getExactSource(imported)).toBe("\uFEFFnew\n");
    expect(undoDepth(imported)).toBe(0);
    expect(redoDepth(imported)).toBe(0);
    expect(runCommand(imported, undo)).toBe(imported);
    expect(runCommand(imported, redo)).toBe(imported);
  });

  it("can install the exact-source layer into a caller-owned state configuration", () => {
    const source = "a\r\nb\n";
    const state = EditorState.create({
      doc: normalizeSourceForCodeMirror(source),
      extensions: exactSourceExtension(source),
    });

    expect(getExactSource(state)).toBe(source);
  });

  it("deduplicates the history field when the caller also supplies basicSetup", () => {
    let state = createExactSourceState("value\r\n", basicSetup);
    state = state.update(createExactSourceEdit(state, [patch(0, 5, "next")])).state;

    expect(undoDepth(state)).toBe(1);
    expect(getExactSource(runCommand(state, undo))).toBe("value\r\n");
  });
});

function patch(from: number, to: number, newText: string) {
  return createTextPatch(textRange(from, to), newText);
}

function runCommand(state: EditorState, command: StateCommand): EditorState {
  let next = state;
  const handled = command({
    state,
    dispatch(transaction) {
      next = transaction.state;
    },
  });
  expect(handled).toBe(state === next ? false : true);
  return next;
}
