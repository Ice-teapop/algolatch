import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";
import {
  WINDOWS_CANARY_STDOUT,
  WINDOWS_EXECUTABLE_NAME,
  WINDOWS_UNINSTALLER_NAME,
  parseJsonDocument,
  parsePowerShellJson,
  parseWindowsVerificationMode,
  readPeOffset,
  requireWindowsInstallGate,
  selectWindowsInstaller,
  validateAsarEntries,
  validateAuthenticodeSignatureRecord,
  validateAuthenticodeSignatures,
  validateInstalledWorkbenchSnapshot,
  validateUninstallOutcome,
  validateWindowsBrokerMetrics,
  validateWindowsBrokerProcessOutcome,
  validateWindowsInstalledCapabilities,
  validateWindowsRuntimeDigests,
  validateWindowsRuntimeManifest,
  validateWindowsVersionInfo,
  validateX64PeHeader,
  windowsInstallerArguments,
  windowsJobHostArguments,
  windowsUninstallerArguments,
} from "./lib/installed-windows-gate.mjs";
import { WINDOWS_TOOLCHAIN, sha256File } from "./lib/windows-toolchain.mjs";

const runFile = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commandOptions = Object.freeze({
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  timeout: 120_000,
  windowsHide: true,
});
const canaryLimits = Object.freeze({
  memoryBytes: 512 * 1024 * 1024,
  processLimit: 8,
  cpuMs: 30_000,
});
const canarySource = `#include <stdio.h>
#include <windows.h>

int main(void) {
  Sleep(75);
  if (fputs("ALGOLATCH_WINDOWS_CANARY\\n", stdout) == EOF) {
    return 2;
  }
  return 0;
}
`;
const authenticodeScript = String.raw`
$ErrorActionPreference = 'Stop'
$targets = ConvertFrom-Json -InputObject $env:PANEL_WINDOWS_SIGNATURE_TARGETS
$results = @($targets | ForEach-Object {
  $signature = Get-AuthenticodeSignature -LiteralPath $_.path
  [pscustomobject]@{
    label = [string]$_.label
    status = [string]$signature.Status
    signerSubject = [string]$signature.SignerCertificate.Subject
    signerThumbprint = [string]$signature.SignerCertificate.Thumbprint
    timestampSubject = [string]$signature.TimeStamperCertificate.Subject
    timestampThumbprint = [string]$signature.TimeStamperCertificate.Thumbprint
  }
})
ConvertTo-Json -InputObject $results -Compress -Depth 4
`;
const versionInfoScript = String.raw`
$ErrorActionPreference = 'Stop'
$info = (Get-Item -LiteralPath $env:PANEL_WINDOWS_APP_EXECUTABLE).VersionInfo
[pscustomobject]@{
  productName = [string]$info.ProductName
  productVersion = [string]$info.ProductVersion
  fileVersion = [string]$info.FileVersion
} | ConvertTo-Json -Compress
`;

requireWindowsInstallGate(process.platform, process.env);
const mode = parseWindowsVerificationMode(process.argv.slice(2));
const releaseDirectory = join(projectRoot, mode.releaseDirectoryName);

let application;
let temporaryRoot;
let installedExecutable;
let projectSourcePath;
const cleanupFailures = [];

