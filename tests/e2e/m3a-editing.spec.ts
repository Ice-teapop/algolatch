import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const LITERAL_SOURCE = `${["int main(void) {", "  int value = 41;", "  return value;", "}"].join(
  "\n",
)}\n`;

let electronApplication: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  electronApplication = await electron.launch({
    args: ["."],
    chromiumSandbox: true,
    env: inheritedEnvironment,
  });
  page = await electronApplication.firstWindow();
});

test.beforeEach(async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("button", { name: "粘贴源码" })).toBeEnabled();
});

test.afterAll(async () => {
  await electronApplication?.close();
});

test("previews and cancels without mutation, then commits a literal with button and keyboard history", async () => {
  await pasteSource(LITERAL_SOURCE);
  await clickCodeOccurrence("41", 0);
  await openEditDock();

  const literalInput = page.getByRole("textbox", { name: "原文" });
  await expect(literalInput).toHaveValue("41");
  await literalInput.fill("42");

  const original = await editorText();
  await page.getByRole("button", { name: "预览修改" }).click();
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  expect(await editorText()).toBe(original);
  await expect(dialog.locator(".edit-panel__diff")).toHaveCount(1);
  await expect(dialog.locator(".edit-panel__diff-text").nth(0)).toHaveText("41");
  await expect(dialog.locator(".edit-panel__diff-text").nth(1)).toHaveText("42");

  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".edit-panel__status")).toHaveText("已取消；源码未发生变化。");
  expect(await editorText()).toBe(original);

  await page.getByRole("button", { name: "预览修改" }).click();
  await expect(dialog).toBeVisible();
  expect(await editorText()).toBe(original);
  await dialog.getByRole("button", { name: "确认修改" }).click();

  const editedSource = LITERAL_SOURCE.replace("41", "42");
  await expectEditorSource(editedSource);
  const undoButton = historyButton("撤销");
  const redoButton = historyButton("重做");
  await expect(undoButton).toHaveAttribute("aria-label", "撤销，可用 1 步");
  await expect(redoButton).toHaveAttribute("aria-label", "重做，可用 0 步");
  await expect(undoButton).toBeEnabled();
  await expect(redoButton).toBeDisabled();

  await undoButton.click();
  await expectEditorSource(LITERAL_SOURCE);
  await expect(redoButton).toHaveAttribute("aria-label", "重做，可用 1 步");
  await expect(redoButton).toBeEnabled();

  await page.getByRole("tab", { name: "编辑" }).click();
  await redoButton.click();
  await expectEditorSource(editedSource);

  await openBuildDock();
  const content = page.locator(".cm-content");
  await content.click();
  await expect(content).toBeFocused();
  await page.keyboard.press("Meta+Z");
  await expectEditorSource(LITERAL_SOURCE);
  await page.keyboard.press("Meta+Shift+Z");
  await expectEditorSource(editedSource);
});

test("parenthesizes a+b before changing the outer plus and shows three minimal patches", async () => {
  const source = `${["int main(void) {", "  int a = 1, b = 2, c = 3;", "  return a+b+c;", "}"].join(
    "\n",
  )}\n`;
  await pasteSource(source);
  await clickCodeOccurrence("+", 1);
  await openEditDock();

  const operator = page.getByRole("combobox", { name: "运算符" });
  await expect(operator).toHaveValue("+");
  await operator.selectOption("*");
  const original = await editorText();
  await page.getByRole("button", { name: "预览修改" }).click();

  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  expect(await editorText()).toBe(original);
  const rows = dialog.locator(".edit-panel__diff");
  await expect(rows).toHaveCount(3);
  const patchPairs = await rows.evaluateAll((items) =>
    items.map((item) => {
      const text = [...item.querySelectorAll<HTMLElement>(".edit-panel__diff-text")];
      return [text[0]?.textContent ?? "", text[1]?.textContent ?? ""];
    }),
  );
  expect(patchPairs).toEqual(
    expect.arrayContaining([
      ["", "("],
      ["", ")"],
      ["+", "*"],
    ]),
  );

  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expectEditorSource(source.replace("a+b+c", "(a+b)*c"));
});

test("edits all three for fields while preserving the body character-for-character", async () => {
  const body = "{\n    total += i; /* BODY_SENTINEL */\n  }";
  const source = `${[
    "int main(void) {",
    "  int total = 0;",
    "  for (int i = 0; i < 3; i++) " + body,
    "  return total;",
    "}",
  ].join("\n")}\n`;
  await pasteSource(source);
  await page.locator('.block-card[data-node-type="for_statement"]').first().click();
  await openEditDock();

  await page.getByRole("textbox", { name: "初始化" }).fill("int i = 1");
  await page.getByRole("textbox", { name: "条件" }).fill(" i <= 5");
  await page.getByRole("textbox", { name: "更新" }).fill(" i += 2");
  await page.getByRole("button", { name: "预览修改" }).click();
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff")).toHaveCount(3);
  await dialog.getByRole("button", { name: "确认修改" }).click();

  const expected = source.replace("for (int i = 0; i < 3; i++)", "for (int i = 1; i <= 5; i += 2)");
  await expectEditorSource(expected);
  expect(await editorText()).toContain(body);
});

