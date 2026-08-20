import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  containsProtectedPublicationField,
  type ApprovedPublicCatalogConfigurationV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import {
  PrismaCatalogReleaseSourceRepository,
} from "./catalog-release-source-repository.ts";
import {
  PrismaProviderCatalogReleaseSourceRepository,
  ProviderCatalogReleaseSourcePersistenceError,
} from "./provider-catalog-release-source-repository.ts";
import {
  PrismaProviderCatalogSettlementRepository,
  type ProviderCatalogCheckpointRecord,
} from "./public-change-settlement-repository.provider-read.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";
import {
  prismaApprovedPublicRepackIdentityMaterializer as identityMaterializer,
} from "./public-repack-identity-mapping-repository.ts";
import { hashJson } from "./security.ts";
import {
  createMigratedTestDatabase,
  type MigratedTestDatabase,
} from "./test-support.ts";

const organizationId = "8a000000-0000-4000-8000-000000000001";
const alphaProviderId = "8a000000-0000-4000-8000-000000000010";
const betaProviderId = "8a000000-0000-4000-8000-000000000011";
const alphaRevisionId = "8a000000-0000-4000-8000-000000000020";
const betaRevisionId = "8a000000-0000-4000-8000-000000000021";
const shadowOrganizationId = "8b000000-0000-4000-8000-000000000001";
const shadowProviderId = "8b000000-0000-4000-8000-000000000010";
const shadowRevisionId = "8b000000-0000-4000-8000-000000000020";
const categoryId = "8a000000-0000-5000-8000-000000000030";
const observedAt = new Date("2026-08-16T10:10:00.000Z");
const lifecycleAt = new Date("2026-08-16T10:20:00.000Z");
const settledAt = new Date("2026-08-16T10:40:00.000Z");

const repackIds = {
  alphaDash: "8a000000-0000-5000-8000-000000000040",
  alphaUnderscore: "8a000000-0000-5000-8000-000000000041",
  beta: "8a000000-0000-5000-8000-000000000042",
} as const;

function approvedConfiguration(): ApprovedPublicCatalogConfigurationV1 {
  const platform = (platformKey: "alpha" | "beta", vendorId: string) => ({
    platformKey,
    vendor: {
      publicVendorId: vendorId,
      vendorKey: platformKey,
      displayName: platformKey.toUpperCase(),
      logoUrl: null,
      websiteUrl: `https://${platformKey}.example`,
      listingHosts: [`${platformKey}.example`],
      imageOrigins: [`https://${platformKey}.example`],
      referralParameters: [],
      publicPromo: null,
    },
    format: "repack" as const,
    defaultPublicCategoryIds: [categoryId],
    categoryMappings: [],
    collectibleTypeMappings: [],
  });
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "provider-release-epoch-1",
    revision: 1,
    approvedAt: "2026-08-16T10:00:00.000Z",
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: ["https://alpha.example", "https://beta.example"],
    verifiedUsdStablecoins: ["USDC"],
    categories: [{
      publicCategoryId: categoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [categoryId],
      displayOrder: 0,
    }],
    platforms: [
      platform("alpha", "8a000000-0000-5000-8000-000000000050"),
      platform("beta", "8a000000-0000-5000-8000-000000000051"),
    ],
    repacks: [
      {
        platformKey: "alpha",
        packExternalId: "a-1",
        publicRepackId: repackIds.alphaDash,
      },
      {
        platformKey: "alpha",
        packExternalId: "a_1",
        publicRepackId: repackIds.alphaUnderscore,
      },
      {
        platformKey: "beta",
        packExternalId: "beta-pack",
        publicRepackId: repackIds.beta,
      },
    ],
    collectibles: [{
      platformKey: "beta",
      externalId: "beta-only-collectible",
      publicCollectibleId: "8a000000-0000-5000-8000-000000000060",
      aliases: [],
      collectibleType: "card",
      publicCategoryIds: [categoryId],
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      probabilityBucketId: null,
      matchConfidenceBasisPoints: 10_000,
      chaseEvidenceKinds: ["vendor_inventory"],
    }],
  };
}

function packContent(name: string, protectedField = false): unknown {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "pack",
    parentExternalId: null,
    name,
    category: "Cards",
    description: null,
    availability: "active",
    sourceStatus: "available",
    priceValueMinor: 1_000,
    priceCurrency: "USD",
    providerReportedEvValueMinor: null,
    providerReportedEvCurrency: null,
    buybackPercent: null,
    drawCount: 1,
    imageUrls: [],
    dataQualityEvidence: [],
    ...(protectedField ? { rawPayload: { credential: "must-not-leak" } } : {}),
  };
}

interface SeedOptions {
  readonly alphaBackfillComplete?: boolean;
  readonly alphaProtectedContent?: boolean;
}

