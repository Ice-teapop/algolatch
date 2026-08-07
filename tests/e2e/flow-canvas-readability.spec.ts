import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_ALGORITHM_SOURCE } from "../../src/tutorials/first-algorithm.js";
import { showFlowCanvas, showRuntimePanel, showSourceEditor } from "./support/c-cell-layout.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-canvas-readability-e2e-"));
  const developmentServerPort = process.env.PANEL_E2E_PORT ?? "5173";
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
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  page = await application.firstWindow();
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __canvasCspViolations?: Array<{
        readonly blockedUri: string;
        readonly directive: string;
      }>;
    };
    state.__canvasCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      state.__canvasCspViolations?.push({
        blockedUri: event.blockedURI,
        directive: event.effectiveDirective,
      });
    });
  });
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();

  await page.getByRole("button", { name: "新建", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建工作区条目" });
  await create.getByRole("combobox", { name: "条目类型" }).selectOption("project");
  await create.getByRole("textbox", { name: "条目名称" }).fill("画布可读性实机检查");
  await create.getByRole("button", { name: "创建并打开" }).click();

  await showSourceEditor(page);
  const content = page.locator("#code-pane .cm-content");
  await content.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(FIRST_ALGORITHM_SOURCE);
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("keeps project creation and real source input CSP-clean", async () => {
  const violations = await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __canvasCspViolations?: readonly unknown[];
    };
    return state.__canvasCspViolations ?? [];
  });
  expect(violations).toEqual([]);
});

test("progressively reveals Flow editing affordances without shrinking their targets", async () => {
  await showFlowCanvas(page);
  const canvas = page.locator(".flow-canvas");
  const node = page.locator(".flow-node:has(.flow-node__port:not(:disabled))").first();
  const port = node.locator(".flow-node__port:not(:disabled)").first();
  const toolbar = page.locator("#semantic-flow-panel .canvas-toolbar");
  const toolbarActions = toolbar.locator(".canvas-toolbar__actions");

  await expect(node).toBeVisible();
  await expect
    .poll(() => progressiveStyle(port))
    .toEqual({
      opacity: "0",
      pointerEvents: "none",
    });
  await expect
    .poll(() => progressiveStyle(toolbarActions))
    .toEqual({
      opacity: "0",
      pointerEvents: "none",
    });

  await toolbar.hover();
  await expect
    .poll(() => progressiveStyle(toolbarActions))
    .toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });
  await toolbar.getByRole("button", { name: "撤销", exact: true }).focus();
  await expect
    .poll(() => progressiveStyle(toolbarActions))
    .toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });
  await canvas.focus();
  await page.mouse.move(2, 2);
  await expect
    .poll(() => progressiveStyle(toolbarActions))
    .toEqual({
      opacity: "0",
      pointerEvents: "none",
    });

  await canvas.evaluate((element) => {
    element.dataset.interactionContext = "wiring";
  });
  await expect
    .poll(() => progressiveStyle(port))
    .toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });
  await canvas.evaluate((element) => {
    element.dataset.interactionContext = "idle";
  });
  await expect
    .poll(() => progressiveStyle(port))
    .toEqual({
      opacity: "0",
      pointerEvents: "none",
    });

  await node.hover();
  await expect
    .poll(() => progressiveStyle(port))
    .toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });
  const target = await port.boundingBox();
  expect(target?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(target?.height ?? 0).toBeGreaterThanOrEqual(32);

  await node.click({ position: { x: 72, y: 16 } });
  await expect(node).toHaveClass(/is-selected/u);
  await page.mouse.move(2, 2);
  await expect
    .poll(() => progressiveStyle(port))
    .toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });
});

