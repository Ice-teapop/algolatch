import type { BlockIndexEntry, CAnalysisSnapshot } from "../core/index.js";
import {
  WORKBENCH_QUICK_OPEN_ACTIVATE_EVENT,
  WORKBENCH_QUICK_OPEN_COLLECT_EVENT,
  quickOpenActivateDetail,
  quickOpenCollectDetail,
  quickOpenItemId,
  type QuickOpenItem,
} from "../commands/index.js";
import {
  createLearningCatalog,
  type LearningCatalogStorage,
  type PresetBlockKind,
  type PresetBlockLifecycle,
  type PresetPortDefinition,
  type PresetSyntaxAncestorCapability,
  type PresetSyntaxSlotKind,
} from "../learning/index.js";
import {
  createBlockLibraryManager,
  type BlockLibraryManager,
} from "../ui/block-library-manager.js";
import {
  createBlockPalette,
  filterLearningTemplates,
  type BlockPalette,
  type BlockPaletteCategory,
} from "../ui/block-palette.js";
import { presentPresetBlock } from "../ui/builtin-preset-presentations.js";
import type { AssemblyInsertIntent, AssemblyInsertPosition, BlockTree } from "../ui/block-tree.js";
import type { CanvasEdgeInsertPreset } from "../ui/canvas-structure-actions.js";
import { createSoftwareLibrary, type SoftwareLibrary } from "../ui/software-library.js";
import {
  createLibraryTutorialsModule,
  type LibraryTutorialsModule,
} from "../ui/library-tutorials-module.js";
import { WORKBENCH_OPEN_TUTORIAL_EVENT, type TutorialsModule } from "../ui/tutorials-module.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";
import type { FlowCanvasCompatibleBlockSearchRequest } from "../ui/flow-canvas.js";
import type { FoaLessonDefinition } from "../tutorials/foa-curriculum.js";
import type { PanelApi } from "../shared/api.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import type { RuntimeLearningObservation } from "./runtime-workspace-controller.js";
import { searchLibrary } from "../library/index.js";
import {
  buildAssemblyInsertRequest,
  createAssemblyController,
  type AssemblyController,
} from "./assembly-controller.js";
import {
  validateLearningTemplateSource,
  type LearningTemplateAnalyzer,
} from "./learning-template-validator.js";
import type { StructureEditController } from "./structure-edit-controller.js";

export interface LearningSurfaceOptions {
  readonly elements: WorkbenchElements;
  readonly blockTree: BlockTree;
  readonly structureEdits: StructureEditController;
  readonly getAnalysis: () => CAnalysisSnapshot | null;
  readonly getAnalyzer: () => LearningTemplateAnalyzer | null;
  readonly storage?: LearningCatalogStorage | undefined;
  readonly traceApi?: Pick<PanelApi, "startTrace" | "readTrace" | "cancelTrace"> | undefined;
  readonly onStartGuidedLesson: () => void;
  readonly onOpenFoaWorkspace?: ((lesson: FoaLessonDefinition) => void) | undefined;
  readonly onError: (error: Error) => void;
}

export interface LearningSurface {
  insert(intent: AssemblyInsertIntent): Promise<void>;
  prepareCanvasPresetInsert(target: CanvasPresetInsertTarget): void;
  listCompatibleCanvasPresets(
    target: CanvasPresetInsertTarget,
    locale: "zh-CN" | "en",
  ): readonly CanvasEdgeInsertPreset[];
  insertCanvasPreset(target: CanvasPresetInsertTarget, presetId: string): boolean;
  resolvePreset(presetId: string): ResolvedLearningPreset | null;
  setSelectedInsertEnabled(enabled: boolean): void;
  recordRuntimeObservation(observation: RuntimeLearningObservation): void;
  destroy(): void;
}

export interface CanvasPresetInsertTarget {
  readonly sourceFingerprint: string;
  readonly target: BlockIndexEntry;
  readonly position: AssemblyInsertPosition;
}

