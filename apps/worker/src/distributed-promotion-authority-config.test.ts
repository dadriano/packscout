import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import test from "node:test";
import {
  DistributedPromotionAuthorityConfigurationError,
  assertDistributedPromotionAuthorityIsolation,
  assertProviderPublicationJobRegistration,
  readManifestReconciliationJobAuthorityConfiguration,
  readProviderPublicationJobAuthorityConfiguration,
} from "./distributed-promotion-authority-config.ts";

const PROVIDER_A_ID = "1188497f-a4b5-4bd4-a963-a9c77e2f53d0";
const PROVIDER_B_ID = "d2443367-59f0-4619-9b75-fd19b7582c86";
const PROVIDER_SECRET = Buffer.alloc(32, 7);
const MANIFEST_SECRET = Buffer.alloc(32, 11);

function providerEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_PROMOTION_PROVIDER_ID: PROVIDER_A_ID,
    PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: "provider.alpha.v1",
    PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
      PROVIDER_SECRET.toString("base64"),
    PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "provider-alpha-v1",
    ...overrides,
  };
}

function manifestEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_PROMOTION_MANIFEST_KEY_ID: "manifest.publish.v1",
    PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64:
      MANIFEST_SECRET.toString("base64"),
    PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION: "manifest-v1",
    ...overrides,
  };
}

