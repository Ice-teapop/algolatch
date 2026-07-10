import {
  createOnboardingFlow,
  getOnboardingScene,
  type OnboardingPlacement,
  type OnboardingState,
  type OnboardingStorage,
} from "../onboarding/flow.js";

export interface OnboardingTourOptions {
  readonly storage?: OnboardingStorage | undefined;
  readonly navigate: (pageId: string) => void;
  readonly getCurrentPage: () => string;
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface OnboardingTour {
  readonly element: HTMLElement;
  getState(): OnboardingState;
  startIfNeeded(): void;
  openFromLibrary(): void;
  skip(): void;
  destroy(): void;
}

export interface TourCardPosition {
  readonly left: number;
  readonly top: number;
}

interface TargetRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const VIEWPORT_MARGIN = 12;
const TARGET_GAP = 12;
const SPOTLIGHT_PADDING = 5;

export function createOnboardingTour(
  host: HTMLElement,
  options: OnboardingTourOptions,
): OnboardingTour {
  assertOptions(options);
  const ownerDocument = host.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const scheduleFrame =
    options.scheduleFrame ??
    ownerWindow?.requestAnimationFrame.bind(ownerWindow) ??
    ((callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(0), 0) as unknown as number);
  const cancelFrame =
    options.cancelFrame ??
    ownerWindow?.cancelAnimationFrame.bind(ownerWindow) ??
    ((handle: number) => globalThis.clearTimeout(handle));
  const flow = createOnboardingFlow({ storage: options.storage });

  const root = ownerDocument.createElement("section");
  root.className = "onboarding-tour";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "onboarding-tour-title");
  root.setAttribute("aria-describedby", "onboarding-tour-dialogue");

