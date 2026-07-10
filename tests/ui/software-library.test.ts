import { describe, expect, it } from "vitest";
import { SOFTWARE_FEATURES } from "../../src/ui/software-library.js";

describe("software Library catalog", () => {
  it("covers the mainstream product surfaces without duplicate ids", () => {
    expect(new Set(SOFTWARE_FEATURES.map(({ id }) => id)).size).toBe(SOFTWARE_FEATURES.length);
    expect(SOFTWARE_FEATURES.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "dashboard",
        "projects",
        "sandboxes",
        "tests",
        "presets",
        "assembly",
        "source",
        "explanation",
        "editing",
        "run",
        "block-library",
        "storage",
        "extensions",
      ]),
    );
  });

  it("documents current capability, limits and concrete extension points for every feature", () => {
    for (const feature of SOFTWARE_FEATURES) {
      expect(feature.pageId.length, feature.id).toBeGreaterThan(0);
      expect(feature.targetId.length, feature.id).toBeGreaterThan(0);
      expect(feature.purpose.length, feature.id).toBeGreaterThan(10);
      expect(feature.currentCapability.length, feature.id).toBeGreaterThan(10);
      expect(feature.limitation.length, feature.id).toBeGreaterThan(6);
      expect(feature.extensionPoints.length, feature.id).toBeGreaterThan(0);
    }
  });

  it("routes every feature to an existing product surface target", () => {
    const existingRoutes = new Set([
      "dashboard:dashboard",
      "dashboard:project",
      "dashboard:sandbox",
      "dashboard:test",
      "build:preset-blocks",
      "build:assembly-canvas",
      "build:code-pane",
      "explanation:explanation",
      "edit:edit",
      "run:run",
      "block-library:block-library-create",
      "build:local-save",
      "software-library:software-library",
    ]);

    for (const feature of SOFTWARE_FEATURES) {
      expect(existingRoutes.has(`${feature.pageId}:${feature.targetId}`), feature.id).toBe(true);
    }
  });
});
