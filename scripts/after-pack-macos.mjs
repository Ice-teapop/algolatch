import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export default async function removeMacosSigningDetritus(context) {
  if (context?.electronPlatformName !== "darwin") return;
  const appPath = resolvePackagedAppPath(context);
  await runFile("/usr/bin/xattr", ["-cr", appPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

export function resolvePackagedAppPath(context) {
  const outputDirectory = context?.appOutDir;
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (
    typeof outputDirectory !== "string" ||
    !isAbsolute(outputDirectory) ||
    typeof productFilename !== "string" ||
    productFilename !== "AlgoLatch"
  ) {
    throw new TypeError("macOS afterPack 只允许清理 AlgoLatch 的绝对构建输出路径");
  }
  return join(outputDirectory, `${productFilename}.app`);
}
