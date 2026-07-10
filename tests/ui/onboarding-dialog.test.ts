import { describe, expect, it } from "vitest";
import { ONBOARDING_STORAGE_KEY, type OnboardingStorage } from "../../src/onboarding/flow.js";
import { createOnboardingDialog } from "../../src/ui/onboarding-dialog.js";

describe("onboarding dialog", () => {
  it("opens on first launch with accessible dialogue and two native-button choices", () => {
    const fixture = fakeHost();
    fixture.trigger.focus();
    const onboarding = createOnboardingDialog(fixture.host as unknown as HTMLElement, {
      storage: new MemoryStorage(),
    });
    const dialog = onboarding.element as unknown as FakeElement;
    const choiceButtons = fixture.root.findAllByClass("onboarding-dialog__choice");

    expect(dialog.open).toBe(true);
    expect(dialog.showModalCount).toBe(1);
    expect(dialog.getAttribute("aria-labelledby")).toBe("onboarding-title");
    expect(dialog.getAttribute("aria-describedby")).toBe("onboarding-dialogue");
    expect(fixture.root.findByClass("onboarding-dialog__speaker")?.textContent).toBe("工作台导师");
    expect(fixture.root.findByClass("onboarding-dialog__dialogue")?.textContent).toMatch(/经验/u);
    expect(fixture.root.findByClass("onboarding-dialog__choices")?.getAttribute("role")).toBe(
      "group",
    );
    expect(choiceButtons).toHaveLength(2);
    expect(
      choiceButtons.every((button) => button.tagName === "button" && button.type === "button"),
    ).toBe(true);
    expect(fixture.document.activeElement).toBe(choiceButtons[0]);
    expect(fixture.root.findByTag("img")).toBeUndefined();
    expect(fixture.root.findByTag("audio")).toBeUndefined();
    expect(fixture.root.findByTag("video")).toBeUndefined();
  });

  it("renders experience and entry branches, then restores the previous scene", () => {
    const fixture = fakeHost();
    createOnboardingDialog(fixture.host as unknown as HTMLElement, {
      storage: new MemoryStorage(),
    });

    fixture.root.findByChoice("learner-new")?.click();
    expect(fixture.root.findByChoice("entry-presets")).toBeDefined();
    expect(fixture.root.findByClass("onboarding-dialog__dialogue")?.textContent).toMatch(
      /先选起点/u,
    );
    fixture.root.findByChoice("entry-presets")?.click();
    expect(fixture.root.findByClass("onboarding-dialog__dialogue")?.textContent).toMatch(
      /拖到高亮插槽/u,
    );

    fixture.root.findByClass("onboarding-dialog__back")?.click();
    expect(fixture.root.findByChoice("entry-import")).toBeDefined();
    fixture.root.findByChoice("entry-import")?.click();
    expect(fixture.root.findByClass("onboarding-dialog__dialogue")?.textContent).toMatch(
      /打开、拖入或粘贴 C/u,
    );
  });

  it("supports arrow-key choice navigation, Escape skip and Dock reopen", () => {
    const storage = new MemoryStorage();
    const fixture = fakeHost();
    fixture.trigger.focus();
    const onboarding = createOnboardingDialog(fixture.host as unknown as HTMLElement, { storage });
    const choices = fixture.root.findByClass("onboarding-dialog__choices");
    const first = fixture.root.findByChoice("learner-new");
    const second = fixture.root.findByChoice("learner-experienced");
    if (choices === undefined || first === undefined || second === undefined) {
      throw new Error("缺少新手引导选择控件");
    }

    const down = choices.emit("keydown", { key: "ArrowDown", target: first });
    expect(down.defaultPrevented).toBe(true);
    expect(fixture.document.activeElement).toBe(second);
    choices.emit("keydown", { key: "Home", target: second });
    expect(fixture.document.activeElement).toBe(first);

    const cancel = (onboarding.element as unknown as FakeElement).emit("cancel");
    expect(cancel.defaultPrevented).toBe(true);
    expect((onboarding.element as unknown as FakeElement).returnValue).toBe("skipped");
    expect(onboarding.getState()).toMatchObject({ status: "closed", completion: "skipped" });
    expect(fixture.document.activeElement).toBe(fixture.trigger);

    const laterFixture = fakeHost();
    const later = createOnboardingDialog(laterFixture.host as unknown as HTMLElement, { storage });
    expect((later.element as unknown as FakeElement).open).toBe(false);
    later.openFromDock();
    expect((later.element as unknown as FakeElement).open).toBe(true);
    expect(later.getState()).toMatchObject({ status: "open", stepId: "welcome" });
  });

  it("completes through choices, persists the result and tears down idempotently", () => {
    const storage = new MemoryStorage();
    const fixture = fakeHost();
    const onboarding = createOnboardingDialog(fixture.host as unknown as HTMLElement, { storage });
    for (const choiceId of [
      "learner-experienced",
      "entry-import",
      "import-sync",
      "sync-lifecycle",
      "lifecycle-safety",
      "finish",
    ]) {
      const choice = fixture.root.findByChoice(choiceId);
      if (choice === undefined) throw new Error(`缺少选择 ${choiceId}`);
      choice.click();
    }

    const dialog = onboarding.element as unknown as FakeElement;
    expect(dialog.open).toBe(false);
    expect(dialog.returnValue).toBe("completed");
    expect(onboarding.getState()).toMatchObject({ status: "closed", completion: "completed" });
    expect(storage.getItem(ONBOARDING_STORAGE_KEY)).toContain('"completion":"completed"');

    onboarding.destroy();
    onboarding.destroy();
    expect(dialog.removeCount).toBe(1);
    expect(() => onboarding.openFromDock()).toThrow(/已销毁/u);
  });
});

