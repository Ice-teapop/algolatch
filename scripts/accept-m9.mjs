import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";

const expected = Object.freeze({
  version: "0.0.2",
  engine: ">=24.0.0 <25",
  npm: "npm@11.11.0",
  repository: "https://github.com/Ice-teapop/algolatch.git",
  builderConfig: "build/electron-builder.release.json",
  windowsBuilderConfig: "build/electron-builder.windows.release.json",
  windowsBetaBuilderConfig: "build/electron-builder.windows.beta.json",
});

const root = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);
const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
const failures = [];
let checks = 0;

const readText = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await readText(path));

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function includes(text, fragment, label) {
  check(text.includes(fragment), `${label} 缺少 ${fragment}`);
}

function findRelativeMarkdownLinks(text) {
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith("#") && !/^[a-z][a-z\d+.-]*:/iu.test(target));
}

function assertOrderedWorkflowStages(workflow, stages, label) {
  let previousIndex = -1;
  for (const stage of stages) {
    const index = workflow.indexOf(stage.fragment);
    if (index < 0) throw new Error(`${label} 缺少${stage.label}`);
    if (index <= previousIndex) throw new Error(`${label} 的${stage.label}顺序不安全`);
    previousIndex = index;
  }
}

const [
  manifest,
  lockfile,
  builder,
  betaBuilder,
  windowsBuilder,
  windowsBetaBuilder,
  ci,
  release,
  toolchain,
  credentialGate,
  windowsCredentialGate,
  installedDmgGate,
  installedDmgSupport,
  installedWindowsGate,
  installedWindowsSupport,
  entitlements,
  inheritedEntitlements,
  gitignore,
  license,
  nvmrc,
  nodeVersion,
  workspaceRootSource,
  playwrightConfiguration,
] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson(expected.builderConfig),
  readJson("build/electron-builder.beta.json"),
  readJson(expected.windowsBuilderConfig),
  readJson(expected.windowsBetaBuilderConfig),
  readText(".github/workflows/ci.yml"),
  readText(".github/workflows/release.yml"),
  readText("scripts/verify-toolchain.mjs"),
  readText("scripts/verify-macos-release-credentials.mjs"),
  readText("scripts/verify-windows-release-credentials.mjs"),
  readText("scripts/verify-installed-dmg.mjs"),
  readText("scripts/lib/installed-dmg-gate.mjs"),
  readText("scripts/verify-installed-windows.mjs"),
  readText("scripts/lib/installed-windows-gate.mjs"),
  readText("build/entitlements.mac.plist"),
  readText("build/entitlements.mac.inherit.plist"),
  readText(".gitignore"),
  readText("LICENSE"),
  readText(".nvmrc"),
  readText(".node-version"),
  readText("electron/main/workspace-root.ts"),
  readText("playwright.config.ts"),
]);
const legacyPersistenceSources = await Promise.all(
  [
    "src/ui/interface-preferences.ts",
    "src/ui/theme-controller.ts",
    "src/learning/contracts.ts",
    "src/ui/ai-edit-permission.ts",
    "src/ui/ai-workspace-window.ts",
    "src/app/ai-workspace-integration.ts",
    "src/app/guided-lesson-workspace-controller.ts",
  ].map(readText),
);
const workspaceStoreSource = await readText("electron/main/workspace-store.ts");
const currentReleaseNotes = await readText(`docs/releases/v${expected.version}.md`);
const releaseNotePaths = (await readdir(new URL("docs/releases/", root)))
  .filter((path) => path.endsWith(".md"))
  .sort();
const releaseNotes = await Promise.all(
  releaseNotePaths.map(async (path) => [path, await readText(`docs/releases/${path}`)]),
);