interface SeededProviderRelease {
  readonly checkpointAlpha: ProviderCatalogCheckpointRecord;
  readonly checkpointBeta: ProviderCatalogCheckpointRecord;
  readonly alphaRepository: PrismaProviderCatalogReleaseSourceRepository;
  readonly alphaRunId: string;
  readonly alphaPageId: string;
}

async function seedProviderRelease(
  harness: MigratedTestDatabase,
  options: SeedOptions = {},
): Promise<SeededProviderRelease> {
  await harness.client.organizations.create({
    data: {
      id: organizationId,
      slug: "provider-release-source",
      name: "Provider Release Source",
    },
  });
  await harness.client.provider_sources.createMany({
    data: [
      {
        id: alphaProviderId,
        organization_id: organizationId,
        platform_key: "alpha",
        display_name: "Alpha",
        state: "active",
      },
      {
        id: betaProviderId,
        organization_id: organizationId,
        platform_key: "beta",
        display_name: "Beta",
        state: "active",
      },
    ],
  });
  await harness.client.provider_config_revisions.createMany({
    data: [
      {
        id: alphaRevisionId,
        organization_id: organizationId,
        provider_id: alphaProviderId,
        version: 1,
        adapter_key: "http-cursor-v1",
        endpoint_url: "https://alpha.example/feed",
        auth_mode: "bearer",
        created_by_actor_key: "protected-alpha-actor",
      },
      {
        id: betaRevisionId,
        organization_id: organizationId,
        provider_id: betaProviderId,
        version: 1,
        adapter_key: "http-cursor-v1",
        endpoint_url: "https://beta.example/feed",
        auth_mode: "bearer",
        created_by_actor_key: "protected-beta-actor",
      },
    ],
  });
  await Promise.all([
    harness.client.provider_sources.update({
      where: { id: alphaProviderId },
      data: { active_revision_id: alphaRevisionId },
    }),
    harness.client.provider_sources.update({
      where: { id: betaProviderId },
      data: { active_revision_id: betaRevisionId },
    }),
  ]);

  await new PrismaCatalogReleaseSourceRepository(
    harness.client,
    organizationId,
  ).approveConfiguration(approvedConfiguration(), identityMaterializer);

  const alphaRunId = randomUUID();
  const betaRunId = randomUUID();
  const alphaPageId = randomUUID();
  const betaPageId = randomUUID();
  await harness.client.import_runs.createMany({
    data: [
      {
        id: alphaRunId,
        organization_id: organizationId,
        provider_id: alphaProviderId,
        config_revision_id: alphaRevisionId,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date("2026-08-16T10:05:00.000Z"),
        finished_at: observedAt,
        reached_provider_head: options.alphaBackfillComplete ?? true,
      },
      {
        id: betaRunId,
        organization_id: organizationId,
        provider_id: betaProviderId,
        config_revision_id: betaRevisionId,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date("2026-08-16T10:05:00.000Z"),
        finished_at: observedAt,
        reached_provider_head: true,
      },
    ],
  });
  await harness.client.import_pages.createMany({
    data: [
      {
        id: alphaPageId,
        organization_id: organizationId,
        provider_id: alphaProviderId,
        run_id: alphaRunId,
        page_number: 1,
        has_more: false,
        payload_hash: "a".repeat(64),
        record_counts_json: {},
        expires_at: new Date("2026-11-16T10:00:00.000Z"),
      },
      {
        id: betaPageId,
        organization_id: organizationId,
        provider_id: betaProviderId,
        run_id: betaRunId,
        page_number: 1,
        has_more: false,
        payload_hash: "b".repeat(64),
        record_counts_json: {},
        expires_at: new Date("2026-11-16T10:00:00.000Z"),
      },
    ],
  });

  const revisionInputs = [
    {
      platformKey: "alpha",
      providerId: alphaProviderId,
      configurationRevisionId: alphaRevisionId,
      runId: alphaRunId,
      pageId: alphaPageId,
      externalId: "a_1",
      content: packContent("Alpha underscore"),
    },
    {
      platformKey: "alpha",
      providerId: alphaProviderId,
      configurationRevisionId: alphaRevisionId,
      runId: alphaRunId,
      pageId: alphaPageId,
      externalId: "a-1",
      content: packContent(
        "Alpha dash",
        options.alphaProtectedContent ?? false,
      ),
    },
    {
      platformKey: "beta",
      providerId: betaProviderId,
      configurationRevisionId: betaRevisionId,
      runId: betaRunId,
      pageId: betaPageId,
      externalId: "beta-pack",
      content: packContent("Beta protected", true),
    },
  ] as const;
  const sourceRecords = revisionInputs.map((input, index) => ({
    id: randomUUID(),
    organization_id: organizationId,
    provider_id: input.providerId,
    first_run_id: input.runId,
    first_page_id: input.pageId,
    record_kind: "catalog" as const,
    external_id: input.externalId,
    source_time: new Date(observedAt.getTime() + index * 1_000),
    collected_at: new Date(observedAt.getTime() + index * 1_000),
    payload_json: {
      rawPayload: input.platformKey === "beta" ? "beta-secret" : "alpha-raw",
    },
    content_hash: hashJson(input.content),
    expires_at: new Date("2026-11-16T10:00:00.000Z"),
  }));
  await harness.client.source_records.createMany({ data: sourceRecords });

  await harness.client.$transaction(async (transaction) => {
    await allocatePublicChangeCauses(transaction, {
      organizationId,
      changes: [
        {
          changeKind: "provider_lifecycle",
          entityKey: `provider:v1:${alphaProviderId}`,
          sourceKey: "alpha",
          sourceRevisionKey: alphaRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "active",
            configurationRevisionId: alphaRevisionId,
          },
          occurredAt: lifecycleAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
            manifestLifecycle: { platformKey: "alpha", state: "active" },
          },
        },
        {
          changeKind: "provider_lifecycle",
          entityKey: `provider:v1:${betaProviderId}`,
          sourceKey: "beta",
          sourceRevisionKey: betaRevisionId,
          metadata: {
            providerId: betaProviderId,
            platformKey: "beta",
            state: "active",
            configurationRevisionId: betaRevisionId,
          },
          occurredAt: lifecycleAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["beta"],
            manifestLifecycle: { platformKey: "beta", state: "active" },
          },
        },
      ],
    });
    await advanceSettledPublicWatermark(transaction, {
      organizationId,
      settledAt: lifecycleAt,
    });
  });

  await harness.client.$transaction(async (transaction) => {
    const causes = await allocatePublicChangeCauses(transaction, {
      organizationId,
      changes: revisionInputs.map((input, index) => ({
        changeKind: "provider_projection" as const,
        entityKey: `canonical:v1:${input.platformKey}:pack:${input.externalId}`,
        sourceKey: input.platformKey,
        sourceRevisionKey: input.configurationRevisionId,
        occurredAt: new Date("2026-08-16T10:30:00.000Z"),
        authoritativeTransactionId: `provider-release-fixture-${index}`,
        catalogImpact: {
          kind: "catalog" as const,
          providerPlatformKeys: [input.platformKey],
        },
      })),
    });
    for (const [index, input] of revisionInputs.entries()) {
      const entityId = randomUUID();
      const revisionId = randomUUID();
      await transaction.canonical_entities.create({
        data: {
          id: entityId,
          organization_id: organizationId,
          platform_key: input.platformKey,
          record_kind: "pack",
          external_id: input.externalId,
        },
      });
      await transaction.canonical_revisions.create({
        data: {
          id: revisionId,
          organization_id: organizationId,
          entity_id: entityId,
          revision_number: 1,
          source_record_id: sourceRecords[index]!.id,
          content_json: input.content as Prisma.InputJsonValue,
          content_hash: hashJson(input.content),
          provenance_json: {
            providerId: input.providerId,
            internalRunId: input.runId,
          },
          provenance_hash: hashJson({
            providerId: input.providerId,
            internalRunId: input.runId,
          }),
          actor_key: "protected-projection-actor",
          source_updated_at: sourceRecords[index]!.source_time,
          source_collected_at: sourceRecords[index]!.collected_at,
          accepted_at: sourceRecords[index]!.collected_at,
          public_change_sequence: causes[index]!.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: entityId },
        data: { current_revision_id: revisionId },
      });
    }
    await advanceSettledPublicWatermark(transaction, {
      organizationId,
      settledAt,
    });
  });

  const settlement = new PrismaProviderCatalogSettlementRepository(
    harness.client,
  );
  const checkpointAlpha = await settlement.loadProviderCatalogCheckpoint({
    organizationId,
    platformKey: "alpha",
  });
  const checkpointBeta = await settlement.loadProviderCatalogCheckpoint({
    organizationId,
    platformKey: "beta",
  });
  assert.ok(checkpointAlpha);
  assert.ok(checkpointBeta);
  return {
    checkpointAlpha,
    checkpointBeta,
    alphaRepository: new PrismaProviderCatalogReleaseSourceRepository(
      harness.client,
      { organizationId, platformKey: "alpha" },
    ),
    alphaRunId,
    alphaPageId,
  };
}

