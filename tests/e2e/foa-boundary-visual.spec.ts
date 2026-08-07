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
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const BOUNDARY_LESSON = FOA_LESSONS[4]!;
const SCREENSHOT_ROOT = join(tmpdir(), "algolatch-course5-visual");

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-boundary-visual-e2e-"));
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
  page = await application.firstWindow();
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await page.locator("#tutorials-tab").click();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("course 5 prediction graph is legible at wide and narrow panel widths", async () => {
  test.setTimeout(90_000);
  const entry = page.locator(`[data-tutorial-lesson-id='${BOUNDARY_LESSON.id}']`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  const stage = page.locator(".foa-semantic-stage");
  await stage.locator("[data-task-lesson-action='start']").click();
  await submitInput(stage, "8");
  const flow = stage.locator(".foa-flow-demo");
  const frame = flow.locator("[data-flow-frame]");
  await frame.focus();
  await page.keyboard.press("ArrowRight");
  await expect(frame).toHaveAttribute("data-frame-id", "boundary.frame.value");
  await expect(flow.locator(".foa-flow-demo__prediction")).toBeVisible();

  for (const width of [960, 720, 520]) {
    await constrainTutorialPanelWidth(width);
    await page.waitForTimeout(100);
    await flow.screenshot({ path: `${SCREENSHOT_ROOT}-${String(width)}.png` });
    const geometry = await measureGeometry(flow);
    expect(geometry.nodeOverlaps, `${String(width)}px: node overlap`).toEqual([]);
    expect(geometry.labelOverlaps, `${String(width)}px: path-label overlap`).toEqual([]);
    expect(geometry.labelNodeCollisions, `${String(width)}px: path label crosses a node`).toEqual(
      [],
    );
    expect(geometry.outsideNodes, `${String(width)}px: node leaves graph`).toEqual([]);
    expect(geometry.outsideLabels, `${String(width)}px: path label leaves graph`).toEqual([]);
    expect(geometry.clippedCopy, `${String(width)}px: visible copy is clipped`).toEqual([]);
    expect(
      geometry.detachedEndpoints,
      `${String(width)}px: connector arrow does not meet its target`,
    ).toEqual([]);
    expect(geometry.markerUnits).toBe("userSpaceOnUse");
    expect(geometry.outputCount, `${String(width)}px: all three outcomes stay visible`).toBe(3);
  }
});

async function submitInput(stage: ReturnType<Page["locator"]>, input: string): Promise<void> {
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  const field = dialog.locator("[data-task-lesson-input='runtime-value']");
  await field.fill(input);
  await field.press("Enter");
  await expect(dialog).toBeHidden();
}

async function constrainTutorialPanelWidth(width: number): Promise<void> {
  await page.evaluate((panelWidth) => {
    const module = document.querySelector<HTMLElement>(".tutorials-module");
    if (module === null) throw new Error("Tutorial module is unavailable");
    const catalogWidth = 272;
    module.style.width = `${String(catalogWidth + panelWidth)}px`;
    module.style.maxWidth = "none";
    module.style.gridTemplateColumns = `${String(catalogWidth)}px ${String(panelWidth)}px`;
    module.style.justifySelf = "start";
  }, width);
  await expect
    .poll(() =>
      page
        .locator(".tutorials-module__stage-host")
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    )
    .toBe(width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function measureGeometry(flow: ReturnType<Page["locator"]>): Promise<{
  readonly clippedCopy: readonly string[];
  readonly detachedEndpoints: readonly string[];
  readonly labelNodeCollisions: readonly string[];
  readonly labelOverlaps: readonly string[];
  readonly markerUnits: string | null;
  readonly nodeOverlaps: readonly string[];
  readonly outsideLabels: readonly string[];
  readonly outsideNodes: readonly string[];
  readonly outputCount: number;
}> {
  return flow.evaluate((root) => {
    const graph = root.querySelector<HTMLElement>(".foa-flow-demo__graph");
    if (graph === null) throw new Error("Course 5 graph is unavailable");
    const graphBounds = graph.getBoundingClientRect();
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-flow-node]")].map((element) => ({
      bounds: element.getBoundingClientRect(),
      id: element.dataset.flowNodeId ?? element.dataset.flowNode ?? "unknown-node",
    }));
    const labels = [...root.querySelectorAll<SVGGraphicsElement>("[data-flow-edge-label]")].map(
      (element) => ({
        bounds: element.getBoundingClientRect(),
        id:
          element.getAttribute("data-flow-edge-label-id") ?? element.textContent ?? "unknown-label",
      }),
    );
    const detachedEndpoints = [
      ...root.querySelectorAll<SVGPathElement>("[data-flow-edge-id][data-flow-to]"),
    ].flatMap((path) => {
      const targetId = path.dataset.flowTo;
      const target =
        targetId === undefined
          ? null
          : root.querySelector<HTMLElement>(`[data-flow-node-id='${targetId}']`);
      const matrix = path.getScreenCTM();
      if (target === null || matrix === null) return [path.dataset.flowEdgeId ?? "unknown-edge"];
      const endpoint = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
      const bounds = target.getBoundingClientRect();
      const deltaX = Math.max(bounds.left - endpoint.x, 0, endpoint.x - bounds.right);
      const deltaY = Math.max(bounds.top - endpoint.y, 0, endpoint.y - bounds.bottom);
      const distance = Math.hypot(deltaX, deltaY);
      return distance > 2
        ? [`${path.dataset.flowEdgeId ?? "unknown-edge"}:${distance.toFixed(1)}`]
        : [];
    });
    const intersection = (left: DOMRect, right: DOMRect, inset = 0): boolean =>
      Math.min(left.right - inset, right.right - inset) -
        Math.max(left.left + inset, right.left + inset) >
        1 &&
      Math.min(left.bottom - inset, right.bottom - inset) -
        Math.max(left.top + inset, right.top + inset) >
        1;
    const pairwise = (
      items: readonly { readonly bounds: DOMRect; readonly id: string }[],
    ): string[] => {
      const collisions: string[] = [];
      for (let left = 0; left < items.length; left += 1) {
        for (let right = left + 1; right < items.length; right += 1) {
          if (intersection(items[left]!.bounds, items[right]!.bounds)) {
            collisions.push(`${items[left]!.id}/${items[right]!.id}`);
          }
        }
      }
      return collisions;
    };
    const outside = (item: { readonly bounds: DOMRect; readonly id: string }): boolean =>
      item.bounds.left < graphBounds.left - 1 ||
      item.bounds.right > graphBounds.right + 1 ||
      item.bounds.top < graphBounds.top - 1 ||
      item.bounds.bottom > graphBounds.bottom + 1;
    const clippedCopy = [
      ...root.querySelectorAll<HTMLElement>(
        "[data-flow-node] > strong, [data-flow-prediction] > span, [data-flow-prediction] > button, [data-flow-observation]",
      ),
    ]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .filter(
        (element) =>
          element.clientWidth > 0 &&
          (element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1),
      )
      .map((element) => element.textContent?.trim() || element.tagName.toLowerCase());
    return Object.freeze({
      clippedCopy: Object.freeze(clippedCopy),
      detachedEndpoints: Object.freeze(detachedEndpoints),
      labelNodeCollisions: Object.freeze(
        labels.flatMap((label) =>
          nodes
            .filter((node) => intersection(label.bounds, node.bounds, 2))
            .map((node) => `${label.id}/${node.id}`),
        ),
      ),
      labelOverlaps: Object.freeze(pairwise(labels)),
      markerUnits: root.querySelector("marker")?.getAttribute("markerUnits") ?? null,
      nodeOverlaps: Object.freeze(pairwise(nodes)),
      outsideLabels: Object.freeze(labels.filter(outside).map((label) => label.id)),
      outsideNodes: Object.freeze(nodes.filter(outside).map((node) => node.id)),
      outputCount: root.querySelectorAll("[data-flow-output='true']").length,
    });
  });
}
