import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CRLF_SOURCE = [
  "int helper(int value) {",
  "  return value;",
  "}",
  "",
  "int main(void) {",
  "  return 0;",
  "}",
  "",
].join("\r\n");

let electronApplication: ElectronApplication | undefined;
let page: Page;
let fixtureDirectory = "";
let crlfFixturePath = "";

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "panel-m3b-editing-"));
  crlfFixturePath = join(fixtureDirectory, "m3b-crlf.c");
  await writeFile(crlfFixturePath, CRLF_SOURCE, "utf8");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  electronApplication = await electron.launch({
    args: ["."],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
    },
  });
  page = await electronApplication.firstWindow();
  await electronApplication.evaluate(({ dialog }, path) => {
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{
        readonly canceled: boolean;
        readonly filePaths: string[];
      }>;
    };
    mutableDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, crlfFixturePath);
});

test.beforeEach(async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("button", { name: "粘贴源码" })).toBeEnabled();
});

test.afterAll(async () => {
  await electronApplication?.close();
  if (fixtureDirectory.length > 0) await rm(fixtureDirectory, { recursive: true, force: true });
});

test("supports direct input, bracket pairing, and exact CRLF undo", async () => {
  await page.getByRole("button", { name: "打开 C 文件" }).click();
  await expect(page.locator("#file-name")).toHaveText("m3b-crlf.c");
  await expect(page.locator("#source-meta")).toContainText("CRLF");
  await expectEditorSource(CRLF_SOURCE);
  const content = page.locator(".cm-content");
  const originalMetadata = await page.locator("#source-meta").textContent();

  await expect(content).toHaveAttribute("contenteditable", "true");
  await expect(content).toHaveAttribute("aria-readonly", "false");
  await expect(content).toHaveAttribute("aria-label", "C 源码编辑器");

  await placeCursorAfterCodeOccurrence("0", 0);
  await page.keyboard.type("(");
  await expect.poll(editorText).toContain("  return 0();");
  await page.keyboard.type("1");
  await page.keyboard.press("ArrowRight");

  await expectEditorSource(CRLF_SOURCE.replace("  return 0;", "  return 0(1);"));
  await expect(projectionStatus()).toHaveAttribute("data-state", "synced");
  await expect(page.locator("#source-meta")).toContainText("CRLF");

  await undoUntilSource(CRLF_SOURCE);
  await expect(page.locator("#source-meta")).toHaveText(originalMetadata ?? "");
  await expect(projectionStatus()).toHaveAttribute("data-state", "synced");
});

