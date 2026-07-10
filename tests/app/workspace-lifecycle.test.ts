import { describe, expect, it, vi } from "vitest";
import { installWorkspaceLifecycle } from "../../src/app/workspace-lifecycle.js";

describe("workspace renderer lifecycle", () => {
  it("registers a close handler that waits for the workspace flush", async () => {
    const harness = createHarness(false);
    const lifecycle = installWorkspaceLifecycle(harness.options);

    await harness.closeHandler?.();

    expect(harness.flush).toHaveBeenCalledTimes(1);
    lifecycle.destroy();
  });

  it("blocks a reload until dirty source is durable", async () => {
    const deferred = deferredPromise();
    const harness = createHarness(true, () => deferred.promise);
    installWorkspaceLifecycle(harness.options);
    const event = new Event("beforeunload", { cancelable: true });

    harness.target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.destroy).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();

    deferred.resolve();
    await flushMicrotasks();
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the renderer open after a failed flush and retries on the next unload", async () => {
    let attempt = 0;
    const harness = createHarness(true, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("disk unavailable");
    });
    installWorkspaceLifecycle(harness.options);

    harness.target.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    await flushMicrotasks();
    expect(harness.destroy).not.toHaveBeenCalled();

    harness.target.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    await flushMicrotasks();
    expect(harness.flush).toHaveBeenCalledTimes(2);
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });
});

function createHarness(hasUnsavedChanges: boolean, flushImplementation?: () => Promise<void>) {
  const target = new EventTarget();
  const flush = vi.fn(flushImplementation ?? (async () => undefined));
  const destroy = vi.fn();
  const reload = vi.fn();
  let closeHandler: (() => Promise<void>) | undefined;
  return {
    target,
    flush,
    destroy,
    reload,
    get closeHandler(): (() => Promise<void>) | undefined {
      return closeHandler;
    },
    options: {
      workspace: { hasUnsavedChanges, flush },
      onCloseRequested(handler: () => Promise<void>): () => void {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      },
      destroy,
      targetWindow: target as unknown as Window,
      reload,
    },
  };
}

function deferredPromise(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
