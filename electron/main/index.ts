import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebPreferences,
} from "electron";
import type {
  CompileRequest,
  CompileResult,
  RunRequest,
  RunnerErrorCode,
  RunResult,
  SourceImportResult,
} from "../../src/shared/api.js";
import {
  compile,
  createTrustedExecutionGrant,
  describeTrustedRequest,
  disposeRunner,
  getCapabilities,
  run,
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
import { registerWorkspaceIpcHandlers } from "./workspace-ipc.js";
import { createWorkspaceStore, WORKSPACE_ROOT_NAME } from "./workspace-store.js";

const IPC_CHANNELS = Object.freeze({
  openSource: "panel:open-source",
  openDroppedSource: "panel:open-dropped-source",
  capabilities: "panel:capabilities",
  compile: "panel:compile",
  run: "panel:run",
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const preloadPath = resolve(currentDirectory, "../../preload/index.cjs");
const rendererFilePath = join(app.getAppPath(), "dist", "index.html");
const developmentIconPath = join(app.getAppPath(), "build", "icon.png");
const developmentServerUrl = parseDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL);
let isShuttingDown = false;
let cleanupComplete = false;
let cleanupPromise: Promise<void> | undefined;
let runnerRequestInFlight = false;
let sourceImportInFlight = false;

type PanelBrowserWindow = BrowserWindow & {
  readonly panelSecurityPreferences: Readonly<WebPreferences>;
};

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

function requireTrustedSenderWindow(event: IpcMainInvokeEvent): BrowserWindow {
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

function acquireMainRunnerRequest(): (() => void) | null {
  if (runnerRequestInFlight) {
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
  operation: TrustedOperation,
  request: CompileRequest | RunRequest,
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
        : describeTrustedRequest(operation, request as RunRequest);
  } catch {
    // The runner returns the precise validation error without opening a dialog.
    return { state: "ready" };
  }

  let response = 0;
  try {
    const result = await dialog.showMessageBox(senderWindow, {
      type: "warning",
      title: "确认仅执行这一次",
      message:
        operation === "compile"
          ? "嵌套沙箱不可用。是否编译这份可信代码？"
          : "嵌套沙箱不可用。是否运行这个可信程序？",
      detail: [
        "trusted-only 没有 Seatbelt 文件与网络隔离，只能用于你确认可信的代码。",
        "",
        ...summary.detailLines,
        "",
        "授权仅绑定上述请求摘要，使用一次后立即失效。",
      ].join("\n"),
      buttons: ["取消", "仅允许这一次"],
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
      : createTrustedExecutionGrant(operation, request as RunRequest);
  return { state: "ready", grant };
}

function registerIpcHandlers(): void {
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
        result = await dialog.showOpenDialog(senderWindow, {
          title: "导入 C 源文件",
          properties: ["openFile"],
          filters: [{ name: "C 源文件", extensions: ["c"] }],
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
}

function createMainWindow(): BrowserWindow {
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
    backgroundColor: "#0d0f11",
    title: "C 积木算法面板",
    webPreferences,
  }) as PanelBrowserWindow;

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
  registerIpcHandlers();
  registerWorkspaceIpcHandlers({
    ipcMain,
    store: createWorkspaceStore(
      !app.isPackaged && process.env.PANEL_WORKSPACE_ROOT !== undefined
        ? process.env.PANEL_WORKSPACE_ROOT
        : join(app.getPath("documents"), WORKSPACE_ROOT_NAME),
    ),
    authorize: (event) => void requireTrustedSenderWindow(event),
    isShuttingDown: () => isShuttingDown,
  });
  createMainWindow();
});

app.on("activate", () => {
  if (!isShuttingDown && BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", (event) => {
  if (cleanupComplete) {
    return;
  }
  event.preventDefault();
  isShuttingDown = true;
  cleanupPromise ??= disposeRunner()
    .catch((error: unknown) => {
      console.error("运行器退出清理失败", error);
    })
    .finally(() => {
      cleanupComplete = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
