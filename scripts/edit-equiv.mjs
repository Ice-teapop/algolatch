import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(
  npmCommand,
  [
    "exec",
    "--",
    "vitest",
    "run",
    "--config",
    "vitest.edit-equiv.config.ts",
    "tests/core/edit-equiv.acceptance.ts",
    "--reporter=verbose",
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(`无法启动 M3 edit-equiv：${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (code === 0 && signal === null) {
    console.log("✓ M3 rename edit-equiv 全矩阵通过");
    return;
  }
  console.error(`✗ M3 edit-equiv 失败：code=${String(code)}, signal=${String(signal)}`);
  process.exitCode = 1;
});