check(manifest.version === expected.version, `package version 必须为 ${expected.version}`);
check(/^0\.\d+\.\d+$/u.test(manifest.version), "当前公开版本线只允许 0.x.y 初始版本");
check(manifest.name === "c-block-algorithm-panel", "内部 package name 必须保持旧数据兼容");
check(manifest.private === true, "npm 包必须保持 private，防止误发布到 npm");
check(manifest.license === "MIT", "package license 必须为 MIT");
check(manifest.packageManager === expected.npm, `packageManager 必须为 ${expected.npm}`);
check(manifest.engines?.node === expected.engine, `engines.node 必须为 ${expected.engine}`);
check(nvmrc.trim() === "24.14.0", ".nvmrc 必须固定当前 Node 24 LTS");
check(nodeVersion.trim() === "24.14.0", ".node-version 必须固定当前 Node 24 LTS");
check(manifest.repository?.url === expected.repository, "GitHub repository 元数据不正确");
includes(currentReleaseNotes, `# AlgoLatch v${expected.version}`, "current release notes");
includes(currentReleaseNotes, "Authenticode", "current release notes");
check(
  !currentReleaseNotes.includes("Control-click bypass required"),
  "签名版说明不得要求绕过 Gatekeeper",
);
for (const [path, notes] of releaseNotes) {
  const relativeLinks = findRelativeMarkdownLinks(notes);
  check(
    relativeLinks.length === 0,
    `docs/releases/${path} 含有在 GitHub Release 页面失效的相对链接：${relativeLinks.join(", ")}`,
  );
}
check(
  manifest.build?.extends === `file:${expected.builderConfig}`,
  "package.json 默认 build 必须继承 release 配置",
);
check(manifest.build?.mac?.icon === "build/icon.icns", "package.json 缺少 macOS 图标入口");
check(manifest.scripts?.["accept:m9"] === "node scripts/accept-m9.mjs", "缺少 accept:m9");
check(
  manifest.scripts?.["notices:check"] === "node scripts/generate-third-party-notices.mjs --check",
  "缺少 notices:check",
);
check(
  manifest.scripts?.["verify:installed-dmg"] === "node scripts/verify-installed-dmg.mjs",
  "缺少 verify:installed-dmg",
);
check(
  manifest.scripts?.["verify:installed-dmg:beta"] ===
    "node scripts/verify-installed-dmg.mjs --allow-unsigned",
  "缺少显式未签名 Beta 安装态门禁",
);
check(
  manifest.scripts?.["verify:mac-release-credentials"] ===
    "node scripts/verify-macos-release-credentials.mjs",
  "缺少 macOS 正式发布凭据门禁",
);
check(
  manifest.scripts?.["verify:win-release-credentials"] ===
    "node scripts/verify-windows-release-credentials.mjs",
  "缺少 Windows 正式发布凭据门禁",
);
check(
  manifest.scripts?.["verify:installed-win"] === "node scripts/verify-installed-windows.mjs",
  "缺少 Windows 正式安装态门禁",
);
check(
  manifest.scripts?.["verify:installed-win:beta"] ===
    "node scripts/verify-installed-windows.mjs --allow-unsigned",
  "缺少显式未签名 Windows Beta 安装态门禁",
);
check(
  manifest.scripts?.["accept:m0-m5-regression"] === "node scripts/accept-m0-m5-regression.mjs",
  "缺少 accept:m0-m5-regression",
);
for (const milestone of ["m6", "m7", "m8", "m6-m8"]) {
  check(
    manifest.scripts?.[`accept:${milestone}`] === `node scripts/accept-${milestone}.mjs`,
    `缺少 accept:${milestone}`,
  );
}
includes(manifest.scripts?.["dist:mac"] ?? "", expected.builderConfig, "dist:mac");
includes(manifest.scripts?.["dist:mac"] ?? "", "--publish never", "dist:mac");
includes(manifest.scripts?.["dist:mac"] ?? "", "verify:mac-release-credentials", "dist:mac");
includes(
  manifest.scripts?.["dist:mac:beta"] ?? "",
  "build/electron-builder.beta.json",
  "dist:mac:beta",
);
includes(manifest.scripts?.["dist:win"] ?? "", "verify:win-release-credentials", "dist:win");
includes(manifest.scripts?.["dist:win"] ?? "", "prepare:win-toolchain", "dist:win");
includes(manifest.scripts?.["dist:win"] ?? "", expected.windowsBuilderConfig, "dist:win");
includes(manifest.scripts?.["dist:win"] ?? "", "--publish never", "dist:win");
includes(
  manifest.scripts?.["dist:win:beta"] ?? "",
  expected.windowsBetaBuilderConfig,
  "dist:win:beta",
);
includes(manifest.scripts?.["dist:win:beta"] ?? "", "--publish never", "dist:win:beta");

const directPlatformPin = "@typescript/typescript-darwin-arm64";
check(
  manifest.devDependencies?.[directPlatformPin] === undefined,
  `不得直接锁定 ${directPlatformPin}`,
);

