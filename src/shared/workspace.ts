export const WORKSPACE_KINDS = Object.freeze(["project", "sandbox", "test"] as const);

export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export interface WorkspaceEntrySummary {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly title: string;
  readonly sourceName: "main.c";
  readonly revision: number;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceDocument {
  readonly entry: WorkspaceEntrySummary;
  readonly source: string;
}

export interface WorkspaceSnapshot {
  /** Display-only. The absolute local path is never exposed to the renderer. */
  readonly rootName: string;
  readonly entries: readonly WorkspaceEntrySummary[];
}

export type WorkspaceErrorCode =
  | "WORKSPACE_CONFLICT"
  | "WORKSPACE_CONTEXT_CLOSED"
  | "WORKSPACE_INVALID_REQUEST"
  | "WORKSPACE_INVALID_SOURCE"
  | "WORKSPACE_INVALID_TITLE"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_REGULAR_FILE"
  | "WORKSPACE_READ_FAILED"
  | "WORKSPACE_ROOT_UNAVAILABLE"
  | "WORKSPACE_TOO_LARGE"
  | "WORKSPACE_WRITE_FAILED";

export interface WorkspaceError {
  readonly code: WorkspaceErrorCode;
  readonly message: string;
}

export interface CreateWorkspaceDocumentRequest {
  readonly kind: WorkspaceKind;
  readonly title: string;
}

export interface OpenWorkspaceDocumentRequest {
  readonly entryId: string;
}

export interface SaveWorkspaceDocumentRequest extends OpenWorkspaceDocumentRequest {
  readonly expectedRevision: number;
  readonly source: string;
}

export type WorkspaceListResult =
  | { readonly status: "ready"; readonly snapshot: WorkspaceSnapshot }
  | { readonly status: "failed"; readonly error: WorkspaceError };

export type WorkspaceDocumentResult =
  | { readonly status: "opened"; readonly document: WorkspaceDocument }
  | { readonly status: "failed"; readonly error: WorkspaceError };

export type WorkspaceSaveResult =
  | { readonly status: "saved"; readonly entry: WorkspaceEntrySummary }
  | { readonly status: "failed"; readonly error: WorkspaceError };

export function workspaceFailure(
  code: WorkspaceErrorCode,
  message: string,
): { readonly status: "failed"; readonly error: WorkspaceError } {
  return Object.freeze({
    status: "failed",
    error: Object.freeze({ code, message }),
  });
}
