import type { WorkspaceEntrySummary, WorkspaceSaveResult } from "../shared/workspace.js";

export type WorkspacePersistenceState = "unmanaged" | "pending" | "saving" | "saved" | "error";

export interface WorkspacePersistenceStatus {
  readonly state: WorkspacePersistenceState;
  readonly message: string;
  readonly recovery?: "reload-disk" | undefined;
}

export interface WorkspacePersistenceOptions {
  readonly delayMs?: number;
  readonly save: (
    entryId: string,
    expectedRevision: number,
    source: string,
  ) => Promise<WorkspaceSaveResult>;
  readonly onStatus: (status: WorkspacePersistenceStatus) => void;
}

export interface WorkspacePersistence {
  readonly activeEntry: WorkspaceEntrySummary | null;
  readonly hasUnsavedChanges: boolean;
  readonly sourceVersion: number;
  adopt(entry: WorkspaceEntrySummary): void;
  handleSourceChange(source: string): void;
  flush(): Promise<void>;
  discardActiveChanges(expectedSourceVersion?: number): void;
  deactivateAfterFlush(): void;
  deactivate(): Promise<void>;
  destroy(): void;
}

const DEFAULT_SAVE_DELAY_MS = 300;

interface PendingSource {
  readonly entryId: string;
  readonly source: string;
}

interface QueuedSave extends PendingSource {
  readonly task: Promise<boolean>;
}

