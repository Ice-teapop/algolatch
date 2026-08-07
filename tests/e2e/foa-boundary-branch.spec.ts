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

const BOUNDARY_LESSON = FOA_LESSONS[4]!;
const BRANCH_EDGE_IDS = [
  "boundary.positive",
  "boundary.not-positive",
  "boundary.negative",
  "boundary.zero",
] as const;

const CASES = [
  {
    input: "7",
    category: "positive",
    wrongCategory: "negative",
    takenEdges: ["boundary.positive"],
  },
  {
    input: "-4",
    category: "negative",
    wrongCategory: "zero",
    takenEdges: ["boundary.not-positive", "boundary.negative"],
  },
  {
    input: "0",
    category: "zero",
    wrongCategory: "positive",
    takenEdges: ["boundary.not-positive", "boundary.zero"],
  },
] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-boundary-branch-e2e-"));
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
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await page.locator("#tutorials-tab").click();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("uses real inputs and prediction-gated paths for positive, negative, and zero", async () => {
  test.setTimeout(90_000);
  const stage = await openBoundaryLesson();
  const flow = stage.locator(".foa-flow-demo");
  const frame = flow.locator("[data-flow-frame]");
  const movingValue = flow.locator("[data-flow-value-id='runtime-value']");

  await expect(stage).toHaveAttribute("data-flow-demo-kind", "branch");
  await expect(flow).toHaveAttribute("data-flow-frame-kind", "branch");

  for (const [index, currentCase] of CASES.entries()) {
    await test.step(`${currentCase.input} -> ${currentCase.category}`, async () => {
      if (index > 0) await openInputWithKeyboard(stage);
      await submitInputWithKeyboard(stage, currentCase.input);

      await expect(frame).toHaveAttribute("data-frame-id", "boundary.frame.input");
      await expect(movingValue).toBeVisible();
      await expect(movingValue).toHaveText(currentCase.input);
      await expect(flow).toHaveAttribute("data-run-state", "ready");
      await expect(flow.locator(".foa-flow-demo__evidence")).toContainText("当前位置");
      await expect(stage).toHaveAttribute("data-confirmed-events", "0");
      await expect(stage).toHaveAttribute("data-phase", "task");

      await moveForwardWithKeyboard(frame);
      await expect(frame).toHaveAttribute("data-frame-id", "boundary.frame.value");
      await expect(movingValue).toHaveText(currentCase.input);
      await expect(movingValue.locator("xpath=ancestor::*[@data-flow-node][1]")).toHaveAttribute(
        "data-flow-node",
        "value",
      );

      const next = flow.locator("[data-flow-control='next']");
      await expect(next).toBeDisabled();
      await expect(flow.locator("[data-flow-prediction='positive']")).toBeVisible();
      await expect(flow.locator("[data-flow-prediction='negative']")).toBeVisible();
      await expect(flow.locator("[data-flow-prediction='zero']")).toBeVisible();
      await expect(flow).toHaveAttribute("data-run-state", "prediction");
      await expect(flow.locator(".foa-flow-demo__position")).toContainText("等待预测");
      await expect(flow.locator(".foa-flow-demo__evidence")).toContainText("已走");

      // Repeated transport commands must not manufacture progress while a prediction is pending.
      await frame.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(frame).toHaveAttribute("data-frame-id", "boundary.frame.value");
      await expect(stage).toHaveAttribute("data-confirmed-events", "0");
      await expect(stage).toHaveAttribute("data-phase", "task");
      await expect(flow.locator("[data-flow-output][data-state='done']")).toHaveCount(0);

      const wrongPrediction = flow.locator(`[data-flow-prediction='${currentCase.wrongCategory}']`);
      await wrongPrediction.focus();
      await page.keyboard.press("Enter");
      await expect(flow.locator(".foa-flow-demo__prediction")).toHaveAttribute(
        "data-state",
        "error",
      );
      await expect(frame).toHaveAttribute("data-frame-id", "boundary.frame.value");
      await expectBranchEdges(flow, []);

      const correctPrediction = flow.locator(`[data-flow-prediction='${currentCase.category}']`);
      await correctPrediction.focus();
      await page.keyboard.press("Enter");
      await expect(frame).toHaveAttribute("data-frame-id", "boundary.frame.positive");

      await advanceToOutputWithKeyboard(flow);
      const completedOutput = flow.locator("[data-flow-output][data-state='done']");
      await expect(completedOutput).toHaveCount(1);
      await expect(completedOutput).toContainText(currentCase.category);
      await expectBranchEdges(flow, currentCase.takenEdges);
      await expect(flow).toHaveAttribute("data-run-state", "completed");
      await expect(stage).toHaveAttribute("data-phase", "completed");
    });
  }

  await test.step("the same task remains complete and keyboard-operable in English", async () => {
    await selectInterfaceLanguage("en");
    await expect(flow).toHaveAttribute("data-locale", "en");
    await openInputWithKeyboard(stage);
    const dialog = stage.locator("[data-task-lesson-dialog='input']");
    await expect(dialog).toContainText("Enter a positive number, negative number, or zero");
    await expect(dialog).toContainText(
      "Enter an integer, predict whether it is positive, negative, or zero, then verify the guess on the actual comparison path.",
    );
    await submitInputWithKeyboard(stage, "0");
    await moveForwardWithKeyboard(frame);

    await expect(flow.locator("[data-flow-prediction='positive']")).toHaveText("Positive");
    await expect(flow.locator("[data-flow-prediction='negative']")).toHaveText("Negative");
    await expect(flow.locator("[data-flow-prediction='zero']")).toHaveText("Zero");
    await expect(flow.locator(".foa-flow-demo__prediction")).toContainText(
      "Predict the category of value first",
    );
    await expect(flow.locator(".foa-flow-demo__position")).toContainText("Prediction required");
    expect(await flow.innerText()).not.toMatch(/[\u3400-\u9fff]/u);

    const zero = flow.locator("[data-flow-prediction='zero']");
    await zero.focus();
    await page.keyboard.press("Enter");
    await advanceToOutputWithKeyboard(flow);
    await expect(flow.locator("[data-flow-output][data-state='done']")).toContainText("zero");
    await expect(stage).toHaveAttribute("data-phase", "completed");
  });
});

