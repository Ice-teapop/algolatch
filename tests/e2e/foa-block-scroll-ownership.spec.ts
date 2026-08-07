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

const BLOCK_LESSONS = FOA_LESSONS.slice(60, 105);
const MATRIX = [
  { id: "900x650-z100", width: 900, height: 650, zoom: 1 },
  { id: "1280x800-z150", width: 1280, height: 800, zoom: 1.5 },
] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-scroll-ownership-"));
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
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();
});

test.afterAll(async () => {
  await setZoomFactor(1).catch(() => undefined);
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("lessons 61-105 keep interaction and source on independent scroll rails", async () => {
  test.setTimeout(300_000);
  let observedInteractionScroll = false;
  let observedSourceScroll = false;

  for (const matrixCase of MATRIX) {
    await setZoomFactor(matrixCase.zoom);
    await page.setViewportSize({ width: matrixCase.width, height: matrixCase.height });
    await page.locator("#tutorials-tab").click();
    await expect(page.locator("#tutorials-panel")).toBeVisible();

    for (const lesson of BLOCK_LESSONS) {
      await test.step(`${matrixCase.id} lesson ${String(lesson.order)}`, async () => {
        await selectLesson(lesson.id);
        const stage = page.locator(".foa-block-stage");
        await expect(stage).toBeVisible();
        await stage.locator("[data-task-lesson-action='start']").click();
        await expect(stage).toHaveAttribute("data-phase", "task");

        const report = await stage.evaluate((root) => {
          const workspace = required(root, ".foa-block-stage__workspace");
          const interaction = required(root, ".foa-block-stage__interaction");
          const evidence = required(root, ".foa-block-stage__evidence");
          const source = required(root, ".foa-block-stage__source");
          const sourceViewport = required(root, ".foa-block-stage__source pre");
          const header = required(root, ".foa-block-stage__header");
          const title = required(root, ".foa-block-stage__header > strong");
          const instruction = required(root, ".foa-block-stage__instruction");
          const reset = required(root, "[data-task-lesson-action='reset']");
          const rootBox = root.getBoundingClientRect();
          const documentScroller = document.scrollingElement;
          const workspaceBox = workspace.getBoundingClientRect();
          const interactionBox = interaction.getBoundingClientRect();
          const evidenceBox = evidence.getBoundingClientRect();
          const sourceBox = source.getBoundingClientRect();
          const sourceViewportBox = sourceViewport.getBoundingClientRect();
          const headerBox = header.getBoundingClientRect();
          const headerItems = [title, instruction, reset].map((element) =>
            element.getBoundingClientRect(),
          );
          const blockOverflow = [...root.querySelectorAll<HTMLElement>(".foa-block-stage__block")]
            .filter((element) => !element.hidden)
            .map((element) => element.scrollWidth - element.clientWidth);
          return {
            documentHorizontalOverflow:
              documentScroller === null
                ? Number.POSITIVE_INFINITY
                : documentScroller.scrollWidth - documentScroller.clientWidth,
            documentScrollX: globalThis.scrollX,
            rootHorizontalOverflow: root.scrollWidth - root.clientWidth,
            rootVerticalOverflow: root.scrollHeight - root.clientHeight,
            workspaceOverflow: getComputedStyle(workspace).overflow,
            interactionOverflowY: getComputedStyle(interaction).overflowY,
            sourceOverflowY: getComputedStyle(sourceViewport).overflowY,
            interactionTabIndex: interaction.tabIndex,
            sourceTabIndex: sourceViewport.tabIndex,
            interactionRole: interaction.getAttribute("role"),
            sourceRole: sourceViewport.getAttribute("role"),
            workspaceInsideRoot:
              workspaceBox.left >= rootBox.left - 1 &&
              workspaceBox.right <= rootBox.right + 1 &&
              workspaceBox.bottom <= rootBox.bottom + 1,
            headerBeforeWorkspace: headerBox.bottom <= workspaceBox.top + 1,
            interactionEvidenceOverlap: overlap(interactionBox, evidenceBox),
            rootBox: box(rootBox),
            workspaceBox: box(workspaceBox),
            interactionBox: box(interactionBox),
            evidenceBox: box(evidenceBox),
            sourceBox: box(sourceBox),
            sourceViewportBox: box(sourceViewportBox),
            sourceInsideEvidence:
              sourceBox.left >= evidenceBox.left - 1 &&
              sourceBox.right <= evidenceBox.right + 1 &&
              sourceBox.top >= evidenceBox.top - 1 &&
              sourceBox.bottom <= evidenceBox.bottom + 1,
            sourceViewportHeight: sourceViewportBox.height,
            headerOverlaps: siblingOverlaps(headerItems),
            largestBlockOverflow: Math.max(0, ...blockOverflow),
          };

          function required(scope: Element, selector: string): HTMLElement {
            const element = scope.querySelector<HTMLElement>(selector);
            if (element === null) throw new Error(`Missing ${selector}`);
            return element;
          }

          function overlap(left: DOMRect, right: DOMRect): number {
            const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
            const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
            return width > 1 && height > 1 ? width * height : 0;
          }

          function box(rectangle: DOMRect): Record<string, number> {
            return {
              top: rectangle.top,
              right: rectangle.right,
              bottom: rectangle.bottom,
              left: rectangle.left,
              width: rectangle.width,
              height: rectangle.height,
            };
          }

          function siblingOverlaps(rectangles: DOMRect[]): number {
            let count = 0;
            for (let left = 0; left < rectangles.length; left += 1) {
              for (let right = left + 1; right < rectangles.length; right += 1) {
                if (overlap(rectangles[left]!, rectangles[right]!) > 0) count += 1;
              }
            }
            return count;
          }
        });

        expect(
          report.documentHorizontalOverflow,
          label(lesson.order, "document overflow"),
        ).toBeLessThanOrEqual(1);
        expect(report.documentScrollX, label(lesson.order, "document scroll position")).toBe(0);
        expect(
          report.rootHorizontalOverflow,
          label(lesson.order, "root horizontal overflow"),
        ).toBeLessThanOrEqual(1);
        expect(
          report.rootVerticalOverflow,
          label(lesson.order, "root vertical overflow"),
        ).toBeLessThanOrEqual(1);
        expect(report.workspaceOverflow, label(lesson.order, "workspace overflow owner")).toBe(
          "hidden",
        );
        expect(report.interactionOverflowY, label(lesson.order, "interaction scroll rail")).toBe(
          "auto",
        );
        expect(report.sourceOverflowY, label(lesson.order, "source scroll rail")).toBe("auto");
        expect(report.interactionTabIndex).toBe(0);
        expect(report.sourceTabIndex).toBe(0);
        expect(report.interactionRole).toBe("region");
        expect(report.sourceRole).toBe("region");
        expect(report.workspaceInsideRoot, label(lesson.order, "workspace bounds")).toBe(true);
        expect(report.headerBeforeWorkspace, label(lesson.order, "header collision")).toBe(true);
        expect(
          report.interactionEvidenceOverlap,
          `${label(lesson.order, "module collision")} ${JSON.stringify(report)}`,
        ).toBe(0);
        expect(report.sourceInsideEvidence, label(lesson.order, "source bounds")).toBe(true);
        expect(
          report.sourceViewportHeight,
          `${label(lesson.order, "source rail height")} ${JSON.stringify(report)}`,
        ).toBeGreaterThan(20);
        expect(report.headerOverlaps, label(lesson.order, "header text overlap")).toBe(0);
        expect(
          report.largestBlockOverflow,
          label(lesson.order, "block overflow"),
        ).toBeLessThanOrEqual(1);

        const scrollProof = await stage.evaluate((root) => {
          const interaction = root.querySelector<HTMLElement>(".foa-block-stage__interaction")!;
          const source = root.querySelector<HTMLElement>(".foa-block-stage__source pre")!;
          const interactionScrollable = interaction.scrollHeight > interaction.clientHeight;
          const sourceScrollable = source.scrollHeight > source.clientHeight;
          interaction.scrollTop = interactionScrollable ? 24 : 0;
          const interactionAfter = interaction.scrollTop;
          const sourceWhileInteractionMoves = source.scrollTop;
          interaction.scrollTop = 0;
          source.scrollTop = sourceScrollable ? 24 : 0;
          const sourceAfter = source.scrollTop;
          const interactionWhileSourceMoves = interaction.scrollTop;
          return {
            interactionScrollable,
            sourceScrollable,
            interactionMoved: interactionAfter > 0 && sourceWhileInteractionMoves === 0,
            sourceMoved: sourceAfter > 0 && interactionWhileSourceMoves === 0,
          };
        });
        if (scrollProof.interactionScrollable) {
          expect(scrollProof.interactionMoved, label(lesson.order, "interaction isolation")).toBe(
            true,
          );
          observedInteractionScroll = true;
        }
        if (scrollProof.sourceScrollable) {
          expect(scrollProof.sourceMoved, label(lesson.order, "source isolation")).toBe(true);
          observedSourceScroll = true;
        }
      });
    }
  }
  expect(observedInteractionScroll, "at least one interaction rail must need scrolling").toBe(true);
  expect(observedSourceScroll, "at least one source rail must need scrolling").toBe(true);
});

async function selectLesson(lessonId: string): Promise<void> {
  const entry = lessonEntry(lessonId);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
    (element as HTMLButtonElement).click();
  });
  await expect(entry).toHaveAttribute("aria-current", "page");
}

function lessonEntry(lessonId: string): Locator {
  return page.locator(`[data-tutorial-lesson-id="${lessonId}"]`);
}

function label(order: number, subject: string): string {
  return `lesson ${String(order)} ${subject}`;
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
