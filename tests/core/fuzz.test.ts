import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { Language, Parser, type Node } from "web-tree-sitter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSourceDocInvariants,
  projectionShape,
  rebuildFromCoverage,
  renderSourceDoc,
  type CParser,
} from "../../src/core/index.js";
import { createTestParser, TEST_PARSER_ASSETS } from "./parser-fixture.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const samplesRoot = resolve(projectRoot, "samples");
const sampleSources = readdirSync(samplesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readFileSync(resolve(samplesRoot, entry.name, "main.c"), "utf8"));
const configuredRuns = readPositiveInteger("M1_FUZZ_RUNS", 500);
const configuredSeed = readSafeInteger("M1_FUZZ_SEED", 0xc0b10c);
const fuzzTimeoutMs = Math.max(15_000, Math.min(300_000, configuredRuns * 30));
const allowedAncestors = new Set(["translation_unit", "ERROR", "preproc_ifdef", "preproc_else"]);

type Mutation =
  | { readonly kind: "identity"; readonly sample: number }
  | { readonly kind: "truncate"; readonly sample: number; readonly position: number }
  | {
      readonly kind: "delete-span";
      readonly sample: number;
      readonly position: number;
      readonly length: number;
    }
  | { readonly kind: "delete-line"; readonly sample: number; readonly line: number }
  | { readonly kind: "delete-token"; readonly sample: number; readonly token: number }
  | {
      readonly kind: "replace-operator";
      readonly sample: number;
      readonly operator: number;
      readonly replacement: "+" | "-" | "*" | "/" | "==" | "!=";
    }
  | { readonly kind: "delete-delimiter"; readonly sample: number; readonly delimiter: number }
  | { readonly kind: "insert-goto"; readonly sample: number; readonly position: number }
  | { readonly kind: "insert-macro"; readonly sample: number; readonly position: number }
  | { readonly kind: "concatenate"; readonly left: number; readonly right: number };

const sampleIndex = fc.nat({ max: Math.max(0, sampleSources.length - 1) });
const mutationArbitrary: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant("identity"), sample: sampleIndex }),
  fc.record({ kind: fc.constant("truncate"), sample: sampleIndex, position: fc.nat() }),
  fc.record({
    kind: fc.constant("delete-span"),
    sample: sampleIndex,
    position: fc.nat(),
    length: fc.integer({ min: 1, max: 80 }),
  }),
  fc.record({ kind: fc.constant("delete-line"), sample: sampleIndex, line: fc.nat() }),
  fc.record({ kind: fc.constant("delete-token"), sample: sampleIndex, token: fc.nat() }),
  fc.record({
    kind: fc.constant("replace-operator"),
    sample: sampleIndex,
    operator: fc.nat(),
    replacement: fc.constantFrom("+", "-", "*", "/", "==", "!="),
  }),
  fc.record({ kind: fc.constant("delete-delimiter"), sample: sampleIndex, delimiter: fc.nat() }),
  fc.record({ kind: fc.constant("insert-goto"), sample: sampleIndex, position: fc.nat() }),
  fc.record({ kind: fc.constant("insert-macro"), sample: sampleIndex, position: fc.nat() }),
  fc.record({ kind: fc.constant("concatenate"), left: sampleIndex, right: sampleIndex }),
);

let parser: CParser;
let oracleParser: Parser;

beforeAll(async () => {
  parser = await createTestParser();
  const language = await Language.load(TEST_PARSER_ASSETS.languageWasm);
  oracleParser = new Parser();
  oracleParser.setLanguage(language);
});

afterAll(() => {
  oracleParser.delete();
  parser.dispose();
});

describe("M1 mutation fuzz", () => {
  it(
    `preserves characters and eligible functions (${configuredRuns} runs, seed ${configuredSeed})`,
    () => {
      const property = fc.property(mutationArbitrary, (mutation) => {
        const source = applyMutation(mutation);
        const document = parser.project(source);
        const rendered = renderSourceDoc(document);

        assertSourceDocInvariants(document);
        expect(rebuildFromCoverage(document)).toBe(source);
        expect(rendered).toBe(source);
        expect(new TextEncoder().encode(rendered)).toEqual(new TextEncoder().encode(source));
        expect(projectionShape(parser.project(rendered))).toEqual(projectionShape(document));
        assertEligibleFunctionsPreserved(source, document);
      });
      const result = fc.check(property, {
        numRuns: configuredRuns,
        seed: configuredSeed,
        endOnFailure: false,
        verbose: 2,
      });
      if (result.failed) {
        const mutation = result.counterexample?.[0] as Mutation | undefined;
        const regression = mutation === undefined ? "" : applyMutation(mutation);
        const digest = createHash("sha256").update(regression).digest("hex").slice(0, 12);
        const regressionDirectory = resolve(projectRoot, "corpus/regressions");
        mkdirSync(regressionDirectory, { recursive: true });
        writeFileSync(resolve(regressionDirectory, `m1-${digest}.c`), regression, "utf8");
        writeFileSync(
          resolve(regressionDirectory, `m1-${digest}.json`),
          `${JSON.stringify({ seed: configuredSeed, mutation }, null, 2)}\n`,
          "utf8",
        );
      }
      const failureMessage =
        result.errorInstance instanceof Error
          ? result.errorInstance.message
          : String(result.errorInstance ?? "fast-check failed");
      expect(result.failed, failureMessage).toBe(false);
    },
    fuzzTimeoutMs,
  );
});

