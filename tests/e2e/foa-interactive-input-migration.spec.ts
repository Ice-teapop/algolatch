import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";
import {
  defaultFoaInteractiveRun,
  FOA_INTERACTIVE_INPUT_ORDERS,
  getFoaInteractiveInputDefinition,
} from "../../src/tutorials/foa-interactive-inputs.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-interactive-input-e2e-"));
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
  await page.emulateMedia({ reducedMotion: "reduce" });
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

test("opens a real learner-input contract for all 23 migrated lessons", async () => {
  test.setTimeout(120_000);
  for (const order of FOA_INTERACTIVE_INPUT_ORDERS) {
    const definition = getFoaInteractiveInputDefinition(order)!;
    const expectedRun = defaultFoaInteractiveRun(definition);
    await selectLesson(order);
    const stage = page.locator(".foa-semantic-stage");
    await stage.locator("[data-task-lesson-action='start']").click();
    const dialog = stage.locator("[data-task-lesson-dialog='input']");
    await expect(dialog, `lesson ${String(order)} input`).toBeVisible();
    await expect(dialog).toHaveAttribute("data-interactive-input-group", definition.group);
    await dialog.locator("[data-task-lesson-action='submit-input']").click();
    await expect(dialog).toBeHidden();
    await expect(stage).toHaveAttribute("data-run-state", "ready");
    await expect(stage.locator(".foa-semantic-scene")).toHaveAttribute(
      "data-case-mode",
      "interactive",
    );
    await expect(stage.locator(".foa-semantic-scene__channels dd").first()).toContainText(
      expectedRun.stdin.trim().split(/\s+/u)[0]!,
    );
    await expect(stage.locator("[data-task-lesson-action='change-input']")).toBeVisible();
  }
});

test("uses changed single, pair, sequence, and special inputs as visible runtime evidence", async () => {
  test.setTimeout(90_000);
  const cases = [
    { order: 12, values: { value: "3" }, output: "113.10" },
    { order: 14, values: { left: "8", right: "3" }, output: "false" },
    { order: 28, values: { count: "3", values: "-5 -2 -9" }, output: "-2" },
    { order: 50, values: { value: "invalid" }, output: "invalid" },
  ] as const;

  for (const runtimeCase of cases) {
    await selectLesson(runtimeCase.order);
    const stage = page.locator(".foa-semantic-stage");
    await stage.locator("[data-task-lesson-action='start']").click();
    const dialog = stage.locator("[data-task-lesson-dialog='input']");
    for (const [field, value] of Object.entries(runtimeCase.values)) {
      await dialog.locator(`[data-task-lesson-input="${field}"]`).fill(value);
    }
    await dialog.locator("[data-task-lesson-action='submit-input']").click();
    await expect(dialog).toBeHidden();

    const scene = stage.locator(".foa-semantic-scene");
    await expect(scene.locator(".foa-semantic-scene__channels dd").nth(1)).toHaveText("完成后显示");
    await performSceneAction(scene);
    await expect(stage).toHaveAttribute("data-run-state", "running");
    await expect(
      scene.locator(".foa-semantic-scene__node[data-state='done']").first(),
    ).not.toHaveText(/^(已执行|Executed)$/u);

    for (let index = 1; index < 4; index += 1) {
      await expect(stage).toHaveAttribute("data-run-state", "paused");
      await performSceneAction(scene);
    }
    await expect(stage).toHaveAttribute("data-phase", "completed");
    await expect(stage.locator(".foa-semantic-stage__completion-details")).toContainText(
      runtimeCase.output,
    );
  }
});

test("changing input clears old completion and path evidence before the next run", async () => {
  await selectLesson(9);
  const stage = page.locator(".foa-semantic-stage");
  await stage.locator("[data-task-lesson-action='start']").click();
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  await dialog.locator("[data-task-lesson-input='value']").fill("41");
  await dialog.locator("[data-task-lesson-action='submit-input']").click();
  const scene = stage.locator(".foa-semantic-scene");
  await performSceneAction(scene);
  await expect(stage).toHaveAttribute("data-confirmed-events", "1");

  await scene.locator("[data-task-lesson-action='change-input']").click();
  await dialog.locator("[data-task-lesson-input='value']").fill("abc");
  await dialog.locator("[data-task-lesson-action='submit-input']").click();
  await expect(stage).toHaveAttribute("data-confirmed-events", "0");
  await expect(stage).toHaveAttribute("data-run-state", "ready");
  await expect(scene.locator(".foa-semantic-scene__channels dd").first()).toContainText("abc");
  await expect(scene.locator(".foa-semantic-scene__channels dd").nth(1)).toHaveText("完成后显示");
  await expect(scene.locator(".foa-semantic-scene__node[data-state='done']")).toHaveCount(0);
});

async function selectLesson(order: number): Promise<void> {
  const lesson = FOA_LESSONS[order - 1]!;
  const catalogToggle = page.locator("[data-tutorials-action='toggle-catalog']");
  if ((await catalogToggle.getAttribute("aria-expanded")) === "false") {
    await catalogToggle.click();
  }
  const entry = page.locator(`[data-tutorial-lesson-id="${lesson.id}"]`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
}

async function performSceneAction(scene: import("@playwright/test").Locator): Promise<void> {
  const selectors = [
    ".foa-runtime-scene__branch-lane[data-compatible='true']:visible",
    ".foa-runtime-scene__memory-link[data-compatible='true']:visible",
    ".foa-runtime-scene__stack-action[data-compatible='true']:visible",
    ".foa-runtime-scene__value-choice[data-compatible='true']:visible",
    ".foa-runtime-scene__action-target:visible",
    ".foa-semantic-scene__node[data-state='active']:visible",
  ];
  for (const selector of selectors) {
    const target = scene.locator(selector).first();
    if ((await target.count()) > 0 && (await target.isEnabled())) {
      await target.click();
      return;
    }
  }
  throw new Error("FOA scene has no operable current action");
}
