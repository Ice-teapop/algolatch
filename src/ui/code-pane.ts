import { basicSetup } from "codemirror";
import {
  redo as redoCommand,
  redoDepth,
  undo as undoCommand,
  undoDepth,
} from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import type { TextPatch } from "../core/editing/index.js";
import type { TextRange } from "../core/model.js";
import {
  createSourceOffsetMap,
  editorToSource,
  sourceToEditor,
  type SourceOffsetMap,
} from "../renderer/source-offset-map.js";
import {
  allowExactSourceInput,
  createExactSourceEdit,
  createExactSourceState,
  exactSourceInputValidator,
  getExactSource,
} from "./exact-source-history.js";

export type CodeHighlightKind = "primary" | "symbol-declaration" | "symbol-use";

export interface CodeHighlight {
  readonly range: TextRange;
  readonly kind: CodeHighlightKind;
  readonly title?: string;
}

export interface CodePaneInputOptions {
  /** Direct typing is opt-in; programmatic exact-source edits remain available in either mode. */
  readonly editable?: boolean;
  /** Throws synchronously when a direct-input candidate must not enter editor history. */
  readonly validateSource?: (candidateSource: string) => void;
  /** Receives the policy error while the rejected transaction still observes the prior state. */
  readonly onInputRejected?: (error: unknown) => void;
}

export interface CodePaneOptions extends CodePaneInputOptions {
  readonly onSourceOffset: (sourceOffset: number) => void;
  readonly onSourceChange?: (source: string, reason: CodeSourceChangeReason) => void;
}

export type CodeSourceChangeReason = "edit" | "undo" | "redo";

export interface CodePaneHistoryDepth {
  readonly undo: number;
  readonly redo: number;
}

export interface CodePane {
  setSource(source: string): void;
  applyPatches(patches: readonly TextPatch[]): boolean;
  undo(): boolean;
  redo(): boolean;
  getSource(): string;
  getHistoryDepth(): CodePaneHistoryDepth;
  setHighlights(highlights: readonly CodeHighlight[]): void;
  reveal(sourceRange: TextRange): void;
  destroy(): void;
}

export interface EditorRange {
  readonly from: number;
  readonly to: number;
}

const programmaticSelection = Annotation.define<boolean>();
const replaceHighlights = StateEffect.define<DecorationSet>();

const industrialSyntaxHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  {
    tag: [tags.string, tags.character, tags.escape, tags.special(tags.string)],
    color: "var(--syntax-string)",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syntax-number)" },
  { tag: tags.comment, color: "var(--syntax-comment)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--syntax-function)",
  },
  {
    tag: [tags.macroName, tags.processingInstruction, tags.special(tags.name), tags.meta],
    color: "var(--syntax-macro)",
  },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  {
    tag: tags.invalid,
    color: "var(--syntax-invalid)",
    textDecoration: "underline wavy var(--syntax-invalid)",
  },
]);