  const spotlight = ownerDocument.createElement("div");
  spotlight.className = "onboarding-tour__spotlight";
  spotlight.setAttribute("aria-hidden", "true");
  const card = ownerDocument.createElement("section");
  card.className = "onboarding-tour__card";
  const header = ownerDocument.createElement("header");
  const progress = ownerDocument.createElement("span");
  progress.className = "onboarding-tour__progress";
  const title = ownerDocument.createElement("h2");
  title.id = "onboarding-tour-title";
  title.textContent = "功能引导";
  const speaker = ownerDocument.createElement("strong");
  speaker.className = "onboarding-tour__speaker";
  const dialogue = ownerDocument.createElement("p");
  dialogue.id = "onboarding-tour-dialogue";
  dialogue.className = "onboarding-tour__dialogue";
  dialogue.setAttribute("aria-live", "polite");
  dialogue.setAttribute("aria-atomic", "true");
  header.append(progress, title, speaker, dialogue);
  const choices = ownerDocument.createElement("div");
  choices.className = "onboarding-tour__choices";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "引导回答");
  const footer = ownerDocument.createElement("footer");
  const back = textButton(ownerDocument, "上一步", "onboarding-tour__back");
  const skip = textButton(ownerDocument, "跳过", "onboarding-tour__skip");
  footer.append(back, skip);
  card.append(header, choices, footer);
  root.append(spotlight, card);
  host.append(root);

  let destroyed = false;
  let frameHandles: number[] = [];
  let choiceButtons: HTMLButtonElement[] = [];
  let activeTarget: HTMLElement | null = null;
  let returnFocus: HTMLElement | null = null;
  let startingPage: string | null = null;
  const backgroundInertState = new Map<HTMLElement, boolean>();

  const clearFrames = (): void => {
    for (const handle of frameHandles) cancelFrame(handle);
    frameHandles = [];
  };

  const clearTarget = (): void => {
    activeTarget?.removeAttribute("data-tour-active");
    activeTarget = null;
    spotlight.hidden = true;
  };

  const lockBackground = (): void => {
    for (const sibling of host.children) {
      if (!(sibling instanceof HTMLElement) || sibling === root) continue;
      if (!backgroundInertState.has(sibling)) backgroundInertState.set(sibling, sibling.inert);
      sibling.inert = true;
    }
  };

  const unlockBackground = (): void => {
    for (const [sibling, wasInert] of backgroundInertState) sibling.inert = wasInert;
    backgroundInertState.clear();
  };

  const position = (): void => {
    if (destroyed || root.hidden) return;
    const scene = getOnboardingScene(flow.getState());
    clearTarget();
    const target = findTourTarget(ownerDocument, scene.targetId);
    if (target === null) {
      centerCard(card, ownerWindow);
      return;
    }
    activeTarget = target;
    target.dataset.tourActive = "true";
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    const targetRect = target.getBoundingClientRect();
    spotlight.hidden = false;
    spotlight.style.left = `${String(Math.max(0, targetRect.left - SPOTLIGHT_PADDING))}px`;
    spotlight.style.top = `${String(Math.max(0, targetRect.top - SPOTLIGHT_PADDING))}px`;
    spotlight.style.width = `${String(targetRect.width + SPOTLIGHT_PADDING * 2)}px`;
    spotlight.style.height = `${String(targetRect.height + SPOTLIGHT_PADDING * 2)}px`;
    const viewportWidth = ownerWindow?.innerWidth ?? ownerDocument.documentElement.clientWidth;
    const viewportHeight = ownerWindow?.innerHeight ?? ownerDocument.documentElement.clientHeight;
    const cardRect = card.getBoundingClientRect();
    const cardPosition = calculateTourCardPosition(
      targetRect,
      { width: cardRect.width || 360, height: cardRect.height || 210 },
      { width: viewportWidth, height: viewportHeight },
      scene.placement,
    );
    card.style.left = `${String(cardPosition.left)}px`;
    card.style.top = `${String(cardPosition.top)}px`;
  };

  const schedulePosition = (): void => {
    clearFrames();
    let first = 0;
    first = scheduleFrame(() => {
      frameHandles = frameHandles.filter((handle) => handle !== first);
      let second = 0;
      second = scheduleFrame(() => {
        frameHandles = frameHandles.filter((handle) => handle !== second);
        position();
      });
      frameHandles.push(second);
    });
    frameHandles.push(first);
  };

  const close = (restorePage: boolean): void => {
    clearFrames();
    clearTarget();
    root.hidden = true;
    unlockBackground();
    if (restorePage && startingPage !== null) options.navigate(startingPage);
    returnFocus?.focus();
    returnFocus = null;
    startingPage = null;
  };

  const render = (): void => {
    assertActive(destroyed);
    const state = flow.getState();
    if (state.status === "closed") {
      close(false);
      return;
    }
    const scene = getOnboardingScene(state);
    root.dataset.stepId = scene.stepId;
    root.dataset.pageId = scene.pageId;
    root.dataset.targetId = scene.targetId;
    progress.textContent = `${String(scene.stepIndex)} / ${String(scene.stepCount)}`;
    speaker.textContent = scene.speaker;
    dialogue.textContent = scene.dialogue;
    back.disabled = !scene.canGoBack;
    choiceButtons = scene.choices.map((choice) => {
      const button = textButton(ownerDocument, choice.label, "onboarding-tour__choice");
      button.dataset.onboardingChoice = choice.id;
      button.addEventListener("click", () => {
        if (destroyed) return;
        const next = flow.choose(choice.id);
        if (next.status === "closed") {
          close(false);
          return;
        }
        render();
        choiceButtons[0]?.focus();
      });
      return button;
    });
    choices.replaceChildren(...choiceButtons);
    options.navigate(scene.pageId);
    schedulePosition();
  };

  const open = (): void => {
    assertActive(destroyed);
    if (flow.getState().status !== "open") return;
    if (root.hidden) {
      const activeElement = ownerDocument.activeElement;
      returnFocus = isFocusable(activeElement) ? activeElement : null;
      startingPage = options.getCurrentPage();
      root.hidden = false;
      lockBackground();
    }
    render();
    choiceButtons[0]?.focus();
  };

  const onBack = (): void => {
    if (destroyed || back.disabled) return;
    flow.back();
    render();
    choiceButtons[0]?.focus();
  };
  const onSkip = (): void => {
    if (destroyed || flow.getState().status !== "open") return;
    flow.skip();
    close(true);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (root.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onSkip();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const currentIndex = focusable.indexOf(ownerDocument.activeElement as HTMLButtonElement);
      const shouldWrapBackward = event.shiftKey && currentIndex <= 0;
      const shouldWrapForward = !event.shiftKey && currentIndex === focusable.length - 1;
      if (shouldWrapBackward || shouldWrapForward || currentIndex < 0) {
        event.preventDefault();
        focusable[shouldWrapBackward ? focusable.length - 1 : 0]?.focus();
      }
    }
  };
  const onViewportChange = (): void => {
    if (!root.hidden) schedulePosition();
  };

  back.addEventListener("click", onBack);
  skip.addEventListener("click", onSkip);
  ownerDocument.addEventListener("keydown", onKeydown);
  ownerWindow?.addEventListener("resize", onViewportChange);
  ownerWindow?.addEventListener("scroll", onViewportChange, true);

  return Object.freeze({
    element: root,
    getState: () => flow.getState(),
    startIfNeeded: open,
    openFromLibrary(): void {
      assertActive(destroyed);
      flow.reopen();
      open();
    },
    skip: onSkip,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearFrames();
      clearTarget();
      unlockBackground();
      back.removeEventListener("click", onBack);
      skip.removeEventListener("click", onSkip);
      ownerDocument.removeEventListener("keydown", onKeydown);
      ownerWindow?.removeEventListener("resize", onViewportChange);
      ownerWindow?.removeEventListener("scroll", onViewportChange, true);
      root.remove();
      choiceButtons = [];
      returnFocus = null;
      startingPage = null;
    },
  });
}