test("holds the previous block projection for a large ERROR and recovers after repair", async () => {
  const original = ["int main(void) {", "  int stable = 1;", "  return stable;", "}", ""].join(
    "\n",
  );
  const repaired = ["int main(void) {", "  int repaired = 2;", "  return repaired;", "}", ""].join(
    "\n",
  );
  await pasteSource(original);
  const stableBlock = statementBlock("declaration", "int stable = 1;");
  await expect(stableBlock).toBeVisible();

  await replaceEditorSource("((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((");

  const status = projectionStatus();
  await expect(status).toHaveAttribute("data-state", "held");
  await expect(status).toContainText(/积木暂时保持上次(?:稳定)?结果/u);
  await expect(page.locator("#block-tree")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#block-tree")).toHaveJSProperty("inert", true);
  await expect(stableBlock).toBeVisible();

  await replaceEditorSource(repaired);

  await expect(status).toHaveAttribute("data-state", "synced");
  await expect(page.locator("#block-tree")).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#block-tree")).toHaveJSProperty("inert", false);
  await expect(statementBlock("declaration", "int repaired = 2;")).toBeVisible();
  await expect(statementBlock("declaration", "int stable = 1;")).toHaveCount(0);
});

test("previews insert and delete, respects cancel, and moves attached comments with deletion", async () => {
  const source = [
    "int value(void) {",
    "  // attached lead",
    "  /* attached block */",
    "  alpha(); // attached tail",
    "  beta();",
    "  return 0;",
    "}",
    "",
  ].join("\n");
  await pasteSource(source);
  await selectStatement("expression_statement", "beta();");

  const insertInput = page.getByRole("textbox", { name: "要插入的单行 C 语句" });
  await insertInput.fill("prepare();");
  const insertBefore = structureOperation("insert-before");
  await expect(insertBefore).toBeEnabled();
  await insertBefore.click();
  const dialog = confirmationDialog();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff")).toHaveCount(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectEditorSource(source);
  await expect(page.locator(".structure-edit-panel__status")).toContainText("已取消");

  await insertBefore.click();
  await confirmVisibleDiff();
  const inserted = source.replace("  beta();", "  prepare();\n  beta();");
  await expectEditorSource(inserted);

  await selectStatement("expression_statement", "alpha();");
  await structureOperation("delete").click();
  await confirmVisibleDiff();
  const deleted = ["int value(void) {", "  prepare();", "  beta();", "  return 0;", "}", ""].join(
    "\n",
  );
  await expectEditorSource(deleted);
  const after = await editorText();
  expect(after).not.toContain("attached lead");
  expect(after).not.toContain("attached block");
  expect(after).not.toContain("attached tail");
});

test("turns deleted inline required bodies into semicolons and disables unsafe same-line edits", async () => {
  const source = [
    "int value(int ready) {",
    "  if (ready) update(); // attached tail",
    "  if (ready) first(); else second();",
    "  return ready;",
    "}",
    "",
  ].join("\n");
  await pasteSource(source);
  await selectStatement("expression_statement", "update();");

  await expect(structureOperation("insert-before")).toBeDisabled();
  await expect(structureOperation("insert-after")).toBeDisabled();
  await expect(structureOperation("move-previous")).toBeDisabled();
  await expect(structureOperation("move-next")).toBeDisabled();
  await expect(structureOperation("delete")).toBeEnabled();
  await expect(page.locator(".structure-edit-panel__hint")).toContainText("只允许安全删除");

  await structureOperation("delete").click();
  await confirmVisibleDiff();
  const withoutUpdate = source.replace("update(); // attached tail", ";");
  await expectEditorSource(withoutUpdate);

  await selectStatement("expression_statement", "first();");
  await expect(structureOperation("insert-before")).toBeDisabled();
  await structureOperation("delete").click();
  await confirmVisibleDiff();
  await expectEditorSource(withoutUpdate.replace("first();", ";"));
  expect(await editorText()).toContain("if (ready) ; else second();");
});

test("moves adjacent statements with buttons and supports a real drag while rejecting unsafe drops", async () => {
  const buttonSource = [
    "int value(void) {",
    "  a();",
    "  b();",
    "  c();",
    "  return 0;",
    "}",
    "",
  ].join("\n");
  await pasteSource(buttonSource);
  await selectStatement("expression_statement", "b();");
  await expect(structureOperation("move-previous")).toBeEnabled();
  await structureOperation("move-previous").click();
  await confirmVisibleDiff();
  const movedUp = buttonSource.replace("  a();\n  b();", "  b();\n  a();");
  await expectEditorSource(movedUp);

  await selectStatement("expression_statement", "b();");
  await expect(structureOperation("move-next")).toBeEnabled();
  await structureOperation("move-next").click();
  await confirmVisibleDiff();
  await expectEditorSource(buttonSource);

  const dragSource = [
    "int value(int ready) {",
    "  a();",
    "  if (ready) {",
    "    nested();",
    "  }",
    "  // B lead",
    "  b(); // B tail",
    "",
    "  /* C lead */",
    "  c(); // C tail",
    "  return 0;",
    "}",
    "",
  ].join("\n");
  await pasteSource(dragSource);
  const b = draggableStatement("expression_statement", "b();");
  const c = draggableStatement("expression_statement", "c();");
  await expect(b).toHaveAttribute("draggable", "true");
  await b.dragTo(c);
  await confirmVisibleDiff();
  const swapped = dragSource
    .replace("  // B lead\n  b(); // B tail", "__B__")
    .replace("  /* C lead */\n  c(); // C tail", "  // B lead\n  b(); // B tail")
    .replace("__B__", "  /* C lead */\n  c(); // C tail");
  await expectEditorSource(swapped);

  const beforeRejectedDrop = await editorText();
  await draggableStatement("expression_statement", "a();").dragTo(
    draggableStatement("expression_statement", "b();"),
  );
  await expect(confirmationDialog()).toBeHidden();
  await expect(page.locator('#import-status[data-state="error"]')).toContainText(
    /NOT_ADJACENT_SIBLINGS|相邻/u,
  );
  expect(await editorText()).toBe(beforeRejectedDrop);

  await draggableStatement("expression_statement", "a();").dragTo(
    draggableStatement("expression_statement", "nested();"),
  );
  await expect(confirmationDialog()).toBeHidden();
  await expect(page.locator('#import-status[data-state="error"]')).toContainText(
    /NOT_ADJACENT_SIBLINGS|同一父级|相邻/u,
  );
  expect(await editorText()).toBe(beforeRejectedDrop);
});

test("renames only one certain local binding, rejects collisions, and undoes exactly", async () => {
  const source = [
    "struct Item { int value; };",
    "int main(void) {",
    "  // value stays in this comment",
    "  int value = 1;",
    "  int other = 0;",
    '  const char *text = "value";',
    "  struct Item item = {.value = 2};",
    "  item.value += value;",
    "  if (value < 2) goto value;",
    "value:",
    "  return value + other + (text[0] == 'v');",
    "}",
    "",
  ].join("\n");
  await pasteSource(source);
  await clickCodeOccurrenceInLine("int value = 1;", "value");

  const renameInput = page.getByRole("textbox", { name: "局部变量 value 的新名称" });
  const renameButton = structureOperation("rename");
  await renameInput.fill("other");
  await expect(renameButton).toBeEnabled();
  await renameButton.click();
  await expect(confirmationDialog()).toBeHidden();
  await expect(page.locator('.structure-edit-panel__status[data-state="error"]')).toContainText(
    "NAME_COLLISION",
  );
  await expectEditorSource(source);

  await renameInput.fill("amount");
  await renameButton.click();
  const dialog = confirmationDialog();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff")).toHaveCount(4);
  await dialog.getByRole("button", { name: "确认修改" }).click();

  const renamed = source
    .replace("int value = 1;", "int amount = 1;")
    .replace("item.value += value;", "item.value += amount;")
    .replace("if (value < 2)", "if (amount < 2)")
    .replace("return value + other", "return amount + other");
  await expectEditorSource(renamed);
  const after = await editorText();
  expect(after).toContain("struct Item { int value; };");
  expect(after).toContain("// value stays in this comment");
  expect(after).toContain('"value"');
  expect(after).toContain("item.value");
  expect(after).toContain("goto value;");
  expect(after).toContain("value:");

  await page.getByRole("tab", { name: "编辑" }).click();
  await historyButton("撤销").click();
  await expectEditorSource(source);
});

test("compiles the current CodeMirror source while projection sync is still pending", async () => {
  const original = [
    "#include <stdio.h>",
    "int main(void) {",
    '  printf("1\\n");',
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const current = original.replace('printf("1\\n")', 'printf("7\\n")');
  await pasteSource(original);
  await page.getByRole("tab", { name: "运行" }).click();
  const runPanel = page.locator("#run-panel .run-panel");
  await expect(runPanel).toHaveAttribute("data-state", "ready");
  await acceptTrustedRunnerPrompts();

  // Keep the app inside its real pending state long enough to make the source
  // capture boundary deterministic; only the product's 120 ms sync timer is widened.
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) =>
      nativeSetTimeout(
        handler,
        timeout === 120 ? 10_000 : timeout,
        ...arguments_,
      )) as typeof setTimeout;
  });

  await replaceEditorSourceWithoutWaiting(current);
  await expect(projectionStatus()).toHaveAttribute("data-state", "pending");
  expect(await editorText()).toBe(normalizedEditorSource(current));
  await page.getByRole("tab", { name: "运行" }).click();
  await page.getByRole("button", { name: "编译并运行" }).click();

  await expect(runPanel).toHaveAttribute("data-state", "success", { timeout: 15_000 });
  expect(await page.locator('[data-run-field="stdout"]').textContent()).toBe("7\n");
  await expect(page.locator('[data-run-field="exit-code"]')).toHaveText("0");
});

