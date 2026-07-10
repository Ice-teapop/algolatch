import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceImportController } from "../../src/app/source-import-controller.js";
import type { SourceImportResult } from "../../src/shared/api.js";
import type { WorkbenchElements } from "../../src/ui/workbench-shell.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("source import controller", () => {
  it("owns enabled and status state with strict inputs", () => {
    const harness = createHarness();
    const controller = createSourceImportController(harness.elements, { load: vi.fn() });

    controller.setEnabled(true);
    controller.setStatus("就绪", "ready");

    expect(harness.openButton.disabled).toBe(false);
    expect(harness.pasteButton.disabled).toBe(false);
    expect(harness.importStatus.textContent).toBe("就绪");
    expect(harness.importStatus.dataset.state).toBe("ready");
    expect(() => controller.setStatus("bad", "invalid" as never)).toThrow(/合法 state/u);
  });

  it("loads the latest native-open result and ignores completion after destroy", async () => {
    const first = deferred<SourceImportResult>();
    const second = deferred<SourceImportResult>();
    const openSource = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const harness = createHarness({ openSource });
    const load = vi.fn();
    const controller = createSourceImportController(harness.elements, { load });

    harness.openButton.dispatchEvent(new Event("click"));
    harness.openButton.dispatchEvent(new Event("click"));
    first.resolve(opened("old.c"));
    second.resolve(opened("new.c"));
    await flushMicrotasks();

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "new.c" }),
      expect.any(Function),
    );

    const late = deferred<SourceImportResult>();
    openSource.mockReturnValueOnce(late.promise);
    harness.openButton.dispatchEvent(new Event("click"));
    controller.destroy();
    late.resolve(opened("late.c"));
    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not let an older asynchronous load overwrite a newer import", async () => {
    const releaseOldLoad = deferred<void>();
    const openSource = vi
      .fn()
      .mockResolvedValueOnce(opened("old.c"))
      .mockResolvedValueOnce(opened("new.c"));
    const harness = createHarness({ openSource });
    const committed: string[] = [];
    const load = vi.fn(async (document: { displayName: string }, isCurrent: () => boolean) => {
      if (document.displayName === "old.c") await releaseOldLoad.promise;
      if (isCurrent()) committed.push(document.displayName);
    });
    const controller = createSourceImportController(harness.elements, { load });

    harness.openButton.dispatchEvent(new Event("click"));
    await flushMicrotasks();
    harness.openButton.dispatchEvent(new Event("click"));
    await flushMicrotasks();
    expect(committed).toEqual(["new.c"]);

    releaseOldLoad.resolve(undefined);
    await flushMicrotasks();
    expect(committed).toEqual(["new.c"]);
    expect(harness.importStatus.textContent).toContain("new.c");
    controller.destroy();
  });

  it("keeps invalid paste local and loads a valid exact source", async () => {
    const harness = createHarness();
    const load = vi.fn();
    const controller = createSourceImportController(harness.elements, { load });

    harness.pasteButton.dispatchEvent(new Event("click"));
    expect(harness.pasteDialog.showCount).toBe(1);
    expect(harness.pasteSource.focusCount).toBe(1);

    harness.pasteSource.value = "int main(void) {\0}";
    harness.pasteConfirm.dispatchEvent(new Event("click"));
    expect(load).not.toHaveBeenCalled();
    expect(harness.pasteError.textContent).not.toBe("");

    harness.pasteSource.value = "int main(void) {\r\n  return 0;\r\n}\r\n";
    harness.pasteConfirm.dispatchEvent(new Event("click"));
    await flushMicrotasks();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ source: "int main(void) {\r\n  return 0;\r\n}\r\n" }),
      expect.any(Function),
    );
    expect(harness.pasteDialog.closeValue).toBe("loaded");
    controller.destroy();
  });

  it("routes a single dropped file and rejects multi-file drops", async () => {
    const harness = createHarness({
      openDroppedSource: vi.fn().mockResolvedValue(opened("drop.c")),
    });
    const load = vi.fn();
    const controller = createSourceImportController(harness.elements, { load });

    harness.shell.dispatchEvent(dropEvent([{} as File, {} as File]));
    expect(harness.importStatus.dataset.state).toBe("error");

    harness.shell.dispatchEvent(dropEvent([{} as File]));
    await flushMicrotasks();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "drop.c" }),
      expect.any(Function),
    );
    controller.destroy();
  });
});

function createHarness(
  overrides: {
    readonly openSource?: () => Promise<SourceImportResult>;
    readonly openDroppedSource?: (file: File) => Promise<SourceImportResult>;
  } = {},
) {
  const openButton = new FakeButton();
  const pasteButton = new FakeButton();
  const pasteConfirm = new FakeButton();
  const pasteDialog = new FakeDialog();
  const pasteSource = new FakeTextArea();
  const pasteError = new FakeElement();
  const importStatus = new FakeElement();
  const dropOverlay = new FakeElement();
  const shell = new FakeElement();
  vi.stubGlobal("window", {
    panelApi: {
      openSource: overrides.openSource ?? vi.fn().mockResolvedValue({ status: "cancelled" }),
      openDroppedSource:
        overrides.openDroppedSource ?? vi.fn().mockResolvedValue({ status: "cancelled" }),
    },
  });
  return {
    elements: {
      openButton,
      pasteButton,
      pasteConfirm,
      pasteDialog,
      pasteSource,
      pasteError,
      importStatus,
      dropOverlay,
      shell,
    } as unknown as WorkbenchElements,
    openButton,
    pasteButton,
    pasteConfirm,
    pasteDialog,
    pasteSource,
    pasteError,
    importStatus,
    shell,
  };
}

class FakeElement extends EventTarget {
  hidden = true;
  textContent = "";
  readonly dataset: Record<string, string | undefined> = {};
}

class FakeButton extends FakeElement {
  disabled = true;
}

class FakeDialog extends FakeElement {
  showCount = 0;
  closeValue = "";

  showModal(): void {
    this.showCount += 1;
  }

  close(value = ""): void {
    this.closeValue = value;
  }
}

class FakeTextArea extends FakeElement {
  value = "";
  focusCount = 0;

  focus(): void {
    this.focusCount += 1;
  }
}

function opened(displayName: string): SourceImportResult {
  return {
    status: "opened",
    document: { source: "int main(void){return 0;}\n", displayName, origin: "paste" },
  };
}

function dropEvent(files: readonly File[]): Event {
  const event = new Event("drop", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files },
  });
  return event;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
