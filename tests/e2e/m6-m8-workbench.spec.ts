import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pressSplitterKey,
  showBlockPalette,
  showFlowCanvas,
  showProjectTools,
  showRuntimePanel,
  showSourceEditor,
} from "./support/c-cell-layout.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

const SOURCE = `${[
  "int main(void) {",
  "  int x = 1;",
  "  if (x) {",
  "    x++;",
  "  }",
  "  else {",
  "    x--;",
  "  }",
  "  return 0;",
  "}",
].join("\n")}\n`;

const SOURCE_WITH_EDGE_INSERT = `${[
  "int main(void) {",
  "  int value = 0;",
  "  int x = 1;",
  "  if (x) {",
  "    x++;",
  "  }",
  "  else {",
  "    x--;",
  "  }",
  "  return 0;",
  "}",
].join("\n")}\n`;

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";
let projectDirectory = "";
const developmentServerPort = process.env.PANEL_E2E_PORT ?? "5173";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "c-block-m6-m8-e2e-"));
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  application = await electron.launch({
    args: [".", `--user-data-dir=${e2eProfileRoot}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${developmentServerPort}/`,
    },
  });
  page = await application.firstWindow();
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");

  await page.getByRole("button", { name: "新建", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建工作区条目" });
  await create.getByRole("combobox", { name: "条目类型" }).selectOption("project");
  await create.getByRole("textbox", { name: "条目名称" }).fill("M6 自由画布");
  await create.getByRole("button", { name: "创建并打开" }).click();
  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const projectIds = await readdir(join(workspaceRoot, "Projects"));
  const projectId = projectIds[0];
  if (projectId === undefined) throw new Error("M6 E2E 项目目录不存在");
  projectDirectory = join(workspaceRoot, "Projects", projectId);

  await showSourceEditor(page);
  const content = page.locator("#code-pane .cm-content");
  await content.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(SOURCE);
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "saved");
  await expect.poll(() => readFile(join(projectDirectory, "main.c"), "utf8")).toBe(SOURCE);

  await requireApplication().evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("uses a reduced Dock, opens Library directly and exposes local interface preferences", async () => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("[data-menu-root-trigger]")).toHaveText([
    "设置",
    "积木",
    "Library",
    "布局",
  ]);

  await menuTrigger("Library").click();
  await expect(page.locator("#software-library-panel")).toBeVisible();
  await page.locator("[data-library-branch-id='c-syntax']").click();
  await expect(
    page.locator("[data-library-branch-id='c-syntax'][aria-current='true']"),
  ).toBeVisible();
  await expect(page.locator(".software-library__detail h2")).not.toHaveText("");
  await page.getByRole("searchbox", { name: "全文搜索 Library" }).fill("for");
  await expect(page.locator(".software-library__results mark").first()).toBeVisible();

  await openMenuBranch("设置", "通用");
  const drawer = page.locator("#workbench-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("语言、背景和明暗主题只影响本机界面");
  await page.locator("#interface-background").selectOption("paper");
  await expect(page.locator("html")).toHaveAttribute("data-background", "paper");
  await page.locator("#interface-language").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect
    .poll(() =>
      requireApplication().evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getTitle(),
      ),
    )
    .toBe("AlgoLatch");
  await expect(page.locator("[data-menu-root-trigger]")).toHaveText([
    "Settings",
    "Blocks",
    "Library",
    "Layout",
  ]);
  await page.locator("#interface-language").selectOption("zh-CN");
  await expect
    .poll(() =>
      requireApplication().evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getTitle(),
      ),
    )
    .toBe("AlgoLatch");
  await page.locator("#interface-background").selectOption("white");
  await page.getByRole("button", { name: "切换为深色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "切换为浅色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "关闭设置" }).click();
});

