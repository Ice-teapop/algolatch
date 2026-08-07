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

const SCREENSHOT_ROOT = join(tmpdir(), "algolatch-transition-prototypes");

const PROTOTYPE_CASES = [
  { order: 63, kind: "counter" },
  { order: 70, kind: "search" },
  { order: 75, kind: "stack" },
  { order: 80, kind: "grid" },
] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-transition-prototype-e2e-"));
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
  await expect.poll(() => page.url()).toContain(`127.0.0.1:${developmentServerPort}`);
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("courses 63, 70, 75 and 80 keep their runtime prototype usable and unclipped", async () => {
  test.setTimeout(120_000);

  for (const runtimeCase of PROTOTYPE_CASES) {
    await test.step(`course ${String(runtimeCase.order)}: input, layout and one runtime step`, async () => {
      await page.setViewportSize({
        width: runtimeCase.order === 70 ? 1024 : 1440,
        height: 960,
      });
      await selectLesson(runtimeCase.order);

      const blockStage = page.locator(".foa-block-stage[data-transition-prototype='true']");
      await expect(blockStage).toBeVisible();
      await blockStage.locator("[data-task-lesson-action='start']").click();
      await expect(blockStage).toHaveAttribute("data-phase", "task");

      const prototype = blockStage.locator(".foa-transition-prototype");
      await expect(prototype).toBeVisible();
      await expect(prototype).toHaveAttribute("data-lesson-order", String(runtimeCase.order));
      await expect(prototype).toHaveAttribute("data-provenance", "teaching-model");
      await expect(prototype).toHaveAttribute("data-trace-status", "idle");
      expect
        .soft(
          await prototype.getAttribute("data-layout"),
          `course ${String(runtimeCase.order)} initial layout state`,
        )
        .toBe("ready");

      await operateInput(prototype, runtimeCase.kind);
      await prototype.screenshot({
        path: join(SCREENSHOT_ROOT, `course-${String(runtimeCase.order)}-input.png`),
      });
      const inputGate = await measureProductionLayoutGate(prototype);
      console.info(
        `[foa-transition-gate] course=${String(runtimeCase.order)} phase=input ${JSON.stringify(inputGate)}`,
      );
      expect
        .soft(inputGate, `course ${String(runtimeCase.order)} production layout gate after input`)
        .toMatchObject({ textOverflow: false, overlap: false, outside: false });
      expect
        .soft(
          await measurePrototype(prototype),
          `course ${String(runtimeCase.order)} prototype layout`,
        )
        .toMatchObject({
          horizontalOverflow: false,
          clippedEssentialText: [],
          outOfBoundsEssentialText: [],
          overlappingTextPairs: [],
        });
      await expectHorizontalOutputLabel(prototype, runtimeCase.order);

      const progress = prototype.locator("[data-transition-progress]");
      await expect(progress).toHaveValue("0");
      const summaryBefore = await prototype
        .locator(".foa-transition-prototype__summary")
        .innerText();
      await prototype.locator("[data-transition-action='next']").click();
      await expect(progress).toHaveValue("1");
      await expect(prototype.locator("[data-transition-action='previous']")).toBeEnabled();
      await expect
        .poll(() => prototype.locator(".foa-transition-prototype__summary").innerText())
        .not.toBe(summaryBefore);
      await expect(prototype.locator(".foa-transition-prototype__source code")).not.toBeEmpty();
      await expectRuntimeSourceSync(blockStage, prototype);
      if (runtimeCase.order === 75 || runtimeCase.order === 80) {
        await expectSourceSyncAcrossTimeline(blockStage, prototype);
      }
      await prototype.screenshot({
        path: join(SCREENSHOT_ROOT, `course-${String(runtimeCase.order)}-next.png`),
      });
      const nextGate = await measureProductionLayoutGate(prototype);
      console.info(
        `[foa-transition-gate] course=${String(runtimeCase.order)} phase=next ${JSON.stringify(nextGate)}`,
      );
      expect
        .soft(nextGate, `course ${String(runtimeCase.order)} production layout gate after next`)
        .toMatchObject({ textOverflow: false, overlap: false, outside: false });

      expect
        .soft(
          await measurePrototype(prototype),
          `course ${String(runtimeCase.order)} prototype layout after next`,
        )
        .toMatchObject({
          horizontalOverflow: false,
          clippedEssentialText: [],
          outOfBoundsEssentialText: [],
          overlappingTextPairs: [],
        });
      expect
        .soft(
          await prototype.getAttribute("data-layout"),
          `course ${String(runtimeCase.order)} layout state after next`,
        )
        .toBe("ready");
      if (runtimeCase.order === 70) await verifySearchScrollConnection(prototype);
      if (runtimeCase.order === 75) await verifyStackConnectionDirections(prototype);
      if (runtimeCase.order === 80) await verifyGridDependencyDirection(prototype);
    });
  }
});

