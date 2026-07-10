import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_NAME = "m2-workbench.c";
const FIXTURE_SOURCE = `${[
  "\uFEFF#include <stdio.h>",
  "",
  "int main(void) {",
  "  int total = 0;",
  "  for (int i = 0; i < 3; i++) {",
  "    total += i;",
  "  }",
  '  printf("%d\\n", total);',
  "  return 0;",
  "}",
].join("\r\n")}\r\n`;
const FIXTURE_EDITOR_TEXT = FIXTURE_SOURCE.replaceAll("\r\n", "\n").replace("\uFEFF", "•");
const PASTED_SOURCE = "int main(void) {\n  int pasted = 1;\n  return pasted;\n}\n";

let electronApplication: ElectronApplication | undefined;
let page: Page;
let fixtureDirectory = "";
let fixturePath = "";

function getElectronApplication(): ElectronApplication {
  if (electronApplication === undefined) {
    throw new Error("Electron 应用尚未启动");
  }
  return electronApplication;
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "panel-m2-workbench-"));
  fixturePath = join(fixtureDirectory, FIXTURE_NAME);
  await writeFile(fixturePath, FIXTURE_SOURCE, "utf8");

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
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __m2CspViolations?: Array<{
        readonly blockedUri: string;
        readonly directive: string;
      }>;
    };
    state.__m2CspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      state.__m2CspViolations?.push({
        blockedUri: event.blockedURI,
        directive: event.effectiveDirective,
      });
    });
  });

  await getElectronApplication().evaluate(({ dialog }, path) => {
    const state = globalThis as typeof globalThis & {
      __m2OpenDialogCount?: number;
    };
    state.__m2OpenDialogCount = 0;
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{
        readonly canceled: boolean;
        readonly filePaths: string[];
      }>;
    };
    mutableDialog.showOpenDialog = async () => {
      state.__m2OpenDialogCount = (state.__m2OpenDialogCount ?? 0) + 1;
      return { canceled: false, filePaths: [path] };
    };
  }, fixturePath);
});

test.beforeEach(async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("button", { name: "打开 C 文件" })).toBeEnabled();
});

test("opens a BOM + CRLF C file through the visible native-dialog action", async () => {
  await getElectronApplication().evaluate(() => {
    const state = globalThis as typeof globalThis & { __m2OpenDialogCount?: number };
    state.__m2OpenDialogCount = 0;
  });

  await loadFixtureThroughOpenButton();

  await expect(page.locator("#source-meta")).toContainText("CRLF");
  await expect(page.locator("#source-meta")).toContainText(
    `${Buffer.byteLength(FIXTURE_SOURCE, "utf8")} B`,
  );
  expect(await editorText()).toBe(FIXTURE_EDITOR_TEXT);
  await expect(page.locator(".cm-specialChar")).toHaveAttribute(
    "title",
    /zero width no-break space/u,
  );
  const dialogCount = await getElectronApplication().evaluate(() => {
    const state = globalThis as typeof globalThis & { __m2OpenDialogCount?: number };
    return state.__m2OpenDialogCount ?? 0;
  });
  expect(dialogCount).toBe(1);
});

test("dispatches a real disk-backed File through the workbench drop UI", async () => {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "m2-disk-backed-file";
    input.hidden = true;
    document.body.append(input);
  });
  const input = page.locator("#m2-disk-backed-file");
  await input.setInputFiles(fixturePath);

  try {
    await page.evaluate(() => {
      const file = (document.querySelector("#m2-disk-backed-file") as HTMLInputElement | null)
        ?.files?.[0];
      const shell = document.querySelector("#workbench-shell");
      if (file === undefined || shell === null) {
        throw new Error("未得到磁盘 File 或工作台节点");
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const state = globalThis as typeof globalThis & { __m2DropTransfer?: DataTransfer };
      state.__m2DropTransfer = transfer;
      shell.dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      shell.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect(page.locator("#drop-overlay")).toBeVisible();

    await page.evaluate(() => {
      const shell = document.querySelector("#workbench-shell");
      const state = globalThis as typeof globalThis & { __m2DropTransfer?: DataTransfer };
      if (shell === null || state.__m2DropTransfer === undefined) {
        throw new Error("拖放状态丢失");
      }
      shell.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: state.__m2DropTransfer,
        }),
      );
      delete state.__m2DropTransfer;
    });

    await expect(page.locator("#drop-overlay")).toBeHidden();
    await expect(page.locator("#file-name")).toHaveText(FIXTURE_NAME);
    await expect(page.locator("#import-status")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#import-status")).toHaveText(`已载入 ${FIXTURE_NAME}。`);
    expect(await editorText()).toBe(FIXTURE_EDITOR_TEXT);
  } finally {
    await input.evaluate((element) => element.remove());
  }
});

