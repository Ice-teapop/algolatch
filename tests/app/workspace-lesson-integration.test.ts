import { describe, expect, it, vi } from "vitest";
import type { WorkspaceControllerOptions } from "../../src/app/workspace-controller.js";
import type { WorkspaceEntrySummary } from "../../src/shared/workspace.js";

const integrationMock = vi.hoisted(() => ({
  workspaceOptions: null as WorkspaceControllerOptions | null,
  guidedSetWorkspaceEntry: vi.fn<(entry: WorkspaceEntrySummary | null) => Promise<void>>(),
}));

vi.mock("../../src/app/workspace-controller.js", () => ({
  createWorkspaceController(options: WorkspaceControllerOptions) {
    integrationMock.workspaceOptions = options;
    return {
      dashboard: {},
      activeEntry: null,
      hasUnsavedChanges: false,
      initialize: async () => undefined,
      refresh: async () => undefined,
      async createDocument(_kind: string, _title: string, initialSource?: string) {
        const entry = workspaceEntry("lesson-workspace");
        options.load({
          source: initialSource ?? "",
          displayName: "lesson.c",
          origin: "workspace",
        });
        await options.onActiveEntryChange?.(entry);
        return true;
      },
      handleSourceChange: () => undefined,
      flush: async () => undefined,
      prepareExternalImport: async () => true,
      deactivate: async () => undefined,
      destroy: () => undefined,
    };
  },
}));

vi.mock("../../src/app/guided-lesson-workspace-controller.js", () => ({
  createGuidedLessonWorkspaceController() {
    return {
      setWorkspaceEntry: integrationMock.guidedSetWorkspaceEntry,
      handleSourceChanged: vi.fn(),
    };
  },
}));

import { createWorkspaceLessonIntegration } from "../../src/app/workspace-lesson-integration.js";
import { createFoaWorkspaceLaunchContract, FOA_LESSONS } from "../../src/tutorials/index.js";

describe("workspace lesson integration", () => {
  it("configures a tutorial case only after flow, runtime, and lesson consumers adopt the workspace", async () => {
    const flowAdoption = deferred<void>();
    const runtimeAdoption = deferred<void>();
    const lessonAdoption = deferred<void>();
    integrationMock.guidedSetWorkspaceEntry.mockImplementation(async () => lessonAdoption.promise);
    const configureTutorialCase = vi.fn();
    const setWorkspaceLessonFocus = vi.fn();
    const loadSource = vi.fn();
    const lesson = FOA_LESSONS.find((candidate) => candidate.mode === "workspace-evidence");
    expect(lesson).toBeDefined();
    const launch = createFoaWorkspaceLaunchContract(lesson!);
    expect(launch).not.toBeNull();
    const integration = createWorkspaceLessonIntegration({
      elements: {
        shell: { dataset: { locale: "en" } },
        workspaceSaveStatus: {},
        workspaceRecoveryButton: {},
        getPageHost: vi.fn(() => ({})),
        showPage: vi.fn(),
        focusPanel: vi.fn(),
        setWorkspaceLessonFocus,
      } as never,
      api: {} as never,
      codePane: {
        getSource: () => "int main(void) { return 0; }\n",
      } as never,
      flow: {
        projection: null,
        setWorkspaceEntry: vi.fn(async () => flowAdoption.promise),
      } as never,
      runtime: {
        setWorkspaceEntry: vi.fn(async () => runtimeAdoption.promise),
        configureTutorialCase,
      } as never,
      loadSource,
      getCurrentDocument: () => null,
      onError: vi.fn(),
    });

    integration.openFoaLesson(lesson!);
    await flushMicrotasks();
    expect(configureTutorialCase).not.toHaveBeenCalled();

    flowAdoption.resolve();
    runtimeAdoption.resolve();
    await flushMicrotasks();
    expect(integrationMock.guidedSetWorkspaceEntry).toHaveBeenCalledTimes(1);
    expect(configureTutorialCase).not.toHaveBeenCalled();

    lessonAdoption.resolve();
    await flushMicrotasks();
    expect(configureTutorialCase).toHaveBeenCalledWith(launch!.runtimeCase);
    expect(setWorkspaceLessonFocus).toHaveBeenCalledWith(
      expect.objectContaining({ lessonId: lesson!.id }),
    );
    expect(loadSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: launch!.initialSource, origin: "workspace" }),
    );
    expect(launch!.initialSource).toContain("TODO");
  });
});

function workspaceEntry(id: string): WorkspaceEntrySummary {
  return Object.freeze({
    id,
    kind: "sandbox" as const,
    title: id,
    sourceName: "main.c" as const,
    revision: 0,
    byteLength: 0,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T): void {
      resolvePromise(value as T);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
