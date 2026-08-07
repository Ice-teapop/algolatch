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

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-root-zoom-"));
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
  await setZoomFactor(1).catch(() => undefined);
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("keeps the Dock and late-course tutorials inside the document at 150% zoom", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await setZoomFactor(1.5);

  await expectDocumentToOwnNoHorizontalScroll("dashboard");
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();

  for (const order of [81, 106, 119] as const) {
    const lesson = FOA_LESSONS[order - 1];
    if (lesson === undefined) throw new Error(`FOA lesson ${String(order)} is missing`);
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
    await expectDocumentToOwnNoHorizontalScroll(`course ${String(order)}`);
  }

  await page.locator("#build-tab").click();
  await expect(page.locator("#build-panel")).toBeVisible();
  await expectDocumentToOwnNoHorizontalScroll("build");
  const builderOverflow = await page.locator("#build-panel").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  // The builder used to carry a 760px minimum width and own a horizontal scrollbar; the
  // C Cell layout fits any width instead, so the contract is that the page contains its
  // own content and can never leak overflow up to the document.
  expect(builderOverflow.overflowX).not.toBe("visible");
  expect(builderOverflow.scrollWidth).toBeLessThanOrEqual(builderOverflow.clientWidth + 1);
});

async function expectDocumentToOwnNoHorizontalScroll(label: string): Promise<void> {
  const geometry = await page.evaluate(() => {
    const scrolling = document.scrollingElement;
    const dock = document.querySelector<HTMLElement>("#workbench-dock");
    const appBar = document.querySelector<HTMLElement>(".app-bar");
    if (scrolling === null || dock === null || appBar === null) {
      throw new Error("Root responsive geometry is unavailable");
    }
    const dockBounds = dock.getBoundingClientRect();
    const appBarBounds = appBar.getBoundingClientRect();
    return {
      clientWidth: scrolling.clientWidth,
      scrollWidth: scrolling.scrollWidth,
      scrollX: globalThis.scrollX,
      dockLeft: dockBounds.left,
      dockRight: dockBounds.right,
      appBarLeft: appBarBounds.left,
      appBarRight: appBarBounds.right,
    };
  });
  expect(geometry.scrollWidth, label).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollX, label).toBe(0);
  expect(geometry.dockLeft, label).toBeGreaterThanOrEqual(-1);
  expect(geometry.dockRight, label).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.appBarLeft, label).toBeGreaterThanOrEqual(-1);
  expect(geometry.appBarRight, label).toBeLessThanOrEqual(geometry.clientWidth + 1);
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
