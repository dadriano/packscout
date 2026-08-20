import { canonicalJson } from "@packscout/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  catalogManifestKeyHasRole,
  catalogRetentionKeyIsAuthorized,
  configuredPublicationKeySecret,
  heatPublicationKeyIsAuthorized,
  publicationAuthorityConfigurationIsIsolated,
} from "./productionPublicationKeyConfig";

const KEY_ID = "catalog-publisher-v1";
const HEAT_KEY_ID = "heat-publisher-v1";
const ROTATED_HEAT_KEY_ID = "heat-publisher-v2";
const SECRET = "packscout-catalog-manifest-secret-000000000001";

function configureSecrets(...keyIds: readonly string[]): void {
  const configuredKeyIds = keyIds.length === 0 ? [KEY_ID] : keyIds;
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson(Object.fromEntries(
      configuredKeyIds.map((keyId, index) => [
        keyId,
        btoa(`${SECRET}:${String(index)}`),
      ]),
    )),
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

  test("requires a dedicated retain-only authority", () => {
    configureSecrets();
    vi.stubEnv(
      "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
      canonicalJson({ [KEY_ID]: ["publish", "retain"] }),
    );

    expect(catalogManifestKeyHasRole(KEY_ID, "publish")).toBe(false);
    expect(catalogRetentionKeyIsAuthorized(KEY_ID)).toBe(false);

    vi.stubEnv(
      "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
      canonicalJson({ [KEY_ID]: ["retain"] }),
    );
    expect(catalogRetentionKeyIsAuthorized(KEY_ID)).toBe(true);
  });
});

describe("Heat publication key authority", () => {
  test("accepts a canonical bounded rotation list of configured dedicated keys", () => {
    configureSecrets(HEAT_KEY_ID, ROTATED_HEAT_KEY_ID);
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID, ROTATED_HEAT_KEY_ID]),
    );

    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(true);
    expect(heatPublicationKeyIsAuthorized(ROTATED_HEAT_KEY_ID)).toBe(true);
  });

  test.each([
    ["noncanonical JSON", `[ "${HEAT_KEY_ID}" ]`],
    ["duplicate keys", canonicalJson([HEAT_KEY_ID, HEAT_KEY_ID])],
    [
      "unsorted keys",
      canonicalJson([ROTATED_HEAT_KEY_ID, HEAT_KEY_ID]),
    ],
    [
      "too many keys",
      canonicalJson([
        "heat-publisher-v1",
        "heat-publisher-v2",
        "heat-publisher-v3",
        "heat-publisher-v4",
        "heat-publisher-v5",
      ]),
    ],
  ])("rejects %s", (_label, keyIds) => {
    configureSecrets(
      HEAT_KEY_ID,
      ROTATED_HEAT_KEY_ID,
      "heat-publisher-v3",
      "heat-publisher-v4",
      "heat-publisher-v5",
    );
    vi.stubEnv("PACKSCOUT_HEAT_PUBLICATION_KEY_IDS", keyIds);

    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
  });

  test("rejects a Heat key without a configured publication secret", () => {
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID]),
    );

    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
  });

  test("fails closed when a Heat key also has provider authority", () => {
    configureSecrets(HEAT_KEY_ID);
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID]),
    );
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      canonicalJson({ [HEAT_KEY_ID]: "alpha" }),
    );

    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
  });

  test.each(["clear", "publish", "retain", "rollback"] as const)(
    "fails closed when a Heat key also has the %s manifest role",
    (role) => {
      configureSecrets(HEAT_KEY_ID);
      vi.stubEnv(
        "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
        canonicalJson([HEAT_KEY_ID]),
      );
      vi.stubEnv(
        "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
        canonicalJson({ [HEAT_KEY_ID]: [role] }),
      );

      expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
    },
  );

  test("fails closed when distinct Heat and provider key IDs share secret bytes", () => {
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({
        [HEAT_KEY_ID]: btoa(SECRET),
        [KEY_ID]: btoa(SECRET),
      }),
    );
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID]),
    );
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      canonicalJson({ [KEY_ID]: "alpha" }),
    );

    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
  });

  test("fails closed when distinct Heat and manifest key IDs share secret bytes", () => {
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({
        [HEAT_KEY_ID]: btoa(SECRET),
        [KEY_ID]: btoa(SECRET),
      }),
    );
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID]),
    );
    vi.stubEnv(
      "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
      canonicalJson({ [KEY_ID]: ["publish"] }),
    );

    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
    expect(catalogManifestKeyHasRole(KEY_ID, "publish")).toBe(true);
    expect(publicationAuthorityConfigurationIsIsolated()).toBe(false);
  });

  test("fails closed when an unbound configured key shares Heat secret bytes", () => {
    const orphanKeyId = "orphan-publication-v1";
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({
        [HEAT_KEY_ID]: btoa(SECRET),
        [orphanKeyId]: btoa(SECRET),
      }),
    );
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID]),
    );

    expect(configuredPublicationKeySecret(orphanKeyId)).not.toBeNull();
    expect(heatPublicationKeyIsAuthorized(HEAT_KEY_ID)).toBe(false);
  });
});