test("keeps the old value visible until the semantic token reaches its destination", async () => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await selectLesson(63);

  const blockStage = page.locator(".foa-block-stage[data-transition-prototype='true']");
  await blockStage.locator("[data-task-lesson-action='start']").click();
  const prototype = blockStage.locator(".foa-transition-prototype");
  const linkValue = prototype.locator("[data-teaching-token-id='pointer-link'] > output");
  await expect(linkValue).toHaveText("—");

  await prototype.locator(".foa-transition-prototype__token").evaluate((token) => {
    const semanticToken = token as HTMLElement & {
      __foaPausedTransfer?: Animation;
      __foaOriginalAnimate?: typeof token.animate;
    };
    semanticToken.__foaOriginalAnimate = token.animate;
    token.animate = function (...arguments_: Parameters<typeof token.animate>) {
      const animation = semanticToken.__foaOriginalAnimate!.apply(this, arguments_);
      animation.pause();
      animation.currentTime = 310;
      semanticToken.__foaPausedTransfer = animation;
      return animation;
    };
  });

  await prototype.locator("[data-transition-action='next']").click();
  await prototype.locator("[data-transition-action='next']").click();
  await expect(prototype.locator("[data-transition-progress]")).toHaveValue("2");
  await expect(linkValue).toHaveText("—");
  await prototype.screenshot({ path: join(SCREENSHOT_ROOT, "course-63-mid-transfer.png") });
  expect(await measureProductionLayoutGate(prototype)).toMatchObject({
    textOverflow: false,
    overlap: false,
    outside: false,
  });

  await prototype.locator(".foa-transition-prototype__token").evaluate((token) => {
    const semanticToken = token as HTMLElement & { __foaPausedTransfer?: Animation };
    semanticToken.__foaPausedTransfer?.finish();
  });
  await expect(linkValue).toContainText("counter");
});

async function selectLesson(order: number): Promise<void> {
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
}