async function pasteSource(source: string): Promise<void> {
  await page.getByRole("button", { name: "粘贴源码" }).click();
  const dialog = page.getByRole("dialog", { name: "粘贴 C 源码" });
  await expect(dialog).toBeVisible();
  await page.locator("#paste-source").fill(source);
  await page.getByRole("button", { name: "载入工作台" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#file-name")).toHaveText("pasted.c");
  await expect(page.locator("#import-status")).toHaveAttribute("data-state", "ready");
  await expectEditorSource(source);
}

function projectionStatus(): Locator {
  return page.locator(".projection-status");
}

function structureOperation(operation: string): Locator {
  return page.locator(`.structure-edit-panel [data-operation="${operation}"]`);
}

function confirmationDialog(): Locator {
  return page.getByRole("dialog", { name: "确认修改" });
}

function historyButton(action: "撤销" | "重做"): Locator {
  return page.locator(`.edit-panel__history-button[title="${action}"]`);
}

function statementBlock(nodeType: string, excerpt: string): Locator {
  return page
    .locator(`#block-tree [data-node-type="${nodeType}"]`)
    .filter({ has: page.locator(".block-card__excerpt", { hasText: excerpt }) });
}

function draggableStatement(nodeType: string, excerpt: string): Locator {
  return statementBlock(nodeType, excerpt).filter({ has: page.locator(".block-card__excerpt") });
}

async function selectStatement(nodeType: string, excerpt: string): Promise<void> {
  const block = statementBlock(nodeType, excerpt);
  await expect(block).toHaveCount(1);
  await block.click();
  await expect(block).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "编辑" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".structure-edit-panel")).toBeVisible();
}

