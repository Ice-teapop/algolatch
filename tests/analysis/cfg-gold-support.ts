import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type {
  AnalysisFindingReason,
  AnalysisFindingRuleId,
  CfgEdgeKind,
  CfgNodeKind,
  CfgNodeOwnership,
  CfgNodeRole,
  CfgPartialReasonCode,
  FunctionCfg,
  ProgramAnalysisSnapshot,
} from "../../src/analysis/index.js";

export interface CfgGoldCorpus {
  readonly manifest: CfgGoldManifest;
  readonly cases: readonly CfgGoldCase[];
}

export interface CfgGoldManifest {
  readonly schemaVersion: 1;
  readonly expectedFixtureCount: number;
  readonly expectedFunctionCount: number;
  readonly requiredTags: readonly string[];
  readonly fixtures: readonly string[];
}

export interface CfgGoldCase {
  readonly source: string;
  readonly expected: CfgGoldExpected;
  readonly expectedFindings: FindingsGold;
}

export interface CfgGoldExpected {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly sourceSha256: string;
  readonly sourceLengthUtf16: number;
  readonly tags: readonly string[];
  readonly functions: readonly GoldFunction[];
}

export interface GoldFunction {
  readonly key: string;
  readonly name: string;
  readonly range: GoldRange;
  readonly partial: boolean;
  readonly partialReasons: readonly GoldPartialReason[];
  readonly nodes: readonly GoldNode[];
  readonly edges: readonly GoldEdge[];
}

export interface GoldNode {
  readonly key: string;
  readonly kind: CfgNodeKind;
  readonly role: CfgNodeRole;
  readonly ownership: CfgNodeOwnership;
  readonly nodeType: string | null;
  readonly range: GoldRange;
  readonly ownerRange: GoldRange;
  readonly reachable: boolean;
  readonly text: string;
}

export interface GoldEdge {
  readonly from: string;
  readonly kind: CfgEdgeKind;
  readonly to: string;
}

export interface GoldPartialReason {
  readonly code: CfgPartialReasonCode;
  readonly nodeType: string;
  readonly range: GoldRange;
  readonly text: string;
}

export interface FindingsGold {
  readonly schemaVersion: 2;
  readonly sourceSha256: string;
  readonly findings: readonly GoldFinding[];
}

export interface GoldFinding {
  readonly function: string;
  readonly ruleId: AnalysisFindingRuleId;
  readonly reason: AnalysisFindingReason;
  readonly confidence: "certain" | "likely" | "hint";
  readonly primaryRange: GoldRange;
  readonly ownerNode: string;
  readonly subject: string | null;
  readonly evidence: readonly GoldEvidence[];
}

export interface GoldEvidence {
  readonly role: string;
  readonly range: GoldRange;
}

export type GoldRange = readonly [from: number, to: number];

