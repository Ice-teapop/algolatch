import {
  assessCCommandDraft,
  buildCCommandProjection,
  canPublishCCommandProjection,
  createCCommandController,
  type CCommandController,
  type CCommandExecutionHooks,
  type CCommandExecutionState,
  type CCommandProjection,
  type CCommandProjectionAssessment,
  type CCommandRuntimeInput,
} from "../app/c-command-controller.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import { getCCommandCopy } from "./c-command-copy.js";
import type { CCommandKeyboardAction } from "./c-command-keyboard.js";
import {
  createCCommandSubmissionArticle,
  type RenderedCCommandSubmission,
  updateCCommandSubmissionArticle,
} from "./c-command-result-view.js";
import { createCCommandEditor, type CCommandEditor } from "./c-command-editor.js";
import { sourceMayNeedRuntimeInput } from "./manual-run-input.js";

const TRANSCRIPT_PIN_TOLERANCE_PX = 24;
let nextCCommandSurfaceId = 1;

export interface CCommandWriteRequest {
  readonly source: string;
  readonly originalInput: string;
  readonly projection: CCommandProjection;
}

export interface CCommandSurfaceOptions {
  readonly hooks: CCommandExecutionHooks;
  readonly locale?: InterfaceLocale | undefined;
  readonly sourceName?: string | undefined;
  readonly initialValue?: string | undefined;
  readonly getRuntimeInput?: (() => CCommandRuntimeInput | null) | undefined;
  readonly onProjectionChange?: ((projection: CCommandProjection | null) => void) | undefined;
  readonly assessProjection?:
    | ((
        projection: CCommandProjection,
      ) => CCommandProjectionAssessment | Promise<CCommandProjectionAssessment>)
    | undefined;
  readonly onRequestWriteSource?:
    ((request: CCommandWriteRequest) => void | Promise<void>) | undefined;
  readonly onExecutionStateChange?: ((state: CCommandExecutionState) => void) | undefined;
}

export interface CCommandSurface {
  readonly element: HTMLElement;
  readonly editor: CCommandEditor;
  focus(): void;
  setLocale(locale: InterfaceLocale): void;
  setValue(value: string): void;
  /** Drops every rendered result. The transcript belongs to one workspace entry, not to the app. */
  clearTranscript(): void;
  submit(): Promise<CCommandExecutionState | null>;
  cancel(): Promise<boolean>;
  destroy(): Promise<void>;
}

export {
  resolveCCommandKeyboardAction,
  type CCommandKeyboardAction,
  type CCommandKeyboardState,
} from "./c-command-keyboard.js";

