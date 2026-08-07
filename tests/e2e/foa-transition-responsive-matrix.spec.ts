import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const SCREENSHOT_ROOT = join(tmpdir(), "algolatch-transition-responsive-matrix");

const COURSES = [
  { order: 63, kind: "counter" },
  { order: 70, kind: "search" },
  { order: 75, kind: "stack" },
  { order: 80, kind: "grid" },
] as const;

const MATRIX = [
  { id: "1280x800-z100", width: 1280, height: 800, zoom: 1 },
  { id: "1100x700-z100", width: 1100, height: 700, zoom: 1 },
  { id: "900x650-z100", width: 900, height: 650, zoom: 1 },
  { id: "1280x800-z125", width: 1280, height: 800, zoom: 1.25 },
  { id: "1280x800-z150", width: 1280, height: 800, zoom: 1.5 },
] as const;

interface BrowserProblem {
  readonly type: "console" | "pageerror";
  readonly text: string;
}

const browserProblems: BrowserProblem[] = [];
const semanticFailures: Array<{
  readonly label: string;
  readonly frame: number;
  readonly input: string;
  readonly visibleValues: readonly string[];
}> = [];
const responsiveFailures: Array<{
  readonly label: string;
  readonly productLayout: string | null;
  readonly result: unknown;
}> = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-transition-responsive-e2e-"));
  await rm(SCREENSHOT_ROOT, { recursive: true, force: true });
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
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
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserProblems.push({ type: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    browserProblems.push({ type: "pageerror", text: error.message });
  });
  await expect.poll(() => page.url()).toContain(`127.0.0.1:${developmentServerPort}`);
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
});