test("loads pasted C source through the visible modal dialog", async () => {
  await page.getByRole("button", { name: "粘贴源码" }).click();
  const dialog = page.getByRole("dialog", { name: "粘贴 C 源码" });
  const textarea = page.locator("#paste-source");
  await expect(dialog).toBeVisible();
  await expect(textarea).toBeFocused();

  await textarea.fill(PASTED_SOURCE);
  await page.getByRole("button", { name: "载入工作台" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator("#file-name")).toHaveText("pasted.c");
  await expect(page.locator("#import-status")).toHaveText("已载入 pasted.c。");
  expect(await editorText()).toBe(PASTED_SOURCE);
});

test("selects nested for and return blocks and paints the primary CodeMirror range", async () => {
  await loadFixtureThroughOpenButton();
  const primary = page.locator('[data-code-highlight-kind="primary"]');

  const forBlock = page.locator('[data-node-type="for_statement"]').first();
  await forBlock.click();
  await expect(forBlock).toHaveAttribute("aria-selected", "true");
  await expect(primary.first()).toBeVisible();
  expect((await primary.allTextContents()).join(" ")).toContain("for (int i = 0");

  const returnBlock = page.locator('[data-node-type="return_statement"]').first();
  await returnBlock.click();
  await expect(returnBlock).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('#block-tree [aria-selected="true"]')).toHaveCount(1);
  await expect(primary.first()).toBeVisible();
  expect((await primary.allTextContents()).join(" ")).toContain("return 0;");
});

test("clicks a CodeMirror variable and links declaration, uses, and the selected block", async () => {
  await loadFixtureThroughOpenButton();

  await clickCodeOccurrence("total", 0);

  const declarationMarks = page.locator(
    '[data-code-highlight-kind="symbol-declaration"][title^="total"]',
  );
  const useMarks = page.locator('[data-code-highlight-kind="symbol-use"][title^="total"]');
  await expect(declarationMarks.first()).toBeVisible();
  await expect(useMarks).toHaveCount(2);
  const selectedDeclaration = page.locator('[data-node-type="declaration"][aria-selected="true"]');
  await expect(selectedDeclaration).toHaveCount(1);
  await expect(selectedDeclaration.locator(".block-card__excerpt")).toContainText("int total");
  await expect(page.locator('.symbol-card[data-focused="true"] code')).toHaveText("total");
});

test("compiles and runs from the UI after exactly two accepted native trust prompts", async () => {
  await loadFixtureThroughOpenButton();
  await page.getByRole("tab", { name: "运行" }).click();
  await getElectronApplication().evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { __m2TrustDialogCount?: number };
    state.__m2TrustDialogCount = 0;
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => {
      state.__m2TrustDialogCount = (state.__m2TrustDialogCount ?? 0) + 1;
      return { response: 1, checkboxChecked: false };
    };
  });

  const runPanel = page.locator(".run-panel");
  await expect(runPanel).toHaveAttribute("data-state", "ready");
  await expect(page.locator('[data-run-field="mode"]')).toContainText("可信代码模式");
  await expect(page.locator('[data-run-field="trust-confirmation"]')).toContainText("需要");
  await page.getByRole("button", { name: "编译并运行" }).click();

  await expect(runPanel).toHaveAttribute("data-state", "success", { timeout: 15_000 });
  expect(await page.locator('[data-run-field="stdout"]').evaluate((node) => node.textContent)).toBe(
    "3\n",
  );
  await expect(page.locator('[data-run-field="exit-code"]')).toHaveText("0");
  await expect(page.locator('[data-run-field="termination"]')).toContainText("process-exit");
  const trustDialogCount = await getElectronApplication().evaluate(() => {
    const state = globalThis as typeof globalThis & { __m2TrustDialogCount?: number };
    return state.__m2TrustDialogCount ?? 0;
  });
  expect(trustDialogCount).toBe(2);
});

