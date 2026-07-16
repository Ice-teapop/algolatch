import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-canvas-readability-e2e-"));
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  application = await electron.launch({
    args: ["."],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  page = await application.firstWindow();
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
  const start = page.getByRole("region", { name: "首次使用" });
  await start.getByRole("button", { name: "开始第一课 · 扫描求最大值" }).click();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-analysis-state", "complete");
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
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

  await page.locator(".flow-node[data-node-kind='declaration']").first().click();
  await expect
    .poll(() => page.locator(".flow-canvas__wire--data.is-contextual").count())
    .toBeGreaterThan(0);
});

test("keeps node inspector geometry stable while switching Explain and Edit", async () => {
  const inspector = page.locator("#inspector-stack");
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
        const inspectorElement = document.querySelector<HTMLElement>("#inspector-stack");
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
  await content.click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Home");
  const before = await page.locator(".code-pane .cm-line").first().textContent();
  await page.keyboard.press("Tab");
  await expect(content).toBeFocused();
  const indented = await page.locator(".code-pane .cm-line").first().textContent();
  expect(indented).toBe(`  ${before ?? ""}`);
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".code-pane .cm-line").first()).toHaveText(before ?? "");
});

test("collapses the overview inside a short canvas instead of covering the toolbar", async () => {
  const geometry = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLElement>(".flow-canvas");
    const minimap = document.querySelector<HTMLElement>(".flow-minimap");
    const map = document.querySelector<SVGElement>(".flow-minimap__map");
    if (canvas === null || minimap === null || map === null) {
      throw new Error("Canvas overview fixture is incomplete");
    }
    canvas.style.height = "150px";
    canvas.style.maxHeight = "150px";
    canvas.style.alignSelf = "start";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const canvasBounds = canvas.getBoundingClientRect();
    const minimapBounds = minimap.getBoundingClientRect();
    return {
      canvasTop: canvasBounds.top,
      canvasBottom: canvasBounds.bottom,
      minimapTop: minimapBounds.top,
      minimapBottom: minimapBounds.bottom,
      mapDisplay: getComputedStyle(map).display,
    };
  });

  expect(geometry.mapDisplay).toBe("none");
  expect(geometry.minimapTop).toBeGreaterThanOrEqual(geometry.canvasTop);
  expect(geometry.minimapBottom).toBeLessThanOrEqual(geometry.canvasBottom + 1);
});

test("keeps the overview pinned to the canvas bottom-right through pan and zoom", async () => {
  const positions = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLElement>(".flow-canvas");
    const minimap = document.querySelector<HTMLElement>(".flow-minimap");
    if (canvas === null || minimap === null) {
      throw new Error("Canvas overview fixture is incomplete");
    }

    canvas.style.height = "";
    canvas.style.maxHeight = "";
    canvas.style.alignSelf = "";

    const measure = () => {
      const canvasBounds = canvas.getBoundingClientRect();
      const minimapBounds = minimap.getBoundingClientRect();
      return {
        right: canvasBounds.right - minimapBounds.right,
        bottom: canvasBounds.bottom - minimapBounds.bottom,
        zoom: canvas.dataset.zoom ?? "",
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
  }
});