async function openBoundaryLesson(): Promise<Locator> {
  const entry = page.locator(`[data-tutorial-lesson-id='${BOUNDARY_LESSON.id}']`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  const stage = page.locator(".foa-semantic-stage");
  await expect(stage).toBeVisible();
  await stage.locator("[data-task-lesson-action='start']").click();
  return stage;
}

async function openInputWithKeyboard(stage: Locator): Promise<void> {
  const changeInput = stage.locator("[data-task-lesson-action='change-input']");
  await changeInput.focus();
  await page.keyboard.press("Enter");
  await expect(stage.locator("[data-task-lesson-dialog='input']")).toBeVisible();
}

async function submitInputWithKeyboard(stage: Locator, input: string): Promise<void> {
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  await expect(dialog).toBeVisible();
  const field = dialog.locator("[data-task-lesson-input='runtime-value']");
  await expect(field).toBeFocused();
  await field.fill(input);
  await field.press("Enter");
  await expect(dialog).toBeHidden();
}

async function moveForwardWithKeyboard(frame: Locator): Promise<void> {
  const previousId = await frame.getAttribute("data-frame-id");
  await frame.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frame.getAttribute("data-frame-id")).not.toBe(previousId);
}

async function advanceToOutputWithKeyboard(flow: Locator): Promise<void> {
  const frame = flow.locator("[data-flow-frame]");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await flow.locator("[data-flow-output][data-state='done']").count()) === 1) return;
    await moveForwardWithKeyboard(frame);
  }
  await expect(flow.locator("[data-flow-output][data-state='done']")).toHaveCount(1);
}

async function expectBranchEdges(flow: Locator, taken: readonly string[]): Promise<void> {
  for (const edgeId of BRANCH_EDGE_IDS) {
    await expect(flow.locator(`[data-flow-edge-id='${edgeId}']`)).toHaveAttribute(
      "data-state",
      taken.includes(edgeId) ? "taken" : "idle",
    );
  }
}

async function selectInterfaceLanguage(locale: "zh-CN" | "en"): Promise<void> {
  await page.evaluate((nextLocale) => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    if (language === null) throw new Error("Interface language control is unavailable");
    language.value = nextLocale;
    language.dispatchEvent(new Event("change", { bubbles: true }));
  }, locale);
}