const lockedRoot = lockfile.packages?.[""];
check(lockfile.version === expected.version, "package-lock 顶层 version 与 manifest 不一致");
check(lockedRoot?.version === expected.version, "package-lock 根包 version 与 manifest 不一致");
check(lockedRoot?.license === "MIT", "package-lock 根包缺少 MIT license");
check(lockedRoot?.engines?.node === expected.engine, "package-lock 根包 Node engine 不一致");
check(
  lockedRoot?.devDependencies?.[directPlatformPin] === undefined,
  `package-lock 根包仍直接锁定 ${directPlatformPin}`,
);
check(
  lockfile.packages?.[`node_modules/${directPlatformPin}`]?.optional === true,
  `${directPlatformPin} 只能作为 TypeScript 的可选平台依赖存在`,
);
check(
  lockfile.packages?.["node_modules/typescript"]?.optionalDependencies?.[directPlatformPin] ===
    manifest.devDependencies?.typescript,
  "TypeScript 的可选平台依赖版本与直接 TypeScript 版本不一致",
);

check(builder.appId === "io.han.c-block-algorithm-panel", "electron-builder appId 不正确");
check(builder.productName === "AlgoLatch", "正式构建 productName 必须为 AlgoLatch");
check(builder.directories?.output === "release", "electron-builder 输出目录必须为 release");
for (const packagedDocument of [
  "package-lock.json",
  "LICENSE",
  "NOTICE.md",
  "THIRD_PARTY_NOTICES.md",
  "PRIVACY.md",
  "SECURITY.md",
]) {
  check(builder.files?.includes(packagedDocument), `发布包未包含 ${packagedDocument}`);
}
check(builder.mac?.identity === undefined, "正式构建不得禁用签名或固定证书名称");
check(builder.electronDownload?.force === false, "Electron 下载缓存不得被强制绕过");
check(
  builder.electronDownload?.checksums?.["electron-v43.0.0-darwin-arm64.zip"] ===
    "e6994f68dba65a6371577eaf68ac69a5858d2c52371869837c64affc6157eca5",
  "Electron arm64 官方 SHA-256 必须固定",
);
check(
  builder.electronDownload?.checksums?.["electron-v43.0.0-darwin-x64.zip"] ===
    "c0102711ff41d8329426e2ca7378fa13a467775e721b69ebe413c0898da14f6e",
  "Electron x64 官方 SHA-256 必须固定",
);
check(builder.mac?.forceCodeSigning === true, "正式构建必须 fail-closed 强制代码签名");
check(builder.mac?.type === "distribution", "正式构建必须锁定 distribution 证书类型");
check(builder.mac?.hardenedRuntime === true, "正式构建必须启用 Hardened Runtime");
check(builder.mac?.strictVerify === true, "正式构建必须启用严格签名验证");
check(builder.mac?.preAutoEntitlements === false, "正式构建必须禁用自动 entitlement 扩张");
check(builder.mac?.notarize === true, "正式构建必须启用 notarization");
check(
  builder.mac?.entitlements === "build/entitlements.mac.plist",
  "正式构建缺少主应用 entitlements",
);
check(
  builder.mac?.entitlementsInherit === "build/entitlements.mac.inherit.plist",
  "正式构建缺少继承 entitlements",
);
check(builder.dmg?.sign === false, "公证应用所在 DMG 不应额外签名");
check(
  builder.mac?.artifactName === "AlgoLatch-${version}-${arch}.${ext}",
  "DMG artifactName 必须包含版本、架构和扩展名",
);
check(builder.afterPack === "scripts/after-pack-macos.mjs", "正式 macOS 构建缺少签名前清理");
check(
  builder.mac?.extendInfo?.NSDocumentsFolderUsageDescription ===
    "AlgoLatch stores the local projects you create in its dedicated Documents workspace.",
  "正式 macOS 构建缺少 Documents 用途说明",
);
check(betaBuilder.productName === "AlgoLatch", "Beta 构建 productName 必须为 AlgoLatch");
check(betaBuilder.directories?.output === "release-beta", "未签名 Beta 必须使用独立输出目录");
check(betaBuilder.mac?.identity === "-", "未签名 Beta 必须对完整 bundle 使用 ad-hoc 签名");
check(betaBuilder.afterPack === "scripts/after-pack-macos.mjs", "Beta macOS 构建缺少签名前清理");
check(
  betaBuilder.mac?.extendInfo?.NSDocumentsFolderUsageDescription ===
    "AlgoLatch stores the local projects you create in its dedicated Documents workspace.",
  "Beta macOS 构建缺少 Documents 用途说明",
);
check(betaBuilder.mac?.hardenedRuntime === false, "未签名 Beta 必须禁用 Hardened Runtime");
check(betaBuilder.mac?.notarize === false, "未签名 Beta 必须禁用 notarization");
check(betaBuilder.dmg?.sign === false, "未签名 Beta DMG 必须显式设置 sign=false");
check(
  betaBuilder.mac?.artifactName === "AlgoLatch-${version}-unsigned-${arch}.${ext}",
  "未签名 Beta 文件名必须显式包含 unsigned",
);