export function calculateTourCardPosition(
  target: TargetRect,
  card: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  placement: OnboardingPlacement,
): TourCardPosition {
  const centeredLeft = target.left + (target.width - card.width) / 2;
  const centeredTop = target.top + (target.height - card.height) / 2;
  let left = centeredLeft;
  let top = centeredTop;
  if (placement === "right") {
    left = target.right + TARGET_GAP;
    top = target.top;
  } else if (placement === "left") {
    left = target.left - card.width - TARGET_GAP;
    top = target.top;
  } else if (placement === "bottom") {
    left = centeredLeft;
    top = target.bottom + TARGET_GAP;
  } else if (placement === "top") {
    left = centeredLeft;
    top = target.top - card.height - TARGET_GAP;
  }
  if (placement === "right" && left + card.width > viewport.width - VIEWPORT_MARGIN) {
    left = target.left - card.width - TARGET_GAP;
  }
  if (placement === "left" && left < VIEWPORT_MARGIN) left = target.right + TARGET_GAP;
  if (placement === "bottom" && top + card.height > viewport.height - VIEWPORT_MARGIN) {
    top = target.top - card.height - TARGET_GAP;
  }
  if (placement === "top" && top < VIEWPORT_MARGIN) top = target.bottom + TARGET_GAP;
  return Object.freeze({
    left: clamp(
      left,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN),
    ),
    top: clamp(
      top,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, viewport.height - card.height - VIEWPORT_MARGIN),
    ),
  });
}

function centerCard(card: HTMLElement, ownerWindow: Window | null): void {
  const viewportWidth = ownerWindow?.innerWidth ?? card.ownerDocument.documentElement.clientWidth;
  const viewportHeight =
    ownerWindow?.innerHeight ?? card.ownerDocument.documentElement.clientHeight;
  const bounds = card.getBoundingClientRect();
  card.style.left = `${String(Math.max(VIEWPORT_MARGIN, (viewportWidth - bounds.width) / 2))}px`;
  card.style.top = `${String(Math.max(VIEWPORT_MARGIN, (viewportHeight - bounds.height) / 2))}px`;
}

function findTourTarget(ownerDocument: Document, targetId: string): HTMLElement | null {
  for (const target of ownerDocument.querySelectorAll<HTMLElement>("[data-tour-target]")) {
    if (target.dataset.tourTarget === targetId && !target.hidden) return target;
  }
  return null;
}

function textButton(ownerDocument: Document, label: string, className: string): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  return button;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isFocusable(element: Element | null): element is HTMLElement {
  return element !== null && "focus" in element && typeof element.focus === "function";
}

function assertOptions(options: OnboardingTourOptions): void {
  if (typeof options.navigate !== "function" || typeof options.getCurrentPage !== "function") {
    throw new TypeError("Onboarding tour options 无效");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("Onboarding tour 已销毁");
}
