import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeProgramCst,
  type CfgEdgeKind,
  type CfgPartialReasonCode,
  type FunctionCfg,
} from "../../src/analysis/index.js";
import { type Block, type CParser, type TextRange } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";
import {
  loadCfgGoldCorpus,
  normalizeAnalysisFindings,
  normalizeFunctionCfg,
  rangeKey,
  reachableGoldNodeKeys,
  type GoldFunction,
  type GoldRange,
} from "./cfg-gold-support.js";

const GOLD_ROOT = fileURLToPath(new URL("../../corpus/m5a/cfg-gold/", import.meta.url));
const corpus = loadCfgGoldCorpus(GOLD_ROOT);
const REQUIRED_EDGE_KIND_MAP = {
  entry: true,
  next: true,
  "branch-true": true,
  "branch-false": true,
  "switch-case": true,
  "switch-default": true,
  "switch-miss": true,
  break: true,
  continue: true,
  goto: true,
  return: true,
  terminate: true,
} as const satisfies Readonly<Record<CfgEdgeKind, true>>;
const REQUIRED_EDGE_KINDS = Object.keys(REQUIRED_EDGE_KIND_MAP) as CfgEdgeKind[];
const PARTIAL_REASON_COVERAGE = {
  "parse-error": "foundation",
  "unsupported-control-flow": "gold",
  "unsupported-syntax": "gold",
} as const satisfies Readonly<Record<CfgPartialReasonCode, "foundation" | "gold">>;
const REQUIRED_GOLD_PARTIAL_REASONS = (
  Object.entries(PARTIAL_REASON_COVERAGE) as Array<
    [CfgPartialReasonCode, (typeof PARTIAL_REASON_COVERAGE)[CfgPartialReasonCode]]
  >
)
  .filter(([, suite]) => suite === "gold")
  .map(([reason]) => reason);

describe("M5a CFG gold corpus contract", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("pins a unique 30–50 function corpus through the manifest", () => {
    expect(corpus.cases).toHaveLength(corpus.manifest.expectedFixtureCount);
    expect(
      corpus.cases.reduce((count, fixture) => count + fixture.expected.functions.length, 0),
    ).toBe(corpus.manifest.expectedFunctionCount);
    expect(corpus.manifest.expectedFunctionCount).toBeGreaterThanOrEqual(30);
    expect(corpus.manifest.expectedFunctionCount).toBeLessThanOrEqual(50);
  });

  it("derives the required CFG coverage from gold structure", () => {
    const functions = corpus.cases.flatMap((fixture) => fixture.expected.functions);
    const nodes = functions.flatMap((cfg) => cfg.nodes);
    const edges = functions.flatMap((cfg) => cfg.edges);
    const partialReasonCodes = [
      ...new Set(functions.flatMap((cfg) => cfg.partialReasons.map((reason) => reason.code))),
    ].sort();
    const edgeKinds = [...new Set(edges.map((edge) => edge.kind))].sort();
    expect(edgeKinds).toEqual([...REQUIRED_EDGE_KINDS].sort());
    expect(partialReasonCodes).toEqual([...REQUIRED_GOLD_PARTIAL_REASONS].sort());
    expect(functions.some((cfg) => cfg.partial)).toBe(true);
    expect(nodes.some((node) => !node.reachable)).toBe(true);
    expect(nodes.some((node) => node.ownership === "auxiliary")).toBe(true);
    expect(nodes.some((node) => node.kind === "control" && node.ownership === "primary")).toBe(
      true,
    );
    expect(edges.some((edge) => edge.kind === "switch-miss")).toBe(true);
    expect(
      functions.some((cfg) => {
        const nonBoundary = cfg.nodes.filter((node) => node.ownership !== "boundary");
        return nonBoundary.some(
          (node, index) =>
            nonBoundary.findIndex(
              (candidate) => candidate.text === node.text && candidate.key !== node.key,
            ) > index,
        );
      }),
    ).toBe(true);
  });

  it("contains reviewed non-empty finding expectations", () => {
    const findings = corpus.cases.flatMap((fixture) => fixture.expectedFindings.findings);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((finding) => finding.ruleId === "unreachable-code")).toBe(true);
    expect(findings.some((finding) => finding.ruleId === "uninitialized-read")).toBe(true);
    expect(findings.some((finding) => finding.ruleId === "literal-out-of-bounds")).toBe(true);
    expect(findings.every((finding) => finding.reason.length > 0)).toBe(true);
  });

  it.each(corpus.cases)(
    "matches the full CFG gold: $expected.caseId",
    ({ source, expected, expectedFindings }) => {
      const inspected = parser.inspect(source, 1, ({ rootNode, document }) =>
        analyzeProgramCst({ source, revision: 1, rootNode, document }),
      );
      const actualFunctions = inspected.result.functions.map((cfg) =>
        normalizeFunctionCfg(cfg, source),
      );
      const actualFindings = normalizeAnalysisFindings(inspected.result);

      expect(actualFunctions).toEqual(expected.functions);
      expect(expectedFindings.sourceSha256).toBe(expected.sourceSha256);
      expect(actualFindings).toEqual(expectedFindings.findings);

      const projectedByFunction = collectProjectedRangesByFunction(
        inspected.analysis.document.blocks,
      );
      for (const [index, cfg] of inspected.result.functions.entries()) {
        const actual = actualFunctions[index];
        const gold = expected.functions[index];
        if (actual === undefined || gold === undefined) {
          throw new Error(`${expected.caseId}: 函数数量或顺序异常`);
        }
        assertGraphProperties(cfg, actual, expected.caseId);
        assertOwnershipProperties(cfg, gold, projectedByFunction, expected.caseId);
      }
    },
  );
});

