import { createStartupLoader, type StartupLoader } from "../ui/startup-loader.js";
import { createThemeController } from "../ui/theme-controller.js";
import { mountWorkbench, type WorkbenchElements } from "../ui/workbench-shell.js";
import { createBuiltinWorkbenchRegistry } from "../workbench/builtin-modules.js";
import type { WorkbenchRegistrySnapshot } from "../workbench/contracts.js";

export interface WorkbenchRuntime {
  readonly elements: WorkbenchElements;
  readonly startupLoader: StartupLoader;
  readonly registrySnapshot: WorkbenchRegistrySnapshot;
  destroy(): void;
}

export function createWorkbenchRuntime(app: HTMLElement): WorkbenchRuntime {
  const registry = createBuiltinWorkbenchRegistry();
  const registrySnapshot = registry.snapshot();
  const elements = mountWorkbench(app, registrySnapshot);
  const startupLoader = createStartupLoader({
    root: elements.startupRoot,
    progress: elements.startupProgress,
    status: elements.startupStatus,
  });
  const themeController = createThemeController({
    root: document.documentElement,
    button: elements.themeButton,
  });
  let destroyed = false;

  return Object.freeze({
    elements,
    startupLoader,
    registrySnapshot,
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      startupLoader.destroy();
      themeController.destroy();
      elements.destroy();
    },
  });
}