test("never exposes edit affordances in the read-only C Cell Flow preview", async () => {
  await page.getByRole("tab", { name: "C Cell", exact: true }).click();
  const input = page.getByRole("textbox", { name: "输入 C 程序、语句或控制块" });
  await input.fill('int probe = 3;\nprintf("%d\\n", probe);');
  const previewToolbar = page.locator("#semantic-flow-panel .canvas-toolbar");
  await expect(previewToolbar).toHaveAttribute("data-presentation", "preview");

  const node = page.locator(".flow-node:has(.flow-node__port)").first();
  const port = node.locator(".flow-node__port").first();
  await node.hover();
  await expect
    .poll(() => progressiveStyle(port))
    .toEqual({
      opacity: "0",
      pointerEvents: "none",
    });

  await page.getByRole("tab", { name: "main.c", exact: true }).click();
  await expect(previewToolbar).not.toHaveAttribute("data-presentation", "preview");
});

test("keeps the C Cell semantic projection readable at 100%, 125%, and 150% zoom", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#c-command-tab").click();
  const input = page.getByRole("textbox", { name: "输入 C 程序、语句或控制块" });
  await input.fill(FIRST_ALGORITHM_SOURCE);

  const previewToolbar = page.locator("#semantic-flow-panel .canvas-toolbar");
  await expect(previewToolbar).toHaveAttribute("data-presentation", "preview");
  await expect.poll(() => page.locator(".flow-node").count()).toBeGreaterThan(10);

  for (const zoomFactor of [1, 1.25, 1.5]) {
    await setZoomFactor(zoomFactor);
    await showFlowCanvas(page);
    await expect
      .poll(async () => Number(await page.locator(".flow-canvas").getAttribute("data-zoom")))
      .toBeGreaterThanOrEqual(0.8);

    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>(".flow-canvas");
      const nodes = [...document.querySelectorAll<HTMLElement>(".flow-node")];
      const tabs = [
        ...document.querySelectorAll<HTMLButtonElement>("#semantic-monitor-tabs > button"),
      ].filter((button) => getComputedStyle(button).display !== "none");
      if (canvas === null || nodes.length === 0) {
        throw new Error("Semantic projection fixture is incomplete");
      }
      const canvasBounds = canvas.getBoundingClientRect();
      const nodeBounds = nodes.map((node) => node.getBoundingClientRect());
      const firstNode = nodeBounds.reduce((first, current) =>
        current.top < first.top ? current : first,
      );
      const tabBounds = tabs.map((tab) => tab.getBoundingClientRect());
      return {
        canvasTop: canvasBounds.top,
        canvasLeft: canvasBounds.left,
        firstNodeTop: firstNode.top,
        firstNodeLeft: firstNode.left,
        firstNodeWidth: firstNode.width,
        adjacentTabsOverlap: tabBounds.some((bounds, index) => {
          const next = tabBounds[index + 1];
          return next !== undefined && next.left < bounds.right - 0.5;
        }),
      };
    });

    expect(geometry.firstNodeTop).toBeGreaterThanOrEqual(geometry.canvasTop - 1);
    expect(geometry.firstNodeLeft).toBeGreaterThanOrEqual(geometry.canvasLeft - 1);
    expect(geometry.firstNodeWidth).toBeGreaterThanOrEqual(127);
    expect(geometry.adjacentTabsOverlap).toBe(false);
  }

  const canvas = page.locator(".flow-canvas");
  const firstNode = page.locator(".flow-node").first();
  const beforePan = await firstNode.boundingBox();
  await canvas.dispatchEvent("wheel", { deltaX: 0, deltaY: 52 });
  await page.waitForTimeout(150);
  const afterPan = await firstNode.boundingBox();
  expect(beforePan).not.toBeNull();
  expect(afterPan).not.toBeNull();
  expect((afterPan?.y ?? 0) - (beforePan?.y ?? 0)).toBeLessThan(-40);

  await showRuntimePanel(page);
  await showFlowCanvas(page);
  const drawerGeometry = await page.evaluate(() => {
    const workArea = document.querySelector<HTMLElement>("#work-area");
    const rightPane = document.querySelector<HTMLElement>("#right-pane");
    if (workArea === null || rightPane === null) {
      throw new Error("Narrow semantic drawer fixture is incomplete");
    }
    const workAreaBounds = workArea.getBoundingClientRect();
    const rightPaneBounds = rightPane.getBoundingClientRect();
    return {
      workAreaTop: workAreaBounds.top,
      workAreaBottom: workAreaBounds.bottom,
      rightPaneTop: rightPaneBounds.top,
      rightPaneBottom: rightPaneBounds.bottom,
    };
  });
  expect(Math.abs(drawerGeometry.rightPaneTop - drawerGeometry.workAreaTop)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(drawerGeometry.rightPaneBottom - drawerGeometry.workAreaBottom),
  ).toBeLessThanOrEqual(1);

  await setZoomFactor(1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await showSourceEditor(page);
});

