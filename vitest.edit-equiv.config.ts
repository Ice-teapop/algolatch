import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/core/edit-equiv.acceptance.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
