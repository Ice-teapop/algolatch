import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const RUNTIME_MATRIX = [1, 3, 4, 6, 8, 9, 12, 17, 23, 28, 32, 37, 38, 44, 50, 52, 57, 59] as const;

const INPUT_CASES = [
  {
    order: 9,
    fields: { value: "7" },
    input: "7",
    output: "8",
    alternateFields: { value: "11" },
    alternateInput: "11",
    alternateOutput: "12",
  },
  {
    order: 17,
    fields: { left: "9", right: "2" },
    input: "9 2",
    output: "9",
    alternateFields: { left: "1", right: "8" },
    alternateInput: "1 8",
    alternateOutput: "8",
  },
  {
    order: 28,
    fields: { count: "5", values: "-8 -3 -11 -2 -7" },
    input: "5 -8 -3 -11 -2 -7",
    output: "-2",
    alternateFields: { count: "4", values: "1 2 3 4" },
    alternateInput: "4 1 2 3 4",
    alternateOutput: "4",
  },
  {
    order: 52,
    fields: { count: "4", values: "4 6 8 10" },
    input: "4 4 6 8 10",
    output: "10",
    alternateFields: { count: "3", values: "7 8 9" },
    alternateInput: "3 7 8 9",
    alternateOutput: "9",
  },
] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-runtime-matrix-e2e-"));
  const developmentServerPort = process.env.PANEL_E2E_PORT ?? "5173";
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  application = await electron.launch({
    args: [".", `--user-data-dir=${e2eProfileRoot}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${developmentServerPort}/`,
    },
  });
  page = await application.firstWindow();
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("representative generic runtime matrix changes mechanism state during preview and learner actions", async () => {
  test.setTimeout(180_000);

  for (const order of RUNTIME_MATRIX) {
    await test.step(`lesson ${String(order)} renders and changes runtime evidence`, async () => {
      const stage = await openRuntimeLesson(order);
      const scene = stage.locator(".foa-runtime-scene");
      const mechanism = scene.locator(".foa-runtime-scene__mechanism");

      await expect(scene).toBeVisible();
      await expect(mechanism).toBeVisible();
      await expect(scene.locator(".foa-runtime-scene__value:visible")).not.toHaveCount(0);
      await expect(scene.locator(".foa-runtime-scene__history-item:visible")).not.toHaveCount(0);
      await expect(stage).toHaveAttribute("data-confirmed-events", "0");
      await expect(scene).toHaveAttribute("data-confirmed-count", "0");
      await verifyFamilyMechanism(mechanism);

      const initial = await runtimeSnapshot(scene);
      const speed = stage.locator("[data-task-lesson-action='rate-1-5']");
      await speed.click();
      const playPause = stage.locator("[data-task-lesson-action='play-pause']");
      await installTransitionProbe(scene);
      await playPause.click();
      await expect
        .poll(() => readTransitionProbe(scene), { timeout: 6_000 })
        .toContainEqual({ mode: "preview", from: "0", to: "1" });
      await expect(stage).toHaveAttribute("data-confirmed-events", "0");
      await expect(scene).toHaveAttribute("data-confirmed-count", "0");
      await expect(stage).toHaveAttribute("data-timeline-position", "1", { timeout: 6_000 });
      await expect(stage).toHaveAttribute("data-previewing", "true");
      const preview = await runtimeSnapshot(scene);
      expect(
        preview.mechanismState,
        `lesson ${String(order)} preview changed only the code cursor`,
      ).not.toEqual(initial.mechanismState);

      if ((await stage.getAttribute("data-playback-state")) === "playing") {
        await playPause.click();
      }
      await stage.locator("[data-task-lesson-action='return-to-current']").click();
      await expect(stage).toHaveAttribute("data-previewing", "false");
      await expect(stage).toHaveAttribute("data-timeline-position", "0");

      await advanceOneStep(stage, scene, 1);
      await expect(scene).toHaveAttribute("data-confirmed-count", "1");
      const committed = await runtimeSnapshot(scene);
      expect(
        committed.mechanismState,
        `lesson ${String(order)} learner action did not update runtime evidence`,
      ).not.toEqual(initial.mechanismState);
    });
  }
});