export function createWorkspacePersistence(
  options: WorkspacePersistenceOptions,
): WorkspacePersistence {
  const delayMs = options.delayMs ?? DEFAULT_SAVE_DELAY_MS;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError("workspace persistence delayMs 必须是非负安全整数");
  }
  if (typeof options.save !== "function" || typeof options.onStatus !== "function") {
    throw new TypeError("workspace persistence callbacks 无效");
  }

  const durableEntries = new Map<string, WorkspaceEntrySummary>();
  const saveChains = new Map<string, Promise<boolean>>();
  const dirtySources = new Map<string, string>();
  const latestQueued = new Map<string, QueuedSave>();
  const latestSequence = new Map<string, number>();
  let activeEntry: WorkspaceEntrySummary | null = null;
  let sourceVersion = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const present = (
    state: WorkspacePersistenceState,
    message: string,
    recovery?: WorkspacePersistenceStatus["recovery"],
  ): void => {
    if (destroyed) return;
    options.onStatus(
      Object.freeze(recovery === undefined ? { state, message } : { state, message, recovery }),
    );
  };

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const queueDirty = (entryId = activeEntry?.id): Promise<boolean> | undefined => {
    clearTimer();
    if (entryId === undefined) return undefined;
    const source = dirtySources.get(entryId);
    const existingChain = saveChains.get(entryId);
    if (source === undefined) return existingChain;
    const queued = latestQueued.get(entryId);
    if (queued?.source === source) return queued.task;

    const sequence = (latestSequence.get(entryId) ?? 0) + 1;
    latestSequence.set(entryId, sequence);
    const previous = existingChain ?? Promise.resolve(true);
    if (activeEntry?.id === entryId) present("saving", "正在同步到 Documents…");
    const task = previous
      .catch(() => false)
      .then(async () => {
        const durable = durableEntries.get(entryId);
        if (durable === undefined) return false;
        let result: WorkspaceSaveResult;
        try {
          result = await options.save(entryId, durable.revision, source);
        } catch {
          if (activeEntry?.id === entryId) {
            present("error", "保存失败 · 工作区 IPC 不可用");
          }
          return false;
        }
        if (result.status === "failed") {
          if (activeEntry?.id === entryId) {
            present(
              "error",
              `${result.error.code} · ${result.error.message}`,
              result.error.code === "WORKSPACE_CONFLICT" ? "reload-disk" : undefined,
            );
          }
          return false;
        }
        const savedEntry = Object.freeze({ ...result.entry });
        durableEntries.set(entryId, savedEntry);
        if (activeEntry?.id === entryId) activeEntry = savedEntry;
        if (dirtySources.get(entryId) === source) dirtySources.delete(entryId);
        if (
          activeEntry?.id === entryId &&
          latestSequence.get(entryId) === sequence &&
          !dirtySources.has(entryId)
        ) {
          present("saved", "已保存到 Documents");
        }
        return true;
      });
    let tracked: Promise<boolean>;
    tracked = task.finally(() => {
      if (saveChains.get(entryId) === tracked) saveChains.delete(entryId);
      if (latestQueued.get(entryId)?.task === tracked) latestQueued.delete(entryId);
    });
    saveChains.set(entryId, tracked);
    latestQueued.set(entryId, Object.freeze({ entryId, source, task: tracked }));
    return tracked;
  };

  const flush = async (): Promise<void> => {
    if (destroyed) return;
    const entryId = activeEntry?.id;
    if (entryId === undefined) return;
    while (true) {
      const task = queueDirty(entryId) ?? saveChains.get(entryId);
      if (task === undefined) return;
      const saved = await task;
      const newerTask = saveChains.get(entryId);
      if (newerTask !== undefined && newerTask !== task) continue;
      if (!saved) throw new Error("工作区仍有未保存修改；请检查保存状态后重试");
      if (!dirtySources.has(entryId)) return;
    }
  };

  const schedule = (): void => {
    clearTimer();
    if (delayMs === 0) {
      void queueDirty();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void queueDirty();
    }, delayMs);
  };

  const deactivateAfterFlush = (): void => {
    assertActive(destroyed);
    const entryId = activeEntry?.id;
    if (entryId !== undefined && (dirtySources.has(entryId) || saveChains.has(entryId))) {
      throw new Error("工作区仍有未保存修改，不能解除托管");
    }
    activeEntry = null;
    sourceVersion += 1;
    present("unmanaged", "临时文档 · 未自动保存");
  };

  present("unmanaged", "本地工作区未打开");

  return Object.freeze({
    get activeEntry(): WorkspaceEntrySummary | null {
      return activeEntry;
    },
    get hasUnsavedChanges(): boolean {
      const entryId = activeEntry?.id;
      return entryId !== undefined && (dirtySources.has(entryId) || saveChains.has(entryId));
    },
    get sourceVersion(): number {
      return sourceVersion;
    },
    adopt(entry: WorkspaceEntrySummary): void {
      assertActive(destroyed);
      if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") {
        throw new TypeError("workspace entry 无效");
      }
      const previousEntryId = activeEntry?.id;
      if (
        previousEntryId !== undefined &&
        (dirtySources.has(previousEntryId) || saveChains.has(previousEntryId))
      ) {
        throw new Error("切换工作区条目前必须完成保存");
      }
      activeEntry = Object.freeze({ ...entry });
      sourceVersion += 1;
      durableEntries.set(entry.id, activeEntry);
      present("saved", "已保存到 Documents");
    },
    handleSourceChange(source: string): void {
      if (destroyed || activeEntry === null) return;
      if (typeof source !== "string") throw new TypeError("source 必须是字符串");
      sourceVersion += 1;
      dirtySources.set(activeEntry.id, source);
      present("pending", "有修改待保存");
      schedule();
    },
    flush,
    discardActiveChanges(expectedSourceVersion?: number): void {
      assertActive(destroyed);
      const entryId = activeEntry?.id;
      if (entryId === undefined) return;
      if (expectedSourceVersion !== undefined && expectedSourceVersion !== sourceVersion) {
        throw new Error("源码已在恢复期间变化，拒绝放弃较新的本地修改");
      }
      if (saveChains.has(entryId)) throw new Error("保存请求尚未结束，暂时不能放弃本地修改");
      clearTimer();
      dirtySources.delete(entryId);
      latestQueued.delete(entryId);
      sourceVersion += 1;
    },
    deactivateAfterFlush,
    async deactivate(): Promise<void> {
      if (destroyed) return;
      await flush();
      deactivateAfterFlush();
    },
    destroy(): void {
      if (destroyed) return;
      clearTimer();
      destroyed = true;
      activeEntry = null;
      dirtySources.clear();
      latestQueued.clear();
    },
  });
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("workspace persistence 已销毁");
}
