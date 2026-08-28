import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  containsProtectedPublicationField,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContent,
  normalizedProviderObservationSchema,
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
import { loadProviderV1AssetPackAssociations } from
  "./provider-v1-asset-pack-association-reader.ts";
import {
  PrismaProviderCatalogSettlementRepository,
  type ProviderCatalogCheckpointRecord,
} from "./public-change-settlement-repository.provider-read.ts";
import { loadManifestPromotionEvaluationTrigger } from
  "./manifest-promotion-trigger.ts";
import { ProviderSourceLifecycleRepository } from
  "./provider-source-lifecycle-repository.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";
import { writeCanonicalProjectionBatch } from
  "./ingestion-page-batch-writer.ts";
import {
  PROTECTED_PAYLOAD_RETENTION_DAYS,
  type CanonicalProjectionInput,
} from "./pipeline-types.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
} from "./provider-source-observation-repository.ts";
import { providerV1ConfirmedRelationshipCtes } from
  "./source-relationship-confirmation-repository.ts";
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
const shadowOrganizationId = "8b000000-0000-4000-8000-000000000001";
const shadowProviderId = "8b000000-0000-4000-8000-000000000010";
const shadowRevisionId = "8b000000-0000-4000-8000-000000000020";
const categoryId = "8a000000-0000-5000-8000-000000000030";
const observedAt = new Date("2026-08-16T10:10:00.000Z");
const lifecycleAt = new Date("2026-08-16T10:20:00.000Z");
const settledAt = new Date("2026-08-16T10:40:00.000Z");

test("provider V1 confirmation-set inlining is explicit and opt-in", () => {
  const render = (materialization: "default" | "not_materialized") =>
    providerV1ConfirmedRelationshipCtes({
      organizationId,
      sourceRevisionId: "8a000000-0000-4000-8000-000000000020",
      throughSequence: 1n,
      materialization,
    }).strings.join("?").replaceAll(/\s+/gu, " ");

  const defaultSql = render("default");
  const optimizedSql = render("not_materialized");
  assert.match(
    defaultSql,
    /confirmed_provider_v1_pull_relationship_sets as \(/u,
  );
  assert.doesNotMatch(defaultSql, /not materialized/u);
  assert.match(
    optimizedSql,
    /confirmed_provider_v1_pull_relationship_sets as not materialized \(/u,
  );
});

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
  readonly alphaSourceInstanceId: string;
  readonly alphaSourceRevisionId: string;
  readonly betaSourceInstanceId: string;
  readonly betaSourceRevisionId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly supervisorEpochId: string;
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
  const lifecycle = new ProviderSourceLifecycleRepository(harness.client);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey: "release-source-v1",
    connectionTypeKey: "release-connection-v1",
    displayName: "Release source fixture",
    requestLimit: 2,
    sourceAdapterVersion: "release-adapter-v1",
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "7".repeat(64),
    actorKey: "fixture-actor",
    createdAt: observedAt,
  });
  const createSource = (providerId: string, platformKey: string) =>
    lifecycle.createSourceInstanceRevision({
      organizationId,
      providerId,
      connectionProfileId: connection.profileId,
      sourceTypeKey: "release-source-v1",
      sourceAdapterVersion: "release-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: `${platformKey}-release-mapper`,
      mapperVersion: "v1",
      identityNamespaceKey: `${platformKey}-release-records`,
      cursorCodecVersion: "release-cursor-v1",
      revisionNumber: 1,
      configuration: { platformKey },
      configurationHash: platformKey === "alpha"
        ? "8".repeat(64)
        : "9".repeat(64),
      recordIdScopes: ["catalog-pack-v1", "catalog-card-v1", "pull-v1"],
      actorKey: "fixture-actor",
      createdAt: observedAt,
    });
  const [alphaSource, betaSource] = await Promise.all([
    createSource(alphaProviderId, "alpha"),
    createSource(betaProviderId, "beta"),
  ]);
  await harness.client.$transaction([
    harness.client.source_connection_revisions.update({
      where: { id: connection.revisionId },
      data: { state: "active", activated_at: observedAt },
    }),
    harness.client.source_connection_profiles.update({
      where: { id: connection.profileId },
      data: {
        state: "active",
        active_revision_id: connection.revisionId,
        updated_at: observedAt,
      },
    }),
    harness.client.provider_source_instances.update({
      where: { id: alphaSource.sourceInstanceId },
      data: { state: "active", activated_at: observedAt, updated_at: observedAt },
    }),
    harness.client.provider_source_instances.update({
      where: { id: betaSource.sourceInstanceId },
      data: { state: "active", activated_at: observedAt, updated_at: observedAt },
    }),
  ]);
  const supervisorEpochId = randomUUID();
  await harness.client.source_supervisor_epochs.create({
    data: {
      id: supervisorEpochId,
      environment_key: `provider-release-${organizationId}`,
      epoch_number: 1n,
      state: "active",
      owner_key: "provider-release-test-worker",
      lease_token: randomUUID(),
      acquired_at: observedAt,
      last_renewed_at: observedAt,
      lease_expires_at: new Date("2026-08-17T10:10:00.000Z"),
      takeover_not_before: new Date("2026-08-17T10:10:15.000Z"),
    },
  });

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
        config_revision_id: null,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date("2026-08-16T10:05:00.000Z"),
        finished_at: observedAt,
        reached_provider_head: options.alphaBackfillComplete ?? true,
        source_instance_id: alphaSource.sourceInstanceId,
        source_revision_id: alphaSource.sourceRevisionId,
        source_type_key: "release-source-v1",
        source_adapter_version: "release-adapter-v1",
        normalized_contract_version: "packscout.provider-observation.v1",
        mapper_key: "alpha-release-mapper",
        mapper_version: "v1",
        identity_namespace_key: "alpha-release-records",
        connection_profile_id: connection.profileId,
        connection_revision_id: connection.revisionId,
        cursor_codec_version: "release-cursor-v1",
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        current_cursor_key: "initial",
        next_page_number: 1,
      },
      {
        id: betaRunId,
        organization_id: organizationId,
        provider_id: betaProviderId,
        config_revision_id: null,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date("2026-08-16T10:05:00.000Z"),
        finished_at: observedAt,
        reached_provider_head: true,
        source_instance_id: betaSource.sourceInstanceId,
        source_revision_id: betaSource.sourceRevisionId,
        source_type_key: "release-source-v1",
        source_adapter_version: "release-adapter-v1",
        normalized_contract_version: "packscout.provider-observation.v1",
        mapper_key: "beta-release-mapper",
        mapper_version: "v1",
        identity_namespace_key: "beta-release-records",
        connection_profile_id: connection.profileId,
        connection_revision_id: connection.revisionId,
        cursor_codec_version: "release-cursor-v1",
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        current_cursor_key: "initial",
        next_page_number: 1,
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
      sourceInstanceId: alphaSource.sourceInstanceId,
      sourceRevisionId: alphaSource.sourceRevisionId,
      runId: alphaRunId,
      pageId: alphaPageId,
      externalId: "a_1",
      content: packContent("Alpha underscore"),
    },
    {
      platformKey: "alpha",
      providerId: alphaProviderId,
      sourceInstanceId: alphaSource.sourceInstanceId,
      sourceRevisionId: alphaSource.sourceRevisionId,
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
      sourceInstanceId: betaSource.sourceInstanceId,
      sourceRevisionId: betaSource.sourceRevisionId,
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
          sourceRevisionKey: alphaSource.sourceRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "active",
            sourceInstanceId: alphaSource.sourceInstanceId,
            sourceRevisionId: alphaSource.sourceRevisionId,
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
          sourceRevisionKey: betaSource.sourceRevisionId,
          metadata: {
            providerId: betaProviderId,
            platformKey: "beta",
            state: "active",
            sourceInstanceId: betaSource.sourceInstanceId,
            sourceRevisionId: betaSource.sourceRevisionId,
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
        sourceRevisionKey: input.sourceRevisionId,
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
    alphaSourceInstanceId: alphaSource.sourceInstanceId,
    alphaSourceRevisionId: alphaSource.sourceRevisionId,
    betaSourceInstanceId: betaSource.sourceInstanceId,
    betaSourceRevisionId: betaSource.sourceRevisionId,
    connectionProfileId: connection.profileId,
    connectionRevisionId: connection.revisionId,
    supervisorEpochId,
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
    assert.deepEqual(first.assetPackAssociations, []);
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
    assert.equal(await harness.client.provider_config_revisions.count({
      where: { organization_id: organizationId },
    }), 0);
    const settlement = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    const promotionCheckpoint = await settlement.loadProviderPromotionCheckpoint({
      organizationId,
      platformKey: "alpha",
    });
    assert.equal(
      promotionCheckpoint?.lastSuccessfulObservationAt.toISOString(),
      observedAt.toISOString(),
    );
    assert.equal(
      (await loadManifestPromotionEvaluationTrigger(
        harness.client,
        organizationId,
      ))?.cause,
      "observation_succeeded",
    );
  } finally {
    await harness.close();
  }
});