test("opens the analysis workspace directly from the text Dock", async () => {
  const analysisTab = page.getByRole("tab", { name: "分析", exact: true });
  await expect(analysisTab).toBeVisible();
  await analysisTab.click();

  await expect(analysisTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#analysis-panel")).toBeVisible();
  await expect(page.locator(".analysis-dashboard")).toBeVisible();
  await expect(page.locator(".analysis-dashboard h1")).toHaveText("分析");
  await expect(page.locator(".analysis-dashboard__trend")).toContainText("输入规模 n");
});

test("keeps root scrolling locked while every meaningful region is independently resizable", async () => {
  // The left project-tools column intentionally becomes an overlay drawer below 1100px, where
  // its structural splitter is hidden. This test exercises the desktop multi-pane resizer contract.
  await page.setViewportSize({ width: 1180, height: 780 });
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  await showProjectTools(page);
  await showRuntimePanel(page);
  await page.locator("#run-tab").click();
  const splitters = page.locator(".resizable-layout__splitter");
  await expect(splitters).toHaveCount(7);
  await expect(page.locator("#build-layout > .resizable-layout__splitter")).toHaveCount(1);
  await expect(page.locator("#work-area > .resizable-layout__splitter")).toHaveCount(1);
  await expect(page.locator("#primary-workspace > .resizable-layout__splitter")).toHaveCount(1);
  await expect(page.locator("#left-pane > .resizable-layout__splitter")).toHaveCount(1);
  await expect(page.locator("#center-pane > .resizable-layout__splitter")).toHaveCount(0);
  await expect(page.locator("#right-pane > .resizable-layout__splitter")).toHaveCount(1);
  await expect(page.locator("#run-panel > .resizable-layout__splitter")).toHaveCount(2);

  const workAreaBounds = await page.locator("#work-area").boundingBox();
  const runtimeBounds = await page.locator("#bottom-pane").boundingBox();
  if (workAreaBounds === null || runtimeBounds === null) {
    throw new Error("工作区或运行区不可见");
  }
  expect(Math.abs(runtimeBounds.x - workAreaBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(runtimeBounds.width - workAreaBounds.width)).toBeLessThanOrEqual(1);

  const bottomSplitter = page.locator(
    "#work-area > .resizable-layout__splitter[data-splitter-for='primary']",
  );
  const primarySizeBefore = Number(await bottomSplitter.getAttribute("aria-valuenow"));
  const bottomSplitterBounds = await bottomSplitter.boundingBox();
  if (bottomSplitterBounds === null) throw new Error("运行区高度分隔线不可用");
  await page.mouse.move(
    bottomSplitterBounds.x + bottomSplitterBounds.width / 2,
    bottomSplitterBounds.y + bottomSplitterBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bottomSplitterBounds.x + bottomSplitterBounds.width / 2,
    bottomSplitterBounds.y + bottomSplitterBounds.height / 2 - 40,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await bottomSplitter.getAttribute("aria-valuenow")))
    .toBeLessThan(primarySizeBefore);
  const resizedRuntimeBounds = await page.locator("#bottom-pane").boundingBox();
  expect(resizedRuntimeBounds?.height ?? runtimeBounds.height).toBeGreaterThan(
    runtimeBounds.height,
  );

  const mainSplitter = page.locator(
    "#build-layout > .resizable-layout__splitter[data-splitter-for='left']",
  );
  const minimumSize = Number(await mainSplitter.getAttribute("aria-valuemin"));
  await pressSplitterKey(mainSplitter, "Home");
  await expect(mainSplitter).toHaveAttribute("aria-valuenow", String(minimumSize));
  await pressSplitterKey(mainSplitter, "ArrowRight");
  await expect(mainSplitter).toHaveAttribute("aria-valuenow", String(minimumSize + 8));

  const outputPanel = page.locator(".runtime-advanced");
  await outputPanel.locator(":scope > summary").click();
  await expect(outputPanel).toHaveAttribute("open", "");
  const scenarioSplitter = page.locator(
    "#run-panel > .resizable-layout__splitter[data-splitter-for='scenario']",
  );
  const traceSplitter = page.locator(
    "#run-panel > .resizable-layout__splitter[data-splitter-for='trace']",
  );
  await expect(scenarioSplitter).toBeVisible();
  await expect(traceSplitter).toBeHidden();
  const outputBefore = await outputPanel.boundingBox();
  const scenarioSizeBefore = Number(await scenarioSplitter.getAttribute("aria-valuenow"));
  const runtimeSplitterBounds = await scenarioSplitter.boundingBox();
  if (outputBefore === null || runtimeSplitterBounds === null) {
    throw new Error("输出与诊断分隔线不可用");
  }
  await page.mouse.move(
    runtimeSplitterBounds.x + runtimeSplitterBounds.width / 2,
    runtimeSplitterBounds.y + runtimeSplitterBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    runtimeSplitterBounds.x + runtimeSplitterBounds.width / 2 + 48,
    runtimeSplitterBounds.y + runtimeSplitterBounds.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await scenarioSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(scenarioSizeBefore);
  const outputAfter = await outputPanel.boundingBox();
  expect(outputAfter?.width ?? outputBefore.width).toBeLessThan(outputBefore.width);

  // The three independently scrolling regions now sit behind one tab each, in three different
  // columns, so all three have to be on screen before their scroll behaviour can be compared.
  await showBlockPalette(page);
  await showSourceEditor(page);
  await showFlowCanvas(page);
  const scrolling = await page.evaluate(() => {
    const palette = document.querySelector<HTMLElement>("#block-palette .block-palette__list");
    const code = document.querySelector<HTMLElement>("#code-pane .cm-scroller");
    const canvas = document.querySelector<HTMLElement>("#flow-canvas");
    if (palette === null || code === null || canvas === null) {
      throw new Error("独立滚动区域未挂载");
    }
    const codeScrollTopBefore = code.scrollTop;
    palette.scrollTop = 120;
    return {
      rootLocked:
        document.documentElement.scrollHeight === document.documentElement.clientHeight &&
        document.body.scrollHeight === document.body.clientHeight,
      paletteOverflow: getComputedStyle(palette).overflowY,
      paletteScrollable: palette.scrollHeight > palette.clientHeight,
      paletteScrollTop: palette.scrollTop,
      codeOverflow: getComputedStyle(code).overflowY,
      codeScrollTopBefore,
      codeScrollTopAfter: code.scrollTop,
      canvasOverflow: getComputedStyle(canvas).overflow,
    };
  });
  expect(scrolling.rootLocked).toBe(true);
  expect(scrolling.paletteOverflow).toBe("auto");
  expect(scrolling.paletteScrollable).toBe(true);
  expect(scrolling.paletteScrollTop).toBeGreaterThan(0);
  expect(scrolling.codeOverflow).toBe("auto");
  expect(scrolling.codeScrollTopAfter).toBe(scrolling.codeScrollTopBefore);
  expect(scrolling.canvasOverflow).toBe("hidden");
});

test("fills a tall workspace after restoring a compact primary pane", async () => {
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  const primarySplitter = page.locator(
    "#work-area > .resizable-layout__splitter[data-splitter-for='primary']",
  );
  const originalViewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  await primarySplitter.focus();
  await page.keyboard.press("Home");
  await expect(primarySplitter).toHaveAttribute("aria-valuenow", "320");
  await page.setViewportSize({ width: 1600, height: 1200 });

  try {
    await expect(page.locator("#workspace-lesson-strip")).toBeHidden();
    const bounds = await page.evaluate(() => {
      const rectangle = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`缺少布局节点：${selector}`);
        const value = element.getBoundingClientRect();
        return Object.freeze({ top: value.top, bottom: value.bottom, height: value.height });
      };
      return Object.freeze({
        viewportBottom: window.innerHeight,
        pages: rectangle("#workbench-pages"),
        buildPanel: rectangle("#build-panel"),
        buildHost: rectangle("#build-host"),
        layout: rectangle("#build-layout"),
        workArea: rectangle("#work-area"),
        bottomPane: rectangle("#bottom-pane"),
        runtimeGrid: rectangle(".runtime-grid"),
      });
    });

    expect(bounds.pages.bottom).toBeCloseTo(bounds.viewportBottom, 0);
    expect(bounds.buildPanel.bottom).toBeCloseTo(bounds.pages.bottom, 0);
    expect(bounds.buildHost.bottom).toBeCloseTo(bounds.buildPanel.bottom, 0);
    expect(bounds.layout.bottom).toBeCloseTo(bounds.pages.bottom, 0);
    expect(bounds.workArea.bottom).toBeCloseTo(bounds.layout.bottom, 0);
    expect(bounds.bottomPane.bottom).toBeCloseTo(bounds.workArea.bottom, 0);
    expect(bounds.runtimeGrid.bottom).toBeCloseTo(bounds.bottomPane.bottom, 0);
    expect(bounds.bottomPane.height).toBeCloseTo(620, 0);

    const splitterBefore = await primarySplitter.boundingBox();
    if (splitterBefore === null) throw new Error("工作区纵向分隔线不可见");
    await page.mouse.move(
      splitterBefore.x + splitterBefore.width / 2,
      splitterBefore.y + splitterBefore.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      splitterBefore.x + splitterBefore.width / 2,
      splitterBefore.y + splitterBefore.height / 2 - 40,
      { steps: 4 },
    );
    await page.mouse.up();
    const splitterAfterBlockedDrag = await primarySplitter.boundingBox();
    if (splitterAfterBlockedDrag === null) {
      throw new Error("工作区纵向分隔线钳制后不可见");
    }
    expect(splitterAfterBlockedDrag.y).toBeCloseTo(splitterBefore.y, 0);

    await primarySplitter.focus();
    await page.keyboard.press("ArrowDown");
    const splitterAfter = await primarySplitter.boundingBox();
    if (splitterAfter === null) throw new Error("工作区纵向分隔线调整后不可见");
    expect(splitterAfter.y - splitterBefore.y).toBeCloseTo(8, 0);
    await page.keyboard.press("Home");
  } finally {
    await page.setViewportSize(originalViewport);
  }
});

