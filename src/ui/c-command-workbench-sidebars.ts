import type { CCommandExecutionState, CCommandRuntimeInput } from "../app/c-command-controller.js";
import {
  createBuiltinScenarioProvider,
  type AlgorithmScenarioDefinition,
  type ScenarioRunCase,
} from "../mentor/index.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import {
  createScenarioPicker,
  type ScenarioPicker,
  type ScenarioPickerOption,
} from "./scenario-picker.js";

const HISTORY_LIMIT = 100;
const UNMANAGED_WORKSPACE = "unmanaged";

export interface CCommandWorkbenchSidebars {
  record(state: CCommandExecutionState): void;
  getSelectedRunInput(): CCommandRuntimeInput | null;
  setWorkspaceEntry(entryId: string | null): void;
  destroy(): void;
}

/** Renders session-only C Cell facts; it never writes project run history. */
export function createCCommandWorkbenchSidebars(
  commandHost: HTMLElement,
): CCommandWorkbenchSidebars {
  const shell =
    typeof commandHost.closest === "function"
      ? commandHost.closest<HTMLElement>("[data-command-view]")
      : null;
  const filesHost = shell?.querySelector<HTMLElement>("#project-files-host") ?? null;
  const casesHost = shell?.querySelector<HTMLElement>("#workspace-cases-host") ?? null;
  const historyHost = shell?.querySelector<HTMLElement>("#workspace-history-host") ?? null;
  const records = new Map<string, Map<string, Map<string, CCommandExecutionState>>>();
  const provider = createBuiltinScenarioProvider();
  const scenarios = provider.list();
  let workspaceId: string | null = null;
  let selectedScenarioId = "";
  let selectedRunCase: ScenarioRunCase | null = null;
  let scenarioPicker: ScenarioPicker | null = null;
  let destroyed = false;

  const locale = (): InterfaceLocale => (shell?.dataset.locale === "en" ? "en" : "zh-CN");
  const renderFiles = (): void => {
    if (filesHost === null) return;
    const button = filesHost.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "project-files-host__file";
    button.textContent = "main.c";
    button.addEventListener("click", () => {
      shell?.querySelector<HTMLButtonElement>("#main-source-tab")?.click();
    });
    filesHost.replaceChildren(button);
  };
  const renderCases = (): void => {
    if (casesHost === null) return;
    scenarioPicker?.destroy();
    const currentLocale = locale();
    const preview = casesHost.ownerDocument.createElement("pre");
    preview.className = "workspace-cases-host__preview";
    preview.textContent = runCasePreview(selectedRunCase, currentLocale);
    scenarioPicker = createScenarioPicker(casesHost.ownerDocument, {
      options: scenarioPickerOptions(scenarios, currentLocale),
      value: selectedScenarioId,
      copy: {
        ariaLabel: currentLocale === "en" ? "Run input case" : "运行输入案例",
        emptyLabel: currentLocale === "en" ? "No case · no input" : "不使用案例 · 无输入",
        searchAriaLabel: currentLocale === "en" ? "Filter run input cases" : "筛选运行输入案例",
        searchPlaceholder: currentLocale === "en" ? "Search cases or algorithms" : "搜索案例或算法",
        noMatches: currentLocale === "en" ? "No matching cases" : "没有匹配案例",
      },
      onSelect: (scenarioId) => {
        selectedScenarioId = scenarioId;
        const selectedScenario = provider.get(selectedScenarioId);
        selectedRunCase =
          selectedScenario === null
            ? null
            : provider.generate(
                selectedScenario.id,
                selectedScenario.sizeGenerator.defaultSizes[0] ??
                  selectedScenario.sizeGenerator.minimum,
              );
        preview.textContent = runCasePreview(selectedRunCase, locale());
      },
    });
    casesHost.replaceChildren(scenarioPicker.element, preview);
  };
  const renderHistory = (): void => {
    if (historyHost === null) return;
    const currentLocale = locale();
    const fragment = historyHost.ownerDocument.createDocumentFragment();
    const sourceGroups = records.get(workspaceKey(workspaceId));
    const states =
      sourceGroups === undefined
        ? []
        : [...sourceGroups.values()].flatMap((sourceRecords) => [...sourceRecords.values()]);
    states.sort((left, right) => submissionSequence(right) - submissionSequence(left));
    for (const state of states) {
      const row = historyHost.ownerDocument.createElement("article");
      row.className = "workspace-history-host__entry";
      row.dataset.state = state.phase;
      row.dataset.sourceFingerprint = fingerprintSource(state.projection.source);
      const status = historyHost.ownerDocument.createElement("strong");
      status.textContent = historyStatus(state, currentLocale);
      const evidence = historyHost.ownerDocument.createElement("span");
      evidence.textContent = historyEvidence(state, currentLocale);
      const source = historyHost.ownerDocument.createElement("span");
      source.textContent = historySource(state, currentLocale);
      row.append(status, evidence, source);
      fragment.append(row);
    }
    historyHost.replaceChildren(fragment);
  };
  const onLocaleChange = (): void => {
    renderCases();
    renderHistory();
  };
  shell?.addEventListener("workbench-locale-change", onLocaleChange);
  renderFiles();
  renderCases();
  renderHistory();

  return Object.freeze({
    record(state: CCommandExecutionState): void {
      if (destroyed || !isTerminal(state)) return;
      const workspaceRecords = getOrCreate(records, workspaceKey(workspaceId));
      const sourceRecords = getOrCreate(
        workspaceRecords,
        fingerprintSource(state.projection.source),
      );
      sourceRecords.delete(state.submissionId);
      sourceRecords.set(state.submissionId, state);
      trimHistory(workspaceRecords);
      renderHistory();
    },
    getSelectedRunInput(): CCommandRuntimeInput | null {
      const runCase = selectedRunCase;
      return runCase === null
        ? null
        : Object.freeze({
            args: Object.freeze([...runCase.arguments]),
            stdin: runCase.stdin,
            fixtures: Object.freeze([]),
          });
    },
    setWorkspaceEntry(entryId: string | null): void {
      workspaceId = entryId;
      renderHistory();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      shell?.removeEventListener("workbench-locale-change", onLocaleChange);
      records.clear();
      scenarioPicker?.destroy();
      scenarioPicker = null;
      filesHost?.replaceChildren();
      casesHost?.replaceChildren();
      historyHost?.replaceChildren();
    },
  });
}

