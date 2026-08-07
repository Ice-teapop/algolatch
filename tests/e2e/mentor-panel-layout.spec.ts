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
import { showAiAssistant } from "./support/c-cell-layout.js";

// A dedicated Electron profile: a shared one lets localStorage and window state leak
// between spec files, which run strictly in sequence under `workers: 1`.
const e2eProfileRoot = mkdtempSync(join(tmpdir(), "algolatch-e2e-profile-"));

let application: ElectronApplication | undefined;
let page: Page;
let workspaceRoot = "";

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "c-block-mentor-layout-e2e-"));
  const port = process.env.PANEL_E2E_PORT ?? "5173";
  application = await electron.launch({
    args: [".", `--user-data-dir=${e2eProfileRoot}`],
    chromiumSandbox: true,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      PANEL_WORKSPACE_ROOT: workspaceRoot,
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}/`,
    },
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 748);
  });
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("c-block-algorithm-panel.locale", "zh-CN");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#startup-loader")).toBeHidden();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("keeps every local check reachable in a short runtime pane", async () => {
  await page.locator("#build-tab").click();
  // The local checks moved out of the runtime pane: showRuntimeView redirects "mentor" to the
  // semantic monitor's AI panel, and #mentor-panel is now an empty legacy shell.
  await showAiAssistant(page);
  await expect(page.locator("#semantic-ai-panel")).toBeVisible();
  await expect(page.locator("#mentor-hints-host")).toBeVisible();

  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".mentor-panel__list");
    if (list === null) throw new Error("本地检查列表未挂载");
    for (let index = 0; index < 40; index += 1) {
      const item = document.createElement("article");
      item.className = "mentor-hint";
      item.setAttribute("role", "listitem");
      if (index === 39) item.dataset.e2eLastHint = "true";
      const action = document.createElement("button");
      action.type = "button";
      action.className = "mentor-hint__action";
      action.textContent = `检查 ${String(index + 1)}：定位证据并验证下一步实验。`;
      item.append(action);
      list.append(item);
    }
  });

  // The panel must contain its own content: a child claiming height:100% under fixed-height
  // siblings used to push the list tail past the panel's hidden overflow, out of reach.
  const panelContainsItsContent = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("#semantic-ai-panel");
    if (panel === null) throw new Error("AI 面板未挂载");
    return panel.scrollHeight <= panel.clientHeight + 1;
  });
  expect(panelContainsItsContent).toBe(true);

  const layout = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>("#mentor-hints-host");
    const lastHint = document.querySelector<HTMLElement>("[data-e2e-last-hint='true']");
    if (host === null || lastHint === null) {
      throw new Error("本地检查滚动夹具未挂载");
    }
    // In the semantic monitor the panel owns the scrolling rather than the hints host, so the
    // contract is asserted on whichever ancestor actually scrolls.
    // Only a genuinely scrollable ancestor counts: scrollTop can be set on an overflow:hidden
    // box from script, so "the fixture moved" would otherwise pass on a clipping container the
    // reader cannot actually scroll.
    let owner: HTMLElement | null = host;
    while (owner !== null) {
      const overflowY = getComputedStyle(owner).overflowY;
      const scrolls = overflowY === "auto" || overflowY === "scroll";
      if (scrolls && owner.scrollHeight > owner.clientHeight) break;
      owner = owner.parentElement;
    }
    if (owner === null) throw new Error("本地检查列表没有可滚动的宿主");
    const before = owner.scrollTop;
    owner.scrollTop = owner.scrollHeight;
    const ownerBounds = owner.getBoundingClientRect();
    const lastHintBounds = lastHint.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(owner).overflowY,
      scrollable: owner.scrollHeight > owner.clientHeight,
      moved: owner.scrollTop > before,
      lastHintReachable:
        lastHintBounds.top >= ownerBounds.top && lastHintBounds.bottom <= ownerBounds.bottom,
    };
  });

  expect(layout.overflowY).toBe("auto");
  expect(layout.scrollable).toBe(true);
  expect(layout.moved).toBe(true);
  expect(layout.lastHintReachable).toBe(true);
  const lastHintAction = page.locator("[data-e2e-last-hint='true'] .mentor-hint__action");
  await lastHintAction.focus();
  await expect(lastHintAction).toBeFocused();

  // The checks live in the right column now, so the divider that has to stay grabbable is the
  // one bordering that column rather than the runtime pane's.
  const splitter = page.locator(
    "#primary-workspace > .resizable-layout__splitter[data-splitter-for='center']",
  );
  const splitterBounds = await splitter.boundingBox();
  expect(splitterBounds?.height ?? 0).toBeGreaterThanOrEqual(10);
});