function hasConfigurationError(
  code: DistributedPromotionAuthorityConfigurationError["code"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof DistributedPromotionAuthorityConfigurationError &&
    error.code === code;
}

test("pins a provider job to one exact provider and one credential", () => {
  const configuration =
    readProviderPublicationJobAuthorityConfiguration(providerEnvironment());

  assert.equal(configuration.kind, "provider_publication");
  assert.equal(configuration.providerId, PROVIDER_A_ID);
  assert.equal(configuration.credential.keyId, "provider.alpha.v1");
  assert.equal(configuration.credential.authorityVersion, "provider-alpha-v1");
  assert.deepEqual(
    Buffer.from(configuration.credential.secret),
    PROVIDER_SECRET,
  );
  assert.equal(configuration.requestTimeoutMilliseconds, 10_000);
  assert.equal(Reflect.has(configuration, "manifestCredential"), false);
  assert.equal(Reflect.has(configuration, "manifestClearCredential"), false);
  assert.equal(Reflect.has(configuration, "providerCredentials"), false);

  assert.doesNotThrow(() => assertProviderPublicationJobRegistration(
    configuration,
    { providerId: PROVIDER_A_ID.toUpperCase() },
  ));
  assert.throws(
    () => assertProviderPublicationJobRegistration(
      configuration,
      { providerId: PROVIDER_B_ID },
    ),
    hasConfigurationError("DISTRIBUTED_PROMOTION_PROVIDER_NOT_REGISTERED"),
  );
});

test("gives the central job manifest authority without provider or clear authority", () => {
  const configuration =
    readManifestReconciliationJobAuthorityConfiguration(
      manifestEnvironment(),
    );

  assert.equal(configuration.kind, "manifest_reconciliation");
  assert.equal(configuration.credential.keyId, "manifest.publish.v1");
  assert.equal(configuration.credential.authorityVersion, "manifest-v1");
  assert.deepEqual(
    Buffer.from(configuration.credential.secret),
    MANIFEST_SECRET,
  );
  assert.equal(Reflect.has(configuration, "providerId"), false);
  assert.equal(Reflect.has(configuration, "providerCredential"), false);
  assert.equal(Reflect.has(configuration, "manifestClearCredential"), false);
  assert.equal(Reflect.has(configuration, "clearCredential"), false);
});

test("refuses provider and manifest role composition", () => {
  assert.throws(
    () => readProviderPublicationJobAuthorityConfiguration(
      providerEnvironment({
        PACKSCOUT_PROMOTION_MANIFEST_KEY_ID: "manifest.publish.v1",
      }),
    ),
    hasConfigurationError("DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT"),
  );
  assert.throws(
    () => readManifestReconciliationJobAuthorityConfiguration(
      manifestEnvironment({
        PACKSCOUT_PROMOTION_PROVIDER_ID: PROVIDER_A_ID,
      }),
    ),
    hasConfigurationError("DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT"),
  );
});

test("refuses every legacy composite promotion authority", () => {
  const legacyKeys = [
    "PACKSCOUT_CATALOG_PLATFORM_KEY",
    "PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS",
    "PACKSCOUT_CATALOG_PROVIDER_KEY_ID",
    "PACKSCOUT_CATALOG_PROVIDER_SECRET_BASE64",
    "PACKSCOUT_CATALOG_PROVIDER_AUTHORITY_VERSION",
    "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID",
    "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_SECRET_BASE64",
    "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_AUTHORITY_VERSION",
    "PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID",
    "PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64",
    "PACKSCOUT_CATALOG_MANIFEST_CLEAR_AUTHORITY_VERSION",
  ] as const;

  for (const key of legacyKeys) {
    assert.throws(
      () => readProviderPublicationJobAuthorityConfiguration(
        providerEnvironment({ [key]: "configured" }),
      ),
      hasConfigurationError(
        "DISTRIBUTED_PROMOTION_LEGACY_AUTHORITY_CONFIGURED",
      ),
    );
    assert.throws(
      () => readManifestReconciliationJobAuthorityConfiguration(
        manifestEnvironment({ [key]: "configured" }),
      ),
      hasConfigurationError(
        "DISTRIBUTED_PROMOTION_LEGACY_AUTHORITY_CONFIGURED",
      ),
    );
  }
});

test("keeps keys and secret identities isolated across roles and rotations", () => {
  const provider =
    readProviderPublicationJobAuthorityConfiguration(providerEnvironment());
  assert.doesNotThrow(() => assertDistributedPromotionAuthorityIsolation(
    provider,
    [{
      keyId: "provider.alpha.v0",
      secretIdentitySha256: createHash("sha256")
        .update(Buffer.alloc(32, 6))
        .digest("hex"),
    }],
  ));

  for (const reserved of [
    {
      keyId: provider.credential.keyId,
      secretIdentitySha256: "0".repeat(64),
    },
    {
      keyId: "provider.alpha.v0",
      secretIdentitySha256: provider.credential.secretIdentitySha256,
    },
  ]) {
    assert.throws(
      () => assertDistributedPromotionAuthorityIsolation(provider, [reserved]),
      hasConfigurationError("DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT"),
    );
  }

  const rotated = readProviderPublicationJobAuthorityConfiguration(
    providerEnvironment({
      PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: "provider.alpha.v2",
      PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
        Buffer.alloc(32, 8).toString("base64"),
      PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "provider-alpha-v2",
    }),
  );
  assert.equal(rotated.providerId, provider.providerId);
  assert.notEqual(rotated.credential.keyId, provider.credential.keyId);
  assert.notEqual(
    rotated.credential.secretIdentitySha256,
    provider.credential.secretIdentitySha256,
  );
});

test("returns secret copies and redacts configuration inspection", () => {
  const configuration =
    readProviderPublicationJobAuthorityConfiguration(providerEnvironment());
  const firstCopy = configuration.credential.secret;
  firstCopy[0] = 99;
  assert.equal(configuration.credential.secret[0], PROVIDER_SECRET[0]);
  assert.notEqual(firstCopy, configuration.credential.secret);

  const rendered = [
    JSON.stringify(configuration),
    inspect(configuration),
    JSON.stringify(configuration.credential),
    inspect(configuration.credential),
  ].join("\n");
  const secretDigest = createHash("sha256").update(PROVIDER_SECRET).digest("hex");

  for (const protectedValue of [
    PROVIDER_A_ID,
    "provider.alpha.v1",
    PROVIDER_SECRET.toString("base64"),
    secretDigest,
    "production-us",
  ]) {
    assert.equal(rendered.includes(protectedValue), false);
  }
  assert.deepEqual(Object.keys(configuration), []);
  assert.deepEqual(Object.keys(configuration.credential), []);
});

test("validates provider identity, endpoint, deployment, timeout, version, and secret", () => {
  const cases: readonly [
    NodeJS.ProcessEnv,
    DistributedPromotionAuthorityConfigurationError["code"],
  ][] = [
    [
      providerEnvironment({ PACKSCOUT_PROMOTION_PROVIDER_ID: "alpha" }),
      "DISTRIBUTED_PROMOTION_PROVIDER_ID_INVALID",
    ],
    [
      providerEnvironment({
        PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "http://convex.example",
      }),
      "DISTRIBUTED_PROMOTION_URL_INVALID",
    ],
    [
      providerEnvironment({
        PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example/path",
      }),
      "DISTRIBUTED_PROMOTION_URL_INVALID",
    ],
    [
      providerEnvironment({ PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "" }),
      "DISTRIBUTED_PROMOTION_DEPLOYMENT_KEY_INVALID",
    ],
    [
      providerEnvironment({
        PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS: "30001",
      }),
      "DISTRIBUTED_PROMOTION_REQUEST_TIMEOUT_INVALID",
    ],
    [
      providerEnvironment({
        PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "bad version",
      }),
      "DISTRIBUTED_PROMOTION_AUTHORITY_VERSION_INVALID",
    ],
    [
      providerEnvironment({
        PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
          Buffer.alloc(31, 7).toString("base64"),
      }),
      "DISTRIBUTED_PROMOTION_PROVIDER_CREDENTIAL_INVALID",
    ],
  ];

  for (const [environment, code] of cases) {
    assert.throws(
      () => readProviderPublicationJobAuthorityConfiguration(environment),
      hasConfigurationError(code),
    );
  }
});