function getOrCreate<K, InnerKey, V>(map: Map<K, Map<InnerKey, V>>, key: K): Map<InnerKey, V> {
  let value = map.get(key);
  if (value === undefined) {
    value = new Map<InnerKey, V>();
    map.set(key, value);
  }
  return value;
}

function trimHistory(sourceGroups: Map<string, Map<string, CCommandExecutionState>>): void {
  const states = [...sourceGroups.values()].flatMap((records) =>
    [...records.entries()].map(([submissionId, state]) => ({
      records,
      submissionId,
      sequence: submissionSequence(state),
    })),
  );
  states.sort((left, right) => left.sequence - right.sequence);
  while (states.length > HISTORY_LIMIT) {
    const oldest = states.shift();
    if (oldest === undefined) break;
    oldest.records.delete(oldest.submissionId);
  }
  for (const [fingerprint, records] of sourceGroups) {
    if (records.size === 0) sourceGroups.delete(fingerprint);
  }
}

function workspaceKey(entryId: string | null): string {
  return entryId === null ? UNMANAGED_WORKSPACE : `workspace:${entryId}`;
}

function isTerminal(state: CCommandExecutionState): boolean {
  return (
    state.phase === "succeeded" ||
    state.phase === "compile-failed" ||
    state.phase === "run-failed" ||
    state.phase === "cancelled" ||
    state.phase === "internal-error"
  );
}

function scenarioLabel(scenario: AlgorithmScenarioDefinition, locale: InterfaceLocale): string {
  if (locale !== "en") return scenario.label;
  return (
    ENGLISH_SCENARIO_LABELS[scenario.id] ??
    scenario.id
      .replace(/^scenario\./u, "")
      .split(".")
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" · ")
  );
}

function scenarioPickerOptions(
  scenarios: readonly AlgorithmScenarioDefinition[],
  locale: InterfaceLocale,
): readonly ScenarioPickerOption[] {
  return Object.freeze(
    scenarios.map((scenario) =>
      Object.freeze({
        id: scenario.id,
        label: scenarioLabel(scenario, locale),
        group: scenarioFamilyLabel(scenario.family, locale),
        keywords: Object.freeze([
          scenario.label,
          scenarioLabel(scenario, "en"),
          scenario.description,
          scenario.id,
          scenarioFamilyLabel(scenario.family, "zh-CN"),
          scenarioFamilyLabel(scenario.family, "en"),
        ]),
      }),
    ),
  );
}