async function operateInput(
  prototype: Locator,
  kind: (typeof PROTOTYPE_CASES)[number]["kind"],
): Promise<void> {
  if (kind === "counter") {
    const value = prototype.locator(".foa-transition-prototype__input input[type='number']");
    await value.fill("11");
    await prototype.locator("[data-transition-action='apply-input']").click();
    await expect(value).toHaveValue("11");
    return;
  }

  if (kind === "search") {
    const values = prototype.locator(".foa-transition-prototype__input input[type='text']");
    const target = prototype.locator(".foa-transition-prototype__input input[type='number']");
    await values.fill("-10 -8 -6 -4 -2 0 2 4 6 8 10 12");
    await target.fill("8");
    await prototype.locator("[data-transition-action='apply-input']").click();
    await expect(values).toHaveValue("-10 -8 -6 -4 -2 0 2 4 6 8 10 12");
    await expect(target).toHaveValue("8");
    return;
  }

  if (kind === "stack") {
    const disks = prototype.locator(".foa-transition-prototype__input input[type='number']");
    await disks.fill("3");
    await prototype.locator("[data-transition-action='apply-input']").click();
    await expect(disks).toHaveValue("3");
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

async function expectRuntimeSourceSync(blockStage: Locator, prototype: Locator): Promise<void> {
  const activeLine = await prototype.getAttribute("data-active-source-line");
  const activeAnchor = await prototype.getAttribute("data-active-source-anchor-id");
  expect(activeLine, "the runtime frame exposes an exact source line").toMatch(/^\d+$/u);
  expect(activeAnchor, "the runtime frame exposes an authored source anchor").toBeTruthy();
  await expect(blockStage).toHaveAttribute("data-prototype-source-line", activeLine!);
  await expect(prototype.locator(".foa-transition-prototype__source code")).toHaveAttribute(
    "data-source-anchor-id",
    activeAnchor!,
  );
  const sourceRow = blockStage.locator(
    `.foa-block-stage__source-line[data-source-line='${activeLine!}']`,
  );
  await expect(sourceRow).toBeVisible();
  await expect(sourceRow).toHaveAttribute("data-state", "active");
}

async function expectSourceSyncAcrossTimeline(
  blockStage: Locator,
  prototype: Locator,
): Promise<void> {
  const progress = prototype.locator("[data-transition-progress]");
  const maximum = Number(await progress.getAttribute("max"));
  const checkpoints = [...new Set([1, Math.floor(maximum / 2), maximum])].filter(
    (value) => value >= 0,
  );
  for (const checkpoint of checkpoints) {
    await progress.fill(String(checkpoint));
    await expect(progress).toHaveValue(String(checkpoint));
    await expectRuntimeSourceSync(blockStage, prototype);
  }
  await progress.fill("1");
  await expect(progress).toHaveValue("1");
  await expectRuntimeSourceSync(blockStage, prototype);
}

async function measurePrototype(prototype: Locator): Promise<{
  horizontalOverflow: boolean;
  clippedEssentialText: string[];
  outOfBoundsEssentialText: string[];
  overlappingTextPairs: string[];
}> {
  return prototype.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const essentials = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-transition-prototype__essential, .foa-transition-prototype__summary, .foa-transition-prototype__source code",
      ),
    ].filter((element) => isVisiblyRendered(element));
    const textTargets = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-transition-prototype__heading, .foa-transition-prototype__badge, .foa-transition-prototype__input-title, .foa-transition-prototype__field > span, .foa-transition-prototype__node > span, .foa-transition-prototype__node > output, .foa-transition-prototype__summary, .foa-transition-prototype__source code, .foa-transition-prototype__output output, .foa-transition-prototype__controls > button, .foa-transition-prototype__progress-label > span, .foa-transition-prototype__layout-warning",
      ),
    ].filter((element) => isVisiblyRendered(element));
    const overlappingTextPairs = textTargets.flatMap((left, leftIndex) => {
      const leftBox = left.getBoundingClientRect();
      return textTargets.slice(leftIndex + 1).flatMap((right) => {
        const rightBox = right.getBoundingClientRect();
        const horizontal =
          Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
        const vertical =
          Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
        return horizontal > 1 && vertical > 1
          ? [`${left.textContent?.trim() ?? ""} ↔ ${right.textContent?.trim() ?? ""}`]
          : [];
      });
    });
    return {
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      clippedEssentialText: essentials
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent?.trim() ?? ""),
      outOfBoundsEssentialText: essentials
        .filter((element) => {
          if (closestScrollableAncestor(element) !== null) return false;
          const box = element.getBoundingClientRect();
          return box.left < bounds.left - 1 || box.right > bounds.right + 1;
        })
        .map((element) => element.textContent?.trim() ?? ""),
      overlappingTextPairs,
    };

    function isVisiblyRendered(element: HTMLElement): boolean {
      if (element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || Number.parseFloat(style.opacity) <= 0.05) return false;
      const scrollContainer = closestScrollableAncestor(element);
      if (scrollContainer === null) return true;
      const viewport = scrollContainer.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return (
        Math.min(viewport.right, bounds.right) - Math.max(viewport.left, bounds.left) > 1 &&
        Math.min(viewport.bottom, bounds.bottom) - Math.max(viewport.top, bounds.top) > 1
      );
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
  });
}

