import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFoaWorkspaceLaunchContract } from "../../src/tutorials/foa-course-adapter.js";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";
import { showSourceEditor } from "./support/c-cell-layout.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const semanticLesson = FOA_LESSONS[0]!;
const semanticCapstoneLesson = FOA_LESSONS[59]!;
const observeLesson = FOA_LESSONS[60]!;
const longEnglishLesson = FOA_LESSONS[87]!;
const completeLesson = FOA_LESSONS[75]!;
const composeLesson = FOA_LESSONS[90]!;
const workspaceLesson = FOA_LESSONS[105]!;
const workspaceLaunch = createFoaWorkspaceLaunchContract(workspaceLesson);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-course-e2e-"));
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
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("keeps previews separate from mastery, exposes fading block stages, and launches the TODO workspace suite", async () => {
  test.setTimeout(120_000);
  expect(workspaceLaunch).not.toBeNull();
  if (workspaceLaunch === null) throw new Error("第 106 课缺少工作区启动契约");
  expect(workspaceLaunch.runtimeCase.cases).toHaveLength(3);
  const tutorialSearch = page.locator(".tutorials-module__search");

  await test.step("catalog, collapse and keyboard entry", async () => {
    await page.locator("#tutorials-tab").click();
    await expect(page.locator("#tutorials-tab")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#tutorials-panel")).toBeVisible();
    await expect(page.locator("#build-panel")).toBeHidden();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(".tutorials-module__task-rail")).toHaveCount(0);
    await expect(page.locator(".tutorials-module__chapter[open]")).toHaveCount(1);
    const tutorialWidth = await page.locator(".tutorials-module").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(tutorialWidth.scrollWidth).toBeLessThanOrEqual(tutorialWidth.clientWidth);
    await expect
      .poll(async () =>
        page.locator(".tutorials-module").evaluate((element) => {
          const selectors = [
            ".tutorials-module__catalog h2",
            ".tutorials-module__progress",
            ".tutorials-module__search",
            ".tutorials-module__chapter summary",
            ".tutorials-module__lesson",
            ".tutorials-module__lesson-order",
          ];
          return [
            ...new Set(
              selectors.flatMap((selector) => {
                const target = element.querySelector<HTMLElement>(selector);
                return target === null
                  ? []
                  : [Number.parseFloat(getComputedStyle(target).fontSize)];
              }),
            ),
          ].sort((left, right) => left - right);
        }),
      )
      .toEqual([11, 12]);
    await expect(page.locator("[data-tutorial-lesson-id]")).toHaveCount(120);

    const stageWidthBeforeCollapse = await page
      .locator(".tutorials-module__stage")
      .evaluate((element) => element.getBoundingClientRect().width);
    await page.locator("[data-tutorials-action='toggle-catalog']").click();
    await expect(page.locator(".tutorials-module")).toHaveAttribute(
      "data-catalog-collapsed",
      "true",
    );
    await expect(page.locator("[data-tutorials-action='toggle-catalog']")).toHaveAttribute(
      "aria-label",
      "展开 课程目录",
    );
    const controlledCatalogId = await page
      .locator("[data-tutorials-action='toggle-catalog']")
      .getAttribute("aria-controls");
    expect(controlledCatalogId).not.toBeNull();
    await expect(page.locator(`#${controlledCatalogId!}`)).toHaveJSProperty("tagName", "NAV");
    const stageWidthAfterCollapse = await page
      .locator(".tutorials-module__stage")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(stageWidthAfterCollapse).toBeGreaterThan(stageWidthBeforeCollapse);
    await page.locator("[data-tutorials-action='toggle-catalog']").click();

    await tutorialSearch.fill(semanticLesson.title.zh);
    await tutorialSearch.press("Enter");
    await expect(
      page.locator(".tutorials-module__stage [data-task-lesson-action='start']"),
    ).toBeFocused();
    await tutorialSearch.fill("");
  });

  await test.step("semantic evidence and block affordances", async () => {
    await selectLesson(semanticLesson.id);
    const semanticStage = page.locator(".foa-semantic-stage");
    await expect(semanticStage).toBeVisible();
    await semanticStage.locator("[data-task-lesson-action='start']").click();
    await expect(semanticStage).toHaveAttribute("data-phase", "task");
    await expect(semanticStage).toHaveAttribute("data-confirmed-events", "0");
    await tutorialSearch.fill(semanticLesson.title.zh);
    await tutorialSearch.press("Enter");
    await expect(
      semanticStage.locator(".foa-semantic-scene__node[aria-current='step']"),
    ).toHaveCount(1);
    await expect(semanticStage.locator("[data-task-lesson-action='runtime-step']")).toBeFocused();
    await tutorialSearch.fill("");

    const semanticEntry = lessonEntry(semanticLesson.id);
    await expect(semanticEntry).toHaveAttribute("data-mastery-status", "in-progress");
    await semanticStage.locator("[data-task-lesson-action='next']").click();
    await expect(semanticStage).toHaveAttribute("data-timeline-position", "1");
    await expect(semanticStage).toHaveAttribute("data-confirmed-events", "0");
    await expect(semanticStage).toHaveAttribute("data-interaction-mode", "preview");
    await expect(
      semanticStage.locator("[data-task-lesson-action='return-to-current']"),
    ).toBeVisible();
    await expect(semanticEntry).not.toHaveAttribute("data-mastery-status", "mastered");

    const eventIds = await semanticStage
      .locator(".foa-semantic-scene__node")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.eventId ?? ""));
    expect(eventIds.length).toBeGreaterThanOrEqual(2);
    await semanticStage.locator("[data-task-lesson-action='return-to-current']").click();
    await expect(semanticStage).toHaveAttribute("data-interaction-mode", "act");
    const sourceHeightBefore = await semanticStage
      .locator(".teaching-source-view")
      .evaluate((element) => element.getBoundingClientRect().height);
    const semanticWorkspaceHeight = await semanticStage
      .locator(".foa-semantic-stage__workspace")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(semanticWorkspaceHeight).toBeGreaterThan(sourceHeightBefore);
    const tutorialDensity = await semanticStage.evaluate((element) => {
      const stage = element.closest<HTMLElement>(".tutorials-module__stage");
      const source = element.querySelector<HTMLElement>(".teaching-source-view");
      const scene = element.querySelector<HTMLElement>(".foa-semantic-scene");
      const diagram = element.querySelector<HTMLElement>(".foa-semantic-scene__diagram");
      const evidence = element.querySelector<HTMLElement>(".foa-semantic-scene__evidence");
      const nodes = [...element.querySelectorAll<HTMLElement>(".foa-semantic-scene__node")];
      const sourceHeader = element.querySelector<HTMLElement>(".teaching-source-view > header");
      const splitter = element.querySelector<HTMLElement>(".foa-semantic-stage__source-splitter");
      if (
        stage === null ||
        source === null ||
        scene === null ||
        diagram === null ||
        evidence === null ||
        nodes.length !== 4 ||
        sourceHeader === null ||
        splitter === null
      ) {
        throw new Error("FOA tutorial density targets are missing");
      }
      const typeTargets = [
        ".foa-semantic-scene__boundary",
        ".foa-semantic-scene__channels",
        ".foa-semantic-scene__node-order",
        ".foa-semantic-scene__node strong",
        ".foa-semantic-scene__node-status",
        ".teaching-source-view > header strong",
        ".teaching-source-view > header span",
        ".teaching-source-view__toggle",
        ".teaching-source-view code",
      ];
      const typeSizes = typeTargets.flatMap((selector) => {
        const target = element.querySelector<HTMLElement>(selector);
        return target === null ? [] : [Number.parseFloat(getComputedStyle(target).fontSize)];
      });
      const stageBounds = stage.getBoundingClientRect();
      const rootBounds = element.getBoundingClientRect();
      const sourceBounds = source.getBoundingClientRect();
      const evidenceBounds = evidence.getBoundingClientRect();
      const diagramBounds = diagram.getBoundingClientRect();
      const nodeBounds = nodes.map((node) => node.getBoundingClientRect());
      const overlaps = nodeBounds.flatMap((left, leftIndex) =>
        nodeBounds.slice(leftIndex + 1).filter((right) => {
          const horizontal = Math.min(left.right, right.right) - Math.max(left.left, right.left);
          const vertical = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
          return horizontal > 1 && vertical > 1;
        }),
      ).length;
      return {
        rootBottomGap: Math.abs(stageBounds.bottom - rootBounds.bottom),
        sourceBottomGap: Math.abs(rootBounds.bottom - sourceBounds.bottom),
        typeSizes: [...new Set(typeSizes)].sort((left, right) => left - right),
        evidenceBeforeDiagram: evidenceBounds.bottom <= diagramBounds.top + 1,
        sceneOverflow: scene.scrollWidth - scene.clientWidth,
        diagramOverflow: diagram.scrollWidth - diagram.clientWidth,
        nodeOverlaps: overlaps,
        sourceBorder: getComputedStyle(source).borderBottomWidth,
        sourceHeaderBorder: getComputedStyle(sourceHeader).borderBottomWidth,
        splitterBorder: getComputedStyle(splitter).borderTopWidth,
        splitterHandleWidth: getComputedStyle(splitter, "::after").width,
        nodeBorder: getComputedStyle(nodes[0]!).borderBottomWidth,
      };
    });
    expect(tutorialDensity.rootBottomGap).toBeLessThanOrEqual(1);
    expect(tutorialDensity.sourceBottomGap).toBeLessThanOrEqual(1);
    expect(tutorialDensity.typeSizes).toEqual(expect.arrayContaining([11, 12]));
    expect(tutorialDensity.typeSizes.every((size) => [11, 12, 13].includes(size))).toBe(true);
    expect(tutorialDensity.typeSizes.length).toBeLessThanOrEqual(3);
    expect(tutorialDensity.evidenceBeforeDiagram).toBe(true);
    expect(tutorialDensity.sceneOverflow).toBeLessThanOrEqual(1);
    expect(tutorialDensity.diagramOverflow).toBeLessThanOrEqual(1);
    expect(tutorialDensity.nodeOverlaps).toBe(0);
    expect(tutorialDensity.sourceBorder).toBe("0px");
    expect(tutorialDensity.sourceHeaderBorder).toBe("0px");
    expect(tutorialDensity.splitterBorder).toBe("0px");
    expect(tutorialDensity.splitterHandleWidth).toBe("32px");
    expect(tutorialDensity.nodeBorder).not.toBe("0px");
    const sourceSplitter = semanticStage.locator("[data-task-lesson-action='resize-source']");
    const splitterBounds = await sourceSplitter.boundingBox();
    expect(splitterBounds).not.toBeNull();
    await page.mouse.move(splitterBounds!.x + splitterBounds!.width / 2, splitterBounds!.y + 3);
    await page.mouse.down();
    await page.mouse.move(splitterBounds!.x + splitterBounds!.width / 2, splitterBounds!.y - 48);
    await page.mouse.up();
    const sourceHeightAfter = await semanticStage
      .locator(".teaching-source-view")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(sourceHeightAfter).toBeGreaterThan(sourceHeightBefore + 30);
    await semanticToken(semanticStage, eventIds[1]!).click();
    await expect(semanticStage).toHaveAttribute("data-confirmed-events", "0");
    await expect(semanticStage.locator(".foa-semantic-stage__feedback")).toHaveAttribute(
      "data-kind",
      "incorrect",
    );
    await expect(semanticEntry).not.toHaveAttribute("data-mastery-status", "mastered");

    for (const eventId of eventIds) await semanticToken(semanticStage, eventId).click();
    await expect(semanticStage).toHaveAttribute("data-phase", "completed");
    await expect(semanticEntry).toHaveAttribute("data-mastery-status", "mastered");

    await selectLesson(semanticCapstoneLesson.id);
    await expect(page.locator(".library-task-lesson")).toBeVisible();
    await expect(page.getByRole("heading", { name: "插入排序：连续语义实验" })).toBeVisible();
    const insertionStage = page.locator(".library-task-lesson--v2");
    await insertionStage.locator("[data-task-lesson-action='start']").click();
    const readableType = await insertionStage.evaluate((element) => {
      const progress = element.querySelector<HTMLElement>(".library-task-stage__progress li");
      const keyTray = element.querySelector<HTMLElement>(".library-task-stage__key-tray");
      const slot = element.querySelector<HTMLElement>(".library-task-stage__slot");
      if (progress === null || keyTray === null || slot === null) {
        throw new Error("Insertion-sort typography targets are missing");
      }
      return {
        progress: Number.parseFloat(getComputedStyle(progress).fontSize),
        keyTray: Number.parseFloat(getComputedStyle(keyTray).fontSize),
        slotIndex: Number.parseFloat(getComputedStyle(slot, "::after").fontSize),
      };
    });
    expect(readableType.progress).toBeGreaterThanOrEqual(11);
    expect(readableType.keyTray).toBeGreaterThanOrEqual(10);
    expect(readableType.slotIndex).toBeGreaterThanOrEqual(10);

    await selectLesson(observeLesson.id);
    const observeStage = page.locator(".foa-block-stage");
    await expect(observeStage).toHaveAttribute("data-mode", "block-observe");
    await observeStage.locator("[data-task-lesson-action='start']").click();
    await expect(observeStage).toHaveAttribute("data-phase", "task");
    await expect(observeStage.locator("[data-block-role='sequence']")).toHaveCount(
      observeLesson.semanticEvents.length,
    );
    await expect(observeStage.locator("[data-block-role='sequence']").first()).not.toHaveAttribute(
      "draggable",
      "true",
    );
    await expect(observeStage.locator("[data-block-role='sequence']").first()).toHaveCSS(
      "cursor",
      "pointer",
    );

    await selectLesson(completeLesson.id);
    const completeStage = page.locator(".foa-block-stage");
    await expect(completeStage).toHaveAttribute("data-mode", "block-complete");
    await completeStage.locator("[data-task-lesson-action='start']").click();
    await expect(completeStage).toHaveAttribute("data-phase", "task");
    await expect(completeStage.locator("[data-task-lesson-action='block-gap']")).toBeVisible();

    await selectLesson(composeLesson.id);
    const composeStage = page.locator(".foa-block-stage");
    await expect(composeStage).toHaveAttribute("data-mode", "block-compose");
    await composeStage.locator("[data-task-lesson-action='start']").click();
    await expect(composeStage).toHaveAttribute("data-phase", "task");
    await expect(
      composeStage.locator("[data-task-lesson-action='verify-composition']"),
    ).toBeVisible();
  });

  await test.step("locale, narrow layout and themed interaction states", async () => {
    const localizedComposeStage = page.locator(".foa-block-stage");
    await page.locator("[data-menu-root-trigger]").filter({ hasText: "设置" }).click();
    await page
      .getByRole("menu", { name: "设置" })
      .getByRole("menuitem", { name: "通用", exact: true })
      .click();
    await page.locator("#interface-language").selectOption("en");
    await expect(page.locator(".tutorials-module")).toHaveAttribute(
      "aria-label",
      "Algorithm Tutorials",
    );
    const catalogHeaderLayout = await page
      .locator(".tutorials-module__catalog > header")
      .evaluate((header) => {
        const title = header.querySelector<HTMLElement>("h2");
        const progress = header.querySelector<HTMLElement>(".tutorials-module__progress");
        const toggle = header.querySelector<HTMLElement>(".tutorials-module__catalog-toggle");
        if (title === null || progress === null || toggle === null) {
          throw new Error("Tutorial catalog header is incomplete");
        }
        const titleBox = title.getBoundingClientRect();
        const progressBox = progress.getBoundingClientRect();
        const toggleBox = toggle.getBoundingClientRect();
        return {
          titleRight: titleBox.right,
          toggleLeft: toggleBox.left,
          titleBottom: titleBox.bottom,
          progressTop: progressBox.top,
        };
      });
    expect(catalogHeaderLayout.titleRight).toBeLessThanOrEqual(catalogHeaderLayout.toggleLeft);
    expect(catalogHeaderLayout.titleBottom).toBeLessThanOrEqual(catalogHeaderLayout.progressTop);
    await expect(localizedComposeStage.locator(".foa-block-stage__instruction")).toContainText(
      composeLesson.experience.primaryAction.en,
    );
    await expect(
      localizedComposeStage.locator("[data-task-lesson-action='verify-composition']"),
    ).toHaveText("Verify order");
    await page.locator("#workbench-drawer-close").click();

    const longEnglishEntry = lessonEntry(longEnglishLesson.id);
    await longEnglishEntry.evaluate((element) => {
      const chapter = element.closest("details");
      if (chapter !== null) chapter.open = true;
    });
    await longEnglishEntry.focus();
    await page.keyboard.press("Space");
    await expect(longEnglishEntry).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".foa-block-stage [data-task-lesson-action='start']")).toBeFocused();
    const longEnglishStage = page.locator(".foa-block-stage");
    await longEnglishStage.locator("[data-task-lesson-action='start']").click();
    const longEnglishLayout = await longEnglishStage.evaluate((element) => {
      const header = element.querySelector<HTMLElement>(".foa-block-stage__header");
      const workspace = element.querySelector<HTMLElement>(".foa-block-stage__workspace");
      const title = element.querySelector<HTMLElement>(".foa-block-stage__header > strong");
      const reset = element.querySelector<HTMLElement>("[data-task-lesson-action='reset']");
      if (header === null || workspace === null || title === null || reset === null) {
        throw new Error("FOA block layout is incomplete");
      }
      const headerBox = header.getBoundingClientRect();
      const workspaceBox = workspace.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const resetBox = reset.getBoundingClientRect();
      return {
        headerBottom: headerBox.bottom,
        workspaceTop: workspaceBox.top,
        titleRight: titleBox.right,
        resetLeft: resetBox.left,
        clientWidth: header.clientWidth,
        scrollWidth: header.scrollWidth,
      };
    });
    expect(longEnglishLayout.headerBottom).toBeLessThanOrEqual(longEnglishLayout.workspaceTop + 1);
    expect(longEnglishLayout.titleRight).toBeLessThanOrEqual(longEnglishLayout.resetLeft);
    expect(longEnglishLayout.scrollWidth).toBeLessThanOrEqual(longEnglishLayout.clientWidth);
    const tutorialThemeColors = await longEnglishStage.evaluate((element) => {
      const root = document.documentElement;
      const original = root.dataset.theme;
      root.dataset.theme = "light";
      const light = getComputedStyle(element).backgroundColor;
      root.dataset.theme = "dark";
      const dark = getComputedStyle(element).backgroundColor;
      root.dataset.theme = original ?? "light";
      return { light, dark };
    });
    expect(tutorialThemeColors.dark).not.toBe(tutorialThemeColors.light);
    expect(tutorialThemeColors.dark).not.toBe("rgb(255, 255, 255)");

    await selectLesson(completeLesson.id);
    const darkStateStage = page.locator(".foa-block-stage");
    await darkStateStage.locator("[data-task-lesson-action='start']").click();
    const previousTheme = await page.evaluate(
      () => document.documentElement.dataset.theme ?? "light",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await darkStateStage.evaluate((element) => {
      element.dataset.draggingEventId = "theme-check";
    });
    const darkGapTheme = await darkStateStage.evaluate((element) => {
      const gap = element.querySelector<HTMLElement>(".foa-block-stage__gap");
      if (gap === null) throw new Error("Block gap is unavailable");
      const probe = document.createElement("span");
      probe.style.background = "var(--accent-soft)";
      element.append(probe);
      const actual = getComputedStyle(gap).backgroundColor;
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { actual, expected };
    });
    expect(darkGapTheme.actual).toBe(darkGapTheme.expected);
    await darkStateStage.evaluate((element) => {
      delete element.dataset.draggingEventId;
    });
    await darkStateStage.locator("[data-block-role='candidate']").nth(1).click();
    const darkFeedbackTheme = await darkStateStage.evaluate((element) => {
      const feedback = element.querySelector<HTMLElement>(".foa-block-stage__feedback");
      if (feedback === null) throw new Error("Block feedback is unavailable");
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      element.append(probe);
      const actual = getComputedStyle(feedback).color;
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual, expected };
    });
    expect(darkFeedbackTheme.actual).toBe(darkFeedbackTheme.expected);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, previousTheme);
  });

  await test.step("workspace lesson launch and runtime case handoff", async () => {
    await selectLesson(workspaceLesson.id);
    const workspaceTask = page.locator(".foa-task-lesson");
    await expect(workspaceTask).toBeVisible();
    await workspaceTask.locator("[data-task-lesson-action='start']").click();
    await expect(workspaceTask).toHaveAttribute("data-phase", "task");
    await expect(workspaceTask.locator(".foa-task-lesson__source")).toContainText("TODO:");
    await workspaceTask.locator("[data-task-lesson-action='open-workspace']").click();

    await expect(page.locator("#build-panel")).toBeVisible();
    // The runtime actions nav is hidden while the centre column shows the C Cell prompt.
    await showSourceEditor(page);
    await expect(page.locator("#trace-primary-action")).toBeVisible();
    await expect.poll(async () => (await readdir(join(workspaceRoot, "Sandboxes"))).length).toBe(1);

    const sandboxIds = await readdir(join(workspaceRoot, "Sandboxes"));
    const sandboxId = sandboxIds[0];
    if (sandboxId === undefined) throw new Error("第 106 课没有创建教学沙箱");
    const writtenSource = await readFile(
      join(workspaceRoot, "Sandboxes", sandboxId, "main.c"),
      "utf8",
    );
    expect(writtenSource).toBe(workspaceLaunch.initialSource);
    expect(writtenSource).toContain("TODO:");
    expect(writtenSource).not.toBe(workspaceLesson.code.text);
    await expect(page.locator("#code-pane .cm-content")).toContainText("TODO:");

    const manualInput = page.locator("#manual-run-input-host .manual-run-input");
    await expect(manualInput).toBeVisible();
    await manualInput.locator(".manual-run-input__toggle").click();
    const stdin = manualInput.locator(".manual-run-input__stdin");
    await expect(stdin).toHaveValue(workspaceLaunch.runtimeCase.cases[0]!.stdin);
    expect(await stdin.inputValue()).not.toBe(workspaceLaunch.runtimeCase.cases[1]!.stdin);
  });
});

function lessonEntry(lessonId: string): Locator {
  return page.locator(`[data-tutorial-lesson-id="${lessonId}"]`);
}

async function selectLesson(lessonId: string): Promise<void> {
  const catalogToggle = page.locator("[data-tutorials-action='toggle-catalog']");
  if ((await catalogToggle.getAttribute("aria-expanded")) === "false") {
    await catalogToggle.click();
  }
  const entry = lessonEntry(lessonId);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
}

function semanticToken(stage: Locator, eventId: string): Locator {
  return stage.locator(`.foa-semantic-scene__node[data-event-id="${eventId}"]`);
}