function assertGraphProperties(cfg: FunctionCfg, gold: GoldFunction, caseId: string): void {
  const nodeIds = new Set(cfg.nodes.map((node) => node.id));
  expect(cfg.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true);
  expect(
    new Set(cfg.edges.map((edge) => `${edge.from}\u0000${edge.kind}\u0000${edge.to}`)).size,
  ).toBe(cfg.edges.length);
  expect(cfg.edges.some((edge) => edge.from === cfg.exitId)).toBe(false);

  const reachableKeys = reachableGoldNodeKeys(gold);
  expect(gold.nodes.every((node) => node.reachable === reachableKeys.has(node.key))).toBe(true);
  expect(cfg.nodes.every((node) => containsRange(cfg.range, node.range))).toBe(true);
  expect(cfg.nodes.every((node) => containsRange(cfg.range, node.ownerBlockRange))).toBe(true);
  expect(gold.partial).toBe(gold.partialReasons.length > 0);

  const entryNodes = gold.nodes.filter((node) => node.key === "entry");
  const exitNodes = gold.nodes.filter((node) => node.key === "exit");
  if (entryNodes.length !== 1 || exitNodes.length !== 1) {
    throw new Error(`${caseId}: entry/exit 不唯一`);
  }
}

function assertOwnershipProperties(
  cfg: FunctionCfg,
  gold: GoldFunction,
  projectedByFunction: ReadonlyMap<string, readonly string[]>,
  caseId: string,
): void {
  const projected = projectedByFunction.get(rangeKey(gold.range));
  if (projected === undefined) throw new Error(`${caseId}: 找不到函数投影范围`);
  const actualPrimary = cfg.nodes
    .filter((node) => node.ownership === "primary")
    .map((node) => `${node.ownerBlockRange.from}:${node.ownerBlockRange.to}`)
    .sort();
  const goldPrimary = gold.nodes
    .filter((node) => node.ownership === "primary")
    .map((node) => rangeKey(node.ownerRange))
    .sort();
  expect(actualPrimary).toEqual(projected);
  expect(goldPrimary).toEqual(projected);
  expect(new Set(actualPrimary).size).toBe(actualPrimary.length);

  const primaryOwners = new Set(actualPrimary);
  expect(
    cfg.nodes
      .filter((node) => node.ownership === "auxiliary")
      .every((node) =>
        primaryOwners.has(`${node.ownerBlockRange.from}:${node.ownerBlockRange.to}`),
      ),
  ).toBe(true);
}

function collectProjectedRangesByFunction(
  blocks: readonly Block[],
): ReadonlyMap<string, readonly string[]> {
  const output = new Map<string, readonly string[]>();
  const visit = (block: Block): void => {
    if (block.kind === "syntax" && block.role === "function") {
      const ranges: string[] = [];
      collectStatementRanges(block.children, ranges);
      output.set(`${block.range.from}:${block.range.to}`, Object.freeze(ranges.sort()));
      return;
    }
    block.children.forEach(visit);
  };
  blocks.forEach(visit);
  return output;
}

function collectStatementRanges(blocks: readonly Block[], output: string[]): void {
  for (const block of blocks) {
    if (block.kind === "syntax" && (block.role === "statement" || block.role === "declaration")) {
      output.push(`${block.range.from}:${block.range.to}`);
    }
    collectStatementRanges(block.children, output);
  }
}

function containsRange(parent: TextRange, child: TextRange | GoldRange): boolean {
  const from = "from" in child ? child.from : child[0];
  const to = "to" in child ? child.to : child[1];
  return from >= parent.from && to <= parent.to;
}
