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

const SCREENSHOT_ROOT = join(tmpdir(), "algolatch-interactive-input-visual");
const CASES = [
  { order: 12, fields: { value: "3" }, output: "113.10" },
  { order: 14, fields: { left: "8", right: "3" }, output: "false" },
  {
    order: 28,
    fields: { count: "9", values: "9 8 7 6 5 4 3 2 1" },
    output: "9",
  },
  { order: 50, fields: { value: "invalid" }, output: "invalid" },
] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-visual-e2e-"));
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
  await page.locator("#tutorials-tab").click();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("four interactive input groups remain legible from dialog through completion", async () => {
  test.setTimeout(120_000);
  for (const runtimeCase of CASES) {
    await selectLesson(runtimeCase.order);
    const stage = page.locator(".foa-semantic-stage");
    await stage.locator("[data-task-lesson-action='start']").click();
    const dialog = stage.locator("[data-task-lesson-dialog='input']");
    await expect(dialog).toBeVisible();
    await dialog.screenshot({
      path: `${SCREENSHOT_ROOT}-${String(runtimeCase.order)}-dialog.png`,
    });
    expect(await measureDialog(dialog), `lesson ${String(runtimeCase.order)} dialog`).toMatchObject(
      {
        clipped: false,
        footerVisible: true,
      },
    );

    for (const [field, value] of Object.entries(runtimeCase.fields)) {
      await dialog.locator(`[data-task-lesson-input='${field}']`).fill(value);
    }
    await dialog.locator("[data-task-lesson-action='submit-input']").click();
    await expect(dialog).toBeHidden();

    const scene = stage.locator(".foa-semantic-scene");
    await expect(scene).toBeVisible();
    await scene.screenshot({
      path: `${SCREENSHOT_ROOT}-${String(runtimeCase.order)}-ready.png`,
    });
    expect
      .soft(await measureScene(scene), `lesson ${String(runtimeCase.order)} ready scene`)
      .toMatchObject({
        clippedText: [],
        nodeOverlaps: [],
        outsideEvidence: [],
        outsideNodes: [],
      });

    for (let index = 0; index < 4; index += 1) {
      await performRuntimeAction(scene);
      await expect(stage).toHaveAttribute("data-confirmed-events", String(index + 1));
    }
    await expect(stage).toHaveAttribute("data-phase", "completed");
    await stage.screenshot({
      path: `${SCREENSHOT_ROOT}-${String(runtimeCase.order)}-completed.png`,
    });
    expect
      .soft(
        await scene.isVisible(),
        `lesson ${String(runtimeCase.order)} keeps its completed path visible`,
      )
      .toBe(true);
    await expect(scene.locator(".foa-semantic-scene__run-status")).toHaveAttribute(
      "data-state",
      "completed",
    );
    await expect(scene.locator(".foa-semantic-scene__channels dd").nth(1)).toContainText(
      runtimeCase.output,
    );
    if (runtimeCase.order === 12) {
      await expect(scene).not.toContainText("33.51");
      await expect(stage.locator("[id^='teaching-source-status-']")).not.toContainText("33.51");
    }

    await stage.locator("[data-task-lesson-action='show-summary']").click();
    await expect(scene).toBeHidden();
    await expect(stage.locator(".library-task-lesson__completion")).toBeVisible();
    await expect(stage.locator(".foa-semantic-stage__completion-details")).toContainText(
      runtimeCase.output,
    );
    await stage.screenshot({
      path: `${SCREENSHOT_ROOT}-${String(runtimeCase.order)}-summary.png`,
    });
  }
});

test("interactive sequence lesson remains structured at a narrow tutorial width", async () => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await selectLesson(28);
  const stage = page.locator(".foa-semantic-stage");
  await stage.locator("[data-task-lesson-action='start']").click();
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  await dialog.locator("[data-task-lesson-input='count']").fill("9");
  await dialog.locator("[data-task-lesson-input='values']").fill("9 8 7 6 5 4 3 2 1");
  await dialog.locator("[data-task-lesson-action='submit-input']").click();
  await expect(dialog).toBeHidden();
  await constrainTutorialPanelWidth(720);

  const scene = stage.locator(".foa-semantic-scene");
  await stage.screenshot({ path: `${SCREENSHOT_ROOT}-28-narrow.png` });
  expect(await measureScene(scene)).toMatchObject({
    clippedText: [],
    nodeOverlaps: [],
    outsideEvidence: [],
    outsideNodes: [],
  });
  expect(await measureHeader(stage)).toMatchObject({
    actionsShareIdentityRow: true,
    progressBelowIdentity: true,
  });
  await expect(scene.locator(".foa-semantic-scene__channels dd").first()).toHaveAttribute(
    "title",
    /9 8 7 6 5 4 3 2 1/u,
  );
});

async function selectLesson(order: number): Promise<void> {
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
}

