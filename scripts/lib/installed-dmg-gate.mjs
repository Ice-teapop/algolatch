export const EXPECTED_DOCK_LABELS = Object.freeze([
  Object.freeze(["设置", "积木", "Library", "布局"]),
  Object.freeze(["Settings", "Blocks", "Library", "Layout"]),
]);
export const EXPECTED_PRODUCT_BUNDLE = "AlgoLatch.app";

export function requireMacPlatform(platform) {
  if (platform !== "darwin") {
    throw new Error(`已安装 DMG 门禁只允许在 macOS 运行，当前平台：${platform}`);
  }
}

export function selectSingleArtifact(entries, suffix, kind, label) {
  if (!Array.isArray(entries) || typeof suffix !== "string" || suffix.length === 0) {
    throw new TypeError("产物选择参数无效");
  }
  const matches = entries.filter(
    (entry) =>
      typeof entry?.name === "string" && entry.name.toLowerCase().endsWith(suffix.toLowerCase()),
  );
  if (matches.length !== 1) {
    throw new Error(`${label} 必须恰好存在一个，实际 ${matches.length} 个`);
  }
  const selected = matches[0];
  if (selected?.kind !== kind) {
    throw new Error(`${label} 必须是${kind === "file" ? "普通文件" : "真实目录"}`);
  }
  return selected.name;
}

export function validateBundleExecutableName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\0")
  ) {
    throw new Error("CFBundleExecutable 不是安全的单级文件名");
  }
  return value;
}

export function validateProductBundleName(value) {
  if (value !== EXPECTED_PRODUCT_BUNDLE) {
    throw new Error(`DMG 应只包含 ${EXPECTED_PRODUCT_BUNDLE}，实际 ${String(value)}`);
  }
}

export function validateDeveloperIdSignatureDetails(output) {
  const details = String(output);
  const authority = details.match(/^Authority=Developer ID Application:[^\r\n]+$/mu);
  if (authority === null) {
    throw new Error("应用不是 Developer ID Application 签名");
  }
  const team = details.match(/^TeamIdentifier=([A-Z0-9]{10})$/mu)?.[1];
  if (team === undefined) {
    throw new Error("应用签名缺少有效 TeamIdentifier");
  }
  if (!/^CodeDirectory .*flags=.*\bruntime\b.*$/mu.test(details)) {
    throw new Error("应用签名没有启用 Hardened Runtime");
  }
  return team;
}

export function validateAdHocSignatureDetails(output) {
  const details = String(output);
  if (!/^Identifier=io\.han\.c-block-algorithm-panel$/mu.test(details)) {
    throw new Error("Preview bundle 的签名 Identifier 与应用身份不一致");
  }
  if (!/^Signature=adhoc$/mu.test(details)) {
    throw new Error("Preview bundle 缺少完整 ad-hoc 签名");
  }
  if (!/^TeamIdentifier=not set$/mu.test(details)) {
    throw new Error("Preview bundle 不得冒充 Developer ID 签名");
  }
}

export function validateGatekeeperAssessment(output) {
  if (!/^source=Notarized Developer ID$/mu.test(String(output))) {
    throw new Error("Gatekeeper 没有识别为 Notarized Developer ID");
  }
}

export function validateReleaseEntitlements(output, label = "签名目标") {
  const source = String(output);
  const keyMatches = [...source.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);
  const booleanMatches = [...source.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/gu)].map(
    (match) => Object.freeze({ key: match[1], enabled: match[2] === "true" }),
  );
  if (keyMatches.length !== booleanMatches.length) {
    throw new Error(`${label} 的 entitlements 包含无法验证的值`);
  }
  const expected = new Set(["com.apple.security.cs.allow-jit"]);
  const actual = new Set(booleanMatches.map((entry) => entry.key));
  const invalid = booleanMatches.filter((entry) => !expected.has(entry.key) || !entry.enabled);
  if (
    invalid.length > 0 ||
    actual.size !== expected.size ||
    [...expected].some((key) => !actual.has(key))
  ) {
    throw new Error(`${label} 的 entitlements 超出固定最小集合`);
  }
}

