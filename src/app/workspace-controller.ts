import type { ImportedSource, PanelApi } from "../shared/api.js";
import type {
  WorkspaceDocument,
  WorkspaceEntrySummary,
  WorkspaceKind,
} from "../shared/workspace.js";
import { createWorkspacePersistence } from "./workspace-persistence.js";
import { createWorkspaceDashboard, type WorkspaceDashboard } from "../ui/workspace-dashboard.js";

export interface WorkspaceControllerOptions {
  readonly host: HTMLElement;
  readonly api: Pick<
    PanelApi,
    | "listWorkspaceDocuments"
    | "createWorkspaceDocument"
    | "openWorkspaceDocument"
    | "saveWorkspaceDocument"
  >;
  readonly saveStatus: HTMLOutputElement;
  readonly recoveryButton: HTMLButtonElement;
  readonly load: (document: ImportedSource) => void;
  readonly enterWorkbench: () => void;
}

export interface WorkspaceController {
  readonly dashboard: WorkspaceDashboard;
  readonly activeEntry: WorkspaceEntrySummary | null;
  readonly hasUnsavedChanges: boolean;
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  handleSourceChange(source: string): void;
  flush(): Promise<void>;
  prepareExternalImport(isCurrent: () => boolean): Promise<boolean>;
  deactivate(): Promise<void>;
  destroy(): void;
}

