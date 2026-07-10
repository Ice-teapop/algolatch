import type { WorkbenchModuleDefinition } from "./contracts.js";
import { WorkbenchModuleRegistry } from "./registry.js";

export const BUILTIN_WORKBENCH_MODULES: readonly WorkbenchModuleDefinition[] = Object.freeze([
  builtinNavigationModule(),
  builtinInspectorModule({
    moduleId: "builtin.inspector.explanation",
    moduleLabel: "代码解释",
    capability: "inspector.explanation",
    viewId: "explanation",
    viewLabel: "解释",
    order: 10,
  }),
  builtinInspectorModule({
    moduleId: "builtin.inspector.editing",
    moduleLabel: "结构化编辑",
    capability: "inspector.editing",
    viewId: "edit",
    viewLabel: "编辑",
    order: 20,
  }),
  builtinInspectorModule({
    moduleId: "builtin.inspector.execution",
    moduleLabel: "代码运行",
    capability: "inspector.execution",
    viewId: "run",
    viewLabel: "运行",
    order: 30,
  }),
]);

function builtinNavigationModule(): WorkbenchModuleDefinition {
  return Object.freeze({
    manifest: Object.freeze({
      id: "builtin.navigation",
      version: "1.0.0",
      label: "工作台导航",
      capabilities: Object.freeze(["navigation.dock", "navigation.pages"]),
    }),
    inspectorViews: Object.freeze([]),
    dockGroups: Object.freeze([
      Object.freeze({ id: "core", label: "构建", order: 10 }),
      Object.freeze({ id: "inspect", label: "检查", order: 20 }),
      Object.freeze({ id: "execute", label: "执行", order: 30 }),
      Object.freeze({ id: "learn", label: "学习", order: 40 }),
    ]),
    pages: Object.freeze([
      Object.freeze({ id: "build", label: "搭建", groupId: "core", order: 10 }),
      Object.freeze({ id: "library", label: "积木库", groupId: "core", order: 20 }),
      Object.freeze({ id: "explanation", label: "解释", groupId: "inspect", order: 10 }),
      Object.freeze({ id: "edit", label: "编辑", groupId: "inspect", order: 20 }),
      Object.freeze({ id: "run", label: "运行", groupId: "execute", order: 10 }),
      Object.freeze({ id: "guide", label: "入门", groupId: "learn", order: 10 }),
    ]),
    commands: Object.freeze([]),
    algorithmElements: Object.freeze([]),
  });
}

export function registerBuiltinWorkbenchModules(
  registry: WorkbenchModuleRegistry,
): WorkbenchModuleRegistry {
  registry.registerAll(BUILTIN_WORKBENCH_MODULES);
  return registry;
}

export function createBuiltinWorkbenchRegistry(): WorkbenchModuleRegistry {
  return registerBuiltinWorkbenchModules(new WorkbenchModuleRegistry());
}

interface BuiltinInspectorModuleInput {
  readonly moduleId: string;
  readonly moduleLabel: string;
  readonly capability: string;
  readonly viewId: string;
  readonly viewLabel: string;
  readonly order: number;
}

function builtinInspectorModule(input: BuiltinInspectorModuleInput): WorkbenchModuleDefinition {
  return Object.freeze({
    manifest: Object.freeze({
      id: input.moduleId,
      version: "1.0.0",
      label: input.moduleLabel,
      capabilities: Object.freeze([input.capability]),
    }),
    inspectorViews: Object.freeze([
      Object.freeze({ id: input.viewId, label: input.viewLabel, order: input.order }),
    ]),
    dockGroups: Object.freeze([]),
    pages: Object.freeze([]),
    commands: Object.freeze([]),
    algorithmElements: Object.freeze([]),
  });
}