interface FakeEventInit {
  readonly key?: string;
  readonly target?: FakeElement;
}

class FakeEvent {
  defaultPrevented = false;
  readonly key: string;
  readonly target: FakeElement;

  constructor(target: FakeElement, init: FakeEventInit = {}) {
    this.target = init.target ?? target;
    this.key = init.key ?? "";
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string | undefined> = {};
  className = "";
  textContent = "";
  type = "";
  id = "";
  disabled = false;
  open = false;
  returnValue = "";
  showModalCount = 0;
  focusCount = 0;
  removeCount = 0;
  private parent: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  remove(): void {
    if (this.removeCount > 0) return;
    this.removeCount += 1;
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  showModal(): void {
    this.open = true;
    this.showModalCount += 1;
  }

  close(returnValue = ""): void {
    this.open = false;
    this.returnValue = returnValue;
    this.emit("close");
  }

  focus(): void {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  click(): void {
    if (!this.disabled) this.emit("click");
  }

  emit(type: string, init: FakeEventInit = {}): FakeEvent {
    const event = new FakeEvent(this, init);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
    }
    return event;
  }

  findByClass(className: string): FakeElement | undefined {
    return this.find((element) => element.className.split(/\s+/u).includes(className));
  }

  findAllByClass(className: string): readonly FakeElement[] {
    return this.findAll((element) => element.className.split(/\s+/u).includes(className));
  }

  findByChoice(choiceId: string): FakeElement | undefined {
    return this.find((element) => element.dataset.onboardingChoice === choiceId);
  }

  findByTag(tagName: string): FakeElement | undefined {
    return this.find((element) => element.tagName === tagName);
  }

  private find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match !== undefined) return match;
    }
    return undefined;
  }

  private findAll(predicate: (element: FakeElement) => boolean): readonly FakeElement[] {
    return [
      ...(predicate(this) ? [this] : []),
      ...this.children.flatMap((child) => child.findAll(predicate)),
    ];
  }
}

function fakeHost(): {
  readonly document: FakeDocument;
  readonly root: FakeElement;
  readonly host: FakeElement;
  readonly trigger: FakeElement;
} {
  const document = new FakeDocument();
  const root = document.createElement("main");
  const trigger = document.createElement("button");
  const host = document.createElement("div");
  root.append(trigger, host);
  return { document, root, host, trigger };
}

class MemoryStorage implements OnboardingStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
