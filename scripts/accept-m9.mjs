import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { assertReleaseGateOrder } from "./lib/installed-dmg-gate.mjs";

const expected = Object.freeze({
  version: "0.1.0-beta.12",
  engine: ">=24.0.0 <25",
  npm: "npm@11.11.0",
  repository: "https://github.com/Ice-teapop/c-block-algorithm-panel.git",
  builderConfig: "build/electron-builder.beta.json",
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

const [
  manifest,
  lockfile,
  builder,
  ci,
  release,
  toolchain,
  installedDmgGate,
  installedDmgSupport,
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
  readText(".github/workflows/ci.yml"),
  readText(".github/workflows/release-beta.yml"),
  readText("scripts/verify-toolchain.mjs"),
  readText("scripts/verify-installed-dmg.mjs"),
  readText("scripts/lib/installed-dmg-gate.mjs"),
  readText(".gitignore"),
  readText("LICENSE"),
  readText(".nvmrc"),
  readText(".node-version"),
  readText("electron/main/workspace-root.ts"),
  readText("playwright.config.ts"),
]);

check(manifest.version === expected.version, `package version 必须为 ${expected.version}`);
check(/^\d+\.\d+\.\d+-beta\.\d+$/u.test(manifest.version), "未签名构建只允许 beta 预发布版本");
check(manifest.private === true, "npm 包必须保持 private，防止误发布到 npm");
check(manifest.license === "MIT", "package license 必须为 MIT");
check(manifest.packageManager === expected.npm, `packageManager 必须为 ${expected.npm}`);
check(manifest.engines?.node === expected.engine, `engines.node 必须为 ${expected.engine}`);
check(nvmrc.trim() === "24.14.0", ".nvmrc 必须固定当前 Node 24 LTS");
check(nodeVersion.trim() === "24.14.0", ".node-version 必须固定当前 Node 24 LTS");
check(manifest.repository?.url === expected.repository, "GitHub repository 元数据不正确");
check(
  manifest.build?.extends === "file:build/electron-builder.beta.json",
  "package.json 默认 build 必须继承 beta 配置，禁止形成第二套发布边界",
);
check(manifest.build?.mac?.icon === "build/icon.icns", "package.json 缺少 macOS 图标入口");
check(manifest.scripts?.["accept:m9"] === "node scripts/accept-m9.mjs", "缺少 accept:m9");
check(
  manifest.scripts?.["verify:installed-dmg"] === "node scripts/verify-installed-dmg.mjs",
  "缺少 verify:installed-dmg",
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
includes(manifest.scripts?.["dist:mac:beta"] ?? "", expected.builderConfig, "dist:mac:beta");
includes(manifest.scripts?.["dist:mac:beta"] ?? "", "--publish never", "dist:mac:beta");

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
check(builder.directories?.output === "release", "electron-builder 输出目录必须为 release");
for (const packagedDocument of [
  "package-lock.json",
  "LICENSE",
  "NOTICE.md",
  "PRIVACY.md",
  "SECURITY.md",
]) {
  check(builder.files?.includes(packagedDocument), `beta 包未包含 ${packagedDocument}`);
}
check(builder.mac?.identity === null, "beta 配置必须显式设置 mac.identity=null");
check(builder.mac?.hardenedRuntime === false, "beta 配置必须显式禁用 Hardened Runtime");
check(builder.mac?.notarize === false, "beta 配置必须显式禁用 notarization");
check(builder.dmg?.sign === false, "beta DMG 必须显式设置 sign=false");
check(
  builder.mac?.artifactName === "c-block-algorithm-panel-${version}-${arch}.${ext}",
  "DMG artifactName 必须包含版本、架构和扩展名",
);

const macTargets = builder.mac?.target;
check(Array.isArray(macTargets) && macTargets.length === 1, "beta 只应声明一个 macOS target");
const dmgTarget = Array.isArray(macTargets) ? macTargets[0] : undefined;
check(dmgTarget?.target === "dmg", "beta target 必须为 DMG");
check(
  Array.isArray(dmgTarget?.arch) &&
    dmgTarget.arch.length === 1 &&
    dmgTarget.arch[0] === "universal",
  "beta DMG 必须只构建 universal 架构",
);

try {
  await validateConfiguration(builder, { isEnabled: false, add() {} });
  check(true, "electron-builder schema");
} catch (error) {
  check(
    false,
    `electron-builder schema 校验失败：${error instanceof Error ? error.message : String(error)}`,
  );
}

includes(toolchain, "const expectedNodeMajor = 24;", "verify-toolchain");
check(!toolchain.includes('"v25.8.1"'), "verify-toolchain 仍锁定已迁出的 Node 25");
includes(installedDmgGate, "requireMacPlatform(process.platform)", "verify-installed-dmg");
includes(installedDmgGate, 'runFile("/usr/bin/hdiutil"', "verify-installed-dmg");
includes(installedDmgGate, 'runFile("/usr/bin/ditto"', "verify-installed-dmg");
includes(installedDmgGate, '"/usr/bin/lipo"', "verify-installed-dmg");
includes(installedDmgGate, 'asarCli, "list", asarPath', "verify-installed-dmg");
includes(installedDmgGate, "app.isPackaged", "verify-installed-dmg");
includes(installedDmgGate, 'name: "新建"', "verify-installed-dmg");
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
includes(installedDmgSupport, '"-readonly"', "installed-dmg support");
includes(installedDmgSupport, "selectSingleArtifact", "installed-dmg support");
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
includes(gitignore, "!/build/electron-builder.beta.json", ".gitignore");
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
includes(ci, "npm test", "CI");
includes(ci, "npm run accept:m0-m5-regression", "CI");
includes(ci, "npm run build", "CI");
includes(ci, "npm run test:e2e", "CI");
includes(ci, "id: electron_e2e", "CI");
includes(ci, "steps.electron_e2e.outcome == 'failure'", "CI");
includes(ci, "Upload Electron failure traces", "CI");
includes(ci, "${{ runner.temp }}/c-block-algorithm-panel-playwright", "CI");

includes(release, '      - "v*"', "release workflow");
includes(release, "RELEASE_TAG: ${{ github.ref_name }}", "release workflow");
includes(release, "npm run accept:m9", "release workflow");
includes(release, "npm run accept:m6", "release workflow");
includes(release, "npm run accept:m7", "release workflow");
includes(release, "npm run accept:m8", "release workflow");
includes(release, "npm run accept:m0-m5-regression", "release workflow");
includes(release, "npm run test:e2e", "release workflow");
includes(release, "id: electron_e2e", "release workflow");
includes(release, "steps.electron_e2e.outcome == 'failure'", "release workflow");
includes(release, "Upload Electron failure traces", "release workflow");
includes(release, "${{ runner.temp }}/c-block-algorithm-panel-playwright", "release workflow");
includes(release, "npm run dist:mac:beta", "release workflow");
includes(release, "npm run verify:installed-dmg", "release workflow");
includes(release, "shasum -a 256", "release workflow");
includes(release, "shasum -a 256 --check", "release workflow");
includes(release, "uses: actions/upload-artifact@v4", "release workflow");
includes(release, "gh release view", "release workflow");
includes(release, "gh release edit", "release workflow");
includes(release, "gh release create", "release workflow");
includes(release, "gh release upload", "release workflow");
includes(release, "--verify-tag", "release workflow");
includes(release, "--prerelease", "release workflow");
includes(playwrightConfiguration, "process.env.RUNNER_TEMP ?? tmpdir()", "Playwright config");
includes(playwrightConfiguration, '"c-block-algorithm-panel-playwright"', "Playwright config");
try {
  assertReleaseGateOrder(release);
  check(true, "release workflow installed-DMG order");
} catch (error) {
  check(
    false,
    error instanceof Error ? error.message : "release workflow 的安装态 DMG 门禁顺序无效",
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
  console.log("  Universal DMG 仍是未签名、未公证 beta；稳定版不得使用此配置。");
}
