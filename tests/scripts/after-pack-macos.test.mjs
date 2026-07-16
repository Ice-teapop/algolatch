import { describe, expect, it } from "vitest";
import removeMacosSigningDetritus, {
  resolvePackagedAppPath,
} from "../../scripts/after-pack-macos.mjs";

describe("macOS afterPack signing preparation", () => {
  it("targets only the generated AlgoLatch app bundle", () => {
    expect(
      resolvePackagedAppPath({
        appOutDir: "/tmp/algolatch-build/mac-universal",
        packager: { appInfo: { productFilename: "AlgoLatch" } },
      }),
    ).toBe("/tmp/algolatch-build/mac-universal/AlgoLatch.app");
    expect(() =>
      resolvePackagedAppPath({
        appOutDir: "/tmp/algolatch-build/mac-universal",
        packager: { appInfo: { productFilename: "Other" } },
      }),
    ).toThrow(/AlgoLatch/u);
    expect(() =>
      resolvePackagedAppPath({
        appOutDir: "relative-output",
        packager: { appInfo: { productFilename: "AlgoLatch" } },
      }),
    ).toThrow(/绝对/u);
  });

  it("does nothing for non-macOS packaging", async () => {
    await expect(
      removeMacosSigningDetritus({ electronPlatformName: "win32" }),
    ).resolves.toBeUndefined();
  });
});
