import type {
  CreateWorkspaceDocumentRequest,
  OpenWorkspaceDocumentRequest,
  SaveWorkspaceDocumentRequest,
  WorkspaceDocumentResult,
  WorkspaceListResult,
  WorkspaceSaveResult,
} from "./workspace.js";

export type RunnerMode = "seatbelt-best-effort" | "trusted-only" | "disabled";

export type SeatbeltProbeStatus = "not-checked" | "probe-succeeded" | "unavailable";

export interface FixtureInput {
  readonly path: string;
  readonly contents: string | Uint8Array;
}

export interface CompileRequest {
  readonly source: string;
  readonly sourceName?: string;
}

export interface RunRequest {
  readonly artifactId: string;
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly fixtures?: readonly FixtureInput[];
}

export type RunnerErrorCode =
  | "INVALID_REQUEST"
  | "RUNNER_DISABLED"
  | "RUNNER_BUSY"
  | "RUNNER_SHUTTING_DOWN"
  | "SANDBOX_UNAVAILABLE"
  | "TRUST_CONFIRMATION_REQUIRED"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_EXPIRED"
  | "ARTIFACT_CAPACITY_REACHED"
  | "COMPILE_FAILED"
  | "LEAK_CHECK_FAILED"
  | "RESOURCE_LIMIT"
  | "PROCESS_SPAWN_FAILED"
  | "PROCESS_CONTROL_FAILED"
  | "INTERNAL_ERROR";

export interface RunnerError {
  readonly code: RunnerErrorCode;
  readonly message: string;
}

export type TerminationReason =
  | "not-started"
  | "process-exit"
  | "spawn-error"
  | "input-error"
  | "wall-time-limit"
  | "output-limit"
  | "rss-limit"
  | "process-count-limit"
  | "rss-monitor-error";

export interface SuccessfulCompileResult {
  readonly ok: true;
  readonly artifactId: string;
  readonly expiresAtMs: number;
  readonly diagnostics: string;
}

export interface FailedCompileResult {
  readonly ok: false;
  readonly diagnostics: string;
  readonly error: RunnerError;
}

export type CompileResult = SuccessfulCompileResult | FailedCompileResult;

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly termination: TerminationReason;
  readonly durationMs: number;
  readonly error?: RunnerError;
}

export interface Capabilities {
  readonly mode: RunnerMode;
  readonly runnerEnabled: boolean;
  readonly seatbeltProbe: {
    readonly status: SeatbeltProbeStatus;
    readonly detail: string;
  };
  readonly requiresNativeTrustConfirmation: boolean;
}

export type SourceOrigin = "dialog" | "drop" | "paste" | "workspace";

export type SourceImportErrorCode =
  | "SOURCE_IMPORT_BUSY"
  | "SOURCE_CONTEXT_CLOSED"
  | "SOURCE_DIALOG_FAILED"
  | "SOURCE_INVALID_DROP"
  | "SOURCE_INVALID_REQUEST"
  | "SOURCE_NOT_C_FILE"
  | "SOURCE_NOT_REGULAR_FILE"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_INVALID_UTF8"
  | "SOURCE_CONTAINS_NUL"
  | "SOURCE_READ_FAILED";

export interface SourceImportError {
  readonly code: SourceImportErrorCode;
  readonly message: string;
}

export interface ImportedSource {
  readonly source: string;
  readonly displayName: string;
  readonly origin: SourceOrigin;
}

export type SourceImportResult =
  | { readonly status: "opened"; readonly document: ImportedSource }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: SourceImportError };

export interface PanelApi {
  openSource(): Promise<SourceImportResult>;
  openDroppedSource(file: File): Promise<SourceImportResult>;
  listWorkspaceDocuments(): Promise<WorkspaceListResult>;
  createWorkspaceDocument(
    request: CreateWorkspaceDocumentRequest,
  ): Promise<WorkspaceDocumentResult>;
  openWorkspaceDocument(request: OpenWorkspaceDocumentRequest): Promise<WorkspaceDocumentResult>;
  saveWorkspaceDocument(request: SaveWorkspaceDocumentRequest): Promise<WorkspaceSaveResult>;
  onWorkspaceCloseRequested(handler: () => Promise<void>): () => void;
  capabilities(): Promise<Capabilities>;
  compile(request: CompileRequest): Promise<CompileResult>;
  run(request: RunRequest): Promise<RunResult>;
}
