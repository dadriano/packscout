import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_BATCH_HASH_DOMAIN,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES,
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  canonicalJsonBytes,
  catalogContentSeedHash,
  extendCatalogContentHash,
  globalCategoryPublicId,
  packscoutPublicIdentityUuid,
  sha256CanonicalJson,
  type PublicCatalogAlias,
  type PublicCatalogCategory,
  type PublicCatalogCollectible,
} from "@packscout/contracts";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  ProviderReleaseCentralRepository,
  ProviderReleasePinError,
} from "./provider-release-central-repository.ts";

const ids = {
  provider: "17000000-0000-4000-8000-000000000001",
  profile: "17000000-0000-4000-8000-000000000002",
  config: "17000000-0000-4000-8000-000000000008",
  globalCategory: "17000000-0000-4000-8000-000000000003",
  canonicalCollectible: "17000000-0000-4000-8000-000000000004",
  retiredAlias: "17000000-0000-4000-8000-000000000005",
  localCategory: "17000000-0000-4000-8000-000000000006",
  localCollectible: "17000000-0000-4000-8000-000000000007",
} as const;
const dataAsOf = new Date("2026-08-29T12:00:00.000Z");

async function artifact() {
  const publicCategoryId = globalCategoryPublicId(ids.globalCategory);
  const categories: readonly PublicCatalogCategory[] = [{
      publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      displayName: "Cards",
      categoryKind: "vertical",
      displayOrder: 0,
      depth: 0,
      pathPublicCategoryIds: [publicCategoryId],
      lifecycle: "active",
    }];
  const collectibles: readonly PublicCatalogCollectible[] = [{
      publicCollectibleId: ids.canonicalCollectible,
      collectibleType: "card",
      identityState: "canonical",
      displayName: "Canonical Card",
      normalizedName: "canonical card",
      year: 2026,
      brand: "PackScout",
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      primaryImageUrl: null,
      primaryImageAlt: null,
      valuationAmount: null,
      valuationCurrency: null,
      valuationUsdAmount: null,
      valuationUnavailableReason: "VALUATION_UNAVAILABLE",
      valuationType: null,
      valuationObservedAt: null,
      dataAsOf: dataAsOf.toISOString(),
      publicCategoryIds: [publicCategoryId],
      nameAliases: [],
      normalizedNameAliases: [],
    }];
  const aliases: readonly PublicCatalogAlias[] = [{
      aliasPublicCollectibleId: ids.retiredAlias,
      canonicalPublicCollectibleId: ids.canonicalCollectible,
    }];
  const source = [
    { batchKind: "categories" as const, records: categories },
    { batchKind: "collectibles" as const, records: collectibles },
    { batchKind: "aliases" as const, records: aliases },
  ];
  const batches = await Promise.all(source.map(async ({ batchKind, records }, batchOrdinal) => {
    const body = { batchKind, batchIndex: 0, records };
    return {
      batchOrdinal,
      batchKind,
      batchIndex: 0,
      records,
      recordCount: records.length,
      byteCount: canonicalJsonBytes(body).byteLength,
      bodyHash: await sha256CanonicalJson(CATALOG_BATCH_HASH_DOMAIN, body),
    };
  }));
  let contentHash = await catalogContentSeedHash({
    schemaVersion: "catalog-v1",
    categoryCount: categories.length,
    collectibleCount: collectibles.length,
    aliasCount: aliases.length,
    batchCount: batches.length,
  });
  for (const batch of batches) {
    contentHash = await extendCatalogContentHash({
      previousHash: contentHash,
      batchOrdinal: batch.batchOrdinal,
      batchKind: batch.batchKind,
      batchIndex: batch.batchIndex,
      recordCount: batch.recordCount,
      byteCount: batch.byteCount,
      bodyHash: batch.bodyHash,
    });
  }
  return {
    descriptor: {
      catalogVersionId: packscoutPublicIdentityUuid(`catalog-version:catalog-v1:${contentHash}`),
      schemaVersion: "catalog-v1",
      categoryCount: categories.length,
      collectibleCount: collectibles.length,
      aliasCount: aliases.length,
      contentHash,
    },
    batches,
  };
}

