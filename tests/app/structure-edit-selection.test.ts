import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBlockIndex,
  type BlockIndexEntry,
  type CAnalysisSnapshot,
  type CParser,
} from "../../src/core/index.js";
import {
  canSelectAnalyzedSource,
  structureEditSelectionAtOffset,
  structureEditSelectionForBlock,
} from "../../src/app/structure-edit-selection.js";
import { createTestParser } from "../core/parser-fixture.js";

let parser: CParser;

beforeAll(async () => {
  parser = await createTestParser();
});

afterAll(() => {
  parser.dispose();
});

describe("structure edit selection mapping", () => {
  const source = `int main(void) {
  int value = 1;
  value++;
  return value;
}
`;

  it("combines the selected statement with a local-variable rename selection", () => {
    const analysis = parser.analyze(source, 7);
    const declarationOffset = source.indexOf("value") + 1;
    const selection = structureEditSelectionAtOffset(analysis, declarationOffset);

    expect(selection).toMatchObject({
      revision: 7,
      statement: {
        text: "int value = 1;",
        parentMode: "statement-list",
        blocker: null,
        previous: null,
        next: { text: "value++;" },
      },
      localVariable: { name: "value" },
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection?.statement)).toBe(true);
  });

  it("maps a statement block even when it has no M3a edit target", () => {
    const analysis = parser.analyze(source, 9);
    const entry = exactStatementEntry(analysis, "return value;");
    const selection = structureEditSelectionForBlock(analysis, entry);

    expect(selection).toMatchObject({
      revision: 9,
      statement: {
        text: "return value;",
        previous: { text: "value++;" },
        next: null,
      },
    });
    expect(selection?.localVariable).toBeUndefined();
  });

  it("does not offer rename for fields or functions and validates offsets", () => {
    const analysis = parser.analyze(source, 10);
    expect(structureEditSelectionAtOffset(analysis, source.indexOf("main"))).toBeNull();
    expect(() => structureEditSelectionAtOffset(analysis, source.length + 1)).toThrow(/范围/u);
  });

  it("never maps new editor offsets against a pending, held, or stale analysis", () => {
    expect(canSelectAnalyzedSource("synced", source, source)).toBe(true);
    expect(canSelectAnalyzedSource("recovery", source, source)).toBe(true);
    expect(canSelectAnalyzedSource("pending", source, source)).toBe(false);
    expect(canSelectAnalyzedSource("held", source, source)).toBe(false);
    expect(canSelectAnalyzedSource("synced", `${source} `, source)).toBe(false);
  });
});

function exactStatementEntry(analysis: CAnalysisSnapshot, statementText: string): BlockIndexEntry {
  const from = analysis.document.source.indexOf(statementText);
  const to = from + statementText.length;
  const entry = createBlockIndex(analysis.document).entries.find(
    (candidate) =>
      candidate.block?.kind === "syntax" &&
      candidate.block.range.from === from &&
      candidate.block.range.to === to,
  );
  if (entry === undefined) throw new Error(`缺少语句积木：${statementText}`);
  return entry;
}
