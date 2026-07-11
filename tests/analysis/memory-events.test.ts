import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeProgramCst,
  type FunctionMemoryEvents,
  type MemoryEvent,
  type ProgramAnalysisSnapshot,
} from "../../src/analysis/index.js";
import type { CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a unique-handle memory event facts", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("publishes a direct malloc, null guard, dereference and free lifecycle", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(sizeof *p); if (!p) return 1; *p = 1; free(p); return 0; }",
    );
    const memory = onlyMemory(analysis.snapshot);
    const events = allEvents(memory);

    expect(memory.status).toBe("complete");
    expect(memory.handleVariableIds).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual([
      "allocation",
      "null-guard",
      "dereference",
      "free",
    ]);
    expect(events[0]).toMatchObject({
      allocator: "malloc",
      sizeForm: "sizeof-pointee",
      repeatable: false,
    });
    expect(events[1]).toMatchObject({
      form: "logical-not",
      nonNullEdgeKind: "branch-false",
    });
    expect(events[2]).toMatchObject({ form: "indirection" });
    expect(events.map((event) => selectedText(analysis, event))).toEqual([
      "malloc(sizeof *p)",
      "(!p)",
      "*p",
      "free(p)",
    ]);
  });

  it("supports casted calloc, explicit null comparison and arrow access", () => {
    const analysis = inspect(
      parser,
      [
        "#include <stdlib.h>",
        "struct Item { int value; };",
        "int f(void) {",
        "  struct Item *p = (struct Item *)calloc(1, sizeof *p);",
        "  if (p != NULL) p->value = 1;",
        "  free(p);",
        "  return 0;",
        "}",
      ].join("\n"),
    );
    const memory = onlyMemory(analysis.snapshot);
    const events = allEvents(memory);

    expect(memory.status).toBe("complete");
    expect(events.map((event) => event.kind)).toEqual([
      "allocation",
      "null-guard",
      "dereference",
      "free",
    ]);
    expect(events[0]).toMatchObject({ allocator: "calloc", sizeForm: "sizeof-pointee" });
    expect(events[1]).toMatchObject({
      form: "not-equals-null",
      nonNullEdgeKind: "branch-true",
    });
    expect(events[2]).toMatchObject({ form: "arrow" });
  });

  it("recognizes direct, commuted and offset dereference forms", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(8); p[0] = 1; 1[p] = 2; *(p + 1) = 3; free(p); return 0; }",
    );
    const dereferences = allEvents(onlyMemory(analysis.snapshot)).filter(
      (event) => event.kind === "dereference",
    );

    expect(dereferences.map((event) => event.form)).toEqual([
      "subscript",
      "subscript",
      "indirection",
    ]);
  });

  it("keeps multiple same-node dereferences without claiming a runtime order", () => {
    const beforeFree = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = malloc(8); p[0] = p[1]; free(p); return 0; }",
      ).snapshot,
    );
    const afterFree = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = malloc(8); free(p); return p[0] + p[1]; }",
      ).snapshot,
    );

    for (const memory of [beforeFree, afterFree]) {
      expect(memory.status).toBe("complete");
      expect(allEvents(memory).filter((event) => event.kind === "dereference")).toHaveLength(2);
    }
  });

  it("uses an active assert CFG branch as a non-null guard", () => {
    const asserted = ["p", "p != NULL", "NULL != p"].map((condition) =>
      inspect(
        parser,
        `#include <stdlib.h>\n#include <assert.h>\nint f(void) { int *p = malloc(4); assert(${condition}); *p = 1; free(p); return 0; }`,
      ),
    );
    const nullAssertions = ["!p", "p == NULL"].map((condition) =>
      inspect(
        parser,
        `#include <stdlib.h>\n#include <assert.h>\nint f(void) { int *p = malloc(4); assert(${condition}); free(p); return 0; }`,
      ),
    );

    expect(
      asserted.map((analysis) =>
        allEvents(onlyMemory(analysis.snapshot)).find((event) => event.kind === "null-guard"),
      ),
    ).toEqual([
      expect.objectContaining({ form: "assert", nonNullEdgeKind: "branch-true" }),
      expect.objectContaining({ form: "assert", nonNullEdgeKind: "branch-true" }),
      expect.objectContaining({ form: "assert", nonNullEdgeKind: "branch-true" }),
    ]);
    expect(
      nullAssertions.map((analysis) =>
        allEvents(onlyMemory(analysis.snapshot)).find((event) => event.kind === "null-guard"),
      ),
    ).toEqual([
      expect.objectContaining({ form: "assert", nonNullEdgeKind: "branch-false" }),
      expect.objectContaining({ form: "assert", nonNullEdgeKind: "branch-false" }),
    ]);
  });

  it("keeps direct assert guards in for initializer and update phases", () => {
    const analyses = ["assert(p)", "(assert(p))"].map((phase) =>
      onlyMemory(
        inspect(
          parser,
          `#include <stdlib.h>\n#include <assert.h>\nint f(int c) { int *p = malloc(4); for (${phase}; c; ${phase}) c--; free(p); return 0; }`,
        ).snapshot,
      ),
    );

    for (const memory of analyses) {
      const guards = allEvents(memory).filter((event) => event.kind === "null-guard");
      expect(memory.status).toBe("complete");
      expect(guards.map((event) => [event.form, event.repeatable])).toEqual([
        ["assert", false],
        ["assert", true],
      ]);
    }
  });

  it("does not borrow an enclosing control branch for a shadowed assert call", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint assert(void *); int f(void) { int *p = malloc(4); if (assert(p)) *p = 1; free(p); return 0; }",
    );
    const events = allEvents(onlyMemory(analysis.snapshot));

    expect(events.filter((event) => event.kind === "null-guard")).toEqual([]);
    expect(events.find((event) => event.kind === "escape")).toMatchObject({
      kind: "escape",
      origin: "call-argument",
    });
  });

  it("keeps compound boolean observations local instead of escaping ownership", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int *p = malloc(4); if (p && c) free(p); return 0; }",
    );
    const memory = onlyMemory(analysis.snapshot);

    expect(memory.status).toBe("complete");
    expect(allEvents(memory).map((event) => event.kind)).toEqual(["allocation", "free"]);
  });

  it("distinguishes evaluated builtin calls from the narrow unevaluated allowlist", () => {
    const evaluated = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); __builtin_memset(p, 0, 4); return 0; }",
    );
    const unevaluated = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); (void)__builtin_constant_p(*p); free(p); return 0; }",
    );

    expect(allEvents(onlyMemory(evaluated.snapshot)).map((event) => event.kind)).toEqual([
      "allocation",
      "escape",
    ]);
    expect(allEvents(onlyMemory(unevaluated.snapshot)).map((event) => event.kind)).toEqual([
      "allocation",
      "free",
    ]);
  });

  it("absorbs ambiguous builtin selection instead of publishing branch-local actions", () => {
    const selectedFree = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); __builtin_choose_expr(1, free(p), 0); return 0; }",
    );
    const selectedDereference = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); (void)__builtin_choose_expr(0, *p, 0); return 0; }",
    );

    for (const analysis of [selectedFree, selectedDereference]) {
      const events = allEvents(onlyMemory(analysis.snapshot));
      expect(events.map((event) => event.kind)).toEqual(["allocation", "escape"]);
      expect(events[1]).toMatchObject({ kind: "escape", origin: "unsupported-use" });
      expect(selectedText(analysis, events[1]!)).toContain("__builtin_choose_expr");
    }
  });

  it("records direct null assignments around a later allocation", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\n#include <stddef.h>\nint f(void) { int *p = NULL; p = malloc(4); free(p); p = 0; return 0; }",
    );
    const memory = onlyMemory(analysis.snapshot);
    const events = allEvents(memory);

    expect(memory.status).toBe("complete");
    expect(events.map((event) => event.kind)).toEqual([
      "null-assignment",
      "allocation",
      "free",
      "null-assignment",
    ]);
    expect(events.filter((event) => event.kind === "null-assignment")).toHaveLength(2);
  });

  it.each([
    ["return", "int *f(void) { int *p = malloc(4); return p; }"],
    ["call-argument", "int f(void) { int *p = malloc(4); sink(p); return 0; }"],
    ["stored-value", "int f(void) { int *p = malloc(4); int *q = p; return q != 0; }"],
    ["address-taken", "int f(void) { int *p = malloc(4); sink(&p); return 0; }"],
    ["overwritten", "int f(void) { int *p = malloc(4); p = other(); return 0; }"],
  ] as const)("publishes a %s escape for a direct ownership boundary", (origin, body) => {
    const analysis = inspect(parser, `#include <stdlib.h>\n${body}`);
    const memory = onlyMemory(analysis.snapshot);
    const escape = allEvents(memory).find((event) => event.kind === "escape");

    expect(memory.status).toBe("complete");
    expect(escape).toMatchObject({ kind: "escape", origin });
  });

  it("absorbs arrow-derived values that cross an ownership boundary", () => {
    const sources = [
      [
        "stored-value",
        "struct S { int a[4]; }; int f(void) { struct S *p = malloc(sizeof *p); int *q = p->a; free(p); return q[0]; }",
      ],
      [
        "stored-value",
        "struct S { int a[4]; }; int f(void) { struct S *p = malloc(sizeof *p); int *q = (*p).a; free(p); return q[0]; }",
      ],
      [
        "stored-value",
        "struct S { int a[4]; }; int f(void) { struct S *p = malloc(sizeof *p); int *q = p[0].a; free(p); return q[0]; }",
      ],
      [
        "call-argument",
        "struct S { int a[4]; }; int f(void) { struct S *p = malloc(sizeof *p); sink(p->a); free(p); return 0; }",
      ],
      [
        "return",
        "struct S { int a[4]; }; int *f(void) { struct S *p = malloc(sizeof *p); return p->a; }",
      ],
    ] as const;

    for (const [origin, body] of sources) {
      const memory = onlyMemory(inspect(parser, `#include <stdlib.h>\n${body}`).snapshot);
      const events = allEvents(memory);
      expect(memory.status).toBe("complete");
      expect(events.find((event) => event.kind === "dereference")).toMatchObject({
        kind: "dereference",
      });
      expect(events.find((event) => event.kind === "escape")).toMatchObject({
        kind: "escape",
        origin,
      });
    }
  });

  it("requires builtin allocator/free identity and treats shadowed free as escape", () => {
    const customAllocation = inspect(
      parser,
      "void *malloc(unsigned long); int f(void) { int *p = malloc(4); return p != 0; }",
    );
    const shadowedFree = inspect(
      parser,
      "#include <stdlib.h>\nvoid free(void *); int f(void) { int *p = malloc(4); free(p); return 0; }",
    );

    expect(onlyMemory(customAllocation.snapshot).handleVariableIds).toEqual([]);
    expect(allEvents(onlyMemory(customAllocation.snapshot))).toEqual([]);
    expect(allEvents(onlyMemory(shadowedFree.snapshot)).map((event) => event.kind)).toEqual([
      "allocation",
      "escape",
    ]);
    expect(allEvents(onlyMemory(shadowedFree.snapshot))[1]).toMatchObject({
      origin: "call-argument",
    });
  });

  it("disables nested allocation assignment and excludes non-automatic or non-level-one targets", () => {
    const nested = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = 0; int *q = 0; q = (p = malloc(4)); return q != 0; }",
      ).snapshot,
    );
    const conditional = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = 0; if (p = malloc(4)) return 1; return 0; }",
      ).snapshot,
    );
    const integerCast = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = (int *)(long)malloc(4); return p != 0; }",
      ).snapshot,
    );
    const sources = [
      "int f(int *p) { p = malloc(4); return p != 0; }",
      "int f(void) { static int *p = malloc(4); return p != 0; }",
      "int f(void) { int **p = (int **)malloc(4); return p != 0; }",
      "int f(void) { volatile int *p = malloc(4); return p != 0; }",
    ];

    expect(nested.status).toBe("disabled");
    expect(nested.disabledReasons).toContain("unsupported-memory-effect-order");
    expect(conditional.status).toBe("disabled");
    expect(conditional.disabledReasons).toContain("unsupported-memory-effect-order");
    expect(integerCast.status).toBe("disabled");
    expect(integerCast.disabledReasons).toContain("unsupported-memory-effect-order");
    for (const source of sources) {
      const memory = onlyMemory(inspect(parser, `#include <stdlib.h>\n${source}`).snapshot);
      expect(memory.status).toBe("complete");
      expect(memory.handleVariableIds).toEqual([]);
      expect(allEvents(memory)).toEqual([]);
    }
  });

  it("rejects typedef-obscured handle types without leaking sibling declarator qualifiers", () => {
    const obscuredSources = [
      "typedef int *P; int f(void) { P *p = malloc(4); free(p); return 0; }",
      "typedef int A[3]; int f(void) { A *p = malloc(4); free(p); return 0; }",
      "typedef volatile int V; int f(void) { V *p = malloc(4); free(p); return 0; }",
      "int f(void) { typeof(int *) *p = malloc(4); free(p); return 0; }",
      "int f(void) { typeof(volatile int) *p = malloc(4); free(p); return 0; }",
    ];
    for (const source of obscuredSources) {
      const memory = onlyMemory(inspect(parser, `#include <stdlib.h>\n${source}`).snapshot);
      expect(memory.status).toBe("complete");
      expect(memory.handleVariableIds).toEqual([]);
      expect(allEvents(memory)).toEqual([]);
    }

    const precise = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = malloc(4), *volatile q = 0; free(p); return q != 0; }",
      ).snapshot,
    );
    expect(precise.status).toBe("complete");
    expect(precise.handleVariableIds).toHaveLength(1);
    expect(allEvents(precise).map((event) => event.kind)).toEqual(["allocation", "free"]);
  });

  it("cancels direct indirection-after-address pairs as pointer-value operations", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); (void)p; (void)*&p; free(*&p); *p = 1; return 0; }",
    );
    const events = allEvents(onlyMemory(analysis.snapshot));

    expect(events.map((event) => event.kind)).toEqual(["allocation", "free", "dereference"]);
    expect(selectedText(analysis, events[1]!)).toBe("free(*&p)");
    expect(events.filter((event) => event.kind === "escape")).toEqual([]);
  });

  it("inherits the upstream conservative boundary for address-after-indirection", () => {
    const memory = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(void) { int *p = malloc(4); free(&*p); return 0; }",
      ).snapshot,
    );

    expect(memory.status).toBe("disabled");
    expect(memory.disabledReasons).toContain("unsupported-effect-order");
    expect(memory.handleVariableIds).toEqual([]);
    expect(memory.facts).toEqual([]);
  });

  it("accepts a direct allocation target through cancelled address operations", () => {
    const supported = ["*&p", "*(&p)", "*&*&p"].map((target) =>
      onlyMemory(
        inspect(
          parser,
          `#include <stdlib.h>\nint f(void) { int *p = 0; ${target} = malloc(4); free(p); return 0; }`,
        ).snapshot,
      ),
    );
    for (const memory of supported) {
      expect(memory.status).toBe("complete");
      expect(memory.handleVariableIds).toHaveLength(1);
      expect(allEvents(memory).map((event) => event.kind)).toEqual([
        "null-assignment",
        "allocation",
        "free",
      ]);
    }

    const indirect = onlyMemory(
      inspect(
        parser,
        "#include <stdlib.h>\nint f(int **slot) { int *p = 0; *slot = malloc(4); return p != 0; }",
      ).snapshot,
    );
    expect(indirect.status).toBe("complete");
    expect(indirect.handleVariableIds).toEqual([]);
    expect(allEvents(indirect)).toEqual([]);
  });

  it("does not turn free(NULL), sizeof or direct address cancellation into handle actions", () => {
    const analysis = inspect(
      parser,
      [
        "#include <stdlib.h>",
        "#include <stddef.h>",
        "int f(void) {",
        "  int *p = malloc(sizeof p);",
        "  free(NULL); free(0); free((void *)0);",
        "  (void)sizeof *p; (void)sizeof p[0];",
        "  (void)sizeof (free(p), 0);",
        "  (void)sizeof (p = 0);",
        "  (void)sizeof realloc(p, 8);",
        "  free(p);",
        "  return 0;",
        "}",
      ].join("\n"),
    );
    const memory = onlyMemory(analysis.snapshot);
    const events = allEvents(memory);

    expect(memory.status).toBe("complete");
    expect(events[0]).toMatchObject({ kind: "allocation", sizeForm: "sizeof-handle" });
    expect(events.filter((event) => event.kind === "dereference")).toEqual([]);
    expect(events.filter((event) => event.kind === "free")).toHaveLength(1);
  });

  it("turns realloc into an absorbing unsupported escape", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); p = realloc(p, 8); return 0; }",
    );
    const events = allEvents(onlyMemory(analysis.snapshot));

    expect(events.map((event) => event.kind)).toEqual(["allocation", "escape"]);
    expect(events[1]).toMatchObject({ origin: "unsupported-reallocation" });
  });

  it.each([
    "int f(int c) { int *p = malloc(4); c && free(p); return 0; }",
    "int f(int c) { int *p = malloc(4); c ? free(p) : 0; return 0; }",
    "int f(void) { int *p = malloc(4); (free(p), *p); return 0; }",
  ])("disables memory facts when one handle has unsupported in-node ordering: %s", (body) => {
    const memory = onlyMemory(inspect(parser, `#include <stdlib.h>\n${body}`).snapshot);

    expect(memory.status).toBe("disabled");
    expect(memory.disabledReasons).toContain(
      body.includes("free(p), *p") ? "unsupported-memory-effect-order" : "unsupported-effect-order",
    );
    expect(memory.handleVariableIds).toEqual([]);
    expect(memory.facts).toEqual([]);
  });

  it("marks loop-owned syntax events repeatable without duplicating occurrences", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int *p = malloc(4); while (c) { *p = 1; c--; } free(p); return 0; }",
    );
    const events = allEvents(onlyMemory(analysis.snapshot));

    expect(events.map((event) => [event.kind, event.repeatable])).toEqual([
      ["allocation", false],
      ["dereference", true],
      ["free", false],
    ]);
  });

  it("keeps unreachable memory syntax as facts without making its CFG nodes reachable", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { return 0; int *p = malloc(4); *p = 1; free(p); }",
    );
    const memory = onlyMemory(analysis.snapshot);
    const eventNodeIds = new Set(
      memory.facts.filter((fact) => fact.events.length > 0).map((fact) => fact.nodeId),
    );
    const cfg = analysis.snapshot.functions[0];

    expect(allEvents(memory).map((event) => event.kind)).toEqual([
      "allocation",
      "dereference",
      "free",
    ]);
    expect(
      cfg?.nodes
        .filter((node) => eventNodeIds.has(node.id))
        .every((node) => node.reachable === false),
    ).toBe(true);
  });

  it("inherits function disablement and publishes deterministic deeply frozen CFG-aligned facts", () => {
    const disabled = inspect(
      parser,
      "#define TAKE(p) (*(p))\nint f(void) { int *p = malloc(4); return TAKE(p); }",
    );
    const source = "#include <stdlib.h>\nint f(void) { int *p = malloc(4); free(p); return 0; }";
    const first = inspect(parser, source).snapshot;
    const second = inspect(parser, source).snapshot;
    const memory = onlyMemory(first);

    expect(onlyMemory(disabled.snapshot)).toMatchObject({ status: "disabled", facts: [] });
    expect(memory.facts).toHaveLength(first.functions[0]?.nodes.length ?? -1);
    expect(memory.facts.map((fact) => fact.nodeId)).toEqual(
      first.functions[0]?.nodes.map((node) => node.id),
    );
    expect(new Set(allEvents(memory).map((event) => event.id)).size).toBe(allEvents(memory).length);
    expect(memory).toEqual(onlyMemory(second));
    expect(deeplyFrozen(memory)).toBe(true);
  });
});

interface InspectedProgram {
  readonly source: string;
  readonly snapshot: ProgramAnalysisSnapshot;
}

function inspect(parser: CParser, source: string): InspectedProgram {
  return parser.inspect(source, 1, ({ rootNode, document }) =>
    Object.freeze({
      source,
      snapshot: analyzeProgramCst({ source, revision: 1, rootNode, document }),
    }),
  ).result;
}

function onlyMemory(snapshot: ProgramAnalysisSnapshot): FunctionMemoryEvents {
  const memory = snapshot.memoryEvents[0];
  if (memory === undefined || snapshot.memoryEvents.length !== 1) {
    throw new Error("fixture 函数数量异常");
  }
  return memory;
}

function allEvents(memory: FunctionMemoryEvents): readonly MemoryEvent[] {
  return memory.facts.flatMap((fact) => fact.events);
}

function selectedText(analysis: InspectedProgram, event: MemoryEvent): string {
  return analysis.source.slice(event.range.from, event.range.to);
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
}
