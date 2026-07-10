import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { MAX_SOURCE_BYTES } from "../../src/shared/limits.js";
import { validateSourceText } from "../../src/shared/source-import.js";
import {
  WORKSPACE_KINDS,
  workspaceFailure,
  type CreateWorkspaceDocumentRequest,
  type SaveWorkspaceDocumentRequest,
  type WorkspaceDocument,
  type WorkspaceDocumentResult,
  type WorkspaceEntrySummary,
  type WorkspaceKind,
  type WorkspaceListResult,
  type WorkspaceSaveResult,
} from "../../src/shared/workspace.js";

export const WORKSPACE_ROOT_NAME = "C Algorithm Workbench";

const ENTRY_SCHEMA_VERSION = 1;
const SOURCE_NAME = "main.c";
const MANIFEST_NAME = "entry.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_TITLE_CODE_POINTS = 80;
const INITIAL_SOURCE = "int main(void) {\n  return 0;\n}\n";
const ENTRY_ID_PATTERN =
  /^(project|sandbox|test)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KIND_DIRECTORIES: Readonly<Record<WorkspaceKind, string>> = Object.freeze({
  project: "Projects",
  sandbox: "Sandboxes",
  test: "Tests",
});
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface EntryManifest {
  readonly schemaVersion: typeof ENTRY_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly title: string;
  readonly sourceFile: typeof SOURCE_NAME;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredEntry {
  readonly manifest: EntryManifest;
  readonly summary: WorkspaceEntrySummary;
  readonly source: string;
}

export interface WorkspaceStore {
  list(): Promise<WorkspaceListResult>;
  create(request: unknown): Promise<WorkspaceDocumentResult>;
  open(request: unknown): Promise<WorkspaceDocumentResult>;
  save(request: unknown): Promise<WorkspaceSaveResult>;
}

export function createWorkspaceStore(rootPath: string): WorkspaceStore {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath) || rootPath.includes("\0")) {
    throw new TypeError("工作区根目录必须是合法绝对路径");
  }

  const saveQueues = new Map<string, Promise<void>>();

  const ensureLayout = async (): Promise<boolean> => {
    try {
      await ensureRealDirectory(rootPath);
      for (const kind of WORKSPACE_KINDS) {
        await ensureRealDirectory(kindPath(rootPath, kind));
      }
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    async list(): Promise<WorkspaceListResult> {
      if (!(await ensureLayout())) return rootUnavailable();
      try {
        const entries = (await Promise.all(WORKSPACE_KINDS.map((kind) => listKind(rootPath, kind))))
          .flat()
          .sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
              left.title.localeCompare(right.title, "zh-Hans-CN"),
          );
        return Object.freeze({
          status: "ready",
          snapshot: Object.freeze({
            rootName: basename(rootPath),
            entries: Object.freeze(entries),
          }),
        });
      } catch {
        return workspaceFailure("WORKSPACE_READ_FAILED", "无法读取本地工作区文件列表。");
      }
    },

    async create(request: unknown): Promise<WorkspaceDocumentResult> {
      const validated = validateCreateRequest(request);
      if (!validated.ok) return validated.failure;
      if (!(await ensureLayout())) return rootUnavailable();

      const id = `${validated.request.kind}-${randomUUID()}`;
      const directory = entryPath(rootPath, id);
      const now = new Date().toISOString();
      const manifest = freezeManifest({
        schemaVersion: ENTRY_SCHEMA_VERSION,
        id,
        kind: validated.request.kind,
        title: validated.request.title,
        sourceFile: SOURCE_NAME,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });

      try {
        await mkdir(directory, { mode: 0o700 });
        await writeExclusive(join(directory, SOURCE_NAME), INITIAL_SOURCE);
        await writeExclusive(join(directory, MANIFEST_NAME), serializeManifest(manifest));
        return openedResult(manifest, INITIAL_SOURCE);
      } catch {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        return workspaceFailure("WORKSPACE_WRITE_FAILED", "无法在 Documents 中创建工作区条目。");
      }
    },

    async open(request: unknown): Promise<WorkspaceDocumentResult> {
      const validated = validateOpenRequest(request);
      if (!validated.ok) return validated.failure;
      if (!(await ensureLayout())) return rootUnavailable();
      try {
        const entry = await readStoredEntry(rootPath, validated.entryId);
        return Object.freeze({
          status: "opened",
          document: Object.freeze({ entry: entry.summary, source: entry.source }),
        });
      } catch (error: unknown) {
        return readFailure(error);
      }
    },

    async save(request: unknown): Promise<WorkspaceSaveResult> {
      const validated = validateSaveRequest(request);
      if (!validated.ok) return validated.failure;
      if (!(await ensureLayout())) return rootUnavailable();
      return enqueueSave(saveQueues, validated.request.entryId, () =>
        saveDocument(rootPath, validated.request),
      );
    },
  });
}