test("provider snapshot follows the canonical current pointer instead of a later historical insertion", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const currentBefore = await harness.client.canonical_entities.findFirstOrThrow({
      where: {
        organization_id: organizationId,
        platform_key: "alpha",
        record_kind: "pack",
        external_id: "a-1",
      },
      select: { id: true, current_revision_id: true },
    });
    assert.ok(currentBefore.current_revision_id);
    const historicalRevisionId = randomUUID();
    await harness.client.$transaction(async (transaction) => {
      const sourceRecordId = randomUUID();
      const historicalAt = new Date("2026-08-01T00:00:00.000Z");
      const acceptedAt = new Date("2026-08-16T11:00:00.000Z");
      const content = packContent("Stale historical pack");
      await transaction.source_records.create({
        data: {
          id: sourceRecordId,
          organization_id: organizationId,
          provider_id: alphaProviderId,
          first_run_id: fixture.alphaRunId,
          first_page_id: fixture.alphaPageId,
          record_kind: "catalog",
          external_id: "a-1",
          source_time: historicalAt,
          collected_at: acceptedAt,
          content_hash: hashJson(content),
          expires_at: new Date("2026-11-16T11:00:00.000Z"),
        },
      });
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha:pack:a-1:historical",
          sourceKey: "alpha",
          sourceRevisionKey: fixture.alphaSourceRevisionId,
          occurredAt: acceptedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      assert.ok(cause);
      await transaction.canonical_revisions.create({
        data: {
          id: historicalRevisionId,
          organization_id: organizationId,
          entity_id: currentBefore.id,
          revision_number: 2,
          source_record_id: sourceRecordId,
          content_json: content as Prisma.InputJsonValue,
          content_hash: hashJson(content),
          provenance_json: {},
          provenance_hash: hashJson({}),
          source_updated_at: historicalAt,
          source_collected_at: acceptedAt,
          accepted_at: acceptedAt,
          public_change_sequence: cause.sequence,
        },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: acceptedAt,
      });
    });

    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    const pack = snapshot.revisions.find(({ externalId }) => externalId === "a-1");
    assert.ok(pack);
    assert.equal(pack.revisionId, currentBefore.current_revision_id);
    assert.notEqual(pack.revisionId, historicalRevisionId);
    assert.equal((pack.content as { name?: unknown }).name, "Alpha dash");
  } finally {
    await harness.close();
  }
});