async function fakeCentral(input: {
  readonly tamperCatalog?: boolean;
  readonly staleAfterSeconds?: number | null;
  readonly configExpiresAt?: Date | null;
  readonly identityRole?: "central" | "provider";
  readonly identitySchemaVersion?: string;
  readonly catalogPayloadBytes?: bigint;
  readonly observeCatalogPayloadRead?: () => void;
  readonly observeTransactionOptions?: (options: unknown) => void;
} = {}): Promise<CentralPrismaClient> {
  const built = await artifact();
  const publicProvider = {
    publicVendorId: packscoutPublicIdentityUuid(`provider:${ids.provider}`),
    vendorKey: "central_pin_fixture",
    displayName: "Central pin fixture",
    logoUrl: null,
    websiteUrl: "https://fixture.example",
    listingHosts: ["fixture.example"],
    imageOrigins: [],
    referralParameters: [{ name: "utm_source", value: "packscout" }],
    publicPromo: { code: "SCOUT", label: "Use SCOUT" },
  };
  const profile = {
    id: ids.profile,
    provider_id: ids.provider,
    display_name: publicProvider.displayName,
    logo_url: publicProvider.logoUrl,
    website_url: publicProvider.websiteUrl,
    listing_hosts: publicProvider.listingHosts,
    image_origins: publicProvider.imageOrigins,
    referral_parameters: publicProvider.referralParameters,
    promo_code: publicProvider.publicPromo.code,
    promo_label: publicProvider.publicPromo.label,
    content_hash: await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      publicProvider,
    ),
  };
  const storedBatches = built.batches.map((batch, index) => ({
    batch_kind: batch.batchKind,
    batch_index: batch.batchIndex,
    payload: input.tamperCatalog && index === 0 ? [] : batch.records,
    record_count: batch.recordCount,
    byte_count: batch.byteCount,
    body_hash: batch.bodyHash,
  }));
  let rawQueryCount = 0;
  const transaction = {
    providers: {
      async findUnique() {
        return {
          id: ids.provider,
          provider_key: publicProvider.vendorKey,
          lifecycle: "active",
          active_config_version_id: input.staleAfterSeconds === null
            ? null
            : ids.config,
          active_public_profile_version_id: ids.profile,
          active_config_version: input.staleAfterSeconds === null
            ? null
            : {
                id: ids.config,
                stale_after_seconds: input.staleAfterSeconds ?? 3_600,
                expires_at: input.configExpiresAt ?? null,
              },
          active_public_profile_version: profile,
        };
      },
    },
    database_identity: {
      async findUnique() {
        return {
          database_role: input.identityRole ?? "central",
          schema_version: input.identitySchemaVersion ?? "distributed-central-v1",
          provider_id: null,
          provider_key: null,
        };
      },
    },
    catalog_versions: {
      async findUnique() {
        return {
          id: built.descriptor.catalogVersionId,
          schema_version: built.descriptor.schemaVersion,
          content_hash: built.descriptor.contentHash,
          through_change_sequence: 11n,
          category_count: built.descriptor.categoryCount,
          collectible_count: built.descriptor.collectibleCount,
          alias_count: built.descriptor.aliasCount,
          lifecycle: "complete",
        };
      },
      async findFirst() { return null; },
    },
    catalog_version_batches: {
      async findMany() {
        input.observeCatalogPayloadRead?.();
        return storedBatches;
      },
    },
    catalog_ledger: {
      async findUniqueOrThrow() { return { last_sequence: 19n }; },
    },
    provider_category_correlations: {
      async findMany() {
        return [{
          local_category_id: ids.localCategory,
          local_entity_version: 3n,
          global_category_id: ids.globalCategory,
        }];
      },
    },
    provider_collectible_correlations: {
      async findMany() {
        return [{
          local_collectible_id: ids.localCollectible,
          local_entity_version: 4n,
          global_collectible_id: ids.retiredAlias,
        }];
      },
    },
    async $queryRaw() {
      rawQueryCount += 1;
      if (rawQueryCount % 2 === 1) return [{ database_now: dataAsOf }];
      return [{
        payloadBytes: input.catalogPayloadBytes ?? storedBatches.reduce(
          (total, batch) => total +
            BigInt(Buffer.byteLength(JSON.stringify(batch.payload), "utf8")),
          0n,
        ),
      }];
    },
  };
  return {
    async $transaction(
      callback: (client: typeof transaction) => Promise<unknown>,
      options: unknown,
    ) {
      input.observeTransactionOptions?.(options);
      return callback(transaction);
    },
  } as unknown as CentralPrismaClient;
}

test("central pin verifies immutable catalog/profile hashes and flattens temporal aliases", async () => {
  const built = await artifact();
  const pin = await new ProviderReleaseCentralRepository(await fakeCentral()).pin({
    providerId: ids.provider,
    catalogVersionId: built.descriptor.catalogVersionId,
  });
  assert.equal(pin.catalogContentHash, built.descriptor.contentHash);
  assert.match(pin.catalogArtifactVerificationHash, /^[0-9a-f]{64}$/u);
  assert.equal(pin.providerConfigVersionId, ids.config);
  assert.equal(pin.providerConfigExpiresAt, null);
  assert.equal(pin.staleAfterSeconds, 3_600);
  assert.equal(pin.catalogThroughChangeSequence, 11n);
  assert.equal(pin.correlationEventSequence, 19n);
  assert.equal(pin.categoryCorrelations[0]?.publicCategoryId, globalCategoryPublicId(ids.globalCategory));
  assert.equal(pin.collectibleCorrelations[0]?.publicCollectibleId, ids.canonicalCollectible);
  assert.equal(pin.publicProvider.publicVendorId, packscoutPublicIdentityUuid(`provider:${ids.provider}`));
});

