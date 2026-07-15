import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { get } from "node:https";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  WINDOWS_TOOLCHAIN,
  WINDOWS_TOOLCHAIN_MAX_DOWNLOAD_BYTES,
  assertWindowsToolchainSourceDigest,
  createWindowsToolchainManifest,
  hashWindowsToolchainExecutionChain,
  parseWindowsClangVersion,
  requireWindowsPlatform,
  resolveWindowsToolchainRedirect,
  sha256File,
  validateWindowsToolchainArchiveEntries,
  validateWindowsToolchainUrl,
} from "./lib/windows-toolchain.mjs";

const runFile = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildWindowsRoot = join(projectRoot, "build", "windows");
const finalX64Root = join(buildWindowsRoot, "x64");
const archiveTarget = "x86_64-w64-mingw32";
const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
const tarPath = windowsRoot === undefined ? undefined : join(windowsRoot, "System32", "tar.exe");
const commandOptions = Object.freeze({
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  timeout: 180_000,
  windowsHide: true,
});
const downloadTimeoutMs = 15 * 60_000;

requireWindowsPlatform(process.platform);
if (tarPath === undefined) throw new Error("Windows 工具链准备失败：SystemRoot/WINDIR 未设置");
const tarMetadata = await lstat(tarPath).catch(() => null);
if (tarMetadata === null || !tarMetadata.isFile() || tarMetadata.isSymbolicLink()) {
  throw new Error("Windows 工具链准备失败：未找到受信的 System32/tar.exe");
}
await mkdir(buildWindowsRoot, { recursive: true });
const temporaryRoot = await mkdtemp(join(buildWindowsRoot, ".prepare-x64-"));
const downloadPath = join(temporaryRoot, "llvm-mingw.zip");
const extractRoot = join(temporaryRoot, "extracted");
const stagedX64Root = join(temporaryRoot, "x64");
const stagedToolchain = join(stagedX64Root, "toolchain");
const stagedRuntime = join(stagedX64Root, "runtime");
const backupX64Root = join(buildWindowsRoot, `.previous-x64-${String(process.pid)}`);