test("keeps the first-algorithm projection readable without changing its CFG", async () => {
  await expect(page.locator(".flow-node")).toHaveCount(19);

  const readability = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>(".flow-node")];
    const englishKinds: Readonly<Record<string, string>> = {
      start: "Start",
      end: "End",
      branch: "Branch",
      loop: "Loop",
      switch: "Switch",
      assert: "Assert",
      declaration: "Declaration",
      raw: "Raw",
      control: "Control",
      module: "Module",
      statement: "Statement",
    };
    for (const node of nodes) {
      const kind = node.querySelector<HTMLElement>(".flow-node__kind");
      if (kind !== null)
        kind.textContent = englishKinds[node.dataset.nodeKind ?? ""] ?? "Statement";
    }
    const functionNodes = nodes.filter((node) => node.dataset.nodeKind !== "module");
    const kindOverflow = nodes.filter((node) => {
      const kind = node.querySelector<HTMLElement>(".flow-node__kind");
      return kind !== null && kind.scrollWidth > kind.clientWidth + 1;
    }).length;
    const misplacedPorts = nodes.flatMap((node) => {
      const bounds = node.getBoundingClientRect();
      return [...node.querySelectorAll<HTMLElement>(".flow-node__port")].filter((port) => {
        const portBounds = port.getBoundingClientRect();
        const centerY = portBounds.top + portBounds.height / 2;
        return port.classList.contains("flow-node__port--input")
          ? centerY > bounds.top + 2
          : centerY < bounds.bottom - 2;
      });
    }).length;
    const xLanes = new Set(
      functionNodes.map((node) => /^translate\(([-0-9.]+)px,/u.exec(node.style.transform)?.[1]),
    );
    const repeatedReturns = functionNodes
      .map((node) => node.querySelector<HTMLElement>(".flow-node__label")?.textContent ?? "")
      .filter((label) => /^L\d+ · return 1;$/u.test(label));
    const dataWires = [...document.querySelectorAll<SVGPathElement>(".flow-canvas__wire--data")];
    const controlWires = [
      ...document.querySelectorAll<SVGPathElement>(".flow-canvas__wire[data-flow-edge-id]"),
    ];
    const intersections = new Set<string>();
    for (const wire of controlWires) {
      const transform = wire.getScreenCTM();
      if (transform === null) continue;
      const excluded = new Set([wire.dataset.fromNodeId, wire.dataset.toNodeId]);
      const length = wire.getTotalLength();
      for (let offset = 0; offset <= length; offset += 4) {
        const local = wire.getPointAtLength(offset);
        const screen = new DOMPoint(local.x, local.y).matrixTransform(transform);
        for (const node of nodes) {
          const nodeId = node.dataset.flowNodeId;
          if (nodeId === undefined || excluded.has(nodeId)) continue;
          const bounds = node.getBoundingClientRect();
          if (
            screen.x > bounds.left + 2 &&
            screen.x < bounds.right - 2 &&
            screen.y > bounds.top + 2 &&
            screen.y < bounds.bottom - 2
          ) {
            intersections.add(`${wire.dataset.flowEdgeId ?? "?"}:${nodeId}`);
          }
        }
      }
    }
    return {
      kindOverflow,
      misplacedPorts,
      xLaneCount: xLanes.size,
      repeatedReturns,
      wireNodeIntersections: intersections.size,
      nonOrthogonalControlWires: controlWires.filter((wire) =>
        /\bC\b/u.test(wire.getAttribute("d") ?? ""),
      ).length,
      dataWireCount: dataWires.length,
      maximumIdleDataOpacity: Math.max(
        0,
        ...dataWires.map((wire) => Number.parseFloat(getComputedStyle(wire).opacity)),
      ),
    };
  });

  expect(readability).toMatchObject({
    kindOverflow: 0,
    misplacedPorts: 0,
    xLaneCount: 3,
    wireNodeIntersections: 0,
    nonOrthogonalControlWires: 0,
  });
  expect(readability.repeatedReturns).toHaveLength(3);
  expect(readability.dataWireCount).toBeGreaterThan(0);
  expect(readability.maximumIdleDataOpacity).toBeLessThanOrEqual(0.1);

  await showFlowCanvas(page);
  await page.locator(".flow-node[data-node-kind='declaration']").first().click();
  await expect
    .poll(() => page.locator(".flow-canvas__wire--data.is-contextual").count())
    .toBeGreaterThan(0);
});

