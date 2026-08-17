import { canonicalJson } from "@packscout/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  catalogManifestKeyHasRole,
  configuredPublicationKeySecret,
} from "./productionPublicationKeyConfig";

const KEY_ID = "catalog-publisher-v1";
const SECRET = "packscout-catalog-manifest-secret-000000000001";

function configureSecrets(): void {
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({ [KEY_ID]: btoa(SECRET) }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("catalog manifest key roles", () => {
  test("accepts only canonical least-privilege role maps for configured keys", () => {
    configureSecrets();
    vi.stubEnv(
      "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
      canonicalJson({ [KEY_ID]: ["publish", "rollback"] }),
    );

    expect(configuredPublicationKeySecret(KEY_ID)).not.toBeNull();
    expect(catalogManifestKeyHasRole(KEY_ID, "publish")).toBe(true);
    expect(catalogManifestKeyHasRole(KEY_ID, "rollback")).toBe(true);
    expect(catalogManifestKeyHasRole(KEY_ID, "clear")).toBe(false);
  });

  test.each([
    ["noncanonical JSON", `{ "${KEY_ID}": ["publish"] }`],
    ["duplicate roles", canonicalJson({ [KEY_ID]: ["publish", "publish"] })],
    ["unsorted roles", canonicalJson({ [KEY_ID]: ["rollback", "publish"] })],
    ["unknown role", canonicalJson({ [KEY_ID]: ["admin"] })],
  ])("rejects %s", (_label, roleMap) => {
    configureSecrets();
    vi.stubEnv("PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES", roleMap);

    expect(catalogManifestKeyHasRole(KEY_ID, "publish")).toBe(false);
  });

  test("rejects role entries whose HMAC key is not configured", () => {
    vi.stubEnv(
      "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
      canonicalJson({ [KEY_ID]: ["publish"] }),
    );

    expect(catalogManifestKeyHasRole(KEY_ID, "publish")).toBe(false);
  });
});
