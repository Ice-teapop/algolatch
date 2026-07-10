import type { CAnalysisSnapshot } from "../core/index.js";
import type { BlockTree } from "../ui/block-tree.js";
import type { CodeSourceChangeReason } from "../ui/code-pane.js";
import type { EditPanel } from "../ui/edit-panel.js";
import type { ProjectionStatus } from "../ui/projection-status.js";
import type { StructureEditPanel } from "../ui/structure-edit-panel.js";
import type { WorkbenchElements } from "../ui/workbench-shell.js";
import { sourceMetadata } from "./source-display.js";
import type { SourceImportController } from "./source-import-controller.js";
import type { SourceHoldDetail, SourceProjectionMode } from "./source-sync-controller.js";

export interface ProjectionPresenterOptions {
  readonly elements: Pick<WorkbenchElements, "sourceMeta" | "parserStatus">;
  readonly blockTree: Pick<BlockTree, "setInteractionEnabled">;
  readonly editPanel: Pick<EditPanel, "setTarget" | "setStatus">;
  readonly structureEditPanel: Pick<StructureEditPanel, "setSelection">;
  readonly projectionStatus: ProjectionStatus;
  readonly sourceImport: Pick<SourceImportController, "setStatus">;
  readonly adopt: (source: string, analysis: CAnalysisSnapshot) => void;
  readonly getProjectionMode: () => SourceProjectionMode;
}

export interface ProjectionPresenter {
  pending(source: string, reason: CodeSourceChangeReason): void;
  adopted(
    source: string,
    analysis: CAnalysisSnapshot,
    mode: "synced" | "recovery",
    reason: CodeSourceChangeReason,
  ): void;
  held(source: string, detail: SourceHoldDetail): void;
  inputRejected(error: unknown): void;
  destroy(): void;
}

/** Presents source-sync state without owning parser or source session state. */
export function createProjectionPresenter(
  options: ProjectionPresenterOptions,
): ProjectionPresenter {
  let destroyed = false;
  const assertActive = (): void => {
    if (destroyed) throw new Error("投影状态 presenter 已销毁");
  };
  const disableStructuredEditing = (): void => {
    options.blockTree.setInteractionEnabled(false);
    options.editPanel.setTarget(null);
    options.structureEditPanel.setSelection(null);
  };

  return Object.freeze({
    pending(source: string, reason: CodeSourceChangeReason): void {
      assertActive();
      disableStructuredEditing();
      options.editPanel.setStatus({ kind: "working", message: "代码已更新，正在重建积木投影…" });
      options.projectionStatus.setState("pending");
      options.elements.sourceMeta.textContent = sourceMetadata(source);
      options.elements.parserStatus.textContent = "正在重新解析当前 C 代码…";
      options.elements.parserStatus.dataset.state = "loading";
      options.sourceImport.setStatus(
        `${sourceAction(reason)}已写入代码，正在同步积木。`,
        "loading",
      );
    },
    adopted(
      source: string,
      analysis: CAnalysisSnapshot,
      mode: "synced" | "recovery",
      reason: CodeSourceChangeReason,
    ): void {
      assertActive();
      options.blockTree.setInteractionEnabled(true);
      options.adopt(source, analysis);
      options.projectionStatus.setState(mode);
      const action = sourceAction(reason);
      if (mode === "recovery") {
        options.sourceImport.setStatus(`${action}完成；局部语法问题已用恢复积木显示。`, "error");
      } else {
        options.editPanel.setStatus(`${action}完成。`);
        options.sourceImport.setStatus(`${action}完成；代码与积木已同步。`, "ready");
      }
    },
    held(source: string, detail: SourceHoldDetail): void {
      assertActive();
      disableStructuredEditing();
      const message =
        detail.kind === "recovery-impact"
          ? `语法恢复影响 ${(detail.assessment.affectedRatio * 100).toFixed(0)}%，积木暂时保持上次稳定结果。`
          : `当前代码无法形成稳定投影：${errorMessage(detail.error)}`;
      options.editPanel.setStatus({ kind: "parse-error", message });
      options.projectionStatus.setState("held", message);
      options.elements.sourceMeta.textContent = sourceMetadata(source);
      options.elements.parserStatus.textContent = "积木投影已暂停，等待代码恢复稳定";
      options.elements.parserStatus.dataset.state = "warning";
      options.sourceImport.setStatus(message, "error");
    },
    inputRejected(error: unknown): void {
      assertActive();
      const message = `输入未写入：${errorMessage(error)}`;
      options.sourceImport.setStatus(message, "error");
      const mode = options.getProjectionMode();
      if (mode === "pending" || mode === "held") return;
      options.editPanel.setStatus(
        mode === "recovery" ? { kind: "parse-error", message } : new Error(message),
      );
      options.projectionStatus.setState(mode);
    },
    destroy(): void {
      destroyed = true;
    },
  });
}

function sourceAction(reason: CodeSourceChangeReason): string {
  return reason === "undo" ? "撤销" : reason === "redo" ? "重做" : "修改";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
