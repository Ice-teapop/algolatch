import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";

import {
  resolveCCommandKeyboardAction,
  type CCommandKeyboardAction,
} from "./c-command-keyboard.js";

export interface CCommandEditorOptions {
  readonly initialValue: string;
  readonly ariaLabelledBy: string;
  readonly ariaDescribedBy: string;
  readonly placeholderText: string;
  readonly onInput: () => void;
  readonly onKeyAction: (action: Exclude<CCommandKeyboardAction, null>) => boolean;
}

export interface CCommandEditor {
  readonly contentElement: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  setPlaceholder(value: string): void;
  setBusy(busy: boolean): void;
  setCursorTo(position: "start" | "end"): void;
  focus(): void;
  destroy(): void;
}

/** CodeMirror-backed C Cell editor with normal C indentation, wrapping and history keys. */
export function createCCommandEditor(
  host: HTMLElement,
  options: CCommandEditorOptions,
): CCommandEditor {
  const placeholderCompartment = new Compartment();
  const editableCompartment = new Compartment();
  let destroyed = false;
  let suppressInput = false;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.initialValue,
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => options.onKeyAction("submit"),
            },
          ]),
        ),
        basicSetup,
        cpp(),
        EditorView.lineWrapping,
        keymap.of([indentWithTab]),
        placeholderCompartment.of(placeholder(options.placeholderText)),
        editableCompartment.of(EditorView.editable.of(true)),
        EditorView.contentAttributes.of({
          "aria-labelledby": options.ariaLabelledBy,
          "aria-describedby": options.ariaDescribedBy,
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressInput) options.onInput();
        }),
        EditorView.domEventHandlers({
          keydown(event, activeView) {
            const selection = activeView.state.selection.main;
            const action = resolveCCommandKeyboardAction({
              key: event.key,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              shiftKey: event.shiftKey,
              value: activeView.state.doc.toString(),
              selectionStart: selection.from,
              selectionEnd: selection.to,
            });
            if (action === null) return false;
            const consumed = options.onKeyAction(action);
            if (consumed) event.preventDefault();
            return consumed;
          },
        }),
      ],
    }),
  });

  const assertActive = (): void => {
    if (destroyed) throw new Error("C Cell editor 已销毁");
  };

  return Object.freeze({
    contentElement: view.contentDOM,
    getValue(): string {
      assertActive();
      return view.state.doc.toString();
    },
    setValue(value: string): void {
      assertActive();
      suppressInput = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
          selection: EditorSelection.cursor(value.length),
        });
      } finally {
        suppressInput = false;
      }
    },
    setPlaceholder(value: string): void {
      assertActive();
      view.dispatch({ effects: placeholderCompartment.reconfigure(placeholder(value)) });
    },
    setBusy(busy: boolean): void {
      assertActive();
      view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(!busy)) });
      view.contentDOM.setAttribute("aria-busy", String(busy));
    },
    setCursorTo(position: "start" | "end"): void {
      assertActive();
      const offset = position === "start" ? 0 : view.state.doc.length;
      view.dispatch({ selection: EditorSelection.cursor(offset), scrollIntoView: true });
    },
    focus(): void {
      if (!destroyed) view.focus();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
    },
  });
}