async function performRuntimeAction(scene: Locator): Promise<void> {
  const selectors = [
    ".foa-runtime-scene__branch-lane[data-compatible='true']:visible",
    ".foa-runtime-scene__memory-link[data-compatible='true']:visible",
    ".foa-runtime-scene__stack-action[data-compatible='true']:visible",
    ".foa-runtime-scene__value-choice[data-compatible='true']:visible",
    ".foa-runtime-scene__action-target:visible",
  ];
  for (const selector of selectors) {
    const target = scene.locator(selector).first();
    if ((await target.count()) > 0 && (await target.isEnabled())) {
      await target.click();
      return;
    }
  }
  throw new Error("FOA runtime scene has no operable course-specific action");
}

async function constrainTutorialPanelWidth(width: number): Promise<void> {
  await page.evaluate((panelWidth) => {
    const module = document.querySelector<HTMLElement>(".tutorials-module");
    if (module === null) throw new Error("Tutorial module is unavailable");
    const catalogWidth = 272;
    module.style.width = `${String(catalogWidth + panelWidth)}px`;
    module.style.maxWidth = "none";
    module.style.gridTemplateColumns = `${String(catalogWidth)}px ${String(panelWidth)}px`;
    module.style.justifySelf = "start";
  }, width);
  await expect
    .poll(() =>
      page
        .locator(".tutorials-module__stage-host")
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    )
    .toBe(width);
}

async function measureHeader(stage: Locator): Promise<{
  readonly actionsShareIdentityRow: boolean;
  readonly progressBelowIdentity: boolean;
}> {
  return stage.evaluate((root) => {
    const identity = root.querySelector<HTMLElement>(".foa-semantic-stage__identity");
    const actions = root.querySelector<HTMLElement>(".library-task-stage__header-actions");
    const progress = root.querySelector<HTMLElement>(".library-task-stage__progress");
    if (identity === null || actions === null || progress === null) {
      throw new Error("Semantic stage header is incomplete");
    }
    const identityBounds = identity.getBoundingClientRect();
    const actionBounds = actions.getBoundingClientRect();
    const progressBounds = progress.getBoundingClientRect();
    return {
      actionsShareIdentityRow: Math.abs(identityBounds.top - actionBounds.top) <= 1,
      progressBelowIdentity:
        Boolean(progress.hidden) ||
        progressBounds.height === 0 ||
        progressBounds.top >= identityBounds.bottom - 1,
    };
  });
}

async function measureDialog(dialog: Locator): Promise<{
  readonly clipped: boolean;
  readonly footerVisible: boolean;
}> {
  return dialog.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const footer = root.querySelector("footer");
    const footerBounds = footer?.getBoundingClientRect() ?? null;
    return {
      clipped:
        bounds.left < 0 ||
        bounds.top < 0 ||
        bounds.right > window.innerWidth ||
        bounds.bottom > window.innerHeight,
      footerVisible:
        footerBounds !== null &&
        footerBounds.top >= bounds.top &&
        footerBounds.bottom <= Math.min(bounds.bottom, window.innerHeight),
    };
  });
}

async function measureScene(scene: Locator): Promise<{
  readonly clippedText: readonly string[];
  readonly nodeOverlaps: readonly string[];
  readonly outsideEvidence: readonly string[];
  readonly outsideNodes: readonly string[];
}> {
  return scene.evaluate((root) => {
    const diagram = root.querySelector<HTMLElement>(".foa-semantic-scene__diagram");
    const evidence = root.querySelector<HTMLElement>(".foa-semantic-scene__evidence");
    if (diagram === null || evidence === null) throw new Error("Semantic scene is incomplete");
    const diagramBounds = diagram.getBoundingClientRect();
    const evidenceBounds = evidence.getBoundingClientRect();
    const nodes = [...root.querySelectorAll<HTMLElement>(".foa-semantic-scene__node")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element, index) => ({
        bounds: element.getBoundingClientRect(),
        id: element.dataset.sceneSlot ?? String(index),
      }));
    const intersection = (left: DOMRect, right: DOMRect): boolean =>
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
      Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
    const nodeOverlaps: string[] = [];
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        if (intersection(nodes[left]!.bounds, nodes[right]!.bounds)) {
          nodeOverlaps.push(`${nodes[left]!.id}/${nodes[right]!.id}`);
        }
      }
    }
    const clippedText = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-semantic-scene__node strong, .foa-semantic-scene__node-status, .foa-semantic-scene__node-detail",
      ),
    ]
      .filter((element) => !element.hidden)
      .filter(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1,
      )
      .map((element) => element.textContent?.trim() || element.className);
    return {
      clippedText,
      nodeOverlaps,
      outsideEvidence: [...evidence.children]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .filter((element) => getComputedStyle(element).display !== "none")
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left < evidenceBounds.left - 1 ||
            bounds.right > evidenceBounds.right + 1 ||
            bounds.top < evidenceBounds.top - 1 ||
            bounds.bottom > evidenceBounds.bottom + 1
          );
        })
        .map((element) => element.className || element.tagName.toLowerCase()),
      outsideNodes: nodes
        .filter(
          (node) =>
            node.bounds.left < diagramBounds.left - 1 ||
            node.bounds.right > diagramBounds.right + 1 ||
            node.bounds.top < diagramBounds.top - 1 ||
            node.bounds.bottom > diagramBounds.bottom + 1,
        )
        .map((node) => node.id),
    };
  });
}
