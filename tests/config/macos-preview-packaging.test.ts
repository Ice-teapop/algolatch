import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface MacBuilderConfiguration {
  readonly afterPack?: unknown;
  readonly mac?: {
    readonly identity?: unknown;
    readonly extendInfo?: Readonly<Record<string, unknown>>;
  };
}

describe("macOS Documents access packaging", () => {
  it("ad-hoc signs the Preview bundle instead of shipping an identity-less app", async () => {
    const preview = await readBuilderConfiguration("build/electron-builder.beta.json");

    expect(preview.mac?.identity).toBe("-");
  });

  it.each(["build/electron-builder.beta.json", "build/electron-builder.release.json"])(
    "declares why %s needs Documents access",
    async (path) => {
      const configuration = await readBuilderConfiguration(path);

      expect(configuration.afterPack).toBe("scripts/after-pack-macos.mjs");
      expect(configuration.mac?.extendInfo?.NSDocumentsFolderUsageDescription).toBe(
        "AlgoLatch stores the local projects you create in its dedicated Documents workspace.",
      );
    },
  );

  it.each(["build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist"])(
    "keeps %s compatible with the codesign entitlement parser",
    async (path) => {
      const source = await readFile(path, "utf8");

      expect(source).toContain("<true/>");
      expect(source).not.toContain("<true />");
    },
  );
});

async function readBuilderConfiguration(path: string): Promise<MacBuilderConfiguration> {
  return JSON.parse(await readFile(path, "utf8")) as MacBuilderConfiguration;
}
