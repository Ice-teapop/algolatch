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

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const LINEAR_LESSON_ID = "tutorial.foa.c01.l002";
const BRANCH_LESSON_ID = "tutorial.foa.c03.l016";
const LOOP_LESSON_ID = "tutorial.foa.c04.l022";

async function startAndPauseActiveTransport(demo: Locator): Promise<number | null> {
  return demo.evaluate(async (root) => {
    const playPause = root.querySelector<HTMLButtonElement>("[data-flow-control='play-pause']");
    const movingValue = root.querySelector<HTMLElement>("[data-flow-value-id='runtime-value']");
    const frame = root.querySelector<HTMLElement>("[data-flow-frame]");
    if (playPause === null || movingValue === null || frame === null) return null;

    playPause.click();
    return new Promise<number | null>((resolve) => {
      const deadline = performance.now() + 4_000;
      const pauseWhenRunning = (): void => {
        const running = movingValue
          .getAnimations()
          .find((animation) => animation.playState === "running");
        if (running !== undefined) {
          // Keep discovery and the real UI action in one renderer task. Otherwise a slow CI
          // round-trip can let this 480 ms transition commit before Playwright clicks Pause.
          playPause.click();
          const paused = movingValue
            .getAnimations()
            .find((animation) => animation.playState === "paused");
          resolve(paused === undefined ? null : Number(frame.dataset.frameIndex));
          return;
        }
        if (performance.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(pauseWhenRunning, 8);
      };
      pauseWhenRunning();
    });
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-input-flow-e2e-"));
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
  await expect(page.locator("#startup-loader")).toBeHidden();
  await page.locator("#tutorials-tab").click();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("moves a learner value through reversible linear FlowFrames", async () => {
  test.setTimeout(60_000);
  const linear = await openDemo(LINEAR_LESSON_ID, "linear", "9");
  await expectFlowControls(linear);
  const movingValue = linear.locator("[data-flow-value-id='runtime-value']");
  const inputEdge = linear.locator("[data-flow-edge-id='linear.input-to-value']");
  const squareEdge = linear.locator("[data-flow-edge-id='linear.value-to-square']");
  const outputEdge = linear.locator("[data-flow-edge-id='linear.square-to-output']");
  await expect(movingValue).toHaveText("9");
  await expect(movingValue).toHaveAttribute("data-motion-state", "settled");
  await expect(inputEdge).toHaveAttribute("data-state", "idle");
  await expect(squareEdge).toHaveAttribute("data-state", "idle");
  await expect(outputEdge).toHaveAttribute("data-state", "idle");
  const idleConnectorStyle = await inputEdge.evaluate((edge) => ({
    stroke: getComputedStyle(edge).stroke,
    strokeWidth: getComputedStyle(edge).strokeWidth,
  }));

  const inputNode = linear.locator("[data-flow-node='input']");
  await inputNode.hover();
  const restingBounds = await inputNode.boundingBox();
  await page.mouse.down();
  const pressedBounds = await inputNode.boundingBox();
  await page.mouse.up();
  if (restingBounds === null || pressedBounds === null) {
    throw new Error("Linear input node geometry is unavailable");
  }
  expect(Math.abs(pressedBounds.x - restingBounds.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(pressedBounds.y - restingBounds.y)).toBeLessThanOrEqual(0.5);

  const labelsFit = await linear
    .locator("[data-flow-node] > strong")
    .evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth + 1));
  expect(labelsFit).toBe(true);

  await expectFrame(linear, 0, /9/u);
  const timeline = linear.locator("[data-flow-timeline]");
  await expect(timeline).toHaveAttribute("aria-valuenow", "0");
  await expect(timeline).toHaveAttribute("aria-valuetext", "1 / 4");
  const next = linear.locator("[data-flow-control='next']");
  await next.click();
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "moving");
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-frame-index", "0");
  await expect(inputEdge).toHaveAttribute("data-state", "traversing");
  expect(
    await inputEdge.evaluate((edge) => ({
      stroke: getComputedStyle(edge).stroke,
      strokeWidth: getComputedStyle(edge).strokeWidth,
    })),
  ).toEqual(idleConnectorStyle);
  const transportAlignment = await movingValue.evaluate((token) => {
    const root = token.closest(".foa-flow-demo");
    const path = root?.querySelector<SVGPathElement>("[data-flow-edge-id='linear.input-to-value']");
    const animation = token.getAnimations().find((item) => item.playState === "running");
    if (animation === undefined || path === null || path === undefined) return null;
    const matrix = path.getScreenCTM();
    const svg = path.ownerSVGElement;
    if (matrix === null || svg === null) return null;
    animation.pause();
    animation.currentTime = 240;
    const pathPoint = path.getPointAtLength(path.getTotalLength() / 2);
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = pathPoint.x;
    screenPoint.y = pathPoint.y;
    const expected = screenPoint.matrixTransform(matrix);
    const tokenRect = token.getBoundingClientRect();
    const actual = {
      x: tokenRect.left + tokenRect.width / 2,
      y: tokenRect.top + tokenRect.height / 2,
    };
    animation.play();
    return Math.hypot(actual.x - expected.x, actual.y - expected.y);
  });
  expect(transportAlignment).not.toBeNull();
  expect(transportAlignment!).toBeLessThan(8);
  await expect(linear.locator("[data-flow-node='value']")).toHaveAttribute(
    "data-arrival-state",
    "receiving",
  );
  await expect(next).toBeDisabled();
  await expectFrame(linear, 1, /value\s*=\s*9/iu);
  await expect(timeline).toHaveAttribute("aria-valuenow", "1");
  await expect(timeline).toHaveAttribute("aria-valuetext", "2 / 4");
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "idle");
  await expect(inputEdge).toHaveAttribute("data-state", "taken");
  await expect(squareEdge).toHaveAttribute("data-state", "idle");
  await expect(outputEdge).toHaveAttribute("data-state", "idle");
  await next.click();
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "moving");
  await linear.locator("[data-flow-control='previous']").click();
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "idle");
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-frame-index", "1");
  await expect(squareEdge).toHaveAttribute("data-state", "idle");
  await expect(movingValue.locator("xpath=ancestor::*[@data-flow-node][1]")).toHaveAttribute(
    "data-flow-node",
    "value",
  );

  await next.click();
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "moving");
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-frame-index", "1");
  await expect(movingValue).toHaveAttribute("data-motion-state", "moving");
  await expect(movingValue).toHaveText("9 × 9");
  await expect(movingValue).toHaveAttribute("aria-label", /9\s*×\s*9\s*=\s*81/u);
  await expect(next).toBeDisabled();
  await expect(squareEdge).toHaveAttribute("data-state", "traversing");
  await expect(outputEdge).toHaveAttribute("data-state", "idle");
  await expectFrame(linear, 2, /9\s*[×*]\s*9\s*=\s*81/u);
  await expect(movingValue).toHaveAttribute("data-motion-state", "settled");
  await expect(movingValue).toHaveText("81");
  await expect(timeline).toHaveAttribute("aria-valuenow", "2");
  await expect(timeline).toHaveAttribute("aria-valuetext", "3 / 4");
  await expect(next).toBeEnabled();
  await expect(squareEdge).toHaveAttribute("data-state", "taken");
  await next.click();
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "moving");
  await expect(linear.locator("[data-flow-frame]")).toHaveAttribute("data-frame-index", "2");
  await expect(linear.locator("[data-flow-output]")).not.toHaveAttribute("data-state", "done");
  await expectFrame(linear, 3, /(?:输出|output|stdout).*81/iu);
  await expect(outputEdge).toHaveAttribute("data-state", "taken");
  await expectOutput(linear, "81");
  await expect(linear.locator(".foa-flow-demo")).toHaveAttribute("data-run-state", "completed");

  await previousFrame(linear);
  await expectFrame(linear, 2, /9\s*[×*]\s*9\s*=\s*81/u);
  await expect(linear.locator("[data-flow-output]")).not.toHaveAttribute("data-state", "done");
  await nextFrame(linear);
  await expectFrame(linear, 3, /(?:输出|output|stdout).*81/iu);
  await expectOutput(linear, "81");
});

