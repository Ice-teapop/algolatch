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

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

const REAL_TRACE_COURSES = [63, 70, 75, 80] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "algolatch-transition-real-trace-e2e-"));
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
  await expect.poll(() => page.url()).toContain(`127.0.0.1:${developmentServerPort}`);
  await requireApplication().evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: () => Promise<{
        readonly response: number;
        readonly checkboxChecked: boolean;
      }>;
    };
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator("#startup-loader")).toBeHidden();
  await expect(page.locator("#parser-status")).toHaveAttribute("data-state", "ready");
  await page.locator("#tutorials-tab").click();
  await expect(page.locator("#tutorials-panel")).toBeVisible();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("explicitly upgrades courses 63, 70, 75 and 80 with bounded real Trace evidence", async () => {
  test.setTimeout(180_000);

  for (const order of REAL_TRACE_COURSES) {
    await test.step(`course ${String(order)} verifies a real Trace`, async () => {
      const prototype = await openTransitionPrototype(order);
      await expect(prototype).toHaveAttribute("data-trace-status", "idle");
      await expect(prototype).toHaveAttribute("data-provenance", "teaching-model");
      await expect(prototype).toHaveAttribute("data-model-provenance", "teaching-model");

      const verify = prototype.locator("[data-transition-action='verify-real-trace']");
      await expect(verify).toHaveText("验证真实 Trace");
      await verify.click();

      await expect
        .poll(async () => (await prototype.getAttribute("data-trace-status")) ?? "missing", {
          timeout: 30_000,
        })
        .toMatch(/^(?:verified|failed)$/u);
      const terminalStatus = await prototype.getAttribute("data-trace-status");
      if (terminalStatus !== "verified") {
        const failureCode =
          (await prototype.getAttribute("data-trace-failure")) ?? "missing-failure-code";
        const traceMessage =
          (
            await prototype.locator(".foa-transition-prototype__trace-message").textContent()
          )?.trim() ?? "missing-trace-message";
        throw new Error(
          `course ${String(order)} real Trace failed: ${failureCode}; ${traceMessage}`,
        );
      }
      await expect(prototype).toHaveAttribute("data-provenance", "real-trace");
      await expect(prototype).toHaveAttribute("data-model-provenance", "real-trace");
      await expect(prototype).not.toHaveAttribute("data-trace-failure", /.+/u);
      await expect(verify).toHaveText("重新验证");
      await expect(prototype.locator(".foa-transition-prototype__trace-message")).toContainText(
        "实际运行、状态事件与输出已一致。",
      );
      await expectVerifiedSourceAnchor(prototype);

      await verifyInputInvalidation(prototype, order);
    });
  }
});

async function openTransitionPrototype(
  order: (typeof REAL_TRACE_COURSES)[number],
): Promise<Locator> {
  const lesson = FOA_LESSONS[order - 1];
  if (lesson === undefined) throw new Error(`FOA course ${String(order)} is missing`);
  const entry = page.locator(`[data-tutorial-lesson-id='${lesson.id}']`);
  await entry.evaluate((element) => {
    const chapter = element.closest("details");
    if (chapter !== null) chapter.open = true;
  });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");

  const blockStage = page.locator(".foa-block-stage[data-transition-prototype='true']");
  await expect(blockStage).toBeVisible();
  await blockStage.locator("[data-task-lesson-action='start']").click();
  await expect(blockStage).toHaveAttribute("data-phase", "task");
  const prototype = blockStage.locator(".foa-transition-prototype");
  await expect(prototype).toHaveAttribute("data-lesson-order", String(order));
  return prototype;
}

async function expectVerifiedSourceAnchor(prototype: Locator): Promise<void> {
  const activeLine = await prototype.getAttribute("data-active-source-line");
  const activeAnchor = await prototype.getAttribute("data-active-source-anchor-id");
  expect(activeLine, "verified Trace exposes its exact source line").toMatch(/^\d+$/u);
  expect(activeAnchor, "verified Trace exposes its source anchor").toBeTruthy();

  const blockStage = page.locator(".foa-block-stage[data-transition-prototype='true']");
  await expect(blockStage).toHaveAttribute("data-prototype-source-line", activeLine!);
  const sourceRow = blockStage.locator(
    `.foa-block-stage__source-line[data-source-line='${activeLine!}']`,
  );
  await expect(sourceRow).toBeVisible();
  await expect(sourceRow).toHaveAttribute("data-state", "active");
  await expect(prototype.locator(".foa-transition-prototype__source code")).toHaveAttribute(
    "data-source-anchor-id",
    activeAnchor!,
  );
}

async function verifyInputInvalidation(
  prototype: Locator,
  order: (typeof REAL_TRACE_COURSES)[number],
): Promise<void> {
  if (order === 63) {
    const value = prototype.locator(".foa-transition-prototype__input input[type='number']");
    await value.fill("11");
    await prototype.locator("[data-transition-action='apply-input']").click();
  } else if (order === 70) {
    const values = prototype.locator(".foa-transition-prototype__input input[type='text']");
    const target = prototype.locator(".foa-transition-prototype__input input[type='number']");
    await values.fill("-4 -2 0 2 4 6");
    await target.fill("3");
    await prototype.locator("[data-transition-action='apply-input']").click();
  } else if (order === 75) {
    const disks = prototype.locator(".foa-transition-prototype__input input[type='number']");
    await disks.fill("2");
    await prototype.locator("[data-transition-action='apply-input']").click();
  } else {
    await prototype
      .locator(".foa-transition-prototype__grid-toggle:not([disabled])")
      .first()
      .click();
  }

  await expect(prototype).toHaveAttribute("data-trace-status", "idle");
  await expect(prototype).toHaveAttribute("data-provenance", "teaching-model");
  await expect(prototype).toHaveAttribute("data-model-provenance", "teaching-model");
  await expect(prototype.locator("[data-transition-action='verify-real-trace']")).toHaveText(
    "验证真实 Trace",
  );
  await expect(prototype.locator(".foa-transition-prototype__trace-message")).toHaveText(
    "按当前输入编译并运行一次受限影子 Trace。",
  );
}

function requireApplication(): ElectronApplication {
  if (application === undefined) throw new Error("Electron application has not started");
  return application;
}
