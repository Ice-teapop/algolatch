import type {
  AnalysisFinding,
  AnalysisFindingEvidence,
  AnalysisFindingReason,
  AnalysisFindingRuleId,
  CfgNode,
  DefUseDefinitionEffect,
  DefUseUseEffect,
  DefUseVariable,
  FunctionCfg,
  FunctionDefUse,
  ReachingDefinitionUse,
} from "./model.js";

export interface FunctionFindingsInput {
  readonly cfg: FunctionCfg;
  readonly defUse: FunctionDefUse;
}

export function collectFunctionFindings(input: FunctionFindingsInput): readonly AnalysisFinding[] {
  if (input.cfg.partial || input.defUse.status !== "complete") return Object.freeze([]);

  const nodesById = new Map(input.cfg.nodes.map((node) => [node.id, node]));
  const variablesById = new Map(input.defUse.variables.map((variable) => [variable.id, variable]));
  const definitionsById = new Map<string, DefUseDefinitionEffect>();
  for (const fact of input.defUse.facts) {
    for (const effect of fact.effects) {
      if (effect.kind === "def") definitionsById.set(effect.id, effect);
    }
  }

  const findings = [
    ...collectUnreachableFindings(input.cfg),
    ...collectUninitializedReadFindings(input, nodesById, variablesById, definitionsById),
    ...collectLiteralOutOfBoundsFindings(input, nodesById, variablesById),
  ].sort(compareFindings);
  return Object.freeze(findings);
}

function collectLiteralOutOfBoundsFindings(
  input: FunctionFindingsInput,
  nodesById: ReadonlyMap<string, CfgNode>,
  variablesById: ReadonlyMap<string, DefUseVariable>,
): readonly AnalysisFinding[] {
  const shapesByVariableId = new Map(
    input.defUse.arrayShapes.map((shape) => [shape.variableId, shape]),
  );
  const findings: AnalysisFinding[] = [];
  for (const access of input.defUse.arrayAccesses) {
    if (access.execution !== "always") continue;
    const node = nodesById.get(access.nodeId);
    const shape = shapesByVariableId.get(access.variableId);
    const variable = variablesById.get(access.variableId);
    const index = access.indices[0];
    const dimension = shape?.dimensions[0];
    if (
      node === undefined ||
      !node.reachable ||
      shape === undefined ||
      variable === undefined ||
      index === undefined ||
      dimension === undefined ||
      index.literalIndex === null
    ) {
      continue;
    }
    const owner = primaryOwner(input.cfg, node);
    if (owner === null) continue;
    const negative = index.literalIndex < 0;
    const upperViolation =
      access.mode === "address"
        ? index.literalIndex > dimension.extent
        : index.literalIndex >= dimension.extent;
    if (!negative && !upperViolation) continue;
    findings.push(
      freezeFinding({
        functionId: input.cfg.id,
        ruleId: "literal-out-of-bounds",
        reason: negative ? "negative-literal-index" : "literal-index-not-less-than-extent",
        primaryRange: index.indexRange,
        ownerNodeId: owner.id,
        subject: variable.name,
        subjectVariableId: variable.id,
        evidence: [
          { role: "bound", range: dimension.extentRange },
          { role: "index", range: index.indexRange },
        ],
      }),
    );
  }
  return findings;
}

function collectUnreachableFindings(cfg: FunctionCfg): readonly AnalysisFinding[] {
  const unreachable = cfg.nodes
    .filter((node) => node.ownership === "primary" && !node.reachable)
    .map((node) => ({ node, range: unreachableCoverage(cfg, node) }))
    .filter(
      (entry): entry is { readonly node: CfgNode; readonly range: CfgNode["range"] } =>
        entry.range !== null,
    );
  const outermost = unreachable.filter(
    (entry) =>
      !unreachable.some(
        (candidate) =>
          candidate.node.id !== entry.node.id && strictlyContains(candidate.range, entry.range),
      ),
  );
  const unique = outermost.filter(
    (entry, index) =>
      outermost.findIndex((candidate) => sameRange(candidate.range, entry.range)) === index,
  );
  return unique.map(({ node, range }) =>
    freezeFinding({
      functionId: cfg.id,
      ruleId: "unreachable-code",
      reason: "no-entry-path",
      primaryRange: range,
      ownerNodeId: node.id,
      subject: null,
      subjectVariableId: null,
      evidence: [{ role: "unreachable", range }],
    }),
  );
}

function unreachableCoverage(cfg: FunctionCfg, node: CfgNode): CfgNode["range"] | null {
  if (sameRange(node.range, node.ownerBlockRange)) {
    const hasReachableOwnedPhase = cfg.nodes.some(
      (candidate) =>
        candidate.id !== node.id &&
        candidate.ownership !== "boundary" &&
        candidate.reachable &&
        containsRange(node.ownerBlockRange, candidate.range),
    );
    return hasReachableOwnedPhase ? null : node.range;
  }
  const ownedPrimaryNodes = cfg.nodes.filter(
    (candidate) =>
      candidate.ownership === "primary" && containsRange(node.ownerBlockRange, candidate.range),
  );
  return ownedPrimaryNodes.length > 0 &&
    ownedPrimaryNodes.every((candidate) => !candidate.reachable)
    ? node.ownerBlockRange
    : node.range;
}

