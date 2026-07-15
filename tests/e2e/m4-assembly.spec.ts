import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

let application: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  application = await electron.launch({
    args: ["."],
    chromiumSandbox: true,
    env: { ...inheritedEnvironment, PANEL_RUNNER_MODE: "trusted-only" },
  });
  page = await application.firstWindow();
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#startup-loader")).toBeHidden();
  await page.getByRole("button", { name: "粘贴源码" }).click();
  await page.locator("#paste-source").fill("int main(void) {\n  return 0;\n}\n");
  await page.getByRole("button", { name: "载入工作台" }).click();
  await expect(dock("工作区")).toHaveAttribute("aria-selected", "true");
});

test.afterAll(async () => {
  await application?.close();
});

test("prioritizes the assembly canvas and switches extension pages from the top Dock", async () => {
  const canvas = page.locator("#center-pane");
  const code = page.locator("#right-pane");
  const [canvasBox, codeBox] = await Promise.all([canvas.boundingBox(), code.boundingBox()]);
  if (canvasBox === null || codeBox === null) throw new Error("工作台列不可见");
  expect(canvasBox.width).toBeGreaterThan(codeBox.width * 1.35);

  const dockLabels = await page.locator("[data-menu-root-trigger]").allTextContents();
  expect(dockLabels).toEqual(["设置", "积木", "Library", "布局"]);
  await expect(page.getByRole("heading", { name: "AlgoLatch" })).toHaveCount(0);
  await openMenuBranch("积木", "自定义");
  await expect(page.locator("#block-library-panel")).toBeVisible();
  await expect(page.locator("#build-panel")).toBeHidden();
  await openMenuBranch("Library", "完整软件手册");
  await expect(page.locator("#software-library-panel")).toBeVisible();
  await expect(page.locator("#workbench-shell")).toHaveAttribute("data-library-branch", "manual");
  await expect(
    page.locator("[data-library-branch-id='manual'][aria-current='true']"),
  ).toBeVisible();
  await dock("项目").click();
  await expect(dock("项目")).toHaveAttribute("aria-selected", "true");
  await dock("工作区").click();
  await expect(page.getByRole("tabpanel", { name: "工作区" })).toBeVisible();
});

test("drags a multiline preset into a real slot and synchronizes exact C", async () => {
  await dock("工作区").click();
  const target = statement("return_statement", "return 0;");
  const slot = await slotFor(target, "before");
  const preset = page.locator(
    ".block-palette__drag-surface[data-template-id='builtin.control.while']",
  );
  await expect(preset).toBeVisible();

  await preset.dragTo(slot);
  await expect(dock("编辑")).toHaveAttribute("aria-selected", "true");
  await confirmVisibleDiff();
  await expect(dock("工作区")).toHaveAttribute("aria-selected", "true");
  await expect.poll(editorText).toContain("  while (condition) {\n    action();\n  }\n  return 0;");
  await expect(statement("while_statement", "while (condition)")).toBeVisible();
});

test("creates, uses, deprecates and retires a custom block without deleting generated C", async () => {
  await openMenuBranch("积木", "自定义");
  await page.getByRole("textbox", { name: "积木名称" }).fill("我的累加");
  await page.getByRole("textbox", { name: "分类" }).fill("custom");
  await page.getByRole("combobox", { name: "学习阶段" }).selectOption("c.basics");
  await page.getByRole("textbox", { name: "C 源码片段" }).fill("total += 10;");
  await page.getByRole("button", { name: "保存自定义积木" }).click();
  await expect(page.locator(".block-library-manager__status")).toContainText("已创建");
  expect(
    await page.evaluate(() =>
      globalThis.localStorage.getItem("c-block-algorithm-panel.learning-catalog"),
    ),
  ).toBeNull();

  await dock("工作区").click();
  await page.getByRole("searchbox", { name: "筛选积木" }).fill("我的累加");
  const customPreset = page.locator(".block-palette__drag-surface").filter({ hasText: "我的累加" });
  const target = statement("return_statement", "return 0;");
  await customPreset.dragTo(await slotFor(target, "before"));
  await confirmVisibleDiff();
  await expect.poll(editorText).toContain("  total += 10;\n  return 0;");

  await openMenuBranch("积木", "自定义");
  let customEntry = customLibraryEntry();
  await customEntry.getByRole("button", { name: "弃用" }).click();
  await expect(customEntry).toHaveAttribute("data-lifecycle", "deprecated");
  await dock("工作区").click();
  await page.getByRole("searchbox", { name: "筛选积木" }).fill("我的累加");
  await expect(
    page.locator(".block-palette__drag-surface").filter({ hasText: "我的累加" }),
  ).toHaveCount(0);

  await openMenuBranch("积木", "自定义");
  customEntry = customLibraryEntry();
  await customEntry.getByRole("button", { name: "恢复" }).click();
  customEntry = customLibraryEntry();
  await customEntry.getByRole("button", { name: "弃用" }).click();
  customEntry = customLibraryEntry();
  page.once("dialog", async (dialog) => dialog.accept());
  await customEntry.getByRole("button", { name: "退休" }).click();
  await expect(customLibraryEntry()).toHaveAttribute("data-lifecycle", "retired");
  await expect(customLibraryEntry()).toContainText("已生成 C 源码保持不变");
  expect(await editorText()).toContain("total += 10;");
});

function dock(name: string): Locator {
  return page.getByRole("tab", { name, exact: true });
}

function menuTrigger(name: string): Locator {
  return page.locator("[data-menu-root-trigger]").filter({ hasText: name });
}

async function openMenuBranch(rootName: string, branchName: string): Promise<void> {
  const trigger = menuTrigger(rootName);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const menu = page.getByRole("menu", { name: rootName });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: branchName, exact: true }).click();
}

function statement(nodeType: string, excerpt: string): Locator {
  return page
    .locator(`#block-tree .block-card[data-node-type="${nodeType}"]`)
    .filter({ has: page.locator(".block-card__excerpt", { hasText: excerpt }) });
}

async function slotFor(target: Locator, position: "before" | "after"): Promise<Locator> {
  const blockIndex = await target.getAttribute("data-block-index");
  if (blockIndex === null) throw new Error("目标积木缺少 block index");
  return page.locator(
    `.assembly-slot[data-block-index="${blockIndex}"][data-assembly-slot="${position}"]`,
  );
}

function customLibraryEntry(): Locator {
  return page
    .locator(".block-library-manager__entry[data-origin='custom']")
    .filter({ hasText: "我的累加" });
}

async function confirmVisibleDiff(): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff").first()).toBeVisible();
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expect(dialog).toBeHidden();
}

async function editorText(): Promise<string> {
  return page
    .locator(".cm-line")
    .evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join("\n"));
}