test("lesson 33 wires stable prototype, call, and definition stations directly", async () => {
  const stage = await openRuntimeLesson(33);
  const scene = stage.locator(".foa-runtime-scene");
  const contract = scene.locator(".foa-signature-contract");
  const stations = contract.locator(".foa-signature-contract__station");
  const prototype = contract.locator(
    ".foa-signature-contract__station[data-station-id='prototype']",
  );
  const initialStationBoxes = await stations.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );

  await expect(contract).toBeVisible();
  await expect(contract).toHaveAttribute("data-motion-blueprint", "signature-contract-v1");
  await expect(stations).toHaveCount(3);
  await expect(prototype).toHaveCount(1);
  await expect(contract.locator(".foa-signature-contract__route")).toHaveCount(4);

  const source = contract.locator(
    ".foa-signature-contract__port[data-endpoint-id='prototype-return']",
  );
  const target = contract.locator(".foa-signature-contract__port[data-endpoint-id='call-return']");
  await expect(source).toHaveAttribute("data-compatible", "true");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (sourceBox === null || targetBox === null) throw new Error("Lesson 33 ports lack geometry");

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 12,
    sourceBox.y + sourceBox.height / 2,
    {
      steps: 2,
    },
  );
  await expect(contract).toHaveAttribute("data-dragging", "true");
  await expect(contract.locator(".foa-signature-contract__drag-route")).toHaveAttribute(
    "data-active",
    "true",
  );
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 6,
  });
  await expect(target).toHaveAttribute("data-target-compatible", "true");
  await page.mouse.up();

  await expect(stage).toHaveAttribute("data-confirmed-events", "1");
  await expect(contract).not.toHaveAttribute("data-dragging", "true");
  await expect(contract.locator(".foa-signature-contract__route").nth(0)).toHaveAttribute(
    "data-state",
    "done",
  );
  const afterStationBoxes = await stations.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  expect(normalizeStationBoxes(afterStationBoxes)).toEqual(
    normalizeStationBoxes(initialStationBoxes),
  );

  for (let count = 2; count <= 4; count += 1) await advanceOneStep(stage, scene, count);
  await expect(contract.locator(".foa-signature-contract__route[data-state='done']")).toHaveCount(
    4,
  );
  await expect(
    contract.locator(".foa-signature-contract__field[data-endpoint-id='call-result']"),
  ).toContainText("12");
  await expect(stage).toHaveAttribute("data-phase", "completed");
});

test("lesson 33 keeps copy and contract geometry readable across locales and widths", async () => {
  test.setTimeout(180_000);

  const reports: SignatureContractAudit[] = [];
  await selectInterfaceLanguage("zh-CN");
  await page.setViewportSize({ width: 1440, height: 900 });
  const stage = await openRuntimeLesson(33);
  const scene = stage.locator(".foa-runtime-scene");
  const contract = scene.locator(".foa-signature-contract");
  for (const locale of ["zh-CN", "en"] as const) {
    await selectInterfaceLanguage(locale);
    for (const width of [1440, 1100, 960, 860] as const) {
      await page.setViewportSize({ width, height: 900 });
      await stage.locator("[data-task-lesson-action='reset']").click();
      await expect(stage).toHaveAttribute("data-confirmed-events", "0");

      for (let step = 0; step < 4; step += 1) {
        const report = await auditSignatureContract(contract, locale, width, step);
        reports.push(report);
        expect(report.stationOverlaps, report.label).toEqual([]);
        expect(report.textOverflows, report.label).toEqual([]);
        expect(report.textOverlaps, report.label).toEqual([]);
        expect(report.routesThroughText, report.label).toEqual([]);
        expect(report.routeIntersections, report.label).toEqual([]);
        expect(report.visiblePendingRoutes, report.label).toEqual([]);
        expect(report.controlsOverlaps, report.label).toEqual([]);
        expect(Math.max(...report.portVerticalOffsets), report.label).toBeLessThanOrEqual(1.5);
        expect(Math.max(...report.routeEndpointOffsets), report.label).toBeLessThanOrEqual(2.5);
        expect(report.horizontalOverflow, report.label).toBeLessThanOrEqual(1);
        expect(report.canvasBottomOverflow, report.label).toBeLessThanOrEqual(1);
        expect(report.viewportOverflow, report.label).toBeLessThanOrEqual(1);
        expect(report.activeFieldCount, report.label).toBe(2);
        expect(report.fontSizes.length, report.label).toBeLessThanOrEqual(3);

        if (step < 3) await advanceOneStep(stage, scene, step + 1);
      }
    }
  }

  const densest = reports.reduce((current, report) =>
    report.charactersPer10kPx > current.charactersPer10kPx ? report : current,
  );
  expect(densest.visibleTextCount, densest.label).toBeLessThanOrEqual(16);
  expect(densest.charactersPer10kPx, densest.label).toBeLessThanOrEqual(9);
});

