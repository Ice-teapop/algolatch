import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

type ExpectedParserState = "ready" | "recovery";

interface CorpusCase {
  readonly name: string;
  readonly path: string;
  readonly parserState: ExpectedParserState;
}

const projectRoot = resolve(import.meta.dirname, "../..");
const corpusRoot = resolve(projectRoot, "corpus/m4");
const corpusCases = readCorpusCases();

let application: ElectronApplication | undefined;
let page: Page;

test.describe.configure({ mode: "serial" });

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
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#startup-loader")).toBeHidden();

  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { __m4CorpusPath?: string };
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{
        readonly canceled: boolean;
        readonly filePaths: string[];
      }>;
    };
    mutableDialog.showOpenDialog = async () => {
      const path = state.__m4CorpusPath;
      return path === undefined
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [path] };
    };
  });
});

test.afterAll(async () => {
  await application?.close();
});

for (const corpusCase of corpusCases) {
  test(`imports and projects ${corpusCase.name} without a renderer crash`, async () => {
    const runtimeFailures: string[] = [];
    const onPageError = (error: Error): void => {
      runtimeFailures.push(error.message);
    };
    page.on("pageerror", onPageError);

    try {
      await requireApplication().evaluate((_electronModule, path) => {
        const state = globalThis as typeof globalThis & { __m4CorpusPath?: string };
        state.__m4CorpusPath = path;
      }, corpusCase.path);

      await page.locator("[role='tab'][data-workbench-page-id='build']").click();
      await page.locator("#open-source").click();

      await expect(page.locator("#file-name")).toHaveText(corpusCase.name);
      await expect(page.locator("#import-status")).toHaveAttribute("data-state", "ready");
      const parserStatus = page.locator("#parser-status");
      await expect(parserStatus).toHaveAttribute(
        "data-state",
        corpusCase.parserState === "ready" ? "ready" : "warning",
      );
      await expect(parserStatus).toHaveAttribute("data-root-type", "translation_unit");
      await expect(parserStatus).toHaveAttribute("data-roundtrip", "true");

      const blockTree = page.locator("#block-tree");
      await expect(blockTree).not.toHaveAttribute("aria-disabled", "true");
      const firstBlock = blockTree.locator("button[data-block-index]").first();
      await expect(firstBlock).toBeVisible();
      await firstBlock.click();
      await expect(firstBlock).toHaveAttribute("aria-selected", "true");
      expect(runtimeFailures).toEqual([]);
    } finally {
      page.off("pageerror", onPageError);
    }
  });
}

function requireApplication(): ElectronApplication {
  if (application === undefined) throw new Error("Electron 应用尚未启动");
  return application;
}

function readCorpusCases(): readonly CorpusCase[] {
  return Object.freeze(
    readdirSync(corpusRoot)
      .filter((name) => name.endsWith(".c"))
      .sort()
      .map((name) => {
        const expectedPath = resolve(corpusRoot, name.replace(/\.c$/u, ".expected.json"));
        const expected: unknown = JSON.parse(readFileSync(expectedPath, "utf8"));
        if (typeof expected !== "object" || expected === null || !("parserState" in expected)) {
          throw new Error(`${name}: expected snapshot 缺少 parserState`);
        }
        const parserState = expected.parserState;
        if (parserState !== "ready" && parserState !== "recovery") {
          throw new Error(`${name}: parserState 必须为 ready 或 recovery`);
        }
        return Object.freeze({ name, path: resolve(corpusRoot, name), parserState });
      }),
  );
}
