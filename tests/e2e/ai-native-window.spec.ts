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
let mainPage: Page;
let workspaceRoot = "";

test.beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "c-block-ai-window-e2e-"));
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
  mainPage = await application.firstWindow();
  await expect(mainPage.locator("#workbench-shell")).toBeVisible();
  await expect(mainPage.locator("#startup-loader")).toBeHidden();
});

test.afterAll(async () => {
  await application?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("opens AI in a native child window and synchronizes interface preferences", async () => {
  if (application === undefined) throw new Error("Electron application is unavailable");

  await mainPage.evaluate(() => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    if (language === null) throw new Error("Interface language control is unavailable");
    language.value = "en";
    language.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await mainPage.locator("#build-tab").click();
  await expect(mainPage.locator(".app-bar #ai-assistant-button")).toHaveCount(0);
  await showAiAssistant(mainPage);
  await expect(
    mainPage.locator("#semantic-ai-panel .semantic-monitor__ai-entry #ai-assistant-button"),
  ).toBeVisible();

  const childWindow = application.waitForEvent("window");
  await showAiAssistant(mainPage);
  await mainPage.locator("#ai-assistant-button").click();
  const aiPage = await childWindow;
  await aiPage.waitForLoadState("domcontentloaded");

  await expect(mainPage.locator(".ai-workspace-window")).toHaveCount(0);
  await expect(aiPage.locator('.ai-workspace-window[data-presentation="native"]')).toBeVisible();
  await expect
    .poll(() => nativeAiWindowState(application!))
    .toMatchObject({ parentTitle: null, minimized: false, visible: true });
  await expect(aiPage.locator("html")).toHaveAttribute("lang", "en");
  const englishLayout = await nativeAiLayoutSnapshot(aiPage);
  expect(englishLayout).toMatchObject({
    shellDisplay: "grid",
    bodyDisplay: "grid",
    headerHeight: 40,
    inputFontSize: "13px",
    suggestionDisplay: "grid",
  });
  expect(englishLayout.bodyGridColumns).toMatch(/^216px\s+/u);
  expect(englishLayout.fontFamily).toContain("system-ui");
  expect(englishLayout.fontFamily).not.toMatch(/(?:^|,\s*)Times(?: New Roman)?(?:,|$)/u);
  expect(englishLayout.emptyWidth).toBeLessThanOrEqual(640);
  expect(englishLayout.externalStyleSheets).toEqual(
    expect.arrayContaining([expect.stringContaining("/src/ui/ai-workspace-window.css")]),
  );
  expect(englishLayout.contentSecurityPolicy).toContain("style-src 'self'");
  expect(englishLayout.contentSecurityPolicy).not.toContain("unsafe-inline");
  expect(await visibleChineseSystemCopy(aiPage), "AI popup").toEqual([]);

  await mainPage.evaluate(() => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    const background = document.querySelector<HTMLSelectElement>("#interface-background");
    if (language === null || background === null) {
      throw new Error("Interface preference controls are unavailable");
    }
    language.value = "zh-CN";
    language.dispatchEvent(new Event("change", { bubbles: true }));
    background.value = "cool";
    background.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect(aiPage.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(aiPage.locator("html")).toHaveAttribute("data-background", "cool");
  await expect
    .poll(() =>
      aiPage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
      ),
    )
    .toBe("#edf2f4");
  await expect(aiPage.locator(".ai-workspace-window")).toContainText("项目与对话");
  const coolChineseLayout = await nativeAiLayoutSnapshot(aiPage);
  expect(coolChineseLayout).toMatchObject({
    shellDisplay: "grid",
    bodyDisplay: "grid",
    headerHeight: 40,
    inputFontSize: "13px",
    suggestionDisplay: "grid",
  });
  expect(coolChineseLayout.fontFamily).toBe(englishLayout.fontFamily);
  expect(coolChineseLayout.canvasColor).toBe("rgb(237, 242, 244)");

  await application.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (window) =>
        (window as unknown as { panelWindowRole?: string }).panelWindowRole !== "ai-assistant",
    );
    main?.show();
    main?.focus();
  });
  await expect.poll(() => nativeAiWindowState(application!)).toMatchObject({ focused: false });
  await mainPage.evaluate(() => {
    const background = document.querySelector<HTMLSelectElement>("#interface-background");
    if (background === null) throw new Error("Interface background control is unavailable");
    background.value = "white";
    background.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(() => nativeAiWindowState(application!)).toMatchObject({ focused: false });

  await application.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find(
      (window) =>
        (window as unknown as { panelWindowRole?: string }).panelWindowRole === "ai-assistant",
    );
    child?.minimize();
  });
  await expect.poll(() => nativeAiWindowState(application!)).toMatchObject({ minimized: true });
  await showAiAssistant(mainPage);
  await mainPage.locator("#ai-assistant-button").click();
  await expect
    .poll(() => nativeAiWindowState(application!))
    .toMatchObject({ minimized: false, visible: true });

  await aiPage.close();
  await expect(mainPage.locator("#workbench-shell")).toBeVisible();
  await expect.poll(() => application?.windows().length ?? 0).toBe(1);

  const reopenedWindow = application.waitForEvent("window");
  await showAiAssistant(mainPage);
  await mainPage.locator("#ai-assistant-button").click();
  const reopenedAiPage = await reopenedWindow;
  await reopenedAiPage.waitForLoadState("domcontentloaded");
  await expect(
    reopenedAiPage.locator('.ai-workspace-window[data-presentation="native"]'),
  ).toBeVisible();
  await expect
    .poll(() => nativeAiWindowState(application!))
    .toMatchObject({ parentTitle: null, minimized: false, visible: true });
  await reopenedAiPage.close();
});

async function nativeAiWindowState(application: ElectronApplication): Promise<{
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly parentTitle: string | null;
  readonly visible: boolean;
}> {
  return application.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find(
      (window) =>
        (window as unknown as { panelWindowRole?: string }).panelWindowRole === "ai-assistant",
    );
    if (child === undefined) throw new Error("AI BrowserWindow is unavailable");
    return {
      focused: child.isFocused(),
      minimized: child.isMinimized(),
      parentTitle: child.getParentWindow()?.getTitle() ?? null,
      visible: child.isVisible(),
    };
  });
}