test("lesson 33 animation frames never cover copy or shift station geometry", async () => {
  test.setTimeout(90_000);
  await selectInterfaceLanguage("en");
  await page.setViewportSize({ width: 1440, height: 900 });
  const stage = await openRuntimeLesson(33);
  const scene = stage.locator(".foa-runtime-scene");
  const contract = scene.locator(".foa-signature-contract");

  for (const width of [1440, 860] as const) {
    await page.setViewportSize({ width, height: 900 });
    await stage.locator("[data-task-lesson-action='reset']").click();
    await expect(stage).toHaveAttribute("data-confirmed-events", "0");
    await page.waitForTimeout(120);
    const initialStationBoxes = await stationBoxes(contract);

    for (let step = 0; step < 4; step += 1) {
      const source = contract.locator(
        ".foa-signature-contract__port[data-compatible='true']:visible",
      );
      await source.click();
      const travelTokens = contract.locator(".foa-signature-contract__travel-token:visible");
      if (step === 3) await expect(travelTokens).toHaveCount(2, { timeout: 1_500 });
      else await page.waitForTimeout(100);
      const report = await auditSignatureContract(contract, "en", width, step);
      expect(report.textOverlaps, `${report.label} animation`).toEqual([]);
      expect(report.textOverflows, `${report.label} animation`).toEqual([]);
      expect(report.routesThroughText, `${report.label} animation`).toEqual([]);
      expect(report.routeIntersections, `${report.label} animation`).toEqual([]);
      expect(report.visiblePendingRoutes, `${report.label} animation`).toEqual([]);
      expect(report.controlsOverlaps, `${report.label} animation`).toEqual([]);
      expect(
        maxStationBoxDelta(await stationBoxes(contract), initialStationBoxes),
        `${report.label} animation`,
      ).toBeLessThanOrEqual(0.75);
      if (step === 3) {
        await expect(travelTokens).toHaveCount(1, { timeout: 1_500 });
        const returnReport = await auditSignatureContract(contract, "en", width, step);
        expect(returnReport.textOverlaps, `${report.label} return animation`).toEqual([]);
        expect(returnReport.textOverflows, `${report.label} return animation`).toEqual([]);
      }
      await expect(stage).toHaveAttribute("data-confirmed-events", String(step + 1), {
        timeout: 3_000,
      });
    }
    await expect(stage).toHaveAttribute("data-phase", "completed");
  }
});

test("drag-controlled lesson exposes a real compatible drop gesture", async () => {
  const stage = await openRuntimeLesson(4);
  const scene = stage.locator(".foa-runtime-scene");
  const source = scene.locator(".foa-runtime-scene__value-choice[data-state='active']").first();
  const target = scene.locator(".foa-runtime-scene__relation[data-drop-target='true']");
  const ghost = scene.locator(".foa-runtime-scene__drag-ghost");

  await expect(scene).toHaveAttribute("data-learner-control", "drag");
  await expect(source).toBeEnabled();
  await expect(target).toBeVisible();
  const sourceBox = await source.boundingBox();
  if (sourceBox === null) throw new Error("Course 4 drag source geometry is missing");

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 12,
    sourceBox.y + sourceBox.height / 2,
    {
      steps: 2,
    },
  );
  await expect(ghost).toBeVisible();
  const liveTargetBox = await target.boundingBox();
  if (liveTargetBox === null) throw new Error("Course 4 drop target moved out of layout");
  await page.mouse.move(
    liveTargetBox.x + liveTargetBox.width / 2,
    liveTargetBox.y + liveTargetBox.height / 2,
    { steps: 6 },
  );
  await expect(target).toHaveAttribute("data-drop-state", "compatible");
  await page.mouse.up();

  await expect(stage).toHaveAttribute("data-confirmed-events", "1");
  await expect(ghost).toBeHidden();
  await expect(target).toHaveAttribute("data-drop-state", "idle");
});