async function expectHorizontalOutputLabel(prototype: Locator, order: number): Promise<void> {
  const writingMode = await prototype
    .locator(".foa-transition-prototype__output > span")
    .evaluate((element) => getComputedStyle(element).writingMode);
  expect
    .soft(writingMode, `course ${String(order)} output label writing mode`)
    .toBe("horizontal-tb");
}

async function measureProductionLayoutGate(prototype: Locator): Promise<{
  textOverflow: boolean;
  overlap: boolean;
  outside: boolean;
  overflowElements: unknown[];
  overlapPairs: unknown[];
  outsideElements: unknown[];
  visualScrollable: boolean;
}> {
  return prototype.evaluate((root) => {
    const nodes = [
      ...root.querySelectorAll<HTMLElement>(
        ".foa-transition-prototype__essential, .foa-transition-prototype__evidence, .foa-transition-prototype__field, .foa-transition-prototype__progress-label, .foa-transition-prototype__output, .foa-transition-prototype__grid-toggle",
      ),
    ];
    const visibleNodes = nodes.filter((node) => {
      const rectangle = node.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return false;
      const scrollContainer = closestScrollableAncestor(node);
      if (scrollContainer === null) return true;
      const viewport = scrollContainer.getBoundingClientRect();
      return (
        Math.min(viewport.right, rectangle.right) - Math.max(viewport.left, rectangle.left) > 1 &&
        Math.min(viewport.bottom, rectangle.bottom) - Math.max(viewport.top, rectangle.top) > 1
      );
    });
    const overflowElements = nodes
      .filter(
        (node) =>
          (node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1) ||
          (node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 1),
      )
      .map(describe);
    const overlapPairs = visibleNodes.flatMap((left, index) =>
      visibleNodes.slice(index + 1).flatMap((right) => {
        if (left.contains(right) || right.contains(left)) return [];
        const leftRectangle = left.getBoundingClientRect();
        const rightRectangle = right.getBoundingClientRect();
        const overlaps =
          Math.min(leftRectangle.right, rightRectangle.right) -
            Math.max(leftRectangle.left, rightRectangle.left) >
            1 &&
          Math.min(leftRectangle.bottom, rightRectangle.bottom) -
            Math.max(leftRectangle.top, rightRectangle.top) >
            1;
        return overlaps ? [{ left: describe(left), right: describe(right) }] : [];
      }),
    );
    const visual = root.querySelector<HTMLElement>(".foa-transition-prototype__visual");
    if (visual === null) throw new Error("FOA transition prototype visual is missing");
    const visualBounds = visual.getBoundingClientRect();
    const visualScrollable =
      visual.scrollWidth > visual.clientWidth + 1 || visual.scrollHeight > visual.clientHeight + 1;
    const outsideElements = visualScrollable
      ? []
      : visibleNodes
          .filter((node) => {
            if (!visual.contains(node)) return false;
            if (closestScrollableAncestor(node) !== null) return false;
            const rectangle = node.getBoundingClientRect();
            return (
              rectangle.left < visualBounds.left - 1 ||
              rectangle.right > visualBounds.right + 1 ||
              rectangle.top < visualBounds.top - 1 ||
              rectangle.bottom > visualBounds.bottom + 1
            );
          })
          .map(describe);
    return {
      textOverflow: overflowElements.length > 0,
      overlap: overlapPairs.length > 0,
      outside: outsideElements.length > 0,
      overflowElements,
      overlapPairs,
      outsideElements,
      visualScrollable,
    };

    function describe(element: HTMLElement): {
      className: string;
      text: string;
      rect: { left: number; top: number; right: number; bottom: number };
      client: { width: number; height: number };
      scroll: { width: number; height: number };
    } {
      const rectangle = element.getBoundingClientRect();
      return {
        className: element.className,
        text: element.textContent?.trim() ?? "",
        rect: {
          left: Math.round(rectangle.left * 10) / 10,
          top: Math.round(rectangle.top * 10) / 10,
          right: Math.round(rectangle.right * 10) / 10,
          bottom: Math.round(rectangle.bottom * 10) / 10,
        },
        client: { width: element.clientWidth, height: element.clientHeight },
        scroll: { width: element.scrollWidth, height: element.scrollHeight },
      };
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
  });
}

async function verifySearchScrollConnection(prototype: Locator): Promise<void> {
  await installTokenAnimationCounter();
  const next = prototype.locator("[data-transition-action='next']");
  await next.click();
  await expect(prototype.locator("[data-transition-progress]")).toHaveValue("2");
  await expect.poll(readTokenAnimationCount).toBeGreaterThan(0);
  const tokenAnimationCount = await readTokenAnimationCount();
  const token = prototype.locator(".foa-transition-prototype__token");
  const tokenEventId = await token.getAttribute("data-token-event-id");
  expect(tokenEventId, "semantic frames expose a stable token event identity").toBeTruthy();
  await expect(prototype.locator(".foa-transition-prototype__relation-label")).toBeVisible();
  await expect(prototype.locator(".foa-transition-prototype__relation-label")).not.toBeEmpty();
  const array = prototype.locator(".foa-transition-prototype__array");
  const scrollRange = await array.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect
    .soft(scrollRange, "course 70 max input creates a bounded horizontal scroll range")
    .toBeGreaterThan(0);
  if (scrollRange <= 0) {
    await prototype.screenshot({ path: join(SCREENSHOT_ROOT, "course-70-no-scroll.png") });
    return;
  }
  const edge = prototype.locator(".foa-transition-prototype__edge");
  await expect(edge).toHaveCount(1);
  const pathBeforeScroll = await edge.getAttribute("d");
  expect(pathBeforeScroll).not.toBeNull();
  await array.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
  });
  await expect
    .poll(() => edge.getAttribute("d"), {
      message: "course 70 connection follows the scrolled array",
    })
    .not.toBe(pathBeforeScroll);
  await expect.poll(readTokenAnimationCount).toBe(tokenAnimationCount);
  await expect(token).toHaveAttribute("data-token-event-id", tokenEventId!);

  await page.setViewportSize({ width: 1100, height: 960 });
  await expect.poll(readTokenAnimationCount).toBe(tokenAnimationCount);
  await expect(token).toHaveAttribute("data-token-event-id", tokenEventId!);

  await expectSearchEndpointsReachable(array);
  await prototype.screenshot({ path: join(SCREENSHOT_ROOT, "course-70-scroll.png") });
}