test("lets Canvas Focus consume the full workbench height", async () => {
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  await openMenuBranch("布局", "专注画布");

  await expect(page.locator("#bottom-pane")).toBeHidden();
  await expect(page.locator("#inspector-stack")).toBeHidden();

  const bounds = await page.evaluate(() => {
    const read = (selector: string): DOMRect => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`缺少布局元素：${selector}`);
      return element.getBoundingClientRect();
    };
    const workArea = read("#work-area");
    const primary = read("#primary-workspace");
    const canvas = read("#center-pane");
    const code = read("#code-panel");
    const right = read("#right-pane");
    return {
      workAreaHeight: workArea.height,
      primaryHeight: primary.height,
      canvasHeight: canvas.height,
      codeHeight: code.height,
      rightHeight: right.height,
    };
  });

  expect(Math.abs(bounds.primaryHeight - bounds.workAreaHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.canvasHeight - bounds.workAreaHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.codeHeight - bounds.rightHeight)).toBeLessThanOrEqual(1);

  await openMenuBranch("布局", "搭建");
  await expect(page.locator("#left-pane")).toBeVisible();
  await expect(page.locator("#right-pane")).toBeVisible();
  // C Cell owns inline output, so restoring Build must not resurrect the legacy runtime pane.
  await expect(page.locator("#bottom-pane")).toBeHidden();
});

