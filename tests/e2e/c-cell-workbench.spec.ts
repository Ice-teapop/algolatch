import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INITIAL_SOURCE = "int main(void) {\n  return 0;\n}\n";
const PREVIEW_FRAGMENT = 'int probe = 3;\nprintf("%d\\n", probe);';
const STREAMING_PROGRAM = [
  "#include <stdio.h>",
  "#include <time.h>",
  "",
  "int main(void) {",
  '  puts("first");',
  "  fflush(stdout);",
  "  const clock_t started = clock();",
  "  while ((double)(clock() - started) / CLOCKS_PER_SEC < 0.9) {",
  "  }",
  '  puts("second");',
  "  return 0;",
  "}",
].join("\n");
const TRACE_PROGRAM = [
  "#include <stdio.h>",
  "",
  "int main(void) {",
  "  int n;",
  '  if (scanf("%d", &n) != 1) {',
  "    return 1;",
  "  }",
  "  int total = 0;",
  "  for (int i = 1; i <= n; i += 1) {",
  "    total += i;",
  "  }",
  '  printf("%d\\n", total);',
  "  return 0;",
  "}",
].join("\n");
const developmentServerPort = process.env.PANEL_E2E_PORT ?? "5173";

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";
let profileRoot = "";
let projectDirectory = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-c-cell-workspace-"));
  profileRoot = await mkdtemp(join(tmpdir(), "algolatch-c-cell-profile-"));
  application = await launchApplication();
  page = await application.firstWindow();
  await page.addInitScript(() => {
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await acceptTrustedRunnerPrompts();

  await page.getByRole("button", { name: "新建", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作区条目" });
  await dialog.getByRole("combobox", { name: "条目类型" }).selectOption("project");
  await dialog.getByRole("textbox", { name: "条目名称" }).fill("C Cell 验收");
  await dialog.getByRole("button", { name: "创建并打开" }).click();

  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#file-name")).toHaveText("C Cell 验收.c");
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
  const projectIds = await readdir(join(workspaceRoot, "Projects"));
  expect(projectIds).toHaveLength(1);
  const projectId = projectIds[0];
  if (projectId === undefined) throw new Error("C Cell 验收项目目录不存在");
  projectDirectory = join(workspaceRoot, "Projects", projectId);
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(profileRoot, { recursive: true, force: true });
});

test("opens the 1280x800 workspace on C Cell and keeps the three-column shell bounded", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await expect(page.locator("#workbench-shell")).toHaveAttribute("data-command-view", "command");
  await expect(page.getByRole("tab", { name: "C Cell", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#system-shell-tab")).toHaveCount(0);
  await expect(page.locator("#c-command-panel")).toBeVisible();
  await expect(page.locator("#main-source-panel")).toBeHidden();
  await expect(page.locator(".c-command")).toBeVisible();
  await expect(page.locator("#project-files-host .project-files-host__file")).toHaveText("main.c");
  await expect(page.getByRole("tab", { name: "Flow", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const shell = page.locator("#build-layout");
  const center = page.locator("#center-pane");
  const left = page.locator("#left-pane");
  const right = page.locator("#right-pane");
  await expect(left).toBeVisible();
  await expect(center).toBeVisible();
  await expect(right).toBeVisible();
  await expectContained(left, shell);
  await expectContained(center, shell);
  await expectContained(right, shell);
  const overflow = await shell.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test("keeps C Cell operable at 100%, 125%, and 150% zoom", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const zoom of [1, 1.25, 1.5]) {
    await setZoomFactor(zoom);
    await expect(cCellInput()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(Math.ceil(1280 / zoom) + 2);
    const bounds = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(bounds.scrollWidth, `zoom ${String(zoom)}`).toBeLessThanOrEqual(bounds.clientWidth + 1);
  }

  const centerPane = page.locator("#center-pane");
  const leftPane = page.locator("#left-pane");
  const rightPane = page.locator("#right-pane");
  const scrim = page.locator("#narrow-panel-scrim");
  const projectToolsToggle = page.getByRole("button", { name: "切换项目工具" });
  const semanticMonitorToggle = page.getByRole("button", { name: "切换语义监督" });

  await projectToolsToggle.click();
  await expect(leftPane).toBeVisible();
  await expect(leftPane).toHaveAttribute("role", "dialog");
  await expect(leftPane).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#project-tools-close")).toBeVisible();
  await expect(centerPane).toHaveAttribute("inert", "");
  await expect(scrim).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("#left-pane")?.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("#left-pane")?.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.locator("#left-files-tab")).toBeFocused();
  const scrimBounds = await scrim.boundingBox();
  const leftPaneBounds = await leftPane.boundingBox();
  if (scrimBounds === null || leftPaneBounds === null) {
    throw new Error("窄屏抽屉或遮罩没有可测量边界");
  }
  await page.mouse.click(
    (leftPaneBounds.x + leftPaneBounds.width + scrimBounds.x + scrimBounds.width) / 2,
    scrimBounds.y + scrimBounds.height / 2,
  );
  await expect(leftPane).toBeHidden();
  await expect(centerPane).not.toHaveAttribute("inert", "");
  await expect(scrim).toBeHidden();
  await expect(projectToolsToggle).toBeFocused();

  await semanticMonitorToggle.click();
  await expect(rightPane).toBeVisible();
  await expect(rightPane).toHaveAttribute("role", "dialog");
  await expect(rightPane).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#semantic-monitor-close")).toBeVisible();
  await expect(centerPane).toHaveAttribute("inert", "");
  await expect(leftPane).toHaveAttribute("inert", "");
  await expect(scrim).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("#right-pane")?.contains(document.activeElement)),
    )
    .toBe(true);
  await page.locator("#semantic-monitor-close").click();
  await expect(rightPane).toBeHidden();
  await expect(semanticMonitorToggle).toBeFocused();

  await semanticMonitorToggle.click();
  await expect(rightPane).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rightPane).toBeHidden();
  await expect(centerPane).not.toHaveAttribute("inert", "");
  await expect(leftPane).not.toHaveAttribute("inert", "");
  await expect(scrim).toBeHidden();
  await expect(semanticMonitorToggle).toBeFocused();
  await setZoomFactor(1);
});

test("keeps the searchable case picker compact and inside the viewport", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const zoom of [1, 1.25, 1.5]) {
    await setZoomFactor(zoom);
    const leftPane = page.locator("#left-pane");
    if (!(await leftPane.isVisible())) {
      await page.getByRole("button", { name: "切换项目工具" }).click();
    }
    await page.getByRole("tab", { name: "案例", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "运行输入案例", exact: true });
    await picker.click();

    const popover = page.locator(".scenario-picker__popover");
    const listbox = page.getByRole("listbox", { name: "运行输入案例" });
    await expect(popover).toBeVisible();
    const geometry = await popover.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        height: bounds.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.top, `zoom ${String(zoom)}`).toBeGreaterThanOrEqual(7);
    expect(geometry.left, `zoom ${String(zoom)}`).toBeGreaterThanOrEqual(7);
    expect(geometry.right, `zoom ${String(zoom)}`).toBeLessThanOrEqual(geometry.viewportWidth - 7);
    expect(geometry.bottom, `zoom ${String(zoom)}`).toBeLessThanOrEqual(
      geometry.viewportHeight - 7,
    );
    expect(geometry.height, `zoom ${String(zoom)}`).toBeLessThanOrEqual(320);
    const scrolling = await listbox.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrolling.scrollHeight, `zoom ${String(zoom)}`).toBeGreaterThan(scrolling.clientHeight);

    const search = page.getByRole("combobox", {
      name: "筛选运行输入案例",
      exact: true,
    });
    await search.fill("quick");
    await expect(listbox.locator(".scenario-picker__group")).toHaveCount(1);
    await expect(listbox.getByRole("option")).toHaveCount(4);
    await search.press("Escape");
    await expect(popover).toBeHidden();
  }
  await setZoomFactor(1);
  if (!(await page.locator("#left-pane").isVisible())) {
    await page.getByRole("button", { name: "切换项目工具" }).click();
  }
  await page.getByRole("tab", { name: "文件", exact: true }).click();
});