check(
  windowsBuilder.appId === "io.han.c-block-algorithm-panel",
  "Windows electron-builder appId 不正确",
);
check(windowsBuilder.productName === "AlgoLatch", "Windows 正式构建 productName 必须为 AlgoLatch");
check(
  windowsBuilder.directories?.output === "release-windows",
  "Windows 正式构建必须使用独立输出目录",
);
for (const packagedDocument of [
  "package-lock.json",
  "LICENSE",
  "NOTICE.md",
  "THIRD_PARTY_NOTICES.md",
  "PRIVACY.md",
  "SECURITY.md",
]) {
  check(
    windowsBuilder.files?.includes(packagedDocument),
    `Windows 发布包未包含 ${packagedDocument}`,
  );
}
check(
  windowsBuilder.electronDownload?.checksums?.["electron-v43.0.0-win32-x64.zip"] ===
    "a195f798837e4c5719b462d3210c47619f6fc44ce032d06dbdcfbc88327b26e0",
  "Electron Windows x64 官方 SHA-256 必须固定",
);
check(windowsBuilder.win?.forceCodeSigning === true, "Windows 正式构建必须 fail-closed 强制签名");
check(windowsBuilder.win?.signExecutable === true, "Windows 正式构建必须签名应用与安装器");
check(
  windowsBuilder.win?.signtoolOptions?.signingHashAlgorithms?.length === 1 &&
    windowsBuilder.win.signtoolOptions.signingHashAlgorithms[0] === "sha256",
  "Windows 正式构建必须只使用 SHA-256 Authenticode",
);
check(
  windowsBuilder.win?.artifactName === "AlgoLatch-Setup-${version}-${arch}.${ext}",
  "Windows 正式 installer 文件名不正确",
);
const windowsTargets = windowsBuilder.win?.target;
check(
  Array.isArray(windowsTargets) &&
    windowsTargets.length === 1 &&
    windowsTargets[0]?.target === "nsis" &&
    Array.isArray(windowsTargets[0]?.arch) &&
    windowsTargets[0].arch.length === 1 &&
    windowsTargets[0].arch[0] === "x64",
  "Windows 正式发布必须只构建 NSIS x64",
);
check(windowsBuilder.nsis?.oneClick === true, "Windows installer 必须保持一键安装");
check(windowsBuilder.nsis?.perMachine === false, "Windows installer 必须保持当前用户安装");
check(windowsBuilder.nsis?.allowElevation === false, "Windows installer 不得要求提权");
check(windowsBuilder.nsis?.runAfterFinish === true, "Windows installer 安装后必须允许直接启动");
check(windowsBuilder.nsis?.deleteAppDataOnUninstall === false, "Windows 卸载不得删除用户项目数据");
check(windowsBetaBuilder.productName === "AlgoLatch", "Windows Beta productName 必须为 AlgoLatch");
check(
  windowsBetaBuilder.directories?.output === "release-windows-beta",
  "未签名 Windows Beta 必须使用独立输出目录",
);
check(
  windowsBetaBuilder.win?.forceCodeSigning === false &&
    windowsBetaBuilder.win?.signExecutable === false,
  "未签名 Windows Beta 必须显式禁用 Authenticode",
);
check(
  windowsBetaBuilder.win?.artifactName === "AlgoLatch-Setup-${version}-unsigned-${arch}.${ext}",
  "未签名 Windows Beta 文件名必须显式包含 unsigned",
);
for (const entitlement of [entitlements, inheritedEntitlements]) {
  includes(entitlement, "com.apple.security.cs.allow-jit", "macOS entitlements");
  check(
    !entitlement.includes("com.apple.security.cs.allow-unsigned-executable-memory"),
    "Electron 12+ 不得启用 allow-unsigned-executable-memory",
  );
  check(!entitlement.includes("disable-library-validation"), "不得无依据禁用 library validation");
}

