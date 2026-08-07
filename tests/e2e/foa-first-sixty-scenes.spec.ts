import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";
import { getFoaSceneProfile } from "../../src/tutorials/foa-scene-profiles.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const FLOW_DEMOS = new Map<number, { readonly kind: string; readonly input: string }>([
  [2, { kind: "linear", input: "7" }],
  [5, { kind: "branch", input: "0" }],
  [16, { kind: "branch", input: "4" }],
  [22, { kind: "loop", input: "4" }],
]);
const CLICK_THROUGH_ORDERS = new Set([47, 54]);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-foa-scenes-e2e-"));
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
  await page.setViewportSize({ width: 1200, height: 820 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("keeps lessons 1-60 on their authored scene contracts", async () => {
  test.setTimeout(240_000);
  expect(FOA_LESSONS.slice(0, 60).map((lesson) => lesson.order)).toEqual(
    Array.from({ length: 60 }, (_, index) => index + 1),
  );

  for (const lesson of FOA_LESSONS.slice(0, 60)) {
    await test.step(`lesson ${String(lesson.order)}: ${lesson.title.en}`, async () => {
      await selectLesson(lesson.id);

      const flowDemo = FLOW_DEMOS.get(lesson.order);
      if (flowDemo !== undefined) {
        await verifyFlowDemo(flowDemo.kind, flowDemo.input);
        return;
      }
      if (lesson.order === 60) {
        await verifyInsertionSortStage();
        return;
      }

      const profile = getFoaSceneProfile(lesson);
      const stage = page.locator(".foa-semantic-stage");
      await expect(stage).toBeVisible();
      await stage.locator("[data-task-lesson-action='start']").click();
      await expect(stage).toHaveAttribute("data-phase", "task");
      if (profile.caseMode === "interactive") {
        const inputDialog = stage.locator("[data-task-lesson-dialog='input']");
        await expect(inputDialog).toBeVisible();
        await inputDialog.locator("[data-task-lesson-action='submit-input']").click();
        await expect(inputDialog).toBeHidden();
      }
      const scene = stage.locator(".foa-semantic-scene");
      await expect(scene).toBeVisible();
      await expect(scene).toHaveAttribute("data-scene-kind", profile.kind);
      await expect(scene.locator(".foa-semantic-scene__node")).toHaveCount(4);
      const usesSharedRuntime =
        (await scene.locator(".foa-runtime-scene__mechanism").count()) === 1;
      const usesSpecializedContract =
        (await scene.locator('[data-specialized="signature-contract"]').count()) > 0;
      await expect(scene.locator(".foa-semantic-scene__node:visible")).toHaveCount(
        usesSpecializedContract ? 0 : 4,
      );
      await expect(stage.locator(".foa-semantic-stage__region:visible")).toHaveCount(0);
      if (profile.edges !== undefined) {
        const actualEdges = await scene
          .locator(".foa-semantic-scene__edges path[data-from-index]")
          .evaluateAll((paths) =>
            paths.map((path) => {
              const value = path as SVGPathElement;
              return [Number(value.dataset.fromIndex), Number(value.dataset.toIndex)];
            }),
          );
        const expectedEdges =
          profile.pointerAlias !== undefined || profile.matrixCase !== undefined
            ? [
                [0, 1],
                [1, 2],
                [2, 3],
              ]
            : profile.edges;
        expect(actualEdges).toEqual(expectedEdges);
      }

      if (profile.pointerAlias !== undefined) {
        await expect(scene).toHaveAttribute("data-specialized-scene", "pointer-alias");
        await expect(scene.locator("[data-pointer-alias-edge]")).toHaveCount(1);
      }
      if (profile.matrixCase !== undefined) {
        await expect(scene).toHaveAttribute("data-specialized-scene", "matrix-grid");
        await expect(scene.locator("[data-matrix-cell]")).toHaveCount(6);
      }

      const geometry = await measureSceneGeometry(scene, usesSharedRuntime);
      expect(
        geometry.horizontalOverflow,
        `lesson ${String(lesson.order)} scene overflows horizontally`,
      ).toBeLessThanOrEqual(1);
      if (profile.matrixCase !== undefined) {
        expect(
          geometry.diagramVerticalOverflow,
          `lesson ${String(lesson.order)} matrix diagram requires a vertical scrollbar`,
        ).toBeLessThanOrEqual(1);
      }
      expect(geometry.nodeOverlaps, `lesson ${String(lesson.order)} scene nodes overlap`).toEqual(
        [],
      );

      if (usesSharedRuntime) {
        const observations = scene.locator(".foa-runtime-scene__observation output");
        await expect(observations).toHaveCount(profile.stateShape.length);
        const before = await observations.allTextContents();
        expect(before.every((value) => value.trim().length > 0)).toBe(true);
        await expect(stage).toHaveAttribute("data-confirmed-events", "0");
        await performRuntimeAction(scene);
        await expect(stage).toHaveAttribute("data-confirmed-events", "1");
        await expect
          .poll(async () => (await observations.allTextContents()).join("\0"))
          .not.toBe(before.join("\0"));
      }

      if (CLICK_THROUGH_ORDERS.has(lesson.order)) {
        await expect(stage).toHaveAttribute("data-confirmed-events", "0");
        if ((await scene.locator(".foa-runtime-scene__mechanism").count()) === 1) {
          await performRuntimeAction(scene);
        } else {
          await scene.locator(".foa-semantic-scene__node[data-state='active']").click();
        }
        await expect(stage).toHaveAttribute("data-confirmed-events", "1");
        await expect(scene).toHaveAttribute("data-confirmed-count", "1");
      }
    });
  }

  await test.step("reveals one pointer alias only after binding and updates the same object", async () => {
    const lesson = FOA_LESSONS[46]!;
    await selectLesson(lesson.id);
    const stage = page.locator(".foa-semantic-stage");
    await stage.locator("[data-task-lesson-action='start']").click();
    const scene = stage.locator(".foa-semantic-scene");
    const alias = scene.locator("[data-pointer-alias-edge]");
    const objectValue = scene.locator("[data-pointer-object-value]");
    const objectRole = scene.locator("[data-pointer-entity='object'] > span");
    const objectIdentity = scene.locator("[data-pointer-entity='object'] > strong");
    const [objectRoleBox, objectIdentityBox] = await Promise.all([
      objectRole.boundingBox(),
      objectIdentity.boundingBox(),
    ]);
    if (objectRoleBox === null || objectIdentityBox === null) {
      throw new Error("Pointer object labels are missing geometry");
    }
    expect(rectangleIntersectionArea(objectRoleBox, objectIdentityBox)).toBe(0);
    await expect(alias).toBeHidden();
    await expect(objectValue).toHaveText("7");
    await scene.locator(".foa-semantic-scene__node[data-state='active']").click();
    await expect(stage).toHaveAttribute("data-confirmed-events", "1");
    await expect(alias).toBeHidden();
    await scene.locator(".foa-semantic-scene__node[data-state='active']").click();
    await expect(stage).toHaveAttribute("data-confirmed-events", "2");
    await expect(alias).toBeVisible();
    await expect(scene.locator("[data-pointer-alias-edge]")).toHaveCount(1);
    await scene.locator(".foa-semantic-scene__node[data-state='active']").click();
    await expect(stage).toHaveAttribute("data-confirmed-events", "3");
    await expect(objectValue).toHaveText("9");
  });

  await test.step("shows a literal matrix with row, column, and accumulator evidence", async () => {
    const lesson = FOA_LESSONS[53]!;
    await selectLesson(lesson.id);
    const stage = page.locator(".foa-semantic-stage");
    await stage.locator("[data-task-lesson-action='start']").click();
    const scene = stage.locator(".foa-matrix-scene");
    await expect(scene.locator("[data-matrix-cell]")).toHaveCount(6);
    await expect(scene.locator("[data-matrix-panel]")).toHaveAttribute("data-active-row", "none");
    await scene.locator(".foa-semantic-scene__node[data-state='active']").click();
    await expect(stage).toHaveAttribute("data-confirmed-events", "1");
    await expect(scene.locator("[data-matrix-panel]")).toHaveAttribute("data-active-row", "0");
    await expect(scene.locator("[data-matrix-cell='0:0']")).toHaveAttribute("data-cursor", "true");
    await scene.locator(".foa-semantic-scene__node[data-state='active']").click();
    await expect(stage).toHaveAttribute("data-confirmed-events", "2");
    await expect(scene.locator("[data-matrix-sum]")).toContainText("6");
  });
});

async function selectLesson(lessonId: string): Promise<void> {
  const catalogToggle = page.locator("[data-tutorials-action='toggle-catalog']");
  if ((await catalogToggle.getAttribute("aria-expanded")) === "false") {
    await catalogToggle.click();
  }
  const entry = page.locator(`[data-tutorial-lesson-id="${lessonId}"]`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
}

async function performRuntimeAction(scene: Locator): Promise<void> {
  const selectors = [
    ".foa-runtime-scene__branch-lane[data-compatible='true']:visible",
    ".foa-runtime-scene__memory-link[data-compatible='true']:visible",
    ".foa-runtime-scene__stack-action[data-compatible='true']:visible",
    ".foa-runtime-scene__value-choice[data-compatible='true']:visible",
    ".foa-runtime-scene__action-target:visible",
  ];
  for (const selector of selectors) {
    const target = scene.locator(selector).first();
    if ((await target.count()) > 0 && (await target.isEnabled())) {
      await target.click();
      return;
    }
  }
  throw new Error("FOA runtime scene has no operable course-specific action");
}

async function verifyFlowDemo(kind: string, input: string): Promise<void> {
  const stage = page.locator(`.foa-semantic-stage[data-flow-demo-kind="${kind}"]`);
  await expect(stage).toBeVisible();
  await stage.locator("[data-task-lesson-action='start']").click();
  const dialog = stage.locator("[data-task-lesson-dialog='input']");
  await expect(dialog).toBeVisible();
  const value = dialog.locator("[data-task-lesson-input='runtime-value']");
  await value.fill(input);
  await value.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(stage.locator(".foa-flow-demo")).toBeVisible();
  await expect(stage.locator(".foa-flow-demo__graph")).toHaveAttribute("data-scene-kind", kind);
  await expect(stage.locator(".foa-semantic-stage__region:visible")).toHaveCount(0);
  await expect(stage.locator(".foa-semantic-scene")).toHaveCount(0);
}

async function verifyInsertionSortStage(): Promise<void> {
  const stage = page.locator(".library-task-lesson--v2");
  await expect(stage).toBeVisible();
  await stage.locator("[data-task-lesson-action='start']").click();
  await expect(stage.locator(".library-task-stage__board")).toBeVisible();
  await expect(stage.locator(".library-task-stage__board-grid")).toBeVisible();
  expect(await stage.locator(".library-task-stage__slot").count()).toBeGreaterThan(0);
  await expect(stage.locator(".foa-semantic-scene")).toHaveCount(0);
}

async function measureSceneGeometry(
  scene: Locator,
  ignoreHiddenRuntimeNodes = false,
): Promise<{
  readonly horizontalOverflow: number;
  readonly diagramVerticalOverflow: number;
  readonly nodeOverlaps: readonly string[];
}> {
  return scene.evaluate((element, ignoreHiddenNodes) => {
    const sceneRoot = element as HTMLElement;
    const stageRoot = sceneRoot.closest<HTMLElement>(".foa-semantic-stage");
    const diagram = sceneRoot.querySelector<HTMLElement>(".foa-semantic-scene__diagram");
    const nodes = [...sceneRoot.querySelectorAll<HTMLElement>(".foa-semantic-scene__node")];
    if (stageRoot === null || diagram === null || nodes.length !== 4) {
      throw new Error("FOA semantic scene geometry is incomplete");
    }
    const bounds = ignoreHiddenNodes ? [] : nodes.map((node) => node.getBoundingClientRect());
    const nodeOverlaps: string[] = [];
    for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bounds.length; rightIndex += 1) {
        const left = bounds[leftIndex]!;
        const right = bounds[rightIndex]!;
        const horizontal = Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const vertical = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        if (horizontal > 1 && vertical > 1) {
          nodeOverlaps.push(`${String(leftIndex)}:${String(rightIndex)}`);
        }
      }
    }
    return {
      horizontalOverflow: Math.max(
        0,
        stageRoot.scrollWidth - stageRoot.clientWidth,
        sceneRoot.scrollWidth - sceneRoot.clientWidth,
        diagram.scrollWidth - diagram.clientWidth,
      ),
      diagramVerticalOverflow: Math.max(0, diagram.scrollHeight - diagram.clientHeight),
      nodeOverlaps,
    };
  }, ignoreHiddenRuntimeNodes);
}

function rectangleIntersectionArea(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

async function measureScrolledEdgeAlignment(scene: Locator): Promise<{
  readonly scrollTop: number;
  readonly maximumEndpointError: number;
}> {
  await scene.locator(".foa-semantic-scene__diagram").evaluate(async (diagram) => {
    diagram.scrollTop = Math.min(70, Math.max(0, diagram.scrollHeight - diagram.clientHeight));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  return scene.evaluate((element) => {
    const diagram = element.querySelector<HTMLElement>(".foa-semantic-scene__diagram");
    const svg = element.querySelector<SVGSVGElement>(".foa-semantic-scene__edges");
    const nodes = [...element.querySelectorAll<HTMLElement>(".foa-semantic-scene__node")];
    const paths = [
      ...element.querySelectorAll<SVGPathElement>(
        ".foa-semantic-scene__edges path[data-from-index]",
      ),
    ];
    if (diagram === null || svg === null || nodes.length !== 4 || paths.length === 0) {
      throw new Error("Scrolled semantic scene is incomplete");
    }
    const svgBounds = svg.getBoundingClientRect();
    let maximumEndpointError = 0;
    for (const path of paths) {
      const from = nodes[Number(path.dataset.fromIndex)]!.getBoundingClientRect();
      const to = nodes[Number(path.dataset.toIndex)]!.getBoundingClientRect();
      const length = path.getTotalLength();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(length);
      const startError = Math.hypot(
        svgBounds.left + start.x - (from.left + from.width / 2),
        svgBounds.top + start.y - (from.top + from.height / 2),
      );
      const endError = Math.hypot(
        svgBounds.left + end.x - (to.left + to.width / 2),
        svgBounds.top + end.y - (to.top + to.height / 2),
      );
      maximumEndpointError = Math.max(maximumEndpointError, startError, endError);
    }
    return { scrollTop: diagram.scrollTop, maximumEndpointError };
  });
}