test("source head completion after the final settlement makes the exact source revision ready", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness, {
      alphaBackfillComplete: false,
    });
    const settlement = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    assert.equal(await settlement.loadProviderPromotionCheckpoint({
      organizationId,
      platformKey: "alpha",
    }), null);

    const before = await settlement.loadProviderCatalogCheckpoint({
      organizationId,
      platformKey: "alpha",
    });
    assert.ok(before);
    const causeCountBefore = await harness.client.public_change_causes.count({
      where: { organization_id: organizationId },
    });
    const supervisorFinishedAt = new Date("2026-08-16T10:50:00.000Z");
    assert.ok(before.settledAt);
    assert.ok(supervisorFinishedAt > before.settledAt);

    await harness.client.import_runs.update({
      where: { id: fixture.alphaRunId },
      data: {
        reached_provider_head: true,
        finished_at: supervisorFinishedAt,
      },
    });

    const after = await settlement.loadProviderCatalogCheckpoint({
      organizationId,
      platformKey: "alpha",
    });
    assert.deepEqual(after, before);
    assert.equal(await harness.client.public_change_causes.count({
      where: { organization_id: organizationId },
    }), causeCountBefore);
    const promotionCheckpoint = await settlement.loadProviderPromotionCheckpoint({
      organizationId,
      platformKey: "alpha",
    });
    assert.equal(
      promotionCheckpoint?.lastSuccessfulObservationAt.toISOString(),
      supervisorFinishedAt.toISOString(),
    );
    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: fixture.checkpointAlpha,
    });
    assert.equal(
      snapshot.readiness.completedBackfillAt.toISOString(),
      supervisorFinishedAt.toISOString(),
    );
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
    const laterSource = await new ProviderSourceLifecycleRepository(
      harness.client,
    ).createSourceInstanceRevision({
      organizationId,
      providerId: alphaProviderId,
      connectionProfileId: fixture.connectionProfileId,
      sourceTypeKey: "release-source-v1",
      sourceAdapterVersion: "release-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: "alpha-release-mapper",
      mapperVersion: "v1",
      identityNamespaceKey: "alpha-release-records",
      cursorCodecVersion: "release-cursor-v1",
      revisionNumber: 1,
      configuration: { platformKey: "alpha", replacement: true },
      configurationHash: "6".repeat(64),
      recordIdScopes: ["catalog-pack-v1", "catalog-card-v1", "pull-v1"],
      actorKey: "fixture-actor",
      createdAt: new Date("2026-08-16T10:50:00.000Z"),
    });
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
      await transaction.provider_source_instances.update({
        where: { id: fixture.alphaSourceInstanceId },
        data: {
          state: "replaced",
          replaced_at: new Date("2026-08-16T11:00:00.000Z"),
          updated_at: new Date("2026-08-16T11:00:00.000Z"),
        },
      });
      await transaction.provider_source_instances.update({
        where: { id: laterSource.sourceInstanceId },
        data: {
          state: "active",
          activated_at: new Date("2026-08-16T11:00:00.000Z"),
          updated_at: new Date("2026-08-16T11:00:00.000Z"),
        },
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: `provider:v2:${alphaProviderId}`,
          sourceKey: "alpha",
          sourceRevisionKey: laterSource.sourceRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "active",
            sourceInstanceId: laterSource.sourceInstanceId,
            sourceRevisionId: laterSource.sourceRevisionId,
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
    assert.equal(
      snapshot.readiness.sourceRevisionId,
      fixture.alphaSourceRevisionId,
    );
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
      await transaction.provider_source_instances.update({
        where: { id: fixture.alphaSourceInstanceId },
        data: {
          state: "disabled",
          disabled_at: new Date("2026-08-16T11:20:00.000Z"),
          updated_at: new Date("2026-08-16T11:20:00.000Z"),
        },
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: `provider:disable:${alphaProviderId}`,
          sourceKey: "alpha",
          sourceRevisionKey: fixture.alphaSourceRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "disabled",
            sourceInstanceId: fixture.alphaSourceInstanceId,
            sourceRevisionId: fixture.alphaSourceRevisionId,
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

test("later legacy lifecycle causality cannot supersede source-native promotion readiness", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const legacyRevisionId = randomUUID();
    const changedAt = new Date("2026-08-16T11:25:00.000Z");
    await harness.client.provider_config_revisions.create({
      data: {
        id: legacyRevisionId,
        organization_id: organizationId,
        provider_id: alphaProviderId,
        version: 1,
        adapter_key: "legacy-http-v1",
        endpoint_url: "https://legacy-alpha.example/feed",
        auth_mode: "none",
        created_by_actor_key: "legacy-admin",
      },
    });
    await harness.client.$transaction(async (transaction) => {
      await transaction.provider_sources.update({
        where: { id: alphaProviderId },
        data: {
          state: "disabled",
          active_revision_id: legacyRevisionId,
          updated_at: changedAt,
        },
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: `provider:v1:${alphaProviderId}`,
          sourceKey: "alpha",
          sourceRevisionKey: legacyRevisionId,
          metadata: {
            providerId: alphaProviderId,
            platformKey: "alpha",
            state: "disabled",
            configurationRevisionId: legacyRevisionId,
          },
          occurredAt: changedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: [],
            manifestLifecycle: { platformKey: "alpha", state: "disabled" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: changedAt,
      });
    });
    const settlement = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    const eligibility = await settlement.loadManifestEligibilitySnapshot({
      organizationId,
    });
    assert.deepEqual(eligibility?.enabledPlatformKeys, ["alpha", "beta"]);
    assert.ok(await settlement.loadProviderPromotionCheckpoint({
      organizationId,
      platformKey: "alpha",
    }));
    assert.equal(
      (await loadManifestPromotionEvaluationTrigger(
        harness.client,
        organizationId,
      ))?.cause,
      "observation_succeeded",
    );
    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: fixture.checkpointAlpha,
    });
    assert.equal(
      snapshot.readiness.sourceRevisionId,
      fixture.alphaSourceRevisionId,
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
      target_record_kind: "market_event",
      target_external_id: "unresolved-sale",
      created_public_change_sequence: cause!.sequence,
    },
  });
}

async function addLegacyPullRelationshipSet(
  database: PackscoutTransactionClient,
  fixture: SeededProviderRelease,
  associationKey: string,
): Promise<void> {
  const assetExternalId = `asset-legacy-${associationKey}`;
  const pullExternalId = `pull-${associationKey}`;
  const projectionAt = new Date("2026-08-16T11:34:00.000Z");
  const relationshipAt = new Date("2026-08-16T11:35:00.000Z");
  const assetSourceRecordId = randomUUID();
  const pullSourceRecordId = randomUUID();
  await database.source_records.createMany({
    data: [{
      id: assetSourceRecordId,
      organization_id: organizationId,
      provider_id: alphaProviderId,
      first_run_id: fixture.alphaRunId,
      first_page_id: fixture.alphaPageId,
      record_kind: "catalog",
      external_id: assetExternalId,
      source_time: projectionAt,
      collected_at: projectionAt,
      content_hash: hashJson({ assetExternalId, origin: "legacy" }),
      expires_at: new Date("2026-11-16T11:34:00.000Z"),
    }, {
      id: pullSourceRecordId,
      organization_id: organizationId,
      provider_id: alphaProviderId,
      first_run_id: fixture.alphaRunId,
      first_page_id: fixture.alphaPageId,
      record_kind: "pull",
      external_id: pullExternalId,
      source_time: relationshipAt,
      collected_at: relationshipAt,
      content_hash: hashJson({ pullExternalId, origin: "legacy" }),
      expires_at: new Date("2026-11-16T11:35:00.000Z"),
    }],
  });
  const legacyConfigurationRevisionId = randomUUID();
  const policy = {
    retentionDays: PROTECTED_PAYLOAD_RETENTION_DAYS,
    actorPseudonymKey: "provider-release-legacy-cutover-test-key",
  } as const;
  await writeCanonicalProjectionBatch(database, policy, [{
    organizationId,
    providerId: alphaProviderId,
    origin: {
      kind: "legacy_source_record",
      configurationRevisionId: legacyConfigurationRevisionId,
      sourceRecordId: assetSourceRecordId,
    },
    projection: {
      platformKey: "alpha",
      recordKind: "catalog_asset",
      externalId: assetExternalId,
      content: {
        schemaVersion: "catalog-projection-v1",
        entityType: "catalog_asset",
        assetType: "card",
        relatedPackExternalId: null,
        parentExternalId: null,
        firstSeenAt: projectionAt.toISOString(),
        name: "Legacy-only asset",
        description: null,
        category: null,
        availability: "available",
        sourceStatus: null,
        providerValueMinor: 4_000,
        providerValueCurrency: "USD",
        valueSource: "provider-reported",
        imageUrls: [],
        dataQualityEvidence: [],
      },
      sourceUpdatedAt: projectionAt,
      sourceCollectedAt: projectionAt,
    },
    projectionIndex: 0,
    becomesCurrent: true,
    acceptedAt: projectionAt,
    publicChangeKind: "provider_projection",
  }]);
  await writeCanonicalProjectionBatch(database, policy, [{
    organizationId,
    providerId: alphaProviderId,
    origin: {
      kind: "legacy_source_record",
      configurationRevisionId: legacyConfigurationRevisionId,
      sourceRecordId: pullSourceRecordId,
    },
    projection: {
      platformKey: "alpha",
      recordKind: "pull",
      externalId: pullExternalId,
      content: {
        eventKind: "pull",
        displayName: "Legacy pull",
        imageUrls: [],
        value: { amountMinor: 4_000, currency: "USD" },
        valueSource: "provider-reported",
      },
      sourceUpdatedAt: relationshipAt,
      sourceCollectedAt: relationshipAt,
      relationships: [{
        relationshipKind: "card",
        targetPlatformKey: "alpha",
        targetRecordKind: "catalog_asset",
        targetExternalId: assetExternalId,
      }, {
        relationshipKind: "pack",
        targetPlatformKey: "alpha",
        targetRecordKind: "pack",
        targetExternalId: "a_1",
      }, {
        relationshipKind: "asset",
        targetPlatformKey: "alpha",
        targetRecordKind: "catalog_asset",
        targetExternalId: assetExternalId,
      }, {
        relationshipKind: "subject",
        targetPlatformKey: "alpha",
        targetRecordKind: "pack",
        targetExternalId: "a_1",
      }],
    },
    projectionIndex: 0,
    becomesCurrent: true,
    acceptedAt: relationshipAt,
    publicChangeKind: "provider_projection",
  }]);
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

async function addPullAssetPackAssociation(
  database: PackscoutTransactionClient,
  fixture: SeededProviderRelease,
  input: Readonly<{
    pullExternalId: string;
    assetExternalId: string;
    packExternalIds: readonly string[];
    leavePackUnresolved?: boolean;
  }>,
): Promise<Readonly<{
  sourceEntityId: string;
  unresolvedPackRelationshipId: string | null;
  publicChangeSequence: bigint;
  associatedAt: Date;
}>> {
  const projectionAt = new Date("2026-08-16T11:40:00.000Z");
  const relationshipAt = new Date("2026-08-16T11:41:00.000Z");
  const [assetCause, pullCause] = await allocatePublicChangeCauses(database, {
    organizationId,
    changes: [
      {
        changeKind: "provider_projection",
        entityKey: `canonical:v1:alpha:catalog_asset:${input.assetExternalId}`,
        sourceKey: "alpha",
        sourceRevisionKey: fixture.alphaSourceRevisionId,
        occurredAt: projectionAt,
        catalogImpact: {
          kind: "catalog",
          providerPlatformKeys: ["alpha"],
        },
      },
      {
        changeKind: "provider_projection",
        entityKey: `canonical:v1:alpha:pull:${input.pullExternalId}`,
        sourceKey: "alpha",
        sourceRevisionKey: fixture.alphaSourceRevisionId,
        occurredAt: projectionAt,
        // Production V1 canonical writes deliberately classify pull revisions
        // as non-catalog. The paired relationship causes own catalog impact.
        catalogImpact: { kind: "none" },
      },
    ],
  });
  assert.ok(assetCause);
  assert.ok(pullCause);
  const assetEntityId = randomUUID();
  const pullEntityId = randomUUID();
  const records = [
    {
      id: randomUUID(),
      recordKind: "catalog" as const,
      externalId: input.assetExternalId,
      content: { name: "Associated asset" },
      entityId: assetEntityId,
      canonicalKind: "catalog_asset" as const,
      cause: assetCause,
    },
    {
      id: randomUUID(),
      recordKind: "pull" as const,
      externalId: input.pullExternalId,
      content: { assetExternalId: input.assetExternalId },
      entityId: pullEntityId,
      canonicalKind: "pull" as const,
      cause: pullCause,
    },
  ];
  for (const [index, record] of records.entries()) {
    await database.source_records.create({
      data: {
        id: record.id,
        organization_id: organizationId,
        provider_id: alphaProviderId,
        first_run_id: fixture.alphaRunId,
        first_page_id: fixture.alphaPageId,
        record_kind: record.recordKind,
        external_id: record.externalId,
        source_time: new Date(projectionAt.getTime() + index),
        collected_at: new Date(projectionAt.getTime() + index),
        content_hash: hashJson(record.content),
        expires_at: new Date("2026-11-16T11:40:00.000Z"),
      },
    });
    await database.canonical_entities.create({
      data: {
        id: record.entityId,
        organization_id: organizationId,
        platform_key: "alpha",
        record_kind: record.canonicalKind,
        external_id: record.externalId,
      },
    });
    const revisionId = randomUUID();
    await database.canonical_revisions.create({
      data: {
        id: revisionId,
        organization_id: organizationId,
        entity_id: record.entityId,
        revision_number: 1,
        source_record_id: record.id,
        content_json: record.content,
        content_hash: hashJson(record.content),
        provenance_json: {},
        provenance_hash: hashJson({}),
        source_updated_at: new Date(projectionAt.getTime() + index),
        source_collected_at: new Date(projectionAt.getTime() + index),
        accepted_at: new Date(projectionAt.getTime() + index),
        public_change_sequence: record.cause.sequence,
      },
    });
    await database.canonical_entities.update({
      where: { id: record.entityId },
      data: { current_revision_id: revisionId },
    });
  }
  const [relationshipCause] = await allocatePublicChangeCauses(database, {
    organizationId,
    changes: [{
      changeKind: "relationship_resolution",
      entityKey: `relationship:v1:alpha:pull:${input.pullExternalId}`,
      sourceKey: "alpha",
      sourceRevisionKey: fixture.alphaSourceRevisionId,
      occurredAt: relationshipAt,
      catalogImpact: {
        kind: "catalog",
        providerPlatformKeys: ["alpha"],
      },
    }],
  });
  assert.ok(relationshipCause);
  await database.canonical_relationships.create({
    data: {
      organization_id: organizationId,
      source_entity_id: pullEntityId,
      relationship_kind: "card",
      target_platform_key: "alpha",
      target_record_kind: "catalog_asset",
      target_external_id: input.assetExternalId,
      target_entity_id: assetEntityId,
      created_public_change_sequence: relationshipCause.sequence,
      resolved_public_change_sequence: relationshipCause.sequence,
      resolved_at: relationshipAt,
    },
  });
  let unresolvedPackRelationshipId: string | null = null;
  for (const [index, packExternalId] of input.packExternalIds.entries()) {
    const targetEntityId = await canonicalEntityId(database, {
      platformKey: "alpha",
      recordKind: "pack",
      externalId: packExternalId,
    });
    const unresolved = input.leavePackUnresolved === true && index === 0;
    const relationship = await database.canonical_relationships.create({
      data: {
        organization_id: organizationId,
        source_entity_id: pullEntityId,
        relationship_kind: "pack",
        target_platform_key: "alpha",
        target_record_kind: "pack",
        target_external_id: packExternalId,
        target_entity_id: unresolved ? null : targetEntityId,
        created_public_change_sequence: relationshipCause.sequence,
        resolved_public_change_sequence: unresolved
          ? null
          : relationshipCause.sequence,
        resolved_at: unresolved
          ? null
          : new Date(relationshipAt.getTime() + 1_000),
      },
    });
    if (unresolved) unresolvedPackRelationshipId = relationship.id;
  }
  await advanceSettledPublicWatermark(database, {
    organizationId,
    settledAt: new Date(relationshipAt.getTime() + 2_000),
  });
  return {
    sourceEntityId: pullEntityId,
    unresolvedPackRelationshipId,
    publicChangeSequence: relationshipCause.sequence,
    associatedAt: new Date(relationshipAt.getTime() + 1_000),
  };
}

function sourceNativeReleaseObservation(
  projection: CanonicalProjectionInput,
) {
  const common = {
    providerRecordIdentity: {
      recordIdScopeKey: projection.recordKind === "catalog_asset"
        ? "catalog-card-v1" as const
        : "pull-v1" as const,
      providerRecordId: projection.externalId,
    },
    effectiveAt: projection.sourceUpdatedAt.toISOString(),
    collectedAt: projection.sourceCollectedAt.toISOString(),
    protectedNativeEvidenceRef: `evidence:${projection.externalId}`,
  };
  if (projection.recordKind === "catalog_asset") {
    return normalizedProviderObservationSchema.parse({
      ...common,
      kind: "catalog",
      entity: "card",
      firstSeenAt: projection.sourceUpdatedAt.toISOString(),
      availability: "available",
      providerFacts: emptyNormalizedProviderFacts("card"),
      relationships: [],
    });
  }
  if (projection.recordKind !== "pull") {
    throw new TypeError("The release V1 fixture supports cards and pulls only.");
  }
  return normalizedProviderObservationSchema.parse({
    ...common,
    kind: "pull",
    providerFacts: emptyNormalizedProviderFacts("pull"),
    relationships: (projection.relationships ?? []).map((relationship) => ({
      relationship: relationship.relationshipKind,
      target: {
        recordIdScopeKey: relationship.targetRecordKind === "pack"
          ? "catalog-pack-v1" as const
          : "catalog-card-v1" as const,
        providerRecordId: relationship.targetExternalId,
      },
    })),
  });
}

async function writeSourceNativeReleasePage(
  database: PackscoutTransactionClient,
  fixture: SeededProviderRelease,
  acceptedAt: Date,
  projections: readonly CanonicalProjectionInput[],
) {
  const runId = randomUUID();
  const runLeaseToken = randomUUID();
  const runClaimLeaseId = randomUUID();
  const requestAttemptId = randomUUID();
  const requestLeaseId = randomUUID();
  const pageId = randomUUID();
  await database.import_runs.create({
    data: {
      id: runId,
      organization_id: organizationId,
      provider_id: alphaProviderId,
      config_revision_id: null,
      trigger: "manual",
      state: "succeeded",
      requested_by_actor_key: "operator:test",
      started_at: acceptedAt,
      finished_at: acceptedAt,
      created_at: acceptedAt,
      lease_owner: "provider-release-test-worker",
      lease_token: runLeaseToken,
      claim_lease_id: runClaimLeaseId,
      lease_expires_at: new Date(acceptedAt.getTime() + 60_000),
      reached_provider_head: true,
      source_instance_id: fixture.alphaSourceInstanceId,
      source_revision_id: fixture.alphaSourceRevisionId,
      source_type_key: "release-source-v1",
      source_adapter_version: "release-adapter-v1",
      normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      mapper_key: "alpha-release-mapper",
      mapper_version: "v1",
      identity_namespace_key: "alpha-release-records",
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      cursor_codec_version: "release-cursor-v1",
      cursor_generation: 1n,
      requested_cursor: null,
      requested_cursor_fingerprint: null,
      requested_cursor_key: "initial",
      current_cursor: null,
      current_cursor_fingerprint: null,
      current_cursor_key: "initial",
      next_page_number: 2,
    },
  });
  await database.compact_source_request_attempts.create({
    data: {
      request_attempt_id: requestAttemptId,
      organization_id: organizationId,
      operation_kind: "page_read",
      terminal_state: "captured",
      outcome_class: "response_captured",
      safe_outcome_hash: "c".repeat(64),
      request_lease_id: requestLeaseId,
      claim_owner: "provider-release-test-worker",
      claim_token: runLeaseToken,
      supervisor_epoch_id: fixture.supervisorEpochId,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      expected_health_generation: 0n,
      provider_id: alphaProviderId,
      source_instance_id: fixture.alphaSourceInstanceId,
      source_revision_id: fixture.alphaSourceRevisionId,
      run_id: runId,
      page_number: 1,
      cursor_generation: 1n,
      requested_cursor_fingerprint: null,
      requested_cursor_key: "initial",
      response_bytes: 1,
      duration_ms: 1,
      started_at: acceptedAt,
      terminal_at: acceptedAt,
    },
  });
  await database.import_pages.create({
    data: {
      id: pageId,
      organization_id: organizationId,
      provider_id: alphaProviderId,
      run_id: runId,
      page_number: 1,
      requested_cursor: null,
      next_cursor: null,
      has_more: null,
      payload_hash: "d".repeat(64),
      record_counts_json: { records: projections.length },
      committed_at: acceptedAt,
      expires_at: new Date(acceptedAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
      source_instance_id: fixture.alphaSourceInstanceId,
      source_revision_id: fixture.alphaSourceRevisionId,
      source_type_key: "release-source-v1",
      source_adapter_version: "release-adapter-v1",
      normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      mapper_key: "alpha-release-mapper",
      mapper_version: "v1",
      identity_namespace_key: "alpha-release-records",
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      connection_health_generation: 0n,
      request_attempt_id: requestAttemptId,
      run_claim_lease_id: runClaimLeaseId,
      supervisor_epoch_id: fixture.supervisorEpochId,
      cursor_codec_version: "release-cursor-v1",
      cursor_generation: 1n,
      requested_cursor_fingerprint: null,
      requested_cursor_key: "initial",
      next_cursor_fingerprint: null,
      continuation_kind: "poll_after",
      minimum_delay_seconds: 0,
      protected_raw_response: new Uint8Array([1]),
      protected_raw_response_sha256: "e".repeat(64),
      normalized_commit_hash: "f".repeat(64),
    },
  });

  const observationRepository = new ProviderSourceObservationRepository();
  const writes = [];
  const semanticSources = [];
  for (const [projectionIndex, projection] of projections.entries()) {
    const observation = sourceNativeReleaseObservation(projection);
    const normalizedContent = normalizedObservationSemanticContent(observation);
    const semantic =
      await observationRepository.upsertSemanticObservationInTransaction(
        database,
        {
          organizationId,
          providerId: alphaProviderId,
          sourceInstanceId: fixture.alphaSourceInstanceId,
          sourceRevisionId: fixture.alphaSourceRevisionId,
          recordIdScopeKey:
            observation.providerRecordIdentity.recordIdScopeKey,
          providerRecordId: observation.providerRecordIdentity.providerRecordId,
          effectiveSourceTime: new Date(observation.effectiveAt),
          normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
          normalizedContentHash:
            hashNormalizedObservationSemanticContent(normalizedContent),
          normalizedContent,
          ...(projection.recordKind === "catalog_asset"
            ? {
                recordKind: "catalog" as const,
                recordDiscriminator: "catalog_card" as const,
              }
            : {
                recordKind: "pull" as const,
                recordDiscriminator: "pull" as const,
              }),
        },
        { skipSourceRevisionFenceCheck: projectionIndex > 0 },
      );
    if (semantic.kind !== "ready") {
      throw new Error("Release V1 semantic identity conflicted.");
    }
    semanticSources.push({
      sourceRecordId: semantic.sourceRecordId,
      semanticObservationId: semantic.semanticObservationId,
      collectedAt: projection.sourceCollectedAt,
      nativeEvidenceReference: observation.protectedNativeEvidenceRef,
    });
    writes.push({
      organizationId,
      providerId: alphaProviderId,
      origin: {
        kind: "semantic_observation" as const,
        sourceRevisionId: fixture.alphaSourceRevisionId,
        semanticObservationId: semantic.semanticObservationId,
      },
      projection,
      projectionIndex,
      becomesCurrent: true,
      acceptedAt,
      publicChangeKind: "provider_projection" as const,
    });
  }
  const results = await writeCanonicalProjectionBatch(database, {
    retentionDays: PROTECTED_PAYLOAD_RETENTION_DAYS,
    actorPseudonymKey: "provider-release-source-native-test-key",
  }, writes);
  await database.source_delivery_occurrences.createMany({
    data: semanticSources.map((semantic, recordIndex) => ({
      organization_id: organizationId,
      provider_id: alphaProviderId,
      source_instance_id: fixture.alphaSourceInstanceId,
      source_revision_id: fixture.alphaSourceRevisionId,
      run_id: runId,
      page_id: pageId,
      record_index: recordIndex,
      source_record_id: semantic.sourceRecordId,
      semantic_observation_id: semantic.semanticObservationId,
      request_attempt_id: requestAttemptId,
      source_type_key: "release-source-v1",
      source_adapter_version: "release-adapter-v1",
      normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      mapper_key: "alpha-release-mapper",
      mapper_version: "v1",
      identity_namespace_key: "alpha-release-records",
      cursor_codec_version: "release-cursor-v1",
      cursor_generation: 1n,
      connection_health_generation: 0n,
      supervisor_epoch_id: fixture.supervisorEpochId,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      collected_at: semantic.collectedAt,
      native_evidence_reference: semantic.nativeEvidenceReference,
      disposition: results[recordIndex]?.created ? "inserted" : "duplicate",
    })),
  });
  return results;
}

async function addWriterPullAssetPackAssociation(
  database: PackscoutTransactionClient,
  fixture: SeededProviderRelease,
  input: Readonly<{
    associationKey?: string;
    assetExternalId?: string;
    includeCard?: boolean;
    includePack?: boolean;
    projectAsset?: boolean;
    packExternalId?: string;
    relationshipAt?: Date;
    expectedExistingRelationshipCount?: number;
  }> = {},
): Promise<Readonly<{
  sourceEntityId: string;
  publicChangeSequence: bigint;
  associatedAt: Date;
}>> {
  const associationKey = input.associationKey ?? "associated";
  const includeCard = input.includeCard ?? true;
  const includePack = input.includePack ?? true;
  if (!includeCard && !includePack) {
    throw new RangeError("A V1 pull requires at least one relationship.");
  }
  const assetExternalId = input.assetExternalId ?? `asset-${associationKey}`;
  const pullExternalId = `pull-${associationKey}`;
  const relationshipAt = input.relationshipAt ??
    new Date("2026-08-16T11:41:00.000Z");
  const projectionAt = new Date(relationshipAt.getTime() - 60_000);
  const projectAsset = includeCard && input.projectAsset !== false;
  const packExternalId = input.packExternalId ?? "a-1";
  const projections: CanonicalProjectionInput[] = [];
  if (projectAsset) {
    projections.push({
        platformKey: "alpha",
        recordKind: "catalog_asset",
        externalId: assetExternalId,
        content: {
          schemaVersion: "catalog-projection-v1",
          entityType: "catalog_asset",
          assetType: "card",
          relatedPackExternalId: null,
          parentExternalId: null,
          firstSeenAt: projectionAt.toISOString(),
          name: "Associated asset",
          description: null,
          category: null,
          availability: "available",
          sourceStatus: null,
          providerValueMinor: 5_000,
          providerValueCurrency: "USD",
          valueSource: "provider-reported",
          imageUrls: [],
          dataQualityEvidence: [],
        },
        sourceUpdatedAt: projectionAt,
        sourceCollectedAt: projectionAt,
      });
  }
  projections.push({
      platformKey: "alpha",
      recordKind: "pull",
      externalId: pullExternalId,
      content: {
        eventKind: "pull",
        displayName: "Associated asset",
        imageUrls: [],
        value: { amountMinor: 5_000, currency: "USD" },
        valueSource: "provider-reported",
      },
      sourceUpdatedAt: relationshipAt,
      sourceCollectedAt: relationshipAt,
      relationships: [
        ...(includeCard ? [{
          relationshipKind: "card",
          targetPlatformKey: "alpha",
          targetRecordKind: "catalog_asset" as const,
          targetExternalId: assetExternalId,
        }] : []),
        ...(includePack ? [{
          relationshipKind: "pack",
          targetPlatformKey: "alpha",
          targetRecordKind: "pack" as const,
          targetExternalId: packExternalId,
        }] : []),
      ],
    });
  await writeSourceNativeReleasePage(
    database,
    fixture,
    relationshipAt,
    projections,
  );
  const pull = await database.canonical_entities.findFirstOrThrow({
    where: {
      organization_id: organizationId,
      platform_key: "alpha",
      record_kind: "pull",
      external_id: pullExternalId,
    },
    select: { id: true },
  });
  const pullRevision = await database.canonical_revisions.findFirstOrThrow({
    where: {
      organization_id: organizationId,
      entity_id: pull.id,
    },
    orderBy: { revision_number: "desc" },
    select: { public_change_sequence: true },
  });
  assert.deepEqual((await database.public_change_catalog_impacts.findUniqueOrThrow({
    where: {
      organization_id_cause_sequence: {
        organization_id: organizationId,
        cause_sequence: pullRevision.public_change_sequence,
      },
    },
    select: { provider_platform_keys: true },
  })).provider_platform_keys, []);
  const relationships = await database.canonical_relationships.findMany({
    where: {
      organization_id: organizationId,
      source_entity_id: pull.id,
    },
    orderBy: { relationship_kind: "asc" },
  });
  assert.equal(
    relationships.length,
    Number(includeCard) + Number(includePack) +
      (input.expectedExistingRelationshipCount ?? 0),
  );
  const v1Relationships = relationships.filter((relationship) =>
    relationship.relationship_kind === "card"
      ? relationship.target_external_id === assetExternalId
      : relationship.relationship_kind === "pack" &&
        relationship.target_external_id === packExternalId);
  assert.equal(v1Relationships.length, Number(includeCard) + Number(includePack));
  const publicChangeSequence = v1Relationships.reduce(
    (maximum, relationship) =>
      relationship.resolved_public_change_sequence! > maximum
        ? relationship.resolved_public_change_sequence!
        : maximum,
    0n,
  );
  await advanceSettledPublicWatermark(database, {
    organizationId,
    settledAt: relationshipAt,
  });
  return {
    sourceEntityId: pull.id,
    publicChangeSequence,
    associatedAt: relationshipAt,
  };
}

test("provider snapshot accepts production-writer V1 pull causality and pairs its relationships", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const association = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture));
    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(snapshot.assetPackAssociations, [{
      sourceEntityId: association.sourceEntityId,
      platformKey: "alpha",
      assetExternalId: "asset-associated",
      packExternalId: "a-1",
      associatedAt: association.associatedAt,
      publicChangeSequence: association.publicChangeSequence,
    }]);
  } finally {
    await harness.close();
  }
});