const macTargets = builder.mac?.target;
check(Array.isArray(macTargets) && macTargets.length === 1, "发布配置只应声明一个 macOS target");
const dmgTarget = Array.isArray(macTargets) ? macTargets[0] : undefined;
check(dmgTarget?.target === "dmg", "发布 target 必须为 DMG");
check(
  Array.isArray(dmgTarget?.arch) &&
    dmgTarget.arch.length === 1 &&
    dmgTarget.arch[0] === "universal",
  "发布 DMG 必须只构建 universal 架构",
);

try {
  await validateConfiguration(builder, { isEnabled: false, add() {} });
  check(true, "macOS electron-builder schema");
} catch (error) {
  check(
    false,
    `macOS electron-builder schema 校验失败：${error instanceof Error ? error.message : String(error)}`,
  );
}
try {
  await validateConfiguration(windowsBuilder, { isEnabled: false, add() {} });
  check(true, "Windows electron-builder schema");
} catch (error) {
  check(
    false,
    `Windows electron-builder schema 校验失败：${error instanceof Error ? error.message : String(error)}`,
  );
}

includes(toolchain, "const expectedNodeMajor = 24;", "verify-toolchain");
check(!toolchain.includes('"v25.8.1"'), "verify-toolchain 仍锁定已迁出的 Node 25");
includes(credentialGate, "assertMacReleaseCredentials", "macOS release credential gate");
includes(credentialGate, "APPLE_API_KEY", "macOS release credential gate");
includes(
  windowsCredentialGate,
  "assertWindowsReleaseCredentials",
  "Windows release credential gate",
);
includes(
  windowsCredentialGate,
  "validateWindowsCertificateReference",
  "Windows release credential gate",
);
includes(windowsCredentialGate, "process.platform", "Windows release credential gate");
includes(installedDmgGate, "requireMacPlatform(process.platform)", "verify-installed-dmg");
includes(installedDmgGate, 'runFile("/usr/bin/hdiutil"', "verify-installed-dmg");
includes(installedDmgGate, 'runFile("/usr/bin/ditto"', "verify-installed-dmg");
includes(installedDmgGate, '"/usr/bin/lipo"', "verify-installed-dmg");
includes(installedDmgGate, '"/usr/bin/codesign"', "verify-installed-dmg");
includes(installedDmgGate, '"/usr/sbin/spctl"', "verify-installed-dmg");
includes(installedDmgGate, '["stapler", "validate", installedApp]', "verify-installed-dmg");
includes(installedDmgGate, '"com.apple.quarantine"', "verify-installed-dmg");
includes(installedDmgGate, "validateReleaseEntitlements", "verify-installed-dmg");
includes(installedDmgGate, "validateBundleMetadata", "verify-installed-dmg");
includes(installedDmgGate, "rendererTeam !== applicationTeam", "verify-installed-dmg");
includes(installedDmgSupport, "Hardened Runtime", "installed-dmg support");
includes(installedDmgSupport, "CFBundleIdentifier", "installed-dmg support");
includes(installedDmgSupport, "超出固定最小集合", "installed-dmg support");
includes(installedDmgGate, 'asarCli, "list", asarPath', "verify-installed-dmg");
includes(installedDmgGate, "app.isPackaged", "verify-installed-dmg");
includes(installedDmgGate, '[data-tour-target="create-entry"]', "verify-installed-dmg");
includes(installedDmgGate, "mountDmgArguments(dmgPath, mountPoint)", "verify-installed-dmg");
includes(installedDmgGate, "await detachMountedDmg(mountPoint)", "verify-installed-dmg");
includes(installedDmgGate, "executablePath,", "verify-installed-dmg");
includes(installedDmgGate, 'locator("#startup-loader")', "verify-installed-dmg");
includes(installedDmgGate, 'querySelector("#dashboard-panel")', "verify-installed-dmg");
includes(installedDmgGate, 'querySelector("#parser-status")', "verify-installed-dmg");
includes(installedDmgGate, 'PANEL_INSTALLED_DMG_GATE: "1"', "verify-installed-dmg");
includes(installedDmgGate, 'querySelector("#workspace-save-status")', "verify-installed-dmg");
includes(installedDmgGate, 'querySelectorAll("[data-menu-root-trigger]")', "verify-installed-dmg");
includes(workspaceRootSource, 'options.installedGate !== "1"', "workspace-root");
includes(workspaceRootSource, 'startsWith("c-block-installed-dmg-")', "workspace-root");
includes(
  workspaceStoreSource,
  'WORKSPACE_ROOT_NAME = "C Algorithm Workbench"',
  "managed workspace compatibility",
);
for (const source of legacyPersistenceSources) {
  includes(source, "c-block-algorithm-panel", "legacy local persistence ID");
}
includes(installedDmgSupport, '"-readonly"', "installed-dmg support");
includes(installedDmgSupport, "selectSingleArtifact", "installed-dmg support");
includes(
  installedWindowsGate,
  "requireWindowsInstallGate(process.platform, process.env)",
  "verify-installed-windows",
);
includes(installedWindowsGate, "validateAuthenticodeSignatures", "verify-installed-windows");
includes(installedWindowsGate, "validateWindowsRuntimeDigests", "verify-installed-windows");
includes(installedWindowsGate, "validateInstalledWorkbenchSnapshot", "verify-installed-windows");
includes(installedWindowsGate, "windowsInstallerArguments", "verify-installed-windows");
includes(installedWindowsGate, "windowsUninstallerArguments", "verify-installed-windows");
includes(installedWindowsSupport, "requireAuthenticode: true", "installed-windows support");
includes(
  installedWindowsSupport,
  'arguments_[0] === "--allow-unsigned"',
  "installed-windows support",
);
includes(
  installedWindowsSupport,
  "installer、application 与 uninstaller",
  "installed-windows support",
);
includes(installedWindowsSupport, "validateUninstallOutcome", "installed-windows support");
check(
  installedDmgGate.indexOf('runFile("/usr/bin/ditto"') <
    installedDmgGate.indexOf("await detachMountedDmg(mountPoint)"),
  "verify-installed-dmg 必须先复制 .app 再卸载 DMG",
);
check(
  installedDmgGate.indexOf("await detachMountedDmg(mountPoint)") <
    installedDmgGate.indexOf("application = await electron.launch"),
  "verify-installed-dmg 必须先卸载 DMG 再启动复制后的应用",
);
includes(gitignore, "!/build/electron-builder.release.json", ".gitignore");
includes(gitignore, "!/build/entitlements.mac.plist", ".gitignore");
includes(gitignore, "!/build/entitlements.mac.inherit.plist", ".gitignore");
includes(license, "MIT License", "LICENSE");
includes(license, "Copyright (c) 2026 HAN Chen", "LICENSE");

