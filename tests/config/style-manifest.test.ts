import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStyleManifestEntries } from "../test-support/style-manifest.js";

const manifestUrl = new URL("../../src/style.css", import.meta.url);
const expectedOrder = Object.freeze([
  "./styles/core/foundation.css",
  "./styles/core/shell-controls.css",
  "./styles/workbench/projection-code.css",
  "./styles/workbench/inspector-editing.css",
  "./styles/workbench/runtime-feedback.css",
  "./styles/workbench/navigation-palette-dashboard.css",
  "./styles/tutorials/module-shell.css",
  "./styles/tutorials/block-stage.css",
  "./styles/dashboard/dashboard.css",
  "./styles/library/library.css",
  "./styles/tutorials/task-lesson-legacy.css",
  "./styles/tutorials/task-lesson-v2.css",
  "./styles/tutorials/semantic-stage-base.css",
  "./styles/tutorials/semantic-stage-refinements.css",
  "./styles/library/block-library-manager.css",
  "./styles/workbench/build-shell.css",
  "./styles/workbench/flow-canvas.css",
  "./styles/workbench/flow-detail-layout.css",
  "./styles/workbench/matlab-workbench.css",
  "./styles/workbench/c-command.css",
  "./styles/runtime/scenarios-mentor.css",
  "./styles/runtime/settings-density.css",
  "./styles/analysis/analysis-dashboard.css",
  "./styles/ai/provider-mentor.css",
  "./styles/tutorials/guided-lesson.css",
  "./styles/workbench/quick-open-interactions.css",
  "./styles/tutorials/final-overrides.css",
  "./styles/tutorials/flow-semantic-scenes.css",
  "./styles/tutorials/runtime-scenes.css",
  "./styles/tutorials/signature-contract.css",
  "./styles/tutorials/responsive-input.css",
  "./styles/tutorials/flow-frame.css",
  "./styles/tutorials/specialized-lessons.css",
  "./styles/workbench/semantic-projection-progressive.css",
]);

describe("renderer style manifest", () => {
  it("keeps every stylesheet in the explicit cascade order", () => {
    const entries = readStyleManifestEntries(manifestUrl);
    expect(entries.map((entry) => entry.specifier)).toEqual(expectedOrder);
    expect(new Set(entries.map((entry) => entry.specifier)).size).toBe(entries.length);
  });

  it("keeps each physical stylesheet within the maintainability budget", () => {
    for (const entry of readStyleManifestEntries(manifestUrl)) {
      const lines = entry.source.trimEnd().split(/\r?\n/u).length;
      expect(lines, entry.specifier).toBeGreaterThan(0);
      expect(lines, entry.specifier).toBeLessThanOrEqual(900);
    }
  });

  it("loads feature-specific overrides after the shared manifest", () => {
    const mainHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const aiHtml = readFileSync(new URL("../../ai-window.html", import.meta.url), "utf8");

    expect(mainHtml.indexOf("/src/style.css")).toBeLessThan(
      mainHtml.indexOf("/src/ui/foa-transition-prototype-stage.css"),
    );
    expect(aiHtml.indexOf("/src/style.css")).toBeLessThan(
      aiHtml.indexOf("/src/ui/ai-workspace-window.css"),
    );
  });
});
