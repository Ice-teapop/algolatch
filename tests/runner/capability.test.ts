import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  COMPILE_EXECUTION_PROFILE,
  DEFAULT_DEVELOPER_ROOT,
  LEAKS_EXECUTION_PROFILE,
  RUN_EXECUTION_PROFILE,
  SANITIZER_RUN_PROFILE,
  SEATBELT_CANARY_SENTINEL,
  SystemCapabilityProbe,
  SystemSeatbeltCanary,
  classifyClangVersion,
  detectSupportedWindowsToolchain,
  parseRunnerMode,
  resolveCanonicalDeveloperRoots,
  toolchainIdentifier,
  type CanaryCommandExecutor,
  type CanaryCommandResult,
  type SeatbeltCanary,
  type ToolchainDetector,
} from "../../electron/main/runner/capability.js";

const AVAILABLE_TOOLCHAIN = Object.freeze({
  available: true,
  detail: "Apple clang version 21.0.0",
});
const UNAVAILABLE_TOOLCHAIN = Object.freeze({
  available: false,
  detail: "工具链不可用/未验证",
});

describe("Apple clang capability", () => {
  it("accepts the bounded Apple clang 17.x–21.x compatibility range", () => {
    expect(classifyClangVersion("Apple clang version 17.0.0\nTarget: arm64")).toEqual({
      available: true,
      detail: "Apple clang version 17.0.0",
    });
    expect(classifyClangVersion("Apple clang version 21.0.0\nTarget: arm64")).toEqual({
      available: true,
      detail: "Apple clang version 21.0.0",
    });
    expect(classifyClangVersion("Apple clang version 16.1.0")).toMatchObject({
      available: false,
    });
    expect(classifyClangVersion("Apple clang version 22.0.0")).toMatchObject({
      available: false,
    });
    expect(classifyClangVersion("clang version 21.0.0")).toMatchObject({
      available: false,
    });
    expect(classifyClangVersion("")).toMatchObject({ available: false });
  });

  it("forces executable runner modes to disabled when clang is unavailable", () => {
    const unavailable = vi.fn<ToolchainDetector>(() => UNAVAILABLE_TOOLCHAIN);

    expect(parseRunnerMode(undefined, unavailable)).toBe("disabled");
    expect(parseRunnerMode("seatbelt-best-effort", unavailable)).toBe("disabled");
    expect(parseRunnerMode("trusted-only", unavailable)).toBe("disabled");
    expect(unavailable).toHaveBeenCalledTimes(3);
  });

  it("preserves valid requested modes with a verified toolchain", () => {
    const available: ToolchainDetector = () => AVAILABLE_TOOLCHAIN;

    expect(parseRunnerMode(undefined, available)).toBe("seatbelt-best-effort");
    expect(parseRunnerMode("seatbelt-best-effort", available)).toBe("seatbelt-best-effort");
    expect(parseRunnerMode("trusted-only", available)).toBe("trusted-only");
  });

  it("forces verified Windows execution into trusted-only mode", () => {
    const available: ToolchainDetector = () => ({
      available: true,
      platform: "win32",
      detail: "llvm-mingw 20260616",
    });

    expect(parseRunnerMode(undefined, available, "win32")).toBe("trusted-only");
    expect(parseRunnerMode("seatbelt-best-effort", available, "win32")).toBe("trusted-only");
    expect(parseRunnerMode("trusted-only", available, "win32")).toBe("trusted-only");
    expect(parseRunnerMode("disabled", available, "win32")).toBe("disabled");
  });

  it("publishes a stable toolchain key without leaking absolute paths", () => {
    const id = toolchainIdentifier(
      {
        available: true,
        detail:
          "Apple clang version 21.0.0；工具链 /Applications/Xcode.app/Contents/Developer/usr/bin/clang",
      },
      "trusted-only",
    );

    expect(id).toContain("verified:Apple clang version 21.0.0");
    expect(id).toContain("[verified-path]");
    expect(id).not.toContain("/Applications/");
    expect(toolchainIdentifier(UNAVAILABLE_TOOLCHAIN, "disabled")).toBe(
      "disabled:工具链不可用/未验证",
    );
  });

  it("does not probe tools for explicit or malformed disabled modes", () => {
    const detector = vi.fn<ToolchainDetector>(() => AVAILABLE_TOOLCHAIN);

    expect(parseRunnerMode("disabled", detector)).toBe("disabled");
    expect(parseRunnerMode("unexpected", detector)).toBe("disabled");
    expect(detector).not.toHaveBeenCalled();
  });

  it("trusts the canonical target of an active Xcode.app symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "c-block-xcode-root-"));
    try {
      const versionedApp = join(root, "Xcode_16.4.app");
      const developerRoot = join(versionedApp, "Contents", "Developer");
      mkdirSync(developerRoot, { recursive: true });
      const activeApp = join(root, "Xcode.app");
      symlinkSync(versionedApp, activeApp);

      expect(resolveCanonicalDeveloperRoots([join(activeApp, "Contents", "Developer")])).toEqual([
        realpathSync(developerRoot),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bundled Windows toolchain capability", () => {
  it("accepts only the locked manifest and rejects changed critical files", () => {
    const root = mkdtempSync(join(tmpdir(), "algolatch-windows-runtime-"));
    const clang = join(root, "toolchain", "bin", "clang.exe");
    const clangBinary = join(root, "toolchain", "bin", "clang-22.exe");
    const linker = join(root, "toolchain", "bin", "ld.lld.exe");
    const commonConfig = join(root, "toolchain", "bin", "mingw32-common.cfg");
    const targetConfig = join(root, "toolchain", "bin", "x86_64-w64-windows-gnu.cfg");
    const runtimeDll = join(root, "toolchain", "bin", "libwinpthread-1.dll");
    const jobHost = join(root, "runtime", "algolatch-job-host.exe");
    try {
      mkdirSync(join(root, "toolchain", "bin"), { recursive: true });
      mkdirSync(join(root, "runtime"), { recursive: true });
      writeFileSync(
        clang,
        "#!/bin/sh\nprintf 'clang version 22.1.8\\nTarget: x86_64-w64-windows-gnu\\n'\n",
      );
      chmodSync(clang, 0o700);
      writeFileSync(clangBinary, "locked-clang-binary");
      writeFileSync(linker, "locked-linker");
      writeFileSync(commonConfig, "locked-common-config");
      writeFileSync(targetConfig, "locked-target-config");
      writeFileSync(runtimeDll, "locked-runtime-dll");
      writeFileSync(jobHost, "job-host-test-double");
      writeFileSync(
        join(root, "toolchain-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          toolchainVersion: "20260616",
          llvmVersion: "22.1.8",
          architecture: "x64",
          target: "x86_64-w64-windows-gnu",
          sourceUrl:
            "https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip",
          sourceSha256: "b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35",
          files: {
            "runtime/algolatch-job-host.exe": sha256(jobHost),
            "toolchain/bin/clang-22.exe": sha256(clangBinary),
            "toolchain/bin/clang.exe": sha256(clang),
            "toolchain/bin/ld.lld.exe": sha256(linker),
            "toolchain/bin/libwinpthread-1.dll": sha256(runtimeDll),
            "toolchain/bin/mingw32-common.cfg": sha256(commonConfig),
            "toolchain/bin/x86_64-w64-windows-gnu.cfg": sha256(targetConfig),
          },
        }),
      );

      expect(detectSupportedWindowsToolchain(root, "x64")).toMatchObject({
        available: true,
        platform: "win32",
        targetTriple: "x86_64-w64-windows-gnu",
      });
      writeFileSync(runtimeDll, "tampered");
      expect(detectSupportedWindowsToolchain(root, "x64")).toMatchObject({
        available: false,
        detail: expect.stringContaining("摘要不匹配"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Seatbelt capability canary", () => {
  it("compiles a fixed C canary before running it under the narrower profile", async () => {
    const execute = vi
      .fn<CanaryCommandExecutor>()
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: SEATBELT_CANARY_SENTINEL }));
    const canary = new SystemSeatbeltCanary({ execute });

    await expect(canary.run()).resolves.toMatchObject({ succeeded: true });
    expect(execute).toHaveBeenCalledTimes(2);

    const compile = execute.mock.calls[0]?.[0];
    const run = execute.mock.calls[1]?.[0];
    expect(compile).toMatchObject({
      command: "/usr/bin/sandbox-exec",
      timeoutMs: 10_000,
    });
    expect(compile?.args).toContain(COMPILE_EXECUTION_PROFILE);
    expect(compile?.args).toContain(`DEVROOT=${DEFAULT_DEVELOPER_ROOT}`);
    expect(compile?.args).toContain("/usr/bin/clang");
    expect(compile?.args).toContain("seatbelt-canary.c");
    expect(run).toMatchObject({
      command: "/usr/bin/sandbox-exec",
      timeoutMs: 10_000,
    });
    expect(run?.args).toContain(RUN_EXECUTION_PROFILE);
    expect(run?.args.some((argument) => argument.endsWith("/seatbelt-canary"))).toBe(true);
  });

  it("does not run a binary when the sandboxed compile canary fails", async () => {
    const execute = vi
      .fn<CanaryCommandExecutor>()
      .mockResolvedValue(commandResult({ ok: false, reason: "compile denied" }));
    const canary = new SystemSeatbeltCanary({ execute });

    await expect(canary.run()).resolves.toMatchObject({
      succeeded: false,
      detail: expect.stringContaining("compile canary"),
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a successful process exit without the exact C sentinel", async () => {
    const execute = vi
      .fn<CanaryCommandExecutor>()
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: "wrong\n" }));
    const canary = new SystemSeatbeltCanary({ execute });

    await expect(canary.run()).resolves.toMatchObject({
      succeeded: false,
      detail: expect.stringContaining("sentinel"),
    });
  });

  it("does not run the canary when the clang toolchain is unverified", async () => {
    const canary = fakeCanary(true);
    const probe = new SystemCapabilityProbe({
      detectToolchain: () => UNAVAILABLE_TOOLCHAIN,
      canary,
    });

    await expect(probe.probe()).resolves.toEqual({
      status: "unavailable",
      detail: "工具链不可用/未验证",
    });
    expect(canary.run).not.toHaveBeenCalled();
  });

  it("reports success only after the confinement canary succeeds", async () => {
    const canary = fakeCanary(true);
    const probe = new SystemCapabilityProbe({
      detectToolchain: () => AVAILABLE_TOOLCHAIN,
      canary,
    });

    await expect(probe.probe()).resolves.toEqual({
      status: "probe-succeeded",
      detail: "canary passed",
    });
    expect(canary.run).toHaveBeenCalledOnce();
  });

  it("fails closed when the canary fails or throws", async () => {
    const failed = new SystemCapabilityProbe({
      detectToolchain: () => AVAILABLE_TOOLCHAIN,
      canary: fakeCanary(false),
    });
    const crashed = new SystemCapabilityProbe({
      detectToolchain: () => AVAILABLE_TOOLCHAIN,
      canary: { run: vi.fn(async () => Promise.reject(new Error("boom"))) },
    });

    await expect(failed.probe()).resolves.toEqual({
      status: "unavailable",
      detail: "canary failed",
    });
    await expect(crashed.probe()).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});

describe("split execution profiles", () => {
  it("explicitly denies network access in every execution profile", () => {
    expect(COMPILE_EXECUTION_PROFILE).toContain("(deny network*)");
    expect(RUN_EXECUTION_PROFILE).toContain("(deny network*)");
    expect(SANITIZER_RUN_PROFILE).toContain("(deny network*)");
    expect(LEAKS_EXECUTION_PROFILE).toContain("(deny network*)");
  });

  it("adds the detected Apple clang runtime only to the sanitizer run profile", () => {
    const runtimeDirectory =
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/21/lib/darwin";

    expect(RUN_EXECUTION_PROFILE).not.toContain(runtimeDirectory);
    expect(SANITIZER_RUN_PROFILE).toContain(
      '(allow file-read* file-test-existence (subpath (param "SANITIZER_RUNTIME")))',
    );
    expect(SANITIZER_RUN_PROFILE).toContain(
      '(allow file-map-executable (subpath (param "SANITIZER_RUNTIME")))',
    );
    expect(SANITIZER_RUN_PROFILE).not.toContain(runtimeDirectory);
    expect(SANITIZER_RUN_PROFILE).toContain("(deny process-fork)");
    expect(SANITIZER_RUN_PROFILE).not.toContain("(allow process*)");
  });

  it("gives leaks only its required fixed launcher chain", () => {
    expect(LEAKS_EXECUTION_PROFILE).toContain("(allow process-fork)");
    expect(LEAKS_EXECUTION_PROFILE).toContain("(allow mach-priv-task-port (target same-sandbox))");
    expect(LEAKS_EXECUTION_PROFILE).toContain('(allow process-exec (literal "/usr/bin/leaks"))');
    expect(LEAKS_EXECUTION_PROFILE).toContain('(allow process-exec (literal "/bin/bash"))');
    expect(LEAKS_EXECUTION_PROFILE).toContain('(allow process-exec (subpath (param "WORKDIR")))');
    expect(LEAKS_EXECUTION_PROFILE).not.toContain("(allow process*)");
    expect(LEAKS_EXECUTION_PROFILE).not.toContain("com.apple.coresymbolicationd");
    expect(LEAKS_EXECUTION_PROFILE).not.toContain("sysctl");
    expect(LEAKS_EXECUTION_PROFILE).not.toContain("/var/select");
  });

  it("keeps compiler subprocess permission out of the runtime profile", () => {
    expect(COMPILE_EXECUTION_PROFILE).toContain("(allow process*)");
    expect(RUN_EXECUTION_PROFILE).not.toContain("(allow process*)");
    expect(RUN_EXECUTION_PROFILE).toContain("(deny process-fork)");
    expect(RUN_EXECUTION_PROFILE).toContain('(allow process-exec (subpath (param "WORKDIR")))');
  });

  it("allows only metadata traversal above trusted Developer roots", () => {
    const compileAncestorMetadataRule =
      '(allow file-read-metadata file-test-existence (subpath "/Applications") (literal "/Library"))';
    const sanitizerAncestorMetadataRule =
      '(allow file-read-metadata file-test-existence (literal "/Applications") (literal "/Applications/Xcode.app") (literal "/Applications/Xcode.app/Contents") (literal "/Library"))';

    expect(COMPILE_EXECUTION_PROFILE).toContain(compileAncestorMetadataRule);
    expect(COMPILE_EXECUTION_PROFILE).toContain(
      '(allow file-read-metadata file-test-existence (subpath (param "TEMPROOT")))',
    );
    expect(COMPILE_EXECUTION_PROFILE).toContain(
      '(allow file-read* file-test-existence (subpath (param "DEVROOT")))',
    );
    expect(COMPILE_EXECUTION_PROFILE).toContain(
      '(allow file-map-executable (subpath (param "DEVROOT")))',
    );
    expect(SANITIZER_RUN_PROFILE).toContain(sanitizerAncestorMetadataRule);
    expect(RUN_EXECUTION_PROFILE).not.toContain(compileAncestorMetadataRule);
    expect(compileAncestorMetadataRule).not.toContain("file-read-data");
  });

  it("explicitly rejects compile and runtime reads/mappings under usr/local", () => {
    expect(COMPILE_EXECUTION_PROFILE).toContain(
      '(deny file-read* file-test-existence (subpath "/usr/local"))',
    );
    expect(COMPILE_EXECUTION_PROFILE).toContain(
      '(deny file-map-executable (subpath "/usr/local"))',
    );
    expect(RUN_EXECUTION_PROFILE).toContain(
      '(deny file-read* file-test-existence (subpath "/usr/local"))',
    );
    expect(RUN_EXECUTION_PROFILE).toContain('(deny file-map-executable (subpath "/usr/local"))');
  });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandResult(
  overrides: {
    readonly ok?: boolean;
    readonly reason?: string;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
): CanaryCommandResult {
  return Object.freeze({
    ok: overrides.ok ?? true,
    reason: overrides.reason ?? "ok",
    stdout: Uint8Array.from(Buffer.from(overrides.stdout ?? "", "utf8")),
    stderr: Uint8Array.from(Buffer.from(overrides.stderr ?? "", "utf8")),
  });
}

function fakeCanary(succeeded: boolean): SeatbeltCanary & {
  readonly run: ReturnType<typeof vi.fn<SeatbeltCanary["run"]>>;
} {
  return {
    run: vi.fn(async () => ({
      succeeded,
      detail: succeeded ? "canary passed" : "canary failed",
    })),
  };
}
