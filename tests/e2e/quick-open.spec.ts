import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every launch gets its own workspace root and Electron profile. Without them these specs
// write into the user's real Documents workspace and share one browser profile, which both
// pollutes real data and lets state leak between spec files under `workers: 1`.
const e2eWorkspaceRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-workspace-"));
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
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
      PANEL_WORKSPACE_ROOT: e2eWorkspaceRoot,
      PANEL_RUNNER_MODE: "trusted-only",
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
});

test("opens one global text search, locates a block and restores focus on Escape", async () => {
  const projects = page.getByRole("tab", { name: "项目", exact: true });
  await projects.focus();
  await page.keyboard.press("Meta+K");

  const quickOpen = page.getByRole("dialog", { name: "Quick Open" });
  await expect(quickOpen).toBeVisible();
  await expect(quickOpen.locator("img, svg")).toHaveCount(0);
  expect(await quickOpen.locator(".quick-open__result").count()).toBeGreaterThanOrEqual(21);
  await expect(quickOpen.locator("[id='quick-open-command-navigation.tutorials']")).toBeVisible();

  const search = quickOpen.getByRole("combobox", { name: "搜索工作台" });
  await search.fill("+ while");
  await expect(quickOpen.locator("[data-quick-open-kind='preset']").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(quickOpen).toBeHidden();
  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".block-palette__item")).toHaveCount(1);
  await expect(page.locator(".block-palette__item")).toContainText("while");

  await projects.focus();
  await page.keyboard.press("Meta+K");
  await page.keyboard.press("Escape");
  await expect(projects).toBeFocused();
});
