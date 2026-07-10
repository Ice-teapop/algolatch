import type { ImportedSource, SourceImportResult } from "../shared/api.js";
import { importPastedSource } from "../shared/source-import.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";

export type SourceImportStatusState = "loading" | "ready" | "error";

export interface SourceImportControllerOptions {
  readonly load: (document: ImportedSource, isCurrent: () => boolean) => void | Promise<void>;
}

export interface SourceImportController {
  setEnabled(enabled: boolean): void;
  setStatus(message: string, state: SourceImportStatusState): void;
  destroy(): void;
}

/** Owns native-open, paste and file-drop UI without owning the parser session. */
export function createSourceImportController(
  elements: WorkbenchElements,
  options: SourceImportControllerOptions,
): SourceImportController {
  if (typeof options.load !== "function") {
    throw new TypeError("source import options.load 必须是函数");
  }

  let requestId = 0;
  let dragDepth = 0;
  let destroyed = false;

  const setStatus = (message: string, state: SourceImportStatusState): void => {
    if (typeof message !== "string" || !isStatusState(state)) {
      throw new TypeError("source import status 必须提供字符串与合法 state");
    }
    elements.importStatus.textContent = message;
    elements.importStatus.dataset.state = state;
  };

  const applyResult = async (
    result: SourceImportResult,
    currentRequest: number,
  ): Promise<boolean> => {
    const isCurrent = (): boolean => !destroyed && currentRequest === requestId;
    if (!isCurrent()) return false;
    if (result.status === "cancelled") {
      setStatus("已取消文件选择，当前文档保持不变。", "ready");
      return false;
    }
    if (result.status === "failed") {
      setStatus(`${result.error.code}：${result.error.message}`, "error");
      return false;
    }
    try {
      await options.load(result.document, isCurrent);
      if (!isCurrent()) return false;
      setStatus(`已载入 ${result.document.displayName}。`, "ready");
      return true;
    } catch (error: unknown) {
      if (isCurrent()) {
        setStatus(`源码载入失败：${errorMessage(error)}；当前文档保持不变。`, "error");
      }
      return false;
    }
  };

  const openNativeSource = async (): Promise<void> => {
    const currentRequest = ++requestId;
    setStatus("正在等待系统文件选择器…", "loading");
    try {
      const result = await window.panelApi.openSource();
      if (!destroyed && currentRequest === requestId) await applyResult(result, currentRequest);
    } catch {
      if (!destroyed && currentRequest === requestId) {
        setStatus("文件选择器 IPC 调用失败。", "error");
      }
    }
  };

  const showPasteDialog = (): void => {
    elements.pasteError.textContent = "";
    elements.pasteSource.value = "";
    elements.pasteDialog.showModal();
    elements.pasteSource.focus();
  };

  const confirmPaste = async (): Promise<void> => {
    const result = importPastedSource(elements.pasteSource.value);
    if (result.status === "failed") {
      elements.pasteError.textContent = result.error.message;
      return;
    }
    if (result.status === "opened") {
      const currentRequest = ++requestId;
      if (await applyResult(result, currentRequest)) {
        elements.pasteDialog.close("loaded");
      }
    }
  };

  const clearPasteError = (): void => {
    elements.pasteError.textContent = "";
  };

  const onDragEnter = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    elements.dropOverlay.hidden = false;
  };

  const onDragOver = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) elements.dropOverlay.hidden = true;
  };

  const onDrop = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    elements.dropOverlay.hidden = true;
    const files = event.dataTransfer?.files;
    if (files === undefined || files.length !== 1 || files[0] === undefined) {
      setStatus("请一次只拖入一个 .c 文件。", "error");
      return;
    }
    const currentRequest = ++requestId;
    setStatus("正在读取拖入的 C 文件…", "loading");
    void window.panelApi
      .openDroppedSource(files[0])
      .then(async (result) => {
        if (!destroyed && currentRequest === requestId) {
          await applyResult(result, currentRequest);
        }
      })
      .catch(() => {
        if (!destroyed && currentRequest === requestId) {
          setStatus("拖拽导入 IPC 调用失败。", "error");
        }
      });
  };

  elements.openButton.addEventListener("click", openNativeSource);
  elements.pasteButton.addEventListener("click", showPasteDialog);
  const onPasteConfirm = (): void => void confirmPaste();
  elements.pasteConfirm.addEventListener("click", onPasteConfirm);
  elements.pasteDialog.addEventListener("close", clearPasteError);
  elements.shell.addEventListener("dragenter", onDragEnter);
  elements.shell.addEventListener("dragover", onDragOver);
  elements.shell.addEventListener("dragleave", onDragLeave);
  elements.shell.addEventListener("drop", onDrop);

  return Object.freeze({
    setEnabled(enabled: boolean): void {
      if (destroyed) return;
      if (typeof enabled !== "boolean") throw new TypeError("enabled 必须是布尔值");
      elements.openButton.disabled = !enabled;
      elements.pasteButton.disabled = !enabled;
    },
    setStatus,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      requestId += 1;
      dragDepth = 0;
      elements.dropOverlay.hidden = true;
      elements.openButton.removeEventListener("click", openNativeSource);
      elements.pasteButton.removeEventListener("click", showPasteDialog);
      elements.pasteConfirm.removeEventListener("click", onPasteConfirm);
      elements.pasteDialog.removeEventListener("close", clearPasteError);
      elements.shell.removeEventListener("dragenter", onDragEnter);
      elements.shell.removeEventListener("dragover", onDragOver);
      elements.shell.removeEventListener("dragleave", onDragLeave);
      elements.shell.removeEventListener("drop", onDrop);
    },
  });
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

function isStatusState(state: string): state is SourceImportStatusState {
  return state === "loading" || state === "ready" || state === "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