test("drags a projected node freely and restores its sidecar position after reload", async () => {
  // Free dragging and edge clamping need canvas room: in the docked layout the canvas is one
  // 333px column, where the detail window starts clamped against the right edge. Canvas Focus
  // is the app's own way to give it the workbench, so the test uses it rather than a wider window.
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  await showFlowCanvas(page);
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
  await expect(page.locator(".flow-node[data-node-kind='branch']")).toHaveCount(1);
  const node = page.locator(".flow-node[data-node-kind='declaration']").first();
  await expect(node).toBeVisible();
  await node.click();
  await expect(node).toHaveAttribute("aria-selected", "true");
  const detail = page.getByRole("region", { name: "节点详情" });
  await expect(detail).toBeHidden();
  await node.dblclick();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("textbox", { name: /的 C 源码$/u })).toHaveValue(/int x = 1;/u);
  await expect(detail).toContainText("静态诊断：");
  await expect(detail).toContainText("运行证据：");
  await expect(detail).toContainText("main.c 的精确投影");
  const detailBefore = await detail.boundingBox();
  const detailHeader = detail.locator(".flow-detail__header");
  const detailHeaderBounds = await detailHeader.boundingBox();
  if (detailBefore === null || detailHeaderBounds === null) {
    throw new Error("节点详情窗口不可拖动");
  }
  await page.mouse.move(
    detailHeaderBounds.x + Math.min(80, detailHeaderBounds.width / 3),
    detailHeaderBounds.y + detailHeaderBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    detailHeaderBounds.x + Math.min(80, detailHeaderBounds.width / 3) - 56,
    detailHeaderBounds.y + detailHeaderBounds.height / 2 + 36,
    { steps: 4 },
  );
  await page.mouse.up();
  const detailAfter = await detail.boundingBox();
  // The canvas is a single column now, so the window opens against the right edge and free
  // movement is only observable towards the left. Clamping is asserted right below.
  expect(detailAfter?.x ?? detailBefore.x).toBeLessThan(detailBefore.x);
  expect(detailAfter?.y ?? detailBefore.y).toBeGreaterThan(detailBefore.y);
  const canvasBounds = await page.locator(".flow-canvas").boundingBox();
  const movedHeaderBounds = await detailHeader.boundingBox();
  if (canvasBounds === null || movedHeaderBounds === null) {
    throw new Error("节点详情或画布边界不可用");
  }
  await page.mouse.move(
    movedHeaderBounds.x + Math.min(80, movedHeaderBounds.width / 3),
    movedHeaderBounds.y + movedHeaderBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width + 400,
    canvasBounds.y + canvasBounds.height + 400,
    {
      steps: 4,
    },
  );
  await page.mouse.up();
  const clampedDetail = await detail.boundingBox();
  if (clampedDetail === null) throw new Error("节点详情窗口在拖动后消失");
  expect(clampedDetail.x + clampedDetail.width).toBeLessThanOrEqual(
    canvasBounds.x + canvasBounds.width + 1,
  );
  expect(clampedDetail.y + clampedDetail.height).toBeLessThanOrEqual(
    canvasBounds.y + canvasBounds.height + 1,
  );
  await detail.getByRole("button", { name: "收起", exact: true }).click();
  await expect(detail).toHaveAttribute("data-minimized", "true");

  const before = await node.evaluate((element) => (element as HTMLElement).style.transform);
  const bounds = await node.boundingBox();
  if (bounds === null) throw new Error("声明节点不可拖动");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 96, bounds.y + bounds.height / 2 + 54, {
    steps: 6,
  });
  await page.mouse.up();
  const moved = await node.evaluate((element) => (element as HTMLElement).style.transform);
  expect(moved).not.toBe(before);
  const position = /^translate\(([-0-9.]+)px, ([-0-9.]+)px\)$/u.exec(moved);
  if (position === null) throw new Error(`节点坐标格式异常：${moved}`);
  const expectedPosition = { x: Number(position[1]), y: Number(position[2]) };

  const sidecarPath = join(projectDirectory, "flow-view.json");
  await expect
    .poll(async () => {
      try {
        const document = JSON.parse(await readFile(sidecarPath, "utf8")) as {
          readonly payload?: {
            readonly viewState?: {
              readonly positions?: readonly {
                readonly anchor?: {
                  readonly structurePath?: string;
                  readonly kind?: string;
                  readonly nodeType?: string | null;
                  readonly textFingerprint?: string;
                };
                readonly point?: { readonly x?: number; readonly y?: number };
              }[];
            };
          };
        };
        const declarationPositions = (document.payload?.viewState?.positions ?? []).filter(
          (entry) =>
            entry.anchor?.kind === "declaration" && entry.anchor.nodeType === "declaration",
        );
        if (declarationPositions.length !== 1) return null;
        const entry = declarationPositions[0];
        if (
          entry?.point?.x === undefined ||
          entry.point.y === undefined ||
          entry.anchor?.structurePath === undefined ||
          entry.anchor.textFingerprint === undefined
        ) {
          return null;
        }
        return {
          point: { x: entry.point.x, y: entry.point.y },
          hasMainStructurePath: /^function:main:0\/node:declaration:declaration:\d+$/u.test(
            entry.anchor.structurePath,
          ),
          hasTextFingerprint: entry.anchor.textFingerprint.length > 0,
        };
      } catch {
        return null;
      }
    })
    .toEqual({
      point: expectedPosition,
      hasMainStructurePath: true,
      hasTextFingerprint: true,
    });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#file-name")).toHaveText("M6 自由画布.c");
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
  const restored = page.locator(".flow-node[data-node-kind='declaration']");
  await expect(restored).toHaveCount(1);
  await expect
    .poll(() => restored.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(moved);
  await expect(page.getByRole("region", { name: "节点详情" })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
});