function scenarioFamilyLabel(
  family: AlgorithmScenarioDefinition["family"],
  locale: InterfaceLocale,
): string {
  const labels: Readonly<
    Record<InterfaceLocale, Readonly<Record<AlgorithmScenarioDefinition["family"], string>>>
  > = {
    "zh-CN": {
      sorting: "排序",
      searching: "搜索",
      recursion: "递归",
      "linked-list": "链表",
      tree: "树",
      graph: "图",
      "dynamic-programming": "动态规划",
    },
    en: {
      sorting: "Sorting",
      searching: "Searching",
      recursion: "Recursion",
      "linked-list": "Linked list",
      tree: "Tree",
      graph: "Graph",
      "dynamic-programming": "Dynamic programming",
    },
  };
  return labels[locale][family];
}

function runCasePreview(runCase: ScenarioRunCase | null, locale: InterfaceLocale): string {
  if (runCase === null) {
    return locale === "en"
      ? "stdin: (none)\nargs: (none)\nfixtures: (none)"
      : "stdin：（无）\nargs：（无）\nfixtures：（无）";
  }
  const args = runCase.arguments.length === 0 ? "(none)" : runCase.arguments.join(" ");
  const expected = runCase.expected.stdout.length === 0 ? "(empty)" : runCase.expected.stdout;
  return locale === "en"
    ? `stdin:\n${runCase.stdin}\nargs: ${args}\nfixtures: (none)\nexpected stdout:\n${expected}`
    : `stdin：\n${runCase.stdin}\nargs：${args === "(none)" ? "（无）" : args}\nfixtures：（无）\n预期输出：\n${expected === "(empty)" ? "（空）" : expected}`;
}

function historyStatus(state: CCommandExecutionState, locale: InterfaceLocale): string {
  const labels: Readonly<Record<CCommandExecutionState["phase"], readonly [string, string]>> = {
    compiling: ["编译中", "Compiling"],
    running: ["运行中", "Running"],
    succeeded: ["运行完成", "Completed"],
    "compile-failed": ["编译未通过", "Compile failed"],
    "run-failed": ["运行失败", "Run failed"],
    cancelled: ["已取消", "Cancelled"],
    "internal-error": ["运行器错误", "Runner error"],
  };
  const label = labels[state.phase];
  return locale === "en" ? label[1] : label[0];
}

function historyEvidence(state: CCommandExecutionState, locale: InterfaceLocale): string {
  const result = state.runResult;
  if (result === null) {
    return locale === "en" ? "No runtime evidence" : "无运行证据";
  }
  const duration = result.durationMs === undefined ? "—" : `${result.durationMs.toFixed(1)} ms`;
  const exit = result.exitCode === null ? (result.signal ?? "—") : String(result.exitCode);
  return locale === "en" ? `Exit ${exit} · ${duration}` : `退出 ${exit} · ${duration}`;
}

function historySource(state: CCommandExecutionState, locale: InterfaceLocale): string {
  const fingerprint = fingerprintSource(state.projection.source).slice(0, 8);
  const firstLine = state.projection.input.split("\n")[0]?.trim() ?? "";
  const summary = firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
  return locale === "en"
    ? `Source ${fingerprint} · ${summary}`
    : `源码 ${fingerprint} · ${summary}`;
}

function submissionSequence(state: CCommandExecutionState): number {
  const parsed = Number.parseInt(state.submissionId.replace(/^.*-/u, ""), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

const ENGLISH_SCENARIO_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "scenario.sorting.integers": "Integer sorting",
  "scenario.sorting.insertion": "Insertion sort · deterministic",
  "scenario.sorting.insertion.sorted": "Insertion sort · sorted",
  "scenario.sorting.insertion.reverse": "Insertion sort · reverse",
  "scenario.sorting.insertion.duplicates": "Insertion sort · duplicates",
  "scenario.sorting.quick": "Quicksort · deterministic",
  "scenario.sorting.quick.sorted": "Quicksort · sorted",
  "scenario.sorting.quick.reverse": "Quicksort · reverse",
  "scenario.sorting.quick.duplicates": "Quicksort · duplicates",
  "scenario.sorting.merge": "Merge sort · deterministic",
  "scenario.sorting.merge.sorted": "Merge sort · sorted",
  "scenario.sorting.merge.reverse": "Merge sort · reverse",
  "scenario.sorting.merge.duplicates": "Merge sort · duplicates",
  "scenario.searching.linear": "Linear search",
  "scenario.searching.maximum": "Maximum scan",
  "scenario.searching.minimum": "Minimum scan",
  "scenario.recursion.factorial": "Recursive factorial",
  "scenario.linked-list.reverse": "Reverse linked-list traversal",
  "scenario.tree.inorder": "Binary-search-tree inorder traversal",
  "scenario.graph.bfs-chain": "Chain graph BFS",
  "scenario.dynamic-programming.fibonacci": "Dynamic-programming Fibonacci",
});