async function nativeAiLayoutSnapshot(page: Page): Promise<{
  readonly shellDisplay: string;
  readonly bodyDisplay: string;
  readonly bodyGridColumns: string;
  readonly headerHeight: number;
  readonly fontFamily: string;
  readonly inputFontSize: string;
  readonly suggestionDisplay: string;
  readonly emptyWidth: number;
  readonly canvasColor: string;
  readonly externalStyleSheets: readonly string[];
  readonly contentSecurityPolicy: string;
}> {
  return page.evaluate(() => {
    const required = <ElementType extends Element>(selector: string): ElementType => {
      const element = document.querySelector<ElementType>(selector);
      if (element === null) throw new Error(`Missing AI window element: ${selector}`);
      return element;
    };
    const shell = required<HTMLElement>('.ai-workspace-window[data-presentation="native"]');
    const body = required<HTMLElement>(".ai-workspace-window__body");
    const header = required<HTMLElement>(".ai-workspace-window__header");
    const input = required<HTMLTextAreaElement>(".ai-workspace-window__input");
    const suggestions = required<HTMLElement>(".ai-workspace-window__suggestions");
    const empty = required<HTMLElement>(".ai-workspace-window__empty");
    return {
      shellDisplay: getComputedStyle(shell).display,
      bodyDisplay: getComputedStyle(body).display,
      bodyGridColumns: getComputedStyle(body).gridTemplateColumns,
      headerHeight: Math.round(header.getBoundingClientRect().height),
      fontFamily: getComputedStyle(document.body).fontFamily,
      inputFontSize: getComputedStyle(input).fontSize,
      suggestionDisplay: getComputedStyle(suggestions).display,
      emptyWidth: Math.round(empty.getBoundingClientRect().width),
      canvasColor: getComputedStyle(document.body).backgroundColor,
      externalStyleSheets: [...document.styleSheets]
        .map((sheet) => sheet.href)
        .filter((href): href is string => href !== null),
      contentSecurityPolicy:
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
    };
  });
}

test("keeps the primary English surfaces free of Chinese system copy", async () => {
  await selectInterfaceLanguage(mainPage, "en");
  await mainPage.evaluate(() => {
    const hiddenAncestor = document.createElement("div");
    hiddenAncestor.hidden = true;
    hiddenAncestor.dataset.e2eHiddenCopy = "true";
    const hiddenCopy = document.createElement("span");
    hiddenCopy.textContent = "隐藏的测试文案";
    hiddenCopy.title = "隐藏的测试标题";
    hiddenAncestor.append(hiddenCopy);
    document.body.append(hiddenAncestor);
  });

  const surfaces: readonly [string, string, string][] = [
    ["Projects", "#dashboard-tab", "#dashboard-panel"],
    ["Workspace", "#build-tab", "#build-panel"],
    ["Analysis", "#analysis-tab", "#analysis-panel"],
  ];
  for (const [name, trigger, panel] of surfaces) {
    await mainPage.locator(trigger).click();
    await expect(mainPage.locator(panel)).toBeVisible();
    expect(await visibleChineseSystemCopy(mainPage), name).toEqual([]);
  }

  await mainPage.locator('[data-menu-root-trigger="library"]').click();
  await expect(mainPage.locator(".software-library-view")).toBeVisible();
  expect(await visibleChineseSystemCopy(mainPage), "Library").toEqual([]);
});