async function installTokenAnimationCounter(): Promise<void> {
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __foaTokenAnimationCount?: number;
    };
    const token = document.querySelector<HTMLElement>(".foa-transition-prototype__token");
    if (token === null) throw new Error("FOA semantic token is missing");
    const instrumented = token as HTMLElement & { __foaOriginalAnimate?: typeof token.animate };
    state.__foaTokenAnimationCount = 0;
    if (instrumented.__foaOriginalAnimate !== undefined) return;
    instrumented.__foaOriginalAnimate = token.animate;
    token.animate = function (...arguments_: Parameters<typeof token.animate>) {
      state.__foaTokenAnimationCount = (state.__foaTokenAnimationCount ?? 0) + 1;
      return instrumented.__foaOriginalAnimate!.apply(this, arguments_);
    };
  });
}

async function readTokenAnimationCount(): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __foaTokenAnimationCount?: number })
        .__foaTokenAnimationCount ?? 0,
  );
}

async function expectSearchEndpointsReachable(visual: Locator): Promise<void> {
  const reachability = await visual.evaluate((element) => {
    const cells = [
      ...element.querySelectorAll<HTMLElement>(".foa-transition-prototype__array-cell"),
    ];
    if (cells.length < 2) throw new Error("Course 70 long input did not render both endpoints");
    const inspect = (cell: HTMLElement, scrollLeft: number) => {
      element.scrollLeft = scrollLeft;
      const viewport = element.getBoundingClientRect();
      const bounds = cell.getBoundingClientRect();
      return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
    };
    return {
      first: inspect(cells[0]!, 0),
      last: inspect(cells.at(-1)!, element.scrollWidth - element.clientWidth),
    };
  });
  expect(reachability, "course 70 exposes both ends of a 12-item input at 1024px").toEqual({
    first: true,
    last: true,
  });
}

