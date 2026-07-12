import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

let application: ElectronApplication;
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
});

test.beforeEach(async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
});

test.afterAll(async () => {
  await application?.close();
});

test("maps clang byte columns onto the code and matching block after one native confirmation", async () => {
  const source = "// 中文\nint main(void) {\n  int unused;\n  return 0;\n}\n";
  await pasteSource(source);
  await acceptTrustedDiagnosis();
  await page.getByRole("tab", { name: "运行", exact: true }).click();
  const panel = page.locator("#run-panel .run-panel");
  await expect(panel).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "静态诊断", exact: true }).click();

  await expect(panel).toHaveAttribute("data-state", "success", { timeout: 15_000 });
  await expect(page.locator('[data-run-field="diagnostics"]')).toContainText("unused variable");
  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await expect(page.locator('.block-card__diagnostic[data-severity="warning"]')).toHaveText(
    "警告 1",
  );
  await expect(page.locator('[data-code-highlight-kind="diagnostic-warning"]')).toHaveCount(1);
  await page.locator('.block-card[data-node-type="function_definition"]').click();
  await expect
    .poll(() => page.locator('[data-code-highlight-kind="primary"]').count())
    .toBeGreaterThan(0);
  await expect(page.locator('[data-code-highlight-kind="diagnostic-warning"]')).toHaveCount(1);
  expect(await trustDialogCount()).toBe(1);

  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText("int x;\n");
  await expect(page.locator('[data-code-highlight-kind^="diagnostic-"]')).toHaveCount(0);
  await expect(page.locator(".block-card__diagnostic")).toHaveCount(0);
});

test("injects frozen def-use, memory and finding facts into Explanation v2", async () => {
  const source = [
    "#include <stdlib.h>",
    "int main(void) {",
    "  int *p = malloc(sizeof *p);",
    "  free(p);",
    "  return *p;",
    "}",
    "",
  ].join("\n");
  await pasteSource(source);
  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await page.locator('.block-card[data-node-type="function_definition"]').click();
  await page.getByRole("tab", { name: "解释", exact: true }).click();

  const analysis = page.locator(".explanation__analysis");
  await expect(analysis).toBeVisible();
  await expect(analysis).toContainText("程序分析事实");
  await expect(analysis).toContainText("分配尝试");
  await expect(analysis).toContainText("释放调用");
  await expect(analysis).toContainText("释放后使用");

  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText("int main(void) {");
  await page.getByRole("tab", { name: "解释", exact: true }).click();
  const recoveryExplanation = page.getByRole("tabpanel", { name: "解释" });
  await expect(recoveryExplanation).not.toContainText("释放后使用");
  await expect(recoveryExplanation).toContainText("原始 C（解析恢复）");
});

test("drops a diagnosis result when the source changes during native authorization", async () => {
  const source = "int main(void) { int unused; return 0; }\n";
  await pasteSource(source);
  await deferTrustedDiagnosis();
  await page.getByRole("tab", { name: "运行", exact: true }).click();
  const panel = page.locator("#run-panel .run-panel");
  await page.getByRole("button", { name: "静态诊断", exact: true }).click();
  await expect
    .poll(() =>
      application.evaluate(() => {
        const state = globalThis as typeof globalThis & { __m5ReleaseTrust?: () => void };
        return typeof state.__m5ReleaseTrust;
      }),
    )
    .toBe("function");

  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText("int main(void) { return 1; }\n");
  await application.evaluate(() => {
    const state = globalThis as typeof globalThis & { __m5ReleaseTrust?: () => void };
    state.__m5ReleaseTrust?.();
    delete state.__m5ReleaseTrust;
  });

  await page.getByRole("tab", { name: "运行", exact: true }).click();
  await expect(page.locator(".run-panel__operation-status")).toContainText(
    "旧运行或诊断结果已丢弃",
    { timeout: 15_000 },
  );
  await expect(panel.locator(".run-panel__result")).toBeHidden();
  await expect(page.locator('[data-code-highlight-kind^="diagnostic-"]')).toHaveCount(0);
  await expect(page.locator(".block-card__diagnostic")).toHaveCount(0);
});