function assertSourceError(
  code: ProviderCatalogReleaseSourcePersistenceError["code"],
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ProviderCatalogReleaseSourcePersistenceError);
    assert.equal(error.code, code);
    assert.equal(
      error.message,
      "Provider catalog release source state is unavailable or invalid.",
    );
    return true;
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate);
}

test("provider snapshot is deterministic, C-ordered, sanitized, and isolated from malformed provider B", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const first = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: fixture.checkpointAlpha,
    });
    const second = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: fixture.checkpointAlpha,
    });

    assert.equal(stable(first), stable(second));
    assert.deepEqual(
      first.revisions.map(({ externalId }) => externalId),
      ["a-1", "a_1"],
    );
    assert.deepEqual(
      first.repackIdentities.map(({ packExternalId }) => packExternalId),
      ["a-1", "a_1"],
    );
    assert.equal(first.configuration.platform.platformKey, "alpha");
    assert.deepEqual(first.configuration.verifiedUsdStablecoins, ["USDC"]);
    assert.deepEqual(
      first.configuration.repacks.map(({ platformKey }) => platformKey),
      ["alpha", "alpha"],
    );
    assert.deepEqual(first.configuration.collectibles, []);
    assert.ok(first.revisions.every(({ platformKey }) => platformKey === "alpha"));
    assert.ok(first.repackIdentities.every(
      ({ platformKey }) => platformKey === "alpha",
    ));
    assert.equal(first.observation.lastSuccessfulObservationAt.toISOString(),
      observedAt.toISOString());
    assert.equal(containsProtectedPublicationField(first), false);
    assert.equal(stable(first).includes("beta-secret"), false);
    assert.equal(stable(first).includes("protected-alpha-actor"), false);
    assert.equal("organizationId" in first.checkpoint, false);
  } finally {
    await harness.close();
  }
});

