import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const formalUrl = new URL("../../build/electron-builder.windows.release.json", import.meta.url);
const betaUrl = new URL("../../build/electron-builder.windows.beta.json", import.meta.url);

describe("Windows packaging contracts", () => {
  it("keeps formal and explicit unsigned Preview channels separate", async () => {
    const [formal, beta] = await Promise.all([readConfig(formalUrl), readConfig(betaUrl)]);

    expect(formal).toMatchObject({
      appId: "io.han.c-block-algorithm-panel",
      productName: "AlgoLatch",
      directories: { output: "release-windows" },
      win: {
        requestedExecutionLevel: "asInvoker",
        forceCodeSigning: true,
        signExecutable: true,
        artifactName: "AlgoLatch-Setup-${version}-${arch}.${ext}",
      },
      nsis: {
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        packElevateHelper: false,
        deleteAppDataOnUninstall: false,
      },
    });
    expect(beta).toMatchObject({
      directories: { output: "release-windows-beta" },
      win: {
        forceCodeSigning: false,
        signExecutable: false,
        artifactName: "AlgoLatch-Setup-${version}-unsigned-${arch}.${ext}",
      },
    });
    expect(formal.win.signExts).toEqual([
      "!clang.exe",
      "!clang-22.exe",
      "!ld.lld.exe",
      "!algolatch-job-host.exe",
    ]);
    expect(formal.electronDownload).toEqual(beta.electronDownload);
  });

  it("packages the locked compiler, Job Object host and manifest together", async () => {
    const [formal, beta] = await Promise.all([readConfig(formalUrl), readConfig(betaUrl)]);
    const expected = [
      {
        from: "build/windows/x64",
        to: "windows-runtime",
        filter: ["toolchain/**/*", "runtime/**/*", "toolchain-manifest.json"],
      },
    ];
    expect(formal.extraResources).toEqual(expected);
    expect(beta.extraResources).toEqual(expected);
    expect(formal.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(beta.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });
});

async function readConfig(url: URL): Promise<Record<string, any>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, any>;
}
