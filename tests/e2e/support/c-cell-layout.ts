import { expect, type Page } from "@playwright/test";

/**
 * Opens the project source editor in the code-first C Cell layout.
 * Tests use stable element ids because labels are localized at runtime.
 */
export async function showSourceEditor(page: Page): Promise<void> {
  await closeNarrowDrawer(page);
  const tab = page.locator("#main-source-tab");
  if (!(await tab.isVisible())) {
    const workspace = page.locator("#build-tab");
    await expect(workspace).toBeVisible();
    await workspace.click();
  }
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator("#main-source-panel")).toBeVisible();
}

/** Opens the semantic Flow projection, revealing the narrow-screen drawer when needed. */
export async function showFlowCanvas(page: Page): Promise<void> {
  await closeNarrowDrawer(page);
  await ensureSemanticMonitorVisible(page);
  const tab = page.locator("#semantic-flow-tab");
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator("#semantic-flow-panel")).toBeVisible();
  await expect(page.locator("#flow-canvas")).toBeVisible();
}

/** Opens the projected block tree in the semantic monitor. */
export async function showBlockTree(page: Page): Promise<void> {
  await closeNarrowDrawer(page);
  await ensureSemanticMonitorVisible(page);
  const tab = page.locator("#explanation-tab");
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator("#explanation-panel")).toBeVisible();
  await expect(page.locator("#block-tree")).toBeVisible();
}

/** Opens the searchable preset list in the project-tools column. */
export async function showBlockPalette(page: Page): Promise<void> {
  await closeNarrowDrawer(page);
  await ensureProjectToolsVisible(page);
  const tab = page.locator("#left-presets-tab");
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator("#left-presets-panel")).toBeVisible();
  await expect(page.locator("#block-palette")).toBeVisible();
}

/** Reveals the independently collapsible runtime/evidence pane. */
export async function showRuntimePanel(page: Page): Promise<void> {
  await closeNarrowDrawer(page);
  const toggle = page.locator("#runtime-panel-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#bottom-pane")).toBeVisible();
}

/** Opens source editing and the corresponding Blocks projection side by side. */
export async function showSourceAndBlocks(page: Page): Promise<void> {
  await showSourceEditor(page);
  await showBlockTree(page);
}

/** Opens the semantic AI panel; the native assistant window remains a separate user action. */
export async function showAiAssistant(page: Page): Promise<void> {
  await closeNarrowDrawer(page);
  await ensureSemanticMonitorVisible(page);
  const tab = page.locator("#semantic-ai-tab");
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator("#semantic-ai-panel")).toBeVisible();
}

async function ensureProjectToolsVisible(page: Page): Promise<void> {
  const pane = page.locator("#left-pane");
  if (await pane.isVisible()) return;
  const toggle = page.locator("#project-tools-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(pane).toBeVisible();
}

async function ensureSemanticMonitorVisible(page: Page): Promise<void> {
  const pane = page.locator("#right-pane");
  if (await pane.isVisible()) return;
  const toggle = page.locator("#semantic-monitor-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(pane).toBeVisible();
}

async function closeNarrowDrawer(page: Page): Promise<void> {
  const modal = page.locator("#left-pane[aria-modal='true'], #right-pane[aria-modal='true']");
  if (!(await modal.isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
}