async function waitForConfigurationReadToBlock(
  database: MigratedTestDatabase["client"],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%from public.catalog_manifest_lifecycle_checkpoints%'
      ) as blocked
    `);
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider snapshot configuration read did not block");
}

test("repeatable-read snapshot keeps historical lifecycle revision when a later activation commits concurrently", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const writer = await harness.createIndependentClient();
    const observer = await harness.createIndependentClient();
    const laterRevisionId = randomUUID();
    let releaseWriter!: () => void;
    let writerLocked!: () => void;
    const held = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const locked = new Promise<void>((resolve) => { writerLocked = resolve; });
    const writerPromise = writer.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        lock table public.public_change_catalog_impacts in access exclusive mode
      `);
      writerLocked();
      await held;
      await transaction.provider_config_revisions.create({
        data: {
          id: laterRevisionId,
          organization_id: organizationId,
          provider_id: alphaProviderId,
          version: 2,
          adapter_key: "http-cursor-v2",
          endpoint_url: "https://alpha.example/feed-v2",
          auth_mode: "bearer",
          created_by_actor_key: "later-protected-actor",
        },
      });
      await transaction.provider_sources.update({
        where: { id: alphaProviderId },
        data: { active_revision_id: laterRevisionId },
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: `provider:v2:${alphaProviderId}`,
          sourceKey: "alpha",
          sourceRevisionKey: laterRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "active",
            configurationRevisionId: laterRevisionId,
          },
          occurredAt: new Date("2026-08-16T11:00:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
            manifestLifecycle: { platformKey: "alpha", state: "active" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-16T11:00:00.000Z"),
      });
    });
    await locked;
    const snapshotPromise = fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: fixture.checkpointAlpha,
    });
    await waitForConfigurationReadToBlock(observer);
    releaseWriter();
    await writerPromise;

    const snapshot = await snapshotPromise;
    assert.equal(snapshot.readiness.configurationRevisionId, alphaRevisionId);
    assert.equal(
      snapshot.checkpoint.settledSequence,
      fixture.checkpointAlpha.settledSequence,
    );
    const current = await new PrismaProviderCatalogSettlementRepository(
      harness.client,
    ).loadProviderCatalogCheckpoint({ organizationId, platformKey: "alpha" });
    assert.ok(current);
    assert.ok(current.settledSequence > fixture.checkpointAlpha.settledSequence);
  } finally {
    await harness.close();
  }
});

test("checkpoint scope, settlement, regression, epoch, and backfill guards fail closed", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: fixture.checkpointBeta,
      }),
      assertSourceError("PROVIDER_RELEASE_SCOPE_MISMATCH"),
    );
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: {
          ...fixture.checkpointAlpha,
          sourceHeadSequence: fixture.checkpointAlpha.sourceHeadSequence + 1n,
          blockedState: {
            kind: "blocked",
            reason: "pending_derivation",
            causeSequence: fixture.checkpointAlpha.sourceHeadSequence + 1n,
          },
        },
      }),
      assertSourceError("PROVIDER_RELEASE_CHECKPOINT_UNSETTLED"),
    );
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: {
          ...fixture.checkpointAlpha,
          sharedConfigurationEpoch: {
            ...fixture.checkpointAlpha.sharedConfigurationEpoch,
            configurationHash: "f".repeat(64),
          },
        },
      }),
      assertSourceError("PROVIDER_RELEASE_EPOCH_MISMATCH"),
    );

    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "manual_correction",
          entityKey: "canonical:v1:alpha:later",
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T11:10:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-16T11:10:00.000Z"),
      });
    });
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: fixture.checkpointAlpha,
      }),
      assertSourceError("PROVIDER_RELEASE_CHECKPOINT_REGRESSED"),
    );
  } finally {
    await harness.close();
  }

  const incompleteHarness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(incompleteHarness, {
      alphaBackfillComplete: false,
    });
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: fixture.checkpointAlpha,
      }),
      assertSourceError("PROVIDER_RELEASE_BACKFILL_INCOMPLETE"),
    );
  } finally {
    await incompleteHarness.close();
  }
});