test.afterAll(async () => {
  await setZoomFactor(1).catch(() => undefined);
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("transition lessons stay usable through the responsive and zoom matrix", async () => {
  test.setTimeout(300_000);

  for (const matrixCase of MATRIX) {
    await test.step(matrixCase.id, async () => {
      await setZoomFactor(matrixCase.zoom);
      await page.setViewportSize({ width: matrixCase.width, height: matrixCase.height });
      await page.locator("#tutorials-tab").click();
      await expect(page.locator("#tutorials-panel")).toBeVisible();

      for (const course of COURSES) {
        await test.step(`course ${String(course.order)}`, async () => {
          const blockStage = await openCourse(course.order);
          const prototype = blockStage.locator(".foa-transition-prototype");

          await operateInput(prototype, course.kind);
          if (course.order === 63) {
            await verifyCourse63CustomInputFrames(
              prototype,
              `${matrixCase.id}/course-${String(course.order)}`,
            );
          }
          await expectResponsiveGate(
            prototype,
            `${matrixCase.id}/course-${String(course.order)}/input`,
          );

          const progress = prototype.locator("[data-transition-progress]");
          await prototype.locator("[data-transition-action='next']").click();
          await expect(progress).toHaveValue("1");
          await expectSourceSync(blockStage, prototype);
          await expectResponsiveGate(
            prototype,
            `${matrixCase.id}/course-${String(course.order)}/next`,
          );

          const maximum = Number(await progress.getAttribute("max"));
          const seekIndex = Math.max(1, Math.min(maximum - 1, Math.floor(maximum / 2)));
          await progress.fill(String(seekIndex));
          await expect(progress).toHaveValue(String(seekIndex));
          await expectSourceSync(blockStage, prototype);
          await expectResponsiveGate(
            prototype,
            `${matrixCase.id}/course-${String(course.order)}/seek`,
          );

          if (course.order === 70) await expectLocalSearchScroll(prototype);

          const beforePlayback = Number(await progress.inputValue());
          const play = prototype.locator("[data-transition-action='play']");
          await play.click();
          await expect
            .poll(async () => Number(await progress.inputValue()), {
              message: `${matrixCase.id}/course-${String(course.order)} playback advances`,
            })
            .not.toBe(beforePlayback);
          await page.waitForTimeout(120);
          await expectSourceSync(blockStage, prototype);
          await expectResponsiveGate(
            prototype,
            `${matrixCase.id}/course-${String(course.order)}/playing`,
          );
          await prototype.screenshot({
            path: join(
              SCREENSHOT_ROOT,
              `${matrixCase.id}-course-${String(course.order)}-playing.png`,
            ),
            animations: "allow",
          });
          if ((await prototype.getAttribute("data-playing")) === "true") await play.click();
        });
      }
    });
  }

  expect(
    { responsiveFailures, semanticFailures, browserProblems },
    "responsive matrix keeps geometry, custom input semantics and browser diagnostics clean",
  ).toEqual({ responsiveFailures: [], semanticFailures: [], browserProblems: [] });
});

async function openCourse(order: (typeof COURSES)[number]["order"]): Promise<Locator> {
  const lesson = FOA_LESSONS[order - 1];
  if (lesson === undefined) throw new Error(`FOA course ${String(order)} is missing`);
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
  const blockStage = page.locator(".foa-block-stage[data-transition-prototype='true']");
  await expect(blockStage).toBeVisible();
  await blockStage.locator("[data-task-lesson-action='start']").click();
  await expect(blockStage).toHaveAttribute("data-phase", "task");
  await expect(blockStage.locator(".foa-transition-prototype")).toHaveAttribute(
    "data-lesson-order",
    String(order),
  );
  return blockStage;
}

async function operateInput(
  prototype: Locator,
  kind: (typeof COURSES)[number]["kind"],
): Promise<void> {
  if (kind === "counter") {
    await prototype.locator(".foa-transition-prototype__input input[type='number']").fill("11");
    await prototype.locator("[data-transition-action='apply-input']").click();
    return;
  }
  if (kind === "search") {
    await prototype
      .locator(".foa-transition-prototype__input input[type='text']")
      .fill("-10 -8 -6 -4 -2 0 2 4 6 8 10 12");
    await prototype.locator(".foa-transition-prototype__input input[type='number']").fill("8");
    await prototype.locator("[data-transition-action='apply-input']").click();
    return;
  }
  if (kind === "stack") {
    await prototype.locator(".foa-transition-prototype__input input[type='number']").fill("3");
    await prototype.locator("[data-transition-action='apply-input']").click();
    return;
  }
  const gridCell = prototype
    .locator(".foa-transition-prototype__grid-toggle:not([disabled])")
    .first();
  const stateBefore = await gridCell.getAttribute("data-open");
  await gridCell.click();
  await expect(gridCell).not.toHaveAttribute("data-open", stateBefore ?? "");
  await expect(gridCell).toBeFocused();
}

async function verifyCourse63CustomInputFrames(prototype: Locator, label: string): Promise<void> {
  const progress = prototype.locator("[data-transition-progress]");
  const maximum = Number(await progress.getAttribute("max"));
  for (let frame = 0; frame <= maximum; frame += 1) {
    await progress.fill(String(frame));
    const evidence = await prototype.evaluate((root) => ({
      input:
        root
          .querySelector<HTMLOutputElement>("[data-teaching-token-id='pointer-input'] > output")
          ?.textContent?.trim() ?? "",
      visibleValues: [
        ...root.querySelectorAll<HTMLElement>(
          "[data-teaching-token-id] > output, .foa-transition-prototype__summary, .foa-transition-prototype__relation-label:not([hidden]), .foa-transition-prototype__output > output",
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.textContent?.trim() ?? ""),
    }));
    const hasStaleDefault = evidence.visibleValues.some((value) =>
      /(^|\D)[45](?=\D|$)/u.test(value),
    );
    if (evidence.input !== "11" || hasStaleDefault) {
      semanticFailures.push({ label, frame, ...evidence });
    }
  }
  await progress.fill("0");
}

async function expectSourceSync(blockStage: Locator, prototype: Locator): Promise<void> {
  const activeLine = await prototype.getAttribute("data-active-source-line");
  expect(activeLine).toMatch(/^\d+$/u);
  await expect(blockStage).toHaveAttribute("data-prototype-source-line", activeLine!);
  const sourceRow = blockStage.locator(
    `.foa-block-stage__source-line[data-source-line='${activeLine!}']`,
  );
  await expect(sourceRow).toBeVisible();
  await expect(sourceRow).toHaveAttribute("data-state", "active");
}

async function expectLocalSearchScroll(prototype: Locator): Promise<void> {
  const array = prototype.locator(".foa-transition-prototype__array");
  const result = await array.evaluate((element) => {
    const cells = [
      ...element.querySelectorAll<HTMLElement>(".foa-transition-prototype__array-cell"),
    ];
    if (cells.length !== 12)
      throw new Error(`Expected 12 search cells, received ${String(cells.length)}`);
    const range = element.scrollWidth - element.clientWidth;
    const first = cells[0]!;
    const last = cells.at(-1)!;
    element.scrollLeft = 0;
    const viewportAtStart = element.getBoundingClientRect();
    const firstBounds = first.getBoundingClientRect();
    const firstReachable =
      firstBounds.left >= viewportAtStart.left - 1 &&
      firstBounds.right <= viewportAtStart.right + 1;
    element.scrollLeft = range;
    const viewportAtEnd = element.getBoundingClientRect();
    const lastBounds = last.getBoundingClientRect();
    const lastReachable =
      lastBounds.left >= viewportAtEnd.left - 1 && lastBounds.right <= viewportAtEnd.right + 1;
    const overflowX = getComputedStyle(element).overflowX;
    return { range, firstReachable, lastReachable, overflowX };
  });
  expect(result.range, "course 70 keeps a bounded local horizontal scroll range").toBeGreaterThan(
    0,
  );
  expect(result.firstReachable).toBe(true);
  expect(result.lastReachable).toBe(true);
  expect(["auto", "scroll"]).toContain(result.overflowX);
}

async function expectResponsiveGate(prototype: Locator, label: string): Promise<void> {
  const productLayout = await prototype.getAttribute("data-layout");
  const result = await prototype.evaluate((root) => {
    const visibleText = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-transition-prototype__heading, .foa-transition-prototype__badge, .foa-transition-prototype__input-title, .foa-transition-prototype__field > span, .foa-transition-prototype__node > span, .foa-transition-prototype__node > output, .foa-transition-prototype__summary, .foa-transition-prototype__source-line-number, .foa-transition-prototype__source-line-code, .foa-transition-prototype__output > span, .foa-transition-prototype__output output, .foa-transition-prototype__controls > button, .foa-transition-prototype__progress-label > span, .foa-transition-prototype__relation-label",
      ),
    ].filter(isActuallyVisible);
    const textOverflow = visibleText
      .filter(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1,
      )
      .map(describe);
    const textOverlap = overlappingPairs(visibleText);
    const rootBounds = root.getBoundingClientRect();
    const outside = visibleText
      .filter((element) => {
        if (closestScrollableAncestor(element) !== null) return false;
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left < rootBounds.left - 1 ||
          bounds.right > rootBounds.right + 1 ||
          bounds.top < rootBounds.top - 1 ||
          bounds.bottom > rootBounds.bottom + 1
        );
      })
      .map(describe);
    const regions = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-transition-prototype__input, .foa-transition-prototype__canvas, .foa-transition-prototype__narration, .foa-transition-prototype__controls",
      ),
    ].filter(isActuallyVisible);
    const regionOverlap = overlappingPairs(regions);
    const activeSource = root.querySelector<HTMLElement>(".foa-transition-prototype__source");
    const controls = root.querySelector<HTMLElement>(".foa-transition-prototype__controls");
    const sourceControlOverlap =
      activeSource === null || controls === null
        ? []
        : overlap(activeSource.getBoundingClientRect(), controls.getBoundingClientRect())
          ? [{ left: describe(activeSource), right: describe(controls) }]
          : [];
    const regionRects = Object.fromEntries(
      [
        ["root", root],
        ["header", root.querySelector<HTMLElement>(".foa-transition-prototype__header")],
        ["input", root.querySelector<HTMLElement>(".foa-transition-prototype__input")],
        ["canvas", root.querySelector<HTMLElement>(".foa-transition-prototype__canvas")],
        ["narration", root.querySelector<HTMLElement>(".foa-transition-prototype__narration")],
        ["controls", root.querySelector<HTMLElement>(".foa-transition-prototype__controls")],
      ].map(([name, element]) => [
        name,
        element instanceof HTMLElement ? describeRegion(element) : null,
      ]),
    );
    const host = root.parentElement;
    const hostDiagnostic = host === null ? null : describeRegion(host);
    return {
      textOverflow,
      textOverlap,
      outside,
      regionOverlap,
      sourceControlOverlap,
      regionRects,
      hostDiagnostic,
    };

    function isActuallyVisible(element: HTMLElement): boolean {
      if (element.hidden || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) <= 0.05
      ) {
        return false;
      }
      const scroller = closestScrollableAncestor(element);
      if (scroller === null) return true;
      return overlap(element.getBoundingClientRect(), scroller.getBoundingClientRect());
    }

    function closestScrollableAncestor(element: HTMLElement): HTMLElement | null {
      for (let current = element.parentElement; current !== null; current = current.parentElement) {
        if (
          current.scrollWidth > current.clientWidth + 1 ||
          current.scrollHeight > current.clientHeight + 1
        ) {
          return current;
        }
        if (current === root) break;
      }
      return null;
    }

    function overlappingPairs(elements: readonly HTMLElement[]) {
      return elements.flatMap((left, index) =>
        elements.slice(index + 1).flatMap((right) => {
          if (left.contains(right) || right.contains(left)) return [];
          return overlap(left.getBoundingClientRect(), right.getBoundingClientRect())
            ? [{ left: describe(left), right: describe(right) }]
            : [];
        }),
      );
    }

    function overlap(left: DOMRect, right: DOMRect): boolean {
      return (
        Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
      );
    }

    function describe(element: HTMLElement) {
      const bounds = element.getBoundingClientRect();
      return {
        className: element.className,
        text: element.textContent?.trim() ?? "",
        rect: {
          left: Math.round(bounds.left * 10) / 10,
          top: Math.round(bounds.top * 10) / 10,
          right: Math.round(bounds.right * 10) / 10,
          bottom: Math.round(bounds.bottom * 10) / 10,
        },
      };
    }

    function describeRegion(element: HTMLElement) {
      const style = getComputedStyle(element);
      return {
        ...describe(element),
        client: { width: element.clientWidth, height: element.clientHeight },
        scroll: { width: element.scrollWidth, height: element.scrollHeight },
        style: {
          display: style.display,
          position: style.position,
          overflow: style.overflow,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          height: style.height,
          minHeight: style.minHeight,
          gridTemplateRows: style.gridTemplateRows,
        },
      };
    }
  });
  const invalid =
    productLayout !== "ready" ||
    result.textOverflow.length > 0 ||
    result.textOverlap.length > 0 ||
    result.outside.length > 0 ||
    result.regionOverlap.length > 0 ||
    result.sourceControlOverlap.length > 0;
  if (invalid) {
    console.info(
      `[foa-responsive-failure] ${label} ${JSON.stringify({ productLayout, ...result })}`,
    );
    await prototype.screenshot({
      path: join(SCREENSHOT_ROOT, `${label.replace(/[^a-zA-Z0-9-]+/gu, "-")}-failure.png`),
      animations: "allow",
    });
    responsiveFailures.push({ label, productLayout, result });
  }
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