async function progressiveStyle(locator: import("@playwright/test").Locator): Promise<{
  readonly opacity: string;
  readonly pointerEvents: string;
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.freeze({ opacity: style.opacity, pointerEvents: style.pointerEvents });
  });
}

async function setZoomFactor(factor: number): Promise<void> {
  if (application === undefined) throw new Error("Electron application is not running");
  await application.evaluate(({ BrowserWindow }, zoomFactor) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Electron window is unavailable");
    window.webContents.setZoomFactor(zoomFactor);
  }, factor);
  await page.waitForTimeout(100);
}

test("keeps node inspector geometry stable while switching Explain and Edit", async () => {
  // #inspector-stack is an empty legacy shell now; the semantic monitor is what holds the
  // Blocks and Edit panels, so it is the box whose geometry must stay put across switches.
  const inspector = page.locator("#code-panel");
  const explainTab = page.locator("#explanation-tab");
  const editTab = page.locator("#edit-tab");
  const explainPanel = page.locator("#explanation-panel");
  const editPanel = page.locator("#edit-panel");

  await page.locator(".flow-node[data-node-kind='declaration']").first().click();
  await expect(inspector).toBeVisible();

  const snapshots: Array<{
    readonly active: "explanation" | "edit";
    readonly inspector: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly panel: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly panelOverflowX: string;
    readonly horizontalOverflow: number;
  }> = [];
  for (let index = 0; index < 8; index += 1) {
    const active = index % 2 === 0 ? "edit" : "explanation";
    await (active === "edit" ? editTab : explainTab).click();
    await expect(active === "edit" ? editPanel : explainPanel).toBeVisible();
    await expect(active === "edit" ? explainPanel : editPanel).toBeHidden();
    snapshots.push(
      await page.evaluate((activeView) => {
        const inspectorElement = document.querySelector<HTMLElement>("#code-panel");
        const panelElement = document.querySelector<HTMLElement>(`#${activeView}-panel`);
        if (inspectorElement === null || panelElement === null) {
          throw new Error("Node inspector fixture is incomplete");
        }
        const inspectorBounds = inspectorElement.getBoundingClientRect();
        const panelBounds = panelElement.getBoundingClientRect();
        const style = getComputedStyle(panelElement);
        return {
          active: activeView as "edit" | "explanation",
          inspector: {
            x: inspectorBounds.x,
            y: inspectorBounds.y,
            width: inspectorBounds.width,
            height: inspectorBounds.height,
          },
          panel: {
            x: panelBounds.x,
            y: panelBounds.y,
            width: panelBounds.width,
            height: panelBounds.height,
          },
          panelOverflowX: style.overflowX,
          horizontalOverflow: panelElement.scrollWidth - panelElement.clientWidth,
        };
      }, active),
    );
  }

  const baseline = snapshots[0];
  if (baseline === undefined) throw new Error("Node inspector produced no geometry snapshot");
  for (const snapshot of snapshots) {
    expect(Math.abs(snapshot.inspector.x - baseline.inspector.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapshot.inspector.y - baseline.inspector.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapshot.inspector.width - baseline.inspector.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapshot.inspector.height - baseline.inspector.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapshot.panel.y - baseline.panel.y)).toBeLessThanOrEqual(1);
    expect(snapshot.panel.x).toBeGreaterThanOrEqual(snapshot.inspector.x - 1);
    expect(snapshot.panel.width).toBeLessThanOrEqual(snapshot.inspector.width + 1);
    expect(snapshot.panel.y + snapshot.panel.height).toBeLessThanOrEqual(
      snapshot.inspector.y + snapshot.inspector.height + 1,
    );
    expect(snapshot.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(snapshot.panelOverflowX).not.toBe("visible");
  }
});

test("keeps detached block source visible as grey code until the draft is deleted", async () => {
  await showFlowCanvas(page);
  const detailClose = page.locator("[data-flow-detail-close]");
  if (await detailClose.isVisible()) await detailClose.click();
  const statementNodes = page.locator(".flow-node[data-node-kind='statement']");
  const unobscuredIndex = await statementNodes.evaluateAll((nodes) => {
    const minimap = document.querySelector<HTMLElement>(".flow-minimap");
    const minimapBounds = minimap?.getBoundingClientRect();
    return nodes.findIndex((node) => {
      const bounds = node.getBoundingClientRect();
      const center = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
      return (
        minimapBounds === undefined ||
        center.x < minimapBounds.left ||
        center.x > minimapBounds.right ||
        center.y < minimapBounds.top ||
        center.y > minimapBounds.bottom
      );
    });
  });
  expect(unobscuredIndex).toBeGreaterThanOrEqual(0);
  const node = statementNodes.nth(unobscuredIndex);
  await node.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");

  const preview = page.locator(".code-pane__draft-preview").first();
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-status", "detached");
  await expect(preview.locator("pre")).not.toBeEmpty();

  const draft = page.locator(".flow-canvas__draft-node").first();
  await draft.click();
  await expect(draft).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".flow-canvas")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(page.locator(".flow-canvas__draft-node")).toHaveCount(0);
  await expect(page.locator(".code-pane__draft-preview")).toHaveCount(0);
});

