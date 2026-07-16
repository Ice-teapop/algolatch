import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebPreferences,
} from "electron";
import type {
  CompileRequest,
  CompileResult,
  DiagnoseRequest,
  DiagnoseResult,
  RunRequest,
  RunnerErrorCode,
  RunResult,
  SourceImportResult,
} from "../../src/shared/api.js";
import {
  APP_APPLICATION_ID,
  APP_INFO_IPC_CHANNEL,
  APP_LICENSE_ID,
  APP_PRODUCT_NAME,
  APP_RELEASES_URL,
  APP_REPOSITORY_URL,
  type AppInfoSnapshot,
} from "../../src/shared/app-info.js";
import {
  isInterfaceLocale,
  resolveSystemInterfaceLocale,
  type InterfaceLocale,
} from "../../src/shared/interface-locale.js";
import {
  learningCatalogStoreFailure,
  type LearningCatalogReadResult,
  type LearningCatalogSaveResult,
} from "../../src/shared/learning-catalog-store.js";
import {
  isTerminalTraceStatus,
  type TraceBatch,
  type TraceCancelResult,
  type TraceRequest,
  type TraceStartResult,
} from "../../src/shared/trace.js";
import {
  cancelTrace,
  compile,
  createTrustedExecutionGrant,
  diagnose,
  describeTrustedRequest,
  disposeRunner,
  getCapabilities,
  readTrace,
  run,
  startTrace,
  type TrustedExecutionGrant,
  type TrustedOperation,
  type TrustedRequestSummary,
} from "./runner/index.js";
import {
  invalidSourceImportRequestFailure,
  readSourceFile,
  sourceDialogFailure,
  sourceImportBusyFailure,
  sourceImportContextFailure,
  validateDroppedSourceRequest,
} from "./source-import.js";
import { registerWorkspaceIpcHandlers, WORKSPACE_IPC_CHANNELS } from "./workspace-ipc.js";
import {
  createLearningCatalogFileStore,
  type LearningCatalogFileStore,
} from "./learning-catalog-store.js";
import { createWorkspaceStore, WORKSPACE_ROOT_NAME } from "./workspace-store.js";
import { resolveWorkspaceRoot } from "./workspace-root.js";
import { createAiProviderConfigStore } from "./ai-provider-store.js";
import { registerAiProviderIpcHandlers } from "./ai-provider-ipc.js";
import { createAiProviderClient } from "./ai-provider-client.js";
import { createAiMentorController } from "./ai-mentor-controller.js";
import { createAiProjectStore } from "./ai-project-store.js";
import { registerAiProjectIpcHandlers } from "./ai-project-ipc.js";
import { registerNativeAiWindow } from "./ai-window-native.js";
import type { AiWindowManager } from "./ai-window-manager.js";

const IPC_CHANNELS = Object.freeze({
  appInfo: APP_INFO_IPC_CHANNEL,
  getSystemLocale: "panel:system-locale",
  setInterfaceLocale: "panel:set-interface-locale",
  openSource: "panel:open-source",
  openDroppedSource: "panel:open-dropped-source",
  capabilities: "panel:capabilities",
  compile: "panel:compile",
  run: "panel:run",
  diagnose: "panel:diagnose",
  startTrace: "panel:trace-start",
  readTrace: "panel:trace-read",
  cancelTrace: "panel:trace-cancel",
  readLearningCatalog: "learning-catalog:read",
  saveLearningCatalog: "learning-catalog:save",
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const preloadPath = resolve(currentDirectory, "../../preload/index.cjs");
const aiWindowPreloadPath = resolve(currentDirectory, "../../preload/ai-window.cjs");
const rendererFilePath = join(app.getAppPath(), "dist", "index.html");
const aiWindowRendererFilePath = join(app.getAppPath(), "dist", "ai-window.html");
const developmentIconPath = join(app.getAppPath(), "build", "icon.png");
const developmentServerUrl = parseDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL);
let isShuttingDown = false;
let cleanupComplete = false;
let cleanupPromise: Promise<void> | undefined;
let quitRequested = false;
let closeRequestSequence = 0;
let runnerRequestInFlight = false;
let sourceImportInFlight = false;
const traceSessionOwners = new Map<string, BrowserWindow>();
const activeTraceSessions = new Set<string>();

if (process.platform === "win32") {
  app.setAppUserModelId(APP_APPLICATION_ID);
}

interface WorkspaceCloseState {
  phase: "open" | "requested" | "ready";
  requestId: string | null;
}

const workspaceCloseStates = new WeakMap<BrowserWindow, WorkspaceCloseState>();
const interfaceLocales = new WeakMap<BrowserWindow, InterfaceLocale>();
const mainWindows = new WeakSet<BrowserWindow>();
let aiWindowManager: AiWindowManager | null = null;

type PanelBrowserWindow = BrowserWindow & {
  readonly panelSecurityPreferences: Readonly<WebPreferences>;
};

function interfaceLocaleFor(window: BrowserWindow): InterfaceLocale {
  return (
    interfaceLocales.get(window) ??
    resolveSystemInterfaceLocale(app.getPreferredSystemLanguages()[0], app.getLocale())
  );
}

function parseDevelopmentServerUrl(value: string | undefined): URL | null {
  if (value === undefined) {
    return null;
  }

  const parsed = new URL(value);
  const isLoopbackHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "http:" || !isLoopbackHost) {
    throw new Error("VITE_DEV_SERVER_URL 只能指向本机 HTTP 开发服务器");
  }
  return parsed;
}

function isAllowedRendererUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (developmentServerUrl !== null) {
      return parsed.origin === developmentServerUrl.origin;
    }

    return parsed.protocol === "file:" && fileURLToPath(parsed) === rendererFilePath;
  } catch {
    return false;
  }
}

function requireTrustedSenderWindow(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
  const frame = event.senderFrame;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (
    frame === null ||
    frame.parent !== null ||
    frame.frameTreeNodeId !== event.sender.mainFrame.frameTreeNodeId ||
    !isAllowedRendererUrl(frame.url) ||
    senderWindow === null ||
    senderWindow.isDestroyed() ||
    senderWindow.webContents !== event.sender
  ) {
    throw new Error("拒绝来自非主应用页面的 IPC 请求");
  }
  return senderWindow;
}

function requireTrustedMainWindow(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
  const window = requireTrustedSenderWindow(event);
  if (!mainWindows.has(window)) throw new Error("拒绝来自非工作台窗口的 IPC 请求");
  return window;
}

function isCurrentRequestContext(
  event: IpcMainInvokeEvent,
  expectedWindow: BrowserWindow,
): boolean {
  if (isShuttingDown || expectedWindow.isDestroyed()) {
    return false;
  }
  try {
    return requireTrustedSenderWindow(event) === expectedWindow;
  } catch {
    return false;
  }
}

function installWorkspaceCloseHandshake(mainWindow: BrowserWindow): void {
  const state: WorkspaceCloseState = { phase: "open", requestId: null };
  workspaceCloseStates.set(mainWindow, state);
  mainWindow.on("close", (event) => {
    if (state.phase === "ready" || mainWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    if (state.phase === "requested") return;
    state.phase = "requested";
    state.requestId = String(++closeRequestSequence);
    mainWindow.webContents.send(WORKSPACE_IPC_CHANNELS.closeRequest, state.requestId);
  });
  mainWindow.on("closed", () => {
    workspaceCloseStates.delete(mainWindow);
    for (const [sessionId, owner] of traceSessionOwners) {
      if (owner !== mainWindow) continue;
      try {
        cancelTrace(sessionId);
      } catch {
        // Runner shutdown independently kills any remaining native process.
      }
      traceSessionOwners.delete(sessionId);
      activeTraceSessions.delete(sessionId);
    }
    if (quitRequested && BrowserWindow.getAllWindows().length === 0) beginShutdownCleanup();
  });
  mainWindow.webContents.on("render-process-gone", () => {
    state.phase = "ready";
    state.requestId = null;
  });
}

function registerWorkspaceCloseResponses(): void {
  ipcMain.on(WORKSPACE_IPC_CHANNELS.closeResponse, (event, response: unknown) => {
    let senderWindow: BrowserWindow;
    try {
      senderWindow = requireTrustedSenderWindow(event);
    } catch {
      return;
    }
    const state = workspaceCloseStates.get(senderWindow);
    if (state === undefined || !isWorkspaceCloseResponse(response)) return;
    if (state.phase !== "requested" || response.requestId !== state.requestId) return;
    state.requestId = null;
    if (response.status === "failed") {
      state.phase = "open";
      return;
    }
    state.phase = "ready";
    senderWindow.close();
  });
}

function isWorkspaceCloseResponse(
  value: unknown,
): value is { readonly requestId: string; readonly status: "ready" | "failed" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "requestId" || keys[1] !== "status") return false;
  const response = value as { readonly requestId?: unknown; readonly status?: unknown };
  return (
    typeof response.requestId === "string" &&
    (response.status === "ready" || response.status === "failed")
  );
}

