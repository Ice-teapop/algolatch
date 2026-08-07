import type { FlowProjection } from "../flow/index.js";
import type { PanelApi } from "../shared/api.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import type { WorkspaceEntrySummary } from "../shared/workspace.js";
import {
  FIRST_ALGORITHM_SOURCE_FINGERPRINT,
  FIRST_ALGORITHM_WALKTHROUGH,
  FIRST_GUIDED_LESSON,
  FIRST_MINIMUM_ALGORITHM_FINGERPRINT,
  MAXIMUM_SCENARIO_ID,
  MINIMUM_SCENARIO_ID,
  createFirstAlgorithmSkeleton,
  injectFirstAlgorithmBug,
} from "../tutorials/first-lesson.js";
import {
  createGuidedLessonController,
  deserializeGuidedLessonProgress,
  getGuidedLessonCheckpoint,
  type GuidedLessonController,
  type GuidedMissionStageDefinition,
  type GuidedLessonProgress,
  type GuidedMissionDefinition,
  type GuidedRequirement,
  type GuidedSourceRequirement,
  type LearningEvidenceBinding,
  type LearningEvidenceEvent,
} from "../tutorials/guided-lesson.js";
import { createFirstRunStart, type FirstRunStart } from "../ui/first-run-start.js";
import {
  guidedChartReadingSnapshot,
  type GuidedChartAnswerState,
} from "../ui/guided-chart-reading.js";
import {
  createGuidedLessonRail,
  resolveRailLocale,
  type GuidedLessonHintLevel,
  type GuidedLessonRail,
  type GuidedLessonRailSnapshot,
} from "../ui/guided-lesson-rail.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";
import { createWorkspaceSidecarPersistence } from "./workspace-sidecar-persistence.js";
import type { WorkspaceController } from "./workspace-controller.js";

const FIRST_RUN_STORAGE_KEY = "c-block-algorithm-panel:first-run-v6";
const MAXIMUM_CHECKPOINT_ID = "checkpoint.maximum-correct";

interface FirstLessonMissionCopy {
  readonly title: string;
  readonly instruction: string;
  readonly why: string;
  readonly hints: readonly [string, string, string];
  readonly stages: Readonly<Record<string, Readonly<{ title: string; instruction: string }>>>;
}

export interface LocalizedFirstLessonContent {
  readonly missionTitle: string;
  readonly stageTitle: string;
  readonly instruction: string;
  readonly why: string;
  readonly hints: readonly [string, string, string];
}

const FIRST_LESSON_ENGLISH_COPY: Readonly<Record<string, FirstLessonMissionCopy>> = Object.freeze({
  "mission.run": Object.freeze({
    title: "Run",
    instruction: "Run the selected normal case in the Run panel.",
    why: "A verified output gives the later observation and editing tasks a reliable baseline.",
    hints: Object.freeze([
      "Confirm that the selected case is Normal input.",
      "The stdin value should begin with 5.",
      "Choose Real run, not Teaching simulation.",
    ] as const),
    stages: Object.freeze({
      "mission.run.execute": Object.freeze({
        title: "Get the first result",
        instruction: "Run the normal case for real. The output must be 8.",
      }),
    }),
  }),
  "mission.observe": Object.freeze({
    title: "Observe",
    instruction: "Start a real Trace and confirm that the comparison takes both branches.",
    why: "An algorithm is more than static code. Path evidence shows when maximum changes and when it stays unchanged.",
    hints: Object.freeze([
      "Keep using the normal case.",
      "Start Trace from the runtime tools.",
      "Find both highlighted outcomes at the comparison node.",
    ] as const),
    stages: Object.freeze({
      "mission.observe.trace": Object.freeze({
        title: "Observe the real path",
        instruction:
          "Trace must map successfully and cover both true and false outcomes at the comparison node.",
      }),
    }),
  }),
  "mission.read-trace-chart": Object.freeze({
    title: "Read the workspace chart",
    instruction:
      "Use the real Trace you just produced to read the axes, event markers, reference line, and work ratio.",
    why: "The runtime chart is evidence from one execution. Reading it correctly keeps event density, wall time, and complexity as separate claims.",
    hints: Object.freeze([
      "Read whether the horizontal axis says event order or event time span.",
      "Small solid markers are statements; larger markers identify branch outcomes.",
      "Measured/reference compares same-size work. It is not a speed score.",
    ] as const),
    stages: Object.freeze({
      "mission.read-trace-chart.axes": Object.freeze({
        title: "Read the axes and event markers",
        instruction:
          "Inspect the Trace chart, then choose the precise meaning of a point farther right when the axis shows event order.",
      }),
      "mission.read-trace-chart.reference": Object.freeze({
        title: "Read the reference and ratio",
        instruction:
          "Use the same-size reference line to decide what a measured/reference ratio of 1.25× can establish.",
      }),
    }),
  }),
  "mission.complete": Object.freeze({
    title: "Complete",
    instruction:
      "Open the skeleton with the update block removed, then reconnect the Update maximum block inside the loop.",
    why: "Taking the code apart and rebuilding it connects the block, control-flow and C-source models.",
    hints: Object.freeze([
      "Select Start completion first.",
      "Search presets for Update maximum.",
      "Drop it at the highlighted connection and wait for CFG validation before running.",
    ] as const),
    stages: Object.freeze({
      "mission.complete.skeleton": Object.freeze({
        title: "Enter the completion skeleton",
        instruction:
          "Confirm that only the maximum update block is missing and that the source still reparses into a complete CFG.",
      }),
      "mission.complete.assemble": Object.freeze({
        title: "Reconnect the update block",
        instruction:
          "Insert the preset, make a valid connection, verify the source, then run the normal case.",
      }),
    }),
  }),
  "mission.read-analysis-chart": Object.freeze({
    title: "Read the Analysis chart",
    instruction:
      "Generate a comparable three-size benchmark, then interpret medians, ranges, measured growth, and the reference curve.",
    why: "One run gives one point. Growth claims require repeated, comparable runs with the same source, scenario, and toolchain.",
    hints: Object.freeze([
      "Use sizes 8, 32, and 128 with three repetitions per size.",
      "A vertical range joins the minimum and maximum; a longer range means more variation.",
      "Use operation counts for growth shape. Measurements support but do not prove Big-O.",
    ] as const),
    stages: Object.freeze({
      "mission.read-analysis-chart.benchmark": Object.freeze({
        title: "Generate comparable evidence",
        instruction:
          "Run the prepared benchmark at 8, 32, and 128 with at least three repetitions per size.",
      }),
      "mission.read-analysis-chart.variation": Object.freeze({
        title: "Read the median and variation",
        instruction:
          "Open Analysis, inspect the measured points and ranges, then explain what a longer range means.",
      }),
      "mission.read-analysis-chart.growth": Object.freeze({
        title: "Interpret growth without overstating it",
        instruction:
          "Switch to Operations, compare measured and reference growth, then choose the conclusion the evidence supports.",
      }),
    }),
  }),
  "mission.debug": Object.freeze({
    title: "Debug",
    instruction:
      "Reproduce the comparator fault, locate its path with Trace, then repair it and run three regression cases.",
    why: "A reproducible input, path evidence and boundary regressions are more reliable than changing code by intuition.",
    hints: Object.freeze([
      "After loading the faulty version, choose the all-negative case.",
      "The faulty output should consistently be -12.",
      "Restore < to >, then run all three cases.",
    ] as const),
    stages: Object.freeze({
      "mission.debug.reproduce": Object.freeze({
        title: "Reproduce and locate",
        instruction:
          "Confirm the single comparator fault, reproduce -12, and cover both branches with a real Trace.",
      }),
      "mission.debug.repair": Object.freeze({
        title: "Repair and regress",
        instruction:
          "Restore the correct comparator. The normal, all-negative and single-element cases must all pass.",
      }),
    }),
  }),
  "mission.migrate": Object.freeze({
    title: "Migrate",
    instruction:
      "Independently convert the algorithm to scan for the minimum and run three boundary cases.",
    why: "Migration keeps the algorithm structure while changing the meaning of its state and comparison direction.",
    hints: Object.freeze([
      "Rename maximum and its output to minimum.",
      "The update condition should be value < minimum.",
      "Keep a single scan and run the normal, all-negative and single-element cases.",
    ] as const),
    stages: Object.freeze({
      "mission.migrate.minimum": Object.freeze({
        title: "Complete the minimum algorithm",
        instruction:
          "The source structure, all three outputs and single-pass evidence must be valid together.",
      }),
    }),
  }),
});