test("clears old diagnostics without erasing a structure edit's new explanation", async () => {
  const source = "int main(void) { int unused = 41; return 0; }\n";
  await pasteSource(source);
  await acceptTrustedDiagnosis();
  await page.getByRole("tab", { name: "运行", exact: true }).click();
  const panel = page.locator("#run-panel .run-panel");
  await page.getByRole("button", { name: "静态诊断", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "success", { timeout: 15_000 });
  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await expect(page.locator('[data-code-highlight-kind="diagnostic-warning"]')).toHaveCount(1);

  await clickCodeOccurrence("41", 0);
  await page.getByRole("tab", { name: "编辑", exact: true }).click();
  const literalInput = page.getByRole("textbox", { name: "原文" });
  await expect(literalInput).toHaveValue("41");
  await literalInput.fill("42");
  await page.getByRole("button", { name: "预览修改" }).click();
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await dialog.getByRole("button", { name: "确认修改" }).click();

  await expect(page.locator('[data-code-highlight-kind^="diagnostic-"]')).toHaveCount(0);
  await expect(page.locator(".block-card__diagnostic")).toHaveCount(0);
  await page.getByRole("tab", { name: "运行", exact: true }).click();
  await expect(panel.locator(".run-panel__result")).toBeHidden();
  await page.getByRole("tab", { name: "解释", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "解释" }).locator(".explanation__title"),
  ).toBeVisible();
  expect(await trustDialogCount()).toBe(1);
});

test("runs ASan/UBSan and an independent plain leaks gate under one exact grant", async ({}, testInfo) => {
  test.setTimeout(60_000);
  await acceptTrustedDiagnosis();
  const result = await page.evaluate(() =>
    window.panelApi.diagnose({
      source: [
        "#include <stdlib.h>",
        "int main(void) {",
        "  int *p = malloc(sizeof *p);",
        "  if (p == 0) return 1;",
        "  *p = 7;",
        "  free(p);",
        "  return 0;",
        "}",
      ].join("\n"),
      sourceName: "memory-clean.c",
      runtime: {},
    }),
  );
  if (!result.ok) {
    const detail = JSON.stringify(
      { error: result.error, rawDiagnostics: result.rawDiagnostics },
      null,
      2,
    );
    await testInfo.attach("diagnose-failure.json", {
      body: detail,
      contentType: "application/json",
    });
    throw new Error(`真实内存诊断失败：${result.error.code} · ${result.error.message}`);
  }

  expect(result).toMatchObject({
    ok: true,
    hasErrors: false,
    memory: {
      status: "completed",
      clean: true,
      sanitizer: { verdict: "clean" },
      leaks: { verdict: "clean", positiveControl: "passed" },
    },
  });
  expect(await trustDialogCount()).toBe(1);
});

async function pasteSource(source: string): Promise<void> {
  await page.getByRole("tab", { name: "搭建", exact: true }).click();
  await page.getByRole("button", { name: "粘贴源码" }).click();
  const dialog = page.getByRole("dialog", { name: "粘贴 C 源码" });
  await expect(dialog).toBeVisible();
  await page.locator("#paste-source").fill(source);
  await page.getByRole("button", { name: "载入工作台" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#file-name")).toHaveText("pasted.c");
}

async function acceptTrustedDiagnosis(): Promise<void> {
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { __m5TrustDialogCount?: number };
    state.__m5TrustDialogCount = 0;
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => {
      state.__m5TrustDialogCount = (state.__m5TrustDialogCount ?? 0) + 1;
      return { response: 1, checkboxChecked: false };
    };
  });
}

async function deferTrustedDiagnosis(): Promise<void> {
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { __m5ReleaseTrust?: () => void };
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = () =>
      new Promise((resolve) => {
        state.__m5ReleaseTrust = () => resolve({ response: 1, checkboxChecked: false });
      });
  });
}

async function trustDialogCount(): Promise<number> {
  return application.evaluate(() => {
    const state = globalThis as typeof globalThis & { __m5TrustDialogCount?: number };
    return state.__m5TrustDialogCount ?? 0;
  });
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
            const range = document.createRange();
            range.setStart(node, match);
            range.setEnd(node, match + 1);
            const rectangle = range.getBoundingClientRect();
            return {
              x: rectangle.left + rectangle.width / 2,
              y: rectangle.top + rectangle.height / 2,
            };
          }
          remaining -= 1;
          searchFrom = match + target.needle.length;
        }
      }
      throw new Error(`找不到源码文本 ${target.needle}`);
    },
    { needle, occurrence },
  );
  await page.mouse.click(point.x, point.y);
}