const NODE_KINDS = new Set<CfgNodeKind>(["entry", "exit", "syntax", "control"]);
const NODE_ROLES = new Set<CfgNodeRole>(["boundary", "statement", "declaration", "control"]);
const OWNERSHIP_KINDS = new Set<CfgNodeOwnership>(["boundary", "primary", "auxiliary"]);
const EDGE_KINDS = new Set<CfgEdgeKind>([
  "entry",
  "next",
  "branch-true",
  "branch-false",
  "switch-case",
  "switch-default",
  "switch-miss",
  "break",
  "continue",
  "goto",
  "return",
  "terminate",
]);
const PARTIAL_CODES = new Set<CfgPartialReasonCode>([
  "parse-error",
  "unsupported-control-flow",
  "unsupported-syntax",
]);
const FINDING_CONFIDENCE = new Set<GoldFinding["confidence"]>(["certain", "likely", "hint"]);
const FINDING_RULE_ID_MAP = Object.freeze({
  "unreachable-code": true,
  "uninitialized-read": true,
  "literal-out-of-bounds": true,
  "loop-off-by-one": true,
  "memory-leak": true,
  "possible-memory-leak": true,
  "double-free": true,
  "possible-double-free": true,
  "use-after-free": true,
  "possible-use-after-free": true,
  "malloc-sizeof-pointer": true,
  "unchecked-allocation": true,
  "runtime-bound-check": true,
  "loop-index-mismatch": true,
} as const satisfies Readonly<Record<AnalysisFindingRuleId, true>>);
const FINDING_RULE_IDS = new Set<AnalysisFindingRuleId>(
  Object.keys(FINDING_RULE_ID_MAP) as AnalysisFindingRuleId[],
);
const FINDING_REASON_MAP = Object.freeze({
  "no-entry-path": true,
  "all-reaching-definitions-uninitialized": true,
  "no-reaching-definition": true,
  "negative-literal-index": true,
  "literal-index-not-less-than-extent": true,
  "inclusive-bound-reaches-fixed-extent": true,
  "live-at-all-normal-exits": true,
  "live-at-some-normal-exit": true,
  "must-freed-before-free": true,
  "may-freed-before-free": true,
  "must-freed-before-dereference": true,
  "may-freed-before-dereference": true,
  "pointer-size-used-for-pointee-allocation": true,
  "maybe-null-before-dereference": true,
  "loop-condition-does-not-constrain-index": true,
  "runtime-index-without-proven-bound": true,
} as const satisfies Readonly<Record<AnalysisFindingReason, true>>);
const FINDING_REASONS = new Set<AnalysisFindingReason>(
  Object.keys(FINDING_REASON_MAP) as AnalysisFindingReason[],
);
const EVIDENCE_ROLES = new Set([
  "allocation",
  "bound",
  "condition",
  "definition",
  "escape",
  "exit",
  "free",
  "index",
  "path",
  "state",
  "unreachable",
  "use",
]);

export function loadCfgGoldCorpus(root: string): CfgGoldCorpus {
  const entries = readdirSync(root, { withFileTypes: true });
  const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "manifest.json");
  if (manifestEntry === undefined) throw new Error("CFG gold corpus 缺少 manifest.json");
  const manifest = parseManifest(readJson(`${root}/manifest.json`));
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assertStringArrayEqual(directories, [...manifest.fixtures].sort(), "manifest fixtures 与目录");
  const unexpectedEntries = entries
    .filter((entry) => !entry.isDirectory() && !(entry.isFile() && entry.name === "manifest.json"))
    .map((entry) => entry.name);
  if (unexpectedEntries.length > 0) {
    throw new Error(`CFG gold corpus 存在未登记条目：${unexpectedEntries.join(", ")}`);
  }

  const cases = manifest.fixtures.map((fixtureName) => loadCase(root, fixtureName));
  if (cases.length !== manifest.expectedFixtureCount) {
    throw new Error("manifest expectedFixtureCount 与实际目录数量不一致");
  }
  const functionCount = cases.reduce((sum, fixture) => sum + fixture.expected.functions.length, 0);
  if (functionCount !== manifest.expectedFunctionCount) {
    throw new Error("manifest expectedFunctionCount 与金标函数数量不一致");
  }
  const tags = new Set(cases.flatMap((fixture) => fixture.expected.tags));
  for (const requiredTag of manifest.requiredTags) {
    if (!tags.has(requiredTag))
      throw new Error(`CFG gold corpus 缺少 required tag：${requiredTag}`);
  }
  return Object.freeze({ manifest, cases: Object.freeze(cases) });
}

export function normalizeFunctionCfg(cfg: FunctionCfg, source: string): GoldFunction {
  const nodeKeys = new Map<string, string>();
  const nodes = cfg.nodes.map((node): GoldNode => {
    const range: GoldRange = [node.range.from, node.range.to];
    const ownerRange: GoldRange = [node.ownerBlockRange.from, node.ownerBlockRange.to];
    const key =
      node.id === cfg.entryId
        ? "entry"
        : node.id === cfg.exitId
          ? "exit"
          : goldNodeKey(node.kind, node.nodeType, range);
    if (nodeKeys.has(node.id)) throw new Error(`CFG 节点 id 重复：${node.id}`);
    nodeKeys.set(node.id, key);
    return Object.freeze({
      key,
      kind: node.kind,
      role: node.role,
      ownership: node.ownership,
      nodeType: node.nodeType,
      range,
      ownerRange,
      reachable: node.reachable,
      text: source.slice(node.range.from, node.range.to),
    });
  });
  const edges = cfg.edges.map((edge): GoldEdge => {
    const from = nodeKeys.get(edge.from);
    const to = nodeKeys.get(edge.to);
    if (from === undefined || to === undefined) throw new Error("CFG edge 引用了不存在的节点");
    return Object.freeze({ from, kind: edge.kind, to });
  });
  const partialReasons = cfg.partialReasons.map((reason): GoldPartialReason => {
    const range: GoldRange = [reason.range.from, reason.range.to];
    return Object.freeze({
      code: reason.code,
      nodeType: reason.nodeType,
      range,
      text: source.slice(reason.range.from, reason.range.to),
    });
  });
  const functionRange: GoldRange = [cfg.range.from, cfg.range.to];
  return Object.freeze({
    key: goldFunctionKey(cfg.name, functionRange),
    name: cfg.name,
    range: functionRange,
    partial: cfg.partial,
    partialReasons: sortPartialReasons(partialReasons),
    nodes: sortNodes(nodes),
    edges: sortEdges(edges),
  });
}