export function validateBundleMetadata(metadata, expectedVersion) {
  if (metadata?.identifier !== "io.han.c-block-algorithm-panel") {
    throw new Error("CFBundleIdentifier 与兼容应用身份不一致");
  }
  if (metadata?.name !== "AlgoLatch" || metadata?.executable !== "AlgoLatch") {
    throw new Error("应用显示名或主可执行文件名不是 AlgoLatch");
  }
  if (metadata?.version !== expectedVersion) {
    throw new Error(`应用版本不一致：期望 ${String(expectedVersion)}`);
  }
}

export function mountDmgArguments(dmgPath, mountPoint) {
  return Object.freeze([
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    mountPoint,
    dmgPath,
  ]);
}

export function validateInstalledWorkbenchSnapshot(snapshot) {
  const failures = [];
  if (snapshot.appIsPackaged !== true) failures.push("Electron app.isPackaged 不是 true");
  if (snapshot.protocol !== "file:") failures.push("安装态 renderer 未使用 file: 协议");
  if (snapshot.startupHidden !== true) failures.push("启动进度层没有隐藏");
  if (snapshot.dashboardVisible !== true) failures.push("Dashboard 没有显示");
  if (snapshot.parserState !== "ready") {
    failures.push(`C parser 未进入 ready 状态（实际 ${String(snapshot.parserState)}）`);
  }
  if (snapshot.analysisState !== "complete") {
    failures.push(`后台 CFG Worker 未完成分析（实际 ${String(snapshot.analysisState)}）`);
  }
  if (!Number.isSafeInteger(snapshot.flowNodeCount) || snapshot.flowNodeCount < 3) {
    failures.push("创建项目后没有生成真实 Flow 节点");
  }
  if (
    !Array.isArray(snapshot.dockLabels) ||
    !EXPECTED_DOCK_LABELS.some(
      (expected) =>
        snapshot.dockLabels.length === expected.length &&
        snapshot.dockLabels.every((label, index) => label === expected[index]),
    )
  ) {
    failures.push("Dock 必须严格包含当前中文或英文四入口");
  }
  if (failures.length > 0) throw new Error(failures.join("；"));
}

export function validateUniversalArchitectures(output) {
  const architectures = new Set(String(output).trim().split(/\s+/u));
  if (!architectures.has("arm64") || !architectures.has("x86_64")) {
    throw new Error(`应用主二进制不是 Universal：${String(output).trim() || "<空>"}`);
  }
}

export function validateAsarEntries(output) {
  const entries = String(output)
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  for (const requirement of [
    /\/dist\/index\.html$/u,
    /\/dist\/ai-window\.html$/u,
    /\/dist\/assets\/tree-sitter-c-.*\.wasm$/u,
    /\/dist\/assets\/web-tree-sitter-.*\.wasm$/u,
    /\/dist\/assets\/program-analysis-worker-.*\.js$/u,
    /\/dist-electron\/preload\/index\.cjs$/u,
    /\/dist-electron\/preload\/ai-window\.cjs$/u,
    /\/dist-electron\/electron\/main\/index\.js$/u,
  ]) {
    if (!entries.some((entry) => requirement.test(entry))) {
      throw new Error(`app.asar 缺少发布资源：${String(requirement)}`);
    }
  }
}

export function assertReleaseGateOrder(workflow) {
  const stages = Object.freeze([
    Object.freeze({ label: "DMG 构建", fragment: "run: npm run dist:mac" }),
    Object.freeze({ label: "安装态 DMG 门禁", fragment: "run: npm run verify:installed-dmg" }),
    Object.freeze({ label: "SHA-256", fragment: "shasum -a 256" }),
    Object.freeze({
      label: "已验证 artifact 上传",
      fragment: "- name: Upload verified build artifact",
    }),
    Object.freeze({ label: "GitHub Release", fragment: "gh release" }),
  ]);
  let previousIndex = -1;
  for (const stage of stages) {
    const index = workflow.indexOf(stage.fragment);
    if (index < 0) throw new Error(`release workflow 缺少${stage.label}`);
    if (index <= previousIndex) throw new Error(`release workflow 的${stage.label}顺序不安全`);
    previousIndex = index;
  }
}