export function localizeFirstLessonContent(
  mission: GuidedMissionDefinition,
  stage: GuidedMissionStageDefinition,
  locale: InterfaceLocale,
): LocalizedFirstLessonContent {
  if (locale === "zh-CN") {
    return Object.freeze({
      missionTitle: mission.title,
      stageTitle: stage.title,
      instruction: stage.instruction,
      why: mission.why,
      hints: mission.hints,
    });
  }
  const missionCopy = FIRST_LESSON_ENGLISH_COPY[mission.id];
  const stageCopy = missionCopy?.stages[stage.id];
  if (missionCopy === undefined || stageCopy === undefined) {
    return Object.freeze({
      missionTitle: "Lesson mission",
      stageTitle: "Complete this step",
      instruction: "Complete the acceptance criteria shown for this step.",
      why: "Each step is accepted only after the workspace records matching evidence.",
      hints: Object.freeze([
        "Use Locate to open the relevant panel.",
        "Check the selected scenario and current source.",
        "Read the pending acceptance criterion before editing.",
      ] as const),
    });
  }
  return Object.freeze({
    missionTitle: missionCopy.title,
    stageTitle: stageCopy.title,
    instruction: stageCopy.instruction,
    why: missionCopy.why,
    hints: missionCopy.hints,
  });
}

export function localizeFirstLessonRequirement(
  requirement: GuidedRequirement,
  locale: InterfaceLocale,
): string {
  if (locale === "zh-CN") return requirement.label;
  if (requirement.kind === "source-verified") {
    return requirement.profile === "minimum-complete"
      ? "Source passes exact diff, reparse, lossless round trip, complete CFG, and single-pass validation"
      : "Source passes exact diff, reparse, lossless round trip, and complete CFG validation";
  }
  if (requirement.kind === "preset-inserted") return "Update maximum preset inserted";
  if (requirement.kind === "connection-committed") {
    return "Connection accepted by the CFG safety gate";
  }
  if (requirement.kind === "real-trace") {
    return "Real Trace covers the comparison node's true and false outcomes";
  }
  if (requirement.kind === "benchmark-series") {
    return "Comparable real benchmark completed at n = 8, 32, and 128 with at least three repetitions each";
  }
  if (requirement.kind === "visualization-answer") {
    return requirement.visualizationId === "trace-chart"
      ? "Runtime chart interpretation is correct"
      : "Analysis growth-chart interpretation is correct";
  }
  if (requirement.kind === "real-run") {
    const caseLabel =
      requirement.caseId === "normal"
        ? "Normal input"
        : requirement.caseId === "negative"
          ? "All-negative input"
          : requirement.caseId === "single"
            ? "Single-element input"
            : requirement.caseId;
    return `${caseLabel}: real run outputs ${requirement.expectedStdout.trim()}`;
  }
  if (requirement.kind === "projection-ready") {
    return "Projection is complete and the source round trip is lossless";
  }
  return "The tutorial-owned workspace is open";
}