test("a post-read-clock V1 confirmation stays out even when its sequence is eligible", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const associatedAt = new Date("2026-08-16T11:41:00.000Z");
    const readAt = new Date("2026-08-16T11:40:00.000Z");
    const association = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "later-than-read-clock",
        relationshipAt: associatedAt,
      }));

    const historical = await loadProviderV1AssetPackAssociations(
      harness.client,
      {
        organizationId,
        platformKey: "alpha",
        sourceRevisionId: fixture.alphaSourceRevisionId,
        // Deliberately include the confirmation's native sequence. The clock,
        // not the sequence, is what keeps this later write out of the replay.
        throughSequence: association.publicChangeSequence,
        throughOccurredAt: readAt,
      },
    );
    assert.deepEqual(historical, []);

    const current = await loadProviderV1AssetPackAssociations(harness.client, {
      organizationId,
      platformKey: "alpha",
      sourceRevisionId: fixture.alphaSourceRevisionId,
      throughSequence: association.publicChangeSequence,
      throughOccurredAt: associatedAt,
    });
    assert.deepEqual(current, [{
      sourceEntityId: association.sourceEntityId,
      platformKey: "alpha",
      assetExternalId: "asset-later-than-read-clock",
      packExternalId: "a-1",
      associatedAt,
      publicChangeSequence: association.publicChangeSequence,
    }]);
  } finally {
    await harness.close();
  }
});