test("uses Tab for C indentation and keeps keyboard focus in the source editor", async () => {
  const content = page.locator(".code-pane .cm-content");
  const editableLine = page.locator(".code-pane .cm-line", { hasText: "int main" }).first();
  await editableLine.click({ position: { x: 12, y: 8 } });
  const before = await editableLine.textContent();
  await page.keyboard.press("Tab");
  await expect(content).toBeFocused();
  const indented = await editableLine.textContent();
  expect(indented).toBe(`  ${before ?? ""}`);
  await page.keyboard.press("Shift+Tab");
  await expect(editableLine).toHaveText(before ?? "");
});

test("collapses the overview inside a short canvas instead of covering the toolbar", async () => {
  const geometry = await page.evaluate(async () => {
    const liveMinimap = document.querySelector<HTMLElement>(".flow-minimap");
    if (liveMinimap === null) {
      throw new Error("Canvas overview fixture is incomplete");
    }
    const fixture = document.createElement("div");
    fixture.className = "flow-canvas-host";
    fixture.style.cssText =
      "position:fixed;left:-1000px;top:0;width:400px;height:150px;max-height:150px";
    const minimap = liveMinimap.cloneNode(true) as HTMLElement;
    fixture.append(minimap);
    document.body.append(fixture);
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const map = minimap.querySelector<SVGElement>(".flow-minimap__map");
      if (map === null) throw new Error("Canvas overview map is missing");
      const canvasBounds = fixture.getBoundingClientRect();
      const minimapBounds = minimap.getBoundingClientRect();
      return {
        canvasTop: canvasBounds.top,
        canvasBottom: canvasBounds.bottom,
        minimapTop: minimapBounds.top,
        minimapBottom: minimapBounds.bottom,
        mapDisplay: getComputedStyle(map).display,
      };
    } finally {
      fixture.remove();
    }
  });

  expect(geometry.mapDisplay).toBe("none");
  expect(geometry.minimapTop).toBeGreaterThanOrEqual(geometry.canvasTop);
  expect(geometry.minimapBottom).toBeLessThanOrEqual(geometry.canvasBottom + 1);
});