test("streams and finalizes printf output beside its C Cell with measured first-result time", async () => {
  test.setTimeout(45_000);
  const input = cCellInput();
  await input.fill(STREAMING_PROGRAM);
  const submittedAt = Date.now();
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  const submission = page.locator(".c-command__submission").last();
  await expect(submission).toHaveAttribute("data-state", "running", { timeout: 15_000 });
  await expect(
    submission.locator('.c-command__output[data-output-kind="stdout"] pre'),
  ).toContainText("first");
  const observedFirstOutputMs = Date.now() - submittedAt;
  await expect(submission).toHaveAttribute("data-state", "running");

  await expect(submission).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 });
  const stdout = submission.locator('.c-command__output[data-output-kind="stdout"] pre');
  await expect(stdout).toHaveText("first\nsecond\n");
  await expect(submission.locator(".c-command__evidence")).toContainText("退出码");
  await expect(submission.locator(".c-command__evidence")).toContainText("0");
  await expect(page.locator("#bottom-pane")).toBeHidden();

  const firstResultMs = Number(
    await page.locator(".c-command").getAttribute("data-first-result-ms"),
  );
  const firstOutputMs = Number(
    await page.locator(".c-command").getAttribute("data-first-output-ms"),
  );
  expect(Number.isFinite(firstOutputMs)).toBe(true);
  expect(firstOutputMs).toBeGreaterThan(0);
  expect(firstOutputMs).toBeLessThanOrEqual(observedFirstOutputMs + 500);
  expect(firstOutputMs).toBeLessThan(firstResultMs);
  expect(Number.isFinite(firstResultMs)).toBe(true);
  expect(firstResultMs).toBeGreaterThan(0);
  expect(firstResultMs).toBeLessThan(15_000);

  await page.getByRole("tab", { name: "历史", exact: true }).click();
  const history = page.locator("#workspace-history-host .workspace-history-host__entry").first();
  await expect(history).toHaveAttribute("data-state", "succeeded");
  await expect(history).toContainText("运行完成");
  await expect(history).toContainText("退出 0");
  await expect(history).toContainText("ms");
  await page.getByRole("tab", { name: "文件", exact: true }).click();
});