async function saveDocument(
  rootPath: string,
  request: SaveWorkspaceDocumentRequest,
): Promise<WorkspaceSaveResult> {
  let stored: StoredEntry;
  try {
    stored = await readStoredEntry(rootPath, request.entryId);
  } catch (error: unknown) {
    return readFailure(error);
  }
  if (stored.manifest.revision !== request.expectedRevision) {
    return workspaceFailure("WORKSPACE_CONFLICT", "磁盘版本已更新；为避免覆盖，请重新打开该条目。");
  }

  const nextManifest = freezeManifest({
    ...stored.manifest,
    revision: stored.manifest.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  const directory = entryPath(rootPath, request.entryId);
  try {
    await atomicWrite(join(directory, SOURCE_NAME), request.source);
    await atomicWrite(join(directory, MANIFEST_NAME), serializeManifest(nextManifest));
    const validation = validateSourceText(request.source);
    if (!validation.ok) throw new Error("validated-source-became-invalid");
    return Object.freeze({
      status: "saved",
      entry: toSummary(nextManifest, validation.byteLength),
    });
  } catch {
    return workspaceFailure("WORKSPACE_WRITE_FAILED", "无法将修改同步到 Documents 工作区。");
  }
}

async function enqueueSave(
  queues: Map<string, Promise<void>>,
  entryId: string,
  operation: () => Promise<WorkspaceSaveResult>,
): Promise<WorkspaceSaveResult> {
  const previous = queues.get(entryId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  queues.set(entryId, settled);
  void settled.finally(() => {
    if (queues.get(entryId) === settled) queues.delete(entryId);
  });
  return task;
}

type CreateValidation =
  | { readonly ok: true; readonly request: CreateWorkspaceDocumentRequest }
  | { readonly ok: false; readonly failure: ReturnType<typeof workspaceFailure> };

function validateCreateRequest(value: unknown): CreateValidation {
  if (!isExactObject(value, ["kind", "title"])) return invalidRequest();
  const candidate = value as { readonly kind: unknown; readonly title: unknown };
  if (!isWorkspaceKind(candidate.kind) || typeof candidate.title !== "string") {
    return invalidRequest();
  }
  const title = normalizeTitle(candidate.title);
  if (title === null) {
    return {
      ok: false,
      failure: workspaceFailure(
        "WORKSPACE_INVALID_TITLE",
        "名称须为 1–80 个可见字符，且不能包含控制字符。",
      ),
    };
  }
  return {
    ok: true,
    request: Object.freeze({ kind: candidate.kind, title }),
  };
}

type OpenValidation =
  | { readonly ok: true; readonly entryId: string }
  | { readonly ok: false; readonly failure: ReturnType<typeof workspaceFailure> };

function validateOpenRequest(value: unknown): OpenValidation {
  if (!isExactObject(value, ["entryId"])) return invalidRequest();
  const entryId = (value as { readonly entryId: unknown }).entryId;
  if (typeof entryId !== "string" || !ENTRY_ID_PATTERN.test(entryId)) return invalidRequest();
  return { ok: true, entryId };
}

type SaveValidation =
  | { readonly ok: true; readonly request: SaveWorkspaceDocumentRequest }
  | { readonly ok: false; readonly failure: ReturnType<typeof workspaceFailure> };

function validateSaveRequest(value: unknown): SaveValidation {
  if (!isExactObject(value, ["entryId", "expectedRevision", "source"])) {
    return invalidRequest();
  }
  const candidate = value as {
    readonly entryId: unknown;
    readonly expectedRevision: unknown;
    readonly source: unknown;
  };
  const openRequest = validateOpenRequest({ entryId: candidate.entryId });
  if (
    !openRequest.ok ||
    !Number.isSafeInteger(candidate.expectedRevision) ||
    (candidate.expectedRevision as number) < 0 ||
    typeof candidate.source !== "string"
  ) {
    return invalidRequest();
  }
  const validation = validateSourceText(candidate.source);
  if (!validation.ok) {
    return {
      ok: false,
      failure: workspaceFailure(
        validation.code === "SOURCE_TOO_LARGE" ? "WORKSPACE_TOO_LARGE" : "WORKSPACE_INVALID_SOURCE",
        validation.message,
      ),
    };
  }
  return {
    ok: true,
    request: Object.freeze({
      entryId: openRequest.entryId,
      expectedRevision: candidate.expectedRevision as number,
      source: candidate.source,
    }),
  };
}

function invalidRequest(): {
  readonly ok: false;
  readonly failure: ReturnType<typeof workspaceFailure>;
} {
  return {
    ok: false,
    failure: workspaceFailure("WORKSPACE_INVALID_REQUEST", "工作区请求格式无效。"),
  };
}

function isExactObject(value: unknown, expectedKeys: readonly string[]): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === "string" && WORKSPACE_KINDS.some((kind) => kind === value);
}

function normalizeTitle(value: string): string | null {
  const title = value.trim().normalize("NFC");
  if (title.length === 0 || [...title].length > MAX_TITLE_CODE_POINTS || /\p{Cc}/u.test(title)) {
    return null;
  }
  return title;
}

function kindFromEntryId(entryId: string): WorkspaceKind {
  const kind = entryId.slice(0, entryId.indexOf("-"));
  if (!isWorkspaceKind(kind)) throw new Error("invalid-entry-kind");
  return kind;
}

function kindPath(rootPath: string, kind: WorkspaceKind): string {
  return join(rootPath, KIND_DIRECTORIES[kind]);
}

function entryPath(rootPath: string, entryId: string): string {
  return join(kindPath(rootPath, kindFromEntryId(entryId)), entryId);
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not-real-directory");
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700 });
  }
}