test("settled disable blocks assembly without advancing the provider checkpoint", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: `provider:disable:${alphaProviderId}`,
          sourceKey: "alpha",
          sourceRevisionKey: alphaRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "disabled",
            configurationRevisionId: alphaRevisionId,
          },
          occurredAt: new Date("2026-08-16T11:20:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: [],
            manifestLifecycle: { platformKey: "alpha", state: "disabled" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-16T11:20:00.000Z"),
      });
    });
    const afterDisable = await new PrismaProviderCatalogSettlementRepository(
      harness.client,
    ).loadProviderCatalogCheckpoint({ organizationId, platformKey: "alpha" });
    assert.ok(afterDisable);
    assert.equal(
      afterDisable.settledSequence,
      fixture.checkpointAlpha.settledSequence,
    );
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: fixture.checkpointAlpha,
      }),
      assertSourceError("PROVIDER_RELEASE_LIFECYCLE_INELIGIBLE"),
    );
  } finally {
    await harness.close();
  }
});

async function addUnrelatedPullRelationship(
  database: PackscoutTransactionClient,
  fixture: SeededProviderRelease,
): Promise<void> {
  const sourceRecordId = randomUUID();
  const entityId = randomUUID();
  const revisionId = randomUUID();
  const [cause] = await allocatePublicChangeCauses(database, {
    organizationId,
    changes: [{
      changeKind: "provider_projection",
      entityKey: "canonical:v1:alpha:pull:unrelated",
      sourceKey: "alpha",
      occurredAt: new Date("2026-08-16T10:35:00.000Z"),
      catalogImpact: { kind: "none" },
    }],
  });
  await database.source_records.create({
    data: {
      id: sourceRecordId,
      organization_id: organizationId,
      provider_id: alphaProviderId,
      first_run_id: fixture.alphaRunId,
      first_page_id: fixture.alphaPageId,
      record_kind: "pull",
      external_id: "unrelated-pull",
      source_time: observedAt,
      collected_at: observedAt,
      content_hash: "c".repeat(64),
      expires_at: new Date("2026-11-16T10:00:00.000Z"),
    },
  });
  await database.canonical_entities.create({
    data: {
      id: entityId,
      organization_id: organizationId,
      platform_key: "alpha",
      record_kind: "pull",
      external_id: "unrelated-pull",
    },
  });
  await database.canonical_revisions.create({
    data: {
      id: revisionId,
      organization_id: organizationId,
      entity_id: entityId,
      revision_number: 1,
      source_record_id: sourceRecordId,
      content_json: {},
      content_hash: "d".repeat(64),
      provenance_json: {},
      provenance_hash: "e".repeat(64),
      source_updated_at: observedAt,
      source_collected_at: observedAt,
      accepted_at: observedAt,
      public_change_sequence: cause!.sequence,
    },
  });
  await database.canonical_entities.update({
    where: { id: entityId },
    data: { current_revision_id: revisionId },
  });
  await database.canonical_relationships.create({
    data: {
      organization_id: organizationId,
      source_entity_id: entityId,
      relationship_kind: "observed_with",
      target_platform_key: "alpha",
      target_record_kind: "sale",
      target_external_id: "unresolved-sale",
      created_public_change_sequence: cause!.sequence,
    },
  });
}

async function canonicalEntityId(
  database: PackscoutTransactionClient,
  input: Readonly<{
    platformKey: string;
    recordKind: "pack" | "catalog_asset";
    externalId: string;
  }>,
): Promise<string> {
  const entity = await database.canonical_entities.findFirstOrThrow({
    where: {
      organization_id: organizationId,
      platform_key: input.platformKey,
      record_kind: input.recordKind,
      external_id: input.externalId,
    },
    select: { id: true },
  });
  return entity.id;
}