test("resolved one-sided V1 pulls remain valid while only complete pairs associate", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const complete = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "complete",
      }));
    const cardOnly = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "card-only",
        includePack: false,
      }));
    const packOnly = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "pack-only",
        includeCard: false,
      }));

    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(snapshot.assetPackAssociations, [{
      sourceEntityId: complete.sourceEntityId,
      platformKey: "alpha",
      assetExternalId: "asset-complete",
      packExternalId: "a-1",
      associatedAt: complete.associatedAt,
      publicChangeSequence: complete.publicChangeSequence,
    }]);
    assert.equal(snapshot.assetPackAssociations.some(({ sourceEntityId }) =>
      sourceEntityId === cardOnly.sourceEntityId ||
      sourceEntityId === packOnly.sourceEntityId), false);
  } finally {
    await harness.close();
  }
});

test("multiple latest V1 pulls stay paired within their confirmation sets", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const dash = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "grouped-dash",
        packExternalId: "a-1",
        relationshipAt: new Date("2026-08-16T11:41:00.000Z"),
      }));
    const underscore = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "grouped-underscore",
        packExternalId: "a_1",
        relationshipAt: new Date("2026-08-16T11:42:00.000Z"),
      }));

    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(snapshot.assetPackAssociations, [
      {
        sourceEntityId: dash.sourceEntityId,
        platformKey: "alpha",
        assetExternalId: "asset-grouped-dash",
        packExternalId: "a-1",
        associatedAt: dash.associatedAt,
        publicChangeSequence: dash.publicChangeSequence,
      },
      {
        sourceEntityId: underscore.sourceEntityId,
        platformKey: "alpha",
        assetExternalId: "asset-grouped-underscore",
        packExternalId: "a_1",
        associatedAt: underscore.associatedAt,
        publicChangeSequence: underscore.publicChangeSequence,
      },
    ]);
  } finally {
    await harness.close();
  }
});

