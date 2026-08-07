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
import { getFoaSceneProfile } from "../../src/tutorials/foa-scene-profiles.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";
const runtimeErrors: string[] = [];

const TIERS = [
  { name: "900x650", width: 900, height: 650, zoom: 1 },
  { name: "900x650-real-150", width: 900, height: 650, zoom: 1.5 },
] as const;

const ALTERNATE_INPUTS = new Map<number, Readonly<Record<string, string>>>([
  [50, { value: "bad-token" }],
  [52, { count: "2", values: "4 6" }],
  [59, { value: "6" }],
]);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-41-60-gate-"));
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // Deliberately launch the built renderer. This gate must not share a Vite port with another run.
  delete inheritedEnvironment.VITE_DEV_SERVER_URL;
  application = await electron.launch({
    args: [".", `--user-data-dir=${e2eProfileRoot}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("courses 41-60 keep input, mechanism and source evidence isolated at both viewport tiers", async () => {
  test.setTimeout(300_000);

  for (const tier of TIERS) {
    await setViewportTier(tier.width, tier.height, tier.zoom);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(viewport.width, tier.name).toBeLessThanOrEqual(Math.ceil(tier.width / tier.zoom) + 2);
    expect(viewport.height, tier.name).toBeLessThanOrEqual(Math.ceil(tier.height / tier.zoom) + 2);

    for (let order = 41; order <= 60; order += 1) {
      await test.step(`${tier.name} · course ${String(order)}`, async () => {
        await selectLesson(order);
        if (order === 60) {
          await auditInsertionSortCourse(tier.name);
          return;
        }
        await openSemanticCourse(order);
        const stage = page.locator(".foa-semantic-stage");
        const report = await auditSemanticStage(stage);
        expect(report.documentOverflow, report.label).toEqual({ x: 0, y: 0 });
        expect(
          report.stageOverflow,
          `${report.label} ${JSON.stringify(report.stageMetrics)} ${JSON.stringify(report.stageChildren)}`,
        ).toEqual({
          x: 0,
          y: 0,
        });
        expect(report.moduleCollisions, report.label).toEqual([]);
        expect(report.textCollisions, report.label).toEqual([]);
        expect(report.textOverflows, report.label).toEqual([]);
        expect(report.catalogOverflow).toMatch(/auto|scroll/u);
        expect(report.mechanismOverflow).toMatch(/auto|scroll/u);
        expect(report.sourceOverflow).toMatch(/auto|scroll/u);
        expect(report.rootScrollAfterRailProbe, report.label).toEqual(
          report.rootScrollBeforeRailProbe,
        );
      });
    }
  }
});

test("courses 50, 52 and 59 rebuild the visible runtime mechanism from alternate input", async () => {
  test.setTimeout(90_000);
  await setViewportTier(900, 650, 1);

  for (const [order, fields] of ALTERNATE_INPUTS) {
    await selectLesson(order);
    await openSemanticCourse(order, fields);
    const scene = page.locator(".foa-runtime-scene");
    const visibleInput = await scene
      .locator(".foa-semantic-scene__channels dd")
      .first()
      .innerText();
    const mechanismText = await scene.locator(".foa-runtime-scene__mechanism").innerText();

    for (const value of Object.values(fields)) {
      for (const token of value.split(/\s+/u)) {
        if (order === 50 || token === fields.count) continue;
        expect(
          `${visibleInput}\n${mechanismText}`,
          `course ${String(order)} token ${token}`,
        ).toContain(token);
      }
    }
    if (order === 50) {
      expect(visibleInput).toContain("bad-token");
      expect(mechanismText).toContain("bad-token");
      expect(mechanismText).not.toMatch(/\b11\b/u);
    }
    if (order === 52) {
      expect(visibleInput).toContain("2 4 6");
      expect(mechanismText).not.toContain("9 8 7");
    }
    if (order === 59) {
      expect(visibleInput).toContain("6");
      expect(mechanismText).toContain("6");
      expect(mechanismText).not.toMatch(/输入索引\s*3/u);
    }
  }
});

test("switching courses while a runtime animation settles never touches a destroyed scene", async () => {
  test.setTimeout(60_000);
  await setViewportTier(900, 650, 1);
  runtimeErrors.splice(0);
  await selectLesson(41);
  await openSemanticCourse(41);
  const scene = page.locator(".foa-runtime-scene");
  const action = scene
    .locator(
      ".foa-runtime-scene__stack-action[data-compatible='true']:visible, .foa-runtime-scene__action-target:visible",
    )
    .first();
  await action.click();
  const moduleStage = page.locator(".tutorials-module__stage");
  const primedScroll = await moduleStage.evaluate((element) => {
    const stage = element as HTMLElement;
    const host = stage.querySelector<HTMLElement>(".tutorials-module__stage-host");
    if (host === null) throw new Error("Tutorial stage host is missing");
    host.style.width = "calc(100% + 80px)";
    host.style.height = "calc(100% + 80px)";
    stage.scrollTop = 40;
    stage.scrollLeft = 40;
    return { top: stage.scrollTop, left: stage.scrollLeft };
  });
  expect(primedScroll.top).toBeGreaterThan(0);
  expect(primedScroll.left).toBeGreaterThan(0);
  await selectLesson(42);
  await page.waitForTimeout(700);
  const resetScroll = await moduleStage.evaluate((element) => {
    const stage = element as HTMLElement;
    const host = stage.querySelector<HTMLElement>(".tutorials-module__stage-host");
    if (host === null) throw new Error("Tutorial stage host is missing");
    const result = { top: stage.scrollTop, left: stage.scrollLeft };
    host.style.width = "";
    host.style.height = "";
    return result;
  });
  expect(resetScroll).toEqual({ top: 0, left: 0 });
  expect(runtimeErrors.filter((message) => /destroyed|FOA semantic scene/iu.test(message))).toEqual(
    [],
  );
});

async function setViewportTier(width: number, height: number, zoom: number): Promise<void> {
  if (application === undefined) throw new Error("Electron is unavailable");
  await application.evaluate(
    ({ BrowserWindow }, value) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Main window is unavailable");
      window.webContents.setZoomFactor(value.zoom);
      window.setContentSize(value.width, value.height);
    },
    { width, height, zoom },
  );
  await page.waitForTimeout(120);
}

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
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
}

async function openSemanticCourse(
  order: number,
  fields: Readonly<Record<string, string>> | null = null,
): Promise<void> {
  const stage = page.locator(".foa-semantic-stage");
  await expect(stage).toBeVisible();
  await stage.locator("[data-task-lesson-action='start']").click();
  await expect(stage).toHaveAttribute("data-phase", "task");
  const profile = getFoaSceneProfile(FOA_LESSONS[order - 1]!);
  if (profile.caseMode !== "interactive") return;
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  await expect(dialog).toBeVisible();
  for (const [field, value] of Object.entries(fields ?? {})) {
    await dialog.locator(`[data-task-lesson-input='${field}']`).fill(value);
  }
  const dialogReport = await dialog.evaluate((element) => {
    const root = element as HTMLElement;
    const surface = root.querySelector<HTMLElement>(".foa-flow-input-dialog__surface");
    const bounds = root.getBoundingClientRect();
    return {
      contained:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= innerWidth + 1 &&
        bounds.bottom <= innerHeight + 1,
      overflow: surface === null ? "missing" : getComputedStyle(surface).overflowY,
    };
  });
  expect(dialogReport.contained, `course ${String(order)} input dialog`).toBe(true);
  expect(dialogReport.overflow, `course ${String(order)} input dialog`).toMatch(/auto|scroll/u);
  await dialog.locator("[data-task-lesson-action='submit-input']").click();
  await expect(dialog).toBeHidden();
}

async function auditInsertionSortCourse(tier: string): Promise<void> {
  const stage = page.locator(".library-task-lesson--v2");
  await expect(stage).toBeVisible();
  await stage.locator("[data-task-lesson-action='start']").click();
  await expect(stage.locator(".library-task-stage__board")).toBeVisible();
  const report = await stage.evaluate((element) => {
    const root = element as HTMLElement;
    const board = root.querySelector<HTMLElement>(".library-task-stage__board");
    const side = root.querySelector<HTMLElement>(".library-task-stage__side");
    const source = root.querySelector<HTMLElement>(".teaching-source-view pre");
    if (board === null || side === null || source === null) {
      throw new Error("Insertion-sort modules are incomplete");
    }
    return {
      root: { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight },
      boardOverflow: getComputedStyle(board).overflowY,
      sideOverflow: getComputedStyle(side).overflowY,
      sourceOverflow: getComputedStyle(source).overflowY,
    };
  });
  expect(report.root, tier).toEqual({ x: 0, y: 0 });
  expect(report.boardOverflow, tier).toMatch(/auto|scroll/u);
  expect(report.sourceOverflow, tier).toMatch(/auto|scroll/u);
}

async function auditSemanticStage(stage: Locator): Promise<{
  readonly label: string;
  readonly documentOverflow: { readonly x: number; readonly y: number };
  readonly stageOverflow: { readonly x: number; readonly y: number };
  readonly stageMetrics: Readonly<Record<string, number>>;
  readonly stageChildren: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly moduleCollisions: readonly string[];
  readonly textCollisions: readonly string[];
  readonly textOverflows: readonly string[];
  readonly catalogOverflow: string;
  readonly mechanismOverflow: string;
  readonly sourceOverflow: string;
  readonly rootScrollBeforeRailProbe: { readonly top: number; readonly left: number };
  readonly rootScrollAfterRailProbe: { readonly top: number; readonly left: number };
}> {
  return stage.evaluate((element) => {
    const root = element as HTMLElement;
    const lessonOrder = root.dataset.lessonOrder ?? "unknown";
    const catalog = document.querySelector<HTMLElement>(".tutorials-module__lesson-list");
    const mechanism = root.querySelector<HTMLElement>(
      ".foa-runtime-scene__mechanism, .foa-semantic-scene__diagram",
    );
    const source = root.querySelector<HTMLElement>(".teaching-source-view pre");
    const primary = root.querySelector<HTMLElement>(".foa-semantic-stage__primary");
    if (catalog === null || mechanism === null || source === null || primary === null) {
      throw new Error(`course ${lessonOrder} module ownership is incomplete`);
    }
    const visible = (candidate: Element): candidate is HTMLElement => {
      if (!(candidate instanceof HTMLElement) || candidate.hidden) return false;
      const style = getComputedStyle(candidate);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        candidate.getClientRects().length > 0
      );
    };
    const intersectionArea = (left: DOMRect, right: DOMRect): number => {
      const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      return width > 0 && height > 0 ? width * height : 0;
    };
    const moduleSelectors = [
      ".foa-semantic-stage__workspace",
      ".library-task-stage__controls",
      ".foa-semantic-stage__source-splitter",
      ".teaching-source-view",
    ];
    const modules = moduleSelectors
      .map((selector) => primary.querySelector<HTMLElement>(`:scope > ${selector}`))
      .filter((candidate): candidate is HTMLElement => candidate !== null && visible(candidate));
    const moduleCollisions: string[] = [];
    for (let left = 0; left < modules.length; left += 1) {
      for (let right = left + 1; right < modules.length; right += 1) {
        if (
          intersectionArea(
            modules[left]!.getBoundingClientRect(),
            modules[right]!.getBoundingClientRect(),
          ) > 1
        ) {
          moduleCollisions.push(`${modules[left]!.className}/${modules[right]!.className}`);
        }
      }
    }
    const textCollisions: string[] = [];
    const collisionGroups = [
      ".foa-semantic-scene__evidence",
      ".foa-runtime-scene__header",
      ".foa-runtime-scene__frame",
      ".foa-runtime-scene__branch",
      ".foa-runtime-scene__stack",
      ".foa-runtime-scene__memory",
    ];
    for (const selector of collisionGroups) {
      const group = root.querySelector<HTMLElement>(selector);
      if (group === null || !visible(group)) continue;
      const children = [...group.children].filter(visible);
      for (let left = 0; left < children.length; left += 1) {
        for (let right = left + 1; right < children.length; right += 1) {
          if (
            intersectionArea(
              children[left]!.getBoundingClientRect(),
              children[right]!.getBoundingClientRect(),
            ) > 2
          ) {
            textCollisions.push(`${selector}:${String(left)}/${String(right)}`);
          }
        }
      }
    }
    const textOverflows = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-runtime-scene__model, .foa-runtime-scene__primary-action, .foa-runtime-scene__frame-title, .foa-runtime-scene__frame-detail, .foa-runtime-scene__memory-relation, .foa-runtime-scene__history-item strong, .foa-semantic-scene__node strong, .foa-semantic-scene__node-detail, .foa-semantic-scene__node-status, .foa-pointer-alias-scene__entity strong, .foa-pointer-alias-scene__status",
      ),
    ]
      .filter(visible)
      .filter((candidate) => candidate.scrollWidth - candidate.clientWidth > 1)
      .map((candidate) => candidate.className);
    const rootScrollBeforeRailProbe = { top: root.scrollTop, left: root.scrollLeft };
    catalog.scrollTop = Math.min(30, Math.max(0, catalog.scrollHeight - catalog.clientHeight));
    mechanism.scrollTop = Math.min(
      30,
      Math.max(0, mechanism.scrollHeight - mechanism.clientHeight),
    );
    source.scrollTop = Math.min(30, Math.max(0, source.scrollHeight - source.clientHeight));
    const rootScrollAfterRailProbe = { top: root.scrollTop, left: root.scrollLeft };
    return {
      label: `course ${lessonOrder} @ ${String(innerWidth)}x${String(innerHeight)}`,
      documentOverflow: {
        x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        y: Math.max(
          0,
          document.documentElement.scrollHeight - document.documentElement.clientHeight,
        ),
      },
      stageOverflow: {
        x: Math.max(0, root.scrollWidth - root.clientWidth),
        y: Math.max(0, root.scrollHeight - root.clientHeight),
      },
      stageMetrics: {
        rootClientHeight: root.clientHeight,
        rootScrollHeight: root.scrollHeight,
        rootOffsetHeight: root.offsetHeight,
        rootPaddingTop: Number.parseFloat(getComputedStyle(root).paddingTop),
        rootBorderTop: Number.parseFloat(getComputedStyle(root).borderTopWidth),
        taskClientHeight:
          root.querySelector<HTMLElement>(".foa-semantic-stage__task")?.clientHeight ?? -1,
        taskScrollHeight:
          root.querySelector<HTMLElement>(".foa-semantic-stage__task")?.scrollHeight ?? -1,
        mainClientHeight:
          root.querySelector<HTMLElement>(".foa-semantic-stage__main")?.clientHeight ?? -1,
        mainScrollHeight:
          root.querySelector<HTMLElement>(".foa-semantic-stage__main")?.scrollHeight ?? -1,
        primaryClientHeight: primary.clientHeight,
        primaryScrollHeight: primary.scrollHeight,
      },
      stageChildren: [...root.children].map((child) => {
        const candidate = child as HTMLElement;
        const bounds = candidate.getBoundingClientRect();
        const rootBounds = root.getBoundingClientRect();
        return {
          className: candidate.className,
          hidden: candidate.hidden,
          top: Math.round(bounds.top - rootBounds.top),
          bottom: Math.round(bounds.bottom - rootBounds.top),
          clientHeight: candidate.clientHeight,
          scrollHeight: candidate.scrollHeight,
          position: getComputedStyle(candidate).position,
          overflow: getComputedStyle(candidate).overflow,
          marginTop: getComputedStyle(candidate).marginTop,
          transform: getComputedStyle(candidate).transform,
        };
      }),
      moduleCollisions,
      textCollisions,
      textOverflows,
      catalogOverflow: getComputedStyle(catalog).overflowY,
      mechanismOverflow: getComputedStyle(mechanism).overflowY,
      sourceOverflow: getComputedStyle(source).overflowY,
      rootScrollBeforeRailProbe,
      rootScrollAfterRailProbe,
    };
  });
}