async function addCatalogRelationship(
  database: PackscoutTransactionClient,
  input: Readonly<{
    targetEntityId: string | null;
    targetPlatformKey: string;
    targetRecordKind: "pack" | "catalog_asset";
    targetExternalId: string;
    relationshipKind: string;
    catalogImpact?: "catalog" | "none";
  }>,
): Promise<void> {
  const sourceEntityId = await canonicalEntityId(database, {
    platformKey: "alpha",
    recordKind: "pack",
    externalId: "a_1",
  });
  const occurredAt = new Date("2026-08-16T11:30:00.000Z");
  const [cause] = await allocatePublicChangeCauses(database, {
    organizationId,
    changes: [{
      changeKind: "relationship_resolution",
      entityKey: `relationship:v1:${input.relationshipKind}`,
      sourceKey: "alpha",
      occurredAt,
      catalogImpact: input.catalogImpact === "none"
        ? { kind: "none" }
        : {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
    }],
  });
  await database.canonical_relationships.create({
    data: {
      organization_id: organizationId,
      source_entity_id: sourceEntityId,
      relationship_kind: input.relationshipKind,
      target_platform_key: input.targetPlatformKey,
      target_record_kind: input.targetRecordKind,
      target_external_id: input.targetExternalId,
      target_entity_id: input.targetEntityId,
      created_public_change_sequence: cause!.sequence,
      resolved_public_change_sequence: cause!.sequence,
      resolved_at: occurredAt,
    },
  });
  await advanceSettledPublicWatermark(database, {
    organizationId,
    settledAt: occurredAt,
  });
}

async function seedShadowTenantCatalogEntity(
  harness: MigratedTestDatabase,
  externalId: string,
): Promise<string> {
  const runId = randomUUID();
  const pageId = randomUUID();
  const sourceRecordId = randomUUID();
  const entityId = randomUUID();
  const revisionId = randomUUID();
  await harness.client.organizations.create({
    data: {
      id: shadowOrganizationId,
      slug: "provider-release-shadow",
      name: "Provider Release Shadow",
    },
  });
  await harness.client.provider_sources.create({
    data: {
      id: shadowProviderId,
      organization_id: shadowOrganizationId,
      platform_key: "alpha",
      display_name: "Shadow Alpha",
      state: "active",
    },
  });
  await harness.client.provider_config_revisions.create({
    data: {
      id: shadowRevisionId,
      organization_id: shadowOrganizationId,
      provider_id: shadowProviderId,
      version: 1,
      adapter_key: "http-cursor-v1",
      endpoint_url: "https://shadow.example/feed",
      auth_mode: "none",
      created_by_actor_key: "shadow-actor",
    },
  });
  await harness.client.provider_sources.update({
    where: { id: shadowProviderId },
    data: { active_revision_id: shadowRevisionId },
  });
  await harness.client.import_runs.create({
    data: {
      id: runId,
      organization_id: shadowOrganizationId,
      provider_id: shadowProviderId,
      config_revision_id: shadowRevisionId,
      trigger: "scheduled",
      state: "succeeded",
      started_at: observedAt,
      finished_at: observedAt,
      reached_provider_head: true,
    },
  });
  await harness.client.import_pages.create({
    data: {
      id: pageId,
      organization_id: shadowOrganizationId,
      provider_id: shadowProviderId,
      run_id: runId,
      page_number: 1,
      has_more: false,
      payload_hash: "9".repeat(64),
      record_counts_json: {},
      expires_at: new Date("2026-11-16T10:00:00.000Z"),
    },
  });
  await harness.client.$transaction(async (transaction) => {
    const [cause] = await allocatePublicChangeCauses(transaction, {
      organizationId: shadowOrganizationId,
      changes: [{
        changeKind: "provider_projection",
        entityKey: `canonical:v1:alpha:pack:${externalId}`,
        sourceKey: "alpha",
        occurredAt: observedAt,
        catalogImpact: {
          kind: "catalog",
          providerPlatformKeys: ["alpha"],
        },
      }],
    });
    const content = packContent("Tenant shadow");
    await transaction.source_records.create({
      data: {
        id: sourceRecordId,
        organization_id: shadowOrganizationId,
        provider_id: shadowProviderId,
        first_run_id: runId,
        first_page_id: pageId,
        record_kind: "catalog",
        external_id: externalId,
        source_time: observedAt,
        collected_at: observedAt,
        content_hash: hashJson(content),
        expires_at: new Date("2026-11-16T10:00:00.000Z"),
      },
    });
    await transaction.canonical_entities.create({
      data: {
        id: entityId,
        organization_id: shadowOrganizationId,
        platform_key: "alpha",
        record_kind: "pack",
        external_id: externalId,
      },
    });
    await transaction.canonical_revisions.create({
      data: {
        id: revisionId,
        organization_id: shadowOrganizationId,
        entity_id: entityId,
        revision_number: 1,
        source_record_id: sourceRecordId,
        content_json: content as Prisma.InputJsonValue,
        content_hash: hashJson(content),
        provenance_json: {},
        provenance_hash: hashJson({}),
        source_updated_at: observedAt,
        source_collected_at: observedAt,
        accepted_at: observedAt,
        public_change_sequence: cause!.sequence,
      },
    });
    await transaction.canonical_entities.update({
      where: { id: entityId },
      data: { current_revision_id: revisionId },
    });
    await advanceSettledPublicWatermark(transaction, {
      organizationId: shadowOrganizationId,
      settledAt: observedAt,
    });
  });
  return entityId;
}

async function currentAlphaCheckpoint(
  harness: MigratedTestDatabase,
): Promise<ProviderCatalogCheckpointRecord> {
  const checkpoint = await new PrismaProviderCatalogSettlementRepository(
    harness.client,
  ).loadProviderCatalogCheckpoint({ organizationId, platformKey: "alpha" });
  assert.ok(checkpoint);
  return checkpoint;
}

test("unrelated unresolved pull links do not block catalog source while protected A content does", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction(async (transaction) => {
      await addUnrelatedPullRelationship(transaction, fixture);
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "manual_correction",
          entityKey: "canonical:v1:alpha:after-unrelated-pull",
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T10:36:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt,
      });
    });
    const currentCheckpoint = await new PrismaProviderCatalogSettlementRepository(
      harness.client,
    ).loadProviderCatalogCheckpoint({ organizationId, platformKey: "alpha" });
    assert.ok(currentCheckpoint);
    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: currentCheckpoint,
    });
    assert.equal(snapshot.revisions.length, 2);
  } finally {
    await harness.close();
  }

  const protectedHarness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(protectedHarness, {
      alphaProtectedContent: true,
    });
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: fixture.checkpointAlpha,
      }),
      assertSourceError("PROVIDER_RELEASE_PROTECTED_FIELD"),
    );
  } finally {
    await protectedHarness.close();
  }
});