test("keeps the native AI layout in the built file renderer", async () => {
  const productionWorkspaceRoot = await mkdtemp(join(tmpdir(), "c-block-ai-window-built-e2e-"));
  const productionEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "VITE_DEV_SERVER_URL",
    ),
  );
  let productionApplication: ElectronApplication | undefined;
  try {
    productionApplication = await electron.launch({
      args: ["."],
      chromiumSandbox: true,
      env: { ...productionEnvironment, PANEL_WORKSPACE_ROOT: productionWorkspaceRoot },
    });
    const productionMainPage = await productionApplication.firstWindow();
    await expect(productionMainPage.locator("#workbench-shell")).toBeVisible();
    await expect(productionMainPage.locator("#startup-loader")).toBeHidden();
    await selectInterfaceLanguage(productionMainPage, "en");
    await productionMainPage.locator("#build-tab").click();
    await showAiAssistant(productionMainPage);
    await productionMainPage.evaluate(() => {
      const background = document.querySelector<HTMLSelectElement>("#interface-background");
      if (background === null) throw new Error("Interface background control is unavailable");
      background.value = "cool";
      background.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const childWindow = productionApplication.waitForEvent("window");
    await showAiAssistant(productionMainPage);
    await productionMainPage.locator("#ai-assistant-button").click();
    const productionAiPage = await childWindow;
    await productionAiPage.waitForLoadState("domcontentloaded");
    const layout = await nativeAiLayoutSnapshot(productionAiPage);
    expect(layout).toMatchObject({
      shellDisplay: "grid",
      bodyDisplay: "grid",
      headerHeight: 40,
      inputFontSize: "13px",
      suggestionDisplay: "grid",
      canvasColor: "rgb(237, 242, 244)",
    });
    expect(layout.bodyGridColumns).toMatch(/^216px\s+/u);
    expect(layout.fontFamily).toContain("system-ui");
    expect(layout.externalStyleSheets).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/assets\/ai-window-[^/]+\.css$/u)]),
    );
    expect(layout.contentSecurityPolicy).not.toContain("unsafe-inline");
  } finally {
    await productionApplication?.close();
    await rm(productionWorkspaceRoot, { recursive: true, force: true });
  }
});

async function selectInterfaceLanguage(page: Page, locale: "zh-CN" | "en"): Promise<void> {
  await page.evaluate((nextLocale) => {
    const language = document.querySelector<HTMLSelectElement>("#interface-language");
    if (language === null) throw new Error("Interface language control is unavailable");
    language.value = nextLocale;
    language.dispatchEvent(new Event("change", { bubbles: true }));
  }, locale);
}

async function visibleChineseSystemCopy(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const containsHan = (value: string): boolean => /[\u3400-\u9fff]/u.test(value);
    const excluded = "script, style, code, pre, textarea, .cm-editor, [data-user-content]";
    const visible = (element: Element): boolean => {
      if (element.getClientRects().length === 0) return false;
      for (
        let current: Element | null = element;
        current !== null;
        current = current.parentElement
      ) {
        const style = getComputedStyle(current);
        if (
          (current as HTMLElement).hidden ||
          current.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden" ||
          style.opacity === "0"
        ) {
          return false;
        }
      }
      return true;
    };
    const findings = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const value = node.textContent?.trim() ?? "";
      if (
        parent === null ||
        value.length === 0 ||
        !containsHan(value) ||
        parent.closest(excluded) !== null ||
        !visible(parent)
      ) {
        continue;
      }
      findings.add(value);
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      "[aria-label], [title], [placeholder]",
    )) {
      if (!visible(element) || element.closest(excluded) !== null) continue;
      for (const attribute of ["aria-label", "title", "placeholder"] as const) {
        const value = element.getAttribute(attribute)?.trim() ?? "";
        if (containsHan(value)) findings.add(`${attribute}: ${value}`);
      }
    }
    return [...findings].sort();
  });
}
