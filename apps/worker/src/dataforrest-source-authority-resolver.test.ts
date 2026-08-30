import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
} from "@packscout/contracts";
import type { CentralQueryClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher } from "@packscout/services";
import {
  CentralDataforrestSourceAuthorityResolver,
  DataforrestSourceAuthorityError,
  StaticDataforrestSourceAuthorityResolver,
  type DataforrestSourceAuthorityFailureCode,
  type DataforrestSourceAuthorityRequest,
} from "./dataforrest-source-authority-resolver.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "10000000-0000-4000-8000-000000000002";
const configVersionId = "10000000-0000-4000-8000-000000000003";
const sourceCredentialVersionId = "10000000-0000-4000-8000-000000000004";
const now = new Date("2026-08-29T18:00:00.000Z");
const bearerToken = "fixture-dataforrest-token";
const key = new Uint8Array(32).fill(0x53);
const credentialCipher = new AesGcmProviderCredentialCipher({
  primaryVersion: 1,
  keys: new Map([[1, key]]),
});
const adapterKey =
  dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion;

interface CredentialFixture {
  id: string;
  provider_id: string;
  credential_kind: string;
  version_number: bigint;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  key_version: number;
  lifecycle: string;
  activated_at: Date | null;
  retired_at: Date | null;
  revoked_at: Date | null;
}

interface ConfigurationFixture {
  id: string;
  provider_id: string;
  version_number: bigint;
  adapter_key: string;
  endpoint_url: string;
  source_credential_version_id: string | null;
  configuration: unknown;
  expires_at: Date | null;
  source_credential: CredentialFixture | null;
  provider: ProviderIdentityFixture;
}

interface ProviderIdentityFixture {
  id: string;
  organization_id: string;
  provider_key: string;
  lifecycle: string;
}

interface ValidConfigurationFixture extends ConfigurationFixture {
  source_credential_version_id: string;
  source_credential: CredentialFixture;
}

const request: DataforrestSourceAuthorityRequest = Object.freeze({
  providerId,
  providerKey: "clutchpacks",
  configVersionId,
  configVersionNumber: 2n,
  adapterKey,
  now,
});

function encryptedSourceCredential(
  plaintext = bearerToken,
  revisionId = sourceCredentialVersionId,
) {
  return credentialCipher.encrypt(plaintext, {
    organizationId,
    providerId,
    revisionId,
  });
}

function validConfiguration(): ValidConfigurationFixture {
  const encrypted = encryptedSourceCredential();
  return {
    id: configVersionId,
    provider_id: providerId,
    version_number: 2n,
    adapter_key: adapterKey,
    endpoint_url: DATAFORREST_EVENTS_V1_ENDPOINT,
    source_credential_version_id: sourceCredentialVersionId,
    configuration: { platform: "clutchpacks" },
    expires_at: null,
    source_credential: {
      id: sourceCredentialVersionId,
      provider_id: providerId,
      credential_kind: "source" as const,
      version_number: 3n,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      auth_tag: encrypted.authTag,
      key_version: encrypted.keyVersion,
      lifecycle: "active" as const,
      activated_at: new Date("2026-08-29T17:00:00.000Z"),
      retired_at: null,
      revoked_at: null,
    },
    provider: {
      id: providerId,
      organization_id: organizationId,
      provider_key: "clutchpacks",
      lifecycle: "active" as const,
    },
  };
}

function resolverFor(row: ConfigurationFixture | null | Error) {
  let receivedQuery: unknown;
  const central = {
    provider_config_versions: {
      async findUnique(input: unknown) {
        receivedQuery = input;
        if (row instanceof Error) throw row;
        return row;
      },
    },
  } as unknown as CentralQueryClient;
  return {
    resolver: new CentralDataforrestSourceAuthorityResolver({
      central,
      credentialCipher,
    }),
    query: () => receivedQuery,
  };
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: DataforrestSourceAuthorityFailureCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof DataforrestSourceAuthorityError, true);
    assert.equal((error as DataforrestSourceAuthorityError).code, code);
    assert.equal(String(error).includes(bearerToken), false);
    assert.equal(JSON.stringify(error).includes(bearerToken), false);
    return true;
  });
}

