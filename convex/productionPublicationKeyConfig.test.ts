import {
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  canonicalJson,
} from "@packscout/contracts";
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
const MAX_CONVEX_ENVIRONMENT_VALUE_BYTES = 8 * 1_024;
const PROVIDER_KEYS_PER_PLATFORM = 2;
const MAX_MANIFEST_KEYS = 16;
const MAX_HEAT_KEYS = 4;
const MAX_DATA_RELEASE_V3_KEYS = 4;

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

function configureMinimumSecrets(...keyIds: readonly string[]): string {
  const serialized = canonicalJson(Object.fromEntries(
    keyIds.map((keyId, index) => [
      keyId,
      btoa(String(index + 1).padStart(
        MIN_PRODUCTION_AUTH_SECRET_BYTES,
        "0",
      )),
    ]),
  ));
  vi.stubEnv("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", serialized);
  return serialized;
}

function indexedKeyIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(2, "0")}-v1`,
  );
}

function providerKeyPlatforms(
  providerCount: number,
  keysPerPlatform: number,
): Record<string, string> {
  return Object.fromEntries(Array.from(
    { length: providerCount },
    (_, providerIndex) => {
      const index = String(providerIndex).padStart(2, "0");
      return Array.from(
        { length: keysPerPlatform },
        (__, keyIndex) => [
          `provider-${index}-key-${String(keyIndex)}-v1`,
          `provider-${index}`,
        ],
      );
    },
  ).flat());
}

function configureFullRosterAuthorityGraph(): string {
  const providerPlatforms = providerKeyPlatforms(
    MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
    1,
  );
  const manifestKeyIds = indexedKeyIds("manifest", MAX_MANIFEST_KEYS);
  const heatKeyIds = indexedKeyIds("heat", MAX_HEAT_KEYS);
  const dataReleaseV3KeyIds = indexedKeyIds(
    "data-release-v3",
    MAX_DATA_RELEASE_V3_KEYS,
  );
  const serializedSecrets = configureMinimumSecrets(
    ...Object.keys(providerPlatforms),
    ...manifestKeyIds,
    ...heatKeyIds,
    ...dataReleaseV3KeyIds,
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    canonicalJson(providerPlatforms),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson(Object.fromEntries(
      manifestKeyIds.map((keyId) => [keyId, ["publish"]]),
    )),
  );
  vi.stubEnv(
    "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
    canonicalJson(heatKeyIds),
  );
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
    canonicalJson(dataReleaseV3KeyIds),
  );
  return serializedSecrets;
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

describe("publication authority capacity", () => {
  test("accepts 64 providers with one key each plus all 24 ancillary slots within 8 KiB", () => {
    const serializedSecrets = configureFullRosterAuthorityGraph();

    expect(new TextEncoder().encode(serializedSecrets).byteLength)
      .toBeLessThanOrEqual(MAX_CONVEX_ENVIRONMENT_VALUE_BYTES);
    expect(publicationAuthorityConfigurationIsIsolated()).toBe(true);
  });

  test("rejects a sixty-fifth provider even below the provider-key entry limit", () => {
    const providerPlatforms = providerKeyPlatforms(
      MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES + 1,
      1,
    );
    configureSecrets(...Object.keys(providerPlatforms));
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      canonicalJson(providerPlatforms),
    );

    expect(publicationAuthorityConfigurationIsIsolated()).toBe(false);
  });

  test("accepts current and previous provider keys but rejects a third", () => {
    const rotatingProviderPlatforms = providerKeyPlatforms(
      1,
      PROVIDER_KEYS_PER_PLATFORM,
    );
    configureSecrets(...Object.keys(rotatingProviderPlatforms));
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      canonicalJson(rotatingProviderPlatforms),
    );
    expect(publicationAuthorityConfigurationIsIsolated()).toBe(true);

    const overCapacityProviderPlatforms = providerKeyPlatforms(
      1,
      PROVIDER_KEYS_PER_PLATFORM + 1,
    );
    configureSecrets(...Object.keys(overCapacityProviderPlatforms));
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      canonicalJson(overCapacityProviderPlatforms),
    );

    expect(publicationAuthorityConfigurationIsIsolated()).toBe(false);
  });

  test("accepts a publication-secret value exactly at the 8 KiB boundary", () => {
    const serialized = canonicalJson({
      [KEY_ID]: btoa("x".repeat(MIN_PRODUCTION_AUTH_SECRET_BYTES)),
    });
    const exactBoundary = serialized.padEnd(
      MAX_CONVEX_ENVIRONMENT_VALUE_BYTES,
      " ",
    );
    vi.stubEnv("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", exactBoundary);

    expect(new TextEncoder().encode(exactBoundary).byteLength)
      .toBe(MAX_CONVEX_ENVIRONMENT_VALUE_BYTES);
    expect(configuredPublicationKeySecret(KEY_ID)).not.toBeNull();
  });

  test("rejects a publication-secret value one byte beyond 8 KiB", () => {
    const serialized = canonicalJson({
      [KEY_ID]: btoa("x".repeat(MIN_PRODUCTION_AUTH_SECRET_BYTES)),
    });
    const overBoundary = serialized.padEnd(
      MAX_CONVEX_ENVIRONMENT_VALUE_BYTES + 1,
      " ",
    );
    vi.stubEnv("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", overBoundary);

    expect(new TextEncoder().encode(overBoundary).byteLength)
      .toBe(MAX_CONVEX_ENVIRONMENT_VALUE_BYTES + 1);
    expect(configuredPublicationKeySecret(KEY_ID)).toBeNull();
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