const GUIDED_STATUS_ENGLISH: Readonly<Record<string, string>> = Object.freeze({
  "等待完成当前操作。": "Complete the current action to continue.",
  "已恢复上次课程进度。": "The previous lesson progress was restored.",
  "课程进度已按当前源码安全重建；没有覆盖 main.c。":
    "Lesson progress was safely rebuilt from the current source; main.c was not overwritten.",
  "操作已提交，等待新源码投影完成。":
    "The action was submitted. Waiting for the new source projection.",
  "当前任务已通过；可进入下一任务。":
    "The current mission passed. You can continue to the next mission.",
  "阶段验收通过；继续完成下一项。": "This stage passed. Continue with the next item.",
  "已记录一项真实证据。": "One item of real evidence was recorded.",
  "源码已变化；旧运行与 Trace 证据已失效。":
    "The source changed. Previous run and Trace evidence is now invalid.",
  "已恢复当前任务检查点，等待重新验收。":
    "The current mission checkpoint was restored. Run the checks again.",
  "源码已切换，正在等待重解析与 CFG 验证。":
    "The source changed. Waiting for reparse and CFG validation.",
  "当前任务证据已重置；源码保持不变。":
    "Evidence for the current mission was reset; the source was unchanged.",
  "已进入下一任务。": "Moved to the next mission.",
  "证据来自旧源码版本，已拒绝。": "Evidence from an older source version was rejected.",
  "证据来自其他工作区，已拒绝。": "Evidence from another workspace was rejected.",
  "案例或版本绑定不完整，已拒绝。":
    "Evidence with an incomplete scenario or version binding was rejected.",
  "当前证据未通过课程安全校验。": "The current evidence did not pass the lesson safety checks.",
});

export function localizeGuidedLessonStatusMessage(
  message: string,
  locale: InterfaceLocale,
): string {
  if (locale === "zh-CN") return message;
  const exact = GUIDED_STATUS_ENGLISH[message];
  if (exact !== undefined) return exact;
  const mismatch = /^课程源码与预期不一致：(.*)$/u.exec(message);
  if (mismatch !== null)
    return `The lesson source does not match the expected state: ${mismatch[1]}`;
  if (message === "课程源码没有发生预期变化") {
    return "The lesson source did not change as expected.";
  }
  if (/[\u3400-\u9fff]/u.test(message)) {
    return "The lesson state changed. Review the current acceptance criteria.";
  }
  return message;
}

export type GuidedSourceChangeReason =
  "editor" | "preset" | "connection" | "lesson-transform" | "reset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface GuidedLessonWorkspaceControllerOptions {
  readonly elements: WorkbenchElements;
  readonly api: Pick<PanelApi, "readWorkspaceSidecar" | "saveWorkspaceSidecar">;
  readonly workspace: Pick<WorkspaceController, "activeEntry" | "createDocument">;
  readonly getSource: () => string;
  readonly getProjection: () => FlowProjection | null;
  readonly applySource: (source: string, reason: "lesson-transform" | "reset") => boolean;
  readonly configureScenario: (scenarioId: string, size: number) => void;
  readonly configureBenchmark?:
    ((sizes: readonly number[], repetitions: number) => void) | undefined;
  readonly onError: (error: Error) => void;
  readonly storage?: StorageLike | undefined;
  readonly sidecarDelayMs?: number | undefined;
}

export interface GuidedLessonWorkspaceController {
  readonly hasPendingChanges: boolean;
  readonly active: boolean;
  showFirstRunIfNeeded(): void;
  startLesson(): Promise<void>;
  setWorkspaceEntry(entry: WorkspaceEntrySummary | null): Promise<void>;
  binding(
    sourceFingerprint: string,
    scenarioId?: string | null,
    scenarioVersion?: string | null,
  ): LearningEvidenceBinding | null;
  recordEvidence(event: LearningEvidenceEvent): boolean;
  handleSourceChanged(sourceFingerprint: string, reason: GuidedSourceChangeReason): void;
  verifyCurrentProjection(roundTripLossless: boolean): void;
  flush(): Promise<void>;
  destroy(): void;
}