for (const document of [
  "SECURITY.md",
  "PRIVACY.md",
  "NOTICE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
]) {
  const contents = await readText(document);
  check(contents.trim().length > 100, `${document} 缺失或内容不足`);
}

check(!ci.includes("pull_request_target"), "CI 禁止使用高风险 pull_request_target");
includes(ci, "node-version: 24", "CI");
includes(ci, "npm install --global npm@11.11.0", "CI");
includes(ci, "npm ci", "CI");
includes(ci, "npm run accept:m9", "CI");
includes(ci, "npm run notices:check", "CI");
includes(ci, "npm test", "CI");
includes(ci, "npm run accept:m0-m5-regression", "CI");
includes(ci, "npm run build", "CI");
includes(ci, "npm run test:e2e", "CI");
includes(ci, "id: electron_e2e", "CI");
includes(ci, "steps.electron_e2e.outcome == 'failure'", "CI");
includes(ci, "Upload Electron failure traces", "CI");
includes(ci, "${{ runner.temp }}/c-block-algorithm-panel-playwright", "CI");
includes(ci, "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "CI");
includes(ci, "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", "CI");
includes(ci, "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "CI");
includes(ci, "persist-credentials: false", "CI");

includes(release, '      - "v*"', "release workflow");
includes(release, "RELEASE_TAG: ${{ github.ref_name }}", "release workflow");
includes(release, "npm run accept:m9", "release workflow");
includes(release, "npm run notices:check", "release workflow");
includes(release, "name: Release signed Windows build", "release workflow");
includes(release, "verify_windows:", "release workflow");
includes(release, "publish_windows:", "release workflow");
includes(release, "needs: [verify_windows]", "release workflow");
includes(release, "runs-on: windows-2025", "release workflow");
includes(release, "environment: windows-release", "release workflow");
includes(release, "git merge-base --is-ancestor", "release workflow");
includes(release, "WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}", "release workflow");
includes(release, "WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}", "release workflow");
includes(release, "npm run dist:win", "release workflow");
includes(release, "npm run verify:installed-win", "release workflow");
includes(release, "Get-FileHash", "release workflow");
includes(release, "SHA256SUMS-windows.txt", "release workflow");
includes(release, "release-windows/*.exe", "release workflow");
for (const forbidden of [
  "verify_macos",
  "macos-release",
  "runs-on: macos",
  "MACOS_CERTIFICATE",
  "APPLE_API_",
  "npm run dist:mac",
  "npm run verify:installed-dmg",
  ".dmg",
]) {
  check(!release.includes(forbidden), `Windows 正式发布工作流不得包含 ${forbidden}`);
}
for (const forbidden of [
  "npm run dist:win:beta",
  "npm run verify:installed-win:beta",
  "--allow-unsigned",
]) {
  check(!release.includes(forbidden), `正式发布工作流不得调用未签名通道 ${forbidden}`);
}
check(!release.includes("gh release edit"), "已发布 Release 元数据不得被工作流覆盖");
check(!release.includes("--clobber"), "已发布 Release 资产不得被工作流覆盖");
check(!release.includes("git tag"), "发布工作流不得创建、移动或覆盖 tag");
check(!release.includes("gh api --method PATCH"), "发布工作流不得修改既有 GitHub 对象");
includes(release, "sha256sum ./*.exe > SHA256SUMS.txt", "release workflow");
includes(release, "sha256sum --check SHA256SUMS.txt", "release workflow");
includes(
  release,
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "release workflow",
);
includes(
  release,
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "release workflow",
);
includes(release, "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "release workflow");
includes(
  release,
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "release workflow",
);
includes(release, "persist-credentials: false", "release workflow");
includes(release, "permissions:\n      contents: write", "release publish job");
includes(release, "gh release view", "release workflow");
includes(release, "gh release create", "release workflow");
check(
  (release.match(/gh release create/gu) ?? []).length === 1,
  "发布工作流必须只有一个 fail-closed Release 创建点",
);
includes(release, "--verify-tag", "release workflow");
includes(release, "--latest", "release workflow");
includes(release, 'notes_file="docs/releases/${GITHUB_REF_NAME}.md"', "release workflow");
includes(release, '--title "AlgoLatch ${GITHUB_REF_NAME} for Windows"', "release workflow");
check(!release.includes("--prerelease"), "正式 GitHub Release 不得标记为 prerelease");
includes(playwrightConfiguration, "process.env.RUNNER_TEMP ?? tmpdir()", "Playwright config");
includes(playwrightConfiguration, '"c-block-algorithm-panel-playwright"', "Playwright config");
try {
  assertOrderedWorkflowStages(
    release,
    [
      { label: "Windows Authenticode 构建", fragment: "run: npm run dist:win" },
      { label: "Windows 安装态门禁", fragment: "run: npm run verify:installed-win" },
      { label: "Windows SHA-256", fragment: "- name: Create Windows SHA-256 manifest" },
      {
        label: "已验证 Windows artifact 上传",
        fragment: "- name: Upload verified Windows artifact",
      },
      {
        label: "已验证 Windows artifact 下载",
        fragment: "- name: Download verified Windows artifact",
      },
      { label: "不可变 Release 存在性检查", fragment: "gh release view" },
      { label: "GitHub Release", fragment: "gh release create" },
    ],
    "Windows release workflow",
  );
  check(true, "release workflow Windows gate order");
} catch (error) {
  check(
    false,
    error instanceof Error ? error.message : "release workflow 的 Windows 安装态门禁顺序无效",
  );
}

const releaseTag = process.env.RELEASE_TAG?.trim();
if (releaseTag !== undefined && releaseTag.length > 0) {
  check(releaseTag === `v${manifest.version}`, `tag ${releaseTag} 与 v${manifest.version} 不一致`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\nM9 发布基础未通过：${failures.length}/${checks} 项失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ M9 发布基础通过：${checks} 项离线配置检查`);
  console.log("  活动正式通道仅发布 Authenticode 签名且通过安装态门禁的 Windows x64 包。");
  console.log("  macOS 签名配置保留待未来版本启用；未签名构建不得进入正式发布流程。");
}
