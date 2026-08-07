import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const flowCanvasStyle = readFileSync(
  new URL("../../src/styles/workbench/flow-canvas.css", import.meta.url),
  "utf8",
);
const workbenchStyle = readFileSync(
  new URL("../../src/styles/workbench/matlab-workbench.css", import.meta.url),
  "utf8",
);

describe("flow port visual contract", () => {
  it("keeps the visible socket compact without shrinking the semantic-monitor hit target", () => {
    expect(flowCanvasStyle).toMatch(/--flow-port-dot-size:\s*6px;/u);
    expect(flowCanvasStyle).toMatch(/width:\s*var\(--flow-port-dot-size\);/u);
    expect(flowCanvasStyle).toMatch(/height:\s*var\(--flow-port-dot-size\);/u);
    expect(workbenchStyle).toMatch(
      /\.semantic-monitor \.flow-node__port\s*\{[^}]*width:\s*var\(--interaction-target-compact\);[^}]*height:\s*var\(--interaction-target-compact\);/su,
    );
  });

  it("keeps inverse zoom compensation on the invisible port target", () => {
    expect(flowCanvasStyle).toMatch(
      /transform:\s*translateX\(-50%\) scale\(var\(--flow-port-screen-scale, 1\)\);/u,
    );
  });
});
