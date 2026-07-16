export const APP_INFO_IPC_CHANNEL = "panel:app-info" as const;
export const APP_APPLICATION_ID = "io.han.c-block-algorithm-panel" as const;
export const APP_PRODUCT_NAME = "AlgoLatch" as const;
export const APP_REPOSITORY_URL = "https://github.com/Ice-teapop/algolatch" as const;
export const APP_RELEASES_URL = `${APP_REPOSITORY_URL}/releases` as const;
export const APP_LICENSE_ID = "PolyForm-Noncommercial-1.0.0" as const;

export interface AppInfoSnapshot {
  readonly version: string;
  readonly license: typeof APP_LICENSE_ID;
  readonly repositoryUrl: typeof APP_REPOSITORY_URL;
  readonly releasesUrl: typeof APP_RELEASES_URL;
  readonly platform: string;
  readonly architecture: string;
  readonly electronVersion: string;
  readonly packaged: boolean;
}

export function parseAppInfoSnapshot(value: unknown): AppInfoSnapshot | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "architecture",
    "electronVersion",
    "license",
    "packaged",
    "platform",
    "releasesUrl",
    "repositoryUrl",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }
  if (
    !validMetadataToken(value.version, 64) ||
    value.license !== APP_LICENSE_ID ||
    value.repositoryUrl !== APP_REPOSITORY_URL ||
    value.releasesUrl !== APP_RELEASES_URL ||
    !validMetadataToken(value.platform, 32) ||
    !validMetadataToken(value.architecture, 32) ||
    !validMetadataToken(value.electronVersion, 64) ||
    typeof value.packaged !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    version: value.version,
    license: APP_LICENSE_ID,
    repositoryUrl: APP_REPOSITORY_URL,
    releasesUrl: APP_RELEASES_URL,
    platform: value.platform,
    architecture: value.architecture,
    electronVersion: value.electronVersion,
    packaged: value.packaged,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validMetadataToken(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