test("keeps CodeMirror read-only and injects nonce-bearing styles without CSP violations", async () => {
  await loadFixtureThroughOpenButton();
  const content = page.locator(".cm-content");
  await expect(content).toHaveAttribute("contenteditable", "true");
  await expect(content).toHaveAttribute("aria-readonly", "true");
  const before = await editorText();

  await content.click();
  await page.keyboard.type("MUST_NOT_MUTATE");
  await page.keyboard.insertText("_OR_INSERT_");
  expect(await editorText()).toBe(before);

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  const nonce = /(?:^|;)\s*style-src[^;]*'nonce-([^']+)'/u.exec(csp ?? "")?.[1];
  expect(nonce).toBeTruthy();
  const styleNonces = await page
    .locator("style")
    .evaluateAll((styles) => styles.map((style) => (style as HTMLStyleElement).nonce));
  expect(styleNonces.length).toBeGreaterThan(0);
  expect(styleNonces.every((styleNonce) => styleNonce === nonce)).toBe(true);
  const violations = await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __m2CspViolations?: readonly unknown[];
    };
    return state.__m2CspViolations ?? [];
  });
  expect(violations).toEqual([]);
});

test("keeps the compact three-column workbench usable at the minimum window size", async () => {
  await getElectronApplication().evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(860, 600);
  });
  try {
    await expect(page.locator("#parser-status")).toBeVisible();
    await expect(page.locator("#import-status")).toBeVisible();
    await expect(page.locator("#block-tree")).toBeVisible();
    await expect(page.locator("#code-pane")).toBeVisible();
    await expect(page.locator("#explanation")).toBeVisible();
    await page.getByRole("tab", { name: "运行" }).click();
    await expect(page.getByRole("button", { name: "编译并运行" })).toBeVisible();
    const viewport = await page.evaluate(() => {
      const statusBar = document.querySelector(".status-bar")?.getBoundingClientRect();
      const codePane = document.querySelector("#code-pane")?.getBoundingClientRect();
      return {
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
        codePaneHeight: codePane?.height,
        statusTop: statusBar?.top,
        statusBottom: statusBar?.bottom,
        statusHeight: statusBar?.height,
      };
    });
    expect(viewport.scrollHeight).toBe(viewport.clientHeight);
    expect(viewport.codePaneHeight).toBeGreaterThan(400);
    expect(viewport.statusHeight).toBe(26);
    expect(viewport.statusTop).toBeGreaterThanOrEqual(0);
    expect(viewport.statusBottom).toBeLessThanOrEqual(viewport.clientHeight);
  } finally {
    await getElectronApplication().evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1180, 780);
    });
  }
});

test("switches the inspector tabs with the keyboard", async () => {
  const explanationTab = page.getByRole("tab", { name: "解释" });
  const runTab = page.getByRole("tab", { name: "运行" });
  await explanationTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(runTab).toBeFocused();
  await expect(runTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#runner-panel")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(explanationTab).toBeFocused();
  await expect(page.locator("#explanation-panel")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(runTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(explanationTab).toBeFocused();
  await page.keyboard.press("End");
  await expect(runTab).toBeFocused();
});

test("renders the application icon from the packaged renderer path", async () => {
  const icon = page.locator(".brand__mark");
  await expect(icon).toBeVisible();
  expect(
    await icon.evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }),
  ).toBe(true);
});

test.afterAll(async () => {
  await electronApplication?.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function loadFixtureThroughOpenButton(): Promise<void> {
  await page.getByRole("button", { name: "打开 C 文件" }).click();
  await expect(page.locator("#file-name")).toHaveText(FIXTURE_NAME);
  await expect(page.locator("#import-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#import-status")).toHaveText(`已载入 ${FIXTURE_NAME}。`);
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
