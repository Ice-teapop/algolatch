import { describe, expect, it } from "vitest";
import {
  assertReleaseGateOrder,
  mountDmgArguments,
  requireMacPlatform,
  selectSingleArtifact,
  validateAsarEntries,
  validateAdHocSignatureDetails,
  validateBundleMetadata,
  validateBundleExecutableName,
  validateDeveloperIdSignatureDetails,
  validateGatekeeperAssessment,
  validateInstalledWorkbenchSnapshot,
  validateProductBundleName,
  validateReleaseEntitlements,
  validateUniversalArchitectures,
} from "../../scripts/lib/installed-dmg-gate.mjs";

describe("installed DMG release gate", () => {
  it("fails closed outside macOS and for ambiguous artifacts", () => {
    expect(() => requireMacPlatform("linux")).toThrow(/只允许在 macOS/u);
    expect(() =>
      selectSingleArtifact(
        [
          { name: "one.dmg", kind: "file" },
          { name: "two.dmg", kind: "file" },
        ],
        ".dmg",
        "file",
        "DMG",
      ),
    ).toThrow(/恰好存在一个/u);
    expect(() =>
      selectSingleArtifact([{ name: "one.dmg", kind: "other" }], ".dmg", "file", "DMG"),
    ).toThrow(/普通文件/u);
  });

  it("constructs an explicitly read-only, non-browsing mount", () => {
    expect(mountDmgArguments("/release/app.dmg", "/tmp/mount")).toEqual([
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      "/tmp/mount",
      "/release/app.dmg",
    ]);
  });

  it("requires the renamed product bundle and a notarized Developer ID assessment", () => {
    expect(() => validateProductBundleName("AlgoLatch.app")).not.toThrow();
    expect(() => validateProductBundleName("C 积木算法面板.app")).toThrow(/AlgoLatch\.app/u);
    expect(() =>
      validateDeveloperIdSignatureDetails(
        "Authority=Developer ID Application: HAN Chen (TEAMID1234)\nTeamIdentifier=TEAMID1234\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=3+7 location=embedded",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeveloperIdSignatureDetails("Signature=adhoc\nTeamIdentifier=not set"),
    ).toThrow(/Developer ID Application/u);
    expect(() => validateGatekeeperAssessment("source=Notarized Developer ID")).not.toThrow();
    expect(() => validateGatekeeperAssessment("source=Unnotarized Developer ID")).toThrow(
      /Notarized Developer ID/u,
    );
    const minimalEntitlements = `<?xml version="1.0"?><plist><dict>
      <key>com.apple.security.cs.allow-jit</key><true/>
    </dict></plist>`;
    expect(() => validateReleaseEntitlements(minimalEntitlements, "主应用")).not.toThrow();
    expect(() =>
      validateReleaseEntitlements(
        `${minimalEntitlements}<key>com.apple.security.get-task-allow</key><true/>`,
        "主应用",
      ),
    ).toThrow(/最小集合/u);
  });

  it("requires Preview bundles to be coherently ad-hoc signed under the app identity", () => {
    expect(() =>
      validateAdHocSignatureDetails(
        "Identifier=io.han.c-block-algorithm-panel\nSignature=adhoc\nTeamIdentifier=not set\nInternal requirements count=1 size=68",
      ),
    ).not.toThrow();
    expect(() =>
      validateAdHocSignatureDetails(
        "Identifier=Electron\nSignature=adhoc\nTeamIdentifier=not set\nInternal requirements=none",
      ),
    ).toThrow(/Identifier/u);
    expect(() =>
      validateAdHocSignatureDetails(
        "Identifier=io.han.c-block-algorithm-panel\nTeamIdentifier=not set",
      ),
    ).toThrow(/ad-hoc/u);
  });

  it("rejects unsafe bundle executable names", () => {
    expect(validateBundleExecutableName("算法工作台")).toBe("算法工作台");
    expect(() => validateBundleExecutableName("../escape")).toThrow(/安全/u);
    expect(() => validateBundleExecutableName("part/name")).toThrow(/安全/u);
  });

  it("locks the renamed bundle metadata while preserving the existing app identity", () => {
    expect(() =>
      validateBundleMetadata(
        {
          identifier: "io.han.c-block-algorithm-panel",
          name: "AlgoLatch",
          executable: "AlgoLatch",
          version: "0.0.2",
        },
        "0.0.2",
      ),
    ).not.toThrow();
    expect(() =>
      validateBundleMetadata(
        {
          identifier: "io.han.algolatch",
          name: "AlgoLatch",
          executable: "AlgoLatch",
          version: "0.0.2",
        },
        "0.0.2",
      ),
    ).toThrow(/CFBundleIdentifier/u);
  });

  it("accepts only the installed workbench contract", () => {
    expect(() =>
      validateInstalledWorkbenchSnapshot({
        appIsPackaged: true,
        protocol: "file:",
        startupHidden: true,
        dashboardVisible: true,
        dockLabels: ["设置", "积木", "Library", "布局"],
        parserState: "ready",
        analysisState: "complete",
        flowNodeCount: 5,
      }),
    ).not.toThrow();
    expect(() =>
      validateInstalledWorkbenchSnapshot({
        appIsPackaged: false,
        protocol: "http:",
        startupHidden: false,
        dashboardVisible: false,
        dockLabels: ["设置", "Library"],
        parserState: "error",
        analysisState: "worker-error",
        flowNodeCount: 0,
      }),
    ).toThrow(/file:.*进度层.*Dashboard.*parser.*Dock/u);
  });

  it("requires a Universal binary and every packaged runtime asset", () => {
    expect(() => validateUniversalArchitectures("x86_64 arm64\n")).not.toThrow();
    expect(() => validateUniversalArchitectures("arm64\n")).toThrow(/不是 Universal/u);
    expect(() =>
      validateAsarEntries(
        [
          "/dist/index.html",
          "/dist/ai-window.html",
          "/dist/assets/tree-sitter-c-a.wasm",
          "/dist/assets/web-tree-sitter-b.wasm",
          "/dist/assets/program-analysis-worker-c.js",
          "/dist-electron/preload/index.cjs",
          "/dist-electron/preload/ai-window.cjs",
          "/dist-electron/electron/main/index.js",
        ].join("\n"),
      ),
    ).not.toThrow();
    expect(() => validateAsarEntries("/dist/index.html\n")).toThrow(/缺少发布资源/u);
    expect(() =>
      validateAsarEntries(
        [
          "\\dist\\index.html",
          "\\dist\\ai-window.html",
          "\\dist\\assets\\tree-sitter-c-a.wasm",
          "\\dist\\assets\\web-tree-sitter-b.wasm",
          "\\dist\\assets\\program-analysis-worker-c.js",
          "\\dist-electron\\preload\\index.cjs",
          "\\dist-electron\\preload\\ai-window.cjs",
          "\\dist-electron\\electron\\main\\index.js",
        ].join("\r\n"),
      ),
    ).not.toThrow();
  });

  it("requires build, installed check, checksum and publication in that order", () => {
    expect(() =>
      assertReleaseGateOrder(`
run: npm run dist:mac
run: npm run verify:installed-dmg
shasum -a 256
- name: Upload verified build artifact
uses: actions/upload-artifact@v4
gh release create
`),
    ).not.toThrow();
    expect(() =>
      assertReleaseGateOrder(`
run: npm run verify:installed-dmg
run: npm run dist:mac
shasum -a 256
- name: Upload verified build artifact
uses: actions/upload-artifact@v4
gh release create
`),
    ).toThrow(/顺序不安全/u);
  });
});
