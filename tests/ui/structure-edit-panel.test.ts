import { describe, expect, it, vi } from "vitest";
import {
  buildStructureEditRequest,
  createStructureEditPanel,
  getStructureEditAvailability,
  runStructureEditWorkflow,
  type StructureEditConfirmationPlan,
  type StructureEditSelection,
} from "../../src/ui/structure-edit-panel.js";

describe("structure edit request contract", () => {
  it("builds exact engine-shaped requests from one immutable selection", () => {
    const selection = completeSelection();

    expect(
      buildStructureEditRequest(selection, {
        kind: "insert-before",
        statementText: "prepare();",
      }),
    ).toEqual({
      kind: "insert-statement",
      baseRevision: 12,
      targetId: "statement:current",
      expectedTargetText: "work();",
      position: "before",
      statementText: "prepare();",
    });
    expect(
      buildStructureEditRequest(selection, {
        kind: "insert-after",
        statementText: "finish();",
      }),
    ).toMatchObject({ kind: "insert-statement", position: "after", statementText: "finish();" });
    expect(buildStructureEditRequest(selection, { kind: "delete" })).toEqual({
      kind: "delete-statement",
      baseRevision: 12,
      targetId: "statement:current",
      expectedTargetText: "work();",
    });
    expect(buildStructureEditRequest(selection, { kind: "move-previous" })).toEqual({
      kind: "swap-adjacent-statements",
      baseRevision: 12,
      targetId: "statement:current",
      expectedTargetText: "work();",
      adjacentTargetId: "statement:previous",
      expectedAdjacentTargetText: "prepare();",
    });
    expect(buildStructureEditRequest(selection, { kind: "move-next" })).toMatchObject({
      kind: "swap-adjacent-statements",
      adjacentTargetId: "statement:next",
      expectedAdjacentTargetText: "finish();",
    });
    const rename = buildStructureEditRequest(selection, { kind: "rename", newName: "result" });
    expect(rename).toEqual({
      kind: "local-variable-rename",
      baseRevision: 12,
      symbolId: "local:total",
      expectedOldName: "total",
      newName: "result",
    });
    expect(Object.isFrozen(rename)).toBe(true);
  });

  it("enforces one physical insertion line and conservative C identifiers", () => {
    const selection = completeSelection();
    expect(() =>
      buildStructureEditRequest(selection, {
        kind: "insert-before",
        statementText: "first();\nsecond();",
      }),
    ).toThrow(/不允许/u);
    expect(() =>
      buildStructureEditRequest(selection, { kind: "insert-before", statementText: " work();" }),
    ).toThrow(/不允许/u);
    expect(() =>
      buildStructureEditRequest(selection, { kind: "insert-before", statementText: "#define X 1" }),
    ).toThrow(/不允许/u);
    expect(() =>
      buildStructureEditRequest(selection, { kind: "rename", newName: "while" }),
    ).toThrow(/ASCII C/u);
    expect(() =>
      buildStructureEditRequest(selection, { kind: "rename", newName: "__private" }),
    ).toThrow(/ASCII C/u);
    expect(() =>
      buildStructureEditRequest(selection, { kind: "rename", newName: "total" }),
    ).toThrow(/相同/u);
  });

  it("keeps the inline required-body delete exception and blocks all other structure actions", () => {
    const inlineBody = selectionWithStatement({
      parentMode: "required-body",
      blocker: "not-line-exclusive",
      previous: { id: "statement:previous", text: "prepare();" },
      next: { id: "statement:next", text: "finish();" },
    });
    expect(getStructureEditAvailability(inlineBody, "next();")).toMatchObject({
      insert: false,
      delete: true,
      movePrevious: false,
      moveNext: false,
    });
    expect(buildStructureEditRequest(inlineBody, { kind: "delete" })).toMatchObject({
      kind: "delete-statement",
    });
    expect(() => buildStructureEditRequest(inlineBody, { kind: "move-previous" })).toThrow(
      /没有可交换/u,
    );

    const blockedList = selectionWithStatement({
      parentMode: "statement-list",
      blocker: "not-line-exclusive",
    });
    expect(getStructureEditAvailability(blockedList, "next();").delete).toBe(false);
    expect(() => buildStructureEditRequest(blockedList, { kind: "delete" })).toThrow(/不允许/u);
  });
});