test("a newer one-sided V1 set replaces an older complete set for the same pull", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const associationKey = "latest-set-one-sided";
    const assetExternalId = `asset-${associationKey}`;
    const pullExternalId = `pull-${associationKey}`;
    const firstAt = new Date("2026-08-16T11:41:00.000Z");
    const secondAt = new Date("2026-08-16T11:42:00.000Z");
    const first = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey,
        relationshipAt: firstAt,
      }));

    await harness.client.$transaction(async (transaction) => {
      await writeSourceNativeReleasePage(
        transaction,
        fixture,
        secondAt,
        [{
          platformKey: "alpha",
          recordKind: "pull",
          externalId: pullExternalId,
          content: {
            eventKind: "pull",
            displayName: "Associated asset",
            imageUrls: [],
            value: { amountMinor: 5_000, currency: "USD" },
            valueSource: "provider-reported",
          },
          sourceUpdatedAt: secondAt,
          sourceCollectedAt: secondAt,
          relationships: [{
            relationshipKind: "card",
            targetPlatformKey: "alpha",
            targetRecordKind: "catalog_asset",
            targetExternalId: assetExternalId,
          }],
        }],
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: secondAt,
      });
    });

    const confirmationSets = await harness.client
      .source_relationship_confirmation_sets.findMany({
        where: {
          organization_id: organizationId,
          source_entity_id: first.sourceEntityId,
        },
        orderBy: { public_change_sequence: "asc" },
        select: { relationship_count: true },
      });
    assert.deepEqual(
      confirmationSets.map(({ relationship_count }) => relationship_count),
      [2, 1],
    );

    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.equal(
      snapshot.assetPackAssociations.some(({ sourceEntityId }) =>
        sourceEntityId === first.sourceEntityId),
      false,
      "the release must not combine a card from the latest set with a pack from an older set",
    );
  } finally {
    await harness.close();
  }
});