export function normalizeAnalysisFindings(
  snapshot: ProgramAnalysisSnapshot,
): readonly GoldFinding[] {
  const cfgById = new Map(snapshot.functions.map((cfg) => [cfg.id, cfg]));
  const findings = snapshot.findings.map((finding): GoldFinding => {
    const cfg = cfgById.get(finding.functionId);
    if (cfg === undefined) throw new Error(`finding 引用了不存在的函数：${finding.functionId}`);
    const owner = cfg.nodes.find((node) => node.id === finding.ownerNodeId);
    if (owner === undefined || owner.ownership !== "primary") {
      throw new Error(`finding owner 不是 primary CFG 节点：${finding.ownerNodeId}`);
    }
    const functionRange: GoldRange = [cfg.range.from, cfg.range.to];
    return Object.freeze({
      function: goldFunctionKey(cfg.name, functionRange),
      ruleId: finding.ruleId,
      reason: finding.reason,
      confidence: finding.confidence,
      primaryRange: Object.freeze([
        finding.primaryRange.from,
        finding.primaryRange.to,
      ]) as GoldRange,
      ownerNode: goldNodeKey(owner.kind, owner.nodeType, [owner.range.from, owner.range.to]),
      subject: finding.subject,
      evidence: Object.freeze(
        finding.evidence.map((evidence) =>
          Object.freeze({
            role: evidence.role,
            range: Object.freeze([evidence.range.from, evidence.range.to]) as GoldRange,
          }),
        ),
      ),
    });
  });
  return Object.freeze(
    [...findings].sort((left, right) =>
      findingIdentity(left).localeCompare(findingIdentity(right)),
    ),
  );
}

export function reachableGoldNodeKeys(functionGold: GoldFunction): ReadonlySet<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of functionGold.edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const reachable = new Set<string>();
  const pending = ["entry"];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || reachable.has(key)) continue;
    reachable.add(key);
    pending.push(...(outgoing.get(key) ?? []));
  }
  return reachable;
}

export function rangeKey(range: GoldRange): string {
  return `${range[0]}:${range[1]}`;
}

function loadCase(root: string, fixtureName: string): CfgGoldCase {
  const directory = `${root}/${fixtureName}`;
  const files = readdirSync(directory).sort();
  assertStringArrayEqual(
    files,
    ["cfg.expected.json", "expected-findings.json", "source.c"],
    `${fixtureName} 文件集合`,
  );
  const sourceBytes = readFileSync(`${directory}/source.c`);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const expected = parseCfgExpected(
    readJson(`${directory}/cfg.expected.json`),
    fixtureName,
    source,
    sourceSha256,
  );
  const expectedFindings = parseFindings(
    readJson(`${directory}/expected-findings.json`),
    fixtureName,
    source,
    sourceSha256,
    expected.functions,
  );
  return Object.freeze({ source, expected, expectedFindings });
}

function parseManifest(value: unknown): CfgGoldManifest {
  const record = exactRecord(
    value,
    ["schemaVersion", "expectedFixtureCount", "expectedFunctionCount", "requiredTags", "fixtures"],
    "manifest",
  );
  if (record.schemaVersion !== 1) throw new TypeError("manifest.schemaVersion 必须为 1");
  const fixtures = uniqueStrings(record.fixtures, "manifest.fixtures");
  const requiredTags = uniqueStrings(record.requiredTags, "manifest.requiredTags");
  return Object.freeze({
    schemaVersion: 1,
    expectedFixtureCount: safeInteger(record.expectedFixtureCount, "manifest.expectedFixtureCount"),
    expectedFunctionCount: safeInteger(
      record.expectedFunctionCount,
      "manifest.expectedFunctionCount",
    ),
    requiredTags,
    fixtures,
  });
}

