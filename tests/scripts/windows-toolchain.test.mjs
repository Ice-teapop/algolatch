import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_TOOLCHAIN,
  WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS,
  assertWindowsToolchainSourceDigest,
  createWindowsToolchainManifest,
  hashWindowsToolchainExecutionChain,
  isWindowsToolchainManifestPath,
  parseWindowsClangVersion,
  requireWindowsPlatform,
  resolveWindowsToolchainRedirect,
  validateWindowsToolchainArchiveEntries,
  validateWindowsToolchainUrl,
} from "../../scripts/lib/windows-toolchain.mjs";

describe("Windows embedded toolchain supply chain", () => {
  it("locks the official llvm-mingw UCRT x86_64 release", () => {
    expect(WINDOWS_TOOLCHAIN).toMatchObject({
      schemaVersion: 1,
      toolchainVersion: "20260616",
      llvmVersion: "22.1.8",
      architecture: "x64",
      target: "x86_64-w64-windows-gnu",
      sourceUrl:
        "https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip",
      sourceSha256: "b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35",
      sourceSizeBytes: 187_504_083,
    });
    expect(() =>
      assertWindowsToolchainSourceDigest(
        WINDOWS_TOOLCHAIN.sourceSha256,
        WINDOWS_TOOLCHAIN.sourceSizeBytes,
      ),
    ).not.toThrow();
    expect(() =>
      assertWindowsToolchainSourceDigest("0".repeat(64), WINDOWS_TOOLCHAIN.sourceSizeBytes),
    ).toThrow(/SHA-256/u);
    expect(() => assertWindowsToolchainSourceDigest(WINDOWS_TOOLCHAIN.sourceSha256, 1)).toThrow(
      /大小/u,
    );
  });

  it("runs only on Windows and accepts only allowlisted HTTPS download hops", () => {
    expect(() => requireWindowsPlatform("win32")).not.toThrow();
    expect(() => requireWindowsPlatform("darwin")).toThrow(/win32/u);
    expect(validateWindowsToolchainUrl(WINDOWS_TOOLCHAIN.sourceUrl).hostname).toBe("github.com");
    expect(
      resolveWindowsToolchainRedirect(
        WINDOWS_TOOLCHAIN.sourceUrl,
        "https://release-assets.githubusercontent.com/github-production-release-asset/file.zip?token=x",
        0,
      ).hostname,
    ).toBe("release-assets.githubusercontent.com");
    expect(() => validateWindowsToolchainUrl("http://github.com/file.zip")).toThrow(/HTTPS/u);
    expect(() => validateWindowsToolchainUrl("https://github.com.evil.test/file.zip")).toThrow(
      /白名单/u,
    );
    expect(() =>
      resolveWindowsToolchainRedirect(WINDOWS_TOOLCHAIN.sourceUrl, "https://evil.test/file.zip", 0),
    ).toThrow(/白名单/u);
    expect(() =>
      resolveWindowsToolchainRedirect(WINDOWS_TOOLCHAIN.sourceUrl, "/next.zip", 5),
    ).toThrow(/超过 5 次/u);
  });

  it("rejects archive traversal and unexpected roots before extraction", () => {
    expect(() =>
      validateWindowsToolchainArchiveEntries([
        `${WINDOWS_TOOLCHAIN.archiveRoot}/bin/clang.exe`,
        `${WINDOWS_TOOLCHAIN.archiveRoot}/x86_64-w64-mingw32/include/stdio.h`,
      ]),
    ).not.toThrow();
    expect(() =>
      validateWindowsToolchainArchiveEntries([`${WINDOWS_TOOLCHAIN.archiveRoot}/../escape.exe`]),
    ).toThrow(/不安全路径/u);
    expect(() => validateWindowsToolchainArchiveEntries(["C:\\escape.exe"])).toThrow(/不安全路径/u);
    expect(() => validateWindowsToolchainArchiveEntries(["unexpected/bin/clang.exe"])).toThrow(
      /根目录不匹配/u,
    );
  });

  it("requires the exact clang version and runtime target", () => {
    const output = [
      "clang version 22.1.8",
      "Target: x86_64-w64-windows-gnu",
      "Thread model: posix",
    ].join("\r\n");
    expect(parseWindowsClangVersion(output)).toEqual({
      llvmVersion: "22.1.8",
      target: "x86_64-w64-windows-gnu",
    });
    expect(() => parseWindowsClangVersion(output.replace("22.1.8", "22.1.9"))).toThrow(
      /版本不匹配/u,
    );
    expect(() =>
      parseWindowsClangVersion(output.replace("x86_64-w64-windows-gnu", "x86_64-pc-windows-msvc")),
    ).toThrow(/Target 不匹配/u);
  });

  it("emits the exact sorted schema-1 execution-chain manifest", () => {
    const clangDigest = "1".repeat(64);
    const brokerDigest = "2".repeat(64);
    const linkerDigest = "3".repeat(64);
    const runtimeDigest = "4".repeat(64);
    const supportDigest = "5".repeat(64);
    const clangBinaryDigest = "6".repeat(64);
    const commonConfigDigest = "7".repeat(64);
    const targetConfigDigest = "8".repeat(64);
    expect(
      createWindowsToolchainManifest({
        "runtime/algolatch-job-host.exe": brokerDigest,
        "toolchain/bin/zlib.dll": supportDigest,
        "toolchain/bin/ld.lld.exe": linkerDigest,
        "toolchain/bin/clang.exe": clangDigest,
        "toolchain/bin/clang-22.exe": clangBinaryDigest,
        "toolchain/bin/libwinpthread-1.dll": runtimeDigest,
        "toolchain/bin/mingw32-common.cfg": commonConfigDigest,
        "toolchain/bin/x86_64-w64-windows-gnu.cfg": targetConfigDigest,
      }),
    ).toEqual({
      schemaVersion: 1,
      toolchainVersion: "20260616",
      llvmVersion: "22.1.8",
      architecture: "x64",
      target: "x86_64-w64-windows-gnu",
      sourceUrl: WINDOWS_TOOLCHAIN.sourceUrl,
      sourceSha256: WINDOWS_TOOLCHAIN.sourceSha256,
      files: {
        "runtime/algolatch-job-host.exe": brokerDigest,
        "toolchain/bin/clang-22.exe": clangBinaryDigest,
        "toolchain/bin/clang.exe": clangDigest,
        "toolchain/bin/ld.lld.exe": linkerDigest,
        "toolchain/bin/libwinpthread-1.dll": runtimeDigest,
        "toolchain/bin/mingw32-common.cfg": commonConfigDigest,
        "toolchain/bin/x86_64-w64-windows-gnu.cfg": targetConfigDigest,
        "toolchain/bin/zlib.dll": supportDigest,
      },
    });
    expect(
      Object.keys(
        createWindowsToolchainManifest({
          "runtime/algolatch-job-host.exe": brokerDigest,
          "toolchain/bin/clang-22.exe": clangBinaryDigest,
          "toolchain/bin/ld.lld.exe": linkerDigest,
          "toolchain/bin/clang.exe": clangDigest,
          "toolchain/bin/mingw32-common.cfg": commonConfigDigest,
          "toolchain/bin/x86_64-w64-windows-gnu.cfg": targetConfigDigest,
        }).files,
      ),
    ).toEqual([
      "runtime/algolatch-job-host.exe",
      "toolchain/bin/clang-22.exe",
      "toolchain/bin/clang.exe",
      "toolchain/bin/ld.lld.exe",
      "toolchain/bin/mingw32-common.cfg",
      "toolchain/bin/x86_64-w64-windows-gnu.cfg",
    ]);
    expect(WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS).toEqual([
      "toolchain/bin/clang.exe",
      "toolchain/bin/clang-22.exe",
      "toolchain/bin/ld.lld.exe",
      "toolchain/bin/mingw32-common.cfg",
      "toolchain/bin/x86_64-w64-windows-gnu.cfg",
      "runtime/algolatch-job-host.exe",
    ]);
    expect(isWindowsToolchainManifestPath("toolchain/bin/mingw32-common.cfg")).toBe(true);
    expect(isWindowsToolchainManifestPath("toolchain/bin/x86_64-w64-windows-gnu.cfg")).toBe(true);
    expect(isWindowsToolchainManifestPath("toolchain/bin/libc++.dll")).toBe(true);
    expect(isWindowsToolchainManifestPath("toolchain/bin/runtime-name.DLL")).toBe(true);
    expect(isWindowsToolchainManifestPath("toolchain/bin/llvm-ar.exe")).toBe(false);
  });

  it("rejects missing, additional, and malformed execution-chain records", () => {
    const requiredDigests = Object.fromEntries(
      WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS.map((path, index) => [
        path,
        String(index + 1).repeat(64),
      ]),
    );
    for (const missingPath of WINDOWS_TOOLCHAIN_REQUIRED_MANIFEST_PATHS) {
      const incompleteDigests = { ...requiredDigests };
      delete incompleteDigests[missingPath];
      let thrown;
      try {
        createWindowsToolchainManifest(incompleteDigests);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain(missingPath);
    }
    expect(() =>
      createWindowsToolchainManifest({
        ...requiredDigests,
        "runtime/extra.exe": "9".repeat(64),
      }),
    ).toThrow(/未声明/u);
    expect(() =>
      createWindowsToolchainManifest({
        ...requiredDigests,
        "toolchain/bin/tampered.dll": "0".repeat(63),
      }),
    ).toThrow(/摘要无效/u);
  });

  it("hashes every staged bin file and rejects non-files before manifest creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "algolatch-win-chain-"));
    const toolchain = join(root, "toolchain");
    const bin = join(toolchain, "bin");
    const runtime = join(root, "runtime");
    const broker = join(runtime, "algolatch-job-host.exe");
    try {
      await mkdir(bin, { recursive: true });
      await mkdir(runtime, { recursive: true });
      await Promise.all([
        writeFile(join(bin, "clang.exe"), "clang", "utf8"),
        writeFile(join(bin, "clang-22.exe"), "clang-binary", "utf8"),
        writeFile(join(bin, "ld.lld.exe"), "linker", "utf8"),
        writeFile(join(bin, "mingw32-common.cfg"), "common-config", "utf8"),
        writeFile(join(bin, "runtime.dll"), "runtime", "utf8"),
        writeFile(join(bin, "x86_64-w64-windows-gnu.cfg"), "target-config", "utf8"),
        writeFile(broker, "broker", "utf8"),
      ]);
      const digests = await hashWindowsToolchainExecutionChain(toolchain, broker);
      expect(Object.keys(digests)).toEqual([
        "toolchain/bin/clang-22.exe",
        "toolchain/bin/clang.exe",
        "toolchain/bin/ld.lld.exe",
        "toolchain/bin/mingw32-common.cfg",
        "toolchain/bin/runtime.dll",
        "toolchain/bin/x86_64-w64-windows-gnu.cfg",
        "runtime/algolatch-job-host.exe",
      ]);
      expect(() => createWindowsToolchainManifest(digests)).not.toThrow();

      const junctionTarget = join(root, "junction-target");
      await mkdir(junctionTarget);
      await symlink(junctionTarget, join(bin, "linked.dll"), "junction");
      await expect(hashWindowsToolchainExecutionChain(toolchain, broker)).rejects.toThrow(
        /非普通文件/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Windows Job Object broker source contract", () => {
  it("assigns a suspended Unicode child only after configuring kill, memory, process and CPU limits", async () => {
    const source = await readFile(
      new URL("../../native/windows-job-host.c", import.meta.url),
      "utf8",
    );
    for (const token of [
      "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
      "JOB_OBJECT_LIMIT_ACTIVE_PROCESS",
      "JOB_OBJECT_LIMIT_PROCESS_MEMORY",
      "JOB_OBJECT_LIMIT_JOB_MEMORY",
      "JOB_OBJECT_LIMIT_JOB_TIME",
      "CREATE_SUSPENDED",
      "CREATE_UNICODE_ENVIRONMENT",
      "AssignProcessToJobObject",
      "ResumeThread",
      "STARTF_USESTDHANDLES",
      "K32GetProcessMemoryInfo",
      'L"--metrics"',
      'L"--memory-bytes"',
      'L"--process-limit"',
      'L"--cpu-ms"',
    ]) {
      expect(source).toContain(token);
    }
    expect(source.indexOf("write_metrics_atomic(options.metrics_path")).toBeLessThan(
      source.indexOf("ResumeThread(child.hThread)"),
    );
    expect(source).toContain('{\\"rssBytes\\":%llu,\\"processCount\\":%lu}');
    expect(source).toContain("MoveFileExW");
    expect(source).toContain("ExitProcess(child_exit_code)");
    for (let code = 240; code <= 249; code++) expect(source).toContain(`= ${String(code)}`);
  });
});
