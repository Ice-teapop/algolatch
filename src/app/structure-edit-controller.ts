import {
  createBlockIndex,
  planM3bEdit,
  renderSourceDoc,
  type BlockIndexEntry,
  type CAnalysisSnapshot,
  type M3bEditAnalyzer,
  type M3bEditPlan,
} from "../core/index.js";
import type { ImportedSource } from "../shared/api.js";
import type { StructureEditRequest } from "../ui/structure-edit-panel.js";
import type { SourceProjectionMode } from "./source-sync-controller.js";
import { structureEditSelectionForBlock } from "./structure-edit-selection.js";

export interface StructureEditSession {
  readonly imported: ImportedSource;
  readonly analysis: CAnalysisSnapshot;
}

export interface StructureEditControllerOptions {
  readonly getSession: () => StructureEditSession | null;
  readonly getAnalyzer: () => M3bEditAnalyzer | null;
  readonly getCurrentSource: () => string;
  readonly getProjectionMode: () => SourceProjectionMode;
  readonly resetProjection: () => void;
  readonly validateSource: (source: string) => void;
  readonly applyPatches: (patches: M3bEditPlan["patches"]) => boolean;
  readonly confirm: (plan: M3bEditPlan) => boolean | Promise<boolean>;
  readonly adopt: (imported: ImportedSource, analysis: CAnalysisSnapshot) => void;
  readonly onSuccess: () => void;
  readonly onError: (error: Error) => void;
}

export interface StructureEditController {
  assertReady(): void;
  plan(request: StructureEditRequest): M3bEditPlan;
  commit(plan: M3bEditPlan): void;
  run(request: StructureEditRequest): Promise<void>;
  move(sourceEntry: BlockIndexEntry, targetEntry: BlockIndexEntry): Promise<void>;
  destroy(): void;
}

/** Owns the single validated plan -> confirm -> exact commit path for M3b operations. */
export function createStructureEditController(
  options: StructureEditControllerOptions,
): StructureEditController {
  let destroyed = false;

  const requireSession = (): StructureEditSession => {
    const current = options.getSession();
    if (current === null) throw new Error("源码会话尚未就绪");
    return current;
  };

  const assertReady = (): void => {
    assertActive(destroyed);
    const current = requireSession();
    if (
      options.getProjectionMode() !== "synced" ||
      current.analysis.document.parse.hasError ||
      options.getCurrentSource() !== current.imported.source
    ) {
      throw new Error("代码与积木尚未同步，当前不能执行结构修改");
    }
  };

  const plan = (request: StructureEditRequest): M3bEditPlan => {
    assertReady();
    const current = requireSession();
    const analyzer = options.getAnalyzer();
    if (analyzer === null) throw new Error("C 解析器尚未加载");
    return planM3bEdit(
      {
        source: current.imported.source,
        analysis: current.analysis,
        analyzer,
        validateSource: options.validateSource,
      },
      request,
    );
  };

  const commit = (candidate: M3bEditPlan): void => {
    assertReady();
    const current = requireSession();
    if (current.analysis.statementEdits.revision !== candidate.baseRevision) {
      throw new Error("结构修改预览已经过期；源码未修改，请重新选择并预览");
    }
    if (
      candidate.candidateAnalysis.statementEdits.revision !== candidate.candidateRevision ||
      candidate.candidateSource !== candidate.candidateAnalysis.document.source ||
      renderSourceDoc(candidate.candidateAnalysis.document) !== candidate.candidateSource ||
      candidate.candidateAnalysis.document.parse.hasError
    ) {
      throw new Error("结构修改候选快照无效；源码未修改");
    }

    createBlockIndex(candidate.candidateAnalysis.document);
    const changed = options.applyPatches(candidate.patches);
    if (!changed || options.getCurrentSource() !== candidate.candidateSource) {
      throw new Error("CodeMirror 未能精确应用结构修改补丁");
    }

    options.resetProjection();
    options.adopt(
      Object.freeze({ ...current.imported, source: candidate.candidateSource }),
      candidate.candidateAnalysis,
    );
    options.onSuccess();
  };

  const run = async (request: StructureEditRequest): Promise<void> => {
    try {
      const candidate = plan(request);
      if (!(await options.confirm(candidate)) || destroyed) return;
      commit(candidate);
    } catch (error: unknown) {
      if (!destroyed) options.onError(asError(error));
    }
  };

  return Object.freeze({
    assertReady,
    plan,
    commit,
    run,
    async move(sourceEntry: BlockIndexEntry, targetEntry: BlockIndexEntry): Promise<void> {
      try {
        assertReady();
        const analysis = requireSession().analysis;
        const source = structureEditSelectionForBlock(analysis, sourceEntry)?.statement;
        const target = structureEditSelectionForBlock(analysis, targetEntry)?.statement;
        if (source === undefined || target === undefined) {
          throw new Error("拖拽两端必须是当前快照中的可编辑语句");
        }
        await run({
          kind: "swap-adjacent-statements",
          baseRevision: analysis.statementEdits.revision,
          targetId: source.id,
          expectedTargetText: source.text,
          adjacentTargetId: target.id,
          expectedAdjacentTargetText: target.text,
        });
      } catch (error: unknown) {
        if (!destroyed) options.onError(asError(error));
      }
    },
    destroy(): void {
      destroyed = true;
    },
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("无法完成结构修改");
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("结构编辑控制器已销毁");
}