test("supported resolved catalog relationships require the exact same-provider target identity", async () => {
  const legitimateHarness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(legitimateHarness);
    await legitimateHarness.client.$transaction(async (transaction) => {
      await addCatalogRelationship(transaction, {
        targetEntityId: await canonicalEntityId(transaction, {
          platformKey: "alpha",
          recordKind: "pack",
          externalId: "a-1",
        }),
        targetPlatformKey: "alpha",
        targetRecordKind: "pack",
        targetExternalId: "a-1",
        relationshipKind: "legitimate-catalog-target",
      });
    });

    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(legitimateHarness),
    });
    assert.deepEqual(
      snapshot.revisions.map(({ externalId }) => externalId),
      ["a-1", "a_1"],
    );
  } finally {
    await legitimateHarness.close();
  }

  const mismatchedHarness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(mismatchedHarness);
    await mismatchedHarness.client.$transaction(async (transaction) => {
      await addCatalogRelationship(transaction, {
        targetEntityId: await canonicalEntityId(transaction, {
          platformKey: "beta",
          recordKind: "pack",
          externalId: "beta-pack",
        }),
        targetPlatformKey: "alpha",
        targetRecordKind: "pack",
        targetExternalId: "a-1",
        relationshipKind: "mismatched-catalog-target",
      });
    });

    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: await currentAlphaCheckpoint(mismatchedHarness),
      }),
      assertSourceError("PROVIDER_RELEASE_SOURCE_INVALID"),
    );
  } finally {
    await mismatchedHarness.close();
  }
});

test("a supported catalog relationship cannot hide behind a non-catalog impact", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction(async (transaction) => {
      await addCatalogRelationship(transaction, {
        targetEntityId: await canonicalEntityId(transaction, {
          platformKey: "alpha",
          recordKind: "pack",
          externalId: "a-1",
        }),
        targetPlatformKey: "alpha",
        targetRecordKind: "pack",
        targetExternalId: "a-1",
        relationshipKind: "catalog-target-without-impact",
        catalogImpact: "none",
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha:pack:later-head",
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T11:31:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-16T11:31:00.000Z"),
      });
    });

    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: await currentAlphaCheckpoint(harness),
      }),
      assertSourceError("PROVIDER_RELEASE_SOURCE_INVALID"),
    );
  } finally {
    await harness.close();
  }
});

test("catalog relationship resolution must carry the provider impact", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction(async (transaction) => {
      const sourceEntityId = await canonicalEntityId(transaction, {
        platformKey: "alpha",
        recordKind: "pack",
        externalId: "a_1",
      });
      const targetEntityId = await canonicalEntityId(transaction, {
        platformKey: "alpha",
        recordKind: "pack",
        externalId: "a-1",
      });
      const [createdCause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "relationship_resolution",
          entityKey: "relationship:v1:resolution-impact-create",
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T11:32:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      const relationship = await transaction.canonical_relationships.create({
        data: {
          organization_id: organizationId,
          source_entity_id: sourceEntityId,
          relationship_kind: "resolution-without-provider-impact",
          target_platform_key: "alpha",
          target_record_kind: "pack",
          target_external_id: "a-1",
          created_public_change_sequence: createdCause!.sequence,
        },
      });
      const [resolvedCause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "relationship_resolution",
          entityKey: "relationship:v1:resolution-impact-resolve",
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T11:33:00.000Z"),
          catalogImpact: { kind: "none" },
        }],
      });
      await transaction.canonical_relationships.update({
        where: { id: relationship.id },
        data: {
          target_entity_id: targetEntityId,
          resolved_public_change_sequence: resolvedCause!.sequence,
          resolved_at: new Date("2026-08-16T11:33:00.000Z"),
        },
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha:pack:post-resolution-head",
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T11:34:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-16T11:34:00.000Z"),
      });
    });

    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: await currentAlphaCheckpoint(harness),
      }),
      assertSourceError("PROVIDER_RELEASE_SOURCE_INVALID"),
    );
  } finally {
    await harness.close();
  }
});

