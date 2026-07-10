import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupLoader, type StartupLoaderElements } from "../../src/ui/startup-loader.js";

describe("startup loader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances only when real initialization stages are reported", () => {
    const elements = createElements();
    const loader = createStartupLoader(elements as unknown as StartupLoaderElements);

    expect(loader.stage).toBe("shell");
    expect(loader.progress).toBe(8);
    expect(elements.status.textContent).toBe("正在建立本地工作台…");

    loader.advance("parser");
    expect(loader.progress).toBe(32);
    expect(elements.progress.value).toBe(32);
    loader.advance("parser-ready");
    loader.advance("source");
    expect(loader.progress).toBe(86);
    expect(elements.root.dataset.state).toBe("loading");
    expect(() => loader.advance("parser")).toThrow(/不可倒退/u);
  });

  it("completes at 100 then hides after the visual transition", () => {
    vi.useFakeTimers();
    const elements = createElements();
    const loader = createStartupLoader(elements as unknown as StartupLoaderElements);

    loader.advance("parser");
    loader.complete();
    expect(loader.stage).toBe("ready");
    expect(elements.progress.value).toBe(100);
    expect(elements.root.dataset.state).toBe("ready");
    expect(elements.root.hidden).toBe(false);

    elements.root.emit("transitionend");
    expect(elements.root.hidden).toBe(true);
  });

  it("keeps initialization failures visible and tears down idempotently", () => {
    vi.useFakeTimers();
    const elements = createElements();
    const loader = createStartupLoader(elements as unknown as StartupLoaderElements);

    loader.advance("parser");
    loader.fail("解析器资源损坏");
    vi.runAllTimers();
    expect(loader.stage).toBe("error");
    expect(elements.root.hidden).toBe(false);
    expect(elements.root.dataset.state).toBe("error");
    expect(elements.status.textContent).toBe("解析器资源损坏");
    expect(() => loader.advance("source")).toThrow(/终态/u);

    loader.destroy();
    loader.destroy();
    expect(elements.root.listenerCount("transitionend")).toBe(0);
    expect(() => loader.complete()).toThrow(/已销毁/u);
  });
});

class FakeElement {
  readonly dataset: Record<string, string | undefined> = {};
  hidden = false;
  textContent = "";
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    const event = { target: this } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeProgress extends FakeElement {
  value = 0;
}

function createElements() {
  return {
    root: new FakeElement(),
    progress: new FakeProgress(),
    status: new FakeElement(),
  };
}