try {
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const releaseEntries = await describeDirectory(releaseDirectory);
  const installerName = selectWindowsInstaller(releaseEntries, {
    directoryLabel: `${mode.releaseDirectoryName}/`,
    expectedVersion: manifest.version,
    requireAuthenticode: mode.requireAuthenticode,
  });
  const installerPath = join(releaseDirectory, installerName);
  let installerSignature;
  if (mode.requireAuthenticode) {
    const installerSignatures = await inspectAuthenticode([
      { label: "installer", path: installerPath },
    ]);
    if (!Array.isArray(installerSignatures) || installerSignatures.length !== 1) {
      throw new Error("installer Authenticode 检查没有返回唯一结果");
    }
    installerSignature = installerSignatures[0];
    validateAuthenticodeSignatureRecord(installerSignature, "installer");
  }

  temporaryRoot = await mkdtemp(join(tmpdir(), "algolatch-installed-windows-"));
  const installDirectory = join(temporaryRoot, "installed-app");
  const workspaceRoot = join(temporaryRoot, "workspace");
  const userDataRoot = join(temporaryRoot, "user-data");
  installedExecutable = join(installDirectory, WINDOWS_EXECUTABLE_NAME);
  const uninstallerPath = join(installDirectory, WINDOWS_UNINSTALLER_NAME);

  await runFile(installerPath, windowsInstallerArguments(installDirectory), commandOptions);
  await waitForPath(installedExecutable, true, "安装后的 AlgoLatch.exe");
  await waitForPath(uninstallerPath, true, "安装后的 AlgoLatch uninstaller");
  await access(installedExecutable, constants.R_OK);

  const versionInfo = await inspectWindowsVersionInfo(installedExecutable);
  validateWindowsVersionInfo(versionInfo, manifest.version);
  await validateX64Executable(installedExecutable);

  if (mode.requireAuthenticode) {
    const signatures = await inspectAuthenticode([
      { label: "application", path: installedExecutable },
      { label: "uninstaller", path: uninstallerPath },
    ]);
    validateAuthenticodeSignatures([installerSignature, ...signatures]);
  }

  const asarPath = join(installDirectory, "resources", "app.asar");
  const asarCli = join(projectRoot, "node_modules", "@electron", "asar", "bin", "asar.js");
  const { stdout: asarEntries } = await runFile(
    process.execPath,
    [asarCli, "list", asarPath],
    commandOptions,
  );
  validateAsarEntries(asarEntries);
  await verifyInstalledWindowsRuntime(installDirectory, temporaryRoot);

  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && name !== "VITE_DEV_SERVER_URL",
    ),
  );
  application = await electron.launch({
    executablePath: installedExecutable,
    args: [`--user-data-dir=${userDataRoot}`],
    chromiumSandbox: true,
    env: {
      ...inheritedEnvironment,
      PANEL_WINDOWS_INSTALL_GATE: "1",
      PANEL_INSTALLED_PACKAGE_GATE: "1",
      PANEL_RUNNER_MODE: "trusted-only",
      PANEL_WORKSPACE_ROOT: workspaceRoot,
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
  const runnerCapabilities = await page.evaluate(() => window.panelApi.capabilities());
  validateWindowsInstalledCapabilities(runnerCapabilities);
  const dashboardInitiallyVisible = await page.locator("#dashboard-panel").isVisible();

  await page.locator('[data-tour-target="create-entry"]').click();
  const create = page.locator("dialog.workspace-create-dialog");
  await create.locator("select").selectOption("project");
  await create.locator('input[type="text"]').fill("Windows Installed Gate");
  await create.locator('button[type="submit"]').click();
  const source =
    "int main(void) {\n  int value = 1;\n  value++;\n  return value == 2 ? 0 : 1;\n}\n";
  await page.locator("#main-source-tab").click();
  const editor = page.locator('#code-pane [role="textbox"][aria-label]');
  await editor.click();
  await page.keyboard.press("Control+A");
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
    throw new Error(
      `Windows 安装态项目保存未收敛：${formatError(error)}；renderer=${JSON.stringify(rendererDiagnostics.slice(-8))}`,
    );
  }
  await page.locator(".flow-node").first().waitFor({ state: "visible", timeout: 30_000 });

  const projectDirectories = await readdir(join(workspaceRoot, "Projects"));
  if (projectDirectories.length !== 1 || projectDirectories[0] === undefined) {
    throw new Error(`Windows 安装态门禁期望创建一个项目，实际 ${projectDirectories.length} 个`);
  }
  projectSourcePath = join(workspaceRoot, "Projects", projectDirectories[0], "main.c");
  if ((await readFile(projectSourcePath, "utf8")) !== source) {
    throw new Error("Windows 安装态项目没有原样保存到专用工作区");
  }

  const appIsPackaged = await application.evaluate(({ app }) => app.isPackaged);
  const snapshot = await page.evaluate(
    ({ packaged, dashboardWasVisible }) => {
      const startup = document.querySelector("#startup-loader");
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
  await runFile(uninstallerPath, windowsUninstallerArguments(), commandOptions);
  await waitForPath(installedExecutable, false, "卸载后的 AlgoLatch.exe");
  await waitForPath(uninstallerPath, false, "卸载后的 AlgoLatch uninstaller");
  validateUninstallOutcome({
    applicationExists: await pathExists(installedExecutable),
    uninstallerExists: await pathExists(uninstallerPath),
    projectExists: await pathExists(projectSourcePath),
  });

  const trustLabel = mode.requireAuthenticode
    ? "Authenticode 发布者与时间戳、"
    : "显式未签名 Beta、";
  console.log(
    `✓ Windows 安装态门禁通过：${installerName}（${trustLabel}x64、runtime manifest/hash、Job Object 编译运行 canary、capabilities、Dashboard/Dock/parser、保存、卸载保留项目）`,
  );
} catch (error) {
  console.error(`✗ Windows 安装态门禁失败：${formatError(error)}`);
  process.exitCode = 1;
} finally {
  if (application !== undefined) {
    try {
      await application.close();
    } catch (error) {
      cleanupFailures.push(`Electron 关闭失败：${formatError(error)}`);
    }
  }
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(`Windows 门禁专用测试数据清理失败：${formatError(error)}`);
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

async function inspectAuthenticode(targets) {
  const { stdout } = await runFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", authenticodeScript],
    {
      ...commandOptions,
      env: { ...process.env, PANEL_WINDOWS_SIGNATURE_TARGETS: JSON.stringify(targets) },
    },
  );
  const records = parsePowerShellJson(stdout, "Authenticode 检查");
  if (!Array.isArray(records)) throw new Error("Authenticode 检查没有返回数组");
  return records;
}

async function inspectWindowsVersionInfo(executablePath) {
  const { stdout } = await runFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", versionInfoScript],
    {
      ...commandOptions,
      env: { ...process.env, PANEL_WINDOWS_APP_EXECUTABLE: executablePath },
    },
  );
  return parsePowerShellJson(stdout, "Windows 版本资源检查");
}

async function validateX64Executable(executablePath) {
  const handle = await open(executablePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    const peOffset = readPeOffset(dosHeader.subarray(0, dosRead.bytesRead));
    const peHeader = Buffer.alloc(6);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    validateX64PeHeader(peHeader.subarray(0, peRead.bytesRead));
  } finally {
    await handle.close();
  }
}

async function verifyInstalledWindowsRuntime(installDirectory, temporaryDirectory) {
  const runtimeRoot = join(installDirectory, "resources", "windows-runtime");
  const manifestPath = join(runtimeRoot, "toolchain-manifest.json");
  await assertOrdinaryFile(manifestPath, "Windows runtime manifest");
  const manifest = validateWindowsRuntimeManifest(
    parseJsonDocument(await readFile(manifestPath, "utf8"), "Windows runtime manifest"),
  );
  const manifestPaths = Object.keys(manifest.files);
  await validateInstalledRuntimeDirectoryCoverage(runtimeRoot, manifestPaths);
  const installedFiles = await resolveInstalledRuntimeFiles(runtimeRoot, manifestPaths);
  const actualDigests = Object.fromEntries(
    await Promise.all(
      manifestPaths.map(async (relativePath) => [
        relativePath,
        await sha256File(installedFiles[relativePath]),
      ]),
    ),
  );
  validateWindowsRuntimeDigests(manifest, actualDigests);

  const canaryDirectory = join(temporaryDirectory, "windows-runtime-canary");
  await mkdir(canaryDirectory);
  const sourcePath = join(canaryDirectory, "installed-runtime-canary.c");
  const executablePath = join(canaryDirectory, "installed-runtime-canary.exe");
  const compileMetricsPath = join(canaryDirectory, "compile-metrics.json");
  const runMetricsPath = join(canaryDirectory, "run-metrics.json");
  await writeFile(sourcePath, canarySource, { encoding: "utf8", flag: "wx" });

  const jobHostPath = installedFiles["runtime/algolatch-job-host.exe"];
  const clangPath = installedFiles["toolchain/bin/clang.exe"];
  const environment = windowsCanaryEnvironment(
    canaryDirectory,
    join(runtimeRoot, "toolchain", "bin"),
  );
  const compileOutcome = await executeFileOutcome(
    jobHostPath,
    windowsJobHostArguments({
      metricsPath: compileMetricsPath,
      ...canaryLimits,
      command: clangPath,
      args: [
        `--target=${WINDOWS_TOOLCHAIN.target}`,
        "-std=c17",
        "-fintegrated-cc1",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        "-fno-color-diagnostics",
        "-O0",
        "-g0",
        "-fuse-ld=lld",
        "-Wl,--no-insert-timestamp",
        sourcePath,
        "-o",
        executablePath,
      ],
    }),
    canaryDirectory,
    environment,
  );
  validateWindowsBrokerProcessOutcome(compileOutcome, {
    label: "已安装 Job Object broker 编译 canary",
    expectedStdout: "",
  });
  validateWindowsBrokerMetrics(
    parseJsonDocument(await readFile(compileMetricsPath, "utf8"), "broker compile metrics"),
    {
      label: "broker compile",
      maxRssBytes: canaryLimits.memoryBytes,
      maxProcessCount: canaryLimits.processLimit,
    },
  );
  await assertOrdinaryFile(executablePath, "broker 编译生成的 canary.exe");

  const runOutcome = await executeFileOutcome(
    jobHostPath,
    windowsJobHostArguments({
      metricsPath: runMetricsPath,
      ...canaryLimits,
      command: executablePath,
      args: [],
    }),
    canaryDirectory,
    environment,
  );
  validateWindowsBrokerProcessOutcome(runOutcome, {
    label: "已安装 Job Object broker 运行 canary",
    expectedStdout: WINDOWS_CANARY_STDOUT,
  });
  validateWindowsBrokerMetrics(
    parseJsonDocument(await readFile(runMetricsPath, "utf8"), "broker run metrics"),
    {
      label: "broker run",
      maxRssBytes: canaryLimits.memoryBytes,
      maxProcessCount: canaryLimits.processLimit,
    },
  );
}

async function assertOrdinaryFile(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} 缺失或不是普通文件`);
  }
}

async function resolveInstalledRuntimeFiles(runtimeRoot, manifestPaths) {
  const rootMetadata = await lstat(runtimeRoot).catch(() => null);
  if (rootMetadata === null || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Windows runtime 根目录缺失或不是普通目录");
  }
  const canonicalRoot = await realpath(runtimeRoot);
  const files = {};
  for (const manifestPath of manifestPaths) {
    const lexicalPath = resolve(runtimeRoot, ...manifestPath.split("/"));
    assertContainedPath(runtimeRoot, lexicalPath, manifestPath);
    await assertOrdinaryFile(lexicalPath, `Windows runtime ${manifestPath}`);
    const canonicalPath = await realpath(lexicalPath);
    assertContainedPath(canonicalRoot, canonicalPath, manifestPath);
    files[manifestPath] = canonicalPath;
  }
  return Object.freeze(files);
}

async function validateInstalledRuntimeDirectoryCoverage(runtimeRoot, manifestPaths) {
  const binDirectory = join(runtimeRoot, "toolchain", "bin");
  const installedBinPaths = (await readdir(binDirectory, { withFileTypes: true }))
    .map((entry) => `toolchain/bin/${entry.name}`)
    .sort(compareCodePoints);
  const manifestBinPaths = manifestPaths
    .filter((path) => path.startsWith("toolchain/bin/"))
    .sort(compareCodePoints);
  if (installedBinPaths.join("\n") !== manifestBinPaths.join("\n")) {
    throw new Error("Windows runtime manifest 没有精确覆盖已安装 toolchain/bin");
  }

  const installedRuntimePaths = (
    await readdir(join(runtimeRoot, "runtime"), { withFileTypes: true })
  )
    .map((entry) => `runtime/${entry.name}`)
    .sort(compareCodePoints);
  const manifestRuntimePaths = manifestPaths
    .filter((path) => path.startsWith("runtime/"))
    .sort(compareCodePoints);
  if (installedRuntimePaths.join("\n") !== manifestRuntimePaths.join("\n")) {
    throw new Error("Windows runtime manifest 没有精确覆盖已安装 runtime 目录");
  }
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertContainedPath(root, candidate, label) {
  const relativePath = relative(root, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Windows runtime manifest 路径逃逸：${label}`);
  }
}

