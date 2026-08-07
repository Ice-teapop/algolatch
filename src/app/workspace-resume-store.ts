export const WORKSPACE_RESUME_STORAGE_KEY = "algolatch.workspace.resume";
export const WORKSPACE_RESUME_SCHEMA_VERSION = 1;

const MAX_OPAQUE_ENTRY_ID_LENGTH = 256;

export interface WorkspaceResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkspaceResumeStore {
  read(): string | null;
  write(entryId: string): void;
  clear(): void;
}

interface WorkspaceResumeState {
  readonly schemaVersion: typeof WORKSPACE_RESUME_SCHEMA_VERSION;
  readonly entryId: string;
}

export function createWorkspaceResumeStore(
  storage: WorkspaceResumeStorage | null | undefined,
): WorkspaceResumeStore {
  const clear = (): void => {
    try {
      storage?.removeItem(WORKSPACE_RESUME_STORAGE_KEY);
    } catch {
      // Resume state is optional. Unavailable storage must never block the Dashboard.
    }
  };

  return Object.freeze({
    read(): string | null {
      let serialized: string | null;
      try {
        serialized = storage?.getItem(WORKSPACE_RESUME_STORAGE_KEY) ?? null;
      } catch {
        clear();
        return null;
      }
      if (serialized === null) return null;
      try {
        const candidate: unknown = JSON.parse(serialized);
        if (!isWorkspaceResumeState(candidate)) {
          clear();
          return null;
        }
        return candidate.entryId;
      } catch {
        clear();
        return null;
      }
    },
    write(entryId: string): void {
      if (!isOpaqueEntryId(entryId)) {
        clear();
        return;
      }
      const state: WorkspaceResumeState = Object.freeze({
        schemaVersion: WORKSPACE_RESUME_SCHEMA_VERSION,
        entryId,
      });
      try {
        storage?.setItem(WORKSPACE_RESUME_STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Opening a project remains successful when optional resume storage is unavailable.
      }
    },
    clear,
  });
}

function isWorkspaceResumeState(value: unknown): value is WorkspaceResumeState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("schemaVersion") &&
    keys.includes("entryId") &&
    record.schemaVersion === WORKSPACE_RESUME_SCHEMA_VERSION &&
    isOpaqueEntryId(record.entryId)
  );
}

function isOpaqueEntryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ENTRY_ID_LENGTH &&
    value.trim() === value &&
    !/[/\\\u0000-\u001f\u007f]/u.test(value)
  );
}
