import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSERTION_SORT_SAMPLE_SOURCE } from "../../src/samples/insertion-sort-sandbox.js";

describe("Dashboard insertion-sort sandbox", () => {
  it("stays byte-identical to the canonical sample", () => {
    const canonical = readFileSync("samples/05-insertion-sort/main.c", "utf8");
    expect(INSERTION_SORT_SAMPLE_SOURCE).toBe(canonical);
  });
});