function parseCfgExpected(
  value: unknown,
  fixtureName: string,
  source: string,
  sourceSha256: string,
): CfgGoldExpected {
  const path = `${fixtureName}.cfg`;
  const record = exactRecord(
    value,
    ["schemaVersion", "caseId", "sourceSha256", "sourceLengthUtf16", "tags", "functions"],
    path,
  );
  if (record.schemaVersion !== 1) throw new TypeError(`${path}.schemaVersion 必须为 1`);
  const caseId = nonEmptyString(record.caseId, `${path}.caseId`);
  if (caseId !== fixtureName) throw new TypeError(`${path}.caseId 必须等于目录名`);
  const pinnedHash = sha256(record.sourceSha256, `${path}.sourceSha256`);
  if (pinnedHash !== sourceSha256) throw new TypeError(`${path}.sourceSha256 与 source.c 不一致`);
  const sourceLengthUtf16 = safeInteger(record.sourceLengthUtf16, `${path}.sourceLengthUtf16`);
  if (sourceLengthUtf16 !== source.length) throw new TypeError(`${path}.sourceLengthUtf16 不一致`);
  const tags = uniqueStrings(record.tags, `${path}.tags`);
  if (tags.length === 0) throw new TypeError(`${path}.tags 不得为空`);
  const functions = unknownArray(record.functions, `${path}.functions`).map((entry, index) =>
    parseFunction(entry, `${path}.functions[${index}]`, source),
  );
  if (functions.length === 0) throw new TypeError(`${path}.functions 不得为空`);
  ensureUnique(
    functions.map((entry) => entry.key),
    `${path} function key`,
  );
  return Object.freeze({
    schemaVersion: 1,
    caseId,
    sourceSha256: pinnedHash,
    sourceLengthUtf16,
    tags,
    functions: Object.freeze([...functions].sort(compareFunction)),
  });
}

function parseFunction(value: unknown, path: string, source: string): GoldFunction {
  const record = exactRecord(
    value,
    ["key", "name", "range", "partial", "partialReasons", "nodes", "edges"],
    path,
  );
  const name = nonEmptyString(record.name, `${path}.name`);
  const range = sourceRange(record.range, `${path}.range`, source);
  const key = nonEmptyString(record.key, `${path}.key`);
  if (key !== goldFunctionKey(name, range)) throw new TypeError(`${path}.key 与 name/range 不一致`);
  if (typeof record.partial !== "boolean") throw new TypeError(`${path}.partial 必须是 boolean`);
  const partialReasons = unknownArray(record.partialReasons, `${path}.partialReasons`).map(
    (entry, index) => parsePartialReason(entry, `${path}.partialReasons[${index}]`, source, range),
  );
  if (record.partial !== partialReasons.length > 0) {
    throw new TypeError(`${path}.partial 与 partialReasons 不一致`);
  }
  const nodes = unknownArray(record.nodes, `${path}.nodes`).map((entry, index) =>
    parseNode(entry, `${path}.nodes[${index}]`, source, range),
  );
  ensureUnique(
    nodes.map((node) => node.key),
    `${path} node key`,
  );
  const nodeKeys = new Set(nodes.map((node) => node.key));
  if (!nodeKeys.has("entry") || !nodeKeys.has("exit")) {
    throw new TypeError(`${path}.nodes 必须包含 entry 与 exit`);
  }
  const edges = unknownArray(record.edges, `${path}.edges`).map((entry, index) =>
    parseEdge(entry, `${path}.edges[${index}]`),
  );
  ensureUnique(edges.map(edgeIdentity), `${path} edge`);
  for (const edge of edges) {
    if (!nodeKeys.has(edge.from) || !nodeKeys.has(edge.to)) {
      throw new TypeError(`${path}.edges 引用了不存在的节点`);
    }
    if (edge.from === "exit") throw new TypeError(`${path}.edges 不得从 exit 发出`);
  }
  const primaryOwners = nodes
    .filter((node) => node.ownership === "primary")
    .map((node) => rangeKey(node.ownerRange));
  ensureUnique(primaryOwners, `${path} primary ownerRange`);
  const primaryOwnerSet = new Set(primaryOwners);
  for (const node of nodes.filter((candidate) => candidate.ownership === "auxiliary")) {
    if (!primaryOwnerSet.has(rangeKey(node.ownerRange))) {
      throw new TypeError(`${path}: auxiliary 节点必须映射到一个 primary ownerRange`);
    }
  }
  const normalized = Object.freeze({
    key,
    name,
    range,
    partial: record.partial,
    partialReasons: sortPartialReasons(partialReasons),
    nodes: sortNodes(nodes),
    edges: sortEdges(edges),
  });
  const reachable = reachableGoldNodeKeys(normalized);
  if (nodes.some((node) => node.reachable !== reachable.has(node.key))) {
    throw new TypeError(`${path}: reachable 与金标边集的独立 BFS 不一致`);
  }
  return normalized;
}

