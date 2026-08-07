import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-insertion-task-e2e-"));
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
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("completes the stable semantic lesson without entering the workbench or writing a project", async () => {
  test.setTimeout(60_000);
  await page.locator("[data-menu-root-trigger]").filter({ hasText: "Library" }).click();
  await expect(page.locator("#software-library-panel")).toBeVisible();
  await page.locator("[data-library-filter-id='examples']").click();
  await page.locator("[data-library-entry-id='tutorial.insertion-sort-lab']").click();

  const tutorialLink = page.locator(".software-library__tutorial-module-link");
  await expect(tutorialLink).toBeVisible();
  const tutorialLinkHeight = await tutorialLink.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(tutorialLinkHeight).toBeLessThanOrEqual(34);
  const tutorialEntryGap = await tutorialLink.evaluate((element) => {
    const lesson = element.nextElementSibling;
    if (!(lesson instanceof HTMLElement)) throw new Error("Tutorial lesson follows no link");
    return lesson.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });
  expect(tutorialEntryGap).toBeLessThanOrEqual(1);
  await expect(page.getByRole("heading", { name: "插入排序：连续语义实验" })).toBeVisible();
  await expect(page.locator("[data-copy-key='intro-boundary']")).toContainText("不写入项目");
  const root = page.locator("#software-library-panel .library-task-lesson");
  await root.locator("[data-task-lesson-action='start']").click();
  await expect(root).toHaveAttribute("data-task-lesson-stage", "observe");
  await expect(root).toHaveAttribute("data-task-lesson-phase", "task");
  const sourceView = root.locator(".teaching-source-view");
  await expect(sourceView).toBeVisible();
  await expect(sourceView.locator("[data-source-line]")).toHaveCount(9);
  await expect(sourceView).toHaveAttribute("data-active-source-line", "21");
  await expect(sourceView.locator("pre")).toHaveAttribute("role", "region");
  await expect(sourceView.locator("[aria-current='step']")).toHaveCount(1);
  await rememberFirstTeachingSourceLine(root);
  await expectTimelineControlSynchronized(root);
  const evidenceDensity = await root.evaluate((element) => {
    const tray = element.querySelector<HTMLElement>(".insertion-sort-stage__key-tray");
    const board = element.querySelector<HTMLElement>(".insertion-sort-stage__array");
    const facts = element.querySelector<HTMLElement>(".insertion-sort-stage__facts");
    const rows = [...(facts?.children ?? [])] as HTMLElement[];
    if (tray === null || board === null || facts === null || rows.length !== 4) {
      throw new Error("Insertion-sort density targets are unavailable");
    }
    return {
      trayWidth: tray.getBoundingClientRect().width,
      boardWidth: board.getBoundingClientRect().width,
      trayOverflow: tray.scrollWidth - tray.clientWidth,
      factsOverflow: facts.scrollWidth - facts.clientWidth,
      rowBorders: rows.map((row) => getComputedStyle(row).borderRightWidth),
    };
  });
  expect(evidenceDensity.trayWidth).toBeLessThan(evidenceDensity.boardWidth * 0.6);
  expect(evidenceDensity.trayWidth).toBeLessThanOrEqual(168);
  expect(evidenceDensity.trayOverflow).toBeLessThanOrEqual(1);
  expect(evidenceDensity.factsOverflow).toBeLessThanOrEqual(1);
  expect(evidenceDensity.rowBorders).toEqual(["0px", "0px", "0px", "0px"]);

  await root.locator("[data-task-lesson-action='rate-2']").click();
  await root.locator("[data-task-lesson-action='play-pause']").click();
  await expect(root).toHaveAttribute("data-playback-state", "playing");
  await expect(root).toHaveAttribute("data-timeline-position", "1");
  await expectTimelineControlSynchronized(root);
  await page.waitForTimeout(650);
  await expect(root).toHaveAttribute("data-timeline-position", "1");
  await focusLessonRoot(root);
  await page.keyboard.press("Space");
  await expect(root).toHaveAttribute("data-playback-state", "paused");
  await root.locator("[data-task-lesson-action='rate-1']").click();
  await root.locator("[data-task-lesson-input='timeline']").evaluate((input) => {
    const range = input as HTMLInputElement;
    range.value = "0";
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expectTimelineControlSynchronized(root);

  const initialPosition = Number(await root.getAttribute("data-timeline-position"));
  const initialTokenIds = await teachingTokenIds(root);
  await rememberFirstTeachingToken(root);

  await page.keyboard.press("ArrowRight");
  await expect(root).toHaveAttribute("data-timeline-position", String(initialPosition + 1));
  await expectTimelineControlSynchronized(root);
  await expect(sourceView).toHaveAttribute("data-active-source-line", "23");
  await expectStableTeachingTokens(root, initialTokenIds);
  await page.keyboard.press("ArrowLeft");
  await expect(root).toHaveAttribute("data-timeline-position", String(initialPosition));
  await expectTimelineControlSynchronized(root);
  await expect(sourceView).toHaveAttribute("data-active-source-line", "21");
  await expectStableTeachingTokens(root, initialTokenIds);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("ArrowRight");
  await expect(sourceView).toHaveAttribute("data-active-source-line", "23");
  await page.waitForTimeout(30);
  await expect(sourceView).toHaveAttribute("data-active-source-line", "23");
  await page.keyboard.press("ArrowLeft");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const seek = root.locator("[data-task-lesson-input='timeline']");
  const seekTarget = Math.min(Number(await seek.getAttribute("max")), initialPosition + 2);
  await seek.evaluate((input, value) => {
    const range = input as HTMLInputElement;
    range.value = String(value);
    range.dispatchEvent(new Event("input", { bubbles: true }));
  }, seekTarget);
  await expect(root).toHaveAttribute("data-timeline-position", String(seekTarget));
  await expectTimelineControlSynchronized(root);
  await expectStableTeachingTokens(root, initialTokenIds);
  await expectStableTeachingSourceLine(root);

  await root.locator("[data-task-lesson-action='rate-1.5']").click();
  await expect(root).toHaveAttribute("data-playback-rate", "1.5");
  await root.locator("[data-task-lesson-action='rate-1']").click();
  await expect(root).toHaveAttribute("data-playback-rate", "1");
  await root.locator("[data-task-lesson-action='rate-1.5']").click();
  await focusLessonRoot(root);
  await page.keyboard.press("Space");
  await expect
    .poll(() => root.getAttribute("data-task-lesson-stage"), { timeout: 10_000 })
    .toBe("practice");
  await expectTimelineControlSynchronized(root);

  const practicePosition = await root.getAttribute("data-timeline-position");
  const practiceTokenIds = await teachingTokenIds(root);
  await rememberFirstTeachingToken(root);
  await selectInterfaceLanguage(page, "en");
  await expect(root).toHaveAttribute("data-timeline-position", practicePosition ?? "");
  await expectTimelineControlSynchronized(root);
  await expectStableTeachingTokens(root, practiceTokenIds);
  await expect(root.locator(".library-task-stage__prompt h2")).toHaveText(
    "Complete the next round",
  );
  await expect(sourceView.locator("pre")).toHaveAttribute(
    "aria-label",
    "Live code · synced with the current semantic action",
  );
  await expectStableTeachingSourceLine(root);
  await expect(root).not.toContainText(/[\u3400-\u9fff]/u);

  await completeManualStage(root, "practice", "transfer");
  await completeManualStage(root, "transfer", "experiment");

  await expect(root).toHaveAttribute("data-playback-rate", "1.5");
  const customValues = root.locator("[data-task-lesson-input='custom-values']");
  await expect(customValues).toHaveValue("9, 3, 7, 1");
  await customValues.fill("2, 1");
  await root.locator("[data-task-lesson-action='rate-2']").click();
  await root.locator("[data-task-lesson-action='run-experiment']").click();
  await expect
    .poll(() => root.getAttribute("data-task-lesson-stage"), { timeout: 25_000 })
    .toBe("reflect");
  await root.locator("[data-task-lesson-action='reflect-key-snapshot']").click();
  await root.locator("[data-task-lesson-action='reflect-reverse']").click();

  await expect(page.getByRole("heading", { name: "Insertion-sort lab complete" })).toBeVisible();
  await expect(page.getByText("Matches the textbook adjacent-swap template · 5/5")).toBeVisible();
  await expect(page.locator("#build-panel")).toBeHidden();
  await expect(page.locator("[data-task-lesson-action='replay-lesson']")).toBeVisible();

  expect(await readdir(join(workspaceRoot, "Projects"))).toEqual([]);
  expect(await readdir(join(workspaceRoot, "Sandboxes"))).toEqual([]);
  expect(await readdir(join(workspaceRoot, "Tests"))).toEqual([]);
});

async function focusLessonRoot(root: ReturnType<Page["locator"]>): Promise<void> {
  await root.evaluate((element) => {
    const host = element as HTMLElement;
    host.tabIndex = -1;
    host.focus();
  });
}

async function teachingTokenIds(root: ReturnType<Page["locator"]>): Promise<readonly string[]> {
  return root
    .locator("[data-teaching-token-id]")
    .evaluateAll((tokens) =>
      tokens.map((token) => (token as HTMLElement).dataset.teachingTokenId ?? ""),
    );
}

async function rememberFirstTeachingToken(root: ReturnType<Page["locator"]>): Promise<void> {
  await root.evaluate((element) => {
    const token = element.querySelector("[data-teaching-token-id]");
    if (token === null) throw new Error("Teaching token is unavailable");
    (
      globalThis as typeof globalThis & { __insertionLessonToken?: Element }
    ).__insertionLessonToken = token;
  });
}

async function expectStableTeachingTokens(
  root: ReturnType<Page["locator"]>,
  expectedIds: readonly string[],
): Promise<void> {
  expect(await teachingTokenIds(root)).toEqual(expectedIds);
  expect(
    await root.evaluate((element) => {
      const remembered = (globalThis as typeof globalThis & { __insertionLessonToken?: Element })
        .__insertionLessonToken;
      return (
        remembered !== undefined && remembered === element.querySelector("[data-teaching-token-id]")
      );
    }),
  ).toBe(true);
}

async function rememberFirstTeachingSourceLine(root: ReturnType<Page["locator"]>): Promise<void> {
  await root.evaluate((element) => {
    const line = element.querySelector(".teaching-source-view [data-source-line]");
    if (line === null) throw new Error("Teaching source line is unavailable");
    (
      globalThis as typeof globalThis & { __insertionLessonSourceLine?: Element }
    ).__insertionLessonSourceLine = line;
  });
}

async function expectStableTeachingSourceLine(root: ReturnType<Page["locator"]>): Promise<void> {
  expect(
    await root.evaluate((element) => {
      const remembered = (
        globalThis as typeof globalThis & { __insertionLessonSourceLine?: Element }
      ).__insertionLessonSourceLine;
      return (
        remembered !== undefined &&
        remembered === element.querySelector(".teaching-source-view [data-source-line]")
      );
    }),
  ).toBe(true);
}

async function expectTimelineControlSynchronized(root: ReturnType<Page["locator"]>): Promise<void> {
  const state = await root.locator("[data-task-lesson-input='timeline']").evaluate((element) => {
    const input = element as HTMLInputElement;
    const visible = input.closest("label")?.querySelector("span")?.textContent ?? "";
    const match = /(\d+)\s*\/\s*(\d+)\s*$/u.exec(visible);
    return {
      value: input.value,
      minimum: input.min,
      maximum: input.max,
      ariaMinimum: input.getAttribute("aria-valuemin"),
      ariaMaximum: input.getAttribute("aria-valuemax"),
      ariaNow: input.getAttribute("aria-valuenow"),
      ariaText: input.getAttribute("aria-valuetext"),
      visibleCurrent: match?.[1] ?? null,
      visibleMaximum: match?.[2] ?? null,
    };
  });
  expect(state.minimum).toBe("0");
  expect(state.value).toBe(state.ariaNow);
  expect(state.value).toBe(state.visibleCurrent);
  expect(state.maximum).toBe(state.ariaMaximum);
  expect(state.maximum).toBe(state.visibleMaximum);
  expect(state.ariaMinimum).toBe("0");
  expect(state.ariaText).toBe(`${state.value} / ${state.maximum}`);
}

async function completeManualStage(
  root: ReturnType<Page["locator"]>,
  currentStage: "practice" | "transfer",
  nextStage: "transfer" | "experiment",
): Promise<void> {
  for (let guard = 0; guard < 80; guard += 1) {
    const stage = await root.getAttribute("data-task-lesson-stage");
    if (stage === nextStage) {
      await expectTimelineControlSynchronized(root);
      return;
    }
    expect(stage).toBe(currentStage);
    await expectTimelineControlSynchronized(root);

    const prediction = root.locator(".library-task-stage__prediction:not([hidden])");
    if ((await prediction.count()) > 0 && (await prediction.isVisible())) {
      const expression = (await prediction.locator("strong").textContent()) ?? "";
      const match = /(-?\d+)\s*>\s*(-?\d+)/u.exec(expression);
      if (match === null) throw new Error(`Cannot read comparison: ${expression}`);
      const shouldShift = Number(match[1]) > Number(match[2]);
      await root
        .locator(`[data-task-lesson-action='${shouldShift ? "predict-shift" : "predict-stop"}']`)
        .click();
      continue;
    }

    const keyTray = root.locator("[data-task-lesson-action='key-tray']");
    if ((await keyTray.getAttribute("data-drop-state")) === "compatible") {
      await root.locator("[data-teaching-token-id][data-state='active']").click();
      await keyTray.click();
      continue;
    }

    const compatibleHole = root.locator("[data-teaching-slot-index][data-drop-state='compatible']");
    if ((await compatibleHole.count()) > 0) {
      await root
        .locator(
          "[data-teaching-token-id][data-state='active'], [data-teaching-token-id][data-state='key']",
        )
        .first()
        .click();
      await compatibleHole.click();
      continue;
    }

    await root.page().waitForTimeout(100);
  }
  throw new Error(`Lesson did not advance from ${currentStage} to ${nextStage}`);
}

async function selectInterfaceLanguage(page: Page, locale: "zh-CN" | "en"): Promise<void> {
  await page.evaluate((nextLocale) => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    if (language === null) throw new Error("Interface language control is unavailable");
    language.value = nextLocale;
    language.dispatchEvent(new Event("change", { bubbles: true }));
  }, locale);
}