async function verifyStackConnectionDirections(prototype: Locator): Promise<void> {
  const edge = prototype.locator(".foa-transition-prototype__edge");
  await expect(edge).toHaveCount(1);
  const callEnter = parseQuadraticPath(await edge.getAttribute("d"));
  expect(callEnter.endY, "course 75 call-enter arrow points to the deeper frame").toBeGreaterThan(
    callEnter.startY,
  );

  await prototype.locator("[data-transition-action='previous']").click();
  await expect(prototype.locator("[data-transition-progress]")).toHaveValue("0");
  await expect(edge).toHaveCount(0);
  await prototype.locator("[data-transition-progress]").fill("4");
  await expect(prototype.locator("[data-transition-progress]")).toHaveValue("4");
  await expect(edge).toHaveCount(1);
  const callExit = parseQuadraticPath(await edge.getAttribute("d"));
  expect(callExit.endY, "course 75 call-exit arrow returns to the shallower frame").toBeLessThan(
    callExit.startY,
  );
  const exitGate = await measureProductionLayoutGate(prototype);
  expect(exitGate, "course 75 first call-exit layout gate").toMatchObject({
    textOverflow: false,
    overlap: false,
    outside: false,
  });
  await prototype.screenshot({ path: join(SCREENSHOT_ROOT, "course-75-call-exit.png") });
}

async function verifyGridDependencyDirection(prototype: Locator): Promise<void> {
  const edge = prototype.locator(".foa-transition-prototype__edge");
  const progress = prototype.locator("[data-transition-progress]");
  const maximum = Number(await progress.getAttribute("max"));
  let dependencyIndex: number | null = null;
  for (let index = 2; index <= maximum; index += 1) {
    await progress.fill(String(index));
    await prototype.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    if ((await edge.count()) === 1) {
      dependencyIndex = index;
      break;
    }
  }
  expect(dependencyIndex, "course 80 exposes a dependency edge").not.toBeNull();
  await expect(edge).toHaveCount(1);
  const dependency = parseQuadraticPath(await edge.getAttribute("d"));
  const target = prototype.locator(".foa-transition-prototype__matrix-cell[data-active='true']");
  await expect(target).toHaveCount(1);
  const targetBox = await target.boundingBox();
  const canvasBox = await prototype.locator(".foa-transition-prototype__canvas").boundingBox();
  if (targetBox === null || canvasBox === null) {
    throw new Error("Course 80 dependency target geometry is missing");
  }
  const targetCenter = {
    x: targetBox.x - canvasBox.x + targetBox.width / 2,
    y: targetBox.y - canvasBox.y + targetBox.height / 2,
  };
  const startDistance = Math.hypot(
    dependency.startX - targetCenter.x,
    dependency.startY - targetCenter.y,
  );
  const endDistance = Math.hypot(
    dependency.endX - targetCenter.x,
    dependency.endY - targetCenter.y,
  );
  expect(endDistance, "course 80 dependency arrow ends at the active target").toBeLessThan(
    startDistance,
  );
  const horizontalDelta = dependency.endX - dependency.startX;
  const verticalDelta = dependency.endY - dependency.startY;
  if (Math.abs(horizontalDelta) >= Math.abs(verticalDelta)) {
    expect(horizontalDelta, "course 80 horizontal dependency points right").toBeGreaterThan(0);
  } else {
    expect(verticalDelta, "course 80 vertical dependency points down").toBeGreaterThan(0);
  }
  await prototype.screenshot({ path: join(SCREENSHOT_ROOT, "course-80-dependency.png") });
}

function parseQuadraticPath(pathData: string | null): {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
} {
  if (pathData === null) throw new Error("The runtime connection path is missing");
  const values = pathData.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  const startX = values[0];
  const startY = values[1];
  const endX = values[4];
  const endY = values[5];
  if (
    startX === undefined ||
    startY === undefined ||
    endX === undefined ||
    endY === undefined ||
    ![startX, startY, endX, endY].every(Number.isFinite)
  ) {
    throw new Error(`Unexpected quadratic path: ${pathData}`);
  }
  return { startX, startY, endX, endY };
}