export interface ResolvedLearningPreset {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly source: string | null;
  readonly blockKind: PresetBlockKind;
  readonly lifecycle: PresetBlockLifecycle;
  readonly ports: readonly PresetPortDefinition[];
  readonly acceptedSyntaxSlots: readonly PresetSyntaxSlotKind[];
  readonly requiredAnyAncestorCapabilities: readonly PresetSyntaxAncestorCapability[];
}

export function createLearningSurface(options: LearningSurfaceOptions): LearningSurface {
  const storage = options.storage ?? browserStorage();
  const catalog = createLearningCatalog(storage === undefined ? {} : { storage });
  const assembly: AssemblyController = createAssemblyController({
    catalog,
    getAnalysis: options.getAnalysis,
    structureEdits: options.structureEdits,
    onError: options.onError,
  });
  let destroyed = false;
  let canvasPresetInsertTarget: CanvasPresetInsertTarget | null = null;

  const palette: BlockPalette = createBlockPalette(options.elements.blockPalette, catalog, {
    onTemplateDragStart: (templateId) => {
      const preset = catalog.getPreset(templateId);
      options.blockTree.setTemplateDrag(
        templateId,
        preset?.placement.acceptedSyntaxSlots ?? [],
        preset?.placement.requiredAnyAncestorCapabilities ?? [],
      );
    },
    onTemplateDragEnd: () => options.blockTree.setTemplateDrag(null),
    onInsertSelected: (templateId) => {
      const target = options.blockTree.getSelectedEntry();
      if (target !== null) options.elements.showInspector("edit");
      const pending = consumeCanvasPresetInsertTarget(
        canvasPresetInsertTarget,
        target,
        options.getAnalysis(),
      );
      canvasPresetInsertTarget = null;
      void (pending === null
        ? assembly.insertAfterSelected(templateId, target)
        : assembly.insert({
            templateId,
            target: pending.target,
            position: pending.position,
          }));
    },
  });

  const blockLibrary: BlockLibraryManager = createBlockLibraryManager(
    options.elements.getPageHost("block-library"),
    catalog,
    {
      validateSource(source) {
        const analyzer = options.getAnalyzer();
        if (analyzer === null) throw new Error("C 解析器尚未准备好");
        return validateLearningTemplateSource(analyzer, source);
      },
      confirmRetire(message) {
        return globalThis.confirm(message);
      },
      onCatalogChange() {
        palette.refresh();
      },
    },
  );

  const softwareLibrary: SoftwareLibrary = createSoftwareLibrary(
    options.elements.getPageHost("software-library"),
    {
      onOpenFeature(pageId, targetId) {
        if (pageId === "tutorials") {
          const EventConstructor = options.elements.shell.ownerDocument.defaultView?.CustomEvent;
          if (EventConstructor === undefined) return;
          options.elements.shell.dispatchEvent(
            new EventConstructor(WORKBENCH_OPEN_TUTORIAL_EVENT, {
              detail: Object.freeze({ lessonId: targetId }),
            }),
          );
          return;
        }
        if (targetId === "mentor-hints") options.elements.focusPanel("mentor");
        else options.elements.showPage(pageId);
        globalThis.requestAnimationFrame(() =>
          revealFeatureTarget(options.elements.shell, targetId),
        );
      },
      onStartGuidedLesson: options.onStartGuidedLesson,
      onOpenTutorialLesson(lessonId) {
        const EventConstructor = options.elements.shell.ownerDocument.defaultView?.CustomEvent;
        if (EventConstructor === undefined) return;
        options.elements.shell.dispatchEvent(
          new EventConstructor(WORKBENCH_OPEN_TUTORIAL_EVENT, {
            detail: Object.freeze({ lessonId }),
          }),
        );
      },
    },
  );
  const tutorialsModule: LibraryTutorialsModule = createLibraryTutorialsModule(
    options.elements.getPageHost("tutorials"),
    {
      onOpenLibraryEntry(entryId) {
        options.elements.showPage("software-library");
        softwareLibrary.selectEntry(entryId);
      },
      traceApi: options.traceApi,
      onOpenFoaWorkspace: options.onOpenFoaWorkspace,
      onCourseBlocked(message) {
        options.onError(new Error(message));
      },
    },
  );
  const onWorkbenchAction = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isRecord(detail) || typeof detail.branchId !== "string") {
      return;
    }
    if (detail.rootId === "library") softwareLibrary?.selectBranch(detail.branchId);
    else if (detail.rootId === "presets" && detail.branchId !== "custom-lifecycle") {
      palette.setCategory(detail.branchId as BlockPaletteCategory);
    }
  };
  const onCompatibleBlockSearch = (event: Event): void => {
    const request = (event as CustomEvent<unknown>).detail;
    if (!isCompatibleBlockSearchRequest(request)) return;
    palette.setCompatibilityFilter({
      direction: request.compatibleDirection,
      channel: request.endpoint.channel,
    });
    options.elements.focusPanel("presets");
    palette.focusSearch();
  };
  const onOpenTutorial = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isRecord(detail) || typeof detail.lessonId !== "string") return;
    options.elements.showPage("tutorials");
    tutorialsModule.selectLesson(detail.lessonId);
  };
  const onQuickOpenCollect = (event: Event): void => {
    const detail = quickOpenCollectDetail(event);
    if (detail === null) return;
    const snapshot = catalog.snapshot();
    const english = options.elements.shell.dataset.locale === "en";
    const stageLabels = new Map(snapshot.stages.map((stage) => [stage.id, stage.label]));
    const presets: readonly QuickOpenItem[] = Object.freeze(
      detail.scope !== null && detail.scope !== "preset"
        ? []
        : filterLearningTemplates(snapshot, "all", "", "all", null).map((preset, index) =>
            Object.freeze({
              id: quickOpenItemId("preset", preset.id),
              kind: "preset" as const,
              targetId: preset.id,
              label: english
                ? preset.source === null
                  ? preset.id
                  : compactQuickOpenSource(preset.source)
                : preset.label,
              detail: english
                ? `Block · ${preset.category} / ${preset.stage}`
                : `积木 · ${stageLabels.get(preset.stage) ?? preset.stage}`,
              keywords: Object.freeze([
                preset.id,
                preset.label,
                preset.category,
                preset.description,
                preset.source ?? "虚拟流程节点",
              ]),
              order: index,
            }),
          ),
    );
    const library: readonly QuickOpenItem[] = Object.freeze(
      detail.scope !== null && detail.scope !== "library"
        ? []
        : searchLibrary(detail.query, { audiences: ["learner", "help"], limit: 400 }).map(
            ({ entry }, index) =>
              Object.freeze({
                id: quickOpenItemId("library", entry.id),
                kind: "library" as const,
                targetId: entry.id,
                label: english ? (englishAlias(entry.aliases) ?? entry.id) : entry.title,
                detail: english ? `Library · ${entry.branchId}` : entry.summary,
                keywords: Object.freeze([
                  entry.id,
                  entry.title,
                  entry.summary,
                  entry.branchId,
                  ...entry.aliases,
                  ...entry.keywords,
                  entry.syntax?.code ?? "",
                  entry.complexity ?? "",
                ]),
                order: index,
              }),
          ),
    );
    detail.add(presets);
    detail.add(library);
  };
  const onQuickOpenActivate = (event: Event): void => {
    const detail = quickOpenActivateDetail(event);
    if (detail?.item.kind === "preset") {
      try {
        options.elements.focusPanel("presets");
        palette.revealPreset(detail.item.targetId);
      } catch (error: unknown) {
        options.elements.importStatus.textContent =
          error instanceof Error ? error.message : "积木结果已失效，请重新搜索。";
        options.elements.importStatus.dataset.state = "warning";
      }
    } else if (detail?.item.kind === "library") {
      options.elements.showPage("software-library");
      softwareLibrary.selectEntry(detail.item.targetId);
    }
  };
  options.elements.shell.addEventListener("workbench-action", onWorkbenchAction);
  options.elements.shell.addEventListener(
    "flow-canvas-compatible-block-search",
    onCompatibleBlockSearch,
  );
  options.elements.shell.addEventListener(WORKBENCH_QUICK_OPEN_COLLECT_EVENT, onQuickOpenCollect);
  options.elements.shell.addEventListener(WORKBENCH_QUICK_OPEN_ACTIVATE_EVENT, onQuickOpenActivate);
  options.elements.shell.addEventListener(WORKBENCH_OPEN_TUTORIAL_EVENT, onOpenTutorial);
  return Object.freeze({
    insert(intent: AssemblyInsertIntent): Promise<void> {
      if (destroyed) return Promise.resolve();
      canvasPresetInsertTarget = null;
      options.elements.showInspector("edit");
      return assembly.insert(intent);
    },
    prepareCanvasPresetInsert(target: CanvasPresetInsertTarget): void {
      if (destroyed) return;
      const analysis = options.getAnalysis();
      if (
        analysis === null ||
        fingerprintSource(analysis.document.source) !== target.sourceFingerprint
      ) {
        options.onError(new Error("画布插入位置已经过期，请重新点击连接上的 +。"));
        return;
      }
      canvasPresetInsertTarget = Object.freeze({ ...target });
      const presetIds = catalog
        .snapshot()
        .presets.filter((preset) => {
          try {
            buildAssemblyInsertRequest(catalog, analysis, {
              templateId: preset.id,
              target: target.target,
              position: target.position,
            });
            return true;
          } catch {
            return false;
          }
        })
        .map((preset) => preset.id);
      palette.setCompatibilityFilter({
        direction: "input",
        channel: "control",
        presetIds,
      });
      palette.setInsertEnabled(true);
      options.elements.focusPanel("presets");
      palette.focusSearch();
    },
    listCompatibleCanvasPresets(
      target: CanvasPresetInsertTarget,
      locale: "zh-CN" | "en",
    ): readonly CanvasEdgeInsertPreset[] {
      if (destroyed) return Object.freeze([]);
      const analysis = requireCanvasPresetAnalysis(options.getAnalysis(), target);
      return Object.freeze(
        catalog.snapshot().presets.flatMap((preset) => {
          if (preset.source === null) return [];
          try {
            buildAssemblyInsertRequest(catalog, analysis, {
              templateId: preset.id,
              target: target.target,
              position: target.position,
            });
          } catch {
            return [];
          }
          const presentation = presentPresetBlock(preset, locale);
          return [
            Object.freeze({
              id: preset.id,
              label: presentation.label,
              description: presentation.description,
              source: preset.source,
            }),
          ];
        }),
      );
    },
    insertCanvasPreset(target: CanvasPresetInsertTarget, presetId: string): boolean {
      if (destroyed) return false;
      try {
        const analysis = requireCanvasPresetAnalysis(options.getAnalysis(), target);
        const request = buildAssemblyInsertRequest(catalog, analysis, {
          templateId: presetId,
          target: target.target,
          position: target.position,
        });
        void options.structureEdits.run(request).catch((error: unknown) => {
          if (!destroyed) options.onError(asLearningSurfaceError(error));
        });
        return true;
      } catch (error: unknown) {
        options.onError(asLearningSurfaceError(error));
        return false;
      }
    },
    setSelectedInsertEnabled(enabled: boolean): void {
      if (!destroyed) palette.setInsertEnabled(enabled);
    },
    recordRuntimeObservation(observation: RuntimeLearningObservation): void {
      if (!destroyed) tutorialsModule.recordRuntimeObservation(observation);
    },
    resolvePreset(presetId: string) {
      if (destroyed) return null;
      const preset = catalog.getPreset(presetId);
      return preset === null
        ? null
        : Object.freeze({
            id: preset.id,
            version: preset.version,
            label: preset.label,
            source: preset.source,
            blockKind: preset.blockKind,
            lifecycle: preset.lifecycle,
            ports: Object.freeze(preset.ports.map((port) => Object.freeze({ ...port }))),
            acceptedSyntaxSlots: Object.freeze([...preset.placement.acceptedSyntaxSlots]),
            requiredAnyAncestorCapabilities: Object.freeze([
              ...preset.placement.requiredAnyAncestorCapabilities,
            ]),
          });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      canvasPresetInsertTarget = null;
      options.elements.shell.removeEventListener("workbench-action", onWorkbenchAction);
      options.elements.shell.removeEventListener(
        "flow-canvas-compatible-block-search",
        onCompatibleBlockSearch,
      );
      options.elements.shell.removeEventListener(
        WORKBENCH_QUICK_OPEN_COLLECT_EVENT,
        onQuickOpenCollect,
      );
      options.elements.shell.removeEventListener(
        WORKBENCH_QUICK_OPEN_ACTIVATE_EVENT,
        onQuickOpenActivate,
      );
      options.elements.shell.removeEventListener(WORKBENCH_OPEN_TUTORIAL_EVENT, onOpenTutorial);
      tutorialsModule.destroy();
      softwareLibrary.destroy();
      blockLibrary.destroy();
      palette.destroy();
      assembly.destroy();
    },
  });
}

