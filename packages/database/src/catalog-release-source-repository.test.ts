import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  ApprovedPublicCatalogConfigurationPersistenceError,
  PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
  PrismaCatalogReleaseSourceRepository,
} from "./catalog-release-source-repository.ts";
import {
  prismaApprovedPublicRepackIdentityMaterializer as materializer,
} from "./public-repack-identity-mapping-repository.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "81000000-0000-4000-8000-000000000001";
const publicVendorId = "81111111-1111-5111-8111-111111111111";
const publicCategoryId = "81222222-2222-5222-8222-222222222222";
const publicRepackId = "81333333-3333-5333-8333-333333333333";

async function registerVendor(
  database: Awaited<ReturnType<typeof createMigratedTestDatabase>>["client"],
): Promise<void> {
  await database.provider_sources.create({
    data: {
      organization_id: organizationId,
      platform_key: "vendor",
      display_name: "Vendor",
    },
  });
}

function configuration(overrides: {
  revision?: number;
  configurationKey?: string;
  repacks?: ApprovedPublicCatalogConfigurationV1["repacks"];
} = {}): ApprovedPublicCatalogConfigurationV1 {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: overrides.configurationKey ?? "catalog-r1",
    revision: overrides.revision ?? 1,
    approvedAt: "2026-08-15T01:00:00.000Z",
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: ["https://vendor.example"],
    verifiedUsdStablecoins: [],
    categories: [{
      publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [publicCategoryId],
      displayOrder: 0,
    }],
    platforms: [{
      platformKey: "vendor",
      vendor: {
        publicVendorId,
        vendorKey: "vendor",
        displayName: "Vendor",
        logoUrl: null,
        websiteUrl: "https://vendor.example",
        listingHosts: ["vendor.example"],
        imageOrigins: ["https://vendor.example"],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: overrides.repacks ?? [{
      platformKey: "vendor",
      packExternalId: "pack-1",
      publicRepackId,
    }],
    collectibles: [],
  };
}

test("configuration approval, governed identities, and settlement commit atomically and immutably", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "public-catalog", name: "Public Catalog" },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    );
    const approved = await repository.approveConfiguration(configuration(), materializer);
    assert.equal(approved.publicChangeSequence, 1n);
    assert.equal(await harness.client.approved_public_catalog_configurations.count(), 1);
    assert.equal(await harness.client.public_change_causes.count(), 1);
    const mappings = await harness.client.$queryRaw<Array<{ sequence: bigint }>>(Prisma.sql`
      select public_change_sequence as sequence
      from public.public_repack_identity_mappings
    `);
    assert.deepEqual(mappings, [{ sequence: 1n }]);
    assert.equal(
      (await harness.client.settled_public_watermarks.findUniqueOrThrow({
        where: { organization_id: organizationId },
      })).settled_sequence,
      1n,
    );
    await assert.rejects(
      harness.client.approved_public_catalog_configurations.update({
        where: { id: approved.id },
        data: { configuration_hash: "b".repeat(64) },
      }),
      /immutable/i,
    );
    await assert.rejects(
      repository.approveConfiguration(
        configuration({ revision: 2, configurationKey: "catalog-r2" }),
        { async materializeApprovedMappings() { throw new Error("mapping write failed"); } },
      ),
      /mapping write failed/,
    );
    assert.equal(await harness.client.approved_public_catalog_configurations.count(), 1);
    assert.equal(await harness.client.public_change_causes.count(), 1);

    const second = await repository.approveConfiguration(
      configuration({ revision: 2, configurationKey: "catalog-r2" }),
      materializer,
    );
    const preservedMappings = await harness.client.$queryRaw<Array<{
      approvedConfigurationKey: string;
      sequence: bigint;
    }>>(Prisma.sql`
      select approved_configuration_key as "approvedConfigurationKey",
             public_change_sequence as sequence
      from public.public_repack_identity_mappings
    `);
    assert.deepEqual(preservedMappings, [{
      approvedConfigurationKey: "catalog-r1",
      sequence: 1n,
    }]);
    const latest = await repository.loadSnapshot({
      throughSequence: second.publicChangeSequence,
      throughOccurredAt: new Date("2026-08-15T02:00:00.000Z"),
    });
    assert.equal(latest.configuration?.configuration.configurationKey, "catalog-r2");
    assert.equal(latest.repackIdentities[0]?.approvedConfigurationKey, "catalog-r1");
  } finally {
    await harness.close();
  }
});