test("runs a C Cell with the exact input selected in Cases", async () => {
  await page.getByRole("tab", { name: "案例", exact: true }).click();
  await chooseRunInputCase("scenario.recursion.factorial");
  await expect(page.locator("#workspace-cases-host")).toContainText("stdin");
  await expect(page.locator("#workspace-cases-host")).toContainText("4");

  const input = cCellInput();
  await input.fill(
    [
      "#include <stdio.h>",
      "int main(void) {",
      "  int n;",
      '  if (scanf("%d", &n) != 1) return 1;',
      '  printf("%d\\n", n);',
      "  return 0;",
      "}",
    ].join("\n"),
  );
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  const submission = page.locator(".c-command__submission").last();
  await expect(submission).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 });
  await expect(submission.locator('.c-command__output[data-output-kind="stdout"] pre')).toHaveText(
    "4\n",
  );
  await page.getByRole("tab", { name: "文件", exact: true }).click();
});

test("uses the C Cell inline stdin as an explicit override for the selected case", async () => {
  await page.getByRole("tab", { name: "案例", exact: true }).click();
  await chooseRunInputCase("scenario.recursion.factorial");
  await page.getByRole("tab", { name: "文件", exact: true }).click();
  const input = cCellInput();
  await input.fill(
    [
      "#include <stdio.h>",
      "int main(void) {",
      "  int n;",
      '  if (scanf("%d", &n) != 1) return 1;',
      '  printf("%d\\n", n);',
      "  return 0;",
      "}",
    ].join("\n"),
  );

  const stdin = page.getByRole("textbox", { name: "标准输入 stdin", exact: true });
  await expect(stdin).toBeVisible();
  await stdin.fill("7\n");
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  const submission = page.locator(".c-command__submission").last();
  await expect(submission).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 });
  await expect(submission.locator('.c-command__output[data-output-kind="stdout"] pre')).toHaveText(
    "7\n",
  );
});