async function executeFileOutcome(command, args, cwd, env) {
  try {
    const { stdout, stderr } = await runFile(command, args, {
      ...commandOptions,
      cwd,
      env,
      shell: false,
    });
    return Object.freeze({
      exitCode: 0,
      signal: null,
      stdout,
      stderr,
      errorMessage: null,
    });
  } catch (error) {
    return Object.freeze({
      exitCode: Number.isSafeInteger(error?.code) ? error.code : null,
      signal: typeof error?.signal === "string" ? error.signal : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
      errorMessage: formatError(error),
    });
  }
}

function windowsCanaryEnvironment(workDirectory, toolchainBin) {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined || windowsRoot.trim().length === 0) {
    throw new Error("Windows runtime canary 缺少 SystemRoot/WINDIR");
  }
  return Object.freeze({
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    HOME: workDirectory,
    USERPROFILE: workDirectory,
    LANG: "C",
    LC_ALL: "C",
    PATH: `${toolchainBin};${join(windowsRoot, "System32")}`,
    TEMP: workDirectory,
    TMP: workDirectory,
  });
}

async function waitForPath(path, expected, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await pathExists(path)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label}${expected ? "没有出现" : "没有删除"}`);
}

async function pathExists(path) {
  try {
    const stat = await lstat(path);
    return stat.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
