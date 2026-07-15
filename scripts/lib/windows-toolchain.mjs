import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const WINDOWS_TOOLCHAIN = Object.freeze({
  schemaVersion: 1,
  toolchainVersion: "20260616",
  llvmVersion: "22.1.8",
  architecture: "x64",
  target: "x86_64-w64-windows-gnu",
  archiveRoot: "llvm-mingw-20260616-ucrt-x86_64",
  sourceUrl:
    "https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip",
  sourceSha256: "b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35",
  sourceSizeBytes: 187_504_083,
});

export const WINDOWS_TOOLCHAIN_DOWNLOAD_HOSTS = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export const WINDOWS_TOOLCHAIN_MAX_REDIRECTS = 5;
export const WINDOWS_TOOLCHAIN_MAX_DOWNLOAD_BYTES = 220 * 1024 * 1024;

export const WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS = Object.freeze([
  "toolchain/bin/clang.exe",
  "toolchain/bin/clang-22.exe",
  "toolchain/bin/ld.lld.exe",
  "toolchain/bin/mingw32-common.cfg",
  "toolchain/bin/x86_64-w64-windows-gnu.cfg",
  "runtime/algolatch-job-host.exe",
]);

export function requireWindowsPlatform(platform) {
  if (platform !== "win32") {
    throw new Error(`Windows 工具链只能在 win32 主机准备，当前平台：${String(platform)}`);
  }
}

export function validateWindowsToolchainUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    throw new Error("Windows 工具链下载地址不是有效 URL");
  }
  if (url.protocol !== "https:") throw new Error("Windows 工具链下载只允许 HTTPS");
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Windows 工具链下载地址禁止携带凭据");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new Error("Windows 工具链下载地址只允许 HTTPS 默认端口");
  }
  const host = url.hostname.toLowerCase();
  if (!WINDOWS_TOOLCHAIN_DOWNLOAD_HOSTS.includes(host)) {
    throw new Error(`Windows 工具链下载主机不在白名单：${host}`);
  }
  return url;
}

export function resolveWindowsToolchainRedirect(currentUrl, location, redirectCount) {
  if (!Number.isSafeInteger(redirectCount) || redirectCount < 0) {
    throw new Error("Windows 工具链重定向计数无效");
  }
  if (redirectCount >= WINDOWS_TOOLCHAIN_MAX_REDIRECTS) {
    throw new Error(`Windows 工具链下载重定向超过 ${WINDOWS_TOOLCHAIN_MAX_REDIRECTS} 次`);
  }
  if (typeof location !== "string" || location.trim().length === 0) {
    throw new Error("Windows 工具链下载重定向缺少 Location");
  }
  const base = validateWindowsToolchainUrl(currentUrl);
  return validateWindowsToolchainUrl(new URL(location, base));
}

export function validateWindowsToolchainArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Windows 工具链压缩包目录为空");
  }
  const roots = new Set();
  for (const entryValue of entries) {
    if (typeof entryValue !== "string" || entryValue.length === 0) continue;
    if (entryValue.includes("\0")) throw new Error("Windows 工具链压缩包包含 NUL 路径");
    const entry = entryValue.replaceAll("\\", "/");
    if (
      entry.startsWith("/") ||
      entry.startsWith("//") ||
      /^[A-Za-z]:/u.test(entry) ||
      entry.split("/").some((part) => part === ".." || part.includes(":"))
    ) {
      throw new Error(`Windows 工具链压缩包包含不安全路径：${entryValue}`);
    }
    const parts = entry.split("/").filter((part) => part.length > 0 && part !== ".");
    if (parts.length === 0) continue;
    roots.add(parts[0]);
  }
  if (roots.size !== 1 || !roots.has(WINDOWS_TOOLCHAIN.archiveRoot)) {
    throw new Error(`Windows 工具链压缩包根目录不匹配：${[...roots].sort().join(", ") || "(无)"}`);
  }
  return Object.freeze([...entries]);
}