test("retained legacy pull edges are audit-only beside the latest V1 relationship set", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const association = await harness.client.$transaction(async (transaction) => {
      await addLegacyPullRelationshipSet(
        transaction,
        fixture,
        "legacy-cutover",
      );
      return addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "legacy-cutover",
        expectedExistingRelationshipCount: 4,
      });
    });
    const relationships = await harness.client.canonical_relationships.findMany({
      where: {
        organization_id: organizationId,
        source_entity_id: association.sourceEntityId,
      },
      orderBy: { relationship_kind: "asc" },
      select: { relationship_kind: true },
    });
    assert.deepEqual(relationships.map(({ relationship_kind }) => relationship_kind), [
      "asset",
      "card",
      "card",
      "pack",
      "pack",
      "subject",
    ]);

    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(snapshot.assetPackAssociations, [{
      sourceEntityId: association.sourceEntityId,
      platformKey: "alpha",
      assetExternalId: "asset-legacy-cutover",
      packExternalId: "a-1",
      associatedAt: association.associatedAt,
      publicChangeSequence: association.publicChangeSequence,
    }]);
  } finally {
    await harness.close();
  }
});

test("duplicate V1 pull evidence returns one stable asset-pack establishment", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    const first = await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "pair-first",
        assetExternalId: "asset-shared-pair",
        relationshipAt: new Date("2026-08-16T11:41:00.000Z"),
      }));
    const firstSnapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(firstSnapshot.assetPackAssociations, [{
      sourceEntityId: first.sourceEntityId,
      platformKey: "alpha",
      assetExternalId: "asset-shared-pair",
      packExternalId: "a-1",
      associatedAt: first.associatedAt,
      publicChangeSequence: first.publicChangeSequence,
    }]);

    await harness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "pair-later",
        assetExternalId: "asset-shared-pair",
        projectAsset: false,
        relationshipAt: new Date("2026-08-16T12:41:00.000Z"),
      }));
    const laterSnapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(
      laterSnapshot.assetPackAssociations,
      firstSnapshot.assetPackAssociations,
    );
    assert.equal(laterSnapshot.assetPackAssociations.length, 1);
  } finally {
    await harness.close();
  }
});

