import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSampleVerificationRunner } from "../../electron/main/runner/verification.js";
import type { SampleVerificationRunner } from "../../electron/main/runner/verification.js";
import { applyTextPatches } from "../../src/core/editing/patch.js";
import {
  LocalRenameError,
  planConservativeLocalRename,
  type ConservativeLocalRenamePlan,
  type LocalRenameErrorCode,
} from "../../src/core/editing/rename.js";
import { projectCst } from "../../src/core/projector.js";
import type { FixtureInput, RunResult } from "../../src/shared/api.js";
import { TEST_PARSER_ASSETS } from "./parser-fixture.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const samplesRoot = resolve(projectRoot, "samples");
const MINIMUM_GOLD_SAMPLES = 20;
const TEST_TIMEOUT_MS = 10 * 60_000;

// A sample belongs here only when every local-variable symbol is deliberately
// rejected by the conservative planner. Keeping this explicit means a new
// sample can never become an implicit edit-equiv skip.
const ZERO_EXECUTABLE_TARGET_ALLOWLIST = Object.freeze(new Set<string>([]));

interface GoldTestCase {
  readonly id: string;
  readonly stdin: Uint8Array;
}

interface GoldSample {
  readonly name: string;
  readonly source: string;
  readonly args: readonly string[];
  readonly fixtures: readonly FixtureInput[];
  readonly writableFiles: readonly string[];
  readonly tests: readonly GoldTestCase[];
}

interface AcceptedRename {
  readonly targetLabel: string;
  readonly newName: string;
  readonly candidate: string;
}

interface RejectedRename {
  readonly targetLabel: string;
  readonly code: LocalRenameErrorCode;
}

interface SampleRenameMatrix {
  readonly sample: GoldSample;
  readonly localTargetCount: number;
  readonly accepted: readonly AcceptedRename[];
  readonly rejected: readonly RejectedRename[];
}

const matrixRows: string[] = [];
let parser: Parser;
let wallTimeRecoveryCount = 0;

beforeAll(async () => {
  await Parser.init({ locateFile: () => TEST_PARSER_ASSETS.runtimeWasmUrl });
  const language = await Language.load(TEST_PARSER_ASSETS.languageWasm);
  parser = new Parser();
  parser.setLanguage(language);
});

afterAll(() => {
  parser.delete();
  if (matrixRows.length > 0) {
    console.log(
      [
        "",
        "M3 rename edit-equiv matrix",
        ...matrixRows,
        `bounded wall-time recoveries=${String(wallTimeRecoveryCount)}`,
      ].join("\n"),
    );
  }
});