function assertEligibleFunctionsPreserved(
  source: string,
  document: ReturnType<CParser["project"]>,
): void {
  const tree = oracleParser.parse(source);
  if (tree === null) {
    throw new Error("oracle parser 未返回语法树");
  }
  try {
    const expected = tree.rootNode
      .descendantsOfType("function_definition")
      .filter(isEligibleOracleFunction)
      .map((node) => `${node.startIndex}:${node.endIndex}`)
      .sort();
    const actual = flattenBlocks(document.blocks)
      .filter((block) => block.kind === "syntax" && block.role === "function")
      .map((block) => `${block.range.from}:${block.range.to}`)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `syntax 函数集合与独立 CST oracle 不一致：expected=${expected.join(",")} actual=${actual.join(",")}`,
      );
    }
  } finally {
    tree.delete();
  }
}

function flattenBlocks(
  blocks: readonly import("../../src/core/index.js").Block[],
): readonly import("../../src/core/index.js").Block[] {
  const flattened: import("../../src/core/index.js").Block[] = [];
  const stack = [...blocks].reverse();
  while (stack.length > 0) {
    const block = stack.pop();
    if (block === undefined) continue;
    flattened.push(block);
    stack.push(...[...block.children].reverse());
  }
  return flattened;
}

function isEligibleOracleFunction(node: Node): boolean {
  if (
    node.hasError ||
    node.childForFieldName("type") === null ||
    node.childForFieldName("declarator") === null ||
    node.childForFieldName("body")?.type !== "compound_statement"
  ) {
    return false;
  }
  let ancestor = node.parent;
  while (ancestor !== null) {
    if (!allowedAncestors.has(ancestor.type)) {
      return false;
    }
    ancestor = ancestor.parent;
  }
  return true;
}

function applyMutation(mutation: Mutation): string {
  if (mutation.kind === "concatenate") {
    return `${sampleAt(mutation.left)}\n${sampleAt(mutation.right)}`;
  }
  const source = sampleAt(mutation.sample);
  switch (mutation.kind) {
    case "identity":
      return source;
    case "truncate":
      return source.slice(0, boundedIndex(mutation.position, source.length + 1));
    case "delete-span": {
      const from = boundedIndex(mutation.position, Math.max(1, source.length));
      return source.slice(0, from) + source.slice(Math.min(source.length, from + mutation.length));
    }
    case "delete-line": {
      const lines = source.match(/[^\n]*(?:\n|$)/gu)?.filter((line) => line.length > 0) ?? [];
      if (lines.length === 0) {
        return source;
      }
      const selected = boundedIndex(mutation.line, lines.length);
      return lines.filter((_line, index) => index !== selected).join("");
    }
    case "delete-token":
      return removeMatch(
        source,
        /[A-Za-z_]\w*|\d+|==|!=|<=|>=|&&|\|\||[{}()[\];,+\-*/%<>]/gu,
        mutation.token,
      );
    case "replace-operator":
      return replaceMatch(
        source,
        /==|!=|<=|>=|&&|\|\||[+\-*/%<>]/gu,
        mutation.operator,
        mutation.replacement,
      );
    case "delete-delimiter":
      return removeMatch(source, /[{}()[\]]/gu, mutation.delimiter);
    case "insert-goto":
      return insertAt(source, mutation.position, "\ngoto m1_missing_label;\n");
    case "insert-macro":
      return insertAt(source, mutation.position, "\n#define M1_FUZZ(x) ((x) + 1)\n");
  }
}

function sampleAt(index: number): string {
  return sampleSources[boundedIndex(index, sampleSources.length)] ?? "";
}

function boundedIndex(value: number, length: number): number {
  return length <= 0 ? 0 : value % length;
}

function insertAt(source: string, position: number, inserted: string): string {
  const index = boundedIndex(position, source.length + 1);
  return source.slice(0, index) + inserted + source.slice(index);
}

function removeMatch(source: string, pattern: RegExp, selectedIndex: number): string {
  const matches = [...source.matchAll(pattern)];
  const match = matches[boundedIndex(selectedIndex, matches.length)];
  if (match?.index === undefined) {
    return source;
  }
  return source.slice(0, match.index) + source.slice(match.index + match[0].length);
}

function replaceMatch(
  source: string,
  pattern: RegExp,
  selectedIndex: number,
  replacement: string,
): string {
  const matches = [...source.matchAll(pattern)];
  const match = matches[boundedIndex(selectedIndex, matches.length)];
  if (match?.index === undefined) {
    return source;
  }
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new Error(`${name} 必须是 1 到 100000 的安全整数`);
  }
  return parsed;
}

function readSafeInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -0x80000000 || parsed > 0x7fffffff) {
    throw new Error(`${name} 必须是 32 位安全整数`);
  }
  return parsed;
}
