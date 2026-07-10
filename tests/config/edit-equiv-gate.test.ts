import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const acceptancePath = "tests/core/edit-equiv.acceptance.ts";
const configPath = "vitest.edit-equiv.config.ts";
const vitestBin = resolve(projectRoot, "node_modules/vitest/vitest.mjs");

describe("edit-equiv acceptance isolation", () => {
  it("keeps the real runner out of default unit discovery and wires a fail-closed gate", () => {
    const defaultFiles = listVitestFiles([]);
    expect(defaultFiles).not.toContain(acceptancePath);

    const acceptanceFiles = listVitestFiles(["--config", configPath]);
    expect(acceptanceFiles).toEqual([acceptancePath]);

    const packageJson = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts?.["verify:edit-equiv"]).toBe("node scripts/edit-equiv.mjs");
    expect(packageJson.scripts?.["test:unit"]).toBe("vitest run");
    expect(packageJson.scripts?.test).toContain("npm run test:unit");
    expect(packageJson.scripts?.test).not.toContain("edit-equiv");

    const launcher = readFileSync(resolve(projectRoot, "scripts/edit-equiv.mjs"), "utf8");
    expect(launcher).toContain(`"${configPath}"`);
    expect(launcher).toContain(`"${acceptancePath}"`);
    expect(launcher).not.toContain("--passWithNoTests");
  });
});

function listVitestFiles(extraArgs: readonly string[]): readonly string[] {
  const result = spawnSync(
    process.execPath,
    [vitestBin, "list", ...extraArgs, "--filesOnly", "--no-color"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
      shell: false,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `vitest list failed: status=${String(result.status)} signal=${String(result.signal)} stderr=${result.stderr}`,
    );
  }
  return Object.freeze(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