export function createCCommandSurface(
  host: HTMLElement,
  options: CCommandSurfaceOptions,
): CCommandSurface {
  const ownerDocument = host.ownerDocument;
  const localeHost = host.closest?.<HTMLElement>("[data-locale], #workbench-shell") ?? null;
  let locale: InterfaceLocale =
    options.locale ?? (localeHost?.dataset.locale === "en" ? "en" : "zh-CN");
  let copy = getCCommandCopy(locale);
  let destroyed = false;
  let suppressHistoryReset = false;
  const renderedSubmissions = new Map<string, RenderedCCommandSubmission>();
  let projectionRevision = 0;
  let hasPublishedProjection = false;
  const surfaceId = nextCCommandSurfaceId;
  nextCCommandSurfaceId += 1;
  const headingId = `c-cell-heading-${String(surfaceId)}`;
  const inputLabelId = `c-cell-input-label-${String(surfaceId)}`;
  const hintId = `c-cell-hint-${String(surfaceId)}`;
  const validationId = `c-cell-validation-${String(surfaceId)}`;
  const projectionStatusId = `c-cell-projection-${String(surfaceId)}`;
  const stdinLabelId = `c-cell-stdin-label-${String(surfaceId)}`;

  const root = ownerDocument.createElement("section");
  root.className = "c-command";
  root.setAttribute("aria-labelledby", headingId);
  const headingGroup = ownerDocument.createElement("header");
  headingGroup.className = "c-command__heading";
  const heading = ownerDocument.createElement("h2");
  heading.id = headingId;
  heading.textContent = copy.heading;
  const description = ownerDocument.createElement("p");
  description.textContent = copy.description;
  headingGroup.append(heading, description);

  const transcript = ownerDocument.createElement("div");
  transcript.className = "c-command__transcript";
  configureCCommandTranscript(transcript);

  const composer = ownerDocument.createElement("form");
  composer.className = "c-command__composer";
  composer.noValidate = true;
  const inputLabel = ownerDocument.createElement("span");
  inputLabel.id = inputLabelId;
  inputLabel.className = "c-command__input-label";
  inputLabel.textContent = copy.inputLabel;
  const editorHost = ownerDocument.createElement("div");
  editorHost.className = "c-command__editor";
  const stdinRow = ownerDocument.createElement("label");
  stdinRow.className = "c-command__stdin";
  stdinRow.hidden = true;
  const stdinLabel = ownerDocument.createElement("span");
  stdinLabel.id = stdinLabelId;
  stdinLabel.textContent = copy.stdinLabel;
  const stdinInput = ownerDocument.createElement("textarea");
  stdinInput.rows = 2;
  stdinInput.maxLength = 65_536;
  stdinInput.setAttribute("aria-labelledby", stdinLabelId);
  stdinInput.placeholder = copy.stdinPlaceholder;
  stdinRow.append(stdinLabel, stdinInput);
  const composerFooter = ownerDocument.createElement("div");
  composerFooter.className = "c-command__composer-footer";
  const hint = ownerDocument.createElement("p");
  hint.id = hintId;
  hint.className = "c-command__hint";
  hint.textContent = copy.shortcutHint;
  const validation = ownerDocument.createElement("output");
  validation.id = validationId;
  validation.className = "c-command__validation";
  validation.setAttribute("aria-live", "polite");
  const projectionStatus = ownerDocument.createElement("output");
  projectionStatus.id = projectionStatusId;
  projectionStatus.className = "c-command__projection-status";
  projectionStatus.setAttribute("aria-live", "polite");
  const runButton = ownerDocument.createElement("button");
  runButton.className = "c-command__run";
  runButton.type = "submit";
  runButton.textContent = copy.run;
  composerFooter.append(hint, projectionStatus, validation, runButton);
  composer.append(inputLabel, editorHost, stdinRow, composerFooter);
  // Console order: history above, prompt last. The newest result therefore sits directly
  // above the line being typed instead of drifting to the far end of a growing log.
  root.append(headingGroup, transcript, composer);
  host.replaceChildren(root);

  const editor = createCCommandEditor(editorHost, {
    initialValue: options.initialValue ?? "",
    ariaLabelledBy: inputLabelId,
    ariaDescribedBy: `${hintId} ${projectionStatusId} ${validationId}`,
    placeholderText: copy.placeholder,
    // Deferred through arrows: both handlers are declared below and only ever run from a
    // later user event, never during construction.
    onInput: () => handleEditorInput(),
    onKeyAction: (action) => handleKeyAction(action),
  });
  stdinRow.hidden = !sourceMayNeedRuntimeInput(editor.getValue());

  // A console-style surface is ready to type into. Two things block the claim at build
  // time: the panel is still display:none, and the workspace-entry modal is still open —
  // a modal dialog makes everything outside it inert, where focus() is a silent no-op.
  // So the claim retries until it actually lands: on the first real layout box, and again
  // whenever a dialog closes.
  let focusClaimed = false;
  let initialFocusObserver: ResizeObserver | null = null;
  const releaseFocusClaim = (): void => {
    initialFocusObserver?.disconnect();
    initialFocusObserver = null;
    ownerDocument.removeEventListener("close", claimInitialFocus, true);
  };
  function claimInitialFocus(): void {
    if (destroyed || focusClaimed || root.offsetParent === null) return;
    editor.focus();
    if (ownerDocument.activeElement !== editor.contentElement) return;
    focusClaimed = true;
    releaseFocusClaim();
  }
  // Capture, because a dialog's close event does not bubble.
  ownerDocument.addEventListener("close", claimInitialFocus, true);
  claimInitialFocus();
  if (!focusClaimed && typeof ResizeObserver === "function") {
    initialFocusObserver = new ResizeObserver(claimInitialFocus);
    initialFocusObserver.observe(root);
  }

  const publishProjection = (): void => {
    projectionRevision += 1;
    const revision = projectionRevision;
    const projection = buildCCommandProjection(editor.getValue(), options.sourceName);
    if (projection === null) {
      projectionStatus.textContent = "";
      if (!hasPublishedProjection) options.onProjectionChange?.(null);
      return;
    }
    projectionStatus.textContent = copy.projectionPending;
    const assessment =
      options.assessProjection?.(projection) ?? assessCCommandDraft(projection.input);
    void Promise.resolve(assessment)
      .then((resolved) => {
        if (destroyed || revision !== projectionRevision) return;
        if (!canPublishCCommandProjection(resolved)) return;
        hasPublishedProjection = true;
        projectionStatus.textContent = "";
        options.onProjectionChange?.(projection);
      })
      .catch(() => {
        // A failed incremental assessment is treated as an unfinished draft.
        // Keep the last valid projection instead of replacing it with uncertain structure.
      });
  };
  const setInputValue = (
    value: string,
    preserveHistoryNavigation = false,
    shouldPublishProjection = true,
  ): void => {
    suppressHistoryReset = preserveHistoryNavigation;
    editor.setValue(value);
    stdinRow.hidden = !sourceMayNeedRuntimeInput(value);
    if (shouldPublishProjection) {
      publishProjection();
    } else {
      projectionStatus.textContent = "";
    }
    suppressHistoryReset = false;
  };

  // Console scroll anchoring: follow new output only when the reader is already at the
  // end, so scrolling up to re-read an earlier result is never yanked back down.
  //
  // The intent is recorded from the reader's own scrolls, NOT re-measured at mutation time.
  // Re-measuring reads clientHeight, which the composer decides — and the composer swings from
  // 92px to 340px as the draft grows (c-command.css). Five typed lines already move it further
  // than the tolerance, so a re-measure mistakes "the composer grew" for "the reader scrolled
  // away" and unpins the log permanently: every later result then renders 0px into view, which
  // is indistinguishable from the run producing no output at all.
  let followTail = true;
  const scrollTranscriptToEnd = (): void => {
    transcript.scrollTop = transcript.scrollHeight;
  };
  const onTranscriptScroll = (): void => {
    followTail =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <=
      TRANSCRIPT_PIN_TOLERANCE_PX;
  };
  transcript.addEventListener("scroll", onTranscriptScroll, { passive: true });
  const keepTranscriptPinned = (mutate: () => void): void => {
    mutate();
    if (followTail) scrollTranscriptToEnd();
  };
  // Composer height is the only thing that moves clientHeight; re-stick to the tail when it does,
  // otherwise growing the draft scrolls the newest result out from under the reader.
  let composerResizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    composerResizeObserver = new ResizeObserver(() => {
      if (followTail) scrollTranscriptToEnd();
    });
    composerResizeObserver.observe(composer);
  }

  const renderState = (state: CCommandExecutionState): void => {
    let rendered = renderedSubmissions.get(state.submissionId);
    if (rendered === undefined) {
      rendered = createCCommandSubmissionArticle(
        ownerDocument,
        state,
        copy,
        () => {
          setInputValue(state.projection.input);
          editor.focus();
          editor.setCursorTo("end");
        },
        async () => {
          await options.onRequestWriteSource?.({
            source: state.projection.source,
            originalInput: state.projection.input,
            projection: state.projection,
          });
        },
        () => {
          renderedSubmissions.delete(state.submissionId);
          rendered?.article.remove();
        },
      );
      renderedSubmissions.set(state.submissionId, rendered);
      // A new submission is the reader's own action, so follow it even if they had scrolled up.
      followTail = true;
      const appended = rendered;
      keepTranscriptPinned(() => transcript.append(appended.article));
    }
    const current = rendered;
    keepTranscriptPinned(() => updateCCommandSubmissionArticle(current, state, copy));
    const busy = state.phase === "compiling" || state.phase === "running";
    runButton.disabled = false;
    runButton.textContent = busy ? copy.cancelRun : copy.run;
    editor.setBusy(busy);
    options.onExecutionStateChange?.(state);
  };

  const controller: CCommandController = createCCommandController({
    hooks: options.hooks,
    sourceName: options.sourceName,
    getRuntimeInput: () => {
      const inherited = options.getRuntimeInput?.() ?? null;
      if (stdinRow.hidden || stdinInput.value.length === 0) return inherited;
      return Object.freeze({
        args: inherited?.args ?? Object.freeze([]),
        fixtures: inherited?.fixtures ?? Object.freeze([]),
        stdin: stdinInput.value,
      });
    },
    onStateChange: renderState,
  });

  const submit = async (): Promise<CCommandExecutionState | null> => {
    validation.textContent = "";
    if (editor.getValue().trim().length === 0) {
      validation.textContent = copy.emptyInput;
      editor.focus();
      return null;
    }
    if (controller.isRunning()) return null;
    const submittedValue = editor.getValue();
    const completion = controller.submit(submittedValue);
    // Runtime input belongs to one C Cell submission. Reusing it silently in a later cell can
    // override an explicitly selected case and produce a correct-looking result for wrong data.
    stdinInput.value = "";
    setInputValue("", false, false);
    return completion;
  };

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (controller.isRunning()) {
      void controller.cancel();
      return;
    }
    void submit();
  };
  function handleEditorInput(): void {
    publishProjection();
    stdinRow.hidden = !sourceMayNeedRuntimeInput(editor.getValue());
    validation.textContent = "";
    if (!suppressHistoryReset) controller.resetHistoryNavigation();
  }
  /** Returns true when the surface consumed the key, so the editor never also acts on it. */
  function handleKeyAction(action: Exclude<CCommandKeyboardAction, null>): boolean {
    if (action === "submit") {
      void submit();
      return true;
    }
    if (action === "cancel") {
      if (!controller.isRunning()) return false;
      void controller.cancel();
      return true;
    }
    if (action === "history-previous") {
      const previous = controller.historyPrevious(editor.getValue());
      if (previous === null) return false;
      setInputValue(previous, true);
      editor.setCursorTo("start");
      return true;
    }
    const next = controller.historyNext();
    if (next === null) return false;
    setInputValue(next, true);
    editor.setCursorTo("end");
    return true;
  }

  composer.addEventListener("submit", onSubmit);
  publishProjection();

  const setLocale = (nextLocale: InterfaceLocale): void => {
    locale = nextLocale;
    copy = getCCommandCopy(locale);
    heading.textContent = copy.heading;
    description.textContent = copy.description;
    inputLabel.textContent = copy.inputLabel;
    editor.setPlaceholder(copy.placeholder);
    hint.textContent = copy.shortcutHint;
    stdinLabel.textContent = copy.stdinLabel;
    stdinInput.placeholder = copy.stdinPlaceholder;
    if (projectionStatus.textContent.length > 0) {
      projectionStatus.textContent = copy.projectionPending;
    }
    runButton.textContent = controller.isRunning() ? copy.cancelRun : copy.run;
    for (const [submissionId, rendered] of renderedSubmissions) {
      const state = rendered.article.articleState;
      if (state?.submissionId === submissionId) {
        updateCCommandSubmissionArticle(rendered, state, copy);
      }
    }
  };
  const onLocaleChange = (): void => {
    setLocale(localeHost?.dataset.locale === "en" ? "en" : "zh-CN");
  };
  localeHost?.addEventListener("workbench-locale-change", onLocaleChange);

  return Object.freeze({
    element: root,
    editor,
    focus(): void {
      editor.focus();
    },
    setLocale,
    setValue(value: string): void {
      setInputValue(value);
    },
    clearTranscript(): void {
      renderedSubmissions.clear();
      transcript.replaceChildren();
      validation.textContent = "";
      followTail = true;
    },
    submit,
    cancel(): Promise<boolean> {
      return controller.cancel();
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      projectionRevision += 1;
      releaseFocusClaim();
      composerResizeObserver?.disconnect();
      composerResizeObserver = null;
      transcript.removeEventListener("scroll", onTranscriptScroll);
      composer.removeEventListener("submit", onSubmit);
      localeHost?.removeEventListener("workbench-locale-change", onLocaleChange);
      editor.destroy();
      await controller.destroy();
      root.remove();
    },
  });
}

export function configureCCommandTranscript(transcript: HTMLElement): void {
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-live", "off");
  transcript.setAttribute("aria-relevant", "additions");
}
