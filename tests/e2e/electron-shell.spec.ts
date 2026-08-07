import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompileRequest } from "../../src/shared/api.js";

// Every launch gets its own workspace root and Electron profile. Without them these specs
// write into the user's real Documents workspace and share one browser profile, which both
// pollutes real data and lets state leak between spec files under `workers: 1`.
const e2eWorkspaceRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-workspace-"));
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let electronApplication: ElectronApplication | undefined;
let page: Page;
let importFixtureDirectory = "";
let importFixturePath = "";

function getElectronApplication(): ElectronApplication {
  if (electronApplication === undefined) {
    throw new Error("Electron 应用尚未启动");
  }
  return electronApplication;
}

test.beforeAll(async () => {
  importFixtureDirectory = await mkdtemp(join(tmpdir(), "panel-e2e-import-"));
  importFixturePath = join(importFixtureDirectory, "保真.c");
  await writeFile(
    importFixturePath,
    Buffer.from("\uFEFF// 中文\r\nint main(void) { return 0; }\r\n", "utf8"),
  );
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  electronApplication = await electron.launch({
    args: [".", `--user-data-dir=${e2eProfileRoot}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_WORKSPACE_ROOT: e2eWorkspaceRoot,
      PANEL_RUNNER_MODE: "trusted-only",
    },
  });
  page = await electronApplication.firstWindow();
  await page.addInitScript(() => {
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
});

test("imports through the native dialog without exposing an absolute path", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }, path) => {
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{ readonly canceled: boolean; readonly filePaths: string[] }>;
    };
    mutableDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, importFixturePath);

  const result = await page.evaluate(() => window.panelApi.openSource());

  expect(result).toEqual({
    status: "opened",
    document: {
      source: "\uFEFF// 中文\r\nint main(void) { return 0; }\r\n",
      displayName: "保真.c",
      origin: "dialog",
    },
  });
  expect(JSON.stringify(result)).not.toContain(importFixtureDirectory);
});

test("imports a disk-backed dropped File and rejects a synthetic File", async () => {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "e2e-disk-file";
    document.body.append(input);
  });
  const input = page.locator("#e2e-disk-file");
  await input.setInputFiles(importFixturePath);

  const result = await page.evaluate(() => {
    const file = (document.querySelector("#e2e-disk-file") as HTMLInputElement | null)?.files?.[0];
    if (file === undefined) {
      throw new Error("测试未得到 disk-backed File");
    }
    return window.panelApi.openDroppedSource(file);
  });
  const synthetic = await page.evaluate(() =>
    window.panelApi.openDroppedSource(new File(["int x;"], "synthetic.c", { type: "text/x-c" })),
  );

  expect(result).toMatchObject({
    status: "opened",
    document: { displayName: "保真.c", origin: "drop" },
  });
  expect(synthetic).toMatchObject({
    status: "failed",
    error: { code: "SOURCE_INVALID_DROP" },
  });
  await input.evaluate((element) => element.remove());
});

test("serializes native and dropped source imports behind one main-process gate", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __panelSourceDialogCount?: number;
      __resolvePanelSourceDialog?: () => void;
    };
    state.__panelSourceDialogCount = 0;
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{
        readonly canceled: boolean;
        readonly filePaths: string[];
      }>;
    };
    mutableDialog.showOpenDialog = () =>
      new Promise((resolve) => {
        state.__panelSourceDialogCount = (state.__panelSourceDialogCount ?? 0) + 1;
        state.__resolvePanelSourceDialog = () => resolve({ canceled: true, filePaths: [] });
      });
  });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "e2e-concurrent-disk-file";
    document.body.append(input);
  });
  const input = page.locator("#e2e-concurrent-disk-file");
  await input.setInputFiles(importFixturePath);

  const firstRequest = page.evaluate(() => window.panelApi.openSource());
  try {
    await expect
      .poll(() =>
        application.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __panelSourceDialogCount?: number;
          };
          return state.__panelSourceDialogCount ?? 0;
        }),
      )
      .toBe(1);

    const concurrentOpen = await page.evaluate(() => window.panelApi.openSource());
    const concurrentDrop = await page.evaluate(() => {
      const file = (document.querySelector("#e2e-concurrent-disk-file") as HTMLInputElement | null)
        ?.files?.[0];
      if (file === undefined) {
        throw new Error("测试未得到并发导入所需的 disk-backed File");
      }
      return window.panelApi.openDroppedSource(file);
    });

    expect(concurrentOpen).toMatchObject({
      status: "failed",
      error: { code: "SOURCE_IMPORT_BUSY" },
    });
    expect(concurrentDrop).toMatchObject({
      status: "failed",
      error: { code: "SOURCE_IMPORT_BUSY" },
    });
    const dialogCount = await application.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __panelSourceDialogCount?: number;
      };
      return state.__panelSourceDialogCount ?? 0;
    });
    expect(dialogCount).toBe(1);
  } finally {
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __resolvePanelSourceDialog?: () => void;
      };
      state.__resolvePanelSourceDialog?.();
    });
    await expect(firstRequest).resolves.toEqual({ status: "cancelled" });
    await input.evaluate((element) => element.remove());
  }
});

test("drops a pending native result when its renderer frame reloads", async () => {
  const application = getElectronApplication();
  const staleFixturePath = join(importFixtureDirectory, "stale-context.c");
  const staleSentinel = "STALE_IMPORT_RESULT_MUST_NOT_REACH_NEW_FRAME";
  await writeFile(staleFixturePath, `/* ${staleSentinel} */\nint stale(void) { return 1; }\n`);
  await application.evaluate(
    ({ dialog }, paths) => {
      const state = globalThis as typeof globalThis & {
        __panelStaleDialogCount?: number;
        __resolvePanelStaleDialog?: () => void;
      };
      state.__panelStaleDialogCount = 0;
      const mutableDialog = dialog as unknown as {
        showOpenDialog: () => Promise<{
          readonly canceled: boolean;
          readonly filePaths: string[];
        }>;
      };
      mutableDialog.showOpenDialog = () => {
        state.__panelStaleDialogCount = (state.__panelStaleDialogCount ?? 0) + 1;
        if (state.__panelStaleDialogCount === 1) {
          return new Promise((resolve) => {
            state.__resolvePanelStaleDialog = () =>
              resolve({ canceled: false, filePaths: [paths.stale] });
          });
        }
        return Promise.resolve({ canceled: false, filePaths: [paths.fresh] });
      };
    },
    { stale: staleFixturePath, fresh: importFixturePath },
  );

  const staleRequest = page
    .evaluate(() => window.panelApi.openSource())
    .then(
      (result) => ({ state: "resolved" as const, result }),
      (error: unknown) => ({
        state: "context-destroyed" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  await expect
    .poll(() =>
      application.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __panelStaleDialogCount?: number;
        };
        return state.__panelStaleDialogCount ?? 0;
      }),
    )
    .toBe(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __resolvePanelStaleDialog?: () => void;
    };
    state.__resolvePanelStaleDialog?.();
  });

  const staleOutcome = await staleRequest;
  if (staleOutcome.state === "resolved") {
    expect(staleOutcome.result).toMatchObject({
      status: "failed",
      error: { code: "SOURCE_CONTEXT_CLOSED" },
    });
  }

  // Reload normally destroys the old evaluate context, so its discriminated result cannot be
  // observed directly. The stable contract is that resolving the old dialog releases the main
  // gate, never writes its source into the new frame, and lets that frame import independently.
  await expect(page.locator("body")).not.toContainText(staleSentinel);
  let freshResult: Awaited<ReturnType<Window["panelApi"]["openSource"]>> | undefined;
  await expect
    .poll(async () => {
      const result = await page.evaluate(() => window.panelApi.openSource());
      if (result.status === "opened") {
        freshResult = result;
        return "opened";
      }
      if (result.status === "failed" && result.error.code === "SOURCE_IMPORT_BUSY") {
        return "busy";
      }
      return `${result.status}:unexpected`;
    })
    .toBe("opened");
  expect(freshResult).toMatchObject({
    status: "opened",
    document: { displayName: "保真.c", origin: "dialog" },
  });
  await expect(page.locator("body")).not.toContainText(staleSentinel);
});

test("keeps native trust confirmation in main and rejects stale renderer acknowledgements", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __panelTrustDialogDetails?: string[];
    };
    state.__panelTrustDialogDetails = [];
    const mutableDialog = dialog as unknown as {
      showMessageBox: (
        window: unknown,
        options: { readonly detail?: string },
      ) => Promise<{ readonly response: number; readonly checkboxChecked: boolean }>;
    };
    mutableDialog.showMessageBox = async (_window, options) => {
      state.__panelTrustDialogDetails?.push(options.detail ?? "");
      return { response: 0, checkboxChecked: false };
    };
  });

  const rejected = await page.evaluate(() =>
    window.panelApi.compile({ source: "int main(void){return 0;}" }),
  );
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "TRUST_CONFIRMATION_REQUIRED" },
  });

  const staleAcknowledgement = await page.evaluate(() => {
    const request = {
      source: "int main(void){return 0;}",
      trustedAcknowledgement: { acknowledged: true, scope: "this-request" },
    } as unknown as CompileRequest;
    return window.panelApi.compile(request);
  });
  expect(staleAcknowledgement).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST" },
  });

  const details = await application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __panelTrustDialogDetails?: string[];
    };
    return state.__panelTrustDialogDetails ?? [];
  });
  expect(details).toHaveLength(1);
  expect(details[0]).toContain("操作：编译 C 源码");
  expect(details[0]).toMatch(/请求 SHA-256：[0-9a-f]{64}/u);
  expect(details[0]).toContain("授权仅绑定上述请求摘要");
});

test("opens at most one native confirmation dialog for concurrent requests", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __panelTrustDialogCount?: number;
      __resolvePanelTrustDialog?: () => void;
    };
    state.__panelTrustDialogCount = 0;
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = () =>
      new Promise((resolve) => {
        state.__panelTrustDialogCount = (state.__panelTrustDialogCount ?? 0) + 1;
        state.__resolvePanelTrustDialog = () => resolve({ response: 0, checkboxChecked: false });
      });
  });

  const firstRequest = page.evaluate(() =>
    window.panelApi.compile({ source: "int main(void){return 0;}" }),
  );
  await expect
    .poll(() =>
      application.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __panelTrustDialogCount?: number;
        };
        return state.__panelTrustDialogCount ?? 0;
      }),
    )
    .toBe(1);

  const concurrentRequest = await page.evaluate(() =>
    window.panelApi.compile({ source: "int main(void){return 1;}" }),
  );
  expect(concurrentRequest).toMatchObject({
    ok: false,
    error: { code: "RUNNER_BUSY" },
  });

  await application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __resolvePanelTrustDialog?: () => void;
    };
    state.__resolvePanelTrustDialog?.();
  });
  await expect(firstRequest).resolves.toMatchObject({
    ok: false,
    error: { code: "TRUST_CONFIRMATION_REQUIRED" },
  });
  const dialogCount = await application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __panelTrustDialogCount?: number;
    };
    return state.__panelTrustDialogCount ?? 0;
  });
  expect(dialogCount).toBe(1);
});

test("grants exactly one compile and one run after separate native confirmations", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __panelTrustResponses?: number[];
      __panelAcceptedDialogCount?: number;
    };
    state.__panelTrustResponses = [1, 1, 0];
    state.__panelAcceptedDialogCount = 0;
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => {
      state.__panelAcceptedDialogCount = (state.__panelAcceptedDialogCount ?? 0) + 1;
      return {
        response: state.__panelTrustResponses?.shift() ?? 0,
        checkboxChecked: false,
      };
    };
  });

  const compileResult = await page.evaluate(() =>
    window.panelApi.compile({
      source: '#include <stdio.h>\nint main(void){fputs("hello\\n", stdout);return 0;}',
      sourceName: "hello.c",
    }),
  );
  expect(compileResult).toMatchObject({ ok: true });
  if (!compileResult.ok) {
    throw new Error(`hello compile failed: ${compileResult.error.message}`);
  }

  const runResult = await page.evaluate(
    (artifactId) => window.panelApi.run({ artifactId }),
    compileResult.artifactId,
  );
  expect(runResult).toMatchObject({
    ok: true,
    termination: "process-exit",
    exitCode: 0,
  });
  expect(Array.from(runResult.stdout)).toEqual(Array.from(new TextEncoder().encode("hello\n")));

  const cancelledNextRequest = await page.evaluate(() =>
    window.panelApi.compile({ source: "int main(void){return 0;}" }),
  );
  expect(cancelledNextRequest).toMatchObject({
    ok: false,
    error: { code: "TRUST_CONFIRMATION_REQUIRED" },
  });
  const dialogCount = await application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __panelAcceptedDialogCount?: number;
    };
    return state.__panelAcceptedDialogCount ?? 0;
  });
  expect(dialogCount).toBe(3);
});

test("streams a Verified Run through a window-bound, bounded session", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });

  const compileResult = await page.evaluate(() =>
    window.panelApi.compile({
      source: '#include <stdio.h>\nint main(void){fputs("verified\\n", stdout);return 0;}',
      sourceName: "verified.c",
    }),
  );
  expect(compileResult).toMatchObject({ ok: true });
  if (!compileResult.ok) throw new Error(compileResult.error.message);
  const started = await page.evaluate(
    (artifactId) => window.panelApi.startRun({ artifactId }),
    compileResult.artifactId,
  );
  expect(started).toMatchObject({ ok: true, status: "preparing" });
  if (!started.ok) throw new Error(started.error.message);

  await expect(
    page.evaluate((sessionId) => window.panelApi.readRun(sessionId, -1), started.sessionId),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  await expect(
    page.evaluate(() => window.panelApi.readRun("run_not_owned_00000000", 0)),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

  let afterSequence = 0;
  const output: number[] = [];
  let finalResult: Awaited<ReturnType<Window["panelApi"]["readRun"]>> | undefined;
  await expect
    .poll(async () => {
      const batch = await page.evaluate(
        ({ sessionId, cursor }) => window.panelApi.readRun(sessionId, cursor),
        { sessionId: started.sessionId, cursor: afterSequence },
      );
      if (!batch.ok) return batch.error.code;
      for (const event of batch.events) {
        if (event.stream === "stdout") output.push(...event.data);
      }
      afterSequence = batch.nextSequence;
      finalResult = batch;
      return batch.result === null ? batch.status : "settled";
    })
    .toBe("settled");
  expect(finalResult).toMatchObject({
    ok: true,
    status: "completed",
    result: { ok: true, exitCode: 0 },
  });
  expect(output).toEqual(Array.from(new TextEncoder().encode("verified\n")));
  await expect(
    page.evaluate((sessionId) => window.panelApi.readRun(sessionId, 0), started.sessionId),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});

test("cancels Verified Run and releases the shared runner gate after native reap", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });

  const compiled = await page.evaluate(() =>
    window.panelApi.compile({
      source: "int main(void){for(;;){} return 0;}",
      sourceName: "cancel.c",
    }),
  );
  expect(compiled).toMatchObject({ ok: true });
  if (!compiled.ok) throw new Error(compiled.error.message);
  const started = await page.evaluate(
    (artifactId) => window.panelApi.startRun({ artifactId }),
    compiled.artifactId,
  );
  expect(started).toMatchObject({ ok: true });
  if (!started.ok) throw new Error(started.error.message);
  await expect(
    page.evaluate((sessionId) => window.panelApi.cancelRun(sessionId), started.sessionId),
  ).resolves.toMatchObject({ ok: true, status: "cancelled" });

  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        window.panelApi.compile({ source: "int main(void){return 0;}", sourceName: "next.c" }),
      );
      return result.ok ? "ok" : result.error.code;
    })
    .toBe("ok");
  await expect
    .poll(async () => {
      const batch = await page.evaluate(
        (sessionId) => window.panelApi.readRun(sessionId, 0),
        started.sessionId,
      );
      return batch.ok && batch.result !== null ? batch.status : "settling";
    })
    .toBe("cancelled");
});

test("rejects every Verified Run channel from a BrowserWindow outside the workbench set", async () => {
  const application = getElectronApplication();
  const outcomes = await application.evaluate(
    async ({ BrowserWindow }, options) => {
      const untrustedWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      try {
        await untrustedWindow.loadURL(options.rendererUrl);
        return (await untrustedWindow.webContents.executeJavaScript(`
          Promise.all([
            window.panelApi.startRun({ artifactId: "artifact_untrusted_00000001" }),
            window.panelApi.readRun("run_untrusted_session_00000001", 0),
            window.panelApi.cancelRun("run_untrusted_session_00000001")
          ].map((request) => request.then(
            () => "resolved",
            (error) => String(error?.message ?? error)
          )))
        `)) as string[];
      } finally {
        untrustedWindow.destroy();
      }
    },
    {
      rendererUrl: page.url(),
      preloadPath: join(process.cwd(), "dist-electron/preload/index.cjs"),
    },
  );

  expect(outcomes).toHaveLength(3);
  for (const outcome of outcomes) {
    expect(outcome).not.toBe("resolved");
    expect(outcome).toMatch(/非工作台|IPC/u);
  }
});

test("opens the local desktop shell with a narrow preload API", async () => {
  const systemLocale = await page.evaluate(() => window.panelApi.getSystemLocale());
  const appInfo = await page.evaluate(() => window.panelApi.getAppInfo());
  expect(appInfo).toMatchObject({
    version: "0.1.1-preview.3",
    license: "PolyForm-Noncommercial-1.0.0",
    repositoryUrl: "https://github.com/Ice-teapop/algolatch",
    releasesUrl: "https://github.com/Ice-teapop/algolatch/releases",
    platform: process.platform,
    electronVersion: "43.0.0",
  });
  const expectedTitle = "AlgoLatch";
  await expect(page).toHaveTitle(expectedTitle);
  await expect(page.getByRole("heading", { name: expectedTitle })).toHaveCount(0);
  await expect(page.locator("#startup-loader")).toBeHidden();

  const rendererBoundary = await page.evaluate(() => ({
    apiKeys: Object.keys(window.panelApi).sort(),
    forbiddenApiKeys: [
      "readFile",
      "openPath",
      "getPathForFile",
      "path",
      "send",
      "on",
      "shell",
      "exec",
      "spawn",
      "openTerminal",
      "writeTerminal",
      "resizeTerminal",
      "interruptTerminal",
      "closeTerminal",
      "subscribeTerminalEvents",
    ].filter((key) => key in (window.panelApi as unknown as Record<string, unknown>)),
    hasNodeProcess: "process" in window,
    hasNodeRequire: "require" in window,
  }));

  expect(rendererBoundary).toEqual({
    apiKeys: [
      "appendAiConversationMessage",
      "cancelAiMentor",
      "cancelRun",
      "cancelTrace",
      "capabilities",
      "compile",
      "connectAiProvider",
      "createAiConversation",
      "createWorkspaceDocument",
      "deleteAiConversation",
      "diagnose",
      "disconnectAiProvider",
      "getAiProviderConfig",
      "getAppInfo",
      "getSystemLocale",
      "listAiProviderModels",
      "listWorkspaceDocuments",
      "onAiWindowClosed",
      "onAiWindowIntent",
      "onWorkspaceCloseRequested",
      "openAiProject",
      "openAiWindow",
      "openDroppedSource",
      "openSource",
      "openWorkspaceDocument",
      "publishAiWindowState",
      "readAiConversation",
      "readAiMentor",
      "readLearningCatalog",
      "readRun",
      "readTrace",
      "readWorkspaceSidecar",
      "renameAiConversation",
      "run",
      "saveLearningCatalog",
      "saveWorkspaceDocument",
      "saveWorkspaceSidecar",
      "selectAiProviderModel",
      "setAiConversationArchived",
      "setInterfaceLocale",
      "startAiMentor",
      "startRun",
      "startTrace",
      "toggleAiWindow",
    ],
    forbiddenApiKeys: [],
    hasNodeProcess: false,
    hasNodeRequire: false,
  });

  const alternateLocale: "zh-CN" | "en" = systemLocale === "en" ? "zh-CN" : "en";
  await page.evaluate((locale) => window.panelApi.setInterfaceLocale?.(locale), alternateLocale);
  await expect
    .poll(() =>
      getElectronApplication().evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getTitle(),
      ),
    )
    .toBe("AlgoLatch");
  await page.evaluate((locale) => window.panelApi.setInterfaceLocale?.(locale), systemLocale);

  const capabilitySnapshot = await page.evaluate(async () => {
    const first = await window.panelApi.capabilities();
    try {
      (first as { mode: string }).mode = "disabled";
      (first.isolationProbe as { detail: string }).detail = "renderer-tampered";
    } catch {
      // A future Electron bridge may preserve freezing; isolation is still required.
    }
    const second = await window.panelApi.capabilities();
    return {
      distinctSnapshots: first !== second,
      secondMode: second.mode,
      secondDetail: second.isolationProbe.detail,
    };
  });
  expect(capabilitySnapshot.distinctSnapshots).toBe(true);
  expect(capabilitySnapshot.secondMode).toBe("trusted-only");
  expect(capabilitySnapshot.secondDetail).not.toBe("renderer-tampered");

  const contentSecurityPolicy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(contentSecurityPolicy).toContain("default-src 'self'");
  expect(contentSecurityPolicy).toContain("object-src 'none'");
  const scriptPolicy = contentSecurityPolicy
    ?.split(";")
    .map((directive) => directive.trim().split(/\s+/u))
    .find(([name]) => name === "script-src");
  expect(scriptPolicy).toContain("'wasm-unsafe-eval'");
  expect(scriptPolicy).not.toContain("'unsafe-eval'");
  expect(scriptPolicy).not.toContain("'unsafe-inline'");
  const stylePolicy = contentSecurityPolicy
    ?.split(";")
    .map((directive) => directive.trim().split(/\s+/u))
    .find(([name]) => name === "style-src");
  const styleAttributePolicy = contentSecurityPolicy
    ?.split(";")
    .map((directive) => directive.trim().split(/\s+/u))
    .find(([name]) => name === "style-src-attr");
  expect(stylePolicy).not.toContain("'unsafe-inline'");
  expect(styleAttributePolicy).toContain("'unsafe-inline'");
  const scriptSources = await page
    .locator("script[src]")
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src));
  expect(scriptSources.every((source) => source.startsWith("file://"))).toBe(true);
});

test("loads both WASM modules and projects an explicitly opened C document", async () => {
  const runtimeFailures: string[] = [];
  const wasmRequests: string[] = [];
  const onPageError = (error: Error) => runtimeFailures.push(`pageerror: ${error.message}`);
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.url().includes(".wasm")) {
      wasmRequests.push(request.url());
    }
  };
  const onRequestFailed = (request: import("@playwright/test").Request) => {
    if (request.url().includes(".wasm")) {
      runtimeFailures.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    }
  };
  page.on("pageerror", onPageError);
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    const parserStatus = page.locator("#parser-status");
    await expect(parserStatus).toHaveAttribute("data-state", "ready");
    await page.getByRole("button", { name: "粘贴源码" }).click();
    await page.locator("#paste-source").fill("int main(void) { return 0; }\n");
    await page.getByRole("button", { name: "载入工作台" }).click();
    await expect(parserStatus).toHaveAttribute("data-root-type", "translation_unit");
    await expect(parserStatus).toHaveAttribute("data-function-count", "1");
    await expect(parserStatus).toHaveAttribute("data-roundtrip", "true");

    // Renderer projection and the analysis Worker are separate WASM contexts.
    expect(wasmRequests.filter((name) => name.includes("web-tree-sitter-")).length).toBe(2);
    expect(wasmRequests.filter((name) => name.includes("tree-sitter-c-")).length).toBe(2);
    expect(runtimeFailures).toEqual([]);
  } finally {
    page.off("pageerror", onPageError);
    page.off("request", onRequest);
    page.off("requestfailed", onRequestFailed);
  }
});

test("uses the enforced BrowserWindow security preferences", async () => {
  const expectedWindowVisible = process.env.PANEL_E2E_HIDE_WINDOW !== "1";
  const security = await getElectronApplication().evaluate(({ app, BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0] as
      | (Electron.BrowserWindow & {
          readonly panelSecurityPreferences?: Readonly<Electron.WebPreferences>;
        })
      | undefined;

    if (mainWindow === undefined) {
      throw new Error("Electron 主窗口未创建");
    }

    const processMetric = app
      .getAppMetrics()
      .find((metric) => metric.pid === mainWindow.webContents.getOSProcessId());
    const preferences = mainWindow.panelSecurityPreferences;

    return {
      contextIsolation: preferences?.contextIsolation,
      nodeIntegration: preferences?.nodeIntegration,
      sandbox: preferences?.sandbox,
      webSecurity: preferences?.webSecurity,
      navigateOnDragDrop: preferences?.navigateOnDragDrop,
      rendererProcessSandboxed: processMetric?.sandboxed,
      visible: mainWindow.isVisible(),
    };
  });

  expect(security).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    navigateOnDragDrop: false,
    rendererProcessSandboxed: true,
    visible: expectedWindowVisible,
  });
});

test("reaps an active Verified Run process when the application window closes", async () => {
  const application = getElectronApplication();
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const processIdSource =
    process.platform === "win32"
      ? [
          "#include <stdio.h>",
          "#include <windows.h>",
          "int main(void){",
          '  printf("%lu\\n", (unsigned long)GetCurrentProcessId());',
          "  fflush(stdout);",
          "  for(;;){}",
          "  return 0;",
          "}",
        ].join("\n")
      : [
          "#include <stdio.h>",
          "#include <unistd.h>",
          "int main(void){",
          '  printf("%d\\n", (int)getpid());',
          "  fflush(stdout);",
          "  for(;;){}",
          "  return 0;",
          "}",
        ].join("\n");
  const compiled = await page.evaluate(
    (source) =>
      window.panelApi.compile({
        source,
        sourceName: "close-reap.c",
      }),
    processIdSource,
  );
  expect(compiled).toMatchObject({ ok: true });
  if (!compiled.ok) throw new Error(compiled.error.message);
  const started = await page.evaluate(
    (artifactId) => window.panelApi.startRun({ artifactId }),
    compiled.artifactId,
  );
  expect(started).toMatchObject({ ok: true });
  if (!started.ok) throw new Error(started.error.message);

  let childPid = 0;
  await expect
    .poll(async () => {
      const batch = await page.evaluate(
        (sessionId) => window.panelApi.readRun(sessionId, 0),
        started.sessionId,
      );
      if (!batch.ok) return 0;
      const stdout = batch.events
        .filter((event) => event.stream === "stdout")
        .flatMap((event) => [...event.data]);
      childPid = Number.parseInt(new TextDecoder().decode(Uint8Array.from(stdout)), 10);
      return childPid;
    })
    .toBeGreaterThan(1);

  await application.close();
  electronApplication = undefined;
  await expect.poll(() => isProcessAlive(childPid)).toBe(false);
});

test.afterAll(async () => {
  await electronApplication?.close();
  await rm(importFixtureDirectory, { recursive: true, force: true });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
