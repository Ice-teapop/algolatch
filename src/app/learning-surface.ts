import type { CAnalysisSnapshot } from "../core/index.js";
import { createLearningCatalog, type LearningCatalogStorage } from "../learning/index.js";
import { createOnboardingDialog } from "../ui/onboarding-dialog.js";
import {
  createBlockLibraryManager,
  type BlockLibraryManager,
} from "../ui/block-library-manager.js";
import { createBlockPalette, type BlockPalette } from "../ui/block-palette.js";
import type { AssemblyInsertIntent, BlockTree } from "../ui/block-tree.js";
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
  destroy(): void;
}

export function createLearningSurface(options: LearningSurfaceOptions): LearningSurface {
  const storage = browserStorage();
  const catalog = createLearningCatalog(storage === undefined ? {} : { storage });
  const assembly = createAssemblyController({
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

  const library: BlockLibraryManager = createBlockLibraryManager(
    options.elements.getPageHost("library"),
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

  const onboarding = createOnboardingDialog(options.elements.shell, {
    autoOpen: globalThis.navigator?.webdriver !== true,
  });
  const guide = mountGuidePage(options.elements.getPageHost("guide"), () => {
    onboarding.openFromDock();
  });

  return Object.freeze({
    insert(intent: AssemblyInsertIntent): Promise<void> {
      if (destroyed) return Promise.resolve();
      options.elements.showInspector("edit");
      return assembly.insert(intent);
    },
    setSelectedInsertEnabled(enabled: boolean): void {
      if (!destroyed) palette.setInsertEnabled(enabled);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      guide.destroy();
      onboarding.destroy();
      library.destroy();
      palette.destroy();
      assembly.destroy();
    },
  });
}

function mountGuidePage(host: HTMLElement, openGuide: () => void): { destroy(): void } {
  const ownerDocument = host.ownerDocument;
  const root = ownerDocument.createElement("section");
  root.className = "guide-page";
  const heading = ownerDocument.createElement("h2");
  heading.textContent = "工作台入门";
  const copy = ownerDocument.createElement("p");
  copy.textContent = "通过问答了解积木拖拽、代码同步、自定义积木、弃用与删除，以及差异确认和撤销。";
  const button = ownerDocument.createElement("button");
  button.className = "button button--primary";
  button.type = "button";
  button.textContent = "重新开始问答引导";
  button.addEventListener("click", openGuide);
  root.append(heading, copy, button);
  host.append(root);
  return Object.freeze({
    destroy(): void {
      button.removeEventListener("click", openGuide);
      root.remove();
    },
  });
}

function browserStorage(): LearningCatalogStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