const industrialSyntaxHighlighting = syntaxHighlighting(industrialSyntaxHighlightStyle);

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(highlights, transaction) {
    let next = highlights.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(replaceHighlights)) {
        next = effect.value;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Creates an exact-source CodeMirror surface whose direct typing is explicitly opt-in. */
export function createCodePane(host: HTMLElement, options: CodePaneOptions): CodePane {
  const editable = options.editable ?? false;
  const inputExtensions = createCodePaneInputExtensions(options);
  let exactSource = "";
  let offsetMap = createSourceOffsetMap(exactSource);
  let destroyed = false;
  let sourceNotification = 0;

  const mount = document.createElement("div");
  mount.className = "code-pane__editor";
  host.append(mount);

  const editorExtensions = [
    basicSetup,
    // C parsing here is presentation-only; it never replaces the application's source model.
    cpp(),
    // A non-fallback style prevents CodeMirror's light default palette from leaking into
    // either industrial theme. CSS variables make a theme switch re-style existing tokens.
    industrialSyntaxHighlighting,
    // Direct input is an explicit capability. EditorState stays writable in
    // both modes so official undo/redo can replay exact programmatic patches.
    inputExtensions,
    EditorView.cspNonce.of(__CODEMIRROR_STYLE_NONCE__),
    EditorView.contentAttributes.of({
      "aria-label": editable ? "C 源码编辑器" : "C 源码（只读）",
      "aria-readonly": String(!editable),
      "aria-multiline": "true",
      tabindex: "0",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
    }),
    highlightField,
    EditorView.updateListener.of((update) => {
      const nextSource = getExactSource(update.state);
      const sourceChanged = nextSource !== exactSource;
      if (sourceChanged) {
        exactSource = nextSource;
        offsetMap = createSourceOffsetMap(nextSource);
        const reason = sourceChangeReason(update.transactions);
        const notification = ++sourceNotification;
        queueMicrotask(() => {
          if (!destroyed && notification === sourceNotification) {
            options.onSourceChange?.(nextSource, reason);
          }
        });
      }

      if (sourceChanged || !update.selectionSet || isProgrammatic(update.transactions)) {
        return;
      }
      options.onSourceOffset(editorToSource(offsetMap, update.state.selection.main.head));
    }),
  ];
  const state = createExactSourceState("", editorExtensions);
  const view = new EditorView({ state, parent: mount });

  return {
    setSource(source) {
      assertActive(destroyed);
      if (typeof source !== "string") {
        throw new TypeError("source 必须是字符串");
      }

      exactSource = source;
      offsetMap = createSourceOffsetMap(source);
      sourceNotification += 1;
      view.setState(createExactSourceState(source, editorExtensions));
    },

    applyPatches(patches) {
      assertActive(destroyed);
      const before = getExactSource(view.state);
      view.dispatch(createExactSourceEdit(view.state, patches));
      return getExactSource(view.state) !== before;
    },

    undo() {
      assertActive(destroyed);
      return undoCommand(view);
    },

    redo() {
      assertActive(destroyed);
      return redoCommand(view);
    },

    getSource() {
      assertActive(destroyed);
      return getExactSource(view.state);
    },

    getHistoryDepth() {
      assertActive(destroyed);
      return Object.freeze({
        undo: undoDepth(view.state),
        redo: redoDepth(view.state),
      });
    },

    setHighlights(highlights) {
      assertActive(destroyed);
      const decorations = highlights.map((highlight) => {
        assertHighlightKind(highlight.kind);
        if (highlight.title !== undefined && typeof highlight.title !== "string") {
          throw new TypeError("highlight.title 必须是字符串");
        }

        const range = sourceRangeToEditorRange(offsetMap, highlight.range, false);
        const attributes: Record<string, string> = {
          "data-code-highlight": "true",
          "data-code-highlight-kind": highlight.kind,
          ...(highlight.title === undefined ? {} : { title: highlight.title }),
        };
        return Decoration.mark({
          class: `code-pane-highlight code-pane-highlight--${highlight.kind}`,
          attributes,
        }).range(range.from, range.to);
      });

      view.dispatch({
        effects: replaceHighlights.of(Decoration.set(decorations, true)),
        annotations: [programmaticSelection.of(true), Transaction.addToHistory.of(false)],
      });
    },

    reveal(sourceRange) {
      assertActive(destroyed);
      const range = sourceRangeToEditorRange(offsetMap, sourceRange, true);
      const selection = EditorSelection.range(range.from, range.to);
      view.dispatch({
        selection,
        effects: EditorView.scrollIntoView(selection, { y: "center", x: "nearest" }),
        annotations: [programmaticSelection.of(true), Transaction.addToHistory.of(false)],
      });
    },

    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      sourceNotification += 1;
      view.destroy();
      mount.remove();
    },
  };
}

/** Builds the direct-input gate separately so its atomic behavior can be verified without a DOM. */
export function createCodePaneInputExtensions(options: CodePaneInputOptions): Extension {
  const editable = options.editable ?? false;
  if (typeof editable !== "boolean") {
    throw new TypeError("editable 必须是布尔值");
  }
  return [
    EditorView.editable.of(editable),
    ...(editable
      ? [
          allowExactSourceInput.of(true),
          exactSourceInputValidator.of((candidateSource) => {
            try {
              options.validateSource?.(candidateSource);
            } catch (error: unknown) {
              options.onInputRejected?.(error);
              throw error;
            }
          }),
        ]
      : []),
  ];
}

function isProgrammatic(transactions: readonly Transaction[]): boolean {
  return transactions.some((transaction) => transaction.annotation(programmaticSelection) === true);
}

function sourceChangeReason(transactions: readonly Transaction[]): CodeSourceChangeReason {
  if (transactions.some((transaction) => transaction.isUserEvent("undo"))) {
    return "undo";
  }
  if (transactions.some((transaction) => transaction.isUserEvent("redo"))) {
    return "redo";
  }
  return "edit";
}

export function sourceRangeToEditorRange(
  map: SourceOffsetMap,
  range: TextRange,
  allowEmpty: boolean,
): EditorRange {
  // CodeMirror represents CRLF as one logical newline. A parser-owned display
  // range may end between CR and LF (for example a line comment including CR),
  // so presentation must use the offset map's documented left bias. Exact
  // source edits remain guarded independently by exact-source-history.
  const from = sourceToEditor(map, range.from);
  const to = sourceToEditor(map, range.to);
  if (from > to || (!allowEmpty && from === to)) {
    throw new RangeError("source range 必须按顺序且不能是空范围");
  }
  return { from, to };
}

function assertHighlightKind(kind: CodeHighlightKind): void {
  if (kind !== "primary" && kind !== "symbol-declaration" && kind !== "symbol-use") {
    throw new TypeError(`未知的 highlight kind: ${String(kind)}`);
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) {
    throw new Error("CodePane 已销毁");
  }
}