function beginShutdownCleanup(): void {
  if (cleanupComplete || cleanupPromise !== undefined) return;
  isShuttingDown = true;
  cleanupPromise = disposeRunner()
    .catch((error: unknown) => {
      console.error("运行器退出清理失败", error);
    })
    .finally(() => {
      cleanupComplete = true;
      app.quit();
    });
}

function compileRequestFailure(code: RunnerErrorCode, message: string): CompileResult {
  return Object.freeze({
    ok: false as const,
    diagnostics: "",
    error: Object.freeze({
      code,
      message,
    }),
  });
}

function runRequestFailure(code: RunnerErrorCode, message: string): RunResult {
  return Object.freeze({
    ok: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    exitCode: null,
    signal: null,
    termination: "not-started" as const,
    durationMs: 0,
    error: Object.freeze({
      code,
      message,
    }),
  });
}

function diagnoseRequestFailure(code: RunnerErrorCode, message: string): DiagnoseResult {
  return Object.freeze({
    ok: false,
    rawDiagnostics: "",
    error: Object.freeze({ code, message }),
  });
}

function traceStartRequestFailure(code: RunnerErrorCode, message: string): TraceStartResult {
  return Object.freeze({
    ok: false,
    unsupported: null,
    error: Object.freeze({ code, message }),
  });
}

function traceBatchFailure(sessionId: string, code: RunnerErrorCode, message: string): TraceBatch {
  return Object.freeze({
    ok: false,
    sessionId,
    error: Object.freeze({ code, message }),
  });
}

function traceCancelFailure(
  sessionId: string,
  code: RunnerErrorCode,
  message: string,
): TraceCancelResult {
  return Object.freeze({
    ok: false,
    sessionId,
    error: Object.freeze({ code, message }),
  });
}

function acquireMainRunnerRequest(): (() => void) | null {
  if (runnerRequestInFlight || activeTraceSessions.size > 0) {
    return null;
  }
  runnerRequestInFlight = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      runnerRequestInFlight = false;
    }
  };
}

function acquireSourceImport(): (() => void) | null {
  if (sourceImportInFlight) {
    return null;
  }
  sourceImportInFlight = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      sourceImportInFlight = false;
    }
  };
}

type AuthorizationResult =
  | { readonly state: "ready"; readonly grant?: TrustedExecutionGrant }
  | { readonly state: "context-closed" };