function parseNode(
  value: unknown,
  path: string,
  source: string,
  functionRange: GoldRange,
): GoldNode {
  const record = exactRecord(
    value,
    ["key", "kind", "role", "ownership", "nodeType", "range", "ownerRange", "reachable", "text"],
    path,
  );
  const kind = enumString(record.kind, NODE_KINDS, `${path}.kind`);
  const role = enumString(record.role, NODE_ROLES, `${path}.role`);
  const ownership = enumString(record.ownership, OWNERSHIP_KINDS, `${path}.ownership`);
  const nodeType = nullableString(record.nodeType, `${path}.nodeType`);
  const range = nestedSourceRange(record.range, `${path}.range`, source, functionRange);
  const ownerRange = nestedSourceRange(
    record.ownerRange,
    `${path}.ownerRange`,
    source,
    functionRange,
  );
  if (typeof record.reachable !== "boolean")
    throw new TypeError(`${path}.reachable 必须是 boolean`);
  const text = stringValue(record.text, `${path}.text`);
  if (text !== source.slice(range[0], range[1]))
    throw new TypeError(`${path}.text 与 range 原文不一致`);
  const key = nonEmptyString(record.key, `${path}.key`);
  const boundaryKey = kind === "entry" ? "entry" : kind === "exit" ? "exit" : null;
  const expectedKey = boundaryKey ?? goldNodeKey(kind, nodeType, range);
  if (key !== expectedKey) throw new TypeError(`${path}.key 与 kind/nodeType/range 不一致`);
  if (boundaryKey !== null) {
    if (
      ownership !== "boundary" ||
      role !== "boundary" ||
      nodeType !== "function_definition" ||
      rangeKey(range) !== rangeKey(functionRange) ||
      rangeKey(ownerRange) !== rangeKey(functionRange)
    ) {
      throw new TypeError(`${path}: entry/exit 必须覆盖函数范围并声明 boundary`);
    }
  } else if (kind === "syntax") {
    if (
      (role !== "statement" && role !== "declaration") ||
      ownership !== "primary" ||
      nodeType === null ||
      rangeKey(ownerRange) !== rangeKey(range)
    ) {
      throw new TypeError(`${path}: syntax 必须是拥有自身 range 的 primary 语句或声明`);
    }
  } else if (kind === "control") {
    const expectedOwnership =
      nodeType === "do_condition"
        ? "primary"
        : nodeType === "for_initializer" || nodeType === "for_update"
          ? "auxiliary"
          : null;
    if (
      role !== "control" ||
      ownership !== expectedOwnership ||
      !containsGoldRange(ownerRange, range)
    ) {
      throw new TypeError(`${path}: control 的类型、ownership 或 ownerRange 非法`);
    }
  } else {
    throw new TypeError(`${path}: 非法的非边界 kind`);
  }
  return Object.freeze({
    key,
    kind,
    role,
    ownership,
    nodeType,
    range,
    ownerRange,
    reachable: record.reachable,
    text,
  });
}

