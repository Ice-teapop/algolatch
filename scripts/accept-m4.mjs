import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const stages = Object.freeze([
  Object.freeze({
    label: "M3 全量回归",
    command: npmCommand,
    args: Object.freeze(["run", "accept:m3"]),
  }),
  Object.freeze({
    label: "M4 固定语料、回归与生成式性质门禁",
    command: npmCommand,
    args: Object.freeze(["run", "verify:m4"]),
  }),
  Object.freeze({
    label: "M4 5000 例课程 C 深度生成 fuzz",
    command: process.execPath,
    args: Object.freeze(["scripts/generator-fuzz.mjs", "--runs", "5000"]),
  }),
  Object.freeze({
    label: "M4 Electron 组装与 16 份语料 UI E2E",
    command: npmCommand,
    args: Object.freeze(["run", "test:e2e:m4"]),
  }),
]);

const runStage = ({ label, command, args }) =>
  new Promise((resolveStage, rejectStage) => {
    console.log(`\n[M4] ${label}`);
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectStage);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveStage();
        return;
      }
      rejectStage(new Error(`${label} 未通过（code=${String(code)}, signal=${String(signal)}）`));
    });
  });

try {
  for (const stage of stages) {
    await runStage(stage);
  }
  console.log("\n✓ M4 全部门禁通过");
} catch (error) {
  console.error(
    `\n✗ M4 停在首个失败门禁：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
