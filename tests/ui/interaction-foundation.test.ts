import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStyleManifestSource } from "../test-support/style-manifest.js";

const style = readStyleManifestSource(new URL("../../src/style.css", import.meta.url));
const menu = readFileSync(new URL("../../src/ui/workbench-menu.ts", import.meta.url), "utf8");

describe("interaction foundation", () => {
  it("centralizes target, state, duration and easing tokens", () => {
    expect(style).toContain("--text-caption: 11px");
    expect(style).toContain("--text-control: 12px");
    expect(style).toContain("--interaction-target-compact: 32px");
    expect(style).toContain("--interaction-hover-background:");
    expect(style).toContain("--interaction-pressed-background:");
    expect(style).toContain("--motion-feedback: 120ms");
    expect(style).toContain("--motion-surface: 220ms");
    expect(style).toContain("--ease-out-quart:");
    expect(style).not.toContain("transform: scale(0.98)");
    expect(style).toContain("@media (forced-colors: active)");
  });

  it("keeps motion spatially restrained and honors reduced motion", () => {
    const foundation = style.slice(style.indexOf("/* Interaction foundation"));
    expect(foundation).toContain("@media (prefers-reduced-motion: reduce)");
    expect(foundation).toContain("transform: none !important");
    expect(foundation).not.toMatch(/transition:\s*(?:width|height|padding|margin)/u);
  });

  it("keeps high-frequency Dock and page switches instant", () => {
    expect(menu).toContain('menu.popup.dataset.state = "open"');
    expect(menu).toContain('menu.popup.dataset.state = "closed"');
    expect(menu).not.toContain('menu.popup.dataset.state = "opening"');
    expect(menu).not.toContain('menu.popup.dataset.state = "closing"');
    expect(style).toMatch(
      /\[role="tabpanel"\],[\s\S]*?\.workbench-page\s*\{[\s\S]*?transition:\s*none/u,
    );
    expect(style).toMatch(/\.quick-open\s*\{[\s\S]*?transition:\s*none/u);
  });

  it("keeps lesson and transcript surfaces on theme and background tokens", () => {
    const lessonStart = style.indexOf("/* === v6 guided lesson rail");
    const lessonEnd = style.indexOf(".quick-open", lessonStart);
    const lesson = style.slice(lessonStart, lessonEnd);
    const transcript = style.slice(
      style.indexOf(".mentor-panel__transcript"),
      style.indexOf(".mentor-panel__chat-empty"),
    );

    expect(lesson).toContain("background: var(--surface)");
    expect(lesson).toContain("color: var(--ink)");
    expect(lesson).toContain("outline: 2px solid var(--focus)");
    expect(lesson).not.toMatch(/#[fF]{3,6}\b/u);
    expect(transcript).toContain("background: var(--surface)");
    expect(transcript).not.toMatch(/background:\s*#(?:fff|ffffff)\b/iu);
  });
});
