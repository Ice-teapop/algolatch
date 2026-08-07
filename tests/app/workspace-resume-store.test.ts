import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceResumeStore,
  WORKSPACE_RESUME_STORAGE_KEY,
} from "../../src/app/workspace-resume-store.js";

describe("workspace resume store", () => {
  it("stores only a versioned opaque entry id", () => {
    const storage = memoryStorage();
    const store = createWorkspaceResumeStore(storage);

    store.write("project-opaque-id");

    expect(storage.setItem).toHaveBeenCalledWith(
      WORKSPACE_RESUME_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, entryId: "project-opaque-id" }),
    );
    expect(store.read()).toBe("project-opaque-id");
  });

  it.each([
    "{",
    JSON.stringify({ schemaVersion: 2, entryId: "project-id" }),
    JSON.stringify({ schemaVersion: 1, entryId: "../Documents/main.c" }),
    JSON.stringify({ schemaVersion: 1, entryId: "project-id", title: "must not persist" }),
  ])("clears malformed, unsafe, or over-specified state: %s", (serialized) => {
    const storage = memoryStorage(serialized);
    const store = createWorkspaceResumeStore(storage);

    expect(store.read()).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(WORKSPACE_RESUME_STORAGE_KEY);
  });

  it("fails closed when localStorage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      removeItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
    };
    const store = createWorkspaceResumeStore(storage);

    expect(store.read()).toBeNull();
    expect(() => store.write("project-id")).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });
});

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    removeItem: vi.fn(() => {
      value = null;
    }),
  };
}
