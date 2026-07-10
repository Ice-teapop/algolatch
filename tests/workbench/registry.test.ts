import { describe, expect, it } from "vitest";
import type { WorkbenchModuleDefinition } from "../../src/workbench/contracts.js";
import {
  BUILTIN_WORKBENCH_MODULES,
  createBuiltinWorkbenchRegistry,
} from "../../src/workbench/builtin-modules.js";
import {
  WorkbenchModuleRegistry,
  WorkbenchRegistryConflictError,
} from "../../src/workbench/registry.js";

describe("WorkbenchModuleRegistry", () => {
  it("produces the same stably sorted snapshot regardless of registration order", () => {
    const alpha = moduleDefinition("module.alpha", {
      capabilities: ["source.edit", "inspector.open"],
      views: [{ id: "view.zeta", label: "Zeta", order: 20 }],
      groups: [{ id: "group.zeta", label: "Zeta", order: 20 }],
      pages: [{ id: "page.zeta", label: "Zeta", groupId: "group.zeta", order: 20 }],
      commands: [{ id: "command.zeta", label: "Zeta", order: 20 }],
      elements: [
        {
          type: "control.loop",
          version: "1.1.0",
          label: "Loop",
          category: "control",
        },
      ],
    });
    const zeta = moduleDefinition("module.zeta", {
      capabilities: ["source.inspect"],
      views: [{ id: "view.alpha", label: "Alpha", order: 10 }],
      groups: [{ id: "group.alpha", label: "Alpha", order: 10 }],
      pages: [{ id: "page.alpha", label: "Alpha", groupId: "group.alpha", order: 10 }],
      commands: [{ id: "command.alpha", label: "Alpha", order: 10 }],
      elements: [
        {
          type: "data.array",
          version: "2.0.0",
          label: "Array",
          category: "data",
        },
      ],
    });

    const forward = new WorkbenchModuleRegistry().registerAll([alpha, zeta]).snapshot();
    const reverse = new WorkbenchModuleRegistry().registerAll([zeta, alpha]).snapshot();

    expect(reverse).toEqual(forward);
    expect(forward.modules.map(({ manifest }) => manifest.id)).toEqual([
      "module.alpha",
      "module.zeta",
    ]);
    expect(forward.inspectorViews.map(({ id }) => id)).toEqual(["view.alpha", "view.zeta"]);
    expect(forward.dockGroups.map(({ id }) => id)).toEqual(["group.alpha", "group.zeta"]);
    expect(forward.pages.map(({ id }) => id)).toEqual(["page.alpha", "page.zeta"]);
    expect(forward.commands.map(({ id }) => id)).toEqual(["command.alpha", "command.zeta"]);
    expect(forward.algorithmElements.map(({ type }) => type)).toEqual([
      "control.loop",
      "data.array",
    ]);
    expect(forward.capabilities).toEqual(["inspector.open", "source.edit", "source.inspect"]);
  });

  it.each([
    ["module-id", moduleDefinition("module.base")],
    [
      "inspector-view-id",
      moduleDefinition("module.other", {
        views: [{ id: "view.base", label: "Other", order: 30 }],
      }),
    ],
    [
      "dock-group-id",
      moduleDefinition("module.other", {
        groups: [{ id: "group.base", label: "Other", order: 30 }],
      }),
    ],
    [
      "page-id",
      moduleDefinition("module.other", {
        pages: [{ id: "page.base", label: "Other", groupId: "group.base", order: 30 }],
      }),
    ],
    [
      "command-id",
      moduleDefinition("module.other", {
        commands: [{ id: "command.base", label: "Other", order: 30 }],
      }),
    ],
    [
      "algorithm-element-type",
      moduleDefinition("module.other", {
        elements: [
          {
            type: "control.base",
            version: "1.0.0",
            label: "Other",
            category: "control",
          },
        ],
      }),
    ],
  ] as const)("rejects duplicate %s without partially mutating the registry", (kind, conflict) => {
    const registry = new WorkbenchModuleRegistry().register(
      moduleDefinition("module.base", {
        views: [{ id: "view.base", label: "Base", order: 10 }],
        groups: [{ id: "group.base", label: "Base", order: 10 }],
        pages: [{ id: "page.base", label: "Base", groupId: "group.base", order: 10 }],
        commands: [{ id: "command.base", label: "Base", order: 10 }],
        elements: [
          {
            type: "control.base",
            version: "1.0.0",
            label: "Base",
            category: "control",
          },
        ],
      }),
    );
    const before = registry.snapshot();

    expect(() => registry.registerAll([moduleDefinition("module.pending"), conflict])).toThrowError(
      expect.objectContaining<Partial<WorkbenchRegistryConflictError>>({
        name: "WorkbenchRegistryConflictError",
        kind,
      }),
    );
    expect(registry.snapshot()).toEqual(before);
    expect(registry.hasModule("module.pending")).toBe(false);
  });

  it("snapshots caller input and deeply freezes every exported level", () => {
    const mutableCapabilities = ["source.inspect"];
    const mutableViews = [{ id: "view.inspect", label: "Inspect", order: 10 }];
    const mutableGroups = [{ id: "group.inspect", label: "Inspect", order: 10 }];
    const mutablePages = [
      { id: "page.inspect", label: "Inspect", groupId: "group.inspect", order: 10 },
    ];
    const input: WorkbenchModuleDefinition = {
      manifest: {
        id: "module.inspect",
        version: "1.0.0",
        label: "Inspect",
        capabilities: mutableCapabilities,
      },
      inspectorViews: mutableViews,
      dockGroups: mutableGroups,
      pages: mutablePages,
    };
    const registry = new WorkbenchModuleRegistry().register(input);

    mutableCapabilities.push("source.mutated");
    mutableViews[0]!.label = "Mutated";
    mutableGroups[0]!.label = "Mutated";
    mutablePages[0]!.label = "Mutated";
    const snapshot = registry.snapshot();

    expect(snapshot.capabilities).toEqual(["source.inspect"]);
    expect(snapshot.inspectorViews[0]?.label).toBe("Inspect");
    expect(snapshot.dockGroups[0]?.label).toBe("Inspect");
    expect(snapshot.pages[0]?.label).toBe("Inspect");
    expectDeepFrozen(snapshot);
    expectDeepFrozen(registry.findModulesByCapability("source.inspect"));
  });

  it("publishes the built-in inspector views and grouped dock pages", () => {
    const registry = createBuiltinWorkbenchRegistry();
    const snapshot = registry.snapshot();

    expect(BUILTIN_WORKBENCH_MODULES).toHaveLength(4);
    expect(snapshot.inspectorViews).toEqual([
      expect.objectContaining({ id: "explanation", label: "解释", order: 10 }),
      expect.objectContaining({ id: "edit", label: "编辑", order: 20 }),
      expect.objectContaining({ id: "run", label: "运行", order: 30 }),
    ]);
    expect(snapshot.dockGroups).toEqual([
      expect.objectContaining({ id: "core", label: "构建", order: 10 }),
      expect.objectContaining({ id: "inspect", label: "检查", order: 20 }),
      expect.objectContaining({ id: "execute", label: "执行", order: 30 }),
      expect.objectContaining({ id: "learn", label: "学习", order: 40 }),
    ]);
    expect(snapshot.pages).toEqual([
      expect.objectContaining({ id: "build", groupId: "core", order: 10 }),
      expect.objectContaining({ id: "library", groupId: "core", order: 20 }),
      expect.objectContaining({ id: "explanation", groupId: "inspect", order: 10 }),
      expect.objectContaining({ id: "edit", groupId: "inspect", order: 20 }),
      expect.objectContaining({ id: "run", groupId: "execute", order: 10 }),
      expect.objectContaining({ id: "guide", groupId: "learn", order: 10 }),
    ]);
    expect(
      registry.findModulesByCapability("inspector.editing").map(({ manifest }) => manifest.id),
    ).toEqual(["builtin.inspector.editing"]);
    expect(registry.findModulesByCapability("inspector.unknown")).toEqual([]);
    expect(registry.hasCapability("inspector.execution")).toBe(true);
    expect(registry.hasCapability("navigation.dock")).toBe(true);
    expect(registry.hasCapability("inspector.unknown")).toBe(false);
  });

  it("rejects a page with a missing group without partially mutating the registry", () => {
    const registry = new WorkbenchModuleRegistry().register(moduleDefinition("module.base"));
    const before = registry.snapshot();

    expect(() =>
      registry.registerAll([
        moduleDefinition("module.pending"),
        moduleDefinition("module.orphan", {
          pages: [{ id: "page.orphan", label: "Orphan", groupId: "group.missing", order: 10 }],
        }),
      ]),
    ).toThrow(/未注册 Dock 分组/u);
    expect(registry.snapshot()).toEqual(before);
    expect(registry.hasModule("module.pending")).toBe(false);
  });
});

interface ModuleOptions {
  readonly capabilities?: readonly string[];
  readonly views?: WorkbenchModuleDefinition["inspectorViews"];
  readonly groups?: WorkbenchModuleDefinition["dockGroups"];
  readonly pages?: WorkbenchModuleDefinition["pages"];
  readonly commands?: WorkbenchModuleDefinition["commands"];
  readonly elements?: WorkbenchModuleDefinition["algorithmElements"];
}

function moduleDefinition(id: string, options: ModuleOptions = {}): WorkbenchModuleDefinition {
  return {
    manifest: {
      id,
      version: "1.0.0",
      label: id,
      capabilities: options.capabilities ?? [],
    },
    inspectorViews: options.views ?? [],
    dockGroups: options.groups ?? [],
    pages: options.pages ?? [],
    commands: options.commands ?? [],
    algorithmElements: options.elements ?? [],
  };
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested, seen);
  }
}
