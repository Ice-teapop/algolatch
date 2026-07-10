import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTextPatches,
  assertSourceDocInvariants,
  planM3bEdit,
  projectionShape,
  rebuildFromCoverage,
  renderSourceDoc,
  type Block,
  type CParser,
  type StatementEditTarget,
} from "../../src/core/index.js";
import { courseCProgramArbitrary, type GeneratedCourseProgram } from "./course-c-generator.js";
import { createTestParser } from "./parser-fixture.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const configuredRuns = readPositiveInteger("M4_GENERATOR_RUNS", 500);
const configuredSeed = readSafeInteger("M4_GENERATOR_SEED", 0x4c0de);
const shouldWriteRegression = process.env.M4_GENERATOR_WRITE_REGRESSION === "cli-deep-run";
const configuredTimeoutMs = Math.min(600_000, Math.max(5_000, configuredRuns * 5));
const sourceByteLimit = 512 * 1024;

let parser: CParser;

beforeAll(async () => {
  parser = await createTestParser();
});

afterAll(() => {
  parser.dispose();
});

describe("M4 generated course-C fuzz", () => {
  it("emits both for-bearing and straight-line programs", () => {
    const sample = fc.sample(courseCProgramArbitrary, { numRuns: 64, seed: 0x4f04 });

    expect(sample.some((program) => program.features.hasFor)).toBe(true);
    expect(sample.some((program) => !program.features.hasFor)).toBe(true);
  });

  it(
    `preserves projection and M3b edit invariants (${configuredRuns} runs, seed ${configuredSeed})`,
    () => {
      const property = fc.property(courseCProgramArbitrary, (program) => {
        verifyGeneratedProgram(program);
      });
      const result = fc.check(property, {
        numRuns: configuredRuns,
        seed: configuredSeed,
        endOnFailure: false,
        verbose: 2,
      });

      const counterexample = result.counterexample?.[0] as GeneratedCourseProgram | undefined;
      const regressionPath =
        result.failed && shouldWriteRegression && counterexample !== undefined
          ? writeRegression(counterexample, result.counterexamplePath)
          : null;
      const cause =
        result.errorInstance instanceof Error
          ? result.errorInstance.message
          : String(result.errorInstance ?? "fast-check failed");
      const failure = [
        cause,
        `seed=${String(configuredSeed)}`,
        `path=${result.counterexamplePath ?? "<none>"}`,
        regressionPath === null ? null : `regression=${regressionPath}`,
      ]
        .filter((part) => part !== null)
        .join("; ");

      expect(result.failed, failure).toBe(false);
    },
    configuredTimeoutMs,
  );
});

function verifyGeneratedProgram(program: GeneratedCourseProgram): void {
  validateGeneratedSource(program.source);
  const revision = program.source.length;
  const analysis = parser.analyze(program.source, revision);
  const document = analysis.document;
  const rendered = renderSourceDoc(document);

  assertSourceDocInvariants(document);
  expect(document.parse.hasError).toBe(false);
  expect(document.parse.errorRanges).toEqual([]);
  expect(document.parse.missingOffsets).toEqual([]);
  expect(rebuildFromCoverage(document)).toBe(program.source);
  expect(rendered).toBe(program.source);
  expect(projectionShape(parser.project(rendered))).toEqual(projectionShape(document));

  if (program.features.hasFor) {
    expect(
      flattenBlocks(document.blocks).some(
        (block) => block.kind === "syntax" && block.nodeType === "for_statement",
      ),
    ).toBe(true);
  }

  const target = requireReturnTarget(program.source, analysis.statementEdits.statements);
  const plan = planM3bEdit(
    {
      source: program.source,
      analysis,
      analyzer: parser,
      validateSource: validateGeneratedSource,
    },
    {
      kind: "insert-statement",
      baseRevision: revision,
      targetId: target.id,
      expectedTargetText: program.source.slice(target.range.from, target.range.to),
      position: "before",
      statementText: "total += 0;",
    },
  );

  expect(plan.patches.length).toBeGreaterThan(0);
  for (const patch of plan.patches) {
    expect(patch.range.from).toBeGreaterThanOrEqual(target.extendedRange.from);
    expect(patch.range.to).toBeLessThanOrEqual(target.extendedRange.to);
  }
  assertOutsidePatchesUnchanged(program.source, plan.candidateSource, plan.patches);
  expect(plan.candidateAnalysis.document.parse.hasError).toBe(false);
  expect(plan.candidateAnalysis.document.parse.errorRanges).toEqual([]);
  expect(plan.candidateAnalysis.document.parse.missingOffsets).toEqual([]);
  expect(renderSourceDoc(plan.candidateAnalysis.document)).toBe(plan.candidateSource);
  expect(applyTextPatches(plan.candidateSource, plan.inversePatches).source).toBe(program.source);
}

function requireReturnTarget(
  source: string,
  targets: readonly StatementEditTarget[],
): StatementEditTarget {
  const matches = targets.filter(
    (target) =>
      target.nodeType === "return_statement" &&
      target.parentMode === "statement-list" &&
      target.blocker === null &&
      source.slice(target.range.from, target.range.to) === "return total + value;",
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`生成源码缺少唯一可编辑 return，实际 ${String(matches.length)}`);
  }
  return matches[0];
}

function flattenBlocks(blocks: readonly Block[]): readonly Block[] {
  const flattened: Block[] = [];
  const stack = [...blocks].reverse();
  while (stack.length > 0) {
    const block = stack.pop();
    if (block === undefined) continue;
    flattened.push(block);
    stack.push(...[...block.children].reverse());
  }
  return flattened;
}

function assertOutsidePatchesUnchanged(
  source: string,
  candidate: string,
  patches: readonly {
    readonly range: { readonly from: number; readonly to: number };
    readonly newText: string;
  }[],
): void {
  let sourceCursor = 0;
  let candidateCursor = 0;
  for (const patch of patches) {
    const unchanged = source.slice(sourceCursor, patch.range.from);
    expect(candidate.slice(candidateCursor, candidateCursor + unchanged.length)).toBe(unchanged);
    sourceCursor = patch.range.to;
    candidateCursor += unchanged.length + patch.newText.length;
  }
  expect(candidate.slice(candidateCursor)).toBe(source.slice(sourceCursor));
}

function validateGeneratedSource(source: string): void {
  if (source.includes("\0")) throw new Error("生成源码含 NUL");
  if (new TextEncoder().encode(source).length > sourceByteLimit) {
    throw new Error("生成源码超过 512 KiB");
  }
}

function writeRegression(
  program: GeneratedCourseProgram,
  counterexamplePath: string | null,
): string {
  const digest = createHash("sha256").update(program.source).digest("hex").slice(0, 12);
  const directory = resolve(projectRoot, "corpus/regressions");
  const baseName = `m4-gen-${digest}`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${baseName}.c`), program.source, "utf8");
  writeFileSync(
    resolve(directory, `${baseName}.json`),
    `${JSON.stringify(
      {
        kind: "course-c-generator",
        seed: configuredSeed,
        path: counterexamplePath,
        features: program.features,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return `corpus/regressions/${baseName}.c`;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name} 必须是 1 到 100000 的安全整数`);
  }
  return value;
}

function readSafeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`${name} 必须是 32 位安全整数`);
  }
  return value;
}
