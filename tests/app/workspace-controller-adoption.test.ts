import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDashboardCallbacks } from "../../src/ui/workspace-dashboard.js";

const dashboardMock = vi.hoisted(() => ({
  callbacks: null as WorkspaceDashboardCallbacks | null,
}));

vi.mock("../../src/ui/workspace-dashboard.js", () => ({
  createWorkspaceDashboard(_host: HTMLElement, callbacks: WorkspaceDashboardCallbacks) {
    dashboardMock.callbacks = callbacks;
    return {
      element: {} as HTMLElement,
      filter: "recent" as const,
      setSnapshot: vi.fn(),
      setSnapshotUnconfirmed: vi.fn(),
      setBusy: vi.fn(),
      setStatus: vi.fn(),
      openCreate: vi.fn(),
      destroy: vi.fn(),
    };
  },
}));

import { createWorkspaceController } from "../../src/app/workspace-controller.js";
import type { WorkspaceControllerOptions } from "../../src/app/workspace-controller.js";
import type { WorkspaceDocument } from "../../src/shared/workspace.js";
import { INSERTION_SORT_SAMPLE_SOURCE } from "../../src/samples/insertion-sort-sandbox.js";

class FakeOutputElement extends EventTarget {
  readonly dataset: Record<string, string> = {};
  hidden = false;
  textContent: string | null = null;
}

class FakeButtonElement extends EventTarget {
  disabled = false;
  hidden = false;
}

beforeAll(() => {
  Object.defineProperty(globalThis, "HTMLOutputElement", {
    configurable: true,
    value: FakeOutputElement,
  });
  Object.defineProperty(globalThis, "HTMLButtonElement", {
    configurable: true,
    value: FakeButtonElement,
  });
});

beforeEach(() => {
  dashboardMock.callbacks = null;
});

describe("workspace active-entry adoption", () => {
  it("does not resolve createDocument until every active-entry consumer has adopted it", async () => {
    const consumer = deferred<void>();
    const entered = vi.fn();
    const controller = createHarness({
      enterWorkbench: entered,
      onActiveEntryChange: async () => consumer.promise,
    });

    let settled = false;
    const created = controller.createDocument("sandbox", "Lesson").then((result) => {
      settled = true;
      return result;
    });
    await flushMicrotasks();

    expect(settled).toBe(false);
    expect(entered).not.toHaveBeenCalled();

    consumer.resolve();
    await expect(created).resolves.toBe(true);
    expect(entered).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("serializes rapid opens so an older sidecar consumer cannot finish after the newer one", async () => {
    const firstConsumer = deferred<void>();
    const events: string[] = [];
    const controller = createHarness({
      openDocument(entryId) {
        return Promise.resolve({ status: "opened" as const, document: document(entryId) });
      },
      async onActiveEntryChange(entry) {
        if (entry === null) return;
        events.push(`start:${entry.id}`);
        if (entry.id === "first") await firstConsumer.promise;
        events.push(`end:${entry.id}`);
      },
    });
    const callbacks = dashboardMock.callbacks;
    if (callbacks === null) throw new Error("dashboard callbacks were not installed");

    const first = Promise.resolve(callbacks.onOpen("first"));
    await flushMicrotasks();
    const second = Promise.resolve(callbacks.onOpen("second"));
    await flushMicrotasks();

    expect(events).toEqual(["start:first"]);
    firstConsumer.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    expect(controller.activeEntry?.id).toBe("second");
    controller.destroy();
  });

  it("detaches the old sidecar consumer before loading the next entry source", async () => {
    let consumerEntryId: string | null = null;
    const detach = deferred<void>();
    const order: string[] = [];
    const writesObservedDuringLoad: string[] = [];
    const controller = createHarness({
      load(document) {
        order.push(`load:${document.displayName}`);
        if (consumerEntryId !== null) {
          writesObservedDuringLoad.push(`${consumerEntryId}:${document.displayName}`);
        }
      },
      async onActiveEntryChange(entry) {
        if (entry === null && consumerEntryId === "first") {
          order.push("unbind:first");
          await detach.promise;
        }
        consumerEntryId = entry?.id ?? null;
        if (entry !== null) order.push(`bind:${entry.id}`);
      },
    });
    const callbacks = dashboardMock.callbacks;
    if (callbacks === null) throw new Error("dashboard callbacks were not installed");

    await callbacks.onOpen("first");
    const second = Promise.resolve(callbacks.onOpen("second"));
    await flushMicrotasks();

    expect(order).toEqual(["load:first.c", "bind:first", "unbind:first"]);
    detach.resolve();
    await second;

    expect(writesObservedDuringLoad).not.toContain("first:second.c");
    expect(order).toEqual([
      "load:first.c",
      "bind:first",
      "unbind:first",
      "load:second.c",
      "bind:second",
    ]);
    expect(controller.activeEntry?.id).toBe("second");
    controller.destroy();
  });

  it("creates the explicit sample through the atomic workspace create request", async () => {
    const createDocument = vi.fn(async () => ({
      status: "opened" as const,
      document: document("sample"),
    }));
    const controller = createHarness({ createDocument });
    const callbacks = dashboardMock.callbacks;
    if (callbacks === null) throw new Error("dashboard callbacks were not installed");

    await callbacks.onCreateSample();

    expect(createDocument).toHaveBeenCalledWith({
      kind: "sandbox",
      title: "示例 · 插入排序",
      initialSource: INSERTION_SORT_SAMPLE_SOURCE,
    });
    controller.destroy();
  });
});

function createHarness(overrides: {
  readonly enterWorkbench?: () => void;
  readonly onActiveEntryChange?: (entry: WorkspaceDocument["entry"] | null) => void | Promise<void>;
  readonly openDocument?: (
    entryId: string,
  ) => Promise<{ readonly status: "opened"; readonly document: WorkspaceDocument }>;
  readonly load?: (document: Parameters<WorkspaceControllerOptions["load"]>[0]) => void;
  readonly createDocument?: WorkspaceControllerOptions["api"]["createWorkspaceDocument"];
}) {
  return createWorkspaceController({
    host: {
      closest: () => null,
      ownerDocument: { defaultView: null },
    } as unknown as HTMLElement,
    api: {
      listWorkspaceDocuments: async () => ({
        status: "ready",
        snapshot: { rootName: "test", entries: [] },
      }),
      createWorkspaceDocument:
        overrides.createDocument ??
        (async () => ({
          status: "opened",
          document: document("created"),
        })),
      openWorkspaceDocument: async ({ entryId }) =>
        overrides.openDocument?.(entryId) ?? {
          status: "opened",
          document: document(entryId),
        },
      saveWorkspaceDocument: async () => ({
        status: "saved",
        entry: document("created").entry,
      }),
    },
    saveStatus: new FakeOutputElement() as unknown as HTMLOutputElement,
    recoveryButton: new FakeButtonElement() as unknown as HTMLButtonElement,
    load: overrides.load ?? vi.fn(),
    getCurrentDocument: () => null,
    enterWorkbench: overrides.enterWorkbench ?? vi.fn(),
    onActiveEntryChange: overrides.onActiveEntryChange,
  });
}

function document(id: string): WorkspaceDocument {
  return Object.freeze({
    entry: Object.freeze({
      id,
      kind: "sandbox" as const,
      title: id,
      sourceName: "main.c" as const,
      revision: 0,
      byteLength: 22,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    }),
    source: "int main(void) { return 0; }\n",
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
