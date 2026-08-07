import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  Capabilities,
  CompileRequest,
  CompileResult,
  DiagnoseRequest,
  DiagnoseResult,
  PanelApi,
  RunRequest,
  RunResult,
  SourceImportResult,
} from "../../src/shared/api.js";
import {
  APP_INFO_IPC_CHANNEL,
  parseAppInfoSnapshot,
  type AppInfoSnapshot,
} from "../../src/shared/app-info.js";
import { isInterfaceLocale, type InterfaceLocale } from "../../src/shared/interface-locale.js";
import type {
  TraceBatch,
  TraceCancelResult,
  TraceRequest,
  TraceStartResult,
} from "../../src/shared/trace.js";
import type {
  VerifiedRunBatch,
  VerifiedRunCancelResult,
  VerifiedRunStartResult,
} from "../../src/shared/verified-run.js";
import type {
  CreateWorkspaceDocumentRequest,
  OpenWorkspaceDocumentRequest,
  SaveWorkspaceDocumentRequest,
  WorkspaceDocumentResult,
  WorkspaceListResult,
  WorkspaceSaveResult,
} from "../../src/shared/workspace.js";
import type {
  ReadWorkspaceSidecarRequest,
  SaveWorkspaceSidecarRequest,
  WorkspaceSidecarReadResult,
  WorkspaceSidecarSaveResult,
} from "../../src/shared/workspace-sidecar.js";
import type {
  LearningCatalogReadResult,
  LearningCatalogSaveResult,
  SaveLearningCatalogRequest,
} from "../../src/shared/learning-catalog-store.js";
import {
  AI_PROVIDER_IPC_CHANNELS,
  type AiMentorCancelResult,
  type AiMentorReadResult,
  type AiMentorStartResult,
  type AiProviderConnectResult,
  type AiProviderDisconnectResult,
  type AiProviderModelsResult,
  type AiProviderModelSelectResult,
  type AiProviderReadResult,
  type CancelAiMentorRequest,
  type ConnectAiProviderRequest,
  type DisconnectAiProviderRequest,
  type ListAiProviderModelsRequest,
  type ReadAiMentorRequest,
  type SelectAiProviderModelRequest,
  type StartAiMentorRequest,
} from "../../src/shared/ai-provider.js";
import {
  AI_PROJECT_IPC_CHANNELS,
  type AiConversationCreateResult,
  type AiConversationDeleteResult,
  type AiConversationMessageAppendResult,
  type AiConversationReadResult,
  type AiConversationUpdateResult,
  type AiProjectOpenResult,
  type AppendAiConversationMessageRequest,
  type CreateAiConversationRequest,
  type DeleteAiConversationRequest,
  type OpenAiProjectRequest,
  type ReadAiConversationRequest,
  type RenameAiConversationRequest,
  type SetAiConversationArchivedRequest,
} from "../../src/shared/ai-project.js";
import {
  AI_WINDOW_IPC_CHANNELS,
  validateAiWindowIntent,
  validateAiWindowStateEnvelope,
  type AiWindowCommandResult,
  type AiWindowIntent,
  type AiWindowStateEnvelope,
} from "../../src/shared/ai-window.js";

const IPC_CHANNELS = Object.freeze({
  appInfo: APP_INFO_IPC_CHANNEL,
  getSystemLocale: "panel:system-locale",
  setInterfaceLocale: "panel:set-interface-locale",
  openSource: "panel:open-source",
  openDroppedSource: "panel:open-dropped-source",
  listWorkspaceDocuments: "workspace:list",
  createWorkspaceDocument: "workspace:create",
  openWorkspaceDocument: "workspace:open",
  saveWorkspaceDocument: "workspace:save-source",
  readWorkspaceSidecar: "workspace:read-sidecar",
  saveWorkspaceSidecar: "workspace:save-sidecar",
  workspaceCloseRequest: "workspace:close-request",
  workspaceCloseResponse: "workspace:close-response",
  capabilities: "panel:capabilities",
  compile: "panel:compile",
  run: "panel:run",
  startRun: "panel:run-start",
  readRun: "panel:run-read",
  cancelRun: "panel:run-cancel",
  diagnose: "panel:diagnose",
  startTrace: "panel:trace-start",
  readTrace: "panel:trace-read",
  cancelTrace: "panel:trace-cancel",
  readLearningCatalog: "learning-catalog:read",
  saveLearningCatalog: "learning-catalog:save",
});

let workspaceCloseHandler: (() => Promise<void>) | null = null;

ipcRenderer.on(IPC_CHANNELS.workspaceCloseRequest, (_event, requestId: unknown) => {
  if (typeof requestId !== "string") return;
  const handler = workspaceCloseHandler;
  if (handler === null) {
    ipcRenderer.send(IPC_CHANNELS.workspaceCloseResponse, { requestId, status: "ready" });
    return;
  }
  void Promise.resolve()
    .then(handler)
    .then(
      () => ipcRenderer.send(IPC_CHANNELS.workspaceCloseResponse, { requestId, status: "ready" }),
      () => ipcRenderer.send(IPC_CHANNELS.workspaceCloseResponse, { requestId, status: "failed" }),
    );
});