test("a matching target identity in a second tenant cannot satisfy an alpha relationship", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const shadowExternalId = "tenant-shadow-target";
    const shadowEntityId = await seedShadowTenantCatalogEntity(
      harness,
      shadowExternalId,
    );
    const sourceEntityId = await harness.client.$transaction((transaction) =>
      canonicalEntityId(transaction, {
        platformKey: "alpha",
        recordKind: "pack",
        externalId: "a_1",
      }));
    await assert.rejects(
      harness.client.canonical_relationships.create({
        data: {
          organization_id: organizationId,
          source_entity_id: sourceEntityId,
          relationship_kind: "cross-tenant-direct-target",
          target_platform_key: "alpha",
          target_record_kind: "pack",
          target_external_id: shadowExternalId,
          target_entity_id: shadowEntityId,
          created_public_change_sequence:
            fixture.checkpointAlpha.settledSequence,
          resolved_public_change_sequence:
            fixture.checkpointAlpha.settledSequence,
          resolved_at: settledAt,
        },
      }),
      /foreign key constraint/i,
    );

    await harness.client.$transaction(async (transaction) => {
      await addCatalogRelationship(transaction, {
        targetEntityId: null,
        targetPlatformKey: "alpha",
        targetRecordKind: "pack",
        targetExternalId: shadowExternalId,
        relationshipKind: "unresolved-tenant-shadow-target",
      });
    });
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({
        checkpoint: await currentAlphaCheckpoint(harness),
      }),
      assertSourceError("PROVIDER_RELEASE_SOURCE_INVALID"),
    );
  } finally {
    await harness.close();
  }
});

test("supported resolved catalog relationships require a target revision as of the checkpoint", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction(async (transaction) => {
      const targetEntityId = randomUUID();
      const targetExternalId = "future-catalog-asset";
      await transaction.canonical_entities.create({
        data: {
          id: targetEntityId,
          organization_id: organizationId,
          platform_key: "alpha",
          record_kind: "catalog_asset",
          external_id: targetExternalId,
        },
      });
      await addCatalogRelationship(transaction, {
        targetEntityId,
        targetPlatformKey: "alpha",
        targetRecordKind: "catalog_asset",
        targetExternalId,
        relationshipKind: "future-revision-catalog-target",
      });

      const [futureCause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: `canonical:v1:alpha:catalog_asset:${targetExternalId}`,
          sourceKey: "alpha",
          occurredAt: new Date("2026-08-16T11:31:00.000Z"),
          catalogImpact: { kind: "none" },
        }],
      });
      const sourceRecordId = randomUUID();
      const revisionId = randomUUID();
      await transaction.source_records.create({
        data: {
          id: sourceRecordId,
          organization_id: organizationId,
          provider_id: alphaProviderId,
          first_run_id: fixture.alphaRunId,
          first_page_id: fixture.alphaPageId,
          record_kind: "catalog",
          external_id: targetExternalId,
          source_time: new Date("2026-08-16T11:31:00.000Z"),
          collected_at: new Date("2026-08-16T11:31:00.000Z"),
          content_hash: hashJson({ targetExternalId }),
          expires_at: new Date("2026-11-16T11:31:00.000Z"),
        },
      });
      await transaction.canonical_revisions.create({
        data: {
          id: revisionId,
          organization_id: organizationId,
          entity_id: targetEntityId,
          revision_number: 1,
          source_record_id: sourceRecordId,
          content_json: {},
          content_hash: hashJson({}),
          provenance_json: {},
          provenance_hash: hashJson({}),
          source_updated_at: new Date("2026-08-16T11:31:00.000Z"),
          source_collected_at: new Date("2026-08-16T11:31:00.000Z"),
          accepted_at: new Date("2026-08-16T11:31:00.000Z"),
          public_change_sequence: futureCause!.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: targetEntityId },
        data: { current_revision_id: revisionId },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-16T11:31:00.000Z"),
      });
    });

    const checkpoint = await currentAlphaCheckpoint(harness);
    const futureTarget = await harness.client.canonical_entities.findFirstOrThrow({
      where: {
        organization_id: organizationId,
        platform_key: "alpha",
        record_kind: "catalog_asset",
        external_id: "future-catalog-asset",
      },
      select: { id: true },
    });
    const futureRevision = await harness.client.canonical_revisions.findFirstOrThrow({
      where: {
        organization_id: organizationId,
        entity_id: futureTarget.id,
      },
    });
    assert.ok(futureRevision.public_change_sequence > checkpoint.settledSequence);
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({ checkpoint }),
      assertSourceError("PROVIDER_RELEASE_SOURCE_INVALID"),
    );
  } finally {
    await harness.close();
  }
});
