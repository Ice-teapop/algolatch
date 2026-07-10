import type { CAnalysisSnapshot } from "../core/index.js";
import { createLearningCatalog, type LearningCatalogStorage } from "../learning/index.js";
import {
  createBlockLibraryManager,
  type BlockLibraryManager,
} from "../ui/block-library-manager.js";
import { createBlockPalette, type BlockPalette } from "../ui/block-palette.js";
import type { AssemblyInsertIntent, BlockTree } from "../ui/block-tree.js";
import { createOnboardingTour } from "../ui/onboarding-tour.js";
import { createSoftwareLibrary } from "../ui/software-library.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";
import { createAssemblyController, type AssemblyController } from "./assembly-controller.js";
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
  readonly onError: (error: Error) => void;
}

export interface LearningSurface {
  insert(intent: AssemblyInsertIntent): Promise<void>;
  setSelectedInsertEnabled(enabled: boolean): void;
  startOnboardingIfNeeded(): void;
  destroy(): void;
}

export function createLearningSurface(options: LearningSurfaceOptions): LearningSurface {
  const storage = browserStorage();
  const catalog = createLearningCatalog(storage === undefined ? {} : { storage });
  const assembly: AssemblyController = createAssemblyController({
    catalog,
    getAnalysis: options.getAnalysis,
    structureEdits: options.structureEdits,
    onError: options.onError,
  });
  let destroyed = false;

  const palette: BlockPalette = createBlockPalette(options.elements.blockPalette, catalog, {
    onTemplateDragStart: (templateId) => options.blockTree.setTemplateDrag(templateId),
    onTemplateDragEnd: () => options.blockTree.setTemplateDrag(null),
    onInsertSelected: (templateId) => {
      const target = options.blockTree.getSelectedEntry();
      if (target !== null) options.elements.showInspector("edit");
      void assembly.insertAfterSelected(templateId, target);
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

  const onboarding = createOnboardingTour(options.elements.shell, {
    navigate: (pageId) => options.elements.showPage(pageId),
    getCurrentPage: () => options.elements.currentPage,
  });
  const softwareLibrary = createSoftwareLibrary(options.elements.getPageHost("software-library"), {
    onOpenFeature(pageId, targetId) {
      options.elements.showPage(pageId);
      globalThis.requestAnimationFrame(() => revealTourTarget(options.elements.shell, targetId));
    },
    onStartTour: () => onboarding.openFromLibrary(),
  });
  const autoStartEnabled = globalThis.navigator?.webdriver !== true;

  return Object.freeze({
    insert(intent: AssemblyInsertIntent): Promise<void> {
      if (destroyed) return Promise.resolve();
      options.elements.showInspector("edit");
      return assembly.insert(intent);
    },
    setSelectedInsertEnabled(enabled: boolean): void {
      if (!destroyed) palette.setInsertEnabled(enabled);
    },
    startOnboardingIfNeeded(): void {
      if (!destroyed && autoStartEnabled) onboarding.startIfNeeded();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      softwareLibrary.destroy();
      onboarding.destroy();
      blockLibrary.destroy();
      palette.destroy();
      assembly.destroy();
    },
  });
}

function revealTourTarget(root: HTMLElement, targetId: string): void {
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
