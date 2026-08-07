import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_ALGORITHM_SOURCE } from "../../src/tutorials/first-algorithm.js";
import { showRuntimePanel } from "./support/c-cell-layout.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "c-block-v6-lesson-e2e-"));
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
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
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

test("keeps the Dashboard free of the removed first-run tutorial prompt", async () => {
  await expect(page.getByRole("region", { name: "首次使用" })).toHaveCount(0);
  await expect(page.locator("#tutorials-tab")).toBeVisible();
  await expect(page.locator(".onboarding-tour")).toHaveCount(0);
  expect(await readdir(join(workspaceRoot, "Sandboxes"))).toEqual([]);
});

test("starts the guided first lesson from the explicit Library help entry", async () => {
  await page.locator('[data-menu-root-trigger="library"]').click();
  await expect(page.locator("#software-library-panel")).toBeVisible();
  await page.getByRole("button", { name: "帮助", exact: true }).click();
  await expect(
    page.locator("[data-library-branch-id='manual'][aria-current='true']"),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始第一课", exact: true }).click();

  await expect(page.locator("#build-panel")).toBeVisible();
  await expect(page.locator("#main-source-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#main-source-panel")).toBeVisible();
  await expect(page.getByRole("complementary", { name: /第一课/u })).toBeVisible();
  await expect(page.locator(".guided-lesson-rail__requirements li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "下一任务" })).toBeDisabled();
  // The case controls live in the runtime pane, which the C Cell layout keeps collapsed.
  await showRuntimePanel(page);
  await expect(page.getByRole("spinbutton", { name: "案例输入规模" })).toHaveValue("5");
  await expect(page.locator(".onboarding-tour")).toHaveCount(0);

  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.getByRole("button", { name: "下一任务" })).toBeEnabled();
  await expect(page.locator(".guided-lesson-rail__status")).toContainText("当前任务已通过");

  await page.getByRole("button", { name: "下一任务" }).click();
  await expect(page.locator(".guided-lesson-rail__title")).toHaveText("观察真实路径");
  await expect(page.locator(".guided-lesson-rail__prediction")).toContainText("非运行时变量");
  await page.getByRole("button", { name: "观察路径", exact: true }).click();
  await expect(page.getByRole("button", { name: "下一任务" })).toBeEnabled();

  const sandboxIds = await readdir(join(workspaceRoot, "Sandboxes"));
  expect(sandboxIds).toHaveLength(1);
  const sandbox = join(workspaceRoot, "Sandboxes", sandboxIds[0]!);
  expect(await readFile(join(sandbox, "main.c"), "utf8")).toBe(FIRST_ALGORITHM_SOURCE);
  await expect
    .poll(() =>
      access(join(sandbox, "tutorial-progress.json")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
});