describe("M3 conservative rename edit equivalence", () => {
  it(
    "enumerates every gold-corpus local target and preserves plain-run behavior byte-for-byte",
    async () => {
      const samples = await loadGoldCorpus();
      expect(samples.length).toBeGreaterThanOrEqual(MINIMUM_GOLD_SAMPLES);

      const matrices = samples.map((sample, sampleIndex) =>
        enumerateSampleRenames(sample, sampleIndex),
      );
      const actualZeroTargetSamples = matrices
        .filter((entry) => entry.accepted.length === 0)
        .map((entry) => entry.sample.name)
        .sort();
      expect(actualZeroTargetSamples).toEqual([...ZERO_EXECUTABLE_TARGET_ALLOWLIST].sort());

      for (const entry of matrices) {
        await verifySampleEquivalence(entry);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

function enumerateSampleRenames(sample: GoldSample, sampleIndex: number): SampleRenameMatrix {
  const tree = requireTree(sample.source, `${sample.name} original`);
  try {
    assertNoRecoveryNodes(tree.rootNode, `${sample.name} original`);
    const document = projectCst(sample.source, tree.rootNode);
    const localTargets = document.symbols.symbols
      .filter((symbol) => symbol.kind === "local-variable")
      .sort(
        (left, right) =>
          (left.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) -
            (right.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
    const accepted: AcceptedRename[] = [];
    const rejected: RejectedRename[] = [];

    for (const [targetIndex, target] of localTargets.entries()) {
      const targetLabel = `${target.name}@${String(target.declarationRanges[0]?.from ?? "?")}`;
      const planned = planWithCollisionFreeName(
        sample.source,
        tree.rootNode,
        document,
        target.id,
        target.name,
        sampleIndex,
        targetIndex,
      );
      if (planned instanceof LocalRenameError) {
        rejected.push(Object.freeze({ targetLabel, code: planned.code }));
        continue;
      }

      const candidate = applyTextPatches(sample.source, planned.patches).source;
      const candidateTree = requireTree(candidate, `${sample.name} ${targetLabel}`);
      try {
        assertNoRecoveryNodes(candidateTree.rootNode, `${sample.name} ${targetLabel}`);
      } finally {
        candidateTree.delete();
      }
      accepted.push(
        Object.freeze({
          targetLabel,
          newName: planned.newName,
          candidate,
        }),
      );
    }

    return Object.freeze({
      sample,
      localTargetCount: localTargets.length,
      accepted: Object.freeze(accepted),
      rejected: Object.freeze(rejected),
    });
  } finally {
    tree.delete();
  }
}

function planWithCollisionFreeName(
  source: string,
  rootNode: Node,
  analysis: ReturnType<typeof projectCst>,
  symbolId: string,
  oldName: string,
  sampleIndex: number,
  targetIndex: number,
): ConservativeLocalRenamePlan | LocalRenameError {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `X${String(attempt)}`;
    const newName = `m3EditS${String(sampleIndex + 1).padStart(2, "0")}T${String(
      targetIndex + 1,
    ).padStart(2, "0")}${suffix}`;
    try {
      return planConservativeLocalRename({
        source,
        rootNode,
        analysis,
        symbolId,
        expectedOldName: oldName,
        newName,
      });
    } catch (error) {
      if (!(error instanceof LocalRenameError)) throw error;
      if (error.code !== "NAME_COLLISION") return error;
    }
  }
  throw new Error(`无法为 ${symbolId} 构造确定性无冲突名称`);
}

async function verifySampleEquivalence(entry: SampleRenameMatrix): Promise<void> {
  const { sample } = entry;
  if (entry.accepted.length === 0) {
    if (!ZERO_EXECUTABLE_TARGET_ALLOWLIST.has(sample.name)) {
      throw new Error(`${sample.name} 没有可执行 rename target，且不在显式 N/A allowlist`);
    }
    matrixRows.push(formatMatrixRow(entry, "N/A"));
    return;
  }

  const runner = createSampleVerificationRunner();
  const startedAt = performance.now();
  try {
    await assertRunnerReady(runner, sample.name);
    const originalArtifact = await compilePlain(runner, sample.source, `${sample.name} original`);
    const originalResults = new Map<string, RunResult>();
    for (const test of sample.tests) {
      originalResults.set(
        test.id,
        await runCase(runner, sample, test, originalArtifact, "original"),
      );
    }

    for (const rename of entry.accepted) {
      const artifact = await compilePlain(
        runner,
        rename.candidate,
        `${sample.name} ${rename.targetLabel}->${rename.newName}`,
      );
      for (const test of sample.tests) {
        const original = originalResults.get(test.id);
        if (original === undefined) throw new Error(`${sample.name}/${test.id} 缺少原始运行缓存`);
        const candidate = await runCase(
          runner,
          sample,
          test,
          artifact,
          `${rename.targetLabel}->${rename.newName}`,
        );
        assertEquivalentRun(
          candidate,
          original,
          `${sample.name}/${test.id} ${rename.targetLabel}->${rename.newName}`,
        );
      }
    }
    matrixRows.push(formatMatrixRow(entry, `${Math.round(performance.now() - startedAt)}ms`));
  } finally {
    await runner.dispose();
  }
}

async function assertRunnerReady(
  runner: SampleVerificationRunner,
  sampleName: string,
): Promise<void> {
  const capabilities = await runner.capabilities();
  expect(capabilities, `${sampleName} runner capabilities`).toMatchObject({
    mode: "seatbelt-best-effort",
    runnerEnabled: true,
    requiresNativeTrustConfirmation: false,
    seatbeltProbe: { status: "probe-succeeded" },
  });
}

async function compilePlain(
  runner: SampleVerificationRunner,
  source: string,
  label: string,
): Promise<string> {
  const result = await runner.compile({ source, sourceName: "main.c", preset: "plain" });
  if (!result.ok) {
    throw new Error(`${label} plain compile failed: ${result.error.code}: ${result.error.message}`);
  }
  return result.artifactId;
}

async function runCase(
  runner: SampleVerificationRunner,
  sample: GoldSample,
  test: GoldTestCase,
  artifactId: string,
  label: string,
): Promise<RunResult> {
  const attempt = async (): Promise<RunResult> =>
    await runner.run({
      artifactId,
      args: sample.args,
      stdin: test.stdin,
      fixtures: sample.fixtures,
      writableFiles: sample.writableFiles,
      mode: "direct",
    });
  let result = await attempt();
  if (isPureWallTimeLimit(result)) {
    wallTimeRecoveryCount += 1;
    console.warn(
      `${sample.name}/${test.id} ${label} 首次命中固定 3s wall-time；使用该逻辑运行唯一一次同限制恢复重试`,
    );
    result = await attempt();
  }
  if (!result.ok) {
    throw new Error(
      `${sample.name}/${test.id} ${label} run failed: ${result.error?.code ?? "UNKNOWN"}: ${result.error?.message ?? result.termination}; termination=${result.termination}; signal=${String(result.signal)}`,
    );
  }
  return result;
}

function isPureWallTimeLimit(result: RunResult): boolean {
  return (
    result.ok === false &&
    result.termination === "wall-time-limit" &&
    result.exitCode === null &&
    result.signal === "SIGKILL" &&
    result.error?.code === "RESOURCE_LIMIT"
  );
}

function assertEquivalentRun(candidate: RunResult, original: RunResult, label: string): void {
  assertBytesEqual(candidate.stdout, original.stdout, `${label} stdout`);
  assertBytesEqual(candidate.stderr, original.stderr, `${label} stderr`);
  expect(
    {
      exitCode: candidate.exitCode,
      signal: candidate.signal,
      termination: candidate.termination,
    },
    `${label} process outcome`,
  ).toEqual({
    exitCode: original.exitCode,
    signal: original.signal,
    termination: original.termination,
  });
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.equals(expectedBytes)) return;
  const sharedLength = Math.min(actualBytes.length, expectedBytes.length);
  let offset = 0;
  while (offset < sharedLength && actualBytes[offset] === expectedBytes[offset]) offset += 1;
  throw new Error(
    `${label} byte mismatch at ${String(offset)}: actual=${describeByte(actualBytes[offset])} expected=${describeByte(expectedBytes[offset])}`,
  );
}

function describeByte(value: number | undefined): string {
  return value === undefined ? "EOF" : `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function requireTree(source: string, label: string): ReturnType<Parser["parse"]> & object {
  const tree = parser.parse(source);
  if (tree === null) throw new Error(`${label}: tree-sitter 未返回语法树`);
  return tree;
}

function assertNoRecoveryNodes(rootNode: Node, label: string): void {
  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.type === "ERROR" || node.isError || node.isMissing) {
      throw new Error(
        `${label}: reparse contains ${node.isMissing ? "MISSING" : node.type} at ${String(node.startIndex)}:${String(node.endIndex)}`,
      );
    }
    stack.push(...node.children);
  }
  if (rootNode.hasError) throw new Error(`${label}: reparse root.hasError=true`);
}

function formatMatrixRow(entry: SampleRenameMatrix, duration: string): string {
  const accepted =
    entry.accepted.length === 0
      ? "-"
      : entry.accepted.map((item) => `${item.targetLabel}->${item.newName}`).join(", ");
  const rejected =
    entry.rejected.length === 0
      ? "-"
      : entry.rejected.map((item) => `${item.targetLabel}:${item.code}`).join(", ");
  return `${entry.sample.name} | locals=${String(entry.localTargetCount)} | accept=${String(entry.accepted.length)} [${accepted}] | reject=${String(entry.rejected.length)} [${rejected}] | ${duration}`;
}

async function loadGoldCorpus(): Promise<readonly GoldSample[]> {
  const sampleNames = (await readdir(samplesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Object.freeze(
    await Promise.all(sampleNames.map(async (sampleName) => await loadGoldSample(sampleName))),
  );
}

async function loadGoldSample(sampleName: string): Promise<GoldSample> {
  const sampleRoot = resolve(samplesRoot, sampleName);
  const metadata = requireRecord(
    JSON.parse(await readFile(resolve(sampleRoot, "meta.json"), "utf8")),
    `${sampleName}/meta.json`,
  );
  expect(Object.keys(metadata).sort()).toEqual(
    ["args", "fixtures", "id", "schemaVersion", "writableFiles"].sort(),
  );
  expect(metadata.schemaVersion).toBe(1);
  expect(metadata.id).toBe(sampleName);

  const args = requireStringArray(metadata.args, `${sampleName}.args`);
  const writableFiles = requireStringArray(
    metadata.writableFiles,
    `${sampleName}.writableFiles`,
  ).map((path) => assertSafeRelativePath(path, `${sampleName}.writableFiles`));
  if (!Array.isArray(metadata.fixtures)) throw new Error(`${sampleName}.fixtures 必须是数组`);
  const fixtureTargets = new Set<string>();
  const fixtures: FixtureInput[] = [];
  for (const [index, value] of metadata.fixtures.entries()) {
    const fixture = requireRecord(value, `${sampleName}.fixtures[${String(index)}]`);
    expect(Object.keys(fixture).sort()).toEqual(["source", "target"]);
    const source = assertSafeRelativePath(
      fixture.source,
      `${sampleName}.fixtures[${String(index)}].source`,
    );
    const target = assertSafeRelativePath(
      fixture.target,
      `${sampleName}.fixtures[${String(index)}].target`,
    );
    const canonicalTarget = target.normalize("NFC").toLowerCase();
    if (fixtureTargets.has(canonicalTarget)) {
      throw new Error(`${sampleName} fixture target 重复: ${target}`);
    }
    fixtureTargets.add(canonicalTarget);
    fixtures.push(
      Object.freeze({
        path: target,
        contents: new Uint8Array(
          await readFile(resolveInside(sampleRoot, source, `${sampleName} fixture source`)),
        ),
      }),
    );
  }

  const sourceBytes = new Uint8Array(await readFile(resolve(sampleRoot, "main.c")));
  const source = decodeUtf8RoundTrip(sourceBytes, `${sampleName}/main.c`);
  const testsRoot = resolve(sampleRoot, "tests");
  const inputNames = (await readdir(testsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".in"))
    .map((entry) => entry.name)
    .sort();
  if (inputNames.length === 0) throw new Error(`${sampleName} 没有 tests/*.in`);
  const tests = await Promise.all(
    inputNames.map(async (inputName) => {
      const stem = basename(inputName, ".in");
      return Object.freeze({
        id: stem,
        stdin: new Uint8Array(await readFile(resolve(testsRoot, inputName))),
      });
    }),
  );

  return Object.freeze({
    name: sampleName,
    source,
    args,
    fixtures: Object.freeze(fixtures),
    writableFiles: Object.freeze(writableFiles),
    tests: Object.freeze(tests),
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  if (value.some((item) => item.includes("\0"))) throw new Error(`${label} 不能包含 NUL`);
  return Object.freeze([...value] as string[]);
}

function assertSafeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} 不是安全的相对 POSIX 路径: ${String(value)}`);
  }
  return value;
}

function resolveInside(root: string, relativePath: string, label: string): string {
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} 越出允许目录: ${candidate}`);
  }
  return candidate;
}

function decodeUtf8RoundTrip(bytes: Uint8Array, label: string): string {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const source = decoder.decode(bytes);
  if (!Buffer.from(new TextEncoder().encode(source)).equals(Buffer.from(bytes))) {
    throw new Error(`${label} 经 runner string 接口往返后字节发生变化`);
  }
  return source;
}
