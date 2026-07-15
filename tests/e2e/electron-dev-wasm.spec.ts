import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

const DEVELOPMENT_SERVER_PORT = process.env.PANEL_E2E_PORT ?? "5173";
const DEVELOPMENT_SERVER_URL = `http://127.0.0.1:${DEVELOPMENT_SERVER_PORT}/`;

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
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      VITE_DEV_SERVER_URL: DEVELOPMENT_SERVER_URL,
    },
  });
  page = await electronApplication.firstWindow();
  await page.evaluate(() => {
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
});

test("loads both WASM modules through the Vite HTTP development path", async () => {
  const runtimeFailures: string[] = [];
  const wasmResponses: Response[] = [];
  const onPageError = (error: Error) => runtimeFailures.push(`pageerror: ${error.message}`);
  const onResponse = (response: Response) => {
    if (response.url().includes(".wasm")) {
      wasmResponses.push(response);
    }
  };
  const onRequestFailed = (request: Request) => {
    if (request.url().includes(".wasm")) {
      runtimeFailures.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    }
  };
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(page.url()).toBe(DEVELOPMENT_SERVER_URL);

    const parserStatus = page.locator("#parser-status");
    await expect(parserStatus).toHaveAttribute("data-state", "ready");
    await page.getByRole("button", { name: "粘贴源码" }).click();
    await page.locator("#paste-source").fill("int main(void) { return 0; }\n");
    await page.getByRole("button", { name: "载入工作台" }).click();
    await expect(parserStatus).toHaveAttribute("data-root-type", "translation_unit");
    await expect(parserStatus).toHaveAttribute("data-function-count", "1");
    await expect(parserStatus).toHaveAttribute("data-roundtrip", "true");

    const wasmPayloadResponses = wasmResponses.filter((response) =>
      response.headers()["content-type"]?.includes("application/wasm"),
    );
    const runtimeResponses = wasmPayloadResponses.filter((response) =>
      response.url().includes("web-tree-sitter.wasm"),
    );
    const languageResponses = wasmPayloadResponses.filter((response) =>
      response.url().includes("tree-sitter-c.wasm"),
    );
    // M5+ keeps the exact-source parser in the renderer and runs analysis in a
    // dedicated Worker. Each isolated execution context loads its own runtime
    // and C grammar, so two successful responses per asset are required.
    expect(runtimeResponses).toHaveLength(2);
    expect(languageResponses).toHaveLength(2);
    for (const response of [...runtimeResponses, ...languageResponses]) {
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toContain("application/wasm");
      expect(response.url().startsWith(DEVELOPMENT_SERVER_URL)).toBe(true);
    }
    expect(runtimeFailures).toEqual([]);
  } finally {
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
});

test.afterAll(async () => {
  await electronApplication?.close();
});
