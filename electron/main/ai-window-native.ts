import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebPreferences,
} from "electron";
import {
  registerAiWindowManager,
  type AiWindowManager,
  type AiWindowNativeWindow,
} from "./ai-window-manager.js";

export interface NativeAiWindowOptions {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly preloadPath: string;
  readonly rendererFilePath: string;
  readonly developmentServerUrl: URL | null;
  readonly authorizeHost: (event: IpcMainInvokeEvent) => BrowserWindow;
  readonly isShuttingDown: () => boolean;
}

export function registerNativeAiWindow(options: NativeAiWindowOptions): AiWindowManager {
  let rememberedBounds: Rectangle | null = null;
  const suppressE2eWindowFocus =
    options.developmentServerUrl !== null && process.env.PANEL_E2E_HIDE_WINDOW === "1";

  return registerAiWindowManager({
    ipcMain: options.ipcMain,
    authorizeHost: (event) => options.authorizeHost(event) as AiWindowNativeWindow,
    resolveSender: (event) =>
      BrowserWindow.fromWebContents(event.sender) as AiWindowNativeWindow | null,
    isShuttingDown: options.isShuttingDown,
    createChildWindow() {
      const webPreferences = Object.freeze({
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
      }) satisfies Readonly<WebPreferences>;
      const child = new BrowserWindow({
        width: rememberedBounds?.width ?? 860,
        height: rememberedBounds?.height ?? 680,
        ...(rememberedBounds === null ? {} : { x: rememberedBounds.x, y: rememberedBounds.y }),
        minWidth: 680,
        minHeight: 480,
        show: false,
        focusable: !suppressE2eWindowFocus,
        resizable: true,
        minimizable: true,
        maximizable: true,
        fullscreenable: true,
        alwaysOnTop: false,
        autoHideMenuBar: true,
        backgroundColor: "#ffffff",
        title: "AI",
        webPreferences,
      });
      Object.defineProperty(child, "panelWindowRole", {
        configurable: false,
        enumerable: false,
        value: "ai-assistant",
        writable: false,
      });
      Object.defineProperty(child, "panelSecurityPreferences", {
        configurable: false,
        enumerable: false,
        value: webPreferences,
        writable: false,
      });
      child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      child.webContents.on("will-navigate", (event) => {
        if (!isAllowedAiWindowUrl(event.url, options)) event.preventDefault();
      });
      child.webContents.session.setPermissionCheckHandler(() => false);
      child.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      child.on("close", () => {
        if (!child.isDestroyed()) rememberedBounds = child.getNormalBounds();
      });
      if (options.developmentServerUrl === null) {
        void child.loadFile(options.rendererFilePath);
      } else {
        void child.loadURL(new URL("ai-window.html", options.developmentServerUrl).href);
      }
      return child as unknown as AiWindowNativeWindow;
    },
  });
}

function isAllowedAiWindowUrl(candidate: string, options: NativeAiWindowOptions): boolean {
  try {
    const parsed = new URL(candidate);
    if (options.developmentServerUrl !== null) {
      const expected = new URL("ai-window.html", options.developmentServerUrl);
      return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
    }
    return parsed.protocol === "file:" && fileURLToPath(parsed) === options.rendererFilePath;
  } catch {
    return false;
  }
}