function collectUninitializedReadFindings(
  input: FunctionFindingsInput,
  nodesById: ReadonlyMap<string, CfgNode>,
  variablesById: ReadonlyMap<string, DefUseVariable>,
  definitionsById: ReadonlyMap<string, DefUseDefinitionEffect>,
): readonly AnalysisFinding[] {
  const flowByNodeId = new Map(input.defUse.reachingDefinitions.map((flow) => [flow.nodeId, flow]));
  const findings: AnalysisFinding[] = [];

  for (const fact of input.defUse.facts) {
    const node = nodesById.get(fact.nodeId);
    const flow = flowByNodeId.get(fact.nodeId);
    if (node === undefined || flow === undefined || !node.reachable) continue;
    const owner = primaryOwner(input.cfg, node);
    if (owner === null) continue;

    for (const [effectIndex, effect] of fact.effects.entries()) {
      if (effect.kind !== "use" || effect.execution !== "always") continue;
      const variable = variablesById.get(effect.variableId);
      if (!isCleanLocalScalar(variable)) continue;
      const resolution = flow.uses.find((use) => use.useEffectId === effect.id);
      if (resolution === undefined || resolution.availability !== "tracked") continue;
      const uninitialized = uninitializedEvidence(
        fact.effects,
        effectIndex,
        effect,
        resolution,
        definitionsById,
      );
      if (uninitialized === null) continue;

      findings.push(
        freezeFinding({
          functionId: input.cfg.id,
          ruleId: "uninitialized-read",
          reason: uninitialized.reason,
          primaryRange: effect.range,
          ownerNodeId: owner.id,
          subject: variable.name,
          subjectVariableId: variable.id,
          evidence: [
            ...uninitialized.definitions.map((definition) => ({
              role: "definition" as const,
              range: definition.range,
            })),
            { role: "use", range: effect.range },
          ],
        }),
      );
    }
  }
  return findings;
}

function uninitializedEvidence(
  effects: FunctionDefUse["facts"][number]["effects"],
  useIndex: number,
  use: DefUseUseEffect,
  resolution: ReachingDefinitionUse,
  definitionsById: ReadonlyMap<string, DefUseDefinitionEffect>,
): {
  readonly reason: Extract<
    AnalysisFindingReason,
    "all-reaching-definitions-uninitialized" | "no-reaching-definition"
  >;
  readonly definitions: readonly DefUseDefinitionEffect[];
} | null {
  const reaching = resolution.definitionEffectIds.map((id) => definitionsById.get(id));
  if (reaching.some((definition) => definition === undefined)) return null;
  const definitions = reaching.filter(
    (definition): definition is DefUseDefinitionEffect => definition !== undefined,
  );
  if (definitions.length > 0) {
    return definitions.every((definition) => definition.valueState === "uninitialized")
      ? { reason: "all-reaching-definitions-uninitialized", definitions }
      : null;
  }

  const selfDeclaration = effects
    .slice(useIndex + 1)
    .find(
      (effect): effect is DefUseDefinitionEffect =>
        effect.kind === "def" &&
        effect.variableId === use.variableId &&
        effect.origin === "declaration" &&
        effect.strength === "strong",
    );
  return selfDeclaration === undefined
    ? null
    : { reason: "no-reaching-definition", definitions: [selfDeclaration] };
}

function isCleanLocalScalar(variable: DefUseVariable | undefined): variable is DefUseVariable {
  return (
    variable !== undefined &&
    variable.kind === "local" &&
    variable.storage === "scalar" &&
    variable.tracking === "precise"
  );
}

function primaryOwner(cfg: FunctionCfg, node: CfgNode): CfgNode | null {
  if (node.ownership === "primary") return node;
  if (node.ownership !== "auxiliary") return null;
  return (
    cfg.nodes.find(
      (candidate) =>
        candidate.ownership === "primary" && sameRange(candidate.range, node.ownerBlockRange),
    ) ?? null
  );
}

function freezeFinding(input: {
  readonly functionId: string;
  readonly ruleId: AnalysisFindingRuleId;
  readonly reason: AnalysisFindingReason;
  readonly primaryRange: AnalysisFinding["primaryRange"];
  readonly ownerNodeId: string;
  readonly subject: string | null;
  readonly subjectVariableId: string | null;
  readonly evidence: readonly AnalysisFindingEvidence[];
}): AnalysisFinding {
  const subjectKey = input.subjectVariableId ?? input.subject ?? "none";
  return Object.freeze({
    id: `finding:${input.ruleId}:${input.reason}:${String(input.primaryRange.from)}:${String(input.primaryRange.to)}:${subjectKey}`,
    functionId: input.functionId,
    ruleId: input.ruleId,
    reason: input.reason,
    confidence: "certain",
    primaryRange: Object.freeze({ ...input.primaryRange }),
    ownerNodeId: input.ownerNodeId,
    subject: input.subject,
    subjectVariableId: input.subjectVariableId,
    evidence: Object.freeze(
      input.evidence.map((evidence) =>
        Object.freeze({ role: evidence.role, range: Object.freeze({ ...evidence.range }) }),
      ),
    ),
  });
}

function compareFindings(left: AnalysisFinding, right: AnalysisFinding): number {
  return (
    left.primaryRange.from - right.primaryRange.from ||
    left.primaryRange.to - right.primaryRange.to ||
    left.ruleId.localeCompare(right.ruleId) ||
    (left.subject ?? "").localeCompare(right.subject ?? "")
  );
}

function strictlyContains(parent: CfgNode["range"], child: CfgNode["range"]): boolean {
  return (
    child.from >= parent.from &&
    child.to <= parent.to &&
    (child.from !== parent.from || child.to !== parent.to)
  );
}

function containsRange(parent: CfgNode["range"], child: CfgNode["range"]): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function sameRange(left: CfgNode["range"], right: CfgNode["range"]): boolean {
  return left.from === right.from && left.to === right.to;
}