test("keeps the overview pinned to the canvas bottom-right through pan and zoom", async () => {
  // The preceding indentation check submits two source revisions in quick succession. On a busy
  // CI runner the canvas can briefly sit between those projections even after the text is restored.
  await showSourceEditor(page);
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
  await showFlowCanvas(page);
  await expect.poll(() => page.locator(".flow-node__port").count()).toBeGreaterThan(0);

  const positions = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>(".flow-canvas-host");
    const canvas = document.querySelector<HTMLElement>(".flow-canvas");
    const minimap = document.querySelector<HTMLElement>(".flow-minimap");
    if (host === null || canvas === null || minimap === null) {
      throw new Error("Canvas overview fixture is incomplete");
    }

    const measure = () => {
      const canvasBounds = host.getBoundingClientRect();
      const minimapBounds = minimap.getBoundingClientRect();
      const port = canvas.querySelector<HTMLElement>(".flow-node__port");
      if (port === null) throw new Error("Canvas port fixture is incomplete");
      const portStyle = getComputedStyle(port);
      const dotStyle = getComputedStyle(port, "::after");
      return {
        right: canvasBounds.right - minimapBounds.right,
        bottom: canvasBounds.bottom - minimapBounds.bottom,
        zoom: canvas.dataset.zoom ?? "",
        portWidth: Number.parseFloat(portStyle.width),
        portHeight: Number.parseFloat(portStyle.height),
        dotWidth: Number.parseFloat(dotStyle.width),
        dotHeight: Number.parseFloat(dotStyle.height),
      };
    };
    const settle = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const bounds = canvas.getBoundingClientRect();
    const dispatchWheel = (init: WheelEventInit) => {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          ...init,
        }),
      );
    };

    await settle();
    const initial = measure();
    dispatchWheel({ ctrlKey: true, deltaY: -1600 });
    await settle();
    const zoomedIn = measure();
    dispatchWheel({ deltaX: 320, deltaY: -240 });
    await settle();
    const panned = measure();
    dispatchWheel({ ctrlKey: true, deltaY: 3200 });
    await settle();
    const zoomedOut = measure();
    return { initial, zoomedIn, panned, zoomedOut };
  });

  expect(positions.zoomedIn.zoom).not.toBe(positions.initial.zoom);
  expect(positions.zoomedOut.zoom).not.toBe(positions.zoomedIn.zoom);
  for (const position of [
    positions.initial,
    positions.zoomedIn,
    positions.panned,
    positions.zoomedOut,
  ]) {
    expect(position.right).toBeCloseTo(12, 0);
    expect(position.bottom).toBeCloseTo(12, 0);
    expect(position.portWidth).toBe(32);
    expect(position.portHeight).toBe(32);
    expect(position.dotWidth).toBe(6);
    expect(position.dotHeight).toBe(6);
  }
});