test("configuration approval rejects an unregistered or ninth platform before allocating a cause", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "configuration-platform-boundary",
        name: "Configuration Platform Boundary",
      },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    );
    const unregistered = structuredClone(configuration());
    unregistered.platforms[0]!.platformKey = "unregistered";
    unregistered.platforms[0]!.vendor.vendorKey = "unregistered";
    unregistered.repacks[0]!.platformKey = "unregistered";
    await assert.rejects(
      repository.approveConfiguration(unregistered, materializer),
      (error: unknown) =>
        error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
        error.code === "PUBLIC_CONFIGURATION_PLATFORM_UNREGISTERED",
    );

    const ninth = structuredClone(configuration());
    ninth.platforms = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(ninth.platforms[0]!),
      platformKey: `vendor-${index + 1}`,
      vendor: {
        ...structuredClone(ninth.platforms[0]!.vendor),
        publicVendorId: `81111111-1111-5111-8111-11111111111${index + 1}`,
        vendorKey: `vendor_${index + 1}`,
      },
    }));
    await assert.rejects(
      repository.approveConfiguration(ninth, materializer),
      (error: unknown) =>
        error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
        error.code === "PUBLIC_CONFIGURATION_PLATFORM_LIMIT_EXCEEDED",
    );
    assert.equal(await harness.client.public_change_causes.count(), 0);
    assert.equal(
      await harness.client.approved_public_catalog_configurations.count(),
      0,
    );
  } finally {
    await harness.close();
  }
});

test("configuration approval compares registered platform keys in canonical byte order", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "configuration-platform-order",
        name: "Configuration Platform Order",
      },
    });
    const platformKeys = ["a-1", "a_1"] as const;
    await harness.client.provider_sources.createMany({
      data: platformKeys.map((platformKey) => ({
        organization_id: organizationId,
        platform_key: platformKey,
        display_name: platformKey,
      })),
    });
    const input = configuration();
    input.publicAssetOrigins = platformKeys.map(
      (platformKey) => `https://${platformKey}.example`,
    );
    input.platforms = platformKeys.map((platformKey, index) => ({
      ...structuredClone(input.platforms[0]!),
      platformKey,
      vendor: {
        ...structuredClone(input.platforms[0]!.vendor),
        publicVendorId:
          `82111111-1111-5111-8111-${String(index + 1).padStart(12, "0")}`,
        vendorKey: platformKey,
        displayName: platformKey,
        websiteUrl: `https://${platformKey}.example`,
        listingHosts: [`${platformKey}.example`],
        imageOrigins: [`https://${platformKey}.example`],
      },
    }));
    input.repacks[0]!.platformKey = platformKeys[0];

    const approved = await new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    ).approveConfiguration(input, materializer);
    const impact = await harness.client.public_change_catalog_impacts.findUniqueOrThrow({
      where: {
        organization_id_cause_sequence: {
          organization_id: organizationId,
          cause_sequence: approved.publicChangeSequence,
        },
      },
    });
    assert.deepEqual(impact.provider_platform_keys, platformKeys);
  } finally {
    await harness.close();
  }
});

test("readiness is tied to the active causal provider revision, not an old completed backfill", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "revision-readiness", name: "Revision Readiness" },
    });
    const providerId = randomUUID();
    const oldRevisionId = randomUUID();
    const activeRevisionId = randomUUID();
    await harness.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "vendor",
        display_name: "Vendor",
      },
    });
    for (const [id, version] of [[oldRevisionId, 1], [activeRevisionId, 2]] as const) {
      await harness.client.provider_config_revisions.create({
        data: {
          id,
          organization_id: organizationId,
          provider_id: providerId,
          version,
          adapter_key: "http-cursor-v1",
          endpoint_url: "https://vendor.example/feed",
          auth_mode: "none",
          created_by_actor_key: "operator:test",
        },
      });
    }
    await harness.client.provider_sources.update({
      where: { id: providerId },
      data: { state: "active", active_revision_id: activeRevisionId },
    });
    const backfillAt = new Date("2026-08-15T01:10:00.000Z");
    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: oldRevisionId,
        trigger: "manual",
        state: "succeeded",
        started_at: new Date("2026-08-15T01:05:00.000Z"),
        finished_at: backfillAt,
        reached_provider_head: true,
        requested_by_actor_key: "operator:test",
      },
    });
    const repository = new PrismaCatalogReleaseSourceRepository(harness.client, organizationId);
    const approved = await repository.approveConfiguration(configuration(), materializer);
    const [lifecycle] = await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "public_configuration",
          entityKey: `provider:v1:${providerId}`,
          sourceKey: "vendor",
          sourceRevisionKey: activeRevisionId,
          metadata: {
            platformKey: "vendor",
            state: "active",
            configurationRevisionId: activeRevisionId,
          },
          occurredAt: new Date("2026-08-15T01:20:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["vendor"],
            manifestLifecycle: { platformKey: "vendor", state: "active" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-15T01:20:00.000Z"),
      });
      return causes;
    });
    const snapshot = await repository.loadSnapshot({
      throughSequence: lifecycle!.sequence,
      throughOccurredAt: new Date("2026-08-15T01:20:00.000Z"),
    });
    assert.equal(snapshot.configuration?.id, approved.id);
    assert.equal(snapshot.providers[0]?.configurationRevisionId, activeRevisionId);
    assert.equal(snapshot.providers[0]?.completedBackfillAt, null);
  } finally {
    await harness.close();
  }
});