test("unconfirmed legacy pull sets remain audit-only", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction((transaction) =>
      addPullAssetPackAssociation(transaction, fixture, {
        pullExternalId: "pull-multi-pack",
        assetExternalId: "asset-multi-pack",
        packExternalIds: ["a-1", "a_1"],
      }));
    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(harness),
    });
    assert.deepEqual(snapshot.assetPackAssociations, []);
  } finally {
    await harness.close();
  }
});

test("unresolved V1 pull edges are non-contributing and invalid future resolution fails closed", async () => {
  const unresolvedHarness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(unresolvedHarness);
    await unresolvedHarness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "unresolved-pack",
        packExternalId: "missing-pack",
      }));
    const snapshot = await fixture.alphaRepository.loadProviderSnapshot({
      checkpoint: await currentAlphaCheckpoint(unresolvedHarness),
    });
    assert.deepEqual(snapshot.assetPackAssociations, []);
  } finally {
    await unresolvedHarness.close();
  }

  const lateHarness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(lateHarness);
    const association = await lateHarness.client.$transaction((transaction) =>
      addWriterPullAssetPackAssociation(transaction, fixture, {
        associationKey: "late-pack",
        packExternalId: "pack-created-late",
      }));
    const unresolvedPackRelationship =
      await lateHarness.client.canonical_relationships.findFirstOrThrow({
        where: {
          organization_id: organizationId,
          source_entity_id: association.sourceEntityId,
          relationship_kind: "pack",
          target_external_id: "pack-created-late",
        },
        select: { id: true },
      });
    const targetEntityId = randomUUID();
    await lateHarness.client.$transaction(async (transaction) => {
      const targetAt = new Date("2026-08-16T11:41:30.000Z");
      const targetSourceRecordId = randomUUID();
      const targetRevisionId = randomUUID();
      const targetContent = packContent("Late pack target");
      const [targetCause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha:pack:pack-created-late",
          sourceKey: "alpha",
          sourceRevisionKey: fixture.alphaSourceRevisionId,
          occurredAt: targetAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      assert.ok(targetCause);
      await transaction.source_records.create({
        data: {
          id: targetSourceRecordId,
          organization_id: organizationId,
          provider_id: alphaProviderId,
          first_run_id: fixture.alphaRunId,
          first_page_id: fixture.alphaPageId,
          record_kind: "catalog",
          external_id: "pack-created-late",
          source_time: targetAt,
          collected_at: targetAt,
          content_hash: hashJson(targetContent),
          expires_at: new Date("2026-11-16T11:41:30.000Z"),
        },
      });
      await transaction.canonical_entities.create({
        data: {
          id: targetEntityId,
          organization_id: organizationId,
          platform_key: "alpha",
          record_kind: "pack",
          external_id: "pack-created-late",
        },
      });
      await transaction.canonical_revisions.create({
        data: {
          id: targetRevisionId,
          organization_id: organizationId,
          entity_id: targetEntityId,
          revision_number: 1,
          source_record_id: targetSourceRecordId,
          content_json: targetContent as Prisma.InputJsonValue,
          content_hash: hashJson(targetContent),
          provenance_json: {},
          provenance_hash: hashJson({}),
          source_updated_at: targetAt,
          source_collected_at: targetAt,
          accepted_at: targetAt,
          public_change_sequence: targetCause.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: targetEntityId },
        data: { current_revision_id: targetRevisionId },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: targetAt,
      });
    });
    const checkpoint = await currentAlphaCheckpoint(lateHarness);
    await lateHarness.client.$transaction(async (transaction) => {
      const [lateCause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "relationship_resolution",
          entityKey: "relationship:v1:alpha:pull:pull-late-pack:late",
          sourceKey: "alpha",
          sourceRevisionKey: fixture.alphaSourceRevisionId,
          occurredAt: new Date("2026-08-16T11:42:00.000Z"),
          catalogImpact: { kind: "none" },
        }],
      });
      assert.ok(lateCause);
      await transaction.canonical_relationships.update({
        where: { id: unresolvedPackRelationship.id },
        data: {
          target_entity_id: targetEntityId,
          resolved_public_change_sequence: lateCause.sequence,
          resolved_at: new Date("2026-08-16T11:42:00.000Z"),
        },
      });
    });
    await assert.rejects(
      fixture.alphaRepository.loadProviderSnapshot({ checkpoint }),
      assertSourceError("PROVIDER_RELEASE_SOURCE_INVALID"),
    );
  } finally {
    await lateHarness.close();
  }
});

test("legacy pull links are noncontributing while protected provider content fails closed", async () => {
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
    assert.deepEqual(snapshot.assetPackAssociations, []);
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
      assertSourceError("PROVIDER_RELEASE_SCOPE_MISMATCH"),
    );
  } finally {
    await harness.close();
  }
});

test("a relationship cannot resolve before its target has canonical evidence", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const fixture = await seedProviderRelease(harness);
    await harness.client.$transaction(async (transaction) => {
      const targetEntityId = randomUUID();
      const targetExternalId = "target-revised-after-resolution";
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
        relationshipKind: "target-before-evidence",
      });

      const revisionAt = new Date("2026-08-16T11:31:00.000Z");
      const content = {
        schemaVersion: "catalog-projection-v1",
        entityType: "catalog_asset",
        assetType: "card",
        relatedPackExternalId: null,
        parentExternalId: null,
        firstSeenAt: revisionAt.toISOString(),
        name: "Late target",
        description: null,
        category: null,
        availability: "available",
        sourceStatus: null,
        providerValueMinor: null,
        providerValueCurrency: null,
        valueSource: null,
        imageUrls: [],
        dataQualityEvidence: [],
      };
      const sourceRecordId = randomUUID();
      await transaction.source_records.create({
        data: {
          id: sourceRecordId,
          organization_id: organizationId,
          provider_id: alphaProviderId,
          first_run_id: fixture.alphaRunId,
          first_page_id: fixture.alphaPageId,
          record_kind: "catalog",
          external_id: targetExternalId,
          source_time: revisionAt,
          collected_at: revisionAt,
          content_hash: hashJson(content),
          expires_at: new Date("2026-11-16T11:31:00.000Z"),
        },
      });
      const [revisionCause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: `canonical:v1:alpha:catalog_asset:${targetExternalId}`,
          sourceKey: "alpha",
          sourceRevisionKey: fixture.alphaSourceRevisionId,
          occurredAt: revisionAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      assert.ok(revisionCause);
      const revision = await transaction.canonical_revisions.create({
        data: {
          organization_id: organizationId,
          entity_id: targetEntityId,
          revision_number: 1,
          source_record_id: sourceRecordId,
          content_json: content,
          content_hash: hashJson(content),
          provenance_json: {},
          provenance_hash: hashJson({}),
          source_updated_at: revisionAt,
          source_collected_at: revisionAt,
          accepted_at: revisionAt,
          public_change_sequence: revisionCause.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: targetEntityId },
        data: { current_revision_id: revision.id },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: revisionAt,
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
