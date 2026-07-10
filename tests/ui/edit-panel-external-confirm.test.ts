import { describe, expect, it, vi } from "vitest";
import { createEditPanel, type EditConfirmationPlan } from "../../src/ui/edit-panel.js";

describe("edit panel external diff confirmation", () => {
  it("opens the shared diff dialog without an M3a target", async () => {
    const fixture = fakeHost();
    const panel = createEditPanel(fixture.host as unknown as HTMLElement, inertCallbacks());

    const decision = panel.confirmExternal(confirmationPlan());
    const dialog = fixture.root.findByClass("edit-panel__confirmation");
    expect(dialog?.open).toBe(true);
    expect(dialog?.showModalCount).toBe(1);
    expect(fixture.root.textValues()).toContain("return 0;");
    expect(fixture.root.textValues()).toContain("");

    dialog?.close("cancel");
    await expect(decision).resolves.toBe(false);
  });

  it("still refuses external confirmation while parse recovery blocks edits", async () => {
    const fixture = fakeHost();
    const panel = createEditPanel(fixture.host as unknown as HTMLElement, inertCallbacks());
    panel.setStatus({ kind: "parse-error", message: "源码含解析恢复节点" });

    await expect(panel.confirmExternal(confirmationPlan())).resolves.toBe(false);
    expect(fixture.root.findByClass("edit-panel__confirmation")?.showModalCount).toBe(0);
    expect(fixture.root.findByClass("edit-panel__status")?.textContent).toMatch(/已取消/u);
  });
});

function confirmationPlan(): EditConfirmationPlan {
  return {
    diffs: [
      {
        beforeRange: { from: 10, to: 19 },
        afterRange: { from: 10, to: 10 },
        beforeText: "return 0;",
        afterText: "",
      },
    ],
  };
}

function inertCallbacks() {
  return {
    plan: vi.fn(() => confirmationPlan()),
    commit: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
}

class FakeDocument {
  readonly activeElement = null;
  readonly defaultView = undefined;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string | undefined> = {};
  className = "";
  textContent = "";
  type = "";
  value = "";
  id = "";
  title = "";
  disabled = false;
  open = false;
  returnValue = "";
  showModalCount = 0;
  private parent: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>();

  constructor(
    readonly tagName: string,
    ownerDocument: FakeDocument,
  ) {
    this.ownerDocument = ownerDocument;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.splice(0, this.children.length, ...children);
    for (const child of children) child.parent = this;
  }

  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const invoke =
      typeof listener === "function"
        ? (event: FakeEvent) => listener(event as unknown as Event)
        : (event: FakeEvent) => listener.handleEvent(event as unknown as Event);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(invoke);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    for (const registered of listeners) {
      if (registered === listener) listeners.delete(registered);
    }
  }

  showModal(): void {
    this.open = true;
    this.showModalCount += 1;
  }

  close(returnValue = ""): void {
    this.open = false;
    this.returnValue = returnValue;
    this.dispatch("close");
  }

  focus(): void {}

  findByClass(className: string): FakeElement | undefined {
    return this.find((element) => element.className.split(/\s+/u).includes(className));
  }

  textValues(): readonly string[] {
    return [this.textContent, ...this.children.flatMap((child) => child.textValues())];
  }

  private dispatch(type: string): void {
    const event = new FakeEvent();
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match !== undefined) return match;
    }
    return undefined;
  }
}

class FakeEvent {
  preventDefault(): void {}
}

function fakeHost(): { readonly root: FakeElement; readonly host: FakeElement } {
  const document = new FakeDocument();
  const root = document.createElement("main");
  const host = document.createElement("div");
  root.append(host);
  return { root, host };
}