test("places virtual presets but rejects source presets dropped on blank canvas", async () => {
  await showBlockPalette(page);
  await showFlowCanvas(page);
  const search = page.getByRole("searchbox", { name: "筛选积木" });
  const canvas = page.locator("#flow-canvas");

  await search.fill("暂停");
  const pause = page.locator(".block-palette__drag-surface[data-template-id='builtin.flow.pause']");
  await expect(pause).toBeVisible();
  await expect(pause).toContainText("虚拟控制节点 · 不改变 C 语义");
  await pause.dragTo(canvas, { targetPosition: { x: 260, y: 180 } });
  const pauseDraft = page.getByRole("button", { name: "暂停，未接入草稿" });
  await expect(pauseDraft).toBeVisible();
  await pauseDraft.dblclick();
  const pauseSource = page.getByRole("textbox", { name: "暂停 草稿源码" });
  await expect(pauseSource).toBeDisabled();
  await expect(pauseSource).toHaveValue(/不生成或改写 C 语句/u);
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await search.fill("声明整数");
  const declaration = page.locator(
    ".block-palette__drag-surface[data-template-id='builtin.c.declare-integer']",
  );
  // The canvas is a 333px column now, so the old x:430 target landed outside the element and
  // the drop hit <html>. This point is inside the canvas and clear of both the projected nodes
  // and the bottom-right overview, which is what "blank canvas" means here.
  await declaration.dragTo(canvas, { targetPosition: { x: 40, y: 480 } });
  const declarationDraft = page.getByRole("button", { name: "声明整数，未接入草稿" });
  await expect(declarationDraft).toHaveCount(0);
  await expect(page.locator("#import-status")).toContainText(
    /请把积木放到已高亮的连线上|没有可精确映射的插入连线|积木没有落到安全插入位置/u,
  );
  expect(await editorText()).toBe(SOURCE);
});

