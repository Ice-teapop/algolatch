import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FoaLessonDefinition } from "../../src/tutorials/foa-contracts.js";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";
import { showSourceEditor } from "./support/c-cell-layout.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";
let currentZoom = 1;
const runtimeErrors: string[] = [];

const auditGroup = process.env.FOA_AUDIT_GROUP ?? "all";
const groupedLessons =
  auditGroup === "blocks"
    ? FOA_LESSONS.slice(80, 105)
    : auditGroup === "workspaces"
      ? FOA_LESSONS.slice(105, 120)
      : FOA_LESSONS.slice(80, 120);
const requestedOrders = new Set(
  (process.env.FOA_AUDIT_ORDERS ?? "")
    .split(",")
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isInteger),
);
const LATE_LESSONS =
  requestedOrders.size === 0
    ? groupedLessons
    : groupedLessons.filter((lesson) => requestedOrders.has(lesson.order));
const MATRIX = [
  { id: "900x650-z100", zoom: 1 },
  { id: "900x650-z150", zoom: 1.5 },
] as const;
const SCREENSHOT_ORDERS = new Set([81, 90, 91, 105, 106, 120]);

interface GeometryReport {
  readonly order: number;
  readonly mode: string;
  readonly documentHorizontalOverflow: number;
  readonly documentVerticalOverflow: number;
  readonly rootHorizontalOverflow: number;
  readonly rootVerticalOverflow: number;
  readonly catalogOverflowY: string;
  readonly stageOverflowX: string;
  readonly stageOverflowY: string;
  readonly stageHorizontalOverflow: number;
  readonly stageVerticalOverflow: number;
  readonly collisions: readonly string[];
  readonly clippedText: readonly string[];
  readonly outsideStage: readonly string[];
  readonly scrollRails: Readonly<Record<string, string | number | boolean>>;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-late-audit-"));
  await launchApplication();
});

async function launchApplication(): Promise<void> {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "VITE_DEV_SERVER_URL" && entry[1] !== undefined,
    ),
  );
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
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await setZoomFactor(currentZoom);
}

test.afterAll(async () => {
  await setZoomFactor(1).catch(() => undefined);
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("courses 81-120 remain operable and visually bounded at 100% and 150%", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const failures: string[] = [];
  runtimeErrors.length = 0;

  for (const matrixCase of MATRIX) {
    currentZoom = matrixCase.zoom;
    await setZoomFactor(matrixCase.zoom);
    await page.setViewportSize({ width: 900, height: 650 });
    await openTutorials();
    await verifyCatalogRail(matrixCase.id, failures);

    for (const lesson of LATE_LESSONS) {
      await test.step(`${matrixCase.id} · course ${String(lesson.order)}`, async () => {
        try {
          await selectLesson(lesson);
          await expectCurrentLessonToStartAtIntro(lesson);
          await startLesson(lesson);
          await verifyTaskMeaning(lesson, matrixCase.id, failures);

          const report = await collectGeometry(lesson);
          recordGeometryFailures(matrixCase.id, report, failures);

          if (SCREENSHOT_ORDERS.has(lesson.order)) {
            await page.screenshot({
              path: testInfo.outputPath(`${matrixCase.id}-course-${String(lesson.order)}.png`),
              animations: "disabled",
            });
          }

          await performLessonAction(lesson);
          await verifyPostActionState(lesson, matrixCase.id, failures);
        } catch (error) {
          failures.push(
            `${matrixCase.id} course ${String(lesson.order)} interaction: ${errorMessage(error)}`,
          );
          await attachFailureScreenshot(testInfo, matrixCase.id, lesson.order);
          await openTutorials().catch(() => undefined);
        }
      });
    }

    if (LATE_LESSONS.some((lesson) => lesson.mode !== "workspace-evidence")) {
      await verifyLessonSwitchResets(matrixCase.id, failures);
    }
  }

  expect(runtimeErrors, "renderer console/page errors").toEqual([]);
  expect(failures, "late-course visual and interaction audit").toEqual([]);
});

async function openTutorials(): Promise<void> {
  // A workspace lesson focus deliberately disables the page tabs, so a lesson launched by an
  // earlier course has to be exited before the Tutorials page can be reached again.
  const exit = page.locator("#workspace-lesson-exit");
  if (await exit.isVisible()) {
    await exit.click();
    await expect(page.locator("#workspace-lesson-strip")).toBeHidden();
  }
  await page.locator("#tutorials-tab").click({ timeout: 5_000 });
  await expect(page.locator("#tutorials-panel")).toBeVisible();
}

async function selectLesson(lesson: FoaLessonDefinition): Promise<void> {
  await openTutorials();
  const catalogToggle = page.locator("[data-tutorials-action='toggle-catalog']");
  if ((await catalogToggle.getAttribute("aria-expanded")) === "false") {
    await catalogToggle.click();
  }
  const entry = lessonEntry(lesson.id);
  if (!(await entry.isVisible())) {
    const chapter = entry.locator("xpath=ancestor::details[1]");
    await chapter.locator(":scope > summary").click();
  }
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".tutorials-module")).toHaveAttribute(
    "data-selected-lesson-id",
    lesson.id,
  );
}

