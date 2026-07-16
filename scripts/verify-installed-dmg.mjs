import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";
import {
  mountDmgArguments,
  requireMacPlatform,
  selectSingleArtifact,
  validateAsarEntries,
  validateAdHocSignatureDetails,
  validateBundleMetadata,
  validateBundleExecutableName,
  validateDeveloperIdSignatureDetails,
  validateGatekeeperAssessment,
  validateInstalledWorkbenchSnapshot,
  validateProductBundleName,
  validateReleaseEntitlements,
  validateUniversalArchitectures,
} from "./lib/installed-dmg-gate.mjs";

const runFile = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commandOptions = Object.freeze({
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  timeout: 60_000,
});

requireMacPlatform(process.platform);
const requireAppleTrust = parseVerificationMode(process.argv.slice(2));
const releaseDirectory = join(projectRoot, requireAppleTrust ? "release" : "release-beta");

let application;
let mountAttempted = false;
let detached = false;
let temporaryRoot;
let mountPoint;
const cleanupFailures = [];

try {
  const releaseEntries = await describeDirectory(releaseDirectory);
  const dmgName = selectSingleArtifact(releaseEntries, ".dmg", "file", "release/ 中的 DMG");
  const dmgPath = join(releaseDirectory, dmgName);

  temporaryRoot = await mkdtemp(join(tmpdir(), "c-block-installed-dmg-"));
  mountPoint = join(temporaryRoot, "mounted-dmg");
  const installDirectory = join(temporaryRoot, "Applications");
  await mkdir(mountPoint);
  await mkdir(installDirectory);

  await runFile("/usr/bin/hdiutil", ["verify", dmgPath], commandOptions);
  mountAttempted = true;
  await runFile("/usr/bin/hdiutil", mountDmgArguments(dmgPath, mountPoint), commandOptions);

  const mountedEntries = await describeDirectory(mountPoint);
  const appName = selectSingleArtifact(mountedEntries, ".app", "directory", "DMG 中的 .app");
  validateProductBundleName(appName);
  const mountedApp = join(mountPoint, appName);
  const installedApp = join(installDirectory, appName);
  await runFile("/usr/bin/ditto", [mountedApp, installedApp], commandOptions);

  await detachMountedDmg(mountPoint);
  detached = true;

  const plistPath = join(installedApp, "Contents", "Info.plist");
  const executableName = validateBundleExecutableName(
    await readPlistValue(plistPath, "CFBundleExecutable"),
  );
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  validateBundleMetadata(
    {
      identifier: await readPlistValue(plistPath, "CFBundleIdentifier"),
      name: await readPlistValue(plistPath, "CFBundleName"),
      executable: executableName,
      version: await readPlistValue(plistPath, "CFBundleShortVersionString"),
    },
    manifest.version,
  );
  const executablePath = join(installedApp, "Contents", "MacOS", executableName);
  const executableStat = await lstat(executablePath);
  if (!executableStat.isFile()) throw new Error("复制后的 Contents/MacOS 可执行文件无效");
  await access(executablePath, constants.X_OK);
  await runFile(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", installedApp],
    commandOptions,
  );
  const signature = await runFile(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", installedApp],
    commandOptions,
  );
  if (requireAppleTrust) {
    const applicationTeam = validateDeveloperIdSignatureDetails(
      `${signature.stdout}\n${signature.stderr}`,
    );
    const appEntitlements = await runFile(
      "/usr/bin/codesign",
      ["--display", "--entitlements", ":-", installedApp],
      commandOptions,
    );
    validateReleaseEntitlements(`${appEntitlements.stdout}\n${appEntitlements.stderr}`, "主应用");
    const frameworksDirectory = join(installedApp, "Contents", "Frameworks");
    const frameworkEntries = await describeDirectory(frameworksDirectory);
    const rendererHelperName = selectSingleArtifact(
      frameworkEntries,
      " Helper (Renderer).app",
      "directory",
      "Renderer Helper",
    );
    const rendererHelper = join(frameworksDirectory, rendererHelperName);
    const rendererSignature = await runFile(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", rendererHelper],
      commandOptions,
    );
    const rendererTeam = validateDeveloperIdSignatureDetails(
      `${rendererSignature.stdout}\n${rendererSignature.stderr}`,
    );
    if (rendererTeam !== applicationTeam) {
      throw new Error("主应用与 Renderer Helper 的 Developer ID 团队不一致");
    }
    const rendererEntitlements = await runFile(
      "/usr/bin/codesign",
      ["--display", "--entitlements", ":-", rendererHelper],
      commandOptions,
    );
    validateReleaseEntitlements(
      `${rendererEntitlements.stdout}\n${rendererEntitlements.stderr}`,
      "Renderer Helper",
    );
    await runFile(
      "/usr/bin/xattr",
      [
        "-w",
        "com.apple.quarantine",
        "0081;00000000;AlgoLatch;00000000-0000-0000-0000-000000000000",
        installedApp,
      ],
      commandOptions,
    );
    const assessment = await runFile(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=4", installedApp],
      commandOptions,
    );
    validateGatekeeperAssessment(`${assessment.stdout}\n${assessment.stderr}`);
    await runFile("/usr/bin/xcrun", ["stapler", "validate", installedApp], commandOptions);
  } else {
    validateAdHocSignatureDetails(`${signature.stdout}\n${signature.stderr}`);
  }
  const { stdout: architectures } = await runFile(
    "/usr/bin/lipo",
    ["-archs", executablePath],
    commandOptions,
  );
  validateUniversalArchitectures(architectures);
  const asarPath = join(installedApp, "Contents", "Resources", "app.asar");
  const asarCli = join(projectRoot, "node_modules", "@electron", "asar", "bin", "asar.js");
  const { stdout: asarEntries } = await runFile(
    process.execPath,
    [asarCli, "list", asarPath],
    commandOptions,
  );
  validateAsarEntries(asarEntries);

  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) => entry[1] !== undefined && entry[0] !== "VITE_DEV_SERVER_URL",
    ),
  );
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(temporaryRoot, "user-data")}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_INSTALLED_DMG_GATE: "1",
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: join(temporaryRoot, "workspace"),
    },
    timeout: 30_000,
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  const rendererDiagnostics = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      rendererDiagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => rendererDiagnostics.push(`pageerror: ${formatError(error)}`));
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#startup-loader").waitFor({ state: "hidden", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#parser-status")?.getAttribute("data-state") === "ready",
    undefined,
    { timeout: 30_000 },
  );
  const dashboardInitiallyVisible = await page.locator("#dashboard-panel").isVisible();

  await page.locator('[data-tour-target="create-entry"]').click();
  const create = page.locator("dialog.workspace-create-dialog");
  await create.locator("select").selectOption("project");
  await create.locator('input[type="text"]').fill("Installed Gate");
  await create.locator('button[type="submit"]').click();
  const source =
    "int main(void) {\n  int value = 1;\n  value++;\n  return value == 2 ? 0 : 1;\n}\n";
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(source);
  try {
    await page.waitForFunction(
      () =>
        document.querySelector("#parser-status")?.getAttribute("data-state") === "ready" &&
        document.querySelector("#parser-status")?.getAttribute("data-analysis-state") ===
          "complete" &&
        document.querySelector("#workspace-save-status")?.getAttribute("data-state") === "saved",
      undefined,
      { timeout: 30_000 },
    );
  } catch (error) {
    const states = await page.evaluate(() => {
      const parser = document.querySelector("#parser-status");
      const save = document.querySelector("#workspace-save-status");
      return {
        parser: parser?.getAttribute("data-state") ?? "missing",
        analysis: parser?.getAttribute("data-analysis-state") ?? "missing",
        save: save?.getAttribute("data-state") ?? "missing",
        parserText: parser?.textContent?.trim() ?? "",
        saveText: save?.textContent?.trim() ?? "",
      };
    });
    throw new Error(
      `编辑后状态未收敛：parser=${states.parser}, analysis=${states.analysis}, save=${states.save}; ` +
        `parserText=${JSON.stringify(states.parserText)}, saveText=${JSON.stringify(states.saveText)}, ` +
        `renderer=${JSON.stringify(rendererDiagnostics.slice(-8))}; ` +
        `原始错误=${formatError(error)}`,
    );
  }
  await page.locator(".flow-node").first().waitFor({ state: "visible", timeout: 30_000 });
  const appIsPackaged = await application.evaluate(({ app }) => app.isPackaged);

  const snapshot = await page.evaluate(
    ({ packaged, dashboardWasVisible }) => {
      const startup = document.querySelector("#startup-loader");
      const dashboard = document.querySelector("#dashboard-panel");
      const parser = document.querySelector("#parser-status");
      return {
        appIsPackaged: packaged,
        protocol: globalThis.location.protocol,
        startupHidden: startup instanceof HTMLElement && startup.hidden,
        dashboardVisible: dashboardWasVisible,
        dockLabels: Array.from(document.querySelectorAll("[data-menu-root-trigger]"), (element) =>
          element.textContent?.trim(),
        ),
        parserState: parser?.getAttribute("data-state"),
        analysisState: parser?.getAttribute("data-analysis-state"),
        flowNodeCount: document.querySelectorAll(".flow-node").length,
      };
    },
    { packaged: appIsPackaged, dashboardWasVisible: dashboardInitiallyVisible },
  );
  validateInstalledWorkbenchSnapshot(snapshot);

  await application.close();
  application = undefined;
  const trustLabel = requireAppleTrust
    ? "Developer ID、公证票据、Gatekeeper、"
    : "显式未签名 Beta、";
  console.log(
    `✓ 已安装 DMG 门禁通过：${dmgName}（${trustLabel}复制、卸载后启动、Dashboard/Dock/parser）`,
  );
} catch (error) {
  console.error(`✗ 已安装 DMG 门禁失败：${formatError(error)}`);
  process.exitCode = 1;
} finally {
  if (application !== undefined) {
    try {
      await application.close();
    } catch (error) {
      cleanupFailures.push(`Electron 关闭失败：${formatError(error)}`);
    }
  }
  if (mountAttempted && !detached && mountPoint !== undefined) {
    try {
      await detachMountedDmg(mountPoint);
      detached = true;
    } catch (error) {
      cleanupFailures.push(`DMG 卸载失败：${formatError(error)}`);
    }
  }
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(`临时目录清理失败：${formatError(error)}`);
    }
  }
  for (const failure of cleanupFailures) console.error(`✗ ${failure}`);
  if (cleanupFailures.length > 0) process.exitCode = 1;
}

async function describeDirectory(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
  }));
}

async function readPlistValue(plistPath, key) {
  const { stdout } = await runFile(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plistPath],
    commandOptions,
  );
  return stdout.trim();
}

async function detachMountedDmg(path) {
  await runFile("/usr/bin/hdiutil", ["detach", path], commandOptions);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseVerificationMode(args) {
  if (args.length === 0) return true;
  if (args.length === 1 && args[0] === "--allow-unsigned") return false;
  throw new Error(`未知 DMG 验证参数：${args.join(" ")}`);
}