function copyCapabilitiesSnapshot(value: Capabilities): Capabilities {
  return {
    mode: value.mode,
    runnerEnabled: value.runnerEnabled,
    toolchainId: value.toolchainId,
    isolationProbe: { ...value.isolationProbe },
    memoryDiagnostics: { ...value.memoryDiagnostics },
    requiresNativeTrustConfirmation: value.requiresNativeTrustConfirmation,
  };
}

const panelApi: PanelApi = Object.freeze({
  getAppInfo: async (): Promise<AppInfoSnapshot> => {
    const parsed = parseAppInfoSnapshot(await ipcRenderer.invoke(IPC_CHANNELS.appInfo));
    if (parsed === null) throw new TypeError("应用信息响应无效");
    return parsed;
  },
  openAiWindow: async (): Promise<AiWindowCommandResult> =>
    (await ipcRenderer.invoke(AI_WINDOW_IPC_CHANNELS.open)) as AiWindowCommandResult,
  toggleAiWindow: async (): Promise<AiWindowCommandResult> =>
    (await ipcRenderer.invoke(AI_WINDOW_IPC_CHANNELS.toggle)) as AiWindowCommandResult,
  publishAiWindowState: async (value: AiWindowStateEnvelope): Promise<AiWindowCommandResult> => {
    const state = validateAiWindowStateEnvelope(value);
    if (state === null) return Object.freeze({ status: "failed", code: "INVALID_PAYLOAD" });
    return (await ipcRenderer.invoke(
      AI_WINDOW_IPC_CHANNELS.publishState,
      state,
    )) as AiWindowCommandResult;
  },
  onAiWindowIntent: (handler: (intent: AiWindowIntent) => void): (() => void) => {
    if (typeof handler !== "function") throw new TypeError("AI window intent handler is invalid");
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const intent = validateAiWindowIntent(value);
      if (intent !== null) handler(intent);
    };
    ipcRenderer.on(AI_WINDOW_IPC_CHANNELS.intent, listener);
    return () => ipcRenderer.removeListener(AI_WINDOW_IPC_CHANNELS.intent, listener);
  },
  onAiWindowClosed: (handler: () => void): (() => void) => {
    if (typeof handler !== "function") throw new TypeError("AI window close handler is invalid");
    const listener = (): void => handler();
    ipcRenderer.on(AI_WINDOW_IPC_CHANNELS.closed, listener);
    return () => ipcRenderer.removeListener(AI_WINDOW_IPC_CHANNELS.closed, listener);
  },
  getSystemLocale: async (): Promise<InterfaceLocale> => {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.getSystemLocale);
    return isInterfaceLocale(result) ? result : "en";
  },
  setInterfaceLocale: async (locale: InterfaceLocale): Promise<void> => {
    if (!isInterfaceLocale(locale)) throw new TypeError("界面语言无效");
    await ipcRenderer.invoke(IPC_CHANNELS.setInterfaceLocale, locale);
  },
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
  readWorkspaceSidecar: async (
    request: ReadWorkspaceSidecarRequest,
  ): Promise<WorkspaceSidecarReadResult> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.readWorkspaceSidecar,
      request,
    )) as WorkspaceSidecarReadResult,
  saveWorkspaceSidecar: async (
    request: SaveWorkspaceSidecarRequest,
  ): Promise<WorkspaceSidecarSaveResult> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.saveWorkspaceSidecar,
      request,
    )) as WorkspaceSidecarSaveResult,
  readLearningCatalog: async (): Promise<LearningCatalogReadResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.readLearningCatalog)) as LearningCatalogReadResult,
  saveLearningCatalog: async (
    request: SaveLearningCatalogRequest,
  ): Promise<LearningCatalogSaveResult> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.saveLearningCatalog,
      request,
    )) as LearningCatalogSaveResult,
  getAiProviderConfig: async (): Promise<AiProviderReadResult> =>
    (await ipcRenderer.invoke(AI_PROVIDER_IPC_CHANNELS.getConfig)) as AiProviderReadResult,
  openAiProject: async (request: OpenAiProjectRequest): Promise<AiProjectOpenResult> =>
    (await ipcRenderer.invoke(AI_PROJECT_IPC_CHANNELS.open, request)) as AiProjectOpenResult,
  createAiConversation: async (
    request: CreateAiConversationRequest,
  ): Promise<AiConversationCreateResult> =>
    (await ipcRenderer.invoke(
      AI_PROJECT_IPC_CHANNELS.createConversation,
      request,
    )) as AiConversationCreateResult,
  readAiConversation: async (
    request: ReadAiConversationRequest,
  ): Promise<AiConversationReadResult> =>
    (await ipcRenderer.invoke(
      AI_PROJECT_IPC_CHANNELS.readConversation,
      request,
    )) as AiConversationReadResult,
  renameAiConversation: async (
    request: RenameAiConversationRequest,
  ): Promise<AiConversationUpdateResult> =>
    (await ipcRenderer.invoke(
      AI_PROJECT_IPC_CHANNELS.renameConversation,
      request,
    )) as AiConversationUpdateResult,
  setAiConversationArchived: async (
    request: SetAiConversationArchivedRequest,
  ): Promise<AiConversationUpdateResult> =>
    (await ipcRenderer.invoke(
      AI_PROJECT_IPC_CHANNELS.setConversationArchived,
      request,
    )) as AiConversationUpdateResult,
  deleteAiConversation: async (
    request: DeleteAiConversationRequest,
  ): Promise<AiConversationDeleteResult> =>
    (await ipcRenderer.invoke(
      AI_PROJECT_IPC_CHANNELS.deleteConversation,
      request,
    )) as AiConversationDeleteResult,
  appendAiConversationMessage: async (
    request: AppendAiConversationMessageRequest,
  ): Promise<AiConversationMessageAppendResult> =>
    (await ipcRenderer.invoke(
      AI_PROJECT_IPC_CHANNELS.appendMessage,
      request,
    )) as AiConversationMessageAppendResult,
  connectAiProvider: async (request: ConnectAiProviderRequest): Promise<AiProviderConnectResult> =>
    (await ipcRenderer.invoke(
      AI_PROVIDER_IPC_CHANNELS.connect,
      request,
    )) as AiProviderConnectResult,
  listAiProviderModels: async (
    request: ListAiProviderModelsRequest,
  ): Promise<AiProviderModelsResult> =>
    (await ipcRenderer.invoke(
      AI_PROVIDER_IPC_CHANNELS.listModels,
      request,
    )) as AiProviderModelsResult,
  selectAiProviderModel: async (
    request: SelectAiProviderModelRequest,
  ): Promise<AiProviderModelSelectResult> =>
    (await ipcRenderer.invoke(
      AI_PROVIDER_IPC_CHANNELS.selectModel,
      request,
    )) as AiProviderModelSelectResult,
  disconnectAiProvider: async (
    request: DisconnectAiProviderRequest,
  ): Promise<AiProviderDisconnectResult> =>
    (await ipcRenderer.invoke(
      AI_PROVIDER_IPC_CHANNELS.disconnect,
      request,
    )) as AiProviderDisconnectResult,
  startAiMentor: async (request: StartAiMentorRequest): Promise<AiMentorStartResult> =>
    (await ipcRenderer.invoke(
      AI_PROVIDER_IPC_CHANNELS.startMentor,
      request,
    )) as AiMentorStartResult,
  readAiMentor: async (request: ReadAiMentorRequest): Promise<AiMentorReadResult> =>
    (await ipcRenderer.invoke(AI_PROVIDER_IPC_CHANNELS.readMentor, request)) as AiMentorReadResult,
  cancelAiMentor: async (request: CancelAiMentorRequest): Promise<AiMentorCancelResult> =>
    (await ipcRenderer.invoke(
      AI_PROVIDER_IPC_CHANNELS.cancelMentor,
      request,
    )) as AiMentorCancelResult,
  onWorkspaceCloseRequested: (handler: () => Promise<void>): (() => void) => {
    if (typeof handler !== "function") throw new TypeError("关闭前保存处理器必须是函数");
    workspaceCloseHandler = handler;
    return () => {
      if (workspaceCloseHandler === handler) workspaceCloseHandler = null;
    };
  },
  capabilities: async (): Promise<Capabilities> =>
    copyCapabilitiesSnapshot((await ipcRenderer.invoke(IPC_CHANNELS.capabilities)) as Capabilities),
  compile: async (request: CompileRequest): Promise<CompileResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.compile, request)) as CompileResult,
  run: async (request: RunRequest): Promise<RunResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.run, request)) as RunResult,
  startRun: async (request: RunRequest): Promise<VerifiedRunStartResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.startRun, request)) as VerifiedRunStartResult,
  readRun: async (sessionId: string, afterSequence: number): Promise<VerifiedRunBatch> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.readRun, sessionId, afterSequence)) as VerifiedRunBatch,
  cancelRun: async (sessionId: string): Promise<VerifiedRunCancelResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.cancelRun, sessionId)) as VerifiedRunCancelResult,
  diagnose: async (request: DiagnoseRequest): Promise<DiagnoseResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.diagnose, request)) as DiagnoseResult,
  startTrace: async (request: TraceRequest): Promise<TraceStartResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.startTrace, request)) as TraceStartResult,
  readTrace: async (sessionId: string, afterSequence: number): Promise<TraceBatch> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.readTrace, sessionId, afterSequence)) as TraceBatch,
  cancelTrace: async (sessionId: string): Promise<TraceCancelResult> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.cancelTrace, sessionId)) as TraceCancelResult,
});

contextBridge.exposeInMainWorld("panelApi", panelApi);
