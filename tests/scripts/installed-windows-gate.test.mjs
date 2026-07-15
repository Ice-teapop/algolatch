import { describe, expect, it } from "vitest";
import {
  WINDOWS_CANARY_STDOUT,
  WINDOWS_REQUIRED_RUNTIME_FILE_PATHS,
  parsePowerShellJson,
  parseWindowsVerificationMode,
  readPeOffset,
  requireWindowsInstallGate,
  selectWindowsInstaller,
  validateAuthenticodeSignatureRecord,
  validateAuthenticodeSignatures,
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
} from "../../scripts/lib/installed-windows-gate.mjs";
import { WINDOWS_TOOLCHAIN } from "../../scripts/lib/windows-toolchain.mjs";

const SIGNER_THUMBPRINT = "A".repeat(40);
const TIMESTAMP_THUMBPRINT = "B".repeat(40);

describe("installed Windows release gate", () => {
  it("runs only on Windows and only in CI or with an explicit destructive gate", () => {
    expect(() => requireWindowsInstallGate("darwin", { CI: "true" })).toThrow(/只允许在 Windows/u);
    expect(() => requireWindowsInstallGate("win32", {})).toThrow(/CI.*PANEL_WINDOWS_INSTALL_GATE/u);
    expect(() => requireWindowsInstallGate("win32", { CI: "false" })).toThrow(/只允许在 CI/u);
    expect(() => requireWindowsInstallGate("win32", { CI: "true" })).not.toThrow();
    expect(() =>
      requireWindowsInstallGate("win32", { PANEL_WINDOWS_INSTALL_GATE: "1" }),
    ).not.toThrow();
  });

  it("defaults to the signed release and makes unsigned Beta explicit", () => {
    expect(parseWindowsVerificationMode([])).toEqual({
      requireAuthenticode: true,
      releaseDirectoryName: "release-windows",
    });
    expect(parseWindowsVerificationMode(["--allow-unsigned"])).toEqual({
      requireAuthenticode: false,
      releaseDirectoryName: "release-windows-beta",
    });
    expect(() => parseWindowsVerificationMode(["--unsigned"])).toThrow(/未知/u);
  });

  it("selects exactly one correctly labelled installer", () => {
    expect(
      selectWindowsInstaller([{ name: "AlgoLatch-Setup-0.0.2-x64.exe", kind: "file" }], {
        expectedVersion: "0.0.2",
        requireAuthenticode: true,
      }),
    ).toBe("AlgoLatch-Setup-0.0.2-x64.exe");
    expect(
      selectWindowsInstaller([{ name: "AlgoLatch-Setup-0.0.2-unsigned-x64.exe", kind: "file" }], {
        expectedVersion: "0.0.2",
        requireAuthenticode: false,
      }),
    ).toBe("AlgoLatch-Setup-0.0.2-unsigned-x64.exe");
    expect(() =>
      selectWindowsInstaller([{ name: "AlgoLatch-Setup-0.0.2-x64.exe", kind: "file" }], {
        expectedVersion: "0.0.2",
        requireAuthenticode: false,
      }),
    ).toThrow(/unsigned/u);
    expect(() =>
      selectWindowsInstaller(
        [
          { name: "AlgoLatch-Setup-0.0.2-x64.exe", kind: "file" },
          { name: "other.exe", kind: "file" },
        ],
        { expectedVersion: "0.0.2", requireAuthenticode: true },
      ),
    ).toThrow(/恰好存在一个/u);
  });

  it("requires Valid timestamped signatures from one publisher", () => {
    const signatures = signatureSet();
    expect(() => validateAuthenticodeSignatureRecord(signatures[0], "installer")).not.toThrow();
    expect(validateAuthenticodeSignatures(signatures)).toEqual({
      publisherSubject: "CN=AlgoLatch Release",
      publisherThumbprint: SIGNER_THUMBPRINT,
    });
    expect(() =>
      validateAuthenticodeSignatures(
        signatures.map((record) =>
          record.label === "application" ? { ...record, status: "HashMismatch" } : record,
        ),
      ),
    ).toThrow(/application.*Valid/u);
    expect(() =>
      validateAuthenticodeSignatures(
        signatures.map((record) =>
          record.label === "uninstaller" ? { ...record, timestampThumbprint: "" } : record,
        ),
      ),
    ).toThrow(/时间戳证书/u);
    expect(() =>
      validateAuthenticodeSignatures(
        signatures.map((record) =>
          record.label === "application"
            ? { ...record, signerSubject: "CN=Different Publisher" }
            : record,
        ),
      ),
    ).toThrow(/发布者不一致/u);
  });

  it("parses PowerShell JSON without accepting empty or malformed output", () => {
    expect(parsePowerShellJson('\uFEFF{"status":"Valid"}\n', "签名")).toEqual({
      status: "Valid",
    });
    expect(() => parsePowerShellJson("", "签名")).toThrow(/没有返回 JSON/u);
    expect(() => parsePowerShellJson("not-json", "签名")).toThrow(/无效 JSON/u);
  });

  it("accepts only an x64 PE executable", () => {
    const dosHeader = Buffer.alloc(64);
    dosHeader.write("MZ", 0, "ascii");
    dosHeader.writeUInt32LE(0x100, 0x3c);
    expect(readPeOffset(dosHeader)).toBe(0x100);
    const peHeader = Buffer.alloc(6);
    peHeader.write("PE\0\0", 0, "binary");
    peHeader.writeUInt16LE(0x8664, 4);
    expect(() => validateX64PeHeader(peHeader)).not.toThrow();
    peHeader.writeUInt16LE(0x14c, 4);
    expect(() => validateX64PeHeader(peHeader)).toThrow(/不是 x64 PE/u);
    expect(() => readPeOffset(Buffer.alloc(64))).toThrow(/MZ header/u);
  });

  it("locks ProductName and equivalent Windows numeric versions", () => {
    expect(() =>
      validateWindowsVersionInfo(
        { productName: "AlgoLatch", productVersion: "0.0.2", fileVersion: "0.0.2.0" },
        "0.0.2",
      ),
    ).not.toThrow();
    expect(() =>
      validateWindowsVersionInfo(
        { productName: "Other", productVersion: "0.0.2", fileVersion: "0.0.2" },
        "0.0.2",
      ),
    ).toThrow(/ProductName/u);
    expect(() =>
      validateWindowsVersionInfo(
        { productName: "AlgoLatch", productVersion: "0.0.3", fileVersion: "0.0.2" },
        "0.0.2",
      ),
    ).toThrow(/ProductVersion/u);
  });

  it("locks the installed runtime manifest and the complete execution-chain digests", () => {
    const manifest = runtimeManifest();
    const expectedDigests = runtimeDigests();
    expect(validateWindowsRuntimeManifest(manifest)).toEqual(manifest);
    expect(() => validateWindowsRuntimeDigests(manifest, expectedDigests)).not.toThrow();
    expect(() => validateWindowsRuntimeManifest({ ...manifest, llvmVersion: "0.0.0" })).toThrow(
      /锁定工具链/u,
    );
    for (const missingPath of WINDOWS_REQUIRED_RUNTIME_FILE_PATHS) {
      const files = { ...expectedDigests };
      delete files[missingPath];
      expect(() => validateWindowsRuntimeManifest({ ...manifest, files })).toThrow(
        new RegExp(`漏掉固定项.*${escapeRegExp(missingPath)}`, "u"),
      );
    }
    const incompleteDigests = { ...expectedDigests };
    delete incompleteDigests["toolchain/bin/libwinpthread-1.dll"];
    expect(() => validateWindowsRuntimeDigests(manifest, incompleteDigests)).toThrow(/精确覆盖/u);
    for (const [path, expectedDigest] of Object.entries(expectedDigests)) {
      const tamperedDigest = expectedDigest === "f".repeat(64) ? "0".repeat(64) : "f".repeat(64);
      expect(() =>
        validateWindowsRuntimeDigests(manifest, {
          ...expectedDigests,
          [path]: tamperedDigest,
        }),
      ).toThrow(new RegExp(`${escapeRegExp(path)}.*摘要不一致`, "u"));
    }
    expect(WINDOWS_REQUIRED_RUNTIME_FILE_PATHS).toEqual([
      "toolchain/bin/clang.exe",
      "toolchain/bin/clang-22.exe",
      "toolchain/bin/ld.lld.exe",
      "toolchain/bin/mingw32-common.cfg",
      "toolchain/bin/x86_64-w64-windows-gnu.cfg",
      "runtime/algolatch-job-host.exe",
    ]);
  });

  it("constructs the exact Job Object broker protocol and rejects unsafe inputs", () => {
    expect(
      windowsJobHostArguments({
        metricsPath: "C:\\Gate\\metrics.json",
        memoryBytes: 1024,
        processLimit: 4,
        cpuMs: 5000,
        command: "C:\\Gate\\clang.exe",
        args: ["main.c", "-o", "main.exe"],
      }),
    ).toEqual([
      "--metrics",
      "C:\\Gate\\metrics.json",
      "--memory-bytes",
      "1024",
      "--process-limit",
      "4",
      "--cpu-ms",
      "5000",
      "--",
      "C:\\Gate\\clang.exe",
      "main.c",
      "-o",
      "main.exe",
    ]);
    expect(() =>
      windowsJobHostArguments({
        metricsPath: "relative.json",
        memoryBytes: 1024,
        processLimit: 4,
        cpuMs: 5000,
        command: "C:\\Gate\\clang.exe",
        args: [],
      }),
    ).toThrow(/绝对 Windows 路径/u);
  });

  it("verifies canary stdout, exit status and bounded broker metrics", () => {
    expect(() =>
      validateWindowsBrokerProcessOutcome(
        {
          exitCode: 0,
          signal: null,
          stdout: WINDOWS_CANARY_STDOUT.replace("\n", "\r\n"),
          stderr: "",
          errorMessage: null,
        },
        { label: "canary run", expectedStdout: WINDOWS_CANARY_STDOUT },
      ),
    ).not.toThrow();
    expect(() =>
      validateWindowsBrokerProcessOutcome(
        { exitCode: 7, signal: null, stdout: "", stderr: "", errorMessage: null },
        { label: "canary run", expectedStdout: WINDOWS_CANARY_STDOUT },
      ),
    ).toThrow(/退出码不是 0/u);
    expect(() =>
      validateWindowsBrokerProcessOutcome(
        {
          exitCode: 0,
          signal: null,
          stdout: "wrong\n",
          stderr: "",
          errorMessage: null,
        },
        { label: "canary run", expectedStdout: WINDOWS_CANARY_STDOUT },
      ),
    ).toThrow(/stdout/u);
    expect(
      validateWindowsBrokerMetrics(
        { rssBytes: 65_536, processCount: 2 },
        { label: "canary run", maxRssBytes: 1_000_000, maxProcessCount: 4 },
      ),
    ).toEqual({ rssBytes: 65_536, processCount: 2 });
    expect(() =>
      validateWindowsBrokerMetrics(
        { rssBytes: 0, processCount: 1 },
        { label: "canary run", maxRssBytes: 1_000_000, maxProcessCount: 4 },
      ),
    ).toThrow(/有效 RSS/u);
    expect(() =>
      validateWindowsBrokerMetrics(
        { rssBytes: 65_536, processCount: 5 },
        { label: "canary run", maxRssBytes: 1_000_000, maxProcessCount: 4 },
      ),
    ).toThrow(/超过 broker/u);
  });

  it("requires the installed renderer to report a usable Windows runner", () => {
    const capabilities = windowsCapabilities();
    expect(() => validateWindowsInstalledCapabilities(capabilities)).not.toThrow();
    for (const invalid of [
      { ...capabilities, runnerEnabled: false },
      { ...capabilities, mode: "disabled" },
      { ...capabilities, isolationProbe: { ...capabilities.isolationProbe, kind: "none" } },
      { ...capabilities, memoryDiagnostics: { available: true } },
    ]) {
      expect(() => validateWindowsInstalledCapabilities(invalid)).toThrow();
    }
  });

  it("keeps NSIS silent install deterministic and verifies uninstall preservation", () => {
    expect(windowsInstallerArguments("C:\\Temp\\AlgoLatch Gate")).toEqual([
      "/S",
      "/currentuser",
      "/no-desktop-shortcut",
      "/D=C:\\Temp\\AlgoLatch Gate",
    ]);
    expect(windowsUninstallerArguments()).toEqual(["/S", "/KEEP_APP_DATA"]);
    expect(() =>
      validateUninstallOutcome({
        applicationExists: false,
        uninstallerExists: false,
        projectExists: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateUninstallOutcome({
        applicationExists: false,
        uninstallerExists: false,
        projectExists: false,
      }),
    ).toThrow(/删除了用户项目/u);
    expect(() =>
      validateUninstallOutcome({
        applicationExists: false,
        uninstallerExists: true,
        projectExists: true,
      }),
    ).toThrow(/uninstaller/u);
  });
});

function signatureSet() {
  return ["installer", "application", "uninstaller"].map((label) => ({
    label,
    status: "Valid",
    signerSubject: "CN=AlgoLatch Release",
    signerThumbprint: SIGNER_THUMBPRINT,
    timestampSubject: "CN=Timestamp Authority",
    timestampThumbprint: TIMESTAMP_THUMBPRINT,
  }));
}

function runtimeManifest() {
  return {
    schemaVersion: WINDOWS_TOOLCHAIN.schemaVersion,
    toolchainVersion: WINDOWS_TOOLCHAIN.toolchainVersion,
    llvmVersion: WINDOWS_TOOLCHAIN.llvmVersion,
    architecture: WINDOWS_TOOLCHAIN.architecture,
    target: WINDOWS_TOOLCHAIN.target,
    sourceUrl: WINDOWS_TOOLCHAIN.sourceUrl,
    sourceSha256: WINDOWS_TOOLCHAIN.sourceSha256,
    files: runtimeDigests(),
  };
}

function runtimeDigests() {
  return {
    "runtime/algolatch-job-host.exe": "a".repeat(64),
    "toolchain/bin/clang-22.exe": "e".repeat(64),
    "toolchain/bin/clang.exe": "b".repeat(64),
    "toolchain/bin/ld.lld.exe": "c".repeat(64),
    "toolchain/bin/libwinpthread-1.dll": "d".repeat(64),
    "toolchain/bin/mingw32-common.cfg": "f".repeat(64),
    "toolchain/bin/x86_64-w64-windows-gnu.cfg": "0".repeat(64),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function windowsCapabilities() {
  return {
    mode: "trusted-only",
    runnerEnabled: true,
    toolchainId: "verified:llvm-mingw",
    isolationProbe: {
      kind: "windows-job-object",
      status: "probe-succeeded",
      detail: "bounded",
    },
    memoryDiagnostics: { available: false, detail: "not available" },
    requiresNativeTrustConfirmation: true,
  };
}
