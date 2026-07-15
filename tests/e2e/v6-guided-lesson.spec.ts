import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_ALGORITHM_SOURCE } from "../../src/tutorials/first-algorithm.js";

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "c-block-v6-lesson-e2e-"));
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  application = await electron.launch({
    args: ["."],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
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

test("remembers direct entry without creating a tutorial workspace", async () => {
  const start = page.getByRole("region", { name: "首次使用" });
  await expect(start).toBeVisible();
  await start.getByRole("button", { name: "直接进入工作台" }).click();
  await expect(page.locator("#build-panel")).toBeVisible();
  await expect(page.locator(".onboarding-tour")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      globalThis.localStorage.getItem("c-block-algorithm-panel:first-run-v6"),
    ),
  ).toBe("direct");
  expect(await readdir(join(workspaceRoot, "Sandboxes"))).toEqual([]);
});

test("atomically creates the first lesson and mounts the evidence task rail", async () => {
  await page.evaluate(() =>
    globalThis.localStorage.removeItem("c-block-algorithm-panel:first-run-v6"),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  const start = page.getByRole("region", { name: "首次使用" });
  await start.getByRole("button", { name: "开始第一课 · 扫描求最大值" }).click();

  await expect(page.locator("#build-panel")).toBeVisible();
  await expect(page.getByRole("complementary", { name: /第一课/u })).toBeVisible();
  await expect(page.locator(".guided-lesson-rail__requirements li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "下一任务" })).toBeDisabled();
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