export function createWorkspaceController(
  options: WorkspaceControllerOptions,
): WorkspaceController {
  assertOptions(options);
  let destroyed = false;
  let generation = 0;

  const persistence = createWorkspacePersistence({
    save: (entryId, expectedRevision, source) =>
      options.api.saveWorkspaceDocument({ entryId, expectedRevision, source }),
    onStatus(status) {
      options.saveStatus.dataset.state = status.state;
      options.saveStatus.textContent = status.message;
      options.recoveryButton.hidden = status.recovery !== "reload-disk";
    },
  });

  const setFailure = (code: string, message: string): void => {
    dashboard.setStatus(`${code}：${message}`, "error");
  };

  const adopt = (document: WorkspaceDocument): void => {
    options.load({
      source: document.source,
      displayName: `${document.entry.title}.c`,
      origin: "workspace",
    });
    persistence.adopt(document.entry);
    options.enterWorkbench();
    dashboard.setStatus(`已打开“${document.entry.title}”。`, "success");
  };

  const refresh = async (): Promise<void> => {
    if (destroyed) return;
    const requestGeneration = ++generation;
    dashboard.setStatus("正在读取 Documents 工作区…", "loading");
    try {
      const result = await options.api.listWorkspaceDocuments();
      if (destroyed || requestGeneration !== generation) return;
      if (result.status === "failed") {
        setFailure(result.error.code, result.error.message);
        return;
      }
      dashboard.setSnapshot(result.snapshot);
      dashboard.setStatus(
        result.snapshot.entries.length === 0
          ? "工作区为空；新建条目后会立即写入 Documents。"
          : `已载入 ${String(result.snapshot.entries.length)} 个本地条目。`,
        "ready",
      );
    } catch {
      if (!destroyed && requestGeneration === generation) {
        dashboard.setStatus("工作区 IPC 调用失败。", "error");
      }
    }
  };

  const dashboard = createWorkspaceDashboard(options.host, {
    async onCreate(kind: WorkspaceKind, title: string): Promise<boolean> {
      const requestGeneration = ++generation;
      dashboard.setStatus("正在创建本地条目…", "loading");
      try {
        await persistence.flush();
        const result = await options.api.createWorkspaceDocument({ kind, title });
        if (destroyed || requestGeneration !== generation) return false;
        if (result.status === "failed") {
          setFailure(result.error.code, result.error.message);
          return false;
        }
        adopt(result.document);
        void refresh();
        return true;
      } catch {
        if (!destroyed && requestGeneration === generation) {
          dashboard.setStatus("创建条目的 IPC 调用失败。", "error");
        }
        return false;
      }
    },
    async onOpen(entryId: string): Promise<void> {
      const requestGeneration = ++generation;
      dashboard.setStatus("正在打开本地条目…", "loading");
      try {
        await persistence.flush();
        const result = await options.api.openWorkspaceDocument({ entryId });
        if (destroyed || requestGeneration !== generation) return;
        if (result.status === "failed") {
          setFailure(result.error.code, result.error.message);
          return;
        }
        adopt(result.document);
      } catch {
        if (!destroyed && requestGeneration === generation) {
          dashboard.setStatus("打开条目的 IPC 调用失败。", "error");
        }
      }
    },
    onRefresh: refresh,
  });

  const recoverDiskVersion = async (): Promise<void> => {
    if (destroyed || options.recoveryButton.hidden || options.recoveryButton.disabled) return;
    const entry = persistence.activeEntry;
    if (entry === null) return;
    const ownerWindow = options.host.ownerDocument.defaultView;
    if (
      ownerWindow?.confirm(
        "磁盘版本已更新。重新载入会放弃当前未保存修改；已保存的历史版本不受影响。继续吗？",
      ) !== true
    ) {
      return;
    }
    const expectedSourceVersion = persistence.sourceVersion;
    const requestGeneration = ++generation;
    options.recoveryButton.disabled = true;
    dashboard.setStatus("正在重新读取磁盘版本…", "loading");
    try {
      const result = await options.api.openWorkspaceDocument({ entryId: entry.id });
      if (destroyed || requestGeneration !== generation) return;
      if (result.status === "failed") {
        setFailure(result.error.code, result.error.message);
        return;
      }
      if (persistence.sourceVersion !== expectedSourceVersion) {
        dashboard.setStatus("源码在恢复期间再次变化；未放弃本地修改，请重新操作。", "error");
        return;
      }
      options.load({
        source: result.document.source,
        displayName: `${result.document.entry.title}.c`,
        origin: "workspace",
      });
      persistence.discardActiveChanges(expectedSourceVersion);
      persistence.adopt(result.document.entry);
      options.enterWorkbench();
      dashboard.setStatus(`已重新载入“${result.document.entry.title}”的磁盘版本。`, "success");
    } catch {
      if (!destroyed && requestGeneration === generation) {
        dashboard.setStatus("重新载入磁盘版本失败；本地修改仍保留。", "error");
      }
    } finally {
      if (!destroyed) options.recoveryButton.disabled = false;
    }
  };
  const onRecoverDiskVersion = (): void => void recoverDiskVersion();
  options.recoveryButton.addEventListener("click", onRecoverDiskVersion);

  return Object.freeze({
    dashboard,
    get activeEntry(): WorkspaceEntrySummary | null {
      return persistence.activeEntry;
    },
    get hasUnsavedChanges(): boolean {
      return persistence.hasUnsavedChanges;
    },
    async initialize(): Promise<void> {
      if (destroyed) return;
      dashboard.setBusy(true);
      try {
        await refresh();
      } finally {
        if (!destroyed) dashboard.setBusy(false);
      }
    },
    refresh,
    handleSourceChange(source: string): void {
      if (!destroyed) persistence.handleSourceChange(source);
    },
    flush: () => persistence.flush(),
    async prepareExternalImport(isCurrent: () => boolean): Promise<boolean> {
      if (destroyed || typeof isCurrent !== "function") return false;
      await persistence.flush();
      if (!isCurrent()) return false;
      persistence.deactivateAfterFlush();
      return true;
    },
    async deactivate(): Promise<void> {
      if (destroyed) return;
      await persistence.deactivate();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      options.recoveryButton.removeEventListener("click", onRecoverDiskVersion);
      persistence.destroy();
      dashboard.destroy();
    },
  });
}

function assertOptions(options: WorkspaceControllerOptions): void {
  if (
    typeof options.api?.listWorkspaceDocuments !== "function" ||
    typeof options.api.createWorkspaceDocument !== "function" ||
    typeof options.api.openWorkspaceDocument !== "function" ||
    typeof options.api.saveWorkspaceDocument !== "function" ||
    !(options.saveStatus instanceof HTMLOutputElement) ||
    !(options.recoveryButton instanceof HTMLButtonElement) ||
    typeof options.load !== "function" ||
    typeof options.enterWorkbench !== "function"
  ) {
    throw new TypeError("Workspace controller options 无效");
  }
}