test("single, pair, sequence, and bounded-array inputs recompute visible values and output", async () => {
  test.setTimeout(90_000);

  for (const runtimeCase of INPUT_CASES) {
    await test.step(`lesson ${String(runtimeCase.order)} recomputes its runtime model`, async () => {
      const stage = await openRuntimeLesson(runtimeCase.order, runtimeCase.fields);
      const scene = stage.locator(".foa-runtime-scene");
      const channels = scene.locator(".foa-semantic-scene__channels");

      await expect(channels.locator("dd").first()).toContainText(runtimeCase.input);
      await expect(scene.locator(".foa-runtime-scene__values")).toContainText(
        runtimeCase.fields[Object.keys(runtimeCase.fields)[0] as keyof typeof runtimeCase.fields],
      );
      if (runtimeCase.order === 52) {
        for (const value of runtimeCase.fields.values.split(/\s+/u)) {
          await expect(scene.locator(".foa-runtime-scene__values")).toContainText(value);
        }
      }
      await expect(channels.locator("dd").nth(1)).not.toContainText(runtimeCase.output);

      for (let index = 1; index <= 4; index += 1) {
        await advanceOneStep(stage, scene, index);
      }
      await expect(stage).toHaveAttribute("data-phase", "completed");
      await expect(channels.locator("dd").nth(1)).toContainText(runtimeCase.output);

      await scene.locator("[data-task-lesson-action='change-input']").click();
      const dialog = stage.locator("[data-task-lesson-dialog='input']");
      await expect(dialog).toBeVisible();
      for (const [field, value] of Object.entries(runtimeCase.alternateFields)) {
        await dialog.locator(`[data-task-lesson-input='${field}']`).fill(value);
      }
      await dialog.locator("[data-task-lesson-action='submit-input']").click();
      await expect(dialog).toBeHidden();
      await expect(stage).toHaveAttribute("data-confirmed-events", "0");
      await expect(channels.locator("dd").first()).toContainText(runtimeCase.alternateInput);
      if (runtimeCase.order === 52) {
        for (const value of runtimeCase.alternateFields.values.split(/\s+/u)) {
          await expect(scene.locator(".foa-runtime-scene__values")).toContainText(value);
        }
      }
      await expect(channels.locator("dd").nth(1)).not.toContainText(runtimeCase.output);
      for (let index = 1; index <= 4; index += 1) {
        await advanceOneStep(stage, scene, index);
      }
      await expect(channels.locator("dd").nth(1)).toContainText(runtimeCase.alternateOutput);
    });
  }
});

test("switching courses while a semantic animation settles never resumes the destroyed scene", async () => {
  const pageErrors: string[] = [];
  const collectPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  page.on("pageerror", collectPageError);
  try {
    const stage = await openRuntimeLesson(1);
    const runStep = stage.locator("[data-task-lesson-action='runtime-step']");
    await expect(runStep).toBeVisible();
    await expect(runStep).toBeEnabled();
    await runStep.click();

    const nextLesson = FOA_LESSONS[2]!;
    const nextEntry = page.locator(`[data-tutorial-lesson-id='${nextLesson.id}']`);
    await nextEntry.evaluate((element) => {
      const chapter = element.closest("details");
      if (chapter !== null) chapter.open = true;
    });
    await nextEntry.click();
    await expect(nextEntry).toHaveAttribute("aria-current", "page");
    await page.waitForTimeout(500);

    expect(pageErrors).not.toContain("FOA semantic scene has been destroyed");
    expect(pageErrors).not.toContain("FOA semantic task stage has been destroyed");
  } finally {
    page.off("pageerror", collectPageError);
  }
});