function requireCanvasPresetAnalysis(
  analysis: CAnalysisSnapshot | null,
  target: CanvasPresetInsertTarget,
): CAnalysisSnapshot {
  if (
    analysis === null ||
    fingerprintSource(analysis.document.source) !== target.sourceFingerprint
  ) {
    throw new Error("画布插入位置已经过期，请重新点击连接上的 +。");
  }
  return analysis;
}

function asLearningSurfaceError(error: unknown): Error {
  return error instanceof Error ? error : new Error("无法从画布插入预设积木");
}

function consumeCanvasPresetInsertTarget(
  pending: CanvasPresetInsertTarget | null,
  selected: BlockIndexEntry | null,
  analysis: CAnalysisSnapshot | null,
): CanvasPresetInsertTarget | null {
  if (
    pending === null ||
    selected === null ||
    analysis === null ||
    fingerprintSource(analysis.document.source) !== pending.sourceFingerprint ||
    !sameBlockEntry(selected, pending.target)
  ) {
    return null;
  }
  return pending;
}

function sameBlockEntry(left: BlockIndexEntry, right: BlockIndexEntry): boolean {
  if (!(
    left.index === right.index &&
    left.kind === right.kind &&
    left.range.from === right.range.from &&
    left.range.to === right.range.to
  )) {
    return false;
  }
  if (left.block === null || right.block === null) return left.block === right.block;
  return (
    left.block.kind === right.block.kind &&
    (left.block.kind !== "syntax" ||
      (right.block.kind === "syntax" && left.block.nodeType === right.block.nodeType))
  );
}

function isCompatibleBlockSearchRequest(
  value: unknown,
): value is FlowCanvasCompatibleBlockSearchRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Partial<FlowCanvasCompatibleBlockSearchRequest>;
  return (
    typeof input.sourceFingerprint === "string" &&
    (input.compatibleDirection === "input" || input.compatibleDirection === "output") &&
    input.endpoint !== undefined &&
    (input.endpoint.channel === "control" || input.endpoint.channel === "data")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revealFeatureTarget(root: HTMLElement, targetId: string): void {
  for (const target of root.querySelectorAll<HTMLElement>("[data-tour-target]")) {
    if (target.dataset.tourTarget !== targetId || target.hidden) continue;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    return;
  }
}

function browserStorage(): LearningCatalogStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function compactQuickOpenSource(source: string): string {
  const compact = source.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= 52 ? compact : `${compact.slice(0, 49)}…`;
}

function englishAlias(aliases: readonly string[]): string | null {
  return aliases.find((alias) => /[A-Za-z]/u.test(alias)) ?? null;
}
