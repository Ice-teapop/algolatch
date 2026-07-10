import { Language, Parser } from "web-tree-sitter";
import type { SourceDoc } from "./model.js";
import { planConservativeLocalRename, type ConservativeLocalRenamePlan } from "./editing/rename.js";
import {
  extractStatementEditTargets,
  type StatementEditTargetSnapshot,
} from "./editing/statements.js";
import { extractEditTargets, type EditTargetSnapshot } from "./editing/targets.js";
import { projectCst } from "./projector.js";

export interface CParserAssets {
  readonly runtimeWasmUrl: string;
  readonly languageWasm: string | Uint8Array;
}

export interface CAnalysisSnapshot {
  readonly document: SourceDoc;
  readonly editTargets: EditTargetSnapshot;
  readonly statementEdits: StatementEditTargetSnapshot;
}

/** Pure-value input for a parser-owned local rename analysis. */
export interface LocalRenamePlanningRequest {
  readonly symbolId: string;
  readonly expectedOldName: string;
  readonly newName: string;
}

let initializedRuntimeUrl: string | undefined;
let runtimeInitialization: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

export class CParser {
  readonly #parser: Parser;
  #disposed = false;

  private constructor(parser: Parser) {
    this.#parser = parser;
  }

  static async create(assets: CParserAssets): Promise<CParser> {
    await initializeRuntime(assets.runtimeWasmUrl);
    const language = await loadLanguage(assets.languageWasm);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      return new CParser(parser);
    } catch (error) {
      parser.delete();
      throw error;
    }
  }

  project(source: string): SourceDoc {
    return this.analyze(source, 0).document;
  }

  analyze(source: string, revision: number): CAnalysisSnapshot {
    if (this.#disposed) {
      throw new Error("CParser 已释放，不能继续解析");
    }
    const tree = this.#parser.parse(source);
    if (tree === null) {
      throw new Error("tree-sitter 未返回语法树");
    }
    try {
      return Object.freeze({
        document: projectCst(source, tree.rootNode),
        editTargets: extractEditTargets(tree.rootNode, source, revision),
        statementEdits: extractStatementEditTargets(tree.rootNode, source, revision),
      });
    } finally {
      tree.delete();
    }
  }

  /**
   * Plans a conservative local rename without allowing a Tree-sitter Node to
   * escape the parser-owned tree lifetime.
   */
  planLocalRename(
    source: string,
    analysis: CAnalysisSnapshot,
    request: LocalRenamePlanningRequest,
  ): ConservativeLocalRenamePlan {
    if (this.#disposed) {
      throw new Error("CParser 已释放，不能继续解析");
    }
    const tree = this.#parser.parse(source);
    if (tree === null) {
      throw new Error("tree-sitter 未返回语法树");
    }
    try {
      return planConservativeLocalRename({
        source,
        rootNode: tree.rootNode,
        analysis: analysis.document,
        symbolId: request.symbolId,
        expectedOldName: request.expectedOldName,
        newName: request.newName,
      });
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#parser.delete();
    }
  }
}

async function initializeRuntime(runtimeWasmUrl: string): Promise<void> {
  if (initializedRuntimeUrl !== undefined && initializedRuntimeUrl !== runtimeWasmUrl) {
    throw new Error("同一进程不能用不同 URL 重复初始化 web-tree-sitter runtime");
  }
  initializedRuntimeUrl ??= runtimeWasmUrl;
  runtimeInitialization ??= Parser.init({
    locateFile: (requestedFile: string, scriptDirectory: string) =>
      requestedFile === "web-tree-sitter.wasm"
        ? runtimeWasmUrl
        : new URL(requestedFile, scriptDirectory).href,
  });
  await runtimeInitialization;
}

function loadLanguage(input: string | Uint8Array): Promise<Language> {
  if (input instanceof Uint8Array) {
    return Language.load(Uint8Array.from(input));
  }
  let cached = languageCache.get(input);
  if (cached === undefined) {
    cached = Language.load(input);
    languageCache.set(input, cached);
  }
  return cached;
}
