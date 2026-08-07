export type CCommandKeyboardAction =
  "submit" | "cancel" | "history-previous" | "history-next" | null;

export interface CCommandKeyboardState {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export function resolveCCommandKeyboardAction(
  state: CCommandKeyboardState,
): CCommandKeyboardAction {
  if (
    state.key === "Enter" &&
    (state.metaKey || state.ctrlKey) &&
    !state.altKey &&
    !state.shiftKey
  ) {
    return "submit";
  }
  if (
    state.key === "Escape" &&
    !state.metaKey &&
    !state.ctrlKey &&
    !state.altKey &&
    !state.shiftKey
  ) {
    return "cancel";
  }
  if (
    state.selectionStart !== state.selectionEnd ||
    state.metaKey ||
    state.ctrlKey ||
    state.altKey ||
    state.shiftKey
  ) {
    return null;
  }
  if (
    state.key === "ArrowUp" &&
    state.value.lastIndexOf("\n", Math.max(0, state.selectionStart - 1)) < 0
  ) {
    return "history-previous";
  }
  if (state.key === "ArrowDown" && state.value.indexOf("\n", state.selectionEnd) < 0) {
    return "history-next";
  }
  return null;
}