test("pauses and resumes the in-flight value transport without committing early", async () => {
  test.setTimeout(60_000);
  const linear = await openDemo(LINEAR_LESSON_ID, "linear", "9");
  const frame = linear.locator("[data-flow-frame]");
  const movingValue = linear.locator("[data-flow-value-id='runtime-value']");
  const playPause = linear.locator("[data-flow-control='play-pause']");
  const timeline = linear.locator("[data-flow-timeline]");
  const demo = linear.locator(".foa-flow-demo");

  await expect(demo).toHaveAttribute("data-run-state", "ready");

  const firstPause = await startAndPauseActiveTransport(demo);
  expect(firstPause).not.toBeNull();
  expect(firstPause).toBe(0);
  await expect(playPause).toHaveAttribute("aria-pressed", "false");
  await expect(playPause).toBeEnabled();
  await expect(demo).toHaveAttribute("data-run-state", "paused");
  const paused = await movingValue.evaluate((element) => {
    const animation = element.getAnimations().find((item) => item.playState === "paused");
    return animation === undefined ? null : Number(animation.currentTime);
  });
  expect(paused).not.toBeNull();

  await page.waitForTimeout(650);
  expect(
    await movingValue.evaluate((element) => {
      const animation = element.getAnimations().find((item) => item.playState === "paused");
      return animation === undefined ? null : Number(animation.currentTime);
    }),
  ).toBeCloseTo(paused!, 0);
  await expect(frame).toHaveAttribute("data-frame-index", "0");
  await expect(frame).toHaveAttribute("data-motion-state", "moving");

  await playPause.click();
  await expect(playPause).toHaveAttribute("aria-pressed", "true");
  await expect(demo).toHaveAttribute("data-run-state", "running");
  await expectFrame(linear, 1, /value\s*=\s*9/iu);
  await playPause.click();
  await expect(playPause).toHaveAttribute("aria-pressed", "false");

  // Seeking from a paused in-flight transition cancels its WAAPI object and commits only the
  // explicitly requested frame.
  const secondPause = await startAndPauseActiveTransport(demo);
  expect(secondPause).not.toBeNull();
  expect(secondPause).toBe(1);
  await timeline.evaluate((input) => {
    (input as HTMLInputElement).value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(frame).toHaveAttribute("data-frame-index", "2");
  await expect(frame).toHaveAttribute("data-motion-state", "idle");
  await expect(playPause).toHaveAttribute("aria-pressed", "false");
  expect(await movingValue.evaluate((element) => element.getAnimations().length)).toBe(0);
});

test("requires a fresh prediction after cancelling an in-flight branch", async () => {
  test.setTimeout(60_000);
  const branch = await openDemo(BRANCH_LESSON_ID, "branch", "4");
  const frame = branch.locator("[data-flow-frame]");
  const falseChoice = branch.locator("[data-flow-prediction='false']");

  await expectUnrevealedBranchDecision(branch);
  await falseChoice.click();
  await expect(frame).toHaveAttribute("data-motion-state", "moving");
  await branch.locator("[data-flow-control='previous']").click();
  await expectUnrevealedBranchDecision(branch);
  await expect(branch.locator("[data-flow-control='next']")).toBeDisabled();

  await falseChoice.click();
  await expect(branch.locator("[data-flow-output]")).toHaveAttribute("data-state", "done");
  await expectOutput(branch, "4");
});

test("keeps branch outcomes hidden, executes only the chosen path, and asks again after rewind", async () => {
  test.setTimeout(60_000);
  const branch = await openDemo(BRANCH_LESSON_ID, "branch", "4");
  await expectFlowControls(branch);
  await expect(branch.locator("[data-flow-node='keep']")).toHaveCount(0);
  await expect(branch.locator("[data-flow-node='merge']")).toHaveCount(0);

  const trueEdge = branch.locator("[data-flow-edge='true']");
  const falseEdge = branch.locator("[data-flow-edge='false']");
  const updateNode = branch.locator("[data-flow-node='update']");
  const outputNode = branch.locator("[data-flow-output]");

  await expectUnrevealedBranchDecision(branch);
  const idleFalseStyle = await connectorStyle(falseEdge);

  await branch.locator("[data-flow-prediction='false']").click();
  await expect(branch.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "moving");
  await expect(branch.locator("[data-flow-frame]")).toHaveAttribute("data-frame-index", "0");
  await expect(falseEdge).toHaveAttribute("data-state", "traversing");
  expect(await connectorStyle(falseEdge)).toEqual(idleFalseStyle);
  await expectTokenAlignedWithEdge(branch, falseEdge);

  // A false result has no synthetic keep/merge click: it arrives at output directly.
  await expect(outputNode).toHaveAttribute("data-state", "done");
  await expect(updateNode).toHaveAttribute("data-state", "skipped");
  await expect(falseEdge).toHaveAttribute("data-state", "taken");
  await expect(trueEdge).toHaveAttribute("data-state", "idle");
  await expectOutput(branch, "4");

  // Rewinding across the decision invalidates the old answer instead of replaying it silently.
  await previousFrame(branch);
  await expectUnrevealedBranchDecision(branch);
  await expect(falseEdge).toHaveAttribute("data-state", "idle");
  await expect(trueEdge).toHaveAttribute("data-state", "idle");

  await changeInput(branch, "-7", false);
  await expectUnrevealedBranchDecision(branch);
  const idleTrueStyle = await connectorStyle(trueEdge);
  await branch.locator("[data-flow-prediction='true']").click();
  await expect(branch.locator("[data-flow-frame]")).toHaveAttribute("data-motion-state", "moving");
  await expect(trueEdge).toHaveAttribute("data-state", "traversing");
  expect(await connectorStyle(trueEdge)).toEqual(idleTrueStyle);
  await expectTokenAlignedWithEdge(branch, trueEdge);

  await expect(updateNode).toHaveAttribute("data-state", "active");
  await expect(trueEdge).toHaveAttribute("data-state", "taken");
  await expect(falseEdge).toHaveAttribute("data-state", "idle");
  await expect(outputNode).not.toHaveAttribute("data-state", "done");
  await advanceToOutput(branch);
  await expectOutput(branch, "7");
});

test("keeps the simplified branch legible at 520, 720, and 960 pixel panel widths", async () => {
  test.setTimeout(60_000);
  const branch = await openDemoViaOtherLesson(BRANCH_LESSON_ID, "branch", "-7");

  try {
    for (const locale of ["zh-CN", "en"] as const) {
      await selectInterfaceLanguage(locale);
      for (const width of [520, 720, 960]) {
        await constrainTutorialPanelWidth(width);
        const geometry = await measureBranchGeometry(branch);
        const context = `${locale} at ${String(width)}px`;
        expect(geometry.panelWidth, `Unexpected tutorial panel width for ${context}`).toBe(width);
        expect(geometry.pathLabelCount, `True/false path labels are missing for ${context}`).toBe(
          2,
        );
        expect(geometry.overlaps, `Branch nodes overlap for ${context}`).toEqual([]);
        expect(geometry.outsideNodes, `Branch nodes leave the graph for ${context}`).toEqual([]);
        expect(geometry.outsidePathLabels, `Path labels leave the graph for ${context}`).toEqual(
          [],
        );
        expect(geometry.overflowingText, `Branch copy is clipped for ${context}`).toEqual([]);
        expect(
          geometry.distortedPathLabels,
          `Branch path labels are non-uniformly scaled for ${context}`,
        ).toEqual([]);
        if (locale === "en") {
          expect(
            geometry.visibleCopy,
            `English branch contains Chinese copy for ${context}`,
          ).not.toMatch(/\p{Script=Han}/u);
        } else {
          expect(geometry.visibleCopy, `Chinese branch copy is missing for ${context}`).toMatch(
            /\p{Script=Han}/u,
          );
        }
      }
    }
  } finally {
    await restoreTutorialPanelWidth();
    await selectInterfaceLanguage("zh-CN");
  }
});

test("exposes every loop state, supports rewind, and exits n = 0 directly", async () => {
  test.setTimeout(60_000);
  const loop = await openDemo(LOOP_LESSON_ID, "loop", "3");
  await expectFlowControls(loop);

  const observations = await collectFramesToOutput(loop);
  expectOrderedObservations(observations, [
    /i\s*=\s*1.*sum\s*=\s*0/iu,
    /sum\s*=\s*1/iu,
    /i\s*=\s*2/iu,
    /sum\s*=\s*3/iu,
    /i\s*=\s*4.*(?:false|假)/iu,
    /(?:输出|output|stdout).*6/iu,
  ]);
  await expectOutput(loop, "6");

  const outputFrameIndex = await currentFrameIndex(loop);
  await previousFrame(loop);
  expect(await currentFrameIndex(loop)).toBe(outputFrameIndex - 1);
  await expect(loop.locator("[data-flow-observation]")).toContainText(/i\s*=\s*4/iu);
  await nextFrame(loop);
  await expectOutput(loop, "6");

  await changeInput(loop, "0", false);
  await expect(loop.locator("[data-flow-output]")).toHaveAttribute("data-state", "done");
  await expectOutput(loop, "0");
  await expect(loop.locator("[data-flow-control='previous']")).toBeDisabled();
  await expect(loop.locator("[data-flow-control='next']")).toBeDisabled();
  await expect(loop.locator("[data-flow-observation]")).toContainText(
    /n\s*=\s*0.*(?:false|假|不执行|does not run)/iu,
  );
});

test("keeps FlowFrames keyboard-operable, localized, reduced-motion safe, and dense", async () => {
  test.setTimeout(60_000);
  let linear = await openDemo(LINEAR_LESSON_ID, "linear", "5");
  const frame = linear.locator("[data-flow-frame]");
  await frame.focus();
  await page.keyboard.press("ArrowRight");
  await expectFrame(linear, 1, /value\s*=\s*5/iu);
  await page.keyboard.press("ArrowLeft");
  await expectFrame(linear, 0, /5/u);

  const playPause = linear.locator("[data-flow-control='play-pause']");
  await frame.focus();
  await page.keyboard.press("Space");
  await expect(playPause).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(playPause).toHaveAttribute("aria-pressed", "false");

  await selectInterfaceLanguage("en");
  await expect(linear.locator("[data-flow-control='previous']")).toHaveAccessibleName("Previous");
  await expect(linear.locator("[data-flow-control='play-pause']")).toHaveAccessibleName("Play");
  await expect(linear.locator("[data-flow-control='next']")).toHaveAccessibleName("Next");
  await linear.locator("[data-task-lesson-action='change-input']").click();
  const englishDialog = linear.locator("[data-task-lesson-dialog='input']");
  await expect(englishDialog).toHaveAccessibleName("Enter a number");
  await englishDialog.locator("[data-task-lesson-action='cancel-input']").click();
  await selectInterfaceLanguage("zh-CN");

  await page.emulateMedia({ reducedMotion: "reduce" });
  linear = await openDemoViaOtherLesson(LINEAR_LESSON_ID, "linear", "6");
  await expect(linear).toHaveAttribute("data-reduced-motion", "true");
  await nextFrame(linear);
  const runningAnimations = await linear
    .locator("[data-flow-frame-kind]")
    .evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running").length,
    );
  expect(runningAnimations).toBe(0);
  await expectFrame(linear, 1, /value\s*=\s*6/iu);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const geometry = await linear.evaluate((element) => {
    const workspace = element.querySelector<HTMLElement>(".foa-semantic-stage__workspace");
    const flow = element.querySelector<HTMLElement>("[data-flow-frame-kind]");
    const canvas = element.querySelector<HTMLElement>("[data-flow-canvas]");
    const source = element.querySelector<HTMLElement>(".teaching-source-view");
    const visibleContent = [
      ...element.querySelectorAll<HTMLElement>(
        "[data-flow-node], [data-flow-output], [data-flow-observation]",
      ),
    ].filter((candidate) => {
      const style = getComputedStyle(candidate);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    if (
      workspace === null ||
      flow === null ||
      canvas === null ||
      source === null ||
      visibleContent.length === 0
    ) {
      throw new Error("FlowFrame geometry targets are unavailable");
    }
    const workspaceBounds = workspace.getBoundingClientRect();
    const flowBounds = flow.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    const contentBounds = visibleContent.map((candidate) => candidate.getBoundingClientRect());
    const contentTop = Math.min(...contentBounds.map((bounds) => bounds.top));
    const contentBottom = Math.max(...contentBounds.map((bounds) => bounds.bottom));
    return {
      workspaceBlankTail: Math.abs(workspaceBounds.bottom - flowBounds.bottom),
      verticalContentCoverage: (contentBottom - contentTop) / Math.max(1, canvasBounds.height),
      horizontalOverflow: Math.max(0, canvas.scrollWidth - canvas.clientWidth),
      sourceHeight: source.getBoundingClientRect().height,
    };
  });
  expect(geometry.workspaceBlankTail).toBeLessThanOrEqual(6);
  expect(geometry.verticalContentCoverage).toBeGreaterThanOrEqual(0.45);
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(2);
  expect(geometry.sourceHeight).toBeGreaterThanOrEqual(220);
});

async function openDemo(
  lessonId: string,
  kind: "linear" | "branch" | "loop",
  input: string,
): Promise<Locator> {
  const entry = page.locator(`[data-tutorial-lesson-id='${lessonId}']`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  const stage = page.locator(`.foa-semantic-stage[data-flow-demo-kind='${kind}']`);
  await expect(stage).toBeVisible();
  const start = stage.locator("[data-task-lesson-action='start']");
  const repeat = stage.locator("[data-task-lesson-action='repeat']");
  const reset = stage.locator("[data-task-lesson-action='reset']");
  if (await start.isVisible()) await start.click();
  else if (await repeat.isVisible()) await repeat.click();
  else if (await reset.isVisible()) await reset.click();

  const inputDialog = stage.locator("[data-task-lesson-dialog='input']");
  if (!(await inputDialog.isVisible())) {
    await stage.locator("[data-task-lesson-action='change-input']").click();
  }
  await submitDialogInput(stage, input);
  await expect(stage.locator(".foa-semantic-stage__region:visible")).toHaveCount(0);
  await expect(stage.locator("[data-flow-frame]")).toBeFocused();
  return stage;
}

async function openDemoViaOtherLesson(
  lessonId: string,
  kind: "linear" | "branch" | "loop",
  input: string,
): Promise<Locator> {
  const alternateId = lessonId === LOOP_LESSON_ID ? LINEAR_LESSON_ID : LOOP_LESSON_ID;
  const alternate = page.locator(`[data-tutorial-lesson-id='${alternateId}']`);
  await alternate.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await alternate.click();
  return openDemo(lessonId, kind, input);
}

async function submitDialogInput(stage: Locator, input: string): Promise<void> {
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  await expect(dialog).toBeVisible();
  const value = dialog.locator("[data-task-lesson-input='runtime-value']");
  await expect(value).toBeFocused();
  await value.fill(input);
  await value.press("Enter");
  await expect(dialog).toBeHidden();
}

async function changeInput(stage: Locator, input: string, expectFirstFrame = true): Promise<void> {
  await stage.locator("[data-task-lesson-action='change-input']").click();
  await submitDialogInput(stage, input);
  if (expectFirstFrame) {
    await expectFrame(stage, 0, new RegExp(input.replace("-", "-?"), "u"));
  }
}

async function expectFlowControls(stage: Locator): Promise<void> {
  await expect(stage.locator("[data-flow-frame-kind]")).toBeVisible();
  await expect(stage.locator("[data-flow-control='previous']")).toBeVisible();
  await expect(stage.locator("[data-flow-control='play-pause']")).toBeVisible();
  await expect(stage.locator("[data-flow-control='next']")).toBeVisible();
  await expect(stage.locator("[data-flow-timeline]")).toBeVisible();
}

async function expectUnrevealedBranchDecision(stage: Locator): Promise<void> {
  await expect(stage.locator("[data-flow-frame]")).toHaveAttribute("data-frame-index", "0");
  await expect(stage.locator("[data-flow-prediction='true']")).toBeVisible();
  await expect(stage.locator("[data-flow-prediction='false']")).toBeVisible();
  await expect(stage.locator("[data-flow-control='next']")).toBeDisabled();
  await expect(stage.locator("[data-flow-edge='true']")).toHaveAttribute("data-state", "idle");
  await expect(stage.locator("[data-flow-edge='false']")).toHaveAttribute("data-state", "idle");
  await expect(stage.locator("[data-flow-node='update']")).toHaveAttribute("data-state", "pending");
  await expect(stage.locator("[data-flow-output]")).not.toHaveAttribute("data-state", "done");
  await expect(stage.locator("[data-flow-observation]")).not.toContainText(
    /(?:为真|为假|is\s+(?:true|false)|→\s*(?:真|假|true|false))/iu,
  );
}

async function connectorStyle(edge: Locator): Promise<{
  readonly stroke: string;
  readonly strokeWidth: string;
}> {
  return edge.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.freeze({
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
    });
  });
}

async function expectTokenAlignedWithEdge(stage: Locator, edge: Locator): Promise<void> {
  const edgeId = await edge.getAttribute("data-flow-edge-id");
  if (edgeId === null) throw new Error("Branch edge has no stable data-flow-edge-id");
  const distance = await stage.evaluate((root, expectedEdgeId) => {
    const token = root.querySelector<HTMLElement>("[data-flow-value-id='runtime-value']");
    const path = root.querySelector<SVGPathElement>(
      `[data-flow-edge-id='${CSS.escape(expectedEdgeId)}']`,
    );
    if (token === null || path === null) return null;
    const animation = token.getAnimations().find((item) => item.playState === "running");
    const timing = animation?.effect?.getComputedTiming();
    if (animation === undefined || timing === undefined || typeof timing.duration !== "number") {
      return null;
    }
    const matrix = path.getScreenCTM();
    const svg = path.ownerSVGElement;
    if (matrix === null || svg === null) return null;

    const previousTime = animation.currentTime;
    animation.pause();
    animation.currentTime = timing.duration / 2;
    const pathPoint = path.getPointAtLength(path.getTotalLength() / 2);
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = pathPoint.x;
    screenPoint.y = pathPoint.y;
    const expected = screenPoint.matrixTransform(matrix);
    const tokenRect = token.getBoundingClientRect();
    const actualX = tokenRect.left + tokenRect.width / 2;
    const actualY = tokenRect.top + tokenRect.height / 2;
    const result = Math.hypot(actualX - expected.x, actualY - expected.y);
    if (previousTime !== null) animation.currentTime = previousTime;
    animation.play();
    return result;
  }, edgeId);
  expect(distance, `Runtime token did not animate along edge ${edgeId}`).not.toBeNull();
  expect(distance!).toBeLessThanOrEqual(8);
}

async function constrainTutorialPanelWidth(width: number): Promise<void> {
  await page.evaluate((panelWidth) => {
    const module = document.querySelector<HTMLElement>(".tutorials-module");
    if (module === null) throw new Error("Tutorial module is unavailable");
    if (module.dataset.e2eOriginalStyle === undefined) {
      module.dataset.e2eOriginalStyle = module.getAttribute("style") ?? "__none__";
    }
    const catalogWidth = 272;
    module.style.width = `${String(catalogWidth + panelWidth)}px`;
    module.style.maxWidth = "none";
    module.style.gridTemplateColumns = `${String(catalogWidth)}px ${String(panelWidth)}px`;
    module.style.justifySelf = "start";
  }, width);
  await expect
    .poll(async () =>
      page
        .locator(".tutorials-module__stage-host")
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    )
    .toBe(width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function restoreTutorialPanelWidth(): Promise<void> {
  await page.evaluate(() => {
    const module = document.querySelector<HTMLElement>(".tutorials-module");
    if (module === null) return;
    const originalStyle = module.dataset.e2eOriginalStyle;
    if (originalStyle === undefined) return;
    delete module.dataset.e2eOriginalStyle;
    if (originalStyle === "__none__") module.removeAttribute("style");
    else module.setAttribute("style", originalStyle);
  });
}

async function measureBranchGeometry(stage: Locator): Promise<{
  readonly distortedPathLabels: readonly string[];
  readonly outsideNodes: readonly string[];
  readonly outsidePathLabels: readonly string[];
  readonly overflowingText: readonly string[];
  readonly overlaps: readonly string[];
  readonly panelWidth: number;
  readonly pathLabelCount: number;
  readonly visibleCopy: string;
}> {
  return stage.evaluate((root) => {
    const graph = root.querySelector<HTMLElement>(".foa-flow-demo__graph");
    const panel = root.closest(".tutorials-module__stage-host");
    if (!(graph instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      throw new Error("Branch geometry containers are unavailable");
    }
    const graphBounds = graph.getBoundingClientRect();
    const nodeElements = [...root.querySelectorAll<HTMLElement>("[data-flow-node]")].filter(
      (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      },
    );
    const nodes = nodeElements.map((element) => ({
      bounds: element.getBoundingClientRect(),
      id: element.dataset.flowNode ?? element.dataset.flowNodeId ?? "unknown-node",
    }));
    const overlaps: string[] = [];
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex]!;
        const right = nodes[rightIndex]!;
        const overlapX =
          Math.min(left.bounds.right, right.bounds.right) -
          Math.max(left.bounds.left, right.bounds.left);
        const overlapY =
          Math.min(left.bounds.bottom, right.bounds.bottom) -
          Math.max(left.bounds.top, right.bounds.top);
        if (overlapX > 1 && overlapY > 1) {
          overlaps.push(`${left.id}/${right.id}:${overlapX.toFixed(1)}x${overlapY.toFixed(1)}`);
        }
      }
    }

    const outsideNodes = nodes
      .filter(
        ({ bounds }) =>
          bounds.left < graphBounds.left - 1 ||
          bounds.right > graphBounds.right + 1 ||
          bounds.top < graphBounds.top - 1 ||
          bounds.bottom > graphBounds.bottom + 1,
      )
      .map(({ id }) => id);
    const textElements = [
      ...root.querySelectorAll<HTMLElement>(
        "[data-flow-node] > strong, [data-flow-node] > small, [data-flow-observation], [data-flow-prediction] > span, [data-flow-prediction] > button, [data-flow-edge-label]",
      ),
    ].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const overflowingText = textElements
      .filter(
        (element) =>
          element.clientWidth > 0 &&
          (element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1),
      )
      .map((element) => element.textContent?.trim() || element.tagName.toLowerCase());

    const pathLabels = [...root.querySelectorAll<Element>("[data-flow-edge-label]")];
    const distortedPathLabels = pathLabels
      .filter((label) => {
        if (!(label instanceof SVGGraphicsElement)) return false;
        const matrix = label.getScreenCTM();
        if (matrix === null) return true;
        const scaleX = Math.hypot(matrix.a, matrix.b);
        const scaleY = Math.hypot(matrix.c, matrix.d);
        if (scaleX === 0 || scaleY === 0) return true;
        const ratio = scaleX / scaleY;
        return ratio < 0.9 || ratio > 1.1;
      })
      .map((label) => label.textContent?.trim() || "unnamed-path");
    const outsidePathLabels = pathLabels
      .filter((label) => {
        const bounds = label.getBoundingClientRect();
        return (
          bounds.left < graphBounds.left - 1 ||
          bounds.right > graphBounds.right + 1 ||
          bounds.top < graphBounds.top - 1 ||
          bounds.bottom > graphBounds.bottom + 1
        );
      })
      .map((label) => label.textContent?.trim() || "unnamed-path");
    const visibleCopy = [
      ...nodeElements.flatMap((element) =>
        [...element.querySelectorAll<HTMLElement>("strong, small")].map(
          (copy) => copy.textContent?.trim() ?? "",
        ),
      ),
      ...pathLabels.map((label) => label.textContent?.trim() ?? ""),
      ...root.querySelectorAll<HTMLElement>("[data-flow-prediction]"),
    ]
      .map((value) => (typeof value === "string" ? value : (value.textContent?.trim() ?? "")))
      .filter((value) => value.length > 0)
      .join(" ");

    return Object.freeze({
      distortedPathLabels: Object.freeze(distortedPathLabels),
      outsideNodes: Object.freeze(outsideNodes),
      outsidePathLabels: Object.freeze(outsidePathLabels),
      overflowingText: Object.freeze(overflowingText),
      overlaps: Object.freeze(overlaps),
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      pathLabelCount: pathLabels.length,
      visibleCopy,
    });
  });
}

async function expectFrame(stage: Locator, index: number, observation: RegExp): Promise<void> {
  const frame = stage.locator("[data-flow-frame]");
  await expect(frame).toHaveAttribute("data-frame-index", String(index));
  await expect(frame.locator("[data-flow-observation]")).toContainText(observation);
  await expect(stage.locator("[data-flow-timeline]")).toHaveValue(String(index));
}

async function currentFrameIndex(stage: Locator): Promise<number> {
  const value = await stage.locator("[data-flow-frame]").getAttribute("data-frame-index");
  if (value === null) throw new Error("FlowFrame has no data-frame-index");
  return Number(value);
}

async function nextFrame(stage: Locator): Promise<void> {
  const previous = await currentFrameIndex(stage);
  await stage.locator("[data-flow-control='next']").click();
  await expect.poll(() => currentFrameIndex(stage)).toBeGreaterThan(previous);
}

async function previousFrame(stage: Locator): Promise<void> {
  const previous = await currentFrameIndex(stage);
  await stage.locator("[data-flow-control='previous']").click();
  await expect.poll(() => currentFrameIndex(stage)).toBeLessThan(previous);
}

async function advanceUntil(stage: Locator, predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await predicate()) return;
    const next = stage.locator("[data-flow-control='next']");
    if (await next.isDisabled()) break;
    await nextFrame(stage);
  }
  expect(await predicate(), "FlowFrame did not reach the expected state").toBe(true);
}