async function listKind(
  rootPath: string,
  kind: WorkspaceKind,
): Promise<readonly WorkspaceEntrySummary[]> {
  const directory = kindPath(rootPath, kind);
  const entries = await readdir(directory, { withFileTypes: true });
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && ENTRY_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        try {
          const stored = await readStoredEntry(rootPath, entry.name);
          return stored.manifest.kind === kind ? stored.summary : null;
        } catch {
          return null;
        }
      }),
  );
  return Object.freeze(
    summaries.filter((summary): summary is WorkspaceEntrySummary => summary !== null),
  );
}

async function readStoredEntry(rootPath: string, entryId: string): Promise<StoredEntry> {
  if (!ENTRY_ID_PATTERN.test(entryId)) throw workspaceReadError("invalid");
  const directory = entryPath(rootPath, entryId);
  const directoryStat = await lstat(directory).catch((error: unknown) => {
    throw isNodeError(error, "ENOENT") ? workspaceReadError("missing") : error;
  });
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw workspaceReadError("not-regular");
  }
  const manifestText = await readRegularUtf8(join(directory, MANIFEST_NAME), MAX_MANIFEST_BYTES);
  const manifest = parseManifest(manifestText, entryId);
  const source = await readRegularUtf8(join(directory, SOURCE_NAME), MAX_SOURCE_BYTES);
  const validation = validateSourceText(source);
  if (!validation.ok) {
    throw workspaceReadError(validation.code === "SOURCE_TOO_LARGE" ? "too-large" : "invalid");
  }
  return Object.freeze({
    manifest,
    source,
    summary: toSummary(manifest, validation.byteLength),
  });
}