function lessonEntry(lessonId: string): Locator {
  return page.locator(`[data-tutorial-lesson-id="${lessonId}"]`);
}

async function expectCurrentLessonToStartAtIntro(lesson: FoaLessonDefinition): Promise<void> {
  const root = stageFor(lesson);
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute("data-phase", "intro");
  await expect(root.locator("[data-task-lesson-action='start']")).toBeVisible();
}

async function startLesson(lesson: FoaLessonDefinition): Promise<void> {
  const root = stageFor(lesson);
  await root.locator("[data-task-lesson-action='start']").click();
  await expect(root).toHaveAttribute("data-phase", "task");
}

function stageFor(lesson: FoaLessonDefinition): Locator {
  return page.locator(
    lesson.mode === "workspace-evidence" ? ".foa-task-lesson" : ".foa-block-stage",
  );
}

async function verifyTaskMeaning(
  lesson: FoaLessonDefinition,
  matrixId: string,
  failures: string[],
): Promise<void> {
  const root = stageFor(lesson);
  const instruction =
    lesson.mode === "workspace-evidence"
      ? root.locator(".library-task-stage__prompt > p")
      : root.locator(".foa-block-stage__instruction");
  const actual = normalize(await instruction.textContent());
  const expected = normalize(lesson.experience.primaryAction.zh);
  if (actual !== expected) {
    failures.push(
      `${matrixId} course ${String(lesson.order)} task mismatch: expected ${expected}; got ${actual}`,
    );
  }
}

async function performLessonAction(lesson: FoaLessonDefinition): Promise<void> {
  if (lesson.mode === "block-complete") {
    const stage = stageFor(lesson);
    const targetId = await stage
      .locator("[data-task-lesson-action='block-gap'] [data-block-role='sequence']")
      .getAttribute("data-foa-block-event-id");
    if (targetId === null) throw new Error("gap target is missing");
    const candidates = stage.locator("[data-block-role='candidate']");
    const candidateCount = await candidates.count();
    for (let index = 0; index < candidateCount; index += 1) {
      if ((await candidates.nth(index).getAttribute("data-foa-block-event-id")) === targetId) {
        await candidates.nth(index).click();
        return;
      }
    }
    throw new Error(`compatible gap candidate ${targetId} is missing`);
  }

  if (lesson.mode === "block-compose") {
    const firstId = lesson.semanticEvents[0]?.id;
    if (firstId === undefined) throw new Error("composition has no first event");
    const first = stageFor(lesson).locator(
      `[data-block-role='sequence'][data-foa-block-event-id="${firstId}"]`,
    );
    await first.focus();
    await first.press("Home");
    await stageFor(lesson).locator("[data-task-lesson-action='verify-composition']").click();
    return;
  }

  if (lesson.mode === "workspace-evidence") {
    await stageFor(lesson).locator("[data-task-lesson-action='open-workspace']").click();
    await expect(page.locator("#build-panel")).toBeVisible();
    // The workspace opens on the C Cell prompt; the project source editor is a tab away.
    await showSourceEditor(page);
    await restartApplicationAfterWorkspace();
    return;
  }

  throw new Error(`unexpected late-course mode ${lesson.mode}`);
}