function parseEdge(value: unknown, path: string): GoldEdge {
  const record = exactRecord(value, ["from", "kind", "to"], path);
  return Object.freeze({
    from: nonEmptyString(record.from, `${path}.from`),
    kind: enumString(record.kind, EDGE_KINDS, `${path}.kind`),
    to: nonEmptyString(record.to, `${path}.to`),
  });
}

function parsePartialReason(
  value: unknown,
  path: string,
  source: string,
  functionRange: GoldRange,
): GoldPartialReason {
  const record = exactRecord(value, ["code", "nodeType", "range", "text"], path);
  const range = nestedSourceRange(record.range, `${path}.range`, source, functionRange);
  const text = stringValue(record.text, `${path}.text`);
  if (text !== source.slice(range[0], range[1]))
    throw new TypeError(`${path}.text 与 range 原文不一致`);
  return Object.freeze({
    code: enumString(record.code, PARTIAL_CODES, `${path}.code`),
    nodeType: nonEmptyString(record.nodeType, `${path}.nodeType`),
    range,
    text,
  });
}

function parseFindings(
  value: unknown,
  fixtureName: string,
  source: string,
  sourceSha256: string,
  functions: readonly GoldFunction[],
): FindingsGold {
  const path = `${fixtureName}.findings`;
  const record = exactRecord(value, ["schemaVersion", "sourceSha256", "findings"], path);
  if (record.schemaVersion !== 2) throw new TypeError(`${path}.schemaVersion 必须为 2`);
  const pinnedHash = sha256(record.sourceSha256, `${path}.sourceSha256`);
  if (pinnedHash !== sourceSha256) throw new TypeError(`${path}.sourceSha256 与 source.c 不一致`);
  const functionMap = new Map(functions.map((entry) => [entry.key, entry]));
  const findings = unknownArray(record.findings, `${path}.findings`).map((entry, index) =>
    parseFinding(entry, `${path}.findings[${index}]`, source, functionMap),
  );
  ensureUnique(findings.map(findingIdentity), `${path} finding`);
  return Object.freeze({
    schemaVersion: 2,
    sourceSha256: pinnedHash,
    findings: Object.freeze(
      [...findings].sort((left, right) =>
        findingIdentity(left).localeCompare(findingIdentity(right)),
      ),
    ),
  });
}

function parseFinding(
  value: unknown,
  path: string,
  source: string,
  functions: ReadonlyMap<string, GoldFunction>,
): GoldFinding {
  const record = exactRecord(
    value,
    [
      "function",
      "ruleId",
      "reason",
      "confidence",
      "primaryRange",
      "ownerNode",
      "subject",
      "evidence",
    ],
    path,
  );
  const functionKey = nonEmptyString(record.function, `${path}.function`);
  const functionGold = functions.get(functionKey);
  if (functionGold === undefined) throw new TypeError(`${path}.function 不存在`);
  const primaryRange = nestedSourceRange(
    record.primaryRange,
    `${path}.primaryRange`,
    source,
    functionGold.range,
  );
  const ownerNode = nonEmptyString(record.ownerNode, `${path}.ownerNode`);
  const owner = functionGold.nodes.find((node) => node.key === ownerNode);
  if (owner === undefined || owner.ownership !== "primary") {
    throw new TypeError(`${path}.ownerNode 必须是 primary 节点`);
  }
  if (!containsGoldRange(owner.ownerRange, primaryRange)) {
    throw new TypeError(`${path}.primaryRange 必须落在 ownerNode.ownerRange 内`);
  }
  const evidence = unknownArray(record.evidence, `${path}.evidence`).map((entry, index) => {
    const evidenceRecord = exactRecord(entry, ["role", "range"], `${path}.evidence[${index}]`);
    return Object.freeze({
      role: enumString(evidenceRecord.role, EVIDENCE_ROLES, `${path}.evidence[${index}].role`),
      range: nestedSourceRange(
        evidenceRecord.range,
        `${path}.evidence[${index}].range`,
        source,
        functionGold.range,
      ),
    });
  });
  if (evidence.length === 0) throw new TypeError(`${path}.evidence 不得为空`);
  ensureUnique(
    evidence.map((entry) => `${entry.role}\u0000${rangeKey(entry.range)}`),
    `${path}.evidence`,
  );
  return Object.freeze({
    function: functionKey,
    ruleId: enumString(record.ruleId, FINDING_RULE_IDS, `${path}.ruleId`),
    reason: enumString(record.reason, FINDING_REASONS, `${path}.reason`),
    confidence: enumString(record.confidence, FINDING_CONFIDENCE, `${path}.confidence`),
    primaryRange,
    ownerNode,
    subject: nullableString(record.subject, `${path}.subject`),
    evidence: Object.freeze(evidence),
  });
}

