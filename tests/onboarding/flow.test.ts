import { describe, expect, it } from "vitest";
import {
  createOnboardingFlow,
  getOnboardingScene,
  ONBOARDING_FLOW_VERSION,
  ONBOARDING_STORAGE_KEY,
  transitionOnboarding,
  type OnboardingState,
  type OnboardingStorage,
} from "../../src/onboarding/flow.js";

describe("deterministic onboarding flow", () => {
  it("opens the welcome scene on first launch with two experience choices", () => {
    const flow = createOnboardingFlow({ storage: new MemoryStorage() });
    const state = flow.getState();
    const scene = getOnboardingScene(state);

    expect(state).toMatchObject({ status: "open", completion: null, stepId: "welcome" });
    expect(scene.speaker).toBe("工作台导师");
    expect(scene.dialogue.length).toBeGreaterThan(0);
    expect(scene.choices).toHaveLength(2);
    expect(scene.choices.map(({ id }) => id)).toEqual(["learner-new", "learner-experienced"]);
  });

  it("returns the same deeply frozen result for the same state and choice", () => {
    const state = createOnboardingFlow({ storage: new MemoryStorage() }).getState();
    const first = transitionOnboarding(state, { type: "choose", choiceId: "learner-new" });
    const second = transitionOnboarding(state, { type: "choose", choiceId: "learner-new" });

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.history)).toBe(true);
    expect(Object.isFrozen(first.history[0])).toBe(true);
  });

  it("keeps beginner and experienced dialogue branches distinct", () => {
    const initial = createOnboardingFlow({ storage: new MemoryStorage() }).getState();
    const beginner = transitionOnboarding(initial, { type: "choose", choiceId: "learner-new" });
    const experienced = transitionOnboarding(initial, {
      type: "choose",
      choiceId: "learner-experienced",
    });

    expect(beginner.learner).toBe("new");
    expect(experienced.learner).toBe("experienced");
    expect(getOnboardingScene(beginner).dialogue).not.toBe(
      getOnboardingScene(experienced).dialogue,
    );
  });

  it("routes preset assembly and source import through different scenes", () => {
    const entry = transitionOnboarding(
      createOnboardingFlow({ storage: new MemoryStorage() }).getState(),
      { type: "choose", choiceId: "learner-new" },
    );
    const presets = transitionOnboarding(entry, { type: "choose", choiceId: "entry-presets" });
    const sourceImport = transitionOnboarding(entry, { type: "choose", choiceId: "entry-import" });

    expect(presets).toMatchObject({ stepId: "blocks", entryMode: "presets" });
    expect(sourceImport).toMatchObject({ stepId: "import", entryMode: "import" });
    expect(getOnboardingScene(presets).dialogue).toMatch(/拖到高亮插槽/u);
    expect(getOnboardingScene(sourceImport).dialogue).toMatch(/打开、拖入或粘贴 C/u);
  });

  it("covers sync, custom blocks, lifecycle isolation, diff and undo", () => {
    const states = walkthrough();
    const dialogue = states.map((state) => getOnboardingScene(state).dialogue).join("\n");

    expect(dialogue).toMatch(/实时同步/u);
    expect(dialogue).toMatch(/自定义积木/u);
    expect(dialogue).toMatch(/不会改动已生成源码/u);
    expect(dialogue).toMatch(/diff/u);
    expect(dialogue).toMatch(/撤销/u);
  });

  it("restores branch facts on back and rejects choices outside the current scene", () => {
    const flow = createOnboardingFlow({ storage: new MemoryStorage() });
    flow.choose("learner-new");
    const entry = flow.getState();
    flow.choose("entry-presets");
    expect(flow.getState().entryMode).toBe("presets");

    expect(flow.back()).toEqual(entry);
    expect(() => flow.choose("finish")).toThrow(/不支持选择/u);
  });

  it("persists skip and completion, while Dock reopen starts a fresh in-session tour", () => {
    const skippedStorage = new MemoryStorage();
    const skipped = createOnboardingFlow({ storage: skippedStorage });
    expect(skipped.skip()).toMatchObject({ status: "closed", completion: "skipped" });
    expect(createOnboardingFlow({ storage: skippedStorage }).getState()).toMatchObject({
      status: "closed",
      completion: "skipped",
    });
    expect(skipped.reopen()).toMatchObject({ status: "open", stepId: "welcome", history: [] });

    const completedStorage = new MemoryStorage();
    const completed = createOnboardingFlow({ storage: completedStorage });
    for (const choiceId of [
      "learner-experienced",
      "entry-import",
      "import-sync",
      "sync-lifecycle",
      "lifecycle-safety",
      "finish",
    ]) {
      completed.choose(choiceId);
    }
    expect(completed.getState()).toMatchObject({ status: "closed", completion: "completed" });
    expect(createOnboardingFlow({ storage: completedStorage }).getState().status).toBe("closed");
  });

  it("safely resets corrupt, stale and unavailable storage", () => {
    const corrupt = new MemoryStorage("{not-json");
    expect(createOnboardingFlow({ storage: corrupt }).getState().status).toBe("open");
    expect(corrupt.removed).toBe(1);

    const stale = new MemoryStorage(
      JSON.stringify({ version: ONBOARDING_FLOW_VERSION + 1, completion: "completed" }),
    );
    expect(createOnboardingFlow({ storage: stale }).getState().status).toBe("open");
    expect(stale.removed).toBe(1);

    const unavailable: OnboardingStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const flow = createOnboardingFlow({ storage: unavailable });
    expect(flow.getState().status).toBe("open");
    expect(() => flow.skip()).not.toThrow();
  });
});

function walkthrough(): readonly OnboardingState[] {
  const flow = createOnboardingFlow({ storage: new MemoryStorage() });
  flow.choose("learner-new");
  flow.choose("entry-presets");
  const blocks = flow.getState();
  flow.choose("blocks-sync");
  const sync = flow.getState();
  flow.choose("sync-custom");
  const custom = flow.getState();
  flow.choose("custom-lifecycle");
  const lifecycle = flow.getState();
  flow.choose("lifecycle-safety");
  const safety = flow.getState();
  return [blocks, sync, custom, lifecycle, safety];
}

class MemoryStorage implements OnboardingStorage {
  readonly values = new Map<string, string>();
  removed = 0;

  constructor(initial?: string) {
    if (initial !== undefined) this.values.set(ONBOARDING_STORAGE_KEY, initial);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removed += 1;
    this.values.delete(key);
  }
}
