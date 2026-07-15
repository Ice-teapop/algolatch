import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";
let projectId = "";

// Later cases intentionally reuse the project created by the first case. Stop
// after a prerequisite failure instead of restarting a fresh worker and
// emitting misleading entry.json/editor cascade errors.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "c-block-dashboard-e2e-"));
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
  await page.evaluate(() => {
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#startup-loader")).toBeHidden();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("starts on an empty, dense Dashboard instead of silently loading a demo", async () => {
  await expect(page.getByRole("tab", { name: "项目" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".workspace-dashboard")).toBeVisible();
  await expect(page.getByText("这里还没有本地条目。")).toBeVisible();
  await expect(page.locator(".cm-line")).toHaveText([""]);
  await expect(page.locator(".workspace-dashboard__sidebar")).toHaveCSS("width", "188px");
  await expect(page.getByRole("button", { name: "项目", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "沙箱", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "测试", exact: true })).toBeVisible();
});

test("creates a real project folder, enters the workbench and reopens it after reload", async () => {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作区条目" });
  await dialog.getByRole("combobox", { name: "条目类型" }).selectOption("project");
  await dialog.getByRole("textbox", { name: "条目名称" }).fill("二分搜索");
  await dialog.getByRole("button", { name: "创建并打开" }).click();

  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#file-name")).toHaveText("二分搜索.c");
  await expect(page.locator(".cm-line")).toHaveText(["int main(void) {", "  return 0;", "}", ""]);

  const projectIds = await readdir(join(workspaceRoot, "Projects"));
  expect(projectIds).toHaveLength(1);
  projectId = projectIds[0] ?? "";
  if (projectId.length === 0) throw new Error("项目目录不存在");
  expect(await readFile(join(workspaceRoot, "Projects", projectId, "main.c"), "utf8")).toBe(
    "int main(void) {\n  return 0;\n}\n",
  );

  const editedSource = "int main(void) {\n  return 42;\n}\n";
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(editedSource);
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "saved");
  await expect
    .poll(() => readFile(join(workspaceRoot, "Projects", projectId, "main.c"), "utf8"))
    .toBe(editedSource);

  await reloadThroughApplicationLifecycle();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.getByRole("tab", { name: "项目" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const projectRow = page.getByRole("link", { name: "打开项目“二分搜索”" });
  await projectRow.focus();
  await expect(projectRow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#file-name")).toHaveText("二分搜索.c");
  await expect(page.locator(".cm-line")).toHaveText(["int main(void) {", "  return 42;", "}", ""]);
  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await reloadThroughApplicationLifecycle();
  await expect(page.locator("#startup-loader")).toBeHidden();
  const rowAfterReload = page.getByRole("link", { name: "打开项目“二分搜索”" });
  const kindCell = rowAfterReload.locator("td").nth(1);
  await kindCell.click();
  await expect(page.locator("#file-name")).toHaveText("二分搜索.c");
  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("offers an explicit disk reload when optimistic save detects a conflict", async () => {
  const directory = join(workspaceRoot, "Projects", projectId);
  const manifestPath = join(directory, "entry.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const diskSource = "int main(void) {\n  return 99;\n}\n";
  await writeFile(join(directory, "main.c"), diskSource, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        revision: Number(manifest.revision) + 1,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText("int main(void) {\n  return 43;\n}\n");
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "error");
  const recovery = page.getByRole("button", { name: "重新载入磁盘版本" });
  await expect(recovery).toBeVisible();
  page.once("dialog", async (dialog) => dialog.accept());
  await recovery.click();

  await expect(page.locator(".cm-line")).toHaveText(["int main(void) {", "  return 99;", "}", ""]);
  await expect(recovery).toBeHidden();
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "saved");
});

test("flushes the final debounced edit before the desktop window closes", async () => {
  const closingSource = "int main(void) {\n  return 7;\n}\n";
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(closingSource);
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "pending");

  const currentApplication = application;
  if (currentApplication === undefined) throw new Error("Electron 应用尚未启动");
  await currentApplication.close();
  application = undefined;

  await expect
    .poll(() => readFile(join(workspaceRoot, "Projects", projectId, "main.c"), "utf8"))
    .toBe(closingSource);
});

async function reloadThroughApplicationLifecycle(): Promise<void> {
  const previousTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => window.location.reload());
  await expect
    .poll(async () => {
      try {
        return await page.evaluate(() => performance.timeOrigin);
      } catch {
        return previousTimeOrigin;
      }
    })
    .not.toBe(previousTimeOrigin);
  await page.waitForLoadState("domcontentloaded");
}