export function createGuidedLessonWorkspaceController(
  options: GuidedLessonWorkspaceControllerOptions,
): GuidedLessonWorkspaceController {
  assertOptions(options);
  const storage = options.storage ?? browserStorage();
  const persistence = createWorkspaceSidecarPersistence({
    kind: "tutorial-progress",
    read: (entryId, kind) => options.api.readWorkspaceSidecar({ entryId, kind }),
    save: (request) => options.api.saveWorkspaceSidecar(request),
    ...(options.sidecarDelayMs === undefined ? {} : { delayMs: options.sidecarDelayMs }),
  });
  let destroyed = false;
  let creatingTutorial = false;
  let resolveCreatedTutorial: (() => void) | null = null;
  let adoptionGeneration = 0;
  let controller: GuidedLessonController | null = null;
  let firstRun: FirstRunStart | null = null;
  let rail: GuidedLessonRail | null = null;
  let railHost: HTMLElement | null = null;
  let activeEntry: WorkspaceEntrySummary | null = null;
  let hintLevel: GuidedLessonHintLevel = 0;
  let whyExpanded = false;
  let selectedVisualAnswerId: string | null = null;
  let visualAnswerState: GuidedChartAnswerState = "idle";
  let busy = false;
  let status: GuidedLessonRailSnapshot["status"] = Object.freeze({
    state: "idle",
    message: "等待完成当前操作。",
  });
  let configuredStageId: string | null = null;
  let pendingResetFingerprint: string | null = null;
  let highlightedTarget: HTMLElement | null = null;
  let pendingEvidence: LearningEvidenceEvent[] = [];
  const panelVisibility = new Map<HTMLElement, boolean>();
  const currentLocale = (): InterfaceLocale =>
    resolveRailLocale(
      options.elements.shell.dataset.locale ??
        options.elements.shell.ownerDocument.documentElement?.dataset.locale ??
        options.elements.shell.ownerDocument.documentElement?.lang,
    );
  const onLocaleChange = (): void => {
    if (destroyed) return;
    if (railHost !== null) {
      railHost.setAttribute(
        "aria-label",
        currentLocale() === "en" ? "Lesson mission rail" : "课程任务轨",
      );
    }
    render();
  };
  const onPageChange = (): void => {
    if (destroyed || railHost === null) return;
    placeRailForCurrentPage();
    updateLeftPanels();
  };
  options.elements.shell.addEventListener("workbench-locale-change", onLocaleChange);
  options.elements.shell.addEventListener("workbench-page-change", onPageChange);

  const persist = (): void => {
    if (controller === null || persistence.activeEntryId === null) return;
    const progress = controller.getProgress();
    persistence.update(controller.serialize(), progress.sourceFingerprint);
  };

  const createController = (progress: GuidedLessonProgress): GuidedLessonController =>
    createGuidedLessonController({
      definition: FIRST_GUIDED_LESSON,
      progress,
      onChange: () => {
        persist();
        render();
      },
    });

  async function startLesson(): Promise<void> {
    assertActive(destroyed);
    if (controller?.getProgress().status === "active" && activeEntry !== null) {
      options.elements.showPage("build");
      options.elements.showCommandView("source");
      mountRail();
      return;
    }
    creatingTutorial = true;
    const ready = new Promise<void>((resolve) => {
      resolveCreatedTutorial = resolve;
    });
    try {
      const created = await options.workspace.createDocument(
        "sandbox",
        currentLocale() === "en" ? "Tutorial · Scan for Maximum" : "教程 · 扫描求最大值",
        FIRST_GUIDED_LESSON.initialSource,
      );
      if (!created) {
        throw new Error(
          currentLocale() === "en" ? "Could not create the lesson sandbox." : "教学沙箱创建失败",
        );
      }
      const entry = options.workspace.activeEntry;
      if (entry === null) {
        throw new Error(
          currentLocale() === "en"
            ? "The lesson sandbox was created without an active workspace."
            : "教学沙箱创建后没有活动工作区",
        );
      }
      await waitForCreatedTutorial(ready, currentLocale());
      storage?.setItem(FIRST_RUN_STORAGE_KEY, "lesson-started");
      firstRun?.destroy();
      firstRun = null;
      options.elements.showPage("build");
      options.elements.showCommandView("source");
    } finally {
      resolveCreatedTutorial = null;
      creatingTutorial = false;
    }
  }

  async function setWorkspaceEntry(entry: WorkspaceEntrySummary | null): Promise<void> {
    if (destroyed) return;
    const generation = ++adoptionGeneration;
    await persistence.deactivate();
    if (destroyed || generation !== adoptionGeneration) return;
    activeEntry = entry;
    controller = null;
    pendingEvidence = [];
    configuredStageId = null;
    unmountRail();
    if (entry === null) return;

    const sourceFingerprint = fingerprintSource(options.getSource());
    const adoption = await persistence.adopt(entry.id, sourceFingerprint);
    if (destroyed || generation !== adoptionGeneration || activeEntry?.id !== entry.id) return;
    const tutorialOwned =
      entry.kind === "sandbox" && (creatingTutorial || adoption.document !== null);
    if (!tutorialOwned) {
      await persistence.deactivate();
      return;
    }
    const read = deserializeGuidedLessonProgress(
      adoption.document?.serialized,
      FIRST_GUIDED_LESSON,
      Object.freeze({ workspaceId: entry.id, sourceFingerprint }),
    );
    controller = createController(read.progress);
    persist();
    mountRail();
    configureCurrentStage();
    status = Object.freeze({
      state: read.status === "restored" ? "idle" : "working",
      message:
        read.status === "restored"
          ? "已恢复上次课程进度。"
          : "课程进度已按当前源码安全重建；没有覆盖 main.c。",
    });
    render();
    if (options.getProjection()?.sourceFingerprint === sourceFingerprint) {
      verifyCurrentProjection(true);
    }
    resolveCreatedTutorial?.();
  }

  function showFirstRunIfNeeded(): void {
    if (destroyed || firstRun !== null || storage?.getItem(FIRST_RUN_STORAGE_KEY) !== null) return;
    const host = options.elements.getPageHost("dashboard");
    const content = host.querySelector<HTMLElement>(".workspace-dashboard__content") ?? host;
    firstRun = createFirstRunStart(content, {
      onStartLesson: startLesson,
      onContinue: () => {
        storage?.setItem(FIRST_RUN_STORAGE_KEY, "direct");
        firstRun?.destroy();
        firstRun = null;
        options.elements.showPage("build");
      },
    });
  }

  function binding(
    sourceFingerprint: string,
    scenarioId: string | null = null,
    scenarioVersion: string | null = null,
  ): LearningEvidenceBinding | null {
    const progress = controller?.getProgress();
    if (
      progress === undefined ||
      progress.status !== "active" ||
      activeEntry === null ||
      activeEntry.id !== progress.workspaceId
    ) {
      return null;
    }
    return Object.freeze({
      lessonId: FIRST_GUIDED_LESSON.id,
      lessonVersion: FIRST_GUIDED_LESSON.version,
      workspaceId: progress.workspaceId,
      sourceFingerprint,
      scenarioId,
      scenarioVersion,
    });
  }

  function recordEvidence(event: LearningEvidenceEvent): boolean {
    if (destroyed || controller === null) return false;
    const progress = controller.getProgress();
    if (
      event.type !== "source-changed" &&
      event.binding.sourceFingerprint !== progress.sourceFingerprint &&
      event.binding.sourceFingerprint === fingerprintSource(options.getSource())
    ) {
      pendingEvidence.push(event);
      status = Object.freeze({ state: "working", message: "操作已提交，等待新源码投影完成。" });
      render();
      return false;
    }
    const result = controller.recordEvidence(event);
    if (result.status === "accepted") {
      status = Object.freeze({
        state: controller.canAdvance() ? "success" : "working",
        message: controller.canAdvance()
          ? "当前任务已通过；可进入下一任务。"
          : result.stageAdvanced
            ? "阶段验收通过；继续完成下一项。"
            : "已记录一项真实证据。",
      });
      configureCurrentStage();
      render();
      return true;
    }
    if (result.reason !== "duplicate" && result.reason !== "no-requirement-match") {
      status = Object.freeze({ state: "error", message: evidenceRejectionMessage(result.reason) });
      render();
    }
    return false;
  }

  function handleSourceChanged(sourceFingerprint: string, reason: GuidedSourceChangeReason): void {
    const progress = controller?.getProgress();
    if (progress === undefined || progress.status !== "active") return;
    if (progress.sourceFingerprint === sourceFingerprint) return;
    const eventBinding = binding(sourceFingerprint);
    if (eventBinding === null) return;
    const result = controller!.recordEvidence({
      type: "source-changed",
      binding: eventBinding,
      previousSourceFingerprint: progress.sourceFingerprint,
      reason,
    });
    if (result.status !== "accepted") return;
    status = Object.freeze({
      state: "working",
      message: "源码已变化；旧运行与 Trace 证据已失效。",
    });
    const queued = pendingEvidence.filter(
      (event) => event.binding.sourceFingerprint === sourceFingerprint,
    );
    pendingEvidence = [];
    for (const event of queued) recordEvidence(event);
    if (pendingResetFingerprint === sourceFingerprint) {
      pendingResetFingerprint = null;
      controller!.resetCurrentMission(sourceFingerprint);
      status = Object.freeze({ state: "idle", message: "已恢复当前任务检查点，等待重新验收。" });
    }
    render();
  }

  function verifyCurrentProjection(roundTripLossless: boolean): void {
    const progress = controller?.getProgress();
    const projection = options.getProjection();
    if (
      progress === undefined ||
      projection === null ||
      projection.sourceFingerprint !== progress.sourceFingerprint
    ) {
      return;
    }
    const cfgComplete =
      !projection.documentHasError &&
      projection.functions.length > 0 &&
      projection.functions.every((item) => !item.partial);
    const eventBinding = binding(projection.sourceFingerprint);
    if (eventBinding === null) return;
    recordEvidence({
      type: "projection-ready",
      binding: eventBinding,
      completeness: cfgComplete ? "complete" : projection.documentHasError ? "raw" : "partial",
      roundTripLossless,
    });
    const requirement = currentStageRequirements(progress).find(
      (item): item is GuidedSourceRequirement =>
        item.kind === "source-verified" &&
        (item.expectedSourceFingerprint === null ||
          item.expectedSourceFingerprint === projection.sourceFingerprint),
    );
    if (requirement === undefined) return;
    const semanticMinimum =
      requirement.profile === "minimum-complete" &&
      isSinglePassMinimumSource(options.getSource(), projection);
    if (requirement.profile === "minimum-complete" && !semanticMinimum) return;
    recordEvidence({
      type: "source-verified",
      binding: eventBinding,
      profile: requirement.profile,
      exactDiff: requirement.exactDiff,
      reparsed: !projection.documentHasError,
      roundTripLossless,
      cfgComplete,
      linearScan:
        semanticMinimum ||
        projection.sourceFingerprint === FIRST_ALGORITHM_SOURCE_FINGERPRINT ||
        projection.sourceFingerprint === FIRST_MINIMUM_ALGORITHM_FINGERPRINT,
    });
  }

  function mountRail(): void {
    const progress = controller?.getProgress();
    if (progress === undefined || progress.status === "exited") return;
    if (railHost === null) {
      const document = options.elements.leftPane.ownerDocument;
      railHost = document.createElement("section");
      railHost.className = "guided-lesson-host";
      railHost.setAttribute(
        "aria-label",
        currentLocale() === "en" ? "Lesson mission rail" : "课程任务轨",
      );
      options.elements.leftPane.append(railHost);
      for (const selector of ["#presets-pane", "#outline-pane"]) {
        const panel = options.elements.leftPane.querySelector<HTMLElement>(selector);
        if (panel !== null && !panelVisibility.has(panel)) {
          panelVisibility.set(panel, panel.hidden === true);
        }
      }
    }
    placeRailForCurrentPage();
    if (rail === null) {
      rail = createGuidedLessonRail(railHost, railSnapshot(), {
        onLocate: locateCurrentTarget,
        onToggleWhy: () => {
          whyExpanded = !whyExpanded;
          render();
        },
        onNextHint: () => {
          hintLevel = Math.min(3, hintLevel + 1) as GuidedLessonHintLevel;
          render();
        },
        onReset: resetCurrentMission,
        onExit: exitLesson,
        onNext: nextMission,
        onPrepareSkeleton: prepareSkeleton,
        onInjectBug: injectBug,
        onVisualAnswer: answerVisualGuide,
      });
    }
    updateLeftPanels();
    render();
  }

  function unmountRail(): void {
    clearTargetHighlight();
    rail?.destroy();
    rail = null;
    railHost?.remove();
    railHost = null;
    analysisPanel()?.classList.remove("is-guided-lesson");
    for (const [panel, wasHidden] of panelVisibility) panel.hidden = wasHidden;
    panelVisibility.clear();
  }

  function updateLeftPanels(): void {
    const progress = controller?.getProgress();
    const showPresets =
      progress?.status === "active" &&
      progress.currentMissionId === "mission.complete" &&
      progress.currentStageId === "mission.complete.assemble";
    const presets = options.elements.leftPane.querySelector<HTMLElement>("#presets-pane");
    const outline = options.elements.leftPane.querySelector<HTMLElement>("#outline-pane");
    if (presets !== null) presets.hidden = !showPresets;
    if (outline !== null) outline.hidden = true;
    const railInLeftPane = railHost?.parentElement === options.elements.leftPane;
    options.elements.leftPane.classList.toggle("is-guided-lesson", railInLeftPane);
    options.elements.leftPane.classList.toggle(
      "is-guided-lesson-with-presets",
      railInLeftPane && showPresets,
    );
  }

  function analysisPanel(): HTMLElement | null {
    const parent = options.elements.analysisHost.parentElement;
    return parent instanceof HTMLElement ? parent : null;
  }

  function placeRailForCurrentPage(): void {
    if (railHost === null) return;
    const analysis = analysisPanel();
    if (options.elements.currentPage === "analysis" && analysis !== null) {
      if (railHost.parentElement !== analysis)
        analysis.insertBefore(railHost, options.elements.analysisHost);
      analysis.classList.add("is-guided-lesson");
      return;
    }
    analysis?.classList.remove("is-guided-lesson");
    if (railHost.parentElement !== options.elements.leftPane) {
      options.elements.leftPane.append(railHost);
    }
  }

  function railSnapshot(): GuidedLessonRailSnapshot {
    const progress = controller?.getProgress();
    if (progress === undefined) throw new Error("课程任务轨没有活动进度");
    const missionIndex = Math.max(
      0,
      FIRST_GUIDED_LESSON.missions.findIndex((item) => item.id === progress.currentMissionId),
    );
    const mission = FIRST_GUIDED_LESSON.missions[missionIndex]!;
    const stage = mission.stages.find((item) => item.id === progress.currentStageId)!;
    const locale = currentLocale();
    const localized = localizeFirstLessonContent(mission, stage, locale);
    const satisfied = new Set(progress.satisfiedRequirements.map((item) => item.requirementId));
    const completed = progress.status === "completed";
    return Object.freeze({
      lessonLabel:
        locale === "en"
          ? `Lesson 1 · ${String(missionIndex + 1)}/${String(FIRST_GUIDED_LESSON.missions.length)}`
          : `第一课 · ${String(missionIndex + 1)}/${String(FIRST_GUIDED_LESSON.missions.length)}`,
      missionIndex: missionIndex + 1,
      missionCount: FIRST_GUIDED_LESSON.missions.length,
      title: completed
        ? locale === "en"
          ? "Lesson 1 complete"
          : "第一课完成"
        : localized.stageTitle,
      instruction: completed
        ? locale === "en"
          ? "You completed assembly, Trace, chart interpretation, benchmarking, debugging, and migration to a minimum scan. Next lesson: the first index of the minimum."
          : "你已完成搭建、Trace、读图、Benchmark、调试与最小值迁移。下一课：最小值首次下标。"
        : localized.instruction,
      requirements: completed
        ? Object.freeze([])
        : Object.freeze(
            stage.requirements.map((item) =>
              Object.freeze({
                label: localizeFirstLessonRequirement(item, locale),
                status: satisfied.has(item.id) ? ("passed" as const) : ("pending" as const),
              }),
            ),
          ),
      canAdvance: !completed && controller?.canAdvance() === true,
      expandedWhy: whyExpanded,
      hintLevel,
      predictionRows:
        mission.id === "mission.observe"
          ? Object.freeze(
              FIRST_ALGORITHM_WALKTHROUGH.map((row) =>
                Object.freeze({
                  iteration: String(row.inputIndex),
                  input: String(row.value),
                  comparison: row.comparison ?? (locale === "en" ? "Initialize" : "初始化"),
                  maximum: String(row.maximumAfter),
                }),
              ),
            )
          : Object.freeze([]),
      busy,
      status: completed
        ? Object.freeze({
            state: "success" as const,
            message:
              locale === "en"
                ? "All seven missions passed with real evidence."
                : "7 个任务已全部通过真实证据验收。",
          })
        : Object.freeze({
            ...status,
            message: localizeGuidedLessonStatusMessage(status.message, locale),
          }),
      why: localized.why,
      hints: localized.hints,
      visualGuide: completed
        ? undefined
        : guidedChartReadingSnapshot(stage.id, locale, selectedVisualAnswerId, visualAnswerState),
      showPrepareSkeleton:
        mission.id === "mission.complete" &&
        stage.id === "mission.complete.skeleton" &&
        progress.sourceFingerprint === FIRST_ALGORITHM_SOURCE_FINGERPRINT,
      showInjectBug:
        mission.id === "mission.debug" &&
        stage.id === "mission.debug.reproduce" &&
        progress.sourceFingerprint === FIRST_ALGORITHM_SOURCE_FINGERPRINT,
    });
  }

  function render(): void {
    if (destroyed || controller === null || rail === null) return;
    placeRailForCurrentPage();
    updateLeftPanels();
    rail.update(railSnapshot());
  }

  function configureCurrentStage(): void {
    const progress = controller?.getProgress();
    if (progress === undefined || progress.status !== "active") return;
    if (configuredStageId === progress.currentStageId) return;
    configuredStageId = progress.currentStageId;
    hintLevel = 0;
    whyExpanded = false;
    selectedVisualAnswerId = null;
    visualAnswerState = "idle";
    if (progress.currentMissionId === "mission.migrate") {
      options.configureScenario(MINIMUM_SCENARIO_ID, 5);
    } else if (progress.currentMissionId === "mission.debug") {
      options.configureScenario(MAXIMUM_SCENARIO_ID, 4);
    } else if (progress.currentStageId === "mission.read-analysis-chart.benchmark") {
      options.configureScenario(MAXIMUM_SCENARIO_ID, 8);
      options.configureBenchmark?.(Object.freeze([8, 32, 128]), 3);
    } else {
      options.configureScenario(MAXIMUM_SCENARIO_ID, 5);
    }
  }

  function locateCurrentTarget(): void {
    const progress = controller?.getProgress();
    if (progress === undefined) return;
    const mission = currentMission(progress);
    clearTargetHighlight();
    let target: HTMLElement;
    if (progress.currentStageId === "mission.read-analysis-chart.benchmark") {
      options.elements.showPage("build");
      options.elements.focusPanel("runtime");
      const benchmark = options.elements.scenarioHost.querySelector<HTMLDetailsElement>(
        ".scenario-panel__benchmark",
      );
      if (benchmark !== null) benchmark.open = true;
      target = benchmark ?? options.elements.scenarioHost;
    } else if (mission.locateTargetId === "analysis-chart") {
      options.elements.showPage("analysis");
      target =
        options.elements.analysisHost.querySelector<HTMLElement>(".analysis-dashboard__trend") ??
        options.elements.analysisHost;
    } else if (mission.locateTargetId === "trace-chart") {
      options.elements.showPage("build");
      options.elements.focusPanel("runtime");
      target =
        options.elements.traceHost.querySelector<HTMLElement>(".trace-panel__visual") ??
        options.elements.traceHost;
    } else if (mission.locateTargetId === "run-panel" || mission.locateTargetId === "trace-panel") {
      options.elements.showPage("build");
      options.elements.focusPanel("runtime");
      target = options.elements.tracePrimaryButton;
    } else if (mission.locateTargetId === "code-pane") {
      options.elements.showPage("build");
      options.elements.focusPanel("code");
      target = options.elements.codePane;
    } else {
      options.elements.showPage("build");
      if (progress.currentMissionId === "mission.complete") {
        options.elements.focusPanel("presets");
        const EventConstructor = options.elements.shell.ownerDocument.defaultView?.CustomEvent;
        if (EventConstructor !== undefined) {
          options.elements.shell.dispatchEvent(
            new EventConstructor("workbench-action", {
              detail: Object.freeze({ rootId: "presets", branchId: "algorithm-patterns" }),
            }),
          );
        }
      } else {
        options.elements.focusPanel("canvas");
      }
      const slotNode = options
        .getProjection()
        ?.nodes.find((node) => node.sourceText.trim() === ";" && !node.locked);
      const slotElement = [
        ...options.elements.flowCanvas.querySelectorAll<HTMLElement>("[data-flow-node-id]"),
      ].find((element) => element.dataset.flowNodeId === slotNode?.id);
      target = slotElement ?? options.elements.flowCanvas;
    }
    target.classList.add("guided-lesson-target");
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    target.focus({ preventScroll: true });
    highlightedTarget = target;
  }

  function answerVisualGuide(answerId: string): void {
    const progress = controller?.getProgress();
    if (progress === undefined || progress.status !== "active") return;
    const requirement = currentStageRequirements(progress).find(
      (candidate) => candidate.kind === "visualization-answer",
    );
    if (requirement === undefined) return;
    selectedVisualAnswerId = answerId;
    const eventBinding = binding(progress.sourceFingerprint);
    if (eventBinding === null) return;
    const stageId = progress.currentStageId;
    const accepted = recordEvidence({
      type: "visualization-answer",
      binding: eventBinding,
      visualizationId: requirement.visualizationId,
      answerId,
    });
    if (!accepted) {
      visualAnswerState = "incorrect";
      status = Object.freeze({
        state: "error",
        message:
          currentLocale() === "en"
            ? "That interpretation is not supported by the chart. Read the evidence boundary and try again."
            : "这个解释超出了图表证据。请核对证据边界后重试。",
      });
      render();
      return;
    }
    if (controller?.getProgress().currentStageId === stageId) {
      visualAnswerState = "correct";
      render();
    }
  }

  function clearTargetHighlight(): void {
    highlightedTarget?.classList.remove("guided-lesson-target");
    highlightedTarget = null;
  }

  function prepareSkeleton(): void {
    runTransform(() => {
      const progress = requireActiveProgress();
      saveMaximumCheckpoint(progress);
      return createFirstAlgorithmSkeleton(options.getSource(), progress.sourceFingerprint);
    }, "lesson-transform");
  }

  function injectBug(): void {
    runTransform(() => {
      const progress = requireActiveProgress();
      saveMaximumCheckpoint(progress);
      return injectFirstAlgorithmBug(options.getSource(), progress.sourceFingerprint);
    }, "lesson-transform");
  }

  function runTransform(
    transform: () => ReturnType<typeof createFirstAlgorithmSkeleton>,
    reason: "lesson-transform" | "reset",
  ): void {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = transform();
      if (!result.ok) throw new Error(`课程源码与预期不一致：${result.reason}`);
      if (!options.applySource(result.source, reason)) throw new Error("课程源码没有发生预期变化");
      status = Object.freeze({
        state: "working",
        message: "源码已切换，正在等待重解析与 CFG 验证。",
      });
    } catch (error: unknown) {
      if (reason === "reset") pendingResetFingerprint = null;
      const rawProblem = error instanceof Error ? error : new Error(String(error));
      const problem = new Error(
        localizeGuidedLessonStatusMessage(rawProblem.message, currentLocale()),
      );
      status = Object.freeze({ state: "error", message: problem.message });
      options.onError(problem);
    } finally {
      busy = false;
      render();
    }
  }

  function saveMaximumCheckpoint(progress: GuidedLessonProgress): void {
    if (getGuidedLessonCheckpoint(progress, MAXIMUM_CHECKPOINT_ID) !== null) return;
    if (progress.sourceFingerprint !== FIRST_ALGORITHM_SOURCE_FINGERPRINT) {
      throw new Error("当前源码不是可保存的正确最大值版本");
    }
    controller!.saveCheckpoint({
      id: MAXIMUM_CHECKPOINT_ID,
      label: "正确最大值版本",
      source: options.getSource(),
      sourceFingerprint: progress.sourceFingerprint,
    });
  }

  function resetCurrentMission(): void {
    const progress = requireActiveProgress();
    const checkpoint = getGuidedLessonCheckpoint(progress, MAXIMUM_CHECKPOINT_ID);
    const source = checkpoint?.source ?? FIRST_GUIDED_LESSON.initialSource;
    const nextFingerprint = fingerprintSource(source);
    if (options.getSource() === source) {
      controller!.resetCurrentMission(nextFingerprint);
      status = Object.freeze({ state: "idle", message: "当前任务证据已重置；源码保持不变。" });
      render();
      return;
    }
    pendingResetFingerprint = nextFingerprint;
    runTransform(
      () =>
        Object.freeze({
          ok: true as const,
          source,
          previousFingerprint: progress.sourceFingerprint,
          sourceFingerprint: nextFingerprint,
        }),
      "reset",
    );
  }

  function nextMission(): void {
    if (controller === null || !controller.canAdvance()) return;
    controller.next();
    status = Object.freeze({ state: "idle", message: "已进入下一任务。" });
    configureCurrentStage();
    render();
  }

  function exitLesson(): void {
    if (controller === null) return;
    controller.exit();
    persist();
    unmountRail();
    options.elements.showPage("dashboard");
  }

  function requireActiveProgress(): GuidedLessonProgress {
    const progress = controller?.getProgress();
    if (progress === undefined || progress.status !== "active" || activeEntry === null) {
      throw new Error("当前没有活动课程沙箱");
    }
    return progress;
  }

  return Object.freeze({
    get hasPendingChanges(): boolean {
      return persistence.hasPendingChanges;
    },
    get active(): boolean {
      return controller?.getProgress().status === "active";
    },
    showFirstRunIfNeeded,
    startLesson,
    setWorkspaceEntry,
    binding,
    recordEvidence,
    handleSourceChanged,
    verifyCurrentProjection,
    flush: () => persistence.flush(),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      adoptionGeneration += 1;
      firstRun?.destroy();
      firstRun = null;
      unmountRail();
      controller = null;
      pendingEvidence = [];
      options.elements.shell.removeEventListener("workbench-locale-change", onLocaleChange);
      options.elements.shell.removeEventListener("workbench-page-change", onPageChange);
      persistence.destroy();
    },
  });
}