describe("central DataForrest source authority", () => {
  test("loads the exact pinned configuration and decrypts only its source credential", async () => {
    const harness = resolverFor(validConfiguration());
    const authority = await harness.resolver.resolve(request);

    assert.deepEqual(authority, {
      organizationId,
      providerId,
      providerKey: "clutchpacks",
      configVersionId,
      configVersionNumber: 2n,
      adapterKey,
      sourceTypeKey:
        dataforrestClutchpacksDistributedSourceAdapterManifest.sourceTypeKey,
      sourceAdapterVersion: adapterKey,
      sourceCredentialVersionId,
      sourceCredentialVersionNumber: 3n,
      expiresAt: null,
      connectionConfiguration: {
        endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
        bearerToken,
      },
      sourceConfiguration: { platform: "clutchpacks" },
    });
    assert.deepEqual(
      (harness.query() as { where: unknown }).where,
      { id: configVersionId },
    );
    assert.equal(
      "active_config_version" in
        ((harness.query() as { select: Record<string, unknown> }).select),
      false,
    );
    assert.equal("ciphertext" in authority, false);
  });

  test("accepts the schema's null activation timestamp for an active credential", async () => {
    const row = validConfiguration();
    row.source_credential.activated_at = null;

    const authority = await resolverFor(row).resolver.resolve(request);

    assert.equal(authority.sourceCredentialVersionId, sourceCredentialVersionId);
    assert.equal(authority.connectionConfiguration.bearerToken, bearerToken);
  });

  for (const [providerKey, manifest] of [
    ["courtyard", dataforrestLaunchDistributedSourceAdapterManifest],
    ["collector_crypt", dataforrestCollectorCryptDistributedSourceAdapterManifest],
    ["phygitals", dataforrestPhygitalsDistributedV2SourceAdapterManifest],
  ] as const) {
  test(`resolves ${providerKey} only through its exact distributed tuple`, async () => {
    const row = validConfiguration();
    row.adapter_key =
      manifest.adapterVersion;
    row.configuration = { platform: providerKey };
    row.provider.provider_key = providerKey;
    const courtyardRequest: DataforrestSourceAuthorityRequest = {
      ...request,
      providerKey,
      adapterKey:
        manifest.adapterVersion,
    };

    const authority = await resolverFor(row).resolver.resolve(
      courtyardRequest,
    );
    assert.deepEqual(authority, {
      organizationId,
      providerId,
      providerKey,
      configVersionId,
      configVersionNumber: 2n,
      adapterKey:
        manifest.adapterVersion,
      sourceTypeKey:
        manifest.sourceTypeKey,
      sourceAdapterVersion:
        manifest.adapterVersion,
      sourceCredentialVersionId,
      sourceCredentialVersionNumber: 3n,
      expiresAt: null,
      connectionConfiguration: {
        endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
        bearerToken,
      },
      sourceConfiguration: { platform: providerKey },
    });
    assert.equal("ciphertext" in authority, false);
  });
  }

  test("rejects crossed installed provider-adapter tuples before querying central", async () => {
    const crossed = [
      {
        ...request,
        providerKey: "courtyard",
      },
      {
        ...request,
        adapterKey:
          dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      },
      {
        ...request,
        providerKey: "collector_crypt",
      },
      {
        ...request,
        providerKey: "collector_crypt",
        adapterKey: dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      },
      {
        ...request,
        providerKey: "courtyard",
        adapterKey: dataforrestCollectorCryptDistributedSourceAdapterManifest.adapterVersion,
      },
      {
        ...request,
        providerKey: "phygitals",
      },
      {
        ...request,
        providerKey: "phygitals",
        adapterKey: dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      },
      {
        ...request,
        providerKey: "courtyard",
        adapterKey: dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion,
      },
      {
        ...request,
        providerKey: "unknown_provider",
        adapterKey:
          dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      },
    ];
    for (const candidate of crossed) {
      const harness = resolverFor(validConfiguration());
      await rejectsWith(
        harness.resolver.resolve(candidate),
        "PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID",
      );
      assert.equal(harness.query(), undefined);
    }
  });

  test("rejects malformed server pins before querying central", async () => {
    const harness = resolverFor(validConfiguration());
    await rejectsWith(harness.resolver.resolve({
      ...request,
      providerId: "not-a-provider-id",
    }), "PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID");
    assert.equal(harness.query(), undefined);
  });

  test("sanitizes central reachability failures and inactive providers", async () => {
    const databaseFailure = new Error(`database failed near ${bearerToken}`);
    await rejectsWith(
      resolverFor(databaseFailure).resolver.resolve(request),
      "PROVIDER_SOURCE_AUTHORITY_UNAVAILABLE",
    );
    await rejectsWith(
      resolverFor({
        ...validConfiguration(),
        provider: { ...validConfiguration().provider, lifecycle: "disabled" },
      }).resolver
        .resolve(request),
      "PROVIDER_SOURCE_AUTHORITY_UNAVAILABLE",
    );
  });

  test("rejects stale provider, configuration, and adapter identity pins", async () => {
    const mismatches = [
      {
        ...validConfiguration(),
        provider: {
          ...validConfiguration().provider,
          provider_key: "courtyard",
        },
      },
      {
        ...validConfiguration(),
        provider_id: "10000000-0000-4000-8000-000000000099",
      },
      {
        ...validConfiguration(),
        version_number: 9n,
      },
      {
        ...validConfiguration(),
        adapter_key: "dataforrest-events-adapter-v2",
      },
      {
        ...validConfiguration(),
        endpoint_url: "https://example.invalid/v1/events",
      },
      {
        ...validConfiguration(),
        configuration: { platform: "courtyard" },
      },
      {
        ...validConfiguration(),
        expires_at: new Date(Number.NaN),
      },
    ];
    for (const row of mismatches) {
      await rejectsWith(
        resolverFor(row).resolver.resolve(request),
        "PROVIDER_SOURCE_CONFIGURATION_CONFLICT",
      );
    }
  });

  test("treats the exact expiration instant as expired", async () => {
    const row = validConfiguration();
    row.expires_at = new Date(now);
    await rejectsWith(
      resolverFor(row).resolver.resolve(request),
      "PROVIDER_SOURCE_CONFIGURATION_EXPIRED",
    );
  });

  test("rejects missing, foreign, inactive, and not-yet-active source credentials", async () => {
    const validMissing = validConfiguration();
    const missing: ConfigurationFixture = {
      ...validMissing,
      source_credential: null,
    };
    const wrongKind = validConfiguration();
    wrongKind.source_credential.credential_kind =
      "database" as "source";
    const foreign = validConfiguration();
    foreign.source_credential.provider_id =
      "10000000-0000-4000-8000-000000000099";
    const revoked = validConfiguration();
    revoked.source_credential.lifecycle =
      "revoked" as "active";
    revoked.source_credential.revoked_at = new Date(now);
    const future = validConfiguration();
    future.source_credential.activated_at =
      new Date("2026-08-29T19:00:00.000Z");

    for (const row of [missing, wrongKind, foreign, revoked, future]) {
      await rejectsWith(
        resolverFor(row).resolver.resolve(request),
        "PROVIDER_SOURCE_CREDENTIAL_UNAVAILABLE",
      );
    }
  });

  test("uses the source credential version ID as cipher revision scope", async () => {
    const row = validConfiguration();
    const incorrectlyScoped = encryptedSourceCredential(
      bearerToken,
      configVersionId,
    );
    row.source_credential.ciphertext = incorrectlyScoped.ciphertext;
    row.source_credential.nonce = incorrectlyScoped.nonce;
    row.source_credential.auth_tag = incorrectlyScoped.authTag;
    await rejectsWith(
      resolverFor(row).resolver.resolve(request),
      "PROVIDER_SOURCE_CREDENTIAL_INVALID",
    );
  });

  test("rejects decrypted bearer text outside the production adapter contract", async () => {
    const row = validConfiguration();
    const invalid = encryptedSourceCredential(` ${bearerToken}`);
    row.source_credential.ciphertext = invalid.ciphertext;
    row.source_credential.nonce = invalid.nonce;
    row.source_credential.auth_tag = invalid.authTag;
    await rejectsWith(
      resolverFor(row).resolver.resolve(request),
      "PROVIDER_SOURCE_CREDENTIAL_INVALID",
    );
  });
});