test("keeps the last valid Flow while typing and restores the C Cell preview after main.c", async () => {
  const input = cCellInput();
  await input.fill(PREVIEW_FRAGMENT);
  const previewToolbar = page.locator("#semantic-flow-panel .canvas-toolbar");
  await expect(previewToolbar).toHaveAttribute("data-presentation", "preview");
  await expect(previewToolbar.locator(".canvas-toolbar__source-badge")).toHaveText("C Cell · 只读");
  await expect(previewToolbar).toContainText("C Cell 只读投影");
  await expect(
    page.locator(".flow-node .flow-node__label").filter({ hasText: "int probe = 3;" }),
  ).toBeVisible();

  await input.fill("if (");
  await expect(page.locator(".c-command__projection-status")).toHaveText("正在输入");
  await expect(previewToolbar).toHaveAttribute("data-presentation", "preview");
  await expect(
    page.locator(".flow-node .flow-node__label").filter({ hasText: "int probe = 3;" }),
  ).toBeVisible();

  await input.fill(PREVIEW_FRAGMENT);
  await expect(
    page.locator(".flow-node .flow-node__label").filter({ hasText: "int probe = 3;" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "main.c", exact: true }).click();
  await expect(page.locator("#main-source-panel")).toBeVisible();
  await expect(previewToolbar).not.toHaveAttribute("data-presentation", "preview");
  await expect(previewToolbar.locator(".canvas-toolbar__source-badge")).toHaveText("main.c");
  await expect(
    page.locator(".flow-node .flow-node__label").filter({ hasText: "return 0;" }),
  ).toBeVisible();
  await expect(
    page.locator(".flow-node .flow-node__label").filter({ hasText: "int probe = 3;" }),
  ).toHaveCount(0);

  await page.getByRole("tab", { name: "C Cell", exact: true }).click();
  await expect(previewToolbar).toHaveAttribute("data-presentation", "preview");
  await expect(
    page.locator(".flow-node .flow-node__label").filter({ hasText: "int probe = 3;" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Blocks", exact: true }).click();
  await expect(page.locator("#explanation-panel .semantic-monitor__source-note")).toContainText(
    "项目 main.c",
  );
  await page.getByRole("tab", { name: "Flow", exact: true }).click();
});

test("previews the exact main.c replacement and leaves disk source unchanged after cancel", async () => {
  const input = cCellInput();
  await input.fill('puts("write guard");');
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  const submission = page.locator(".c-command__submission").last();
  await expect(submission).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 });
  await submission.locator('[data-command-action="write-main"]').click();

  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff-text").first()).toContainText("return 0;");
  await expect(dialog.locator(".edit-panel__diff-text").last()).toContainText(
    'puts("write guard");',
  );
  await expect(readProjectSource()).resolves.toBe(INITIAL_SOURCE);
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  await expect(readProjectSource()).resolves.toBe(INITIAL_SOURCE);
  await expectEditorSource(INITIAL_SOURCE);
});

test("maps wrapper diagnostics back to the C Cell instead of generated source lines", async () => {
  const input = cCellInput();
  await input.fill('printf("%d\\n", );');
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  const submission = page.locator(".c-command__submission").last();
  await expect(submission).toHaveAttribute("data-state", "compile-failed", {
    timeout: 15_000,
  });
  const diagnostics = submission.locator('.c-command__output[data-output-kind="diagnostics"] pre');
  await expect(diagnostics).toContainText("运行单元:1:");
  await expect(diagnostics).not.toContainText("c-cell.c:");
});

test("starts a real Trace from C Cell and switches between the three evidence views", async () => {
  test.setTimeout(45_000);
  await page.getByRole("tab", { name: "案例", exact: true }).click();
  await chooseRunInputCase("scenario.recursion.factorial");
  await page.getByRole("tab", { name: "文件", exact: true }).click();
  const input = cCellInput();
  await input.fill(TRACE_PROGRAM);
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  const submission = page.locator(".c-command__submission").last();
  await expect(submission).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 });
  await expect(submission.locator('.c-command__output[data-output-kind="stdout"] pre')).toHaveText(
    "10\n",
  );
  await submission.locator('[data-command-action="write-main"]').click();
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(readProjectSource).toBe(`${TRACE_PROGRAM}\n`);
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
  await page.getByRole("tab", { name: "案例", exact: true }).click();
  await clearRunInputCase();
  await page.getByRole("tab", { name: "文件", exact: true }).click();
  await page.locator("#main-source-tab").click();

  const observe = page.locator("#trace-observe-action");
  await expect(observe).toBeVisible();
  await expect(observe).toBeEnabled();
  await expect(page.locator("#bottom-pane")).toBeHidden();
  await observe.click();
  await expect(page.locator("#bottom-pane")).toBeVisible();
  await expect(page.locator("#runtime-panel-toggle")).toHaveAttribute("aria-expanded", "true");
  const manualInput = page.locator("#manual-run-input-host .manual-run-input");
  const manualInputEditor = manualInput.locator(".manual-run-input__editor");
  await expect(manualInputEditor).toBeVisible();
  const [inputBounds, centerBounds, monitorBounds] = await Promise.all([
    manualInputEditor.boundingBox(),
    page.locator("#center-pane").boundingBox(),
    page.locator("#right-pane").boundingBox(),
  ]);
  expect(inputBounds).not.toBeNull();
  expect(centerBounds).not.toBeNull();
  expect(monitorBounds).not.toBeNull();
  const inputRight = inputBounds!.x + inputBounds!.width;
  const centerRight = centerBounds!.x + centerBounds!.width;
  expect(inputRight).toBeLessThanOrEqual(centerRight + 1);
  expect(inputRight).toBeLessThanOrEqual(monitorBounds!.x + 1);
  await manualInput.getByRole("textbox", { name: "标准输入 stdin" }).fill("5");
  await manualInput.getByRole("button", { name: "使用此输入运行" }).click();

  const trace = page.locator(".trace-panel");
  await expect(trace).toHaveAttribute("data-status", "completed", { timeout: 20_000 });
  const chart = trace.locator(".trace-panel__chart");
  await expect(chart).toHaveAttribute("data-chart-view", "timeline");
  await expect
    .poll(async () => Number(await chart.getAttribute("data-point-count")))
    .toBeGreaterThan(0);
  await expect(trace.locator(".trace-panel__chart-caption")).toContainText("步序 × 行号");

  await trace.getByRole("button", { name: "行命中", exact: true }).click();
  await expect(chart).toHaveAttribute("data-chart-view", "line-hits");
  await expect
    .poll(async () => Number(await chart.getAttribute("data-bar-count")))
    .toBeGreaterThan(0);
  await expect(trace.locator(".trace-panel__chart-caption")).toHaveText("行命中直方图");

  await trace.getByRole("button", { name: "分支结果", exact: true }).click();
  await expect(chart).toHaveAttribute("data-chart-view", "branches");
  await expect
    .poll(async () => Number(await chart.getAttribute("data-bar-count")))
    .toBeGreaterThan(0);
  await expect(trace.locator(".trace-panel__chart-caption")).toContainText("true / false");
});