test("routes a source preset dropped on an exact edge through rich diff before changing main.c", async () => {
  await showBlockPalette(page);
  await showFlowCanvas(page);
  const search = page.getByRole("searchbox", { name: "筛选积木" });
  await search.fill("声明整数");
  const declaration = page.locator(
    ".block-palette__drag-surface[data-template-id='builtin.c.declare-integer']",
  );
  await expect(declaration).toBeVisible();

  const entryEdge = page.locator(
    ".flow-canvas__wire[data-edge-kind='entry'][data-insertable='true']",
  );
  await expect(entryEdge).toHaveCount(1);
  const edgeId = await entryEdge.getAttribute("data-flow-edge-id");
  if (edgeId === null) throw new Error("可插入入口连线缺少稳定 ID");
  const insertPoint = page.locator(
    `.flow-canvas__edge-insert[data-flow-edge-insert-id='${edgeId}']`,
  );
  await expect(insertPoint).toBeVisible();

  // A source preset lands on the insertion slot that marks the boundary, not on the "+"
  // control beside it: the "+" opens the preset menu, and its centre sits just above the
  // slot strip. dragTo needs canvas-relative coordinates because the slot only becomes
  // visible once the drag has started.
  const canvasHost = page.locator("#flow-canvas");
  // The previous test's rejected drop leaves the view panned ~116px left, which puts every
  // insertion slot at a negative canvas-relative x — outside the element, where a drop lands
  // on nothing. Home is the canvas's own fit-all-nodes gesture, so it restores a view whose
  // coordinates can be aimed at.
  await canvasHost.focus();
  await page.keyboard.press("Home");
  const canvasBox = await canvasHost.boundingBox();
  const insertBox = await insertPoint.boundingBox();
  if (canvasBox === null || insertBox === null) throw new Error("画布或插入点边界不可用");
  const insertCentre = {
    x: insertBox.x + insertBox.width / 2,
    y: insertBox.y + insertBox.height / 2,
  };
  const slotBox = await page.locator(".flow-canvas__slot").evaluateAll((elements, centre) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    let best = boxes[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const box of boxes) {
      const distance = Math.hypot(
        box.x + box.width / 2 - centre.x,
        box.y + box.height / 2 - centre.y,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = box;
      }
    }
    if (best === undefined) throw new Error("画布没有插入槽");
    return { x: best.x, y: best.y, width: best.width, height: best.height };
  }, insertCentre);
  await declaration.dragTo(canvasHost, {
    targetPosition: {
      x: Math.round(slotBox.x + slotBox.width / 2 - canvasBox.x),
      y: Math.round(slotBox.y + slotBox.height / 2 - canvasBox.y),
    },
  });
  const dialog = page.getByRole("dialog", { name: "确认修改" });
  await expect(dialog).toBeVisible();
  const diff = dialog.locator(".edit-panel__diff").first();
  await expect(diff).toBeVisible();
  await expect(diff.locator(".edit-panel__diff-text").first()).toHaveText("");
  await expect(diff.locator(".edit-panel__diff-text").last()).toContainText("int value = 0;");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  await expectEditorAndDiskSource(SOURCE);

  // Confirmation is owned by Edit; return to Flow before exercising the direct "+" menu.
  await showFlowCanvas(page);
  const refreshedInsertBox = await insertPoint.boundingBox();
  if (refreshedInsertBox === null) throw new Error("插入点边界不可用");
  // The hit path is intentionally transparent, so move the real pointer over its centre instead
  // of using locator.hover(), whose actionability check treats transparent SVG strokes as hidden.
  await page.mouse.move(
    refreshedInsertBox.x + refreshedInsertBox.width / 2,
    refreshedInsertBox.y + refreshedInsertBox.height / 2,
  );
  await expect(insertPoint).toHaveCSS("pointer-events", "auto");
  await insertPoint.click();
  await page.getByRole("button", { name: "插入声明整数" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".edit-panel__diff-text").last()).toContainText("int value = 0;");
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expect(dialog).toBeHidden();

  await expectEditorAndDiskSource(SOURCE_WITH_EDGE_INSERT);
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "saved");
});

