import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageUrl = new URL("../../package.json", import.meta.url);
const buildPngUrl = new URL("../../build/icon.png", import.meta.url);
const rendererPngUrl = new URL("../../public/app-icon.png", import.meta.url);
const icnsUrl = new URL("../../build/icon.icns", import.meta.url);

describe("application icon assets", () => {
  it("keeps the packaging and renderer PNGs identical, square, and RGBA", async () => {
    const [packagingIcon, rendererIcon] = await Promise.all([
      readFile(buildPngUrl),
      readFile(rendererPngUrl),
    ]);

    expect(rendererIcon.equals(packagingIcon)).toBe(true);
    expect(packagingIcon.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(packagingIcon.readUInt32BE(16)).toBe(1024);
    expect(packagingIcon.readUInt32BE(20)).toBe(1024);
    expect(packagingIcon[25]).toBe(6);
  });

  it("declares a structurally complete ICNS as the macOS packaging icon", async () => {
    const [packageText, icon] = await Promise.all([
      readFile(packageUrl, "utf8"),
      readFile(icnsUrl),
    ]);
    const manifest = JSON.parse(packageText) as {
      readonly build?: { readonly mac?: { readonly icon?: unknown } };
    };

    expect(manifest.build?.mac?.icon).toBe("build/icon.icns");
    expect(icon.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icon.readUInt32BE(4)).toBe(icon.byteLength);
  });
});