function currentMission(progress: GuidedLessonProgress): GuidedMissionDefinition {
  const mission = FIRST_GUIDED_LESSON.missions.find(
    (candidate) => candidate.id === progress.currentMissionId,
  );
  if (mission === undefined) throw new Error("课程进度指向未知任务");
  return mission;
}

function currentStageRequirements(progress: GuidedLessonProgress): readonly GuidedRequirement[] {
  const stage = currentMission(progress).stages.find(
    (candidate) => candidate.id === progress.currentStageId,
  );
  if (stage === undefined) throw new Error("课程进度指向未知阶段");
  return stage.requirements;
}

function evidenceRejectionMessage(reason: string): string {
  if (reason === "source-mismatch") return "证据来自旧源码版本，已拒绝。";
  if (reason === "workspace-mismatch") return "证据来自其他工作区，已拒绝。";
  if (reason === "scenario-binding-invalid") return "案例或版本绑定不完整，已拒绝。";
  return "当前证据未通过课程安全校验。";
}

export function isSinglePassMinimumSource(source: string, projection: FlowProjection): boolean {
  const loops = projection.nodes.filter((node) => node.kind === "loop" && !node.locked);
  if (loops.length !== 1 || projection.functions.some((item) => item.partial)) return false;
  return /if\s*\(\s*([A-Za-z_]\w*)\s*<\s*([A-Za-z_]\w*)\s*\)\s*\{\s*\2\s*=\s*\1\s*;\s*\}/u.test(
    source,
  );
}

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function assertOptions(options: GuidedLessonWorkspaceControllerOptions): void {
  if (
    typeof options.api?.readWorkspaceSidecar !== "function" ||
    typeof options.api.saveWorkspaceSidecar !== "function" ||
    typeof options.workspace?.createDocument !== "function" ||
    typeof options.getSource !== "function" ||
    typeof options.getProjection !== "function" ||
    typeof options.applySource !== "function" ||
    typeof options.configureScenario !== "function" ||
    typeof options.onError !== "function"
  ) {
    throw new TypeError("GuidedLessonWorkspaceController options 无效");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("GuidedLessonWorkspaceController 已销毁");
}

async function waitForCreatedTutorial(
  ready: Promise<void>,
  locale: InterfaceLocale = "zh-CN",
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                locale === "en"
                  ? "The lesson sandbox took too long to initialize."
                  : "教学沙箱初始化超时",
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