/** The case picker is a custom listbox; clearing it means choosing its explicit empty row. */
async function clearRunInputCase(): Promise<void> {
  const picker = page.getByRole("combobox", { name: "运行输入案例", exact: true });
  await picker.click();
  const listbox = page.getByRole("listbox", { name: "运行输入案例" });
  await expect(listbox).toBeVisible();
  await listbox.locator('[role="option"][data-scenario-id=""]').click();
  await expect(listbox).toBeHidden();
}

async function chooseRunInputCase(scenarioId: string): Promise<void> {
  const picker = page.getByRole("combobox", { name: "运行输入案例", exact: true });
  await picker.click();
  const search = page.getByRole("combobox", {
    name: "筛选运行输入案例",
    exact: true,
  });
  await search.fill(scenarioId);
  const listbox = page.getByRole("listbox", { name: "运行输入案例" });
  await expect(listbox).toBeVisible();
  await expect(listbox.locator(".scenario-picker__group")).toHaveCount(1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".scenario-picker__popover")).toBeHidden();
}

test("keeps session history isolated when a second workspace is opened", async () => {
  const mainSplitter = page.locator(
    "#build-layout > .resizable-layout__splitter[data-splitter-for='left']",
  );
  await mainSplitter.focus();
  await page.keyboard.press("Home");
  await expect(mainSplitter).toHaveAttribute("aria-valuenow", "150");

  await page.getByRole("tab", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作区条目" });
  await dialog.getByRole("combobox", { name: "条目类型" }).selectOption("project");
  await dialog.getByRole("textbox", { name: "条目名称" }).fill("C Cell 隔离验收");
  await dialog.getByRole("button", { name: "创建并打开" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator("#file-name")).toHaveText("C Cell 隔离验收.c");
  await expect(mainSplitter).toHaveAttribute("aria-valuenow", "240");
  await page.getByRole("tab", { name: "历史", exact: true }).click();
  await expect(page.locator("#workspace-history-host .workspace-history-host__entry")).toHaveCount(
    0,
  );
});

// C Cell owns its local Run action. Project Run/Trace belongs to main.c and must not compete
// with the draft on the default surface; changing tabs swaps the single primary action.
test("shows exactly one run target for C Cell and main.c, then reveals project output", async () => {
  await acceptTrustedRunnerPrompts();
  await page.getByRole("tab", { name: "C Cell", exact: true }).click();
  await expect(page.locator("#workbench-shell")).toHaveAttribute("data-command-view", "command");
  await expect(page.locator(".c-command__run")).toBeVisible();
  await expect(page.locator(".c-command__run")).toHaveText("运行此单元");
  await expect(page.locator("#trace-primary-action")).toBeHidden();

  const toggle = page.locator("#runtime-panel-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(page.locator("#bottom-pane")).toBeHidden();
  const outputPanel = page.locator("details.runtime-advanced");
  if ((await outputPanel.getAttribute("open")) !== null) {
    await outputPanel.locator(":scope > summary").click();
  }

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#bottom-pane")).toBeVisible();
  const collapsedRuntimeGeometry = await page.locator("#run-panel").evaluate((host) => {
    const hostBounds = host.getBoundingClientRect();
    const children = [...host.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .filter((child) => {
        const bounds = child.getBoundingClientRect();
        return getComputedStyle(child).display !== "none" && bounds.width > 0;
      })
      .map((child) => child.getBoundingClientRect())
      .sort((left, right) => left.left - right.left);
    const gaps = children.flatMap((bounds, index) => {
      const previousRight = index === 0 ? hostBounds.left : children[index - 1]!.right;
      return [Math.max(0, bounds.left - previousRight)];
    });
    gaps.push(Math.max(0, hostBounds.right - (children.at(-1)?.right ?? hostBounds.left)));
    return {
      maximumUnownedGap: Math.max(...gaps),
      outputWidth: host.querySelector(".runtime-advanced")?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(collapsedRuntimeGeometry.maximumUnownedGap).toBeLessThanOrEqual(1);
  expect(collapsedRuntimeGeometry.outputWidth).toBeCloseTo(118, 0);
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#bottom-pane")).toBeHidden();

  await page.getByRole("tab", { name: "main.c", exact: true }).click();
  await expect(page.locator("#workbench-shell")).toHaveAttribute("data-command-view", "source");
  await expect(page.locator(".c-command__run")).toBeHidden();
  const run = page.locator("#trace-primary-action");
  await expect(run).toBeVisible();
  await run.click();

  await expect(page.locator("#bottom-pane")).toBeVisible();
  await expect(page.locator("details.runtime-advanced")).toHaveAttribute("open", "");
  const runPanel = page.locator("#run-panel .run-panel");
  await expect(runPanel).toHaveAttribute("data-state", "success", { timeout: 15_000 });
  await expect(page.locator('[data-run-field="exit-code"]')).toBeVisible();
  await expect(page.locator('[data-run-field="exit-code"]')).toHaveText("0");
});

function cCellInput(): Locator {
  return page.getByRole("textbox", { name: "输入 C 程序、语句或控制块" });
}

async function launchApplication(): Promise<ElectronApplication> {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return electron.launch({
    args: [".", `--user-data-dir=${profileRoot}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${developmentServerPort}/`,
    },
  });
}

async function acceptTrustedRunnerPrompts(): Promise<void> {
  if (application === undefined) throw new Error("Electron 应用尚未启动");
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
}

async function expectContained(child: Locator, parent: Locator): Promise<void> {
  const childBounds = await child.boundingBox();
  const parentBounds = await parent.boundingBox();
  if (childBounds === null || parentBounds === null) {
    throw new Error("工作台区域没有可测量边界");
  }
  const tolerance = 1;
  expect(childBounds.x).toBeGreaterThanOrEqual(parentBounds.x - tolerance);
  expect(childBounds.y).toBeGreaterThanOrEqual(parentBounds.y - tolerance);
  expect(childBounds.x + childBounds.width).toBeLessThanOrEqual(
    parentBounds.x + parentBounds.width + tolerance,
  );
  expect(childBounds.y + childBounds.height).toBeLessThanOrEqual(
    parentBounds.y + parentBounds.height + tolerance,
  );
}

async function setZoomFactor(factor: number): Promise<void> {
  const currentApplication = application;
  if (currentApplication === undefined) throw new Error("Electron 应用尚未启动");
  await currentApplication.evaluate(({ BrowserWindow }, zoomFactor) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("找不到 Electron 主窗口");
    window.webContents.setZoomFactor(zoomFactor);
  }, factor);
}

async function readProjectSource(): Promise<string> {
  return readFile(join(projectDirectory, "main.c"), "utf8");
}

async function expectEditorSource(source: string): Promise<void> {
  await expect.poll(editorText).toBe(source);
}

async function editorText(): Promise<string> {
  return page
    .locator("#code-pane .cm-line")
    .evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join("\n"));
}
