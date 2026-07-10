import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  WorkspaceDocumentResult,
  WorkspaceListResult,
  WorkspaceSaveResult,
} from "../../src/shared/workspace.js";
import { workspaceFailure } from "../../src/shared/workspace.js";
import type { WorkspaceStore } from "./workspace-store.js";

export const WORKSPACE_IPC_CHANNELS = Object.freeze({
  list: "workspace:list",
  create: "workspace:create",
  open: "workspace:open",
  saveSource: "workspace:save-source",
});

export interface WorkspaceIpcOptions {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly store: WorkspaceStore;
  readonly authorize: (event: IpcMainInvokeEvent) => void;
  readonly isShuttingDown: () => boolean;
}

export function registerWorkspaceIpcHandlers(options: WorkspaceIpcOptions): void {
  options.ipcMain.handle(
    WORKSPACE_IPC_CHANNELS.list,
    async (event, ...args): Promise<WorkspaceListResult> => {
      options.authorize(event);
      if (options.isShuttingDown()) return contextClosed();
      if (args.length !== 0) return invalidRequest();
      return options.store.list();
    },
  );
  options.ipcMain.handle(
    WORKSPACE_IPC_CHANNELS.create,
    async (event, ...args): Promise<WorkspaceDocumentResult> => {
      options.authorize(event);
      if (options.isShuttingDown()) return contextClosed();
      if (args.length !== 1) return invalidRequest();
      return options.store.create(args[0]);
    },
  );
  options.ipcMain.handle(
    WORKSPACE_IPC_CHANNELS.open,
    async (event, ...args): Promise<WorkspaceDocumentResult> => {
      options.authorize(event);
      if (options.isShuttingDown()) return contextClosed();
      if (args.length !== 1) return invalidRequest();
      return options.store.open(args[0]);
    },
  );
  options.ipcMain.handle(
    WORKSPACE_IPC_CHANNELS.saveSource,
    async (event, ...args): Promise<WorkspaceSaveResult> => {
      options.authorize(event);
      if (options.isShuttingDown()) return contextClosed();
      if (args.length !== 1) return invalidRequest();
      return options.store.save(args[0]);
    },
  );
}

function contextClosed(): ReturnType<typeof workspaceFailure> {
  return workspaceFailure("WORKSPACE_CONTEXT_CLOSED", "应用正在退出，工作区请求已取消。");
}

function invalidRequest(): ReturnType<typeof workspaceFailure> {
  return workspaceFailure("WORKSPACE_INVALID_REQUEST", "工作区请求格式无效。");
}