function goldFunctionKey(name: string, range: GoldRange): string {
  return `fn:${name}:${range[0]}:${range[1]}`;
}

function goldNodeKey(kind: CfgNodeKind, nodeType: string | null, range: GoldRange): string {
  return `n:${kind}:${nodeType ?? "null"}:${range[0]}:${range[1]}`;
}

function sortNodes(nodes: readonly GoldNode[]): readonly GoldNode[] {
  return Object.freeze([...nodes].sort((left, right) => left.key.localeCompare(right.key)));
}

function sortEdges(edges: readonly GoldEdge[]): readonly GoldEdge[] {
  return Object.freeze(
    [...edges].sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right))),
  );
}

function sortPartialReasons(reasons: readonly GoldPartialReason[]): readonly GoldPartialReason[] {
  return Object.freeze(
    [...reasons].sort((left, right) =>
      `${left.code}\u0000${left.nodeType}\u0000${rangeKey(left.range)}`.localeCompare(
        `${right.code}\u0000${right.nodeType}\u0000${rangeKey(right.range)}`,
      ),
    ),
  );
}

function edgeIdentity(edge: GoldEdge): string {
  return `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
}

function findingIdentity(finding: GoldFinding): string {
  return `${finding.function}\u0000${finding.ruleId}\u0000${finding.reason}\u0000${finding.confidence}\u0000${rangeKey(finding.primaryRange)}\u0000${finding.subject ?? ""}`;
}

function compareFunction(left: GoldFunction, right: GoldFunction): number {
  return (
    left.range[0] - right.range[0] ||
    left.range[1] - right.range[1] ||
    left.name.localeCompare(right.name)
  );
}

function sourceRange(value: unknown, path: string, source: string): GoldRange {
  const range = parseRange(value, path);
  if (range[1] > source.length) throw new RangeError(`${path} 超出源码`);
  return range;
}

function nestedSourceRange(
  value: unknown,
  path: string,
  source: string,
  parent: GoldRange,
): GoldRange {
  const range = sourceRange(value, path, source);
  if (range[0] < parent[0] || range[1] > parent[1]) throw new RangeError(`${path} 超出函数范围`);
  return range;
}

function containsGoldRange(parent: GoldRange, child: GoldRange): boolean {
  return child[0] >= parent[0] && child[1] <= parent[1];
}

function parseRange(value: unknown, path: string): GoldRange {
  const entries = unknownArray(value, path);
  if (entries.length !== 2) throw new TypeError(`${path} 必须是 [from, to]`);
  const from = safeInteger(entries[0], `${path}[0]`);
  const to = safeInteger(entries[1], `${path}[1]`);
  if (from < 0 || to <= from) throw new RangeError(`${path} 必须是非空 UTF-16 半开区间`);
  return Object.freeze([from, to]);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  assertStringArrayEqual(Object.keys(record).sort(), [...keys].sort(), `${path} keys`);
  return record;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function unknownArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`);
  return value;
}

function uniqueStrings(value: unknown, path: string): readonly string[] {
  const strings = unknownArray(value, path).map((entry, index) =>
    nonEmptyString(entry, `${path}[${index}]`),
  );
  ensureUnique(strings, path);
  return Object.freeze(strings);
}

function ensureUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${path} 包含重复项`);
}

function enumString<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  const candidate = nonEmptyString(value, path);
  if (!values.has(candidate as T)) throw new TypeError(`${path} 值非法：${candidate}`);
  return candidate as T;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} 必须是字符串`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (result.length === 0) throw new TypeError(`${path} 不得为空`);
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, path);
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${path} 必须是安全整数`);
  return value as number;
}

function sha256(value: unknown, path: string): string {
  const hash = nonEmptyString(value, path);
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new TypeError(`${path} 必须是小写 SHA-256`);
  return hash;
}

function assertStringArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new TypeError(`${path} 不一致：${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
