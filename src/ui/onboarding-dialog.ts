import {
  createOnboardingFlow,
  getOnboardingScene,
  type OnboardingState,
  type OnboardingStorage,
} from "../onboarding/flow.js";

export interface OnboardingDialogOptions {
  readonly storage?: OnboardingStorage | undefined;
  readonly autoOpen?: boolean;
}

export interface OnboardingDialog {
  readonly element: HTMLDialogElement;
  getState(): OnboardingState;
  /** Reopens the deterministic tour from its first scene after a Dock command. */
  openFromDock(): void;
  destroy(): void;
}

export function createOnboardingDialog(
  host: HTMLElement,
  options: OnboardingDialogOptions = {},
): OnboardingDialog {
  const ownerDocument = host.ownerDocument;
  const flow = createOnboardingFlow({ storage: options.storage });
  const dialog = ownerDocument.createElement("dialog");
  dialog.className = "onboarding-dialog";
  dialog.setAttribute("aria-labelledby", "onboarding-title");
  dialog.setAttribute("aria-describedby", "onboarding-dialogue");

  const surface = ownerDocument.createElement("section");
  surface.className = "onboarding-dialog__surface";
  const header = ownerDocument.createElement("header");
  header.className = "onboarding-dialog__header";
  const title = ownerDocument.createElement("h2");
  title.id = "onboarding-title";
  title.textContent = "工作台新手指导";
  const speaker = ownerDocument.createElement("p");
  speaker.className = "onboarding-dialog__speaker";
  const dialogue = ownerDocument.createElement("p");
  dialogue.id = "onboarding-dialogue";
  dialogue.className = "onboarding-dialog__dialogue";
  dialogue.setAttribute("aria-live", "polite");
  dialogue.setAttribute("aria-atomic", "true");
  header.append(title, speaker, dialogue);

  const choices = ownerDocument.createElement("div");
  choices.className = "onboarding-dialog__choices";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "请选择回答");

  const actions = ownerDocument.createElement("footer");
  actions.className = "onboarding-dialog__actions";
  const backButton = textButton(ownerDocument, "上一步", "onboarding-dialog__back");
  const skipButton = textButton(ownerDocument, "跳过引导", "onboarding-dialog__skip");
  skipButton.setAttribute("aria-keyshortcuts", "Escape");
  actions.append(backButton, skipButton);
  surface.append(header, choices, actions);
  dialog.append(surface);
  host.append(dialog);

  let destroyed = false;
  let choiceButtons: HTMLButtonElement[] = [];
  let returnFocus: HTMLElement | null = null;

  const focusFirstChoice = (): void => {
    choiceButtons[0]?.focus();
  };

  const render = (): void => {
    assertActive(destroyed);
    const state = flow.getState();
    const scene = getOnboardingScene(state);
    dialog.dataset.stepId = scene.stepId;
    speaker.textContent = scene.speaker;
    dialogue.textContent = scene.dialogue;
    backButton.disabled = !scene.canGoBack;
    choiceButtons = scene.choices.map((choice) => {
      const button = textButton(ownerDocument, choice.label, "onboarding-dialog__choice");
      button.dataset.onboardingChoice = choice.id;
      button.addEventListener("click", () => {
        if (destroyed) return;
        const next = flow.choose(choice.id);
        if (next.status === "closed") {
          closeForCompletion(dialog, next);
          return;
        }
        render();
        focusFirstChoice();
      });
      return button;
    });
    choices.replaceChildren(...choiceButtons);
  };

  const show = (): void => {
    assertActive(destroyed);
    render();
    if (!dialog.open) {
      const activeElement = ownerDocument.activeElement;
      returnFocus = isFocusable(activeElement) ? activeElement : null;
      dialog.showModal();
    }
    focusFirstChoice();
  };

  const onBack = (): void => {
    if (destroyed || backButton.disabled) return;
    flow.back();
    render();
    focusFirstChoice();
  };
  const onSkip = (): void => {
    if (destroyed) return;
    closeForCompletion(dialog, flow.skip());
  };
  const onCancel = (event: Event): void => {
    event.preventDefault();
    onSkip();
  };
  const onClose = (): void => {
    returnFocus?.focus();
    returnFocus = null;
  };
  const onChoiceKeydown = (event: KeyboardEvent): void => {
    if (destroyed || choiceButtons.length === 0) return;
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      return;
    }
    const currentIndex = Math.max(0, choiceButtons.indexOf(event.target as HTMLButtonElement));
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choiceButtons.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? (currentIndex + 1) % choiceButtons.length
            : (currentIndex - 1 + choiceButtons.length) % choiceButtons.length;
    event.preventDefault();
    choiceButtons[nextIndex]?.focus();
  };

  backButton.addEventListener("click", onBack);
  skipButton.addEventListener("click", onSkip);
  choices.addEventListener("keydown", onChoiceKeydown);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("close", onClose);

  if (flow.getState().status === "open" && options.autoOpen !== false) show();

  return Object.freeze({
    element: dialog,
    getState: () => flow.getState(),
    openFromDock(): void {
      assertActive(destroyed);
      flow.reopen();
      show();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      backButton.removeEventListener("click", onBack);
      skipButton.removeEventListener("click", onSkip);
      choices.removeEventListener("keydown", onChoiceKeydown);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close("destroyed");
      dialog.remove();
      choiceButtons = [];
      returnFocus = null;
    },
  });
}

function textButton(ownerDocument: Document, label: string, className: string): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  return button;
}

function closeForCompletion(dialog: HTMLDialogElement, state: OnboardingState): void {
  if (state.status !== "closed" || state.completion === null) {
    throw new Error("新手引导尚未完成或跳过");
  }
  if (dialog.open) dialog.close(state.completion);
}

function isFocusable(element: Element | null): element is HTMLElement {
  return element !== null && "focus" in element && typeof element.focus === "function";
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("新手引导对话框已销毁");
}