test("keeps an ordinary C projection legible in idle and real-path states without faking reachability", async () => {
  const ordinaryProgram = [
    "#include <stdio.h>",
    "int main(void) {",
    '  puts("hello");',
    "  return 0;",
    '  puts("unreachable");',
    "}",
    "",
  ].join("\n");

  await showSourceEditor(page);
  const content = page.locator("#code-pane .cm-content");
  await content.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText(ordinaryProgram);
  await expect(page.locator("#workspace-save-status")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");

  await showFlowCanvas(page);
  const projectedNodes = page.locator(".flow-node");
  const reachableNode = page.locator('.flow-node[data-execution-reachability="reachable"]');
  const unreachableNode = page.locator('.flow-node[data-execution-reachability="unreachable"]');
  const sourceProjection = page.locator('.flow-node[data-execution-reachability="not-applicable"]');
  await expect(reachableNode.first()).toBeVisible();
  await expect(unreachableNode).toHaveCount(1);
  await expect(sourceProjection.first()).toBeVisible();
  await expect(sourceProjection.first()).not.toHaveAttribute("aria-label", /不可达/u);

  const idleVisuals = await projectedNodes.evaluateAll((nodes) => {
    const reachable = nodes.find(
      (node) => (node as HTMLElement).dataset.executionReachability === "reachable",
    );
    const unreachable = nodes.find(
      (node) => (node as HTMLElement).dataset.executionReachability === "unreachable",
    );
    if (reachable === undefined || unreachable === undefined) {
      throw new Error("Ordinary C projection is missing its reachability evidence");
    }
    const reachableStyle = getComputedStyle(reachable);
    const unreachableStyle = getComputedStyle(unreachable);
    return {
      opacityRecords: nodes.map((node) => ({
        kind: (node as HTMLElement).dataset.nodeKind ?? "unknown",
        reachability: (node as HTMLElement).dataset.executionReachability ?? "missing",
        opacity: Number.parseFloat(getComputedStyle(node).opacity),
      })),
      reachableColor: reachableStyle.color,
      unreachableColor: unreachableStyle.color,
      unreachableBorderStyle: unreachableStyle.borderStyle,
    };
  });
  expect(idleVisuals.opacityRecords).toEqual(
    idleVisuals.opacityRecords.map((record) => ({ ...record, opacity: 1 })),
  );
  expect(idleVisuals.unreachableColor).toBe(idleVisuals.reachableColor);
  expect(idleVisuals.unreachableBorderStyle).toContain("dashed");

  await showSourceEditor(page);
  const runtimeToggle = page.locator("#runtime-panel-toggle");
  if ((await runtimeToggle.getAttribute("aria-expanded")) !== "true") await runtimeToggle.click();
  await page.getByRole("tab", { name: "运行", exact: true }).click();
  const casePicker = page.getByRole("combobox", { name: "算法案例" });
  await casePicker.selectOption("");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.locator("#trace-primary-action")).toHaveText("再次运行");
  await page.getByRole("button", { name: "观察路径", exact: true }).click();
  await expect(page.locator(".trace-panel")).toHaveAttribute("data-status", "completed", {
    timeout: 20_000,
  });

  await showFlowCanvas(page);
  await expect(page.locator(".flow-canvas")).toHaveClass(/has-active-path/u);
  await expect(page.locator(".flow-node.is-active-path").first()).toBeVisible();
  await expect(unreachableNode).not.toHaveClass(/is-active-path/u);
  const pathVisuals = await projectedNodes.evaluateAll((nodes) =>
    nodes.map((node) => ({
      active: node.classList.contains("is-active-path"),
      opacity: Number.parseFloat(getComputedStyle(node).opacity),
    })),
  );
  expect(pathVisuals.some((node) => node.active)).toBe(true);
  expect(pathVisuals.some((node) => !node.active)).toBe(true);
  expect(pathVisuals.every((node) => node.opacity === 1)).toBe(true);
});