test("keeps teaching simulation isolated, then renders a backend-confirmed real Trace path", async () => {
  await showSourceEditor(page);
  await showRuntimePanel(page);
  await page.getByRole("tab", { name: "运行", exact: true }).click();
  const tracePanel = page.locator(".trace-panel");
  const traceEvents = page.locator(".trace-panel__event");
  await expect(tracePanel).toHaveAttribute("data-status", "idle");
  await expect(page.locator("#trace-workbench-host")).toBeHidden();
  const traceChart = page.locator("svg.trace-panel__chart");
  await expect(traceChart).toBeHidden();
  await expect(traceChart).toHaveAttribute("role", "img");
  await expect(traceChart).toHaveAttribute("data-point-count", "0");
  await expect(page.locator(".trace-panel__visual-stage")).toHaveCount(0);
  await expect(page.locator(".trace-panel__reference")).toContainText("参考工作量：不可用");
  await expect(page.locator("#trace-primary-action")).toBeVisible();
  await expect(tracePanel.getByRole("button", { name: "观察路径" })).toHaveCount(0);

  await page.getByRole("combobox", { name: "算法案例" }).selectOption({ index: 1 });
  await page.getByText("更多运行方式", { exact: true }).click();
  await page.getByRole("button", { name: "教学模拟" }).click();
  await expect(page.locator(".scenario-panel__status")).toHaveText("教学模拟请求已完成");
  await expect(page.locator("#semantic-flow-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".flow-node[data-execution-mode='simulation']").first()).toBeVisible();
  await expect(traceEvents).toHaveCount(0);
  expect(await fileExists(join(projectDirectory, "run-history.json"))).toBe(false);

  await page.getByRole("combobox", { name: "算法案例" }).selectOption("");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.locator("#trace-primary-action")).toHaveText("再次运行");
  await expect(tracePanel).toHaveAttribute("data-status", "idle");
  await expect(traceEvents).toHaveCount(0);
  await expect(page.getByRole("button", { name: "观察路径", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "观察路径", exact: true }).click();
  await expect(tracePanel).toHaveAttribute("data-status", "completed", { timeout: 20_000 });
  await expect(traceEvents.first()).toBeVisible();
  expect(await traceEvents.count()).toBeGreaterThan(0);
  await expect(
    page.locator(
      ".trace-panel__event[data-kind='branch'][data-branch-taken='true'][data-trace-mode='real']",
    ),
  ).toHaveCount(1);
  await expect(page.locator(".trace-panel__events")).toHaveAttribute("data-trace-mode", "real");
  await expect(traceChart.locator("[data-series='trace']")).toBeVisible();
  await expect(traceChart.locator("[data-kind='branch'][data-branch-taken='true']")).toBeVisible();
  await expect(page.locator(".trace-panel__reference")).toHaveAttribute("data-available", "false");
  await expect(page.locator(".trace-panel__reference")).toContainText("实测/参考工作量比：不可用");
  await expect(page.locator(".flow-node[data-execution-mode='real']").first()).toBeVisible();
  await expect(page.locator("[data-trace-field='operation-count']")).toContainText(
    "真实 Trace 事件",
  );
  await expect(page.locator("#runtime-metrics-host")).toContainText("真实运行已记录");
  await expect
    .poll(async () => {
      const stored = JSON.parse(
        await readFile(join(projectDirectory, "run-history.json"), "utf8"),
      ) as { readonly payload?: { readonly entries?: readonly unknown[] } };
      return stored.payload?.entries?.length ?? 0;
    })
    .toBeGreaterThan(0);
});

function requireApplication(): ElectronApplication {
  if (application === undefined) throw new Error("Electron 应用尚未启动");
  return application;
}

function menuTrigger(name: string): Locator {
  return page.locator("[data-menu-root-trigger]").filter({ hasText: name });
}

async function openMenuBranch(rootName: string, branchName: string): Promise<void> {
  const trigger = menuTrigger(rootName);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const menu = page.getByRole("menu", { name: rootName });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: branchName, exact: true }).click();
}

async function editorText(): Promise<string> {
  return page
    .locator("#code-pane .cm-line")
    .evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join("\n"));
}

async function expectEditorAndDiskSource(source: string): Promise<void> {
  await expect.poll(editorText).toBe(source);
  await expect.poll(() => readFile(join(projectDirectory, "main.c"), "utf8")).toBe(source);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
