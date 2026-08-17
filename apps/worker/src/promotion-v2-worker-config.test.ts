import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "@packscout/contracts";
import {
  PromotionV2WorkerConfigurationError,
  assertPromotionV2CredentialEligibility,
  assertPromotionV2CredentialRoleIsolation,
  readPromotionV2WorkerConfiguration,
} from "./promotion-v2-worker-config.ts";

const secret = Buffer.alloc(32, 7).toString("base64");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS: canonicalJson({
      alpha: { keyId: "provider.alpha.v1", secretBase64: secret },
      beta: { keyId: "provider.beta.v1", secretBase64: secret },
    }),
    PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID: "manifest.publish.v1",
    PACKSCOUT_CATALOG_MANIFEST_PUBLISH_SECRET_BASE64: secret,
    PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID: "manifest.clear.v1",
    PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64: secret,
    ...overrides,
  };
}

test("reads canonical bounded provider and distinct manifest credentials", () => {
  const configuration = readPromotionV2WorkerConfiguration(environment());
  assert.deepEqual(
    configuration.providerCredentials.map(({ platformKey, keyId }) => ({
      platformKey, keyId,
    })),
    [
      { platformKey: "alpha", keyId: "provider.alpha.v1" },
      { platformKey: "beta", keyId: "provider.beta.v1" },
    ],
  );
  assert.equal(configuration.pollIntervalMilliseconds, 5_000);
  assert.equal(configuration.manifestPublishCredential.keyId, "manifest.publish.v1");
  assert.equal(configuration.manifestClearCredential.keyId, "manifest.clear.v1");
});

test("refuses noncanonical, duplicate, malformed, or oversized provider maps", () => {
  const invalid = [
    JSON.stringify({ beta: { keyId: "provider.beta.v1", secretBase64: secret },
      alpha: { keyId: "provider.alpha.v1", secretBase64: secret } }),
    canonicalJson({
      alpha: { keyId: "provider.shared.v1", secretBase64: secret },
      beta: { keyId: "provider.shared.v1", secretBase64: secret },
    }),
    canonicalJson({
      alpha: { keyId: "provider.alpha.v1", secretBase64: secret, leak: true },
    }),
    canonicalJson(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
      `platform-${index}`,
      { keyId: `provider.${index}.v1`, secretBase64: secret },
    ]))),
  ];
  for (const providerMap of invalid) {
    assert.throws(
      () => readPromotionV2WorkerConfiguration(environment({
        PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS: providerMap,
      })),
      (error: unknown) => error instanceof PromotionV2WorkerConfigurationError &&
        error.code === "PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID",
    );
  }
});

test("retains exact credentials for disabled lanes until configuration removal", () => {
  const configuration = readPromotionV2WorkerConfiguration(environment());
  assert.doesNotThrow(() => assertPromotionV2CredentialEligibility(
    configuration,
    { configuredPlatformKeys: ["alpha", "beta"], enabledPlatformKeys: ["beta"] },
  ));
  const betaOnly = readPromotionV2WorkerConfiguration(environment({
    PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS: canonicalJson({
      beta: { keyId: "provider.beta.v1", secretBase64: secret },
    }),
  }));
  assert.throws(
    () => assertPromotionV2CredentialEligibility(betaOnly, {
      configuredPlatformKeys: ["alpha", "beta"],
      enabledPlatformKeys: ["beta"],
    }),
    PromotionV2WorkerConfigurationError,
  );
  // After the B-only omission manifest is active and PostgreSQL accepts the
  // configuration removal, the next worker deploy must use the exact smaller
  // credential set. Retaining beta as an extra authority is also refused.
  assert.doesNotThrow(() => assertPromotionV2CredentialEligibility(betaOnly, {
    configuredPlatformKeys: ["beta"], enabledPlatformKeys: ["beta"],
  }));
  assert.throws(
    () => assertPromotionV2CredentialEligibility(configuration, {
      configuredPlatformKeys: ["alpha", "beta"],
      enabledPlatformKeys: ["alpha", "gamma"],
    }),
    (error: unknown) => error instanceof PromotionV2WorkerConfigurationError &&
      error.code === "PROMOTION_V2_CREDENTIAL_ELIGIBILITY_MISMATCH",
  );
  assert.throws(
    () => assertPromotionV2CredentialEligibility(configuration, {
      configuredPlatformKeys: ["beta"], enabledPlatformKeys: ["beta"],
    }),
    PromotionV2WorkerConfigurationError,
  );
});

test("enforces the five-second scheduler bound and never falls back to singular auth", () => {
  assert.throws(
    () => readPromotionV2WorkerConfiguration(environment({
      PACKSCOUT_CATALOG_PROMOTION_POLL_MS: "5001",
    })),
    PromotionV2WorkerConfigurationError,
  );
  const withoutMap = environment({
    PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS: undefined,
    PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: "legacy",
    PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64: secret,
  });
  assert.throws(
    () => readPromotionV2WorkerConfiguration(withoutMap),
    PromotionV2WorkerConfigurationError,
  );
});

test("requires disjoint provider, manifest publish, and manifest clear key IDs", () => {
  for (const overrides of [
    { PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID: "manifest.publish.v1" },
    { PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID: "provider.alpha.v1" },
    { PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID: "provider.beta.v1" },
  ]) {
    assert.throws(
      () => readPromotionV2WorkerConfiguration(environment(overrides)),
      PromotionV2WorkerConfigurationError,
    );
  }
});

test("refuses reuse of retained Heat authority by every Task011 role", () => {
  const configuration = readPromotionV2WorkerConfiguration(environment());
  assert.doesNotThrow(() => assertPromotionV2CredentialRoleIsolation(
    configuration,
    ["catalog-publisher.v1"],
  ));
  for (const keyId of [
    "provider.alpha.v1",
    "manifest.publish.v1",
    "manifest.clear.v1",
  ]) {
    assert.throws(
      () => readPromotionV2WorkerConfiguration(environment({
        PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: keyId,
      })),
      (error: unknown) => error instanceof PromotionV2WorkerConfigurationError &&
        error.code === "PROMOTION_V2_CREDENTIAL_ROLE_CONFLICT",
    );
  }
});