async function verifyPostActionState(
  lesson: FoaLessonDefinition,
  matrixId: string,
  failures: string[],
): Promise<void> {
  if (lesson.mode === "workspace-evidence") return;
  const phase = await stageFor(lesson).getAttribute("data-phase");
  if (phase !== "completed") {
    failures.push(`${matrixId} course ${String(lesson.order)} did not complete; phase=${phase}`);
  }
}

async function collectGeometry(lesson: FoaLessonDefinition): Promise<GeometryReport> {
  const root = stageFor(lesson);
  return root.evaluate(
    (stageRoot, meta) => {
      const tutorials = required(document, ".tutorials-module");
      const catalog = required(document, ".tutorials-module__lesson-list");
      const outerStage = required(document, ".tutorials-module__stage");
      const scrolling = document.scrollingElement;
      if (scrolling === null) throw new Error("document scrolling element is missing");

      const collisionContainers =
        meta.mode === "workspace-evidence"
          ? [
              ".library-task-stage__header",
              ".library-task-stage__prompt",
              ".foa-task-lesson__board",
              ".foa-task-lesson__interaction",
              ".teaching-source-view > header",
            ]
          : [
              ".foa-block-stage__header",
              ".foa-block-stage__source-header",
              ".foa-block-stage__candidate-section",
              ".foa-block-stage__gap",
              ".foa-block-stage__block",
            ];
      const collisions = collisionContainers.flatMap((selector) =>
        [...stageRoot.querySelectorAll<HTMLElement>(selector)].flatMap((container, index) =>
          siblingCollisions(container).map((pair) => `${selector}[${String(index)}]:${pair}`),
        ),
      );

      const textSelectors =
        meta.mode === "workspace-evidence"
          ? [
              ".library-task-stage__identity strong",
              ".library-task-stage__prompt > p",
              ".foa-task-lesson__interaction > strong",
              ".foa-task-lesson__interaction > p",
              ".teaching-source-view > header strong",
              ".teaching-source-view > header span",
              ".button",
            ]
          : [
              ".foa-block-stage__header > strong",
              ".foa-block-stage__instruction",
              ".foa-block-stage__block-meta",
              ".foa-block-stage__block-code",
              ".foa-block-stage__source-header > strong",
              ".foa-block-stage__source-actions > *",
              ".button",
            ];
      const clippedText = textSelectors.flatMap((selector) =>
        [...stageRoot.querySelectorAll<HTMLElement>(selector)]
          .filter(isVisible)
          .filter((element) => {
            const style = getComputedStyle(element);
            const ownsHorizontalScroll = ["auto", "scroll"].includes(style.overflowX);
            const ownsVerticalScroll = ["auto", "scroll"].includes(style.overflowY);
            return (
              (!ownsHorizontalScroll && element.scrollWidth > element.clientWidth + 2) ||
              (!ownsVerticalScroll && element.scrollHeight > element.clientHeight + 2)
            );
          })
          .map((element, index) => `${selector}[${String(index)}]:${shortText(element)}`),
      );

      const stageBounds = stageRoot.getBoundingClientRect();
      const outsideStage = [
        ...stageRoot.querySelectorAll<HTMLElement>(
          meta.mode === "workspace-evidence"
            ? ".library-task-stage__header, .library-task-stage__main, .library-task-stage__prompt, .foa-task-lesson__board"
            : ".foa-block-stage__header, .foa-block-stage__workspace, .foa-block-stage__interaction, .foa-block-stage__evidence",
        ),
      ]
        .filter(isVisible)
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left < stageBounds.left - 1 ||
            bounds.right > stageBounds.right + 1 ||
            bounds.top < stageBounds.top - 1 ||
            bounds.bottom > stageBounds.bottom + 1
          );
        })
        .map((element) => element.className);

      const scrollRails: Record<string, string | number | boolean> = {};
      if (meta.mode === "workspace-evidence") {
        const taskMain = required(stageRoot, ".library-task-stage__main");
        const board = required(stageRoot, ".foa-task-lesson__board");
        const source = required(stageRoot, ".teaching-source-view pre");
        scrollRails.taskMainOverflowY = getComputedStyle(taskMain).overflowY;
        scrollRails.boardOverflowY = getComputedStyle(board).overflowY;
        scrollRails.sourceOverflowY = getComputedStyle(source).overflowY;
        scrollRails.sourceClientHeight = source.clientHeight;
      } else {
        const interaction = required(stageRoot, ".foa-block-stage__interaction");
        const source = required(stageRoot, ".foa-block-stage__source pre");
        const sourceBefore = source.scrollTop;
        interaction.scrollTop = interaction.scrollHeight > interaction.clientHeight ? 20 : 0;
        scrollRails.interactionOverflowY = getComputedStyle(interaction).overflowY;
        scrollRails.sourceOverflowY = getComputedStyle(source).overflowY;
        scrollRails.interactionIndependent = source.scrollTop === sourceBefore;
        scrollRails.sourceClientHeight = source.clientHeight;
        interaction.scrollTop = 0;
      }

      return {
        order: meta.order,
        mode: meta.mode,
        documentHorizontalOverflow: scrolling.scrollWidth - scrolling.clientWidth,
        documentVerticalOverflow: scrolling.scrollHeight - scrolling.clientHeight,
        rootHorizontalOverflow: tutorials.scrollWidth - tutorials.clientWidth,
        rootVerticalOverflow: tutorials.scrollHeight - tutorials.clientHeight,
        catalogOverflowY: getComputedStyle(catalog).overflowY,
        stageOverflowX: getComputedStyle(outerStage).overflowX,
        stageOverflowY: getComputedStyle(outerStage).overflowY,
        stageHorizontalOverflow: outerStage.scrollWidth - outerStage.clientWidth,
        stageVerticalOverflow: outerStage.scrollHeight - outerStage.clientHeight,
        collisions,
        clippedText,
        outsideStage,
        scrollRails,
      };

      function required(scope: ParentNode, selector: string): HTMLElement {
        const element = scope.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`missing ${selector}`);
        return element;
      }

      function isVisible(element: HTMLElement): boolean {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      }

      function siblingCollisions(container: HTMLElement): string[] {
        const children = [...container.children].filter(
          (element): element is HTMLElement => element instanceof HTMLElement && isVisible(element),
        );
        const collisions: string[] = [];
        for (let left = 0; left < children.length; left += 1) {
          for (let right = left + 1; right < children.length; right += 1) {
            const leftBounds = children[left]!.getBoundingClientRect();
            const rightBounds = children[right]!.getBoundingClientRect();
            const overlapWidth =
              Math.min(leftBounds.right, rightBounds.right) -
              Math.max(leftBounds.left, rightBounds.left);
            const overlapHeight =
              Math.min(leftBounds.bottom, rightBounds.bottom) -
              Math.max(leftBounds.top, rightBounds.top);
            if (overlapWidth > 1 && overlapHeight > 1) {
              collisions.push(`${shortText(children[left]!)}<>${shortText(children[right]!)}`);
            }
          }
        }
        return collisions;
      }

      function shortText(element: HTMLElement): string {
        return (element.textContent ?? "").trim().replace(/\s+/gu, " ").slice(0, 48);
      }
    },
    { order: lesson.order, mode: lesson.mode },
  );
}

