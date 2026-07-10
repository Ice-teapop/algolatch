import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceStore } from "../../electron/main/workspace-store.js";

describe("Documents workspace store", () => {
  let temporaryDirectory = "";
  let rootPath = "";

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "panel-workspace-"));
    rootPath = join(temporaryDirectory, "C Algorithm Workbench");
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("creates one opaque project directory and lists it without exposing a path", async () => {
    const store = createWorkspaceStore(rootPath);
    const result = await store.create({ kind: "project", title: "Binary Search" });
    expect(result.status).toBe("opened");
    if (result.status !== "opened") throw new Error("项目创建失败");

    const { entry, source } = result.document;
    expect(entry).toMatchObject({
      kind: "project",
      title: "Binary Search",
      sourceName: "main.c",
      revision: 0,
    });
    expect(entry.id).toMatch(/^project-[0-9a-f-]{36}$/u);
    expect(source).toBe("int main(void) {\n  return 0;\n}\n");

    const directory = join(rootPath, "Projects", entry.id);
    expect(await readdir(directory)).toEqual(["entry.json", "main.c"]);
    expect(await readFile(join(directory, "main.c"), "utf8")).toBe(source);
    expect(JSON.parse(await readFile(join(directory, "entry.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      id: entry.id,
      title: "Binary Search",
      sourceFile: "main.c",
    });

    const list = await store.list();
    expect(list).toEqual({
      status: "ready",
      snapshot: { rootName: "C Algorithm Workbench", entries: [entry] },
    });
    expect(JSON.stringify(list)).not.toContain(temporaryDirectory);
  });

  it.each([
    ["project", "项目", "Projects"],
    ["sandbox", "快速实验", "Sandboxes"],
    ["test", "边界测试", "Tests"],
  ] as const)(
    "maps %s entries into the dedicated Documents module",
    async (kind, title, folder) => {
      const store = createWorkspaceStore(rootPath);
      const result = await store.create({ kind, title });
      if (result.status !== "opened") throw new Error("条目创建失败");
      expect(
        await readFile(join(rootPath, folder, result.document.entry.id, "main.c"), "utf8"),
      ).toBe(result.document.source);
    },
  );

  it("opens and serializes concurrent saves with optimistic revision checks", async () => {
    const store = createWorkspaceStore(rootPath);
    const created = await store.create({ kind: "sandbox", title: "指针实验" });
    if (created.status !== "opened") throw new Error("沙箱创建失败");
    const entryId = created.document.entry.id;

    const [first, stale] = await Promise.all([
      store.save({ entryId, expectedRevision: 0, source: "int value = 1;\n" }),
      store.save({ entryId, expectedRevision: 0, source: "int value = 2;\n" }),
    ]);
    expect(first).toMatchObject({ status: "saved", entry: { revision: 1 } });
    expect(stale).toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_CONFLICT" },
    });

    const opened = await store.open({ entryId });
    expect(opened).toMatchObject({
      status: "opened",
      document: { entry: { revision: 1 }, source: "int value = 1;\n" },
    });
  });

  it("rejects extra fields, path-shaped ids, invalid titles and invalid source", async () => {
    const store = createWorkspaceStore(rootPath);
    await expect(
      store.create({ kind: "project", title: "ok", path: "/tmp/x" }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "WORKSPACE_INVALID_REQUEST" } });
    await expect(store.create({ kind: "project", title: "\u0000hidden" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_INVALID_TITLE" },
    });
    await expect(store.open({ entryId: "../../outside" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_INVALID_REQUEST" },
    });

    const created = await store.create({ kind: "test", title: "UTF-8" });
    if (created.status !== "opened") throw new Error("测试条目创建失败");
    await expect(
      store.save({
        entryId: created.document.entry.id,
        expectedRevision: 0,
        source: "bad\0source",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_INVALID_SOURCE" },
    });
  });

  it("rejects a symlinked root and never writes through it", async () => {
    const outside = join(temporaryDirectory, "outside");
    await writeFile(outside, "sentinel", "utf8");
    await symlink(temporaryDirectory, rootPath);
    const store = createWorkspaceStore(rootPath);

    await expect(store.list()).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_ROOT_UNAVAILABLE" },
    });
    expect(await readFile(outside, "utf8")).toBe("sentinel");
  });
});
