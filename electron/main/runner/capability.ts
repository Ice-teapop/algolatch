import { execFile, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type {
  Capabilities,
  IsolationKind,
  IsolationProbeStatus,
  RunnerMode,
} from "../../../src/shared/api.js";

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const CLANG_PATH = "/usr/bin/clang";
const XCRUN_PATH = "/usr/bin/xcrun";
const BASH_PATH = "/bin/bash";
const LEAKS_PATH = "/usr/bin/leaks";
const MIN_SUPPORTED_APPLE_CLANG_MAJOR = 17;
const MAX_SUPPORTED_APPLE_CLANG_MAJOR = 21;
const DEFAULT_DEVELOPER_ROOT = "/Applications/Xcode.app/Contents/Developer";
const DEFAULT_SUPPORTED_APPLE_CLANG_SANITIZER_RUNTIME =
  "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/21/lib/darwin";
const TRUSTED_DEVELOPER_ROOT_CANDIDATES = Object.freeze([
  DEFAULT_DEVELOPER_ROOT,
  "/Library/Developer/CommandLineTools",
]);
const TRUSTED_DEVELOPER_ROOTS = resolveCanonicalDeveloperRoots(TRUSTED_DEVELOPER_ROOT_CANDIDATES);
const PROBE_TIMEOUT_MS = 1_500;
const CANARY_COMPILE_TIMEOUT_MS = 10_000;
const CANARY_RUN_TIMEOUT_MS = 10_000;
const CANARY_FILE_MODE = 0o600;
const CANARY_DIRECTORY_MODE = 0o700;
const CANARY_SOURCE_NAME = "seatbelt-canary.c";
const CANARY_EXECUTABLE_NAME = "seatbelt-canary";
const WINDOWS_TOOLCHAIN_VERSION = "20260616";
const WINDOWS_LLVM_VERSION = "22.1.8";
const WINDOWS_TARGET_TRIPLE = "x86_64-w64-windows-gnu";
const WINDOWS_TOOLCHAIN_SOURCE_SHA256 =
  "b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35";
const WINDOWS_TOOLCHAIN_SOURCE_URL =
  "https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip";
const WINDOWS_REQUIRED_RUNTIME_HASH_PATHS = Object.freeze([
  "runtime/algolatch-job-host.exe",
  "toolchain/bin/clang.exe",
  "toolchain/bin/clang-22.exe",
  "toolchain/bin/ld.lld.exe",
  "toolchain/bin/mingw32-common.cfg",
  "toolchain/bin/x86_64-w64-windows-gnu.cfg",
]);
export const SEATBELT_CANARY_SENTINEL = "C_BLOCK_SEATBELT_CANARY_OK\n";

/**
 * Compilation needs to execute clang's helper processes and read the selected
 * Apple toolchain. It is deliberately broader than the runtime profile.
 */
export const COMPILE_EXECUTION_PROFILE = [
  "(version 1)",
  "(deny default)",
  '(import "system.sb")',
  "(deny network*)",
  "(allow process*)",
  "(allow signal (target same-sandbox))",
  '(allow file-read* file-test-existence (subpath (param "WORKDIR")))',
  '(allow file-write* (subpath (param "WORKDIR")))',
  '(allow file-read* file-test-existence (subpath "/bin"))',
  '(allow file-read* file-test-existence (subpath "/usr"))',
  '(allow file-read* file-test-existence (subpath "/System"))',
  '(allow file-read* file-test-existence (subpath "/Library/Developer"))',
  '(allow file-read* file-test-existence (subpath "/Applications/Xcode.app/Contents/Developer"))',
  '(allow file-read* file-test-existence (subpath (param "DEVROOT")))',
  '(allow file-read-metadata file-test-existence (subpath "/Applications") (literal "/Library"))',
  '(allow file-read-metadata file-test-existence (subpath (param "TEMPROOT")))',
  '(allow file-map-executable (subpath "/bin"))',
  '(allow file-map-executable (subpath "/usr"))',
  '(allow file-map-executable (subpath "/System"))',
  '(allow file-map-executable (subpath "/Library/Developer"))',
  '(allow file-map-executable (subpath "/Applications/Xcode.app/Contents/Developer"))',
  '(allow file-map-executable (subpath (param "DEVROOT")))',
  '(deny file-read* file-test-existence (subpath "/usr/local"))',
  '(deny file-map-executable (subpath "/usr/local"))',
].join("\n");

/**
 * Runtime C programs get no general process permission. The fixed bash
 * wrapper and executables copied into WORKDIR may start, while fork and reads
 * from /usr/local are explicitly denied in addition to deny-default.
 */
export const RUN_EXECUTION_PROFILE = [
  "(version 1)",
  "(deny default)",
  '(import "system.sb")',
  "(deny network*)",
  `(allow process-exec (literal "${BASH_PATH}"))`,
  '(allow process-exec (subpath (param "WORKDIR")))',
  "(deny process-fork)",
  "(allow signal (target same-sandbox))",
  '(allow file-read* file-test-existence (subpath (param "WORKDIR")))',
  '(allow file-write* (subpath (param "WORKDIR")))',
  '(allow file-read* file-test-existence (subpath "/bin"))',
  '(allow file-read* file-test-existence (subpath "/System"))',
  '(allow file-read* file-test-existence (subpath "/usr/lib"))',
  '(allow file-map-executable (subpath "/bin"))',
  '(allow file-map-executable (subpath "/System"))',
  '(allow file-map-executable (subpath "/usr/lib"))',
  '(deny file-read* file-test-existence (subpath "/usr/local"))',
  '(deny file-map-executable (subpath "/usr/local"))',
].join("\n");

/**
 * Sanitized verification artifacts need Apple's ASan/UBSan runtime dylibs.
 * Keep that extra read/map capability out of the ordinary program profile.
 */
export const SANITIZER_RUN_PROFILE = [
  "(version 1)",
  "(deny default)",
  '(import "system.sb")',
  "(deny network*)",
  `(allow process-exec (literal "${BASH_PATH}"))`,
  '(allow process-exec (subpath (param "WORKDIR")))',
  "(deny process-fork)",
  "(allow signal (target same-sandbox))",
  '(allow file-read* file-test-existence (subpath (param "WORKDIR")))',
  '(allow file-write* (subpath (param "WORKDIR")))',
  '(allow file-read* file-test-existence (subpath "/bin"))',
  '(allow file-read* file-test-existence (subpath "/System"))',
  '(allow file-read* file-test-existence (subpath "/usr/lib"))',
  '(allow file-read* file-test-existence (subpath (param "SANITIZER_RUNTIME")))',
  '(allow file-read-metadata file-test-existence (literal "/Applications") (literal "/Applications/Xcode.app") (literal "/Applications/Xcode.app/Contents") (literal "/Library"))',
  '(allow file-map-executable (subpath "/bin"))',
  '(allow file-map-executable (subpath "/System"))',
  '(allow file-map-executable (subpath "/usr/lib"))',
  '(allow file-map-executable (subpath (param "SANITIZER_RUNTIME")))',
  '(deny file-read* file-test-existence (subpath "/usr/local"))',
  '(deny file-map-executable (subpath "/usr/local"))',
].join("\n");

/**
 * `leaks --atExit` must fork the inspected program directly. Its exec
 * permission is limited to the fixed outer limits shell, leaks itself, and
 * binaries copied into WORKDIR.
 */
export const LEAKS_EXECUTION_PROFILE = [
  "(version 1)",
  "(deny default)",
  '(import "system.sb")',
  "(deny network*)",
  `(allow process-exec (literal "${BASH_PATH}"))`,
  `(allow process-exec (literal "${LEAKS_PATH}"))`,
  '(allow process-exec (subpath (param "WORKDIR")))',
  "(allow process-fork)",
  "(allow mach-priv-task-port (target same-sandbox))",
  "(allow signal (target same-sandbox))",
  '(allow file-read* file-test-existence (subpath (param "WORKDIR")))',
  '(allow file-write* (subpath (param "WORKDIR")))',
  '(allow file-read* file-test-existence (subpath "/bin"))',
  `(allow file-read* file-test-existence (literal "${LEAKS_PATH}"))`,
  '(allow file-read* file-test-existence (subpath "/System"))',
  '(allow file-read* file-test-existence (subpath "/usr/lib"))',
  '(allow file-map-executable (subpath "/bin"))',
  `(allow file-map-executable (literal "${LEAKS_PATH}"))`,
  '(allow file-map-executable (subpath "/System"))',
  '(allow file-map-executable (subpath "/usr/lib"))',
  '(deny file-read* file-test-existence (subpath "/usr/local"))',
  '(deny file-map-executable (subpath "/usr/local"))',
].join("\n");

/**
 * Compatibility export until Runner selects COMPILE/RUN profiles per action.
 * Keeping the broader compile profile avoids silently breaking compilation.
 */
export const EXECUTION_PROFILE = COMPILE_EXECUTION_PROFILE;

export interface ToolchainProbeResult {
  readonly available: boolean;
  readonly detail: string;
  readonly platform?: "darwin" | "win32";
  readonly executablePath?: string;
  readonly sdkPath?: string;
  readonly developerRootPath?: string;
  readonly sanitizerRuntimePath?: string;
  readonly jobHostPath?: string;
  readonly targetTriple?: string;
  readonly toolchainRootPath?: string;
}

export type ToolchainDetector = () => ToolchainProbeResult;

export interface SeatbeltCanaryResult {
  readonly succeeded: boolean;
  readonly detail: string;
}

export interface SeatbeltCanary {
  run(): Promise<SeatbeltCanaryResult>;
}

export interface CanaryCommandResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface CanaryCommandSpecification {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type CanaryCommandExecutor = (
  specification: CanaryCommandSpecification,
) => Promise<CanaryCommandResult>;

export interface SeatbeltProbeResult {
  readonly status: Extract<IsolationProbeStatus, "probe-succeeded" | "unavailable">;
  readonly detail: string;
}

export interface CapabilityProbe {
  probe(): Promise<SeatbeltProbeResult>;
}

interface SystemCapabilityProbeOptions {
  readonly detectToolchain?: ToolchainDetector;
  readonly canary?: SeatbeltCanary;
}

export class SystemCapabilityProbe implements CapabilityProbe {
  readonly #detectToolchain: ToolchainDetector;
  readonly #canary: SeatbeltCanary | undefined;

  constructor(options: SystemCapabilityProbeOptions = {}) {
    this.#detectToolchain = options.detectToolchain ?? detectSupportedAppleClang;
    this.#canary = options.canary;
  }

  async probe(): Promise<SeatbeltProbeResult> {
    const toolchain = this.#detectToolchain();
    if (!toolchain.available) {
      return Object.freeze({
        status: "unavailable",
        detail: toolchain.detail,
      });
    }

    try {
      const clangPath = toolchain.executablePath;
      const sdkPath = toolchain.sdkPath;
      if (this.#canary === undefined && (clangPath === undefined || sdkPath === undefined)) {
        return Object.freeze({
          status: "unavailable",
          detail: "Seatbelt canary 缺少已验证的 clang 或 SDK 路径；默认拒绝运行。",
        });
      }
      const canary =
        this.#canary ??
        new SystemSeatbeltCanary({
          clangPath: clangPath as string,
          sdkPath: sdkPath as string,
          ...(toolchain.developerRootPath === undefined
            ? {}
            : { developerRootPath: toolchain.developerRootPath }),
        });
      const canaryResult = await canary.run();
      return Object.freeze({
        status: canaryResult.succeeded ? "probe-succeeded" : "unavailable",
        detail: canaryResult.detail,
      });
    } catch {
      return Object.freeze({
        status: "unavailable",
        detail: "Seatbelt canary 初始化或回收失败；默认拒绝运行。",
      });
    }
  }
}

interface SystemSeatbeltCanaryOptions {
  readonly execute?: CanaryCommandExecutor;
  readonly tempRoot?: string;
  readonly clangPath?: string;
  readonly sdkPath?: string;
  readonly developerRootPath?: string;
}

export class SystemSeatbeltCanary implements SeatbeltCanary {
  readonly #execute: CanaryCommandExecutor;
  readonly #tempRoot: string;
  readonly #clangPath: string;
  readonly #sdkPath: string | undefined;
  readonly #developerRootPath: string;

  constructor(options: SystemSeatbeltCanaryOptions = {}) {
    this.#execute = options.execute ?? execFileResult;
    this.#tempRoot = realpathSync(options.tempRoot ?? tmpdir());
    this.#clangPath = options.clangPath ?? CLANG_PATH;
    this.#sdkPath = options.sdkPath;
    this.#developerRootPath = options.developerRootPath ?? DEFAULT_DEVELOPER_ROOT;
  }

  async run(): Promise<SeatbeltCanaryResult> {
    const createdRoot = await mkdtemp(join(this.#tempRoot, "c-block-seatbelt-canary-"));
    const root = await realpath(createdRoot);
    const workDirectory = join(root, "allowed");
    const forbiddenDirectory = join(root, "forbidden");

    try {
      await Promise.all([
        mkdir(workDirectory, { mode: CANARY_DIRECTORY_MODE }),
        mkdir(forbiddenDirectory, { mode: CANARY_DIRECTORY_MODE }),
      ]);
      const readablePath = join(workDirectory, "readable.txt");
      const writablePath = join(workDirectory, "writable.txt");
      const forbiddenReadablePath = join(forbiddenDirectory, "secret.txt");
      const forbiddenWritablePath = join(forbiddenDirectory, "created.txt");
      const sourcePath = join(workDirectory, CANARY_SOURCE_NAME);
      const executablePath = join(workDirectory, CANARY_EXECUTABLE_NAME);
      await Promise.all([
        writeFile(readablePath, "allowed", { mode: CANARY_FILE_MODE }),
        writeFile(forbiddenReadablePath, "forbidden", {
          mode: CANARY_FILE_MODE,
        }),
        writeFile(sourcePath, SEATBELT_CANARY_SOURCE, {
          mode: CANARY_FILE_MODE,
        }),
      ]);

      const compileResult = await this.#execute({
        command: SANDBOX_EXEC_PATH,
        args: Object.freeze([
          "-D",
          `WORKDIR=${workDirectory}`,
          "-D",
          `TEMPROOT=${this.#tempRoot}`,
          "-D",
          `DEVROOT=${this.#developerRootPath}`,
          "-p",
          COMPILE_EXECUTION_PROFILE,
          this.#clangPath,
          "-std=c17",
          "-fintegrated-cc1",
          ...(this.#sdkPath === undefined ? [] : ["-isysroot", this.#sdkPath]),
          "-O0",
          "-g0",
          "-Wall",
          "-Wextra",
          "-Wpedantic",
          "-fno-color-diagnostics",
          CANARY_SOURCE_NAME,
          "-o",
          CANARY_EXECUTABLE_NAME,
        ]),
        cwd: workDirectory,
        timeoutMs: CANARY_COMPILE_TIMEOUT_MS,
      });
      if (!compileResult.ok) {
        return Object.freeze({
          succeeded: false,
          detail: `Seatbelt compile canary 未通过（${compileResult.reason}）；默认拒绝运行。`,
        });
      }

      const runResult = await this.#execute({
        command: SANDBOX_EXEC_PATH,
        args: Object.freeze([
          "-D",
          `WORKDIR=${workDirectory}`,
          "-p",
          RUN_EXECUTION_PROFILE,
          executablePath,
          readablePath,
          writablePath,
          forbiddenReadablePath,
          forbiddenWritablePath,
        ]),
        cwd: workDirectory,
        timeoutMs: CANARY_RUN_TIMEOUT_MS,
      });

      if (
        runResult.ok &&
        Buffer.from(runResult.stdout).equals(Buffer.from(SEATBELT_CANARY_SENTINEL, "utf8"))
      ) {
        return Object.freeze({
          succeeded: true,
          detail:
            "Seatbelt canary 已在沙箱内编译并运行 C 程序，验证工作目录内读写并拒绝目录外读写；这仍不是 hostile-code 安全保证。",
        });
      }
      return Object.freeze({
        succeeded: false,
        detail: `Seatbelt run canary 未通过（${runResult.ok ? "sentinel 不匹配" : runResult.reason}）；默认拒绝运行。`,
      });
    } finally {
      await rm(createdRoot, { force: true, recursive: true });
    }
  }
}

const SEATBELT_CANARY_SOURCE = `#include <stdio.h>

static int can_read(const char *path) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        return 0;
    }
    (void)fclose(file);
    return 1;
}

static int can_write(const char *path) {
    FILE *file = fopen(path, "wb");
    if (file == NULL) {
        return 0;
    }
    (void)fclose(file);
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 5) {
        return 2;
    }
    if (!can_read(argv[1])) {
        return 10;
    }
    if (!can_write(argv[2])) {
        return 11;
    }
    if (can_read(argv[3])) {
        return 12;
    }
    if (can_write(argv[4])) {
        return 13;
    }
    fputs("${SEATBELT_CANARY_SENTINEL.replace("\n", "\\n")}", stdout);
    return 0;
}
`;

export function classifyClangVersion(output: string): ToolchainProbeResult {
  const firstLine = output.split(/\r?\n/u)[0]?.trim() ?? "";
  const major = appleClangMajor(firstLine);
  if (
    major !== undefined &&
    major >= MIN_SUPPORTED_APPLE_CLANG_MAJOR &&
    major <= MAX_SUPPORTED_APPLE_CLANG_MAJOR
  ) {
    return Object.freeze({
      available: true,
      detail: firstLine,
    });
  }
  return Object.freeze({
    available: false,
    detail:
      firstLine.length === 0
        ? "工具链不可用/未验证：无法读取 /usr/bin/clang 版本。"
        : `工具链不可用/未验证：要求 Apple clang ${MIN_SUPPORTED_APPLE_CLANG_MAJOR}.x–${MAX_SUPPORTED_APPLE_CLANG_MAJOR}.x，实际为 ${firstLine}`,
  });
}

function appleClangMajor(firstLine: string): number | undefined {
  const match = /^Apple clang version (\d+)\./u.exec(firstLine);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

export function detectSupportedAppleClang(): ToolchainProbeResult {
  const result = spawnSync(CLANG_PATH, ["--version"], {
    encoding: "utf8",
    env: minimalProbeEnvironment(),
    shell: false,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    return Object.freeze({
      available: false,
      detail: "工具链不可用/未验证：无法执行 /usr/bin/clang --version。",
    });
  }
  const gate = classifyClangVersion(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (!gate.available) {
    return gate;
  }

  try {
    const executablePath = resolveTrustedXcrunPath(
      ["--no-cache", "--find", "clang"],
      "clang",
      "file",
    );
    const sdkPath = resolveTrustedXcrunPath(
      ["--no-cache", "--sdk", "macosx", "--show-sdk-path"],
      "macOS SDK",
      "directory",
    );
    const developerRoot = trustedDeveloperRoot(executablePath);
    if (developerRoot === undefined || trustedDeveloperRoot(sdkPath) !== developerRoot) {
      throw new Error("clang 与 SDK 不在同一受信 Developer root。 ");
    }

    const resolvedVersion = spawnSync(executablePath, ["--version"], {
      encoding: "utf8",
      env: minimalProbeEnvironment(),
      shell: false,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const resolvedGate = classifyClangVersion(
      `${resolvedVersion.stdout ?? ""}${resolvedVersion.stderr ?? ""}`,
    );
    if (
      resolvedVersion.error !== undefined ||
      resolvedVersion.status !== 0 ||
      !resolvedGate.available
    ) {
      throw new Error("xcrun 返回的 clang 不在受支持版本范围。 ");
    }
    const initialMajor = appleClangMajor(gate.detail);
    const resolvedMajor = appleClangMajor(resolvedGate.detail);
    if (
      initialMajor === undefined ||
      resolvedMajor === undefined ||
      initialMajor !== resolvedMajor
    ) {
      throw new Error("/usr/bin/clang 与 xcrun 解析出的 clang 主版本不一致。 ");
    }

    const sanitizerRuntimePath = resolveTrustedCommandPath(
      executablePath,
      ["--print-runtime-dir"],
      "sanitizer runtime",
      "directory",
    );
    if (
      trustedDeveloperRoot(sanitizerRuntimePath) !== developerRoot ||
      !sanitizerRuntimePath.endsWith(`/usr/lib/clang/${resolvedMajor}/lib/darwin`)
    ) {
      throw new Error("sanitizer runtime 与已验证的 Apple clang 主版本不匹配。 ");
    }

    return Object.freeze({
      available: true,
      platform: "darwin",
      detail: `${gate.detail}；工具链 ${executablePath}`,
      executablePath,
      sdkPath,
      developerRootPath: developerRoot,
      sanitizerRuntimePath,
    });
  } catch (error) {
    return Object.freeze({
      available: false,
      detail: `工具链不可用/未验证：${error instanceof Error ? error.message.trim() : "无法解析受信 clang/SDK 路径。"}`,
    });
  }
}

interface WindowsToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly llvmVersion: string;
  readonly architecture: "x64";
  readonly target: string;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly files: Readonly<Record<string, string>>;
}

export function detectSupportedWindowsToolchain(
  runtimeRootOverride?: string,
  architecture: string = process.arch,
): ToolchainProbeResult {
  if (architecture !== "x64") {
    return Object.freeze({
      available: false,
      platform: "win32",
      detail: `Windows 工具链不可用：首发仅支持 x64，当前架构为 ${architecture}。`,
    });
  }
  const runtimeRoot = runtimeRootOverride ?? resolveWindowsRuntimeRoot();
  if (runtimeRoot === undefined) {
    return Object.freeze({
      available: false,
      platform: "win32",
      detail: "Windows 工具链不可用：未找到随应用安装的受信运行时。",
    });
  }

  try {
    const canonicalRoot = realpathSync(runtimeRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error("运行时根目录不是目录。");
    const manifestPath = canonicalWindowsRuntimeFile(canonicalRoot, "toolchain-manifest.json");
    const manifest = parseWindowsToolchainManifest(readFileSync(manifestPath, "utf8"));
    const runtimeFiles = enumerateWindowsRuntimeExecutionChain(canonicalRoot);
    const manifestPaths = Object.keys(manifest.files).sort(compareCodePoints);
    if (
      runtimeFiles.map(([relativePath]) => relativePath).join("\n") !== manifestPaths.join("\n")
    ) {
      throw new Error("toolchain manifest 与安装的执行链文件不一致。");
    }
    for (const [relativePath, path] of runtimeFiles) {
      verifyWindowsRuntimeHash(manifest, relativePath, path);
    }
    const clangPath = requireWindowsRuntimePath(runtimeFiles, "toolchain/bin/clang.exe");
    const jobHostPath = requireWindowsRuntimePath(runtimeFiles, "runtime/algolatch-job-host.exe");

    const result = spawnSync(clangPath, ["--version"], {
      encoding: "utf8",
      env: minimalWindowsProbeEnvironment(join(canonicalRoot, "toolchain", "bin")),
      shell: false,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error !== undefined || result.status !== 0) {
      throw new Error("无法执行内置 clang.exe --version。");
    }
    if (
      !new RegExp(`\\bclang version ${WINDOWS_LLVM_VERSION.replaceAll(".", "\\.")}\\b`, "u").test(
        output,
      )
    ) {
      throw new Error(`内置 clang 不是锁定的 LLVM ${WINDOWS_LLVM_VERSION}。`);
    }
    const target = /^Target:\s*([^\r\n]+)$/mu.exec(output)?.[1]?.trim();
    if (target !== WINDOWS_TARGET_TRIPLE) {
      throw new Error(`内置 clang target 无效：${target ?? "未报告"}。`);
    }

    return Object.freeze({
      available: true,
      platform: "win32",
      detail: `llvm-mingw ${WINDOWS_TOOLCHAIN_VERSION}；clang version ${WINDOWS_LLVM_VERSION}；Target: ${target}`,
      executablePath: clangPath,
      jobHostPath,
      targetTriple: target,
      toolchainRootPath: join(canonicalRoot, "toolchain"),
    });
  } catch (error) {
    return Object.freeze({
      available: false,
      platform: "win32",
      detail: `Windows 工具链不可用/未验证：${error instanceof Error ? error.message : "运行时校验失败。"}`,
    });
  }
}

export function detectSupportedHostToolchain(
  platform: NodeJS.Platform = process.platform,
): ToolchainProbeResult {
  if (platform === "darwin") return detectSupportedAppleClang();
  if (platform === "win32") return detectSupportedWindowsToolchain();
  return Object.freeze({
    available: false,
    detail: `当前平台 ${platform} 尚未提供受支持的 C 工具链。`,
  });
}

function resolveWindowsRuntimeRoot(): string | undefined {
  if (process.defaultApp === true) {
    const developmentRoot = process.env.PANEL_WINDOWS_RUNTIME_ROOT;
    return developmentRoot === undefined || developmentRoot.trim().length === 0
      ? undefined
      : developmentRoot;
  }
  return typeof process.resourcesPath === "string"
    ? join(process.resourcesPath, "windows-runtime")
    : undefined;
}

function parseWindowsToolchainManifest(contents: string): WindowsToolchainManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("toolchain manifest 不是有效 JSON。");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.toolchainVersion !== WINDOWS_TOOLCHAIN_VERSION ||
    value.llvmVersion !== WINDOWS_LLVM_VERSION ||
    value.architecture !== "x64" ||
    value.target !== WINDOWS_TARGET_TRIPLE ||
    value.sourceSha256 !== WINDOWS_TOOLCHAIN_SOURCE_SHA256 ||
    value.sourceUrl !== WINDOWS_TOOLCHAIN_SOURCE_URL ||
    !isRecord(value.files)
  ) {
    throw new Error("toolchain manifest 与锁定版本不匹配。");
  }
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value.files)) {
    if (!isWindowsRuntimeManifestPath(path) || !/^[a-f0-9]{64}$/u.test(String(hash))) {
      throw new Error("toolchain manifest 文件摘要无效。");
    }
    files[path] = String(hash);
  }
  for (const requiredPath of WINDOWS_REQUIRED_RUNTIME_HASH_PATHS) {
    if (files[requiredPath] === undefined) {
      throw new Error(`toolchain manifest 缺少 ${requiredPath} 摘要。`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    toolchainVersion: WINDOWS_TOOLCHAIN_VERSION,
    llvmVersion: WINDOWS_LLVM_VERSION,
    architecture: "x64",
    target: WINDOWS_TARGET_TRIPLE,
    sourceUrl: WINDOWS_TOOLCHAIN_SOURCE_URL,
    sourceSha256: WINDOWS_TOOLCHAIN_SOURCE_SHA256,
    files: Object.freeze(files),
  });
}

function canonicalWindowsRuntimeFile(root: string, relativePath: string): string {
  const unresolvedPath = join(root, ...relativePath.split("/"));
  if (lstatSync(unresolvedPath).isSymbolicLink()) {
    throw new Error(`${relativePath} 不能是符号链接。`);
  }
  const path = realpathSync(unresolvedPath);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || !statSync(path).isFile()) {
    throw new Error(`${relativePath} 不在受信运行时目录。`);
  }
  return path;
}

function enumerateWindowsRuntimeExecutionChain(
  root: string,
): ReadonlyArray<readonly [relativePath: string, path: string]> {
  const entries: Array<readonly [string, string]> = [];
  const binRoot = canonicalWindowsRuntimeDirectory(root, "toolchain/bin");
  for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
    const relativePath = `toolchain/bin/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink() || !isWindowsRuntimeManifestPath(relativePath)) {
      throw new Error(`Windows 工具链 bin 包含未声明或非普通文件：${entry.name}。`);
    }
    entries.push([relativePath, canonicalWindowsRuntimeFile(root, relativePath)]);
  }
  const runtimeRoot = canonicalWindowsRuntimeDirectory(root, "runtime");
  const runtimeEntries = readdirSync(runtimeRoot, { withFileTypes: true });
  if (
    runtimeEntries.length !== 1 ||
    runtimeEntries[0]?.name !== "algolatch-job-host.exe" ||
    !runtimeEntries[0].isFile() ||
    runtimeEntries[0].isSymbolicLink()
  ) {
    throw new Error("Windows 运行时目录必须只包含普通 Job Object broker。");
  }
  entries.push([
    "runtime/algolatch-job-host.exe",
    canonicalWindowsRuntimeFile(root, "runtime/algolatch-job-host.exe"),
  ]);
  return Object.freeze(entries.sort(([left], [right]) => compareCodePoints(left, right)));
}

function canonicalWindowsRuntimeDirectory(root: string, relativePath: string): string {
  const unresolvedPath = join(root, ...relativePath.split("/"));
  if (lstatSync(unresolvedPath).isSymbolicLink()) {
    throw new Error(`${relativePath} 不能是符号链接。`);
  }
  const path = realpathSync(unresolvedPath);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || !statSync(path).isDirectory()) {
    throw new Error(`${relativePath} 不在受信运行时目录。`);
  }
  return path;
}

function isWindowsRuntimeManifestPath(path: string): boolean {
  return (
    WINDOWS_REQUIRED_RUNTIME_HASH_PATHS.includes(
      path as (typeof WINDOWS_REQUIRED_RUNTIME_HASH_PATHS)[number],
    ) || /^toolchain\/bin\/[A-Za-z0-9._-]+\.dll$/iu.test(path)
  );
}

function requireWindowsRuntimePath(
  files: ReadonlyArray<readonly [relativePath: string, path: string]>,
  relativePath: string,
): string {
  const path = files.find(([candidate]) => candidate === relativePath)?.[1];
  if (path === undefined) throw new Error(`Windows 运行时缺少 ${relativePath}。`);
  return path;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function verifyWindowsRuntimeHash(
  manifest: WindowsToolchainManifest,
  relativePath: string,
  path: string,
): void {
  const expected = manifest.files[relativePath];
  if (expected === undefined) throw new Error(`manifest 缺少 ${relativePath} 摘要。`);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw new Error(`${relativePath} 摘要不匹配。`);
}

function minimalWindowsProbeEnvironment(toolchainBin: string): Readonly<Record<string, string>> {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return Object.freeze({
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    PATH: `${toolchainBin};${join(windowsRoot, "System32")}`,
    LANG: "C",
    LC_ALL: "C",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveTrustedXcrunPath(
  args: readonly string[],
  label: string,
  expectedType: "file" | "directory",
): string {
  return resolveTrustedCommandPath(XCRUN_PATH, args, label, expectedType);
}

function resolveTrustedCommandPath(
  command: string,
  args: readonly string[],
  label: string,
  expectedType: "file" | "directory",
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: minimalProbeEnvironment(),
    shell: false,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`无法通过 ${command} 解析${label}。`);
  }
  const output = String(result.stdout ?? "").trim();
  if (output.length === 0 || output.includes("\0") || output.includes("\n")) {
    throw new Error(`${label}路径格式无效。`);
  }
  const resolvedPath = realpathSync(output);
  const metadata = statSync(resolvedPath);
  if (
    (expectedType === "file" && !metadata.isFile()) ||
    (expectedType === "directory" && !metadata.isDirectory()) ||
    trustedDeveloperRoot(resolvedPath) === undefined
  ) {
    throw new Error(`${label}不在受信 Developer root。`);
  }
  return resolvedPath;
}

function trustedDeveloperRoot(path: string): string | undefined {
  return TRUSTED_DEVELOPER_ROOTS.find((root) => {
    const pathFromRoot = relative(root, path);
    return (
      pathFromRoot.length === 0 || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
    );
  });
}

export function resolveCanonicalDeveloperRoots(candidates: readonly string[]): readonly string[] {
  const roots = new Set<string>();
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isDirectory()) roots.add(resolved);
    } catch {
      // An absent candidate is not trusted; detector remains fail-closed.
    }
  }
  return Object.freeze([...roots]);
}

export function parseRunnerMode(
  value: string | undefined,
  detectToolchain: ToolchainDetector = () => detectSupportedHostToolchain(),
  platform: NodeJS.Platform = process.platform,
): RunnerMode {
  if (value === "disabled") {
    return "disabled";
  }
  if (value !== undefined && value !== "seatbelt-best-effort" && value !== "trusted-only") {
    return "disabled";
  }
  if (!detectToolchain().available) return "disabled";
  if (platform === "win32") return "trusted-only";
  return value ?? "seatbelt-best-effort";
}

export function toolchainIdentifier(toolchain: ToolchainProbeResult, mode: RunnerMode): string {
  const sanitized = toolchain.detail
    .replace(/(^|[\s；，(])\/[^\s；，)]+/gu, "$1[verified-path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  const detail = sanitized.length > 0 ? sanitized : "工具链信息不可用";
  return `${mode === "disabled" ? "disabled" : toolchain.available ? "verified" : "unavailable"}:${detail}`;
}

export function capabilitiesWithoutProbe(
  mode: RunnerMode,
  toolchainId: string,
  isolationKind: IsolationKind = "macos-seatbelt",
): Capabilities {
  if (mode === "disabled") {
    return Object.freeze({
      mode,
      runnerEnabled: false,
      toolchainId,
      isolationProbe: Object.freeze({
        kind: isolationKind,
        status: "not-checked",
        detail: "运行器已禁用，或本机工具链不可用/未验证。",
      }),
      memoryDiagnostics: Object.freeze({
        available: false,
        detail: "运行器已禁用，无法执行完整内存诊断。",
      }),
      requiresNativeTrustConfirmation: false,
    });
  }
  return Object.freeze({
    mode,
    runnerEnabled: true,
    toolchainId,
    isolationProbe: Object.freeze({
      kind: isolationKind,
      status: isolationKind === "windows-job-object" ? "probe-succeeded" : "not-checked",
      detail:
        isolationKind === "windows-job-object"
          ? "Windows Job Object 已限制进程树、内存与 CPU；不提供文件或网络隔离。"
          : "未请求 Seatbelt 探测；仅允许显式确认的可信代码。",
    }),
    memoryDiagnostics: Object.freeze({
      available: isolationKind === "macos-seatbelt",
      detail:
        isolationKind === "macos-seatbelt"
          ? "Apple clang sanitizer 与 leaks 双门诊断可用。"
          : "Windows 首发仅提供静态诊断；完整内存诊断尚未开放。",
    }),
    requiresNativeTrustConfirmation: true,
  });
}

function execFileResult(specification: CanaryCommandSpecification): Promise<CanaryCommandResult> {
  return new Promise((resolve) => {
    execFile(
      specification.command,
      [...specification.args],
      {
        cwd: specification.cwd,
        encoding: "buffer",
        env: minimalProbeEnvironment(specification.cwd),
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: specification.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const reason =
          error === null
            ? "ok"
            : error.killed
              ? "timeout"
              : error.signal !== null
                ? `signal:${error.signal}`
                : error.code === undefined || error.code === null
                  ? "执行失败"
                  : String(error.code);
        resolve(
          Object.freeze({
            ok: error === null,
            reason,
            stdout: Uint8Array.from(stdout),
            stderr: Uint8Array.from(stderr),
          }),
        );
      },
    );
  });
}

function minimalProbeEnvironment(workDirectory?: string): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: workDirectory ?? "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    ...(workDirectory === undefined ? {} : { TMPDIR: workDirectory }),
  });
}

export { SANDBOX_EXEC_PATH };
export {
  DEFAULT_SUPPORTED_APPLE_CLANG_SANITIZER_RUNTIME,
  DEFAULT_DEVELOPER_ROOT,
  MAX_SUPPORTED_APPLE_CLANG_MAJOR,
  MIN_SUPPORTED_APPLE_CLANG_MAJOR,
};
