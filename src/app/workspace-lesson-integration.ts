import * as core from "../core/index.js";
import type { PanelApi } from "../shared/api.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import type { ImportedSource } from "../shared/api.js";
import type { WorkspaceEntrySummary } from "../shared/workspace.js";
import type { CodePane } from "../ui/code-pane.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";
import { createFoaWorkspaceLaunchContract, type FoaLessonDefinition } from "../tutorials/index.js";
import type { FlowWorkbenchController } from "./flow-workbench-controller.js";
import {
  createGuidedLessonWorkspaceController,
  type GuidedLessonWorkspaceController,
  type GuidedSourceChangeReason,
} from "./guided-lesson-workspace-controller.js";
import type { RuntimeWorkspaceController } from "./runtime-workspace-controller.js";
import { createWorkspaceController, type WorkspaceController } from "./workspace-controller.js";

export interface WorkspaceLessonIntegrationOptions {
  readonly elements: WorkbenchElements;
  readonly api: PanelApi;
  readonly codePane: CodePane;
  readonly flow: FlowWorkbenchController;
  readonly runtime: RuntimeWorkspaceController;
  readonly loadSource: (source: ImportedSource) => void;
  readonly getCurrentDocument: () => ImportedSource | null;
  readonly onError: (message: string) => void;
  readonly onActiveEntryChange?: ((entry: WorkspaceEntrySummary | null) => void) | undefined;
  readonly isDestroyed?: (() => boolean) | undefined;
}

export interface WorkspaceLessonIntegration {
  readonly workspace: WorkspaceController;
  readonly guidedLesson: GuidedLessonWorkspaceController;
  handleSourceChanged(source: string): void;
  openFoaLesson(lesson: FoaLessonDefinition): void;
}

export function createWorkspaceLessonIntegration(
  options: WorkspaceLessonIntegrationOptions,
): WorkspaceLessonIntegration {
  let guidedLesson: GuidedLessonWorkspaceController | null = null;
  let pendingSourceReason: GuidedSourceChangeReason | null = null;
  let launchingFoaLesson = false;
  const workspace = createWorkspaceController({
    host: options.elements.getPageHost("dashboard"),
    api: options.api,
    saveStatus: options.elements.workspaceSaveStatus,
    recoveryButton: options.elements.workspaceRecoveryButton,
    load: options.loadSource,
    getCurrentDocument: options.getCurrentDocument,
    enterWorkbench: () => options.elements.showPage("build"),
    onActiveEntryChange: async (entry) => {
      try {
        options.onActiveEntryChange?.(entry);
        const entryId = entry?.id ?? null;
        const fingerprint =
          entryId === null ? null : fingerprintSource(options.codePane.getSource());
        await Promise.all([
          options.flow.setWorkspaceEntry(entryId),
          options.runtime.setWorkspaceEntry(entryId, fingerprint),
        ]);
        await guidedLesson?.setWorkspaceEntry(entry ?? null);
      } catch (error: unknown) {
        options.onError(error instanceof Error ? error.message : "工作区 sidecar 载入失败");
        throw error;
      }
    },
  });
  guidedLesson = createGuidedLessonWorkspaceController({
    elements: options.elements,
    api: options.api,
    workspace,
    getSource: () => options.codePane.getSource(),
    getProjection: () => options.flow.projection,
    applySource(source, reason) {
      const current = options.codePane.getSource();
      pendingSourceReason = reason;
      const changed = options.codePane.applyPatches([
        core.createTextPatch(core.textRange(0, current.length), source),
      ]);
      if (!changed) pendingSourceReason = null;
      return changed;
    },
    configureScenario(scenarioId, size) {
      options.runtime.scenario.selectScenario(scenarioId);
      options.runtime.scenario.setInputSize(size);
    },
    configureBenchmark(sizes, repetitions) {
      options.runtime.scenario.configureBenchmark(sizes, repetitions);
    },
    onError: (error) => options.onError(error.message),
  });
  const lesson = guidedLesson;
  const openFoaLesson = (definition: FoaLessonDefinition): void => {
    if (launchingFoaLesson) return;
    const launch = createFoaWorkspaceLaunchContract(definition);
    if (launch === null) {
      const english = options.elements.shell.dataset.locale === "en";
      options.onError(
        english
          ? "This lesson does not define an independent workspace exercise."
          : "本课程没有定义独立工作区练习。",
      );
      return;
    }
    const english = options.elements.shell.dataset.locale === "en";
    const title = `${english ? "Lesson" : "教程"} ${String(definition.order)} · ${definition.title[english ? "en" : "zh"]}`;
    launchingFoaLesson = true;
    void workspace
      .createDocument("sandbox", title, launch.initialSource)
      .then((created) => {
        if (!created || options.isDestroyed?.()) return;
        options.runtime.configureTutorialCase(launch.runtimeCase);
        options.elements.setWorkspaceLessonFocus({
          lessonId: definition.id,
          title: {
            zh: `课程 ${String(definition.order)} · ${definition.title.zh}`,
            en: `Lesson ${String(definition.order)} · ${definition.title.en}`,
          },
          instruction: {
            zh: definition.objectives[0]?.zh ?? definition.summary.zh,
            en: definition.objectives[0]?.en ?? definition.summary.en,
          },
          onExit: () => options.elements.showPage("tutorials"),
        });
        options.elements.showPage("build");
        options.elements.focusPanel("runtime");
      })
      .catch((error: unknown) => {
        options.onError(error instanceof Error ? error.message : "教程工作区创建失败");
      })
      .finally(() => {
        launchingFoaLesson = false;
      });
  };
  return Object.freeze({
    workspace,
    guidedLesson: lesson,
    openFoaLesson,
    handleSourceChanged(source: string): void {
      lesson.handleSourceChanged(fingerprintSource(source), pendingSourceReason ?? "editor");
      pendingSourceReason = null;
    },
  });
}