test("the occurred_at bound is opt-in: omitting it selects the whole sequence prefix", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "occurred-at-bound",
        name: "Occurred At Bound",
      },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    );
    const secondRepack = {
      platformKey: "vendor",
      packExternalId: "pack-2",
      publicRepackId: "81444444-4444-5444-8444-444444444444",
    } as const;
    const first = await repository.approveConfiguration(
      configuration(),
      materializer,
    );
    // Approved from an operator-supplied time an hour past the read clock
    // below, while holding the higher sequence: exactly the shape a sequence
    // prefix cannot separate from a genuinely earlier change.
    const ahead = configuration({
      revision: 2,
      configurationKey: "catalog-r2",
      repacks: [...configuration().repacks, secondRepack],
    });
    const second = await repository.approveConfiguration(
      { ...ahead, approvedAt: "2026-08-15T03:00:00.000Z" },
      materializer,
    );
    assert.ok(second.publicChangeSequence > first.publicChangeSequence);
    const readAt = new Date("2026-08-15T02:00:00.000Z");

    // v2 shape: a settled prefix and no bound. Byte for byte the prior read.
    const prefix = await repository.loadSnapshot({
      throughSequence: second.publicChangeSequence,
      throughOccurredAt: readAt,
    });
    assert.equal(prefix.configuration?.configuration.configurationKey, "catalog-r2");
    assert.deepEqual(
      prefix.repackIdentities.map(({ packExternalId }) => packExternalId),
      ["pack-1", "pack-2"],
    );

    // v3 shape: the same prefix, bounded on each row's own cause time.
    const bounded = await repository.loadSnapshot({
      throughSequence: second.publicChangeSequence,
      throughOccurredAt: readAt,
      occurredAtBound: readAt,
    });
    assert.equal(bounded.configuration?.configuration.configurationKey, "catalog-r1");
    assert.equal(bounded.configuration?.publicChangeSequence, first.publicChangeSequence);
    assert.deepEqual(
      bounded.repackIdentities.map(({ packExternalId }) => packExternalId),
      ["pack-1"],
    );
  } finally {
    await harness.close();
  }
});

async function waitForBlockedProviderRead(database: {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%from public.provider_sources provider%'
      ) as blocked
    `);
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("snapshot provider read did not block");
}

test("one repeatable-read snapshot cannot mix a newer configuration mapping into older source state", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "snapshot-coherence", name: "Snapshot Coherence" },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(harness.client, organizationId);
    await repository.approveConfiguration(configuration(), materializer);
    const writer = await harness.createIndependentClient();
    const observer = await harness.createIndependentClient();
    let releaseWriter!: () => void;
    let writerLocked!: () => void;
    const held = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const locked = new Promise<void>((resolve) => { writerLocked = resolve; });
    const secondRepack = {
      platformKey: "vendor",
      packExternalId: "pack-2",
      publicRepackId: "81444444-4444-5444-8444-444444444444",
    } as const;
    const writerPromise = writer.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        lock table public.provider_sources in access exclusive mode
      `);
      writerLocked();
      await held;
      const second = configuration({
        revision: 2,
        configurationKey: "catalog-r2",
        repacks: [...configuration().repacks, secondRepack],
      });
      const hash = await sha256CanonicalJson(
        PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
        second,
      );
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "public_configuration",
          entityKey: "public-catalog-configuration:v1:catalog-r2",
          sourceKey: "packscout-public-catalog",
          sourceRevisionKey: "catalog-r2",
          metadata: { configurationKey: "catalog-r2", revision: 2, configurationHash: hash },
          occurredAt: new Date("2026-08-15T02:00:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["vendor"],
            sharedConfigurationEpoch: {
              configurationKey: "catalog-r2",
              revision: 2,
              configurationHash: hash,
            },
          },
        }],
      });
      await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: organizationId,
          configuration_key: second.configurationKey,
          revision: second.revision,
          configuration_json: second as Prisma.InputJsonValue,
          configuration_hash: hash,
          approved_at: new Date(second.approvedAt),
          public_change_sequence: cause!.sequence,
        },
      });
      await materializer.materializeApprovedMappings(transaction, {
        organizationId,
        approvedConfigurationKey: second.configurationKey,
        publicChangeSequence: cause!.sequence,
        approvedAt: new Date(second.approvedAt),
        mappings: [secondRepack],
      });
    });
    await locked;
    const snapshotPromise = repository.loadSnapshot({
      throughSequence: 2n,
      throughOccurredAt: new Date("2026-08-15T02:00:00.000Z"),
    });
    await waitForBlockedProviderRead(observer);
    releaseWriter();
    await writerPromise;
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.configuration?.configuration.revision, 1);
    assert.deepEqual(
      snapshot.repackIdentities.map(({ packExternalId }) => packExternalId),
      ["pack-1"],
    );
  } finally {
    await harness.close();
  }
});