async function advanceToOutput(stage: Locator): Promise<void> {
  await advanceUntil(
    stage,
    async () => (await stage.locator("[data-flow-output]").getAttribute("data-state")) === "done",
  );
}

async function collectFramesToOutput(stage: Locator): Promise<string[]> {
  const observations: string[] = [];
  for (let attempt = 0; attempt < 32; attempt += 1) {
    observations.push((await stage.locator("[data-flow-observation]").innerText()).trim());
    if ((await stage.locator("[data-flow-output]").getAttribute("data-state")) === "done") break;
    const next = stage.locator("[data-flow-control='next']");
    if (await next.isDisabled()) break;
    await nextFrame(stage);
  }
  expect(await stage.locator("[data-flow-output]").getAttribute("data-state")).toBe("done");
  return observations;
}

function expectOrderedObservations(
  observations: readonly string[],
  expected: readonly RegExp[],
): void {
  let cursor = 0;
  for (const pattern of expected) {
    const index = observations.findIndex(
      (value, candidate) => candidate >= cursor && pattern.test(value),
    );
    expect(
      index,
      `Missing ordered FlowFrame observation: ${String(pattern)}`,
    ).toBeGreaterThanOrEqual(cursor);
    cursor = index + 1;
  }
}

async function expectOutput(stage: Locator, value: string): Promise<void> {
  const output = stage.locator("[data-flow-output]");
  await expect(output).toHaveAttribute("data-state", "done");
  await expect(output).toContainText(value);
}

async function selectInterfaceLanguage(locale: "zh-CN" | "en"): Promise<void> {
  await page.evaluate((nextLocale) => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    if (language === null) throw new Error("Interface language control is unavailable");
    language.value = nextLocale;
    language.dispatchEvent(new Event("change", { bubbles: true }));
  }, locale);
}