async function authorizeTrustedFallback(
  operation: "compile",
  request: CompileRequest,
  event: IpcMainInvokeEvent,
  senderWindow: BrowserWindow,
): Promise<AuthorizationResult>;
async function authorizeTrustedFallback(
  operation: "run",
  request: RunRequest,
  event: IpcMainInvokeEvent,
  senderWindow: BrowserWindow,
): Promise<AuthorizationResult>;
async function authorizeTrustedFallback(
  operation: "diagnose",
  request: DiagnoseRequest,
  event: IpcMainInvokeEvent,
  senderWindow: BrowserWindow,
): Promise<AuthorizationResult>;
async function authorizeTrustedFallback(
  operation: "trace",
  request: TraceRequest,
  event: IpcMainInvokeEvent,
  senderWindow: BrowserWindow,
): Promise<AuthorizationResult>;
async function authorizeTrustedFallback(
  operation: TrustedOperation,
  request: CompileRequest | RunRequest | DiagnoseRequest | TraceRequest,
  event: IpcMainInvokeEvent,
  senderWindow: BrowserWindow,
): Promise<AuthorizationResult> {
  const capabilities = await getCapabilities();
  if (!isCurrentRequestContext(event, senderWindow)) {
    return { state: "context-closed" };
  }
  if (!capabilities.requiresNativeTrustConfirmation) {
    return { state: "ready" };
  }

  let summary: TrustedRequestSummary;
  try {
    summary =
      operation === "compile"
        ? describeTrustedRequest(operation, request as CompileRequest)
        : operation === "run"
          ? describeTrustedRequest(operation, request as RunRequest)
          : operation === "diagnose"
            ? describeTrustedRequest(operation, request as DiagnoseRequest)
            : describeTrustedRequest(operation, request as TraceRequest);
  } catch {
    // The runner returns the precise validation error without opening a dialog.
    return { state: "ready" };
  }

  let response = 0;
  try {
    const english = interfaceLocaleFor(senderWindow) === "en";
    const result = await dialog.showMessageBox(senderWindow, {
      type: "warning",
      title: english ? "Allow This Run Once" : "确认仅执行这一次",
      message:
        operation === "compile"
          ? english
            ? "File and network isolation is unavailable. Compile this trusted code?"
            : "文件与网络隔离不可用。是否编译这份可信代码？"
          : operation === "run"
            ? english
              ? "File and network isolation is unavailable. Run this trusted program?"
              : "文件与网络隔离不可用。是否运行这个可信程序？"
            : operation === "diagnose"
              ? english
                ? "File and network isolation is unavailable. Run this trusted diagnostic once?"
                : "文件与网络隔离不可用。是否执行这一次可信诊断？"
              : english
                ? "File and network isolation is unavailable. Run this temporary shadow Trace once?"
                : "文件与网络隔离不可用。是否执行这一次临时影子 Trace？",
      detail: [
        english
          ? "Trusted execution has no file or network isolation. Resource and process-tree limits do not make untrusted code safe."
          : "可信执行没有文件与网络隔离；资源和进程树限制不能让不可信代码变得安全。",
        "",
        ...summary.detailLines,
        "",
        english
          ? "This authorization is bound to the request summary above and expires after one use."
          : "授权仅绑定上述请求摘要，使用一次后立即失效。",
      ].join("\n"),
      buttons: english ? ["Cancel", "Allow Once"] : ["取消", "仅允许这一次"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    response = result.response;
  } catch {
    response = 0;
  }

  if (!isCurrentRequestContext(event, senderWindow)) {
    return { state: "context-closed" };
  }
  if (response !== 1) {
    return { state: "ready" };
  }

  const grant =
    operation === "compile"
      ? createTrustedExecutionGrant(operation, request as CompileRequest)
      : operation === "run"
        ? createTrustedExecutionGrant(operation, request as RunRequest)
        : operation === "diagnose"
          ? createTrustedExecutionGrant(operation, request as DiagnoseRequest)
          : createTrustedExecutionGrant(operation, request as TraceRequest);
  return { state: "ready", grant };
}

function registerIpcHandlers(learningCatalogStore: LearningCatalogFileStore): void {
  ipcMain.handle(IPC_CHANNELS.appInfo, (event, ...args): AppInfoSnapshot => {
    requireTrustedSenderWindow(event);
    if (args.length !== 0) throw new TypeError("应用信息请求不接受参数");
    return Object.freeze({
      version: app.getVersion(),
      license: APP_LICENSE_ID,
      repositoryUrl: APP_REPOSITORY_URL,
      releasesUrl: APP_RELEASES_URL,
      platform: process.platform,
      architecture: process.arch,
      electronVersion: process.versions.electron,
      packaged: app.isPackaged,
    });
  });

  ipcMain.handle(IPC_CHANNELS.getSystemLocale, (event, ...args) => {
    requireTrustedSenderWindow(event);
    if (args.length !== 0) throw new TypeError("系统语言请求不接受参数");
    return resolveSystemInterfaceLocale(app.getPreferredSystemLanguages()[0], app.getLocale());
  });

  ipcMain.handle(IPC_CHANNELS.setInterfaceLocale, (event, ...args) => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (args.length !== 1 || !isInterfaceLocale(args[0])) {
      throw new TypeError("界面语言请求无效");
    }
    const locale = args[0];
    interfaceLocales.set(senderWindow, locale);
    senderWindow.setTitle(APP_PRODUCT_NAME);
  });

  ipcMain.handle(
    IPC_CHANNELS.readLearningCatalog,
    async (event, ...args): Promise<LearningCatalogReadResult> => {
      requireTrustedSenderWindow(event);
      if (isShuttingDown) {
        return learningCatalogStoreFailure(
          "LEARNING_CATALOG_CONTEXT_CLOSED",
          "应用正在退出，自定义积木目录请求已取消。",
        );
      }
      if (args.length !== 0) {
        return learningCatalogStoreFailure(
          "LEARNING_CATALOG_INVALID_REQUEST",
          "自定义积木目录读取请求格式无效。",
        );
      }
      return learningCatalogStore.read();
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.saveLearningCatalog,
    async (event, ...args): Promise<LearningCatalogSaveResult> => {
      requireTrustedSenderWindow(event);
      if (isShuttingDown) {
        return learningCatalogStoreFailure(
          "LEARNING_CATALOG_CONTEXT_CLOSED",
          "应用正在退出，自定义积木目录请求已取消。",
        );
      }
      if (args.length !== 1) {
        return learningCatalogStoreFailure(
          "LEARNING_CATALOG_INVALID_REQUEST",
          "自定义积木目录保存请求格式无效。",
        );
      }
      return learningCatalogStore.save(args[0]);
    },
  );

  ipcMain.handle(IPC_CHANNELS.openSource, async (event, ...args): Promise<SourceImportResult> => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (args.length !== 0) {
      return invalidSourceImportRequestFailure();
    }
    if (isShuttingDown) {
      return sourceImportContextFailure();
    }
    const releaseImport = acquireSourceImport();
    if (releaseImport === null) {
      return sourceImportBusyFailure();
    }

    try {
      let result: Awaited<ReturnType<typeof dialog.showOpenDialog>>;
      try {
        const english = interfaceLocaleFor(senderWindow) === "en";
        result = await dialog.showOpenDialog(senderWindow, {
          title: english ? "Import C Source File" : "导入 C 源文件",
          properties: ["openFile"],
          filters: [{ name: english ? "C Source Files" : "C 源文件", extensions: ["c"] }],
        });
      } catch {
        return sourceDialogFailure();
      }
      if (!isCurrentRequestContext(event, senderWindow)) {
        return sourceImportContextFailure();
      }
      if (result.canceled) {
        return Object.freeze({ status: "cancelled" });
      }
      if (result.filePaths.length !== 1) {
        return sourceDialogFailure();
      }
      const request = validateDroppedSourceRequest({ path: result.filePaths[0] });
      if (!request.ok) {
        return sourceDialogFailure();
      }
      const imported = await readSourceFile(request.path, "dialog");
      return isCurrentRequestContext(event, senderWindow) ? imported : sourceImportContextFailure();
    } finally {
      releaseImport();
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.openDroppedSource,
    async (event, request: unknown): Promise<SourceImportResult> => {
      const senderWindow = requireTrustedSenderWindow(event);
      if (isShuttingDown) {
        return sourceImportContextFailure();
      }
      const validated = validateDroppedSourceRequest(request);
      if (!validated.ok) {
        return validated.result;
      }
      const releaseImport = acquireSourceImport();
      if (releaseImport === null) {
        return sourceImportBusyFailure();
      }
      try {
        const imported = await readSourceFile(validated.path, "drop");
        return isCurrentRequestContext(event, senderWindow)
          ? imported
          : sourceImportContextFailure();
      } finally {
        releaseImport();
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.capabilities, async (event) => {
    requireTrustedSenderWindow(event);
    if (isShuttingDown) {
      throw new Error("应用正在退出，运行器能力不可用");
    }
    return getCapabilities();
  });

  ipcMain.handle(IPC_CHANNELS.compile, async (event, request: CompileRequest) => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (isShuttingDown) {
      return compileRequestFailure("RUNNER_SHUTTING_DOWN", "应用正在退出，拒绝新的编译任务。");
    }
    const releaseRequest = acquireMainRunnerRequest();
    if (releaseRequest === null) {
      return compileRequestFailure("RUNNER_BUSY", "运行器正忙；不会打开第二个可信确认框。");
    }
    try {
      const authorization = await authorizeTrustedFallback("compile", request, event, senderWindow);
      if (authorization.state === "context-closed") {
        return compileRequestFailure("RUNNER_SHUTTING_DOWN", "请求窗口已失效，编译已取消。");
      }
      return compile(request, authorization.grant);
    } finally {
      releaseRequest();
    }
  });

  ipcMain.handle(IPC_CHANNELS.run, async (event, request: RunRequest) => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (isShuttingDown) {
      return runRequestFailure("RUNNER_SHUTTING_DOWN", "应用正在退出，拒绝新的运行任务。");
    }
    const releaseRequest = acquireMainRunnerRequest();
    if (releaseRequest === null) {
      return runRequestFailure("RUNNER_BUSY", "运行器正忙；不会打开第二个可信确认框。");
    }
    try {
      const authorization = await authorizeTrustedFallback("run", request, event, senderWindow);
      if (authorization.state === "context-closed") {
        return runRequestFailure("RUNNER_SHUTTING_DOWN", "请求窗口已失效，运行已取消。");
      }
      return run(request, authorization.grant);
    } finally {
      releaseRequest();
    }
  });

  ipcMain.handle(IPC_CHANNELS.diagnose, async (event, request: DiagnoseRequest) => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (isShuttingDown) {
      return diagnoseRequestFailure("RUNNER_SHUTTING_DOWN", "应用正在退出，拒绝新的诊断任务。");
    }
    const releaseRequest = acquireMainRunnerRequest();
    if (releaseRequest === null) {
      return diagnoseRequestFailure("RUNNER_BUSY", "运行器正忙；不会打开第二个可信确认框。");
    }
    try {
      const authorization = await authorizeTrustedFallback(
        "diagnose",
        request,
        event,
        senderWindow,
      );
      if (authorization.state === "context-closed") {
        return diagnoseRequestFailure("RUNNER_SHUTTING_DOWN", "请求窗口已失效，诊断已取消。");
      }
      return diagnose(request, authorization.grant);
    } finally {
      releaseRequest();
    }
  });

  ipcMain.handle(IPC_CHANNELS.startTrace, async (event, request: TraceRequest) => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (isShuttingDown) {
      return traceStartRequestFailure(
        "RUNNER_SHUTTING_DOWN",
        "应用正在退出，拒绝新的 Trace 任务。",
      );
    }
    const releaseRequest = acquireMainRunnerRequest();
    if (releaseRequest === null) {
      return traceStartRequestFailure("RUNNER_BUSY", "运行器正忙；不会启动第二个 Trace。 ");
    }
    try {
      const authorization = await authorizeTrustedFallback("trace", request, event, senderWindow);
      if (authorization.state === "context-closed") {
        return traceStartRequestFailure("RUNNER_SHUTTING_DOWN", "请求窗口已失效，Trace 已取消。");
      }
      const result = await startTrace(request, authorization.grant);
      if (!result.ok) return result;
      if (!isCurrentRequestContext(event, senderWindow)) {
        cancelTrace(result.sessionId);
        return traceStartRequestFailure("RUNNER_SHUTTING_DOWN", "请求窗口已失效，Trace 已取消。");
      }
      traceSessionOwners.set(result.sessionId, senderWindow);
      activeTraceSessions.add(result.sessionId);
      return result;
    } finally {
      releaseRequest();
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.readTrace,
    (event, sessionId: unknown, afterSequence: unknown): TraceBatch => {
      const senderWindow = requireTrustedSenderWindow(event);
      if (typeof sessionId !== "string" || typeof afterSequence !== "number") {
        return traceBatchFailure(
          typeof sessionId === "string" ? sessionId : "",
          "INVALID_REQUEST",
          "Trace read 参数无效。",
        );
      }
      if (traceSessionOwners.get(sessionId) !== senderWindow) {
        return traceBatchFailure(
          sessionId,
          "TRACE_SESSION_NOT_FOUND",
          "找不到属于当前窗口的 Trace session。",
        );
      }
      const batch = readTrace(sessionId, afterSequence);
      if (batch.ok && isTerminalTraceStatus(batch.status)) activeTraceSessions.delete(sessionId);
      return batch;
    },
  );

  ipcMain.handle(IPC_CHANNELS.cancelTrace, (event, sessionId: unknown): TraceCancelResult => {
    const senderWindow = requireTrustedSenderWindow(event);
    if (typeof sessionId !== "string" || traceSessionOwners.get(sessionId) !== senderWindow) {
      return traceCancelFailure(
        typeof sessionId === "string" ? sessionId : "",
        "TRACE_SESSION_NOT_FOUND",
        "找不到属于当前窗口的 Trace session。",
      );
    }
    const result = cancelTrace(sessionId);
    activeTraceSessions.delete(sessionId);
    traceSessionOwners.delete(sessionId);
    return result;
  });
}

function createMainWindow(): BrowserWindow {
  const initialLocale = resolveSystemInterfaceLocale(
    app.getPreferredSystemLanguages()[0],
    app.getLocale(),
  );
  const webPreferences = Object.freeze({
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
  }) satisfies Readonly<WebPreferences>;

  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    show: true,
    backgroundColor: "#ffffff",
    title: APP_PRODUCT_NAME,
    webPreferences,
  }) as PanelBrowserWindow;
  mainWindows.add(mainWindow);
  interfaceLocales.set(mainWindow, initialLocale);

  Object.defineProperty(mainWindow, "panelSecurityPreferences", {
    configurable: false,
    enumerable: false,
    value: webPreferences,
    writable: false,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => {
    if (!isAllowedRendererUrl(event.url)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  installWorkspaceCloseHandshake(mainWindow);

  if (developmentServerUrl === null) {
    void mainWindow.loadFile(rendererFilePath);
  } else {
    void mainWindow.loadURL(developmentServerUrl.href);
  }

  return mainWindow;
}

void app.whenReady().then(() => {
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(developmentIconPath);
  }
  const workspaceRoot = resolveWorkspaceRoot({
    isPackaged: app.isPackaged,
    defaultRoot: join(app.getPath("documents"), WORKSPACE_ROOT_NAME),
    requestedRoot: process.env.PANEL_WORKSPACE_ROOT,
    installedGate: process.env.PANEL_INSTALLED_PACKAGE_GATE ?? process.env.PANEL_INSTALLED_DMG_GATE,
    temporaryDirectory: tmpdir(),
  });
  registerIpcHandlers(createLearningCatalogFileStore(workspaceRoot));
  const aiProviderClient = createAiProviderClient();
  registerAiProviderIpcHandlers({
    ipcMain,
    store: createAiProviderConfigStore({
      rootPath: app.getPath("userData"),
      safeStorage,
    }),
    client: aiProviderClient,
    mentor: createAiMentorController(aiProviderClient),
    authorize: (event) => requireTrustedMainWindow(event),
    isShuttingDown: () => isShuttingDown,
  });
  registerAiProjectIpcHandlers({
    ipcMain,
    store: createAiProjectStore(workspaceRoot),
    authorize: (event) => void requireTrustedMainWindow(event),
    isShuttingDown: () => isShuttingDown,
  });
  registerWorkspaceIpcHandlers({
    ipcMain,
    store: createWorkspaceStore(workspaceRoot),
    authorize: (event) => void requireTrustedMainWindow(event),
    isShuttingDown: () => isShuttingDown,
  });
  registerWorkspaceCloseResponses();
  aiWindowManager = registerNativeAiWindow({
    ipcMain,
    preloadPath: aiWindowPreloadPath,
    rendererFilePath: aiWindowRendererFilePath,
    developmentServerUrl,
    authorizeHost: (event) => requireTrustedMainWindow(event),
    isShuttingDown: () => isShuttingDown,
  });
  createMainWindow();
});

app.on("activate", () => {
  if (!quitRequested && !isShuttingDown && BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  quitRequested = true;
  aiWindowManager?.closeAll();
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    beginShutdownCleanup();
    return;
  }
  for (const window of windows) window.close();
});

app.on("window-all-closed", () => {
  if (quitRequested) {
    beginShutdownCleanup();
    return;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