describe("structure edit workflow", () => {
  it("always orders plan, external confirm and commit", async () => {
    const events: string[] = [];
    const request = buildStructureEditRequest(completeSelection(), { kind: "delete" });
    const plan = confirmationPlan();

    await expect(
      runStructureEditWorkflow(request, {
        async plan(received) {
          events.push("plan");
          expect(received).toBe(request);
          return plan;
        },
        async confirm(received) {
          events.push("confirm");
          expect(received).toBe(plan);
          return true;
        },
        async commit(received) {
          events.push("commit");
          expect(received).toBe(plan);
        },
      }),
    ).resolves.toBe("committed");
    expect(events).toEqual(["plan", "confirm", "commit"]);
  });

  it("never commits a cancelled or stale preview", async () => {
    const request = buildStructureEditRequest(completeSelection(), { kind: "delete" });
    const commit = vi.fn();
    const confirm = vi.fn(() => false);
    await expect(
      runStructureEditWorkflow(request, {
        plan: confirmationPlan,
        confirm,
        commit,
      }),
    ).resolves.toBe("cancelled");
    expect(commit).not.toHaveBeenCalled();

    let current = true;
    confirm.mockImplementation(() => {
      current = false;
      return true;
    });
    await expect(
      runStructureEditWorkflow(request, { plan: confirmationPlan, confirm, commit }, () => current),
    ).resolves.toBe("stale");
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a plan without diffs before confirmation", async () => {
    const request = buildStructureEditRequest(completeSelection(), { kind: "delete" });
    const confirm = vi.fn();
    await expect(
      runStructureEditWorkflow(request, {
        plan: () => ({ candidate: "x" }) as never,
        confirm,
        commit: vi.fn(),
      }),
    ).rejects.toThrow(/diffs/u);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("structure edit panel DOM behavior", () => {
  it("renders a compact accessible empty state and actionable controls", async () => {
    const fixture = fakeHost();
    const events: string[] = [];
    const requests: unknown[] = [];
    const panel = createStructureEditPanel(fixture.host as unknown as HTMLElement, {
      plan(request) {
        events.push("plan");
        requests.push(request);
        return confirmationPlan();
      },
      confirm() {
        events.push("confirm");
        return true;
      },
      commit() {
        events.push("commit");
      },
    });

    expect(fixture.root.children).toHaveLength(1);
    expect(fixture.root.findByClass("structure-edit-panel__unavailable")?.textContent).toMatch(
      /选择/u,
    );
    expect(panel.element.getAttribute("aria-label")).toBe("结构编辑");

    panel.setSelection(completeSelection());
    const insertInput = fixture.root.findInputByLabel("要插入的单行 C 语句");
    const insertBefore = fixture.root.findByOperation("insert-before");
    const deleteButton = fixture.root.findByOperation("delete");
    const movePrevious = fixture.root.findByOperation("move-previous");
    const renameInput = fixture.root.findInputByLabel("局部变量 total 的新名称");
    const renameButton = fixture.root.findByOperation("rename");

    expect(insertInput).toBeDefined();
    expect(insertBefore?.disabled).toBe(true);
    expect(deleteButton?.disabled).toBe(false);
    expect(movePrevious?.disabled).toBe(false);
    expect(deleteButton?.getAttribute("aria-label")).toBe("删除当前语句");
    expect(renameButton?.disabled).toBe(true);

    insertInput?.input("prepare_more();");
    expect(insertBefore?.disabled).toBe(false);
    insertBefore?.click();
    await settleAsyncHandlers();
    expect(events).toEqual(["plan", "confirm", "commit"]);
    expect(requests[0]).toMatchObject({
      kind: "insert-statement",
      position: "before",
      statementText: "prepare_more();",
    });
    expect(fixture.root.findByClass("structure-edit-panel__status")?.textContent).toBe(
      "修改已提交。",
    );

    renameInput?.input("result");
    expect(renameButton?.disabled).toBe(false);
    renameButton?.click();
    await settleAsyncHandlers();
    expect(requests[1]).toMatchObject({
      kind: "local-variable-rename",
      expectedOldName: "total",
      newName: "result",
    });
  });

  it("exposes only delete for an inline required body", () => {
    const fixture = fakeHost();
    const panel = createStructureEditPanel(
      fixture.host as unknown as HTMLElement,
      inertCallbacks(),
    );
    panel.setSelection(
      selectionWithStatement({
        parentMode: "required-body",
        blocker: "not-line-exclusive",
        previous: { id: "statement:previous", text: "prepare();" },
        next: { id: "statement:next", text: "finish();" },
      }),
    );
    const insertInput = fixture.root.findInputByLabel("要插入的单行 C 语句");
    expect(insertInput?.disabled).toBe(true);
    insertInput?.input("next();");

    expect(fixture.root.findByOperation("insert-before")?.disabled).toBe(true);
    expect(fixture.root.findByOperation("insert-after")?.disabled).toBe(true);
    expect(fixture.root.findByOperation("move-previous")?.disabled).toBe(true);
    expect(fixture.root.findByOperation("move-next")?.disabled).toBe(true);
    expect(fixture.root.findByOperation("delete")?.disabled).toBe(false);
    expect(fixture.root.findByClass("structure-edit-panel__hint")?.textContent).toMatch(
      /只允许安全删除/u,
    );
  });

  it("invalidates an asynchronous preview when selection changes", async () => {
    const fixture = fakeHost();
    const pending = deferred<StructureEditConfirmationPlan>();
    const confirm = vi.fn(() => true);
    const commit = vi.fn();
    const panel = createStructureEditPanel(fixture.host as unknown as HTMLElement, {
      plan: () => pending.promise,
      confirm,
      commit,
    });
    panel.setSelection(completeSelection());
    fixture.root.findByOperation("delete")?.click();
    expect(fixture.root.findByOperation("delete")?.disabled).toBe(true);

    panel.setSelection(selectionWithStatement({ id: "statement:new", text: "new_work();" }));
    pending.resolve(confirmationPlan());
    await settleAsyncHandlers();

    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(fixture.root.findByClass("structure-edit-panel__target")?.textContent).toBe(
      "new_work();",
    );
  });

  it("tears down idempotently and rejects later selections", () => {
    const fixture = fakeHost();
    const panel = createStructureEditPanel(
      fixture.host as unknown as HTMLElement,
      inertCallbacks(),
    );
    panel.destroy();
    panel.destroy();
    expect((panel.element as unknown as FakeElement).removeCount).toBe(1);
    expect(() => panel.setSelection(completeSelection())).toThrow(/已销毁/u);
  });
});

function completeSelection(): StructureEditSelection {
  return selectionWithStatement({
    previous: { id: "statement:previous", text: "prepare();" },
    next: { id: "statement:next", text: "finish();" },
    localVariable: { symbolId: "local:total", name: "total" },
  });
}

function selectionWithStatement(
  overrides: Partial<NonNullable<StructureEditSelection["statement"]>> & {
    readonly localVariable?: NonNullable<StructureEditSelection["localVariable"]>;
  } = {},
): StructureEditSelection {
  const { localVariable, ...statementOverrides } = overrides;
  return {
    revision: 12,
    statement: {
      id: "statement:current",
      text: "work();",
      parentMode: "statement-list",
      blocker: null,
      previous: null,
      next: null,
      ...statementOverrides,
    },
    ...(localVariable === undefined ? {} : { localVariable }),
  };
}

function confirmationPlan(): StructureEditConfirmationPlan {
  return Object.freeze({
    diffs: Object.freeze([
      Object.freeze({
        beforeRange: Object.freeze({ from: 0, to: 7 }),
        afterRange: Object.freeze({ from: 0, to: 0 }),
        beforeText: "work();",
        afterText: "",
      }),
    ]),
  });
}

function inertCallbacks() {
  return {
    plan: confirmationPlan,
    confirm: () => false,
    commit: vi.fn(),
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("deferred 未初始化");
  return { promise, resolve: resolvePromise };
}

async function settleAsyncHandlers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string | undefined> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  value = "";
  placeholder = "";
  autocomplete = "";
  spellcheck = true;
  disabled = false;
  removeCount = 0;
  private parent: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    for (const child of children) child.parent = this;
    this.children.splice(0, this.children.length, ...children);
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

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const invoke =
      typeof listener === "function"
        ? (event: FakeEvent) => listener(event as unknown as Event)
        : (event: FakeEvent) => listener.handleEvent(event as unknown as Event);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(invoke);
    this.listeners.set(type, listeners);
  }

  click(): void {
    if (!this.disabled) this.dispatch("click");
  }

  input(value: string): void {
    this.value = value;
    this.dispatch("input");
  }

  findByClass(className: string): FakeElement | undefined {
    return this.find((element) => element.className.split(/\s+/u).includes(className));
  }

  findByOperation(operation: string): FakeElement | undefined {
    return this.find((element) => element.dataset.operation === operation);
  }

  findInputByLabel(label: string): FakeElement | undefined {
    return this.find(
      (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
    );
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
  defaultPrevented = false;

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

function fakeHost(): { readonly root: FakeElement; readonly host: FakeElement } {
  const document = new FakeDocument();
  const root = document.createElement("main");
  const host = document.createElement("div");
  root.append(host);
  return { root, host };
}