async function confirmVisibleDiff(): Promise<void> {
  const dialog = confirmationDialog();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff").first()).toBeVisible();
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expect(dialog).toBeHidden();
}

async function replaceEditorSource(source: string): Promise<void> {
  await replaceEditorSourceWithoutWaiting(source);
  await expectEditorSource(source);
}

async function replaceEditorSourceWithoutWaiting(source: string): Promise<void> {
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(source);
}

async function undoUntilSource(source: string): Promise<void> {
  const expected = normalizedEditorSource(source);
  for (let attempts = 0; attempts < 12 && (await editorText()) !== expected; attempts += 1) {
    await page.keyboard.press("Meta+Z");
  }
  await expectEditorSource(source);
}

async function expectEditorSource(source: string): Promise<void> {
  await expect.poll(editorText).toBe(normalizedEditorSource(source));
}

function normalizedEditorSource(source: string): string {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace("\uFEFF", "•");
}

async function editorText(): Promise<string> {
  return page
    .locator(".cm-line")
    .evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join("\n"));
}

async function clickCodeOccurrence(needle: string, occurrence: number): Promise<void> {
  const point = await page.locator(".cm-content").evaluate(
    (content, target) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let remaining = target.occurrence;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? "";
        let searchFrom = 0;
        for (;;) {
          const match = value.indexOf(target.needle, searchFrom);
          if (match < 0) break;
          if (remaining === 0) {
            const character = match + Math.floor(target.needle.length / 2);
            const range = document.createRange();
            range.setStart(node, character);
            range.setEnd(node, character + 1);
            const rectangle = range.getBoundingClientRect();
            if (rectangle.width <= 0 || rectangle.height <= 0) {
              throw new Error(`源码文本 ${target.needle} 不可见`);
            }
            return {
              x: rectangle.left + rectangle.width / 2,
              y: rectangle.top + rectangle.height / 2,
            };
          }
          remaining -= 1;
          searchFrom = match + target.needle.length;
        }
      }
      throw new Error(`找不到源码文本 ${target.needle} 的第 ${target.occurrence + 1} 次出现`);
    },
    { needle, occurrence },
  );

  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("tab", { name: "编辑" })).toHaveAttribute("aria-selected", "true");
}

async function clickCodeOccurrenceInLine(lineText: string, needle: string): Promise<void> {
  const line = page.locator(".cm-line").filter({ hasText: lineText });
  await expect(line).toHaveCount(1);
  const point = await line.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const match = (node.nodeValue ?? "").indexOf(target);
      if (match < 0) continue;
      const range = document.createRange();
      range.setStart(node, match);
      range.setEnd(node, match + 1);
      const rectangle = range.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) {
        throw new Error(`源码行中的 ${target} 不可见`);
      }
      return {
        x: rectangle.left + rectangle.width / 2,
        y: rectangle.top + rectangle.height / 2,
      };
    }
    throw new Error(`源码行中找不到 ${target}`);
  }, needle);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("tab", { name: "编辑" })).toHaveAttribute("aria-selected", "true");
}

async function placeCursorAfterCodeOccurrence(needle: string, occurrence: number): Promise<void> {
  const point = await page.locator(".cm-content").evaluate(
    (content, target) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let remaining = target.occurrence;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? "";
        let searchFrom = 0;
        for (;;) {
          const match = value.indexOf(target.needle, searchFrom);
          if (match < 0) break;
          if (remaining === 0) {
            const range = document.createRange();
            range.setStart(node, match);
            range.setEnd(node, match + 1);
            const rectangle = range.getBoundingClientRect();
            if (rectangle.width <= 0 || rectangle.height <= 0) {
              throw new Error(`源码文本 ${target.needle} 不可见`);
            }
            return { x: rectangle.right - 0.1, y: rectangle.top + rectangle.height / 2 };
          }
          remaining -= 1;
          searchFrom = match + target.needle.length;
        }
      }
      throw new Error(`找不到源码文本 ${target.needle} 的第 ${target.occurrence + 1} 次出现`);
    },
    { needle, occurrence },
  );
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".cm-content")).toBeFocused();
}

async function acceptTrustedRunnerPrompts(): Promise<void> {
  const application = electronApplication;
  if (application === undefined) throw new Error("Electron 应用尚未启动");
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
}