function recordGeometryFailures(
  matrixId: string,
  report: GeometryReport,
  failures: string[],
): void {
  const prefix = `${matrixId} course ${String(report.order)}`;
  if (report.documentHorizontalOverflow > 1) {
    failures.push(
      `${prefix} document horizontal overflow ${String(report.documentHorizontalOverflow)}`,
    );
  }
  if (report.documentVerticalOverflow > 1) {
    failures.push(
      `${prefix} document vertical overflow ${String(report.documentVerticalOverflow)}`,
    );
  }
  if (report.rootHorizontalOverflow > 1 || report.rootVerticalOverflow > 1) {
    failures.push(
      `${prefix} tutorial root overflow ${String(report.rootHorizontalOverflow)}x${String(report.rootVerticalOverflow)}`,
    );
  }
  if (report.catalogOverflowY !== "auto") {
    failures.push(`${prefix} catalog does not own vertical scroll (${report.catalogOverflowY})`);
  }
  if (report.stageHorizontalOverflow > 1 || report.stageVerticalOverflow > 1) {
    failures.push(
      `${prefix} outer stage scrolls ${String(report.stageHorizontalOverflow)}x${String(report.stageVerticalOverflow)} (${report.stageOverflowX}/${report.stageOverflowY})`,
    );
  }
  if (report.collisions.length > 0) {
    failures.push(`${prefix} collisions: ${report.collisions.join(" | ")}`);
  }
  if (report.clippedText.length > 0) {
    failures.push(`${prefix} clipped text: ${report.clippedText.join(" | ")}`);
  }
  if (report.outsideStage.length > 0) {
    failures.push(`${prefix} modules outside stage: ${report.outsideStage.join(" | ")}`);
  }
  if (report.mode === "workspace-evidence") {
    if (
      report.scrollRails.sourceOverflowY !== "auto" ||
      Number(report.scrollRails.sourceClientHeight) <= 20
    ) {
      failures.push(
        `${prefix} source rail is not independently usable: ${JSON.stringify(report.scrollRails)}`,
      );
    }
  } else if (
    report.scrollRails.interactionOverflowY !== "auto" ||
    report.scrollRails.sourceOverflowY !== "auto" ||
    report.scrollRails.interactionIndependent !== true ||
    Number(report.scrollRails.sourceClientHeight) <= 20
  ) {
    failures.push(`${prefix} block scroll rails invalid: ${JSON.stringify(report.scrollRails)}`);
  }
}

