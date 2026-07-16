import { describe, expect, it } from "vitest";
import {
  APP_LICENSE_ID,
  APP_RELEASES_URL,
  APP_REPOSITORY_URL,
  parseAppInfoSnapshot,
} from "../../src/shared/app-info.js";

const valid = Object.freeze({
  version: "0.0.1",
  license: APP_LICENSE_ID,
  repositoryUrl: APP_REPOSITORY_URL,
  releasesUrl: APP_RELEASES_URL,
  platform: "darwin",
  architecture: "arm64",
  electronVersion: "43.0.0",
  packaged: true,
});

describe("public app information boundary", () => {
  it("accepts and freezes the bounded public metadata snapshot", () => {
    const parsed = parseAppInfoSnapshot(valid);

    expect(parsed).toEqual(valid);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { ...valid, repositoryUrl: "https://example.com" },
    { ...valid, license: "MIT" },
    { ...valid, version: "0.0.1\nsecret" },
    { ...valid, path: "/Users/example/project" },
  ])("rejects altered, unsafe or expanded metadata %#", (candidate) => {
    expect(parseAppInfoSnapshot(candidate)).toBeNull();
  });
});