test("edits only the if condition and preserves both branches exactly", async () => {
  const consequence = "{\n    result = 10; /* THEN_SENTINEL */\n  }";
  const alternative = "{\n    result = 20; /* ELSE_SENTINEL */\n  }";
  const source = `${[
    "int main(void) {",
    "  int value = 3, ready = 1, result = 0;",
    `  if (value < 5) ${consequence} else ${alternative}`,
    "  return result;",
    "}",
  ].join("\n")}\n`;
  await pasteSource(source);
  await page.locator('.block-card[data-node-type="if_statement"]').first().click();
  await openEditDock();

  await page.getByRole("textbox", { name: "最外层括号内部" }).fill("value >= 10 && ready");
  await page.getByRole("button", { name: "预览修改" }).click();
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff")).toHaveCount(1);
  await dialog.getByRole("button", { name: "确认修改" }).click();

  const expected = source.replace("if (value < 5)", "if (value >= 10 && ready)");
  await expectEditorSource(expected);
  const after = await editorText();
  expect(after).toContain(consequence);
  expect(after).toContain(alternative);
});

test("rejects literal statement injection before confirmation and leaves no history mutation", async () => {
  const source = `${["int main(void) {", "  int value = 1;", "  return value;", "}"].join("\n")}\n`;
  await pasteSource(source);
  await clickCodeOccurrence("1", 0);
  await openEditDock();

  await page.getByRole("textbox", { name: "原文" }).fill("1; hacked()");
  const original = await editorText();
  await page.getByRole("button", { name: "预览修改" }).click();

  await expect(page.getByRole("dialog", { name: "确认修改" })).toBeHidden();
  const status = page.locator(".edit-panel__status");
  await expect(status).toHaveAttribute("data-state", "error");
  await expect(status).toContainText(/CANDIDATE_(?:SHAPE_CHANGED|PARSE_ERROR)/u);
  expect(await editorText()).toBe(original);
  await expect(historyButton("撤销")).toHaveAttribute("aria-label", "撤销，可用 0 步");
  await expect(historyButton("撤销")).toBeDisabled();
  await expect(historyButton("重做")).toHaveAttribute("aria-label", "重做，可用 0 步");
  await expect(historyButton("重做")).toBeDisabled();
});

test("a new import clears both history branches", async () => {
  const first = "int main(void) { return 7; }\n";
  await pasteSource(first);
  await clickCodeOccurrence("7", 0);
  await openEditDock();
  await page.getByRole("textbox", { name: "原文" }).fill("8");
  await confirmCurrentPreview();
  await expectEditorSource("int main(void) { return 8; }\n");
  await expect(historyButton("撤销")).toHaveAttribute("aria-label", "撤销，可用 1 步");
  await expect(historyButton("撤销")).toBeEnabled();

  const imported = "int main(void) { return 99; }\n";
  await pasteSource(imported);
  await expectEditorSource(imported);
  await expect(historyButton("撤销")).toHaveAttribute("aria-label", "撤销，可用 0 步");
  await expect(historyButton("撤销")).toBeDisabled();
  await expect(historyButton("重做")).toHaveAttribute("aria-label", "重做，可用 0 步");
  await expect(historyButton("重做")).toBeDisabled();

  await openBuildDock();
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+Z");
  await expectEditorSource(imported);
});

test("exposes CodeMirror as the editable exact-source surface", async () => {
  await pasteSource(LITERAL_SOURCE);
  const content = page.locator(".cm-content");
  await expect(content).toHaveAttribute("contenteditable", "true");
  await expect(content).toHaveAttribute("aria-readonly", "false");
  await expect(content).toHaveAttribute("aria-label", "C 源码编辑器");
  await expect(historyButton("撤销")).toHaveAttribute("aria-label", "撤销，可用 0 步");
  await expect(historyButton("撤销")).toBeDisabled();
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

async function confirmCurrentPreview(): Promise<void> {
  await page.getByRole("button", { name: "预览修改" }).click();
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认修改" }).click();
}

function historyButton(action: "撤销" | "重做") {
  return page.locator(`.edit-panel__history-button[title="${action}"]`);
}

async function openEditDock(): Promise<void> {
  const editTab = page.getByRole("tab", { name: "编辑", exact: true });
  await editTab.click();
  await expect(editTab).toHaveAttribute("aria-selected", "true");
}

async function openBuildDock(): Promise<void> {
  const buildTab = page.getByRole("tab", { name: "搭建", exact: true });
  await buildTab.click();
  await expect(buildTab).toHaveAttribute("aria-selected", "true");
}

async function expectEditorSource(source: string): Promise<void> {
  await expect.poll(editorText).toBe(source.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
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
}