async function readRegularUtf8(path: string, maxBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw workspaceReadError("not-regular");
    if (stat.size > maxBytes) throw workspaceReadError("too-large");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.byteLength) {
      const result = await handle.read(buffer, byteLength, buffer.byteLength - byteLength, null);
      if (result.bytesRead === 0) break;
      byteLength += result.bytesRead;
    }
    if (byteLength > maxBytes) throw workspaceReadError("too-large");
    try {
      return utf8Decoder.decode(buffer.subarray(0, byteLength));
    } catch {
      throw workspaceReadError("invalid");
    }
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) throw workspaceReadError("missing");
    if (isNodeError(error, "ELOOP")) throw workspaceReadError("not-regular");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseManifest(text: string, expectedId: string): EntryManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw workspaceReadError("invalid");
  }
  if (
    !isExactObject(value, [
      "createdAt",
      "id",
      "kind",
      "revision",
      "schemaVersion",
      "sourceFile",
      "title",
      "updatedAt",
    ])
  ) {
    throw workspaceReadError("invalid");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== ENTRY_SCHEMA_VERSION ||
    manifest.id !== expectedId ||
    typeof manifest.id !== "string" ||
    !ENTRY_ID_PATTERN.test(manifest.id) ||
    !isWorkspaceKind(manifest.kind) ||
    manifest.kind !== kindFromEntryId(expectedId) ||
    typeof manifest.title !== "string" ||
    normalizeTitle(manifest.title) !== manifest.title ||
    manifest.sourceFile !== SOURCE_NAME ||
    !Number.isSafeInteger(manifest.revision) ||
    (manifest.revision as number) < 0 ||
    !isIsoTimestamp(manifest.createdAt) ||
    !isIsoTimestamp(manifest.updatedAt)
  ) {
    throw workspaceReadError("invalid");
  }
  return freezeManifest(manifest as unknown as EntryManifest);
}

function freezeManifest(manifest: EntryManifest): EntryManifest {
  return Object.freeze({ ...manifest });
}

function toSummary(manifest: EntryManifest, byteLength: number): WorkspaceEntrySummary {
  return Object.freeze({
    id: manifest.id,
    kind: manifest.kind,
    title: manifest.title,
    sourceName: SOURCE_NAME,
    revision: manifest.revision,
    byteLength,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  });
}

function openedResult(manifest: EntryManifest, source: string): WorkspaceDocumentResult {
  const validation = validateSourceText(source);
  if (!validation.ok) throw new Error("内部初始源码无效");
  const document: WorkspaceDocument = Object.freeze({
    entry: toSummary(manifest, validation.byteLength),
    source,
  });
  return Object.freeze({ status: "opened", document });
}

function serializeManifest(manifest: EntryManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporaryPath, contents);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

type WorkspaceReadFailure = Error & { readonly reason: string };

function workspaceReadError(reason: string): WorkspaceReadFailure {
  return Object.assign(new Error("workspace-read-failure"), { reason });
}

function readFailure(error: unknown): ReturnType<typeof workspaceFailure> {
  const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
  if (reason === "missing") {
    return workspaceFailure("WORKSPACE_NOT_FOUND", "工作区条目已经不存在。");
  }
  if (reason === "not-regular") {
    return workspaceFailure("WORKSPACE_NOT_REGULAR_FILE", "拒绝读取非普通文件或符号链接。");
  }
  if (reason === "too-large") {
    return workspaceFailure("WORKSPACE_TOO_LARGE", "C 源码超过 512 KiB 上限。");
  }
  return workspaceFailure("WORKSPACE_READ_FAILED", "无法读取本地工作区条目。");
}

function rootUnavailable(): ReturnType<typeof workspaceFailure> {
  return workspaceFailure("WORKSPACE_ROOT_UNAVAILABLE", "无法准备 Documents 中的应用专属工作区。");
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
