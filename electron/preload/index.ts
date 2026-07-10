import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  Capabilities,
  CompileRequest,
  CompileResult,
  PanelApi,
  RunRequest,
  RunResult,
  SourceImportResult,
} from "../../src/shared/api.js";
import type {
  CreateWorkspaceDocumentRequest,
  OpenWorkspaceDocumentRequest,
  SaveWorkspaceDocumentRequest,
  WorkspaceDocumentResult,
  WorkspaceListResult,
  WorkspaceSaveResult,
} from "../../src/shared/workspace.js";

const IPC_CHANNELS = Object.freeze({
  openSource: "panel:open-source",
  openDroppedSource: "panel:open-dropped-source",
  listWorkspaceDocuments: "workspace:list",
  createWorkspaceDocument: "workspace:create",
  openWorkspaceDocument: "workspace:open",
  saveWorkspaceDocument: "workspace:save-source",
  capabilities: "panel:capabilities",
  compile: "panel:compile",
  run: "panel:run",
});

function copyCapabilitiesSnapshot(value: Capabilities): Capabilities {
  return {
    mode: value.mode,
    runnerEnabled: value.runnerEnabled,
    seatbeltProbe: { ...value.seatbeltProbe },
    requiresNativeTrustConfirmation: value.requiresNativeTrustConfirmation,
  };
}

const panelApi: PanelApi = Object.freeze({
  openSource: async (): Promise<SourceImportResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.openSource)) as SourceImportResult,
  openDroppedSource: async (file: File): Promise<SourceImportResult> => {
    let path = "";
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      // Synthetic File objects have no local disk path and are rejected below.
    }
    if (path.length === 0) {
      return {
        status: "failed",
        error: {
          code: "SOURCE_INVALID_DROP",
          message: "拖入的项目不是可读取的本地 C 文件。",
        },
      };
    }
    return (await ipcRenderer.invoke(IPC_CHANNELS.openDroppedSource, {
      path,
    })) as SourceImportResult;
  },
  listWorkspaceDocuments: async (): Promise<WorkspaceListResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.listWorkspaceDocuments)) as WorkspaceListResult,
  createWorkspaceDocument: async (
    request: CreateWorkspaceDocumentRequest,
  ): Promise<WorkspaceDocumentResult> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.createWorkspaceDocument,
      request,
    )) as WorkspaceDocumentResult,
  openWorkspaceDocument: async (
    request: OpenWorkspaceDocumentRequest,
  ): Promise<WorkspaceDocumentResult> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.openWorkspaceDocument,
      request,
    )) as WorkspaceDocumentResult,
  saveWorkspaceDocument: async (
    request: SaveWorkspaceDocumentRequest,
  ): Promise<WorkspaceSaveResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.saveWorkspaceDocument, request)) as WorkspaceSaveResult,
  capabilities: async (): Promise<Capabilities> =>
    copyCapabilitiesSnapshot((await ipcRenderer.invoke(IPC_CHANNELS.capabilities)) as Capabilities),
  compile: async (request: CompileRequest): Promise<CompileResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.compile, request)) as CompileResult,
  run: async (request: RunRequest): Promise<RunResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.run, request)) as RunResult,
});

contextBridge.exposeInMainWorld("panelApi", panelApi);