test("central pin rejects catalog bytes that do not match the complete descriptor", async () => {
  const built = await artifact();
  await assert.rejects(
    new ProviderReleaseCentralRepository(await fakeCentral({ tamperCatalog: true })).pin({
      providerId: ids.provider,
      catalogVersionId: built.descriptor.catalogVersionId,
    }),
    (error: unknown) => error instanceof ProviderReleasePinError
      && error.code === "CATALOG_ARTIFACT_INVALID",
  );
});

test("central pin rejects an oversized stored catalog before hydrating payloads", async () => {
  const built = await artifact();
  let payloadReads = 0;
  const central = await fakeCentral({
    catalogPayloadBytes:
      BigInt(PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES) + 1n,
    observeCatalogPayloadRead() {
      payloadReads += 1;
    },
  });

  await assert.rejects(
    new ProviderReleaseCentralRepository(central).pin({
      providerId: ids.provider,
      catalogVersionId: built.descriptor.catalogVersionId,
    }),
    (error: unknown) => error instanceof ProviderReleasePinError
      && error.code === "CATALOG_ARTIFACT_INVALID",
  );
  assert.equal(payloadReads, 0);
});

test("central pin rejects a missing or invalid authoritative freshness configuration", async () => {
  for (const [staleAfterSeconds, code] of [
    [null, "PROVIDER_CONFIG_MISSING"],
    [0, "PROVIDER_CONFIG_INVALID"],
    [604_801, "PROVIDER_CONFIG_INVALID"],
  ] as const) {
    await assert.rejects(
      new ProviderReleaseCentralRepository(await fakeCentral({ staleAfterSeconds })).pin({
        providerId: ids.provider,
      }),
      (error: unknown) => error instanceof ProviderReleasePinError
        && error.code === code,
    );
  }
  await assert.rejects(
    new ProviderReleaseCentralRepository(await fakeCentral({
      configExpiresAt: new Date(dataAsOf.getTime() - 1),
    })).pin({ providerId: ids.provider }),
    (error: unknown) => error instanceof ProviderReleasePinError
      && error.code === "PROVIDER_CONFIG_INVALID",
  );
});

test("central pin rejects a database with the wrong authoritative role or schema", async () => {
  for (const central of [
    await fakeCentral({ identityRole: "provider" }),
    await fakeCentral({ identitySchemaVersion: "distributed-central-v0" }),
  ]) {
    await assert.rejects(
      new ProviderReleaseCentralRepository(central).pin({ providerId: ids.provider }),
      (error: unknown) => error instanceof ProviderReleasePinError
        && error.code === "CENTRAL_IDENTITY_INVALID",
    );
  }
});

test("central pin preserves defaults and bounds an owned transaction to remaining time", async () => {
  const built = await artifact();
  const observed: Record<string, unknown>[] = [];
  const central = await fakeCentral({
    observeTransactionOptions(options) {
      observed.push(options as Record<string, unknown>);
    },
  });
  const now = 1_000;
  const repository = new ProviderReleaseCentralRepository(central, () => now);
  await repository.pin({
    providerId: ids.provider,
    catalogVersionId: built.descriptor.catalogVersionId,
  });
  await repository.pin({
    providerId: ids.provider,
    catalogVersionId: built.descriptor.catalogVersionId,
    deadlineAt: now + 10_000,
  });

  assert.deepEqual(observed[0], {
    maxWait: 5_000,
    timeout: 60_000,
    isolationLevel: "RepeatableRead",
  });
  assert.equal(observed[1]?.maxWait, 1_990);
  assert.equal(observed[1]?.timeout, 7_960);
  assert.equal(
    Number(observed[1]?.maxWait) + Number(observed[1]?.timeout),
    9_950,
  );
});

test("central pin stops awaiting an in-flight transaction when ownership aborts", async () => {
  let transactionStarted!: () => void;
  const started = new Promise<void>((resolve) => { transactionStarted = resolve; });
  const central = {
    $transaction() {
      transactionStarted();
      return new Promise<never>(() => {});
    },
  } as unknown as CentralPrismaClient;
  const controller = new AbortController();
  const repository = new ProviderReleaseCentralRepository(central);
  const pending = repository.pin({
    providerId: ids.provider,
    signal: controller.signal,
    deadlineAt: Date.now() + 30_000,
  });
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof ProviderReleasePinError &&
    error.code === "PROVIDER_RELEASE_PIN_CANCELLED");
});