describe("static DataForrest source authority", () => {
  test("retains one exact decrypted authority and rechecks tuple and expiry locally", async () => {
    const row = validConfiguration();
    row.expires_at = new Date("2026-08-29T18:05:00.000Z");
    const authority = await resolverFor(row).resolver.resolve(request);
    assert.deepEqual(authority.expiresAt, row.expires_at);

    let observedAt = new Date("2026-08-29T18:01:00.000Z");
    const resolver = new StaticDataforrestSourceAuthorityResolver({
      authority,
      now: () => observedAt,
    });
    const localRequest = { ...request, now: undefined };
    assert.equal(await resolver.resolve(localRequest), authority);

    for (const crossed of [
      { ...localRequest, providerKey: "courtyard" },
      { ...localRequest, configVersionNumber: 3n },
      {
        ...localRequest,
        adapterKey:
          dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      },
    ]) {
      await rejectsWith(
        resolver.resolve(crossed),
        "PROVIDER_SOURCE_CONFIGURATION_CONFLICT",
      );
    }

    const exactExpiresAt = new Date(row.expires_at);
    authority.expiresAt?.setTime(
      new Date("2026-08-29T19:00:00.000Z").getTime(),
    );
    observedAt = exactExpiresAt;
    await rejectsWith(
      resolver.resolve({
        ...localRequest,
        now: new Date("2026-08-29T18:01:00.000Z"),
      }),
      "PROVIDER_SOURCE_CONFIGURATION_EXPIRED",
    );
  });
});