async function verifyCatalogRail(matrixId: string, failures: string[]): Promise<void> {
  const proof = await page.locator(".tutorials-module").evaluate((root) => {
    const catalog = root.querySelector<HTMLElement>(".tutorials-module__lesson-list");
    const stage = root.querySelector<HTMLElement>(".tutorials-module__stage");
    if (catalog === null || stage === null) throw new Error("tutorial panes are missing");
    const stageBefore = stage.scrollTop;
    catalog.scrollTop = Math.min(80, Math.max(0, catalog.scrollHeight - catalog.clientHeight));
    const moved = catalog.scrollTop > 0;
    const isolated = stage.scrollTop === stageBefore;
    catalog.scrollTop = 0;
    return {
      moved,
      isolated,
      catalogOverflowY: getComputedStyle(catalog).overflowY,
      stageOverflowY: getComputedStyle(stage).overflowY,
    };
  });
  if (!proof.moved || !proof.isolated || proof.catalogOverflowY !== "auto") {
    failures.push(`${matrixId} catalog scroll rail invalid: ${JSON.stringify(proof)}`);
  }
}

async function verifyLessonSwitchResets(matrixId: string, failures: string[]): Promise<void> {
  const blockLessons = LATE_LESSONS.filter((lesson) => lesson.mode !== "workspace-evidence");
  const lesson = blockLessons[0];
  const alternate = blockLessons[1];
  if (lesson === undefined || alternate === undefined) return;
  await selectLesson(lesson);
  await startLesson(lesson);
  await selectLesson(alternate);
  await selectLesson(lesson);
  const phase = await stageFor(lesson).getAttribute("data-phase");
  if (phase !== "intro") failures.push(`${matrixId} switching courses retained phase ${phase}`);
}

async function restartApplicationAfterWorkspace(): Promise<void> {
  await application?.close();
  application = undefined;
  await launchApplication();
  await openTutorials();
}

async function setZoomFactor(factor: number): Promise<void> {
  const target = application;
  if (target === undefined) throw new Error("Electron application has not started");
  await target.evaluate(({ BrowserWindow }, zoomFactor) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("AlgoLatch window is missing");
    window.webContents.setZoomFactor(zoomFactor);
  }, factor);
}

async function attachFailureScreenshot(
  testInfo: TestInfo,
  matrixId: string,
  order: number,
): Promise<void> {
  await page
    .screenshot({
      path: testInfo.outputPath(`${matrixId}-course-${String(order)}-failure.png`),
      animations: "disabled",
    })
    .catch(() => undefined);
}

function normalize(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/gu, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