export function parseWindowsClangVersion(output) {
  const text = String(output);
  const version = /^clang version\s+([^\s]+).*$/mu.exec(text)?.[1] ?? null;
  const target = /^Target:\s*([^\s]+)\s*$/mu.exec(text)?.[1] ?? null;
  if (version !== WINDOWS_TOOLCHAIN.llvmVersion) {
    throw new Error(
      `Windows clang 版本不匹配：期望 ${WINDOWS_TOOLCHAIN.llvmVersion}，实际 ${version ?? "(缺失)"}`,
    );
  }
  if (target !== WINDOWS_TOOLCHAIN.target) {
    throw new Error(
      `Windows clang Target 不匹配：期望 ${WINDOWS_TOOLCHAIN.target}，实际 ${target ?? "(缺失)"}`,
    );
  }
  return Object.freeze({ llvmVersion: version, target });
}

export function assertWindowsToolchainSourceDigest(actualSha256, actualSizeBytes) {
  const digest = String(actualSha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(digest) || digest !== WINDOWS_TOOLCHAIN.sourceSha256) {
    throw new Error("llvm-mingw 归档 SHA-256 不匹配，已拒绝解压");
  }
  if (actualSizeBytes !== WINDOWS_TOOLCHAIN.sourceSizeBytes) {
    throw new Error(
      `llvm-mingw 归档大小不匹配：期望 ${String(WINDOWS_TOOLCHAIN.sourceSizeBytes)}，实际 ${String(actualSizeBytes)}`,
    );
  }
}

export function createWindowsToolchainManifest(fileDigests) {
  if (fileDigests === null || typeof fileDigests !== "object" || Array.isArray(fileDigests)) {
    throw new Error("Windows 工具链 manifest 文件摘要无效");
  }
  const paths = Object.keys(fileDigests).sort(compareCodePoints);
  for (const path of WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS) {
    const digest = fileDigests[path];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(`Windows 工具链 manifest 缺少有效摘要：${path}`);
    }
  }
  for (const path of paths) {
    if (!isWindowsToolchainManifestPath(path)) {
      throw new Error(`Windows 工具链 manifest 包含未声明文件：${path}`);
    }
    if (typeof fileDigests[path] !== "string" || !/^[0-9a-f]{64}$/u.test(fileDigests[path])) {
      throw new Error(`Windows 工具链 manifest 文件摘要无效：${path}`);
    }
  }
  const files = Object.fromEntries(paths.map((path) => [path, fileDigests[path]]));
  return Object.freeze({
    schemaVersion: WINDOWS_TOOLCHAIN.schemaVersion,
    toolchainVersion: WINDOWS_TOOLCHAIN.toolchainVersion,
    llvmVersion: WINDOWS_TOOLCHAIN.llvmVersion,
    architecture: WINDOWS_TOOLCHAIN.architecture,
    target: WINDOWS_TOOLCHAIN.target,
    sourceUrl: WINDOWS_TOOLCHAIN.sourceUrl,
    sourceSha256: WINDOWS_TOOLCHAIN.sourceSha256,
    files: Object.freeze(files),
  });
}

export function isWindowsToolchainManifestPath(path) {
  if (WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS.includes(path)) return true;
  return /^toolchain\/bin\/[A-Za-z0-9._+-]+\.dll$/iu.test(String(path));
}

export async function hashWindowsToolchainExecutionChain(toolchainRoot, brokerPath) {
  const binDirectory = join(toolchainRoot, "bin");
  const binEntries = (await readdir(binDirectory, { withFileTypes: true })).sort((left, right) =>
    compareCodePoints(left.name, right.name),
  );
  const digests = {};
  for (const entry of binEntries) {
    const relativePath = `toolchain/bin/${entry.name}`;
    const path = join(binDirectory, entry.name);
    const metadata = await lstat(path);
    if (!entry.isFile() || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Windows 工具链 bin 包含非普通文件：${entry.name}`);
    }
    if (!isWindowsToolchainManifestPath(relativePath)) {
      throw new Error(`Windows 工具链 bin 包含未声明文件：${entry.name}`);
    }
    digests[relativePath] = await sha256File(path);
  }
  const brokerMetadata = await lstat(brokerPath);
  if (!brokerMetadata.isFile() || brokerMetadata.isSymbolicLink()) {
    throw new Error("Windows Job Object broker 不是普通文件");
  }
  digests["runtime/algolatch-job-host.exe"] = await sha256File(brokerPath);
  return Object.freeze(digests);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