try {
  console.log(`Downloading locked llvm-mingw ${WINDOWS_TOOLCHAIN.toolchainVersion} archive...`);
  const downloaded = await downloadLockedArchive(WINDOWS_TOOLCHAIN.sourceUrl, downloadPath);
  assertWindowsToolchainSourceDigest(downloaded.sha256, downloaded.sizeBytes);

  await mkdir(extractRoot, { recursive: true });
  const { stdout: archiveListing } = await runFile(tarPath, ["-tf", downloadPath], commandOptions);
  validateWindowsToolchainArchiveEntries(splitArchiveListing(archiveListing));
  await runFile(tarPath, ["-xf", downloadPath, "-C", extractRoot], commandOptions);

  const sourceRoot = join(extractRoot, WINDOWS_TOOLCHAIN.archiveRoot);
  await assertOrdinaryDirectoryTree(sourceRoot);
  await stageToolchain(sourceRoot, stagedToolchain);
  await mkdir(stagedRuntime, { recursive: true });

  const clangPath = join(stagedToolchain, "bin", "clang.exe");
  const { stdout: clangVersion, stderr: clangVersionErrors } = await runFile(
    clangPath,
    ["--version"],
    commandOptions,
  );
  parseWindowsClangVersion(`${clangVersion}\n${clangVersionErrors}`);

  const brokerPath = join(stagedRuntime, "algolatch-job-host.exe");
  await compileBroker(clangPath, brokerPath);
  await runCompileCanary(clangPath, temporaryRoot);

  const manifest = createWindowsToolchainManifest(
    await hashWindowsToolchainExecutionChain(stagedToolchain, brokerPath),
  );
  await writeFile(
    join(stagedX64Root, "toolchain-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  await installStagedTree(stagedX64Root, finalX64Root, backupX64Root);
  console.log(
    `Prepared Windows x64 toolchain at ${relative(projectRoot, finalX64Root)} ` +
      `(LLVM ${WINDOWS_TOOLCHAIN.llvmVersion}, ${WINDOWS_TOOLCHAIN.target}).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function downloadLockedArchive(sourceUrl, destination) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const output = await open(destination, "wx", 0o600);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("llvm-mingw 下载超过 15 分钟上限")),
    downloadTimeoutMs,
  );
  try {
    await request(
      validateWindowsToolchainUrl(sourceUrl),
      0,
      abortController.signal,
      async (response) => {
        const declaredLength = parseContentLength(response.headers["content-length"]);
        if (declaredLength !== null && declaredLength > WINDOWS_TOOLCHAIN_MAX_DOWNLOAD_BYTES) {
          throw new Error("llvm-mingw 下载响应超过允许大小");
        }
        if (
          response.headers["content-encoding"] !== undefined &&
          response.headers["content-encoding"] !== "identity"
        ) {
          throw new Error("llvm-mingw 下载响应使用了未允许的内容编码");
        }
        for await (const chunk of response) {
          sizeBytes += chunk.length;
          if (sizeBytes > WINDOWS_TOOLCHAIN_MAX_DOWNLOAD_BYTES) {
            throw new Error("llvm-mingw 下载数据超过允许大小");
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
            if (bytesWritten <= 0) throw new Error("llvm-mingw 下载文件写入失败");
            offset += bytesWritten;
          }
        }
      },
    );
    await output.sync();
    await output.close();
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return Object.freeze({ sha256: hash.digest("hex"), sizeBytes });
}

async function request(url, redirectCount, signal, consume) {
  await new Promise((resolvePromise, rejectPromise) => {
    const requestHandle = get(
      url,
      {
        signal,
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "AlgoLatch-Windows-Toolchain/1",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          let next;
          try {
            next = resolveWindowsToolchainRedirect(
              url,
              String(response.headers.location ?? ""),
              redirectCount,
            );
          } catch (error) {
            rejectPromise(error);
            return;
          }
          request(next, redirectCount + 1, signal, consume).then(resolvePromise, rejectPromise);
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectPromise(new Error(`llvm-mingw 下载失败：HTTP ${String(status)}`));
          return;
        }
        Promise.resolve(consume(response)).then(resolvePromise, rejectPromise);
      },
    );
    requestHandle.setTimeout(30_000, () => {
      requestHandle.destroy(new Error("llvm-mingw 下载连接超时"));
    });
    requestHandle.once("error", rejectPromise);
  });
}

function parseContentLength(value) {
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/u.test(value)) {
    throw new Error("llvm-mingw 下载响应 Content-Length 无效");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("llvm-mingw 下载响应大小无效");
  return parsed;
}

function splitArchiveListing(output) {
  return String(output)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .filter((entry) => entry.length > 0);
}

async function stageToolchain(sourceRoot, destination) {
  const sourceBin = join(sourceRoot, "bin");
  const destinationBin = join(destination, "bin");
  await mkdir(destinationBin, { recursive: true });
  await copyRequiredFile(join(sourceBin, "clang.exe"), join(destinationBin, "clang.exe"));
  await copyRequiredFile(join(sourceBin, "ld.lld.exe"), join(destinationBin, "ld.lld.exe"));

  const runtimeDlls = (await readdir(sourceBin, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dll"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const dll of runtimeDlls) {
    await copyRequiredFile(join(sourceBin, dll), join(destinationBin, dll));
  }

  for (const directory of ["include", "lib"]) {
    await copyRequiredDirectory(join(sourceRoot, directory), join(destination, directory));
  }
  await copyRequiredDirectory(
    join(sourceRoot, archiveTarget, "lib"),
    join(destination, archiveTarget, "lib"),
  );
  await assertOrdinaryDirectoryTree(destination);
}

async function copyRequiredFile(source, destination) {
  const metadata = await lstat(source).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`llvm-mingw 缺少普通文件：${source}`);
  }
  await cp(source, destination, { force: false, errorOnExist: true });
}

async function copyRequiredDirectory(source, destination) {
  const metadata = await lstat(source).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`llvm-mingw 缺少普通目录：${source}`);
  }
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

async function assertOrdinaryDirectoryTree(root) {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const metadata = await lstat(current).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink()) {
      throw new Error(`Windows 工具链包含缺失路径或符号链接：${current}`);
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(current)) queue.push(join(current, entry));
    } else if (!metadata.isFile()) {
      throw new Error(`Windows 工具链包含非普通文件：${current}`);
    }
  }
}

async function compileBroker(clangPath, destination) {
  const source = join(projectRoot, "native", "windows-job-host.c");
  const result = await runFile(
    clangPath,
    [
      "-std=c17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      "-DUNICODE",
      "-D_UNICODE",
      "-D_WIN32_WINNT=0x0A00",
      "-DPSAPI_VERSION=2",
      "-municode",
      "-fuse-ld=lld",
      "-Wl,--no-insert-timestamp",
      source,
      "-o",
      destination,
    ],
    commandOptions,
  );
  if (result.stderr.trim().length > 0) {
    throw new Error(`Windows Job Object broker 编译产生诊断：${result.stderr.trim()}`);
  }
  const metadata = await stat(destination);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error("Windows Job Object broker 编译产物无效");
  }
}

async function runCompileCanary(clangPath, temporaryDirectory) {
  const canarySource = join(temporaryDirectory, "toolchain-canary.c");
  const canaryExecutable = join(temporaryDirectory, "toolchain-canary.exe");
  await writeFile(canarySource, "int main(void) { return 0; }\n", "utf8");
  await runFile(
    clangPath,
    [
      "-std=c17",
      "-O0",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-fuse-ld=lld",
      "-Wl,--no-insert-timestamp",
      canarySource,
      "-o",
      canaryExecutable,
    ],
    commandOptions,
  );
  const metadata = await stat(canaryExecutable);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error("Windows 工具链 canary 未生成可执行文件");
  }
}

async function installStagedTree(staged, destination, backup) {
  let previousMoved = false;
  try {
    await rm(backup, { recursive: true, force: true });
    try {
      await rename(destination, backup);
      previousMoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(staged, destination);
    if (previousMoved) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (previousMoved) {
      await rm(destination, { recursive: true, force: true });
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}