test("runtime scene localizes fully and reduced motion keeps state without spatial animation", async () => {
  test.setTimeout(45_000);
  let stage = await openRuntimeLesson(8);
  let scene = stage.locator(".foa-runtime-scene");

  await selectInterfaceLanguage("en");
  await expect(scene.locator(".foa-semantic-scene__channels dt").first()).toHaveText("Input");
  await expect(scene.locator(".foa-semantic-scene__channels dt").nth(1)).toHaveText("Output");
  await expect(scene.locator(".foa-semantic-scene__run-status")).toHaveText("Ready");
  const englishRuntimeText = await scene.innerText();
  expect(englishRuntimeText).not.toMatch(/[\u3400-\u9fff]/u);
  await selectInterfaceLanguage("zh-CN");

  await page.emulateMedia({ reducedMotion: "reduce" });
  stage = await openRuntimeLesson(37);
  scene = stage.locator(".foa-runtime-scene");
  await expect(scene).toHaveAttribute("data-reduced-motion", "true");
  await stage.locator("[data-task-lesson-action='next']").click();
  expect(
    await scene
      .locator(".foa-runtime-scene__moving-token")
      .evaluateAll((tokens) => tokens.every((token) => (token as HTMLElement).hidden)),
  ).toBe(true);
  const animationEvidence = await scene.evaluate((root) => {
    const animations = root
      .getAnimations({ subtree: true })
      .filter((item) => item.playState === "running");
    return animations.map((animation) => {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect)) return [];
      return effect.getKeyframes().map((keyframe) => keyframe.transform ?? "none");
    });
  });
  expect(animationEvidence.length).toBeGreaterThan(0);
  expect(animationEvidence.flat().every((transform) => transform === "none")).toBe(true);
  await expect(stage).toHaveAttribute("data-timeline-position", "1");
  await expect(stage).toHaveAttribute("data-confirmed-events", "0");
  await expect(scene).toHaveAttribute("data-display-index", "1");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("compressed tutorial panes keep runtime content inside the scene", async () => {
  await page.setViewportSize({ width: 900, height: 700 });
  try {
    for (const order of [23, 41, 50] as const) {
      await test.step(`lesson ${String(order)} stays inside its compressed scene`, async () => {
        const stage = await openRuntimeLesson(order);
        const scene = stage.locator(".foa-runtime-scene");
        const mechanism = scene.locator(".foa-runtime-scene__mechanism");
        const [sceneBox, mechanismBox] = await Promise.all([
          scene.boundingBox(),
          mechanism.boundingBox(),
        ]);
        if (sceneBox === null || mechanismBox === null) {
          throw new Error(`Lesson ${String(order)} is missing runtime geometry`);
        }
        expect(mechanismBox.y).toBeGreaterThanOrEqual(sceneBox.y);
        expect(mechanismBox.y + mechanismBox.height).toBeLessThanOrEqual(
          sceneBox.y + sceneBox.height + 1,
        );
      });
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

async function openRuntimeLesson(
  order: number,
  fields?: Readonly<Record<string, string>>,
): Promise<Locator> {
  const lesson = FOA_LESSONS[order - 1]!;
  const catalogToggle = page.locator("[data-tutorials-action='toggle-catalog']");
  if ((await catalogToggle.getAttribute("aria-expanded")) === "false") {
    await catalogToggle.click();
  }
  const entry = page.locator(`[data-tutorial-lesson-id='${lesson.id}']`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");

  const stage = page.locator(".foa-semantic-stage");
  await expect(stage).toBeVisible();
  const start = stage.locator("[data-task-lesson-action='start']");
  if (await start.isVisible()) {
    await start.click();
  } else {
    const reset = stage.locator("[data-task-lesson-action='reset']");
    await expect(reset).toBeVisible();
    await reset.click();
  }
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  if (await dialog.isVisible()) {
    for (const [field, value] of Object.entries(fields ?? {})) {
      await dialog.locator(`[data-task-lesson-input='${field}']`).fill(value);
    }
    await dialog.locator("[data-task-lesson-action='submit-input']").click();
    await expect(dialog).toBeHidden();
  } else if (fields !== undefined) {
    throw new Error(`FOA lesson ${String(order)} did not open its input dialog`);
  }
  await expect(stage.locator(".foa-runtime-scene")).toBeVisible();
  return stage;
}

async function verifyFamilyMechanism(mechanism: Locator): Promise<void> {
  const layout = await mechanism.getAttribute("data-layout");
  expect(layout).toMatch(/^(?:pipeline|state|branch|loop|sequence|stack|memory|stream|evidence)$/u);
  const selector =
    layout === "branch"
      ? ".foa-runtime-scene__branch"
      : layout === "stack"
        ? ".foa-runtime-scene__stack"
        : layout === "memory"
          ? ".foa-runtime-scene__memory"
          : layout === "stream"
            ? ".foa-runtime-scene__stream"
            : layout === "evidence"
              ? ".foa-runtime-scene__evidence"
              : ".foa-runtime-scene__values";
  await expect(mechanism.locator(`${selector}:visible`)).toHaveCount(1);
}

async function advanceOneStep(
  stage: Locator,
  scene: Locator,
  expectedCount: number,
): Promise<void> {
  const candidates = [
    scene.locator("[data-task-lesson-action='runtime-step']"),
    scene.locator(".foa-runtime-scene__value-choice[data-state='active']").first(),
    scene.locator("[data-outcome][data-compatible='true']").first(),
    scene.locator("[data-stack-action][data-compatible='true']").first(),
    scene.locator(".foa-runtime-scene__memory-link[data-compatible='true']:visible").first(),
    scene.locator("[data-memory-action][data-compatible='true']").first(),
    scene.locator(".foa-semantic-scene__node[data-state='active']"),
  ];
  for (const candidate of candidates) {
    if (!(await candidate.isVisible()) || !(await candidate.isEnabled())) continue;
    await candidate.click();
    try {
      await expect(stage).toHaveAttribute("data-confirmed-events", String(expectedCount), {
        timeout: 2_000,
      });
      return;
    } catch {
      // A course-specific choice can be rejected; the active semantic step remains the fallback.
    }
  }
  throw new Error(`No learner action advanced runtime evidence to ${String(expectedCount)}`);
}

async function runtimeSnapshot(scene: Locator): Promise<{
  readonly displayIndex: string | undefined;
  readonly mechanismState: string;
}> {
  return scene.evaluate((root) => {
    const visible = (element: HTMLElement): boolean =>
      !element.hidden && getComputedStyle(element).display !== "none";
    const values = [...root.querySelectorAll<HTMLElement>(".foa-runtime-scene__value")]
      .filter(visible)
      .map((element) => ({
        id: element.dataset.valueId,
        state: element.dataset.state,
        text: element.textContent?.trim(),
      }));
    const history = [...root.querySelectorAll<HTMLElement>(".foa-runtime-scene__history-item")]
      .filter(visible)
      .map((element) => ({ state: element.dataset.state, text: element.textContent?.trim() }));
    const branch = root.querySelector<HTMLElement>(".foa-runtime-scene__branch");
    const stack = [...root.querySelectorAll<HTMLElement>(".foa-runtime-scene__stack-frame")]
      .filter(visible)
      .map((element) => ({ state: element.dataset.state, text: element.textContent?.trim() }));
    const stream = [...root.querySelectorAll<HTMLElement>(".foa-runtime-scene__stream-token")]
      .filter(visible)
      .map((element) => ({ state: element.dataset.state, text: element.textContent?.trim() }));
    const memory = root.querySelector<HTMLElement>(".foa-runtime-scene__memory-relation");
    return {
      displayIndex: root.dataset.displayIndex,
      mechanismState: JSON.stringify({
        values,
        history,
        branch: branch?.dataset.outcome,
        stack,
        stream,
        memory: memory?.textContent?.trim(),
      }),
    };
  });
}

async function installTransitionProbe(scene: Locator): Promise<void> {
  await scene.evaluate((root) => {
    type TransitionRecord = { readonly mode: string; readonly from: string; readonly to: string };
    const view = root.ownerDocument.defaultView as
      (Window & { __foaRuntimeTransitions?: TransitionRecord[] }) | null;
    if (view === null) throw new Error("FOA runtime scene has no window");
    view.__foaRuntimeTransitions = [];
    const observer = new MutationObserver(() => {
      if (root.getAttribute("data-transitioning") !== "true") return;
      const record = {
        mode: root.getAttribute("data-transition-mode") ?? "",
        from: root.getAttribute("data-transition-from") ?? "",
        to: root.getAttribute("data-transition-to") ?? "",
      };
      if (
        !view.__foaRuntimeTransitions?.some(
          (item) => JSON.stringify(item) === JSON.stringify(record),
        )
      ) {
        view.__foaRuntimeTransitions?.push(record);
      }
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: [
        "data-transitioning",
        "data-transition-mode",
        "data-transition-from",
        "data-transition-to",
      ],
    });
  });
}

async function readTransitionProbe(
  scene: Locator,
): Promise<readonly { readonly mode: string; readonly from: string; readonly to: string }[]> {
  return scene.evaluate((root) => {
    type TransitionRecord = { readonly mode: string; readonly from: string; readonly to: string };
    const view = root.ownerDocument.defaultView as
      (Window & { __foaRuntimeTransitions?: TransitionRecord[] }) | null;
    return view?.__foaRuntimeTransitions ?? [];
  });
}

async function selectInterfaceLanguage(locale: "zh-CN" | "en"): Promise<void> {
  await page.evaluate((nextLocale) => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    if (language === null) throw new Error("Interface language control is unavailable");
    language.value = nextLocale;
    language.dispatchEvent(new Event("change", { bubbles: true }));
  }, locale);
  await expect(page.locator("html")).toHaveAttribute("data-locale", locale);
}

function normalizeStationBoxes(
  boxes: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[],
): readonly {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}[] {
  const origin = boxes[0] ?? { x: 0, y: 0 };
  const stable = (value: number): number => Math.round(value * 10) / 10;
  return boxes.map((box) => ({
    x: stable(box.x - origin.x),
    y: stable(box.y - origin.y),
    width: stable(box.width),
    height: stable(box.height),
  }));
}

interface SignatureContractAudit {
  readonly label: string;
  readonly stationOverlaps: readonly string[];
  readonly textOverflows: readonly string[];
  readonly textOverlaps: readonly string[];
  readonly routesThroughText: readonly string[];
  readonly routeIntersections: readonly string[];
  readonly visiblePendingRoutes: readonly string[];
  readonly controlsOverlaps: readonly string[];
  readonly portVerticalOffsets: readonly number[];
  readonly routeEndpointOffsets: readonly number[];
  readonly horizontalOverflow: number;
  readonly canvasBottomOverflow: number;
  readonly viewportOverflow: number;
  readonly activeFieldCount: number;
  readonly fontSizes: readonly number[];
  readonly visibleTextCount: number;
  readonly charactersPer10kPx: number;
}

async function auditSignatureContract(
  contract: Locator,
  locale: "zh-CN" | "en",
  width: number,
  step: number,
): Promise<SignatureContractAudit> {
  return contract.evaluate(
    (root, context) => {
      interface Box {
        readonly left: number;
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
        readonly width: number;
        readonly height: number;
      }
      const box = (element: Element): Box => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      const visible = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        return !element.hidden && style.display !== "none" && style.visibility !== "hidden";
      };
      const intersectionArea = (left: Box, right: Box): number =>
        Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) *
        Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
      const distance = (left: { x: number; y: number }, right: { x: number; y: number }): number =>
        Math.hypot(left.x - right.x, left.y - right.y);
      const selector = [
        ".foa-signature-contract__title",
        ".foa-signature-contract__instruction",
        ".foa-signature-contract__step",
        ".foa-signature-contract__station-name",
        ".foa-signature-contract__signature",
        ".foa-signature-contract__field-label",
        ".foa-signature-contract__field-value",
        ".foa-signature-contract__travel-token",
      ].join(",");
      const textElements = [...root.querySelectorAll<HTMLElement>(selector)].filter(visible);
      const textRects = textElements.map((element) => ({
        element,
        rect: box(element),
        name: `${element.className}:${element.textContent?.trim() ?? ""}`,
      }));
      const stations = [...root.querySelectorAll<HTMLElement>(".foa-signature-contract__station")];
      const stationOverlaps: string[] = [];
      for (let leftIndex = 0; leftIndex < stations.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < stations.length; rightIndex += 1) {
          if (intersectionArea(box(stations[leftIndex]!), box(stations[rightIndex]!)) > 1) {
            stationOverlaps.push(
              `${stations[leftIndex]!.dataset.stationId ?? leftIndex}-${stations[rightIndex]!.dataset.stationId ?? rightIndex}`,
            );
          }
        }
      }
      const textOverflows = textElements
        .filter(
          (element) =>
            element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1,
        )
        .map((element) => `${element.className}:${element.textContent?.trim() ?? ""}`);
      const textOverlaps: string[] = [];
      for (let leftIndex = 0; leftIndex < textRects.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < textRects.length; rightIndex += 1) {
          const left = textRects[leftIndex]!;
          const right = textRects[rightIndex]!;
          if (left.element.contains(right.element) || right.element.contains(left.element))
            continue;
          if (intersectionArea(left.rect, right.rect) > 1) {
            textOverlaps.push(`${left.name} <> ${right.name}`);
          }
        }
      }
      const portVerticalOffsets = [
        ...root.querySelectorAll<HTMLElement>(".foa-signature-contract__port"),
      ].map((port) => {
        const row = port.closest<HTMLElement>(".foa-signature-contract__field");
        if (row === null) return Number.POSITIVE_INFINITY;
        const portRect = box(port);
        const rowRect = box(row);
        return Math.abs(portRect.top + portRect.height / 2 - (rowRect.top + rowRect.height / 2));
      });
      const routeEndpoints: Readonly<Record<string, readonly [string, string]>> = {
        "prototype-call": ["prototype-return", "call-return"],
        "prototype-call-parameters": ["prototype-parameters", "call-arguments"],
        "prototype-definition": ["prototype-return", "definition-return"],
        "definition-return": ["definition-result", "call-result"],
      };
      const svg = root.querySelector<SVGSVGElement>(".foa-signature-contract__routes");
      if (svg === null) throw new Error("Signature contract routes are missing");
      const svgRect = box(svg);
      const routeEndpointOffsets: number[] = [];
      const routesThroughText: string[] = [];
      const routeSamples: Array<{
        readonly id: string;
        readonly points: readonly { readonly x: number; readonly y: number }[];
      }> = [];
      for (const path of root.querySelectorAll<SVGPathElement>(".foa-signature-contract__route")) {
        const endpoints = routeEndpoints[path.dataset.routeId ?? ""];
        if (endpoints === undefined) continue;
        const length = path.getTotalLength();
        const pathIsVisible = Number.parseFloat(getComputedStyle(path).opacity) > 0.02;
        if (pathIsVisible) {
          routeSamples.push({
            id: path.dataset.routeId ?? "route",
            points: Array.from({ length: 33 }, (_, index) => {
              const point = path.getPointAtLength((length * index) / 32);
              return { x: point.x + svgRect.left, y: point.y + svgRect.top };
            }),
          });
        }
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(length);
        for (const [point, endpointId] of [
          [start, endpoints[0]],
          [end, endpoints[1]],
        ] as const) {
          const endpoint = root.querySelector<HTMLElement>(
            `.foa-signature-contract__port[data-endpoint-id='${endpointId}']`,
          );
          if (endpoint === null) throw new Error(`Missing endpoint ${endpointId}`);
          const endpointRect = box(endpoint);
          routeEndpointOffsets.push(
            distance(
              { x: point.x + svgRect.left, y: point.y + svgRect.top },
              {
                x: endpointRect.left + endpointRect.width / 2,
                y: endpointRect.top + endpointRect.height / 2,
              },
            ),
          );
        }
        for (let sample = 2; pathIsVisible && sample <= 38; sample += 1) {
          const point = path.getPointAtLength((length * sample) / 40);
          const pagePoint = { x: point.x + svgRect.left, y: point.y + svgRect.top };
          const collision = textRects.find(
            ({ rect }) =>
              pagePoint.x >= rect.left &&
              pagePoint.x <= rect.right &&
              pagePoint.y >= rect.top &&
              pagePoint.y <= rect.bottom,
          );
          if (collision !== undefined) {
            routesThroughText.push(`${path.dataset.routeId ?? "route"}:${collision.name}`);
            break;
          }
        }
      }
      const routeIntersections: string[] = [];
      const orientation = (
        first: { x: number; y: number },
        second: { x: number; y: number },
        third: { x: number; y: number },
      ): number =>
        (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
      for (let leftIndex = 0; leftIndex < routeSamples.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < routeSamples.length; rightIndex += 1) {
          const left = routeSamples[leftIndex]!;
          const right = routeSamples[rightIndex]!;
          let intersects = false;
          for (let leftSegment = 4; leftSegment < left.points.length - 5; leftSegment += 1) {
            const leftStart = left.points[leftSegment]!;
            const leftEnd = left.points[leftSegment + 1]!;
            for (let rightSegment = 4; rightSegment < right.points.length - 5; rightSegment += 1) {
              const rightStart = right.points[rightSegment]!;
              const rightEnd = right.points[rightSegment + 1]!;
              if (
                orientation(leftStart, leftEnd, rightStart) *
                  orientation(leftStart, leftEnd, rightEnd) <
                  -0.01 &&
                orientation(rightStart, rightEnd, leftStart) *
                  orientation(rightStart, rightEnd, leftEnd) <
                  -0.01
              ) {
                intersects = true;
                break;
              }
            }
            if (intersects) break;
          }
          if (intersects) routeIntersections.push(`${left.id} <> ${right.id}`);
        }
      }
      const rootRect = box(root);
      const visiblePendingRoutes = [
        ...root.querySelectorAll<SVGPathElement>(
          ".foa-signature-contract__route[data-state='pending']",
        ),
      ]
        .filter((path) => Number.parseFloat(getComputedStyle(path).opacity) > 0.02)
        .map((path) => path.dataset.routeId ?? "route");
      const canvas = root.querySelector<HTMLElement>(".foa-signature-contract__canvas");
      if (canvas === null) throw new Error("Signature contract canvas is missing");
      const canvasRect = box(canvas);
      const controls = root.ownerDocument.querySelector<HTMLElement>(
        ".library-task-stage__controls",
      );
      const controlsRect = controls === null || !visible(controls) ? null : box(controls);
      const controlsOverlaps =
        controlsRect === null
          ? []
          : [
              ...root.querySelectorAll<HTMLElement>(
                ".foa-signature-contract__station, .foa-signature-contract__port[data-compatible='true']",
              ),
            ]
              .filter(visible)
              .filter((element) => intersectionArea(box(element), controlsRect) > 1)
              .map(
                (element) =>
                  element.dataset.stationId ?? element.dataset.endpointId ?? element.className,
              );
      const characterCount = textElements.reduce(
        (total, element) => total + (element.textContent?.trim().length ?? 0),
        0,
      );
      const area = Math.max(1, rootRect.width * rootRect.height);
      return {
        label: `${context.locale} ${String(context.width)}px step ${String(context.step + 1)}`,
        stationOverlaps,
        textOverflows,
        textOverlaps,
        routesThroughText,
        routeIntersections,
        visiblePendingRoutes,
        controlsOverlaps,
        portVerticalOffsets,
        routeEndpointOffsets,
        horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
        canvasBottomOverflow: Math.max(0, canvasRect.bottom - rootRect.bottom),
        viewportOverflow: Math.max(
          0,
          -rootRect.left,
          rootRect.right - (root.ownerDocument.defaultView?.innerWidth ?? rootRect.right),
        ),
        activeFieldCount: root.querySelectorAll(
          ".foa-signature-contract__field[data-state='active']",
        ).length,
        fontSizes: [
          ...new Set(
            textElements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
          ),
        ].sort((left, right) => left - right),
        visibleTextCount: textElements.length,
        charactersPer10kPx: (characterCount * 10_000) / area,
      };
    },
    { locale, width, step },
  );
}

async function stationBoxes(contract: Locator): Promise<readonly Record<string, number>[]> {
  return contract.locator(".foa-signature-contract__station").evaluateAll((stations) =>
    stations.map((station) => {
      const rect = station.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      };
    }),
  );
}

function maxStationBoxDelta(
  current: readonly Record<string, number>[],
  reference: readonly Record<string, number>[],
): number {
  return current.reduce((maximum, box, index) => {
    const original = reference[index];
    if (original === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(
      maximum,
      ...Object.keys(box).map((key) => Math.abs((box[key] ?? 0) - (original[key] ?? 0))),
    );
  }, 0);
}
