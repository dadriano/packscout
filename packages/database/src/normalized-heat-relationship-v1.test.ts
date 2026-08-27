import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContent,
  normalizedProviderObservationSchema,
  type NormalizedProviderObservation,
  type ProviderSourceCanonicalProjectionPlan,
} from "@packscout/contracts";
import { writeCanonicalProjectionBatch } from
  "./ingestion-page-batch-writer.ts";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import {
  resolveConfirmedRelationshipsForNewTargets,
} from "./canonical-relationship-batch-writer.ts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  PrismaNormalizedHeatObservationRepository,
} from "./normalized-heat-observation-repository.ts";
import { persistNormalizedHeatObservationsForCanonicalWrites } from
  "./normalized-heat-persistence.ts";
import { PrismaNormalizedHeatRelationshipBackfillRepository } from
  "./normalized-heat-relationship-backfill-repository.ts";
import { assertNormalizedHeatExpandedWriteBound } from
  "./normalized-heat-write-bound.ts";
import { PrismaPublicRepackIdentityMappingRepository } from
  "./public-repack-identity-mapping-repository.ts";
import type { CanonicalProjectionInput, CommitPageInput } from
  "./pipeline-types.ts";
import { ProviderSourceLifecycleRepository } from
  "./provider-source-lifecycle-repository.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
} from "./provider-source-observation-repository.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";
import { hashJson } from "./security.ts";
import { PrismaSourceRelationshipConfirmationBackfillRepository } from
  "./source-relationship-confirmation-backfill-repository.ts";

const ids = {
  organization: "55000000-0000-4000-8000-000000000001",
  provider: "55000000-0000-4000-8000-000000000010",
  configuration: "55000000-0000-4000-8000-000000000020",
  samePageRun: "55000000-0000-4000-8000-000000000030",
  latePullRun: "55000000-0000-4000-8000-000000000031",
  lateTargetsRun: "55000000-0000-4000-8000-000000000032",
  boundRun: "55000000-0000-4000-8000-000000000033",
  boundTargetsRun: "55000000-0000-4000-8000-000000000034",
  boundCardRun: "55000000-0000-4000-8000-000000000035",
  legacyOnlyRun: "55000000-0000-4000-8000-000000000036",
  publicRepack: "11111111-1111-5111-8111-111111111111",
  secondPublicRepack: "22222222-2222-5222-8222-222222222222",
  settlementToken: "55000000-0000-4000-8000-000000000099",
} as const;

const anchorAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);

async function mutateHeatBackfillFixture(
  database: PackscoutPrismaClient,
  mutation: (transaction: PackscoutTransactionClient) => Promise<void>,
): Promise<void> {
  await database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "alter table public.normalized_heat_relationship_backfills "
        + "disable trigger normalized_heat_relationship_backfills_monotonic",
    );
    try {
      await mutation(transaction);
    } finally {
      await transaction.$executeRawUnsafe(
        "alter table public.normalized_heat_relationship_backfills "
          + "enable trigger normalized_heat_relationship_backfills_monotonic",
      );
    }
  });
}

function packContent(firstSeenAt: Date) {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "pack",
    evInputStatus: "not_applicable",
    parentExternalId: null,
    firstSeenAt: firstSeenAt.toISOString(),
    name: "Pack One",
    category: null,
    description: null,
    availability: "available",
    availabilityProvenance: {
      kind: "canonical_provider_observation",
      observedAvailability: "available",
    },
    sourceStatus: null,
    priceValueMinor: 2_500,
    priceCurrency: "USD",
    providerReportedEvValueMinor: null,
    providerReportedEvCurrency: null,
    buybackPercent: 80,
    drawCount: 1,
    imageUrls: [],
    dataQualityEvidence: [],
  };
}

function assetContent(firstSeenAt: Date) {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "catalog_asset",
    assetType: "card",
    relatedPackExternalId: null,
    parentExternalId: null,
    firstSeenAt: firstSeenAt.toISOString(),
    name: "Card One",
    description: null,
    category: null,
    availability: "available",
    sourceStatus: null,
    providerValueMinor: 5_000,
    providerValueCurrency: "USD",
    valueSource: "provider-reported",
    imageUrls: [],
    dataQualityEvidence: [],
  };
}

function pullContent(valueMinor: number) {
  return {
    eventKind: "pull",
    displayName: "Card One",
    imageUrls: [],
    value: { amountMinor: valueMinor, currency: "USD" },
    valueSource: "provider-reported",
  };
}

function pullRelationships(
  packExternalId = "pack-1",
  assetExternalId = "asset-1",
) {
  // This is the approved production V1 order: the pack edge causes the pull;
  // the later card edge completes pack-scoped catalog evidence.
  return [
    {
      relationshipKind: "pack",
      targetPlatformKey: "platform-a",
      targetRecordKind: "pack" as const,
      targetExternalId: packExternalId,
    },
    {
      relationshipKind: "card",
      targetPlatformKey: "platform-a",
      targetRecordKind: "catalog_asset" as const,
      targetExternalId: assetExternalId,
    },
  ];
}

type TestDatabase = Awaited<
  ReturnType<typeof createMigratedTestDatabase>
>["client"];

async function seed(input: { database: TestDatabase; configuredAt: Date }) {
  const setup = new PipelineSetupRepository(input.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "heat-v1",
    name: "Heat V1",
    createdAt: input.configuredAt,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: "platform-a",
    displayName: "Provider A",
    createdAt: input.configuredAt,
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: "https://private-provider.example/feed",
    authMode: "none",
    createdByActorKey: "operator:test",
    createdAt: input.configuredAt,
  });
  await setup.recordSuccessfulConnectionTest({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.configuration,
    actorKey: "operator:test",
    testedAt: input.configuredAt,
    latencyMs: 1,
  });
  await setup.activateConfiguration({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.configuration,
    actorKey: "operator:test",
    activatedAt: input.configuredAt,
    nextRunAt: input.configuredAt,
  });
  const lifecycle = new ProviderSourceLifecycleRepository(input.database);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId: ids.organization,
    sourceTypeKey: "dataforrest-events-v1",
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: "Heat V1 source-native connection",
    requestLimit: 1,
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator:test",
    createdAt: input.configuredAt,
  });
  const source = await lifecycle.createSourceInstanceRevision({
    organizationId: ids.organization,
    providerId: ids.provider,
    connectionProfileId: connection.profileId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: "heat-v1-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "heat-v1-records",
    cursorCodecVersion: "dataforrest-cursor-v1",
    revisionNumber: 1,
    intervalSeconds: 60,
    configuration: { provider: "platform-a" },
    configurationHash: "b".repeat(64),
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    actorKey: "operator:test",
    createdAt: input.configuredAt,
  });
  const supervisorEpochId = randomUUID();
  const supervisorLeaseToken = randomUUID();
  await input.database.source_supervisor_epochs.create({
    data: {
      id: supervisorEpochId,
      environment_key: `heat-v1-${ids.organization}`,
      epoch_number: 1n,
      state: "active",
      owner_key: "heat-v1-test-worker",
      lease_token: supervisorLeaseToken,
      acquired_at: input.configuredAt,
      last_renewed_at: input.configuredAt,
      lease_expires_at: new Date(input.configuredAt.getTime() + 60 * 60 * 1_000),
      takeover_not_before: new Date(
        input.configuredAt.getTime() + 60 * 60 * 1_000 + 15_000,
      ),
    },
  });
  await input.database.$transaction(async (transaction) => {
    const [cause] = await allocatePublicChangeCauses(transaction, {
      organizationId: ids.organization,
      changes: [{
        changeKind: "public_configuration",
        entityKey: "public-config:v1:heat-v1",
        sourceKey: "catalog-release",
        sourceRevisionKey: "catalog-config-v1",
        occurredAt: input.configuredAt,
        catalogImpact: {
          kind: "catalog",
          providerPlatformKeys: ["platform-a"],
          sharedConfigurationEpoch: {
            configurationKey: "catalog-config-v1",
            revision: 1,
            configurationHash: "1".padStart(64, "0"),
          },
        },
      }],
    });
    if (!cause) throw new Error("Mapping cause is missing.");
    await transaction.approved_public_catalog_configurations.create({
      data: {
        organization_id: ids.organization,
        configuration_key: "catalog-config-v1",
        revision: 1,
        configuration_json: { platforms: [{ platformKey: "platform-a" }] },
        configuration_hash: "1".padStart(64, "0"),
        approved_at: input.configuredAt,
        public_change_sequence: cause.sequence,
        created_at: input.configuredAt,
      },
    });
    const mappings = new PrismaPublicRepackIdentityMappingRepository(transaction);
    await mappings.registerApprovedMapping({
      organizationId: ids.organization,
      platformKey: "platform-a",
      packExternalId: "pack-1",
      publicRepackId: ids.publicRepack,
      approvedConfigurationKey: "catalog-config-v1",
      publicChangeSequence: cause.sequence,
      approvedAt: input.configuredAt,
    });
  });
  return {
    setup,
    connectionProfileId: connection.profileId,
    connectionRevisionId: connection.revisionId,
    sourceInstanceId: source.sourceInstanceId,
    sourceRevisionId: source.sourceRevisionId,
    supervisorEpochId,
    supervisorLeaseToken,
    ingestion: new IngestionPersistenceRepository(input.database, {
      retentionDays: 90,
      actorPseudonymKey: "heat-v1-test-key",
    }),
  };
}

async function createRun(
  setup: PipelineSetupRepository,
  runId: string,
  createdAt: Date,
): Promise<void> {
  await setup.createImportRun({
    id: runId,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    trigger: "recovery",
    state: "succeeded",
    createdAt,
  });
}

function page(input: {
  runId: string;
  sourceAt: Date;
  committedAt: Date;
  includeTargets: boolean;
  pullExternalIds: readonly string[];
}): CommitPageInput {
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: input.runId,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: null,
    hasMore: false,
    payload: { protected: "not-normalized" },
    committedAt: input.committedAt,
    records: [
      ...(input.includeTargets ? [{
        recordKind: "catalog" as const,
        externalId: `catalog-${input.runId}`,
        sourceTime: input.sourceAt,
        collectedAt: input.committedAt,
        payload: { protected: "catalog" },
        projections: [
          {
            platformKey: "platform-a",
            recordKind: "pack" as const,
            externalId: "pack-1",
            content: packContent(input.sourceAt),
            sourceUpdatedAt: input.sourceAt,
            sourceCollectedAt: input.committedAt,
          },
          {
            platformKey: "platform-a",
            recordKind: "catalog_asset" as const,
            externalId: "asset-1",
            content: assetContent(input.sourceAt),
            sourceUpdatedAt: input.sourceAt,
            sourceCollectedAt: input.committedAt,
          },
        ],
      }] : []),
      ...input.pullExternalIds.map((externalId, index) => ({
        recordKind: "pull" as const,
        externalId,
        sourceTime: input.sourceAt,
        collectedAt: input.committedAt,
        payload: { protected: `pull-${index}` },
        projections: [{
          platformKey: "platform-a",
          recordKind: "pull" as const,
          externalId,
          content: pullContent(5_000 + index),
          relationships: pullRelationships(),
          sourceUpdatedAt: input.sourceAt,
          sourceCollectedAt: input.committedAt,
        }],
      })),
    ],
  };
}

type SeedFixture = Awaited<ReturnType<typeof seed>>;

function sourceNativeObservation(
  projection: CanonicalProjectionInput,
): NormalizedProviderObservation {
  const common = {
    providerRecordIdentity: {
      recordIdScopeKey: projection.recordKind === "pack"
        ? "catalog-pack-v1" as const
        : projection.recordKind === "catalog_asset"
          ? "catalog-card-v1" as const
          : "pull-v1" as const,
      providerRecordId: projection.externalId,
    },
    effectiveAt: projection.sourceUpdatedAt.toISOString(),
    collectedAt: projection.sourceCollectedAt.toISOString(),
    protectedNativeEvidenceRef: `evidence:${projection.externalId}`,
  };
  if (projection.recordKind === "pack") {
    return normalizedProviderObservationSchema.parse({
      ...common,
      kind: "catalog",
      entity: "pack",
      firstSeenAt: projection.sourceUpdatedAt.toISOString(),
      availability: "available",
      providerFacts: emptyNormalizedProviderFacts("pack"),
      relationships: [],
    });
  }
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
    throw new TypeError("The source-native Heat fixture supports only V1 Heat records.");
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

async function writeSourceNativeV1Page(input: {
  database: TestDatabase;
  fixture: SeedFixture;
  acceptedAt: Date;
  projections: readonly CanonicalProjectionInput[];
  backfillPlans?: Map<string, ProviderSourceCanonicalProjectionPlan>;
  transactionTimeoutMs?: number;
}) {
  const observations = new ProviderSourceObservationRepository();
  return input.database.$transaction(async (transaction) => {
    const runId = randomUUID();
    const runLeaseToken = randomUUID();
    const runClaimLeaseId = randomUUID();
    const requestAttemptId = randomUUID();
    const requestLeaseId = randomUUID();
    const pageId = randomUUID();
    await transaction.import_runs.create({
      data: {
        id: runId,
        organization_id: ids.organization,
        provider_id: ids.provider,
        config_revision_id: null,
        trigger: "manual",
        state: "succeeded",
        requested_by_actor_key: "operator:test",
        started_at: input.acceptedAt,
        finished_at: input.acceptedAt,
        created_at: input.acceptedAt,
        lease_owner: "heat-v1-test-worker",
        lease_token: runLeaseToken,
        claim_lease_id: runClaimLeaseId,
        lease_expires_at: new Date(input.acceptedAt.getTime() + 60_000),
        reached_provider_head: true,
        source_instance_id: input.fixture.sourceInstanceId,
        source_revision_id: input.fixture.sourceRevisionId,
        source_type_key: "dataforrest-events-v1",
        source_adapter_version: "dataforrest-events-adapter-v1",
        normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        mapper_key: "heat-v1-provider-observation",
        mapper_version: "1",
        identity_namespace_key: "heat-v1-records",
        connection_profile_id: input.fixture.connectionProfileId,
        connection_revision_id: input.fixture.connectionRevisionId,
        cursor_codec_version: "dataforrest-cursor-v1",
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
    await transaction.compact_source_request_attempts.create({
      data: {
        request_attempt_id: requestAttemptId,
        organization_id: ids.organization,
        operation_kind: "page_read",
        terminal_state: "captured",
        outcome_class: "response_captured",
        safe_outcome_hash: "c".repeat(64),
        request_lease_id: requestLeaseId,
        claim_owner: "heat-v1-test-worker",
        claim_token: runLeaseToken,
        supervisor_epoch_id: input.fixture.supervisorEpochId,
        connection_profile_id: input.fixture.connectionProfileId,
        connection_revision_id: input.fixture.connectionRevisionId,
        expected_health_generation: 0n,
        provider_id: ids.provider,
        source_instance_id: input.fixture.sourceInstanceId,
        source_revision_id: input.fixture.sourceRevisionId,
        run_id: runId,
        page_number: 1,
        cursor_generation: 1n,
        requested_cursor_fingerprint: null,
        requested_cursor_key: "initial",
        response_bytes: 1,
        duration_ms: 1,
        started_at: input.acceptedAt,
        terminal_at: input.acceptedAt,
      },
    });
    await transaction.import_pages.create({
      data: {
        id: pageId,
        organization_id: ids.organization,
        provider_id: ids.provider,
        run_id: runId,
        page_number: 1,
        requested_cursor: null,
        next_cursor: null,
        has_more: null,
        payload_hash: "d".repeat(64),
        record_counts_json: { records: input.projections.length },
        committed_at: input.acceptedAt,
        expires_at: new Date(input.acceptedAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
        source_instance_id: input.fixture.sourceInstanceId,
        source_revision_id: input.fixture.sourceRevisionId,
        source_type_key: "dataforrest-events-v1",
        source_adapter_version: "dataforrest-events-adapter-v1",
        normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        mapper_key: "heat-v1-provider-observation",
        mapper_version: "1",
        identity_namespace_key: "heat-v1-records",
        connection_profile_id: input.fixture.connectionProfileId,
        connection_revision_id: input.fixture.connectionRevisionId,
        connection_health_generation: 0n,
        request_attempt_id: requestAttemptId,
        run_claim_lease_id: runClaimLeaseId,
        supervisor_epoch_id: input.fixture.supervisorEpochId,
        cursor_codec_version: "dataforrest-cursor-v1",
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
    const writes = [];
    const semanticSources = [];
    for (const [projectionIndex, projection] of input.projections.entries()) {
      const observation = sourceNativeObservation(projection);
      const normalizedContent = normalizedObservationSemanticContent(observation);
      const meaning = projection.recordKind === "pack"
        ? {
            recordKind: "catalog" as const,
            recordDiscriminator: "catalog_pack" as const,
          }
        : projection.recordKind === "catalog_asset"
          ? {
              recordKind: "catalog" as const,
              recordDiscriminator: "catalog_card" as const,
            }
          : {
              recordKind: "pull" as const,
              recordDiscriminator: "pull" as const,
            };
      const semantic = await observations.upsertSemanticObservationInTransaction(
        transaction,
        {
          organizationId: ids.organization,
          providerId: ids.provider,
          sourceInstanceId: input.fixture.sourceInstanceId,
          sourceRevisionId: input.fixture.sourceRevisionId,
          recordIdScopeKey:
            observation.providerRecordIdentity.recordIdScopeKey,
          providerRecordId:
            observation.providerRecordIdentity.providerRecordId,
          effectiveSourceTime: new Date(observation.effectiveAt),
          normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
          normalizedContentHash:
            hashNormalizedObservationSemanticContent(normalizedContent),
          normalizedContent,
          ...meaning,
        },
        { skipSourceRevisionFenceCheck: projectionIndex > 0 },
      );
      if (semantic.kind !== "ready") {
        throw new Error("Source-native V1 semantic identity conflicted.");
      }
      input.backfillPlans?.set(semantic.semanticObservationId, {
        projectionKind: "primary",
        platformKey: projection.platformKey as
          ProviderSourceCanonicalProjectionPlan["platformKey"],
        recordKind: projection.recordKind,
        providerRecordId: projection.externalId,
        recordIdScopeKey:
          observation.providerRecordIdentity.recordIdScopeKey,
        effectiveAt: projection.sourceUpdatedAt.toISOString(),
        contentFingerprint: hashJson(projection.content),
        content: projection.content,
        relationships: (projection.relationships ?? []).map((relationship) => ({
          relationship: relationship.relationshipKind as "card" | "pack",
          targetRecordIdScopeKey: relationship.targetRecordKind === "pack"
            ? "catalog-pack-v1" as const
            : "catalog-card-v1" as const,
          targetCanonicalKind: relationship.targetRecordKind as
            | "catalog_asset"
            | "pack",
          targetProviderRecordId: relationship.targetExternalId!,
        })),
        affectedPackProviderRecordId:
          projection.recordKind === "pack" ? projection.externalId : null,
        evInputStatus: projection.recordKind === "pack"
          ? "not_applicable"
          : "not_applicable",
      });
      semanticSources.push({
        sourceRecordId: semantic.sourceRecordId,
        semanticObservationId: semantic.semanticObservationId,
        collectedAt: projection.sourceCollectedAt,
        nativeEvidenceReference: observation.protectedNativeEvidenceRef,
      });
      writes.push({
        organizationId: ids.organization,
        providerId: ids.provider,
        origin: {
          kind: "semantic_observation" as const,
          sourceRevisionId: input.fixture.sourceRevisionId,
          semanticObservationId: semantic.semanticObservationId,
        },
        projection,
        projectionIndex,
        becomesCurrent: true,
        acceptedAt: input.acceptedAt,
        publicChangeKind: "provider_projection" as const,
      });
    }
    const results = await writeCanonicalProjectionBatch(
      transaction,
      { retentionDays: 90, actorPseudonymKey: "heat-v1-source-native" },
      writes,
    );
    await transaction.source_delivery_occurrences.createMany({
      data: semanticSources.map((semantic, recordIndex) => ({
        organization_id: ids.organization,
        provider_id: ids.provider,
        source_instance_id: input.fixture.sourceInstanceId,
        source_revision_id: input.fixture.sourceRevisionId,
        run_id: runId,
        page_id: pageId,
        record_index: recordIndex,
        source_record_id: semantic.sourceRecordId,
        semantic_observation_id: semantic.semanticObservationId,
        request_attempt_id: requestAttemptId,
        source_type_key: "dataforrest-events-v1",
        source_adapter_version: "dataforrest-events-adapter-v1",
        normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        mapper_key: "heat-v1-provider-observation",
        mapper_version: "1",
        identity_namespace_key: "heat-v1-records",
        cursor_codec_version: "dataforrest-cursor-v1",
        cursor_generation: 1n,
        connection_health_generation: 0n,
        supervisor_epoch_id: input.fixture.supervisorEpochId,
        connection_profile_id: input.fixture.connectionProfileId,
        connection_revision_id: input.fixture.connectionRevisionId,
        collected_at: semantic.collectedAt,
        native_evidence_reference: semantic.nativeEvidenceReference,
        disposition: results[recordIndex]?.created ? "inserted" : "duplicate",
      })),
    });
    return results;
  }, { maxWait: 5_000, timeout: input.transactionTimeoutMs ?? 120_000 });
}

interface RelationshipRow {
  relationshipId: string;
  canonicalRevisionId: string;
  sourceExternalId: string;
  relationshipKind: "pack" | "card";
  resolvedPublicChangeSequence: bigint;
  effectivePublicChangeSequence: bigint;
}

async function relationships(database: TestDatabase): Promise<RelationshipRow[]> {
  return database.$queryRaw<RelationshipRow[]>`
    select relationship.id::text as "relationshipId",
           confirmation.source_canonical_revision_id::text
             as "canonicalRevisionId",
           source.external_id as "sourceExternalId",
           relationship.relationship_kind as "relationshipKind",
           relationship.resolved_public_change_sequence
             as "resolvedPublicChangeSequence",
           greatest(
             confirmation.public_change_sequence,
             relationship.resolved_public_change_sequence
           ) as "effectivePublicChangeSequence"
    from public.canonical_relationships as relationship
    join public.canonical_entities as source
      on source.id = relationship.source_entity_id
     and source.organization_id = relationship.organization_id
    join lateral (
      select confirmation_set.source_canonical_revision_id,
             confirmation_set.public_change_sequence
      from public.source_relationship_confirmations as confirmation_item
      join public.source_relationship_confirmation_sets as confirmation_set
        on confirmation_set.id = confirmation_item.confirmation_set_id
       and confirmation_set.organization_id =
         confirmation_item.organization_id
      where confirmation_item.organization_id = relationship.organization_id
        and confirmation_item.canonical_relationship_id = relationship.id
      order by confirmation_set.public_change_sequence asc,
               confirmation_set.id asc
      limit 1
    ) as confirmation on true
    where relationship.organization_id = ${ids.organization}::uuid
      and source.record_kind = 'pull'
    order by source.external_id, relationship.relationship_kind
  `;
}

async function settleAll(input: {
  database: TestDatabase;
  settledAt: Date;
}): Promise<bigint> {
  return input.database.$transaction(async (transaction) => {
    await transaction.public_derivation_obligations.updateMany({
      where: { organization_id: ids.organization },
      data: {
        state: "succeeded",
        outcome_classification: "success",
        acknowledged_claim_token: ids.settlementToken,
        outcome_at: input.settledAt,
        updated_at: input.settledAt,
      },
    });
    const watermark = await advanceSettledPublicWatermark(transaction, {
      organizationId: ids.organization,
      settledAt: input.settledAt,
    });
    return watermark.settledSequence;
  });
}

test("same-page V1 relationships cause pull and deduplicated catalog Heat evidence", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const configuredAt = anchorAt;
    const sourceAt = new Date(anchorAt.getTime() + 1_000);
    const committedAt = new Date(anchorAt.getTime() + 2_000);
    const fixture = await seed({ database: harness.client, configuredAt });
    const sourcePage = page({
      runId: ids.samePageRun,
      sourceAt,
      committedAt,
      includeTargets: true,
      pullExternalIds: ["pull-a", "pull-b"],
    });
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: committedAt,
      projections: sourcePage.records.flatMap(({ projections }) => projections),
    });

    const relationshipRows = await relationships(harness.client);
    const packRelationships = relationshipRows.filter(
      ({ relationshipKind }) => relationshipKind === "pack",
    );
    const cardRelationships = relationshipRows.filter(
      ({ relationshipKind }) => relationshipKind === "card",
    );
    assert.equal(packRelationships.length, 2);
    assert.equal(cardRelationships.length, 2);
    const relationshipObservations = await harness.client
      .normalized_heat_observations.findMany({
        where: {
          organization_id: ids.organization,
          source_relationship_id: { not: null },
        },
        orderBy: [
          { public_change_sequence: "asc" },
          { observation_kind: "asc" },
        ],
      });
    assert.equal(relationshipObservations.length, 4);
    for (const relationship of packRelationships) {
      const caused = relationshipObservations.filter(
        ({ source_relationship_id }) =>
          source_relationship_id === relationship.relationshipId,
      );
      assert.deepEqual(caused.map(({ observation_kind }) => observation_kind), ["pull"]);
      assert.ok(caused.every(({ public_change_sequence }) =>
        public_change_sequence === relationship.effectivePublicChangeSequence));
      assert.equal(caused.length, 1);
    }
    for (const relationship of cardRelationships) {
      const caused = relationshipObservations.filter(
        ({ source_relationship_id }) =>
          source_relationship_id === relationship.relationshipId,
      );
      assert.deepEqual(
        caused.map(({ observation_kind }) => observation_kind),
        ["catalog_snapshot"],
      );
      assert.equal(
        caused[0]?.public_change_sequence,
        relationship.effectivePublicChangeSequence,
      );
    }
    const catalogObservations = relationshipObservations.filter(
      ({ observation_kind }) => observation_kind === "catalog_snapshot",
    );
    assert.ok(catalogObservations.every(({ available_chase_count }) =>
      available_chase_count === 1));
    assert.ok(catalogObservations.every(({ outcome_keys }) =>
      outcome_keys.length === 1));
    assert.equal(
      catalogObservations.at(-1)?.outcome_keys.length,
      1,
      "two pulls linking the same asset to the same pack must not double count it",
    );

    const relationshipOutcomes = await harness.client
      .normalized_heat_observation_outcomes.findMany({
        where: {
          organization_id: ids.organization,
          source_relationship_id: {
            in: relationshipRows.map(({ relationshipId }) => relationshipId),
          },
        },
      });
    assert.equal(relationshipOutcomes.length, 4);
    assert.equal(
      new Set(relationshipOutcomes.map(({ candidate_key }) => candidate_key)).size,
      4,
    );

    const revisionOrigin = await harness.client.normalized_heat_observations
      .findFirstOrThrow({
        where: {
          organization_id: ids.organization,
          source_relationship_id: null,
          observation_kind: "catalog_snapshot",
        },
      });
    assert.equal(revisionOrigin.source_relationship_id, null);
    assert.ok(catalogObservations.every(({ catalog_sequence }) =>
      catalog_sequence! > revisionOrigin.catalog_sequence!));

    const replay = await harness.client.$transaction((transaction) =>
      persistNormalizedHeatObservationsForCanonicalWrites(transaction, {
        organizationId: ids.organization,
        revisions: [],
        confirmedRelationships: relationshipRows.map((relationship) => ({
          relationshipId: relationship.relationshipId,
          canonicalRevisionId: relationship.canonicalRevisionId,
          publicChangeSequence: relationship.effectivePublicChangeSequence,
        })),
        createdAt: new Date(committedAt.getTime() + 1),
      }));
    assert.deepEqual(replay, {
      normalized: 0,
      deferred: 0,
      rejected: 0,
      duplicate: 4,
    });
  } finally {
    await harness.close();
  }
});

test("latest V1 confirmation replaces retained relationship targets without stale revision Heat", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const configuredAt = new Date(anchorAt.getTime() + 5_000);
    const firstAt = new Date(anchorAt.getTime() + 6_000);
    const secondAt = new Date(anchorAt.getTime() + 7_000);
    const fixture = await seed({ database: harness.client, configuredAt });
    const approved = await harness.client.approved_public_catalog_configurations
      .findUniqueOrThrow({
        where: {
          organization_id_configuration_key: {
            organization_id: ids.organization,
            configuration_key: "catalog-config-v1",
          },
        },
      });
    await harness.client.$transaction(async (transaction) => {
      const mappings = new PrismaPublicRepackIdentityMappingRepository(transaction);
      await mappings.registerApprovedMapping({
        organizationId: ids.organization,
        platformKey: "platform-a",
        packExternalId: "pack-2",
        publicRepackId: ids.secondPublicRepack,
        approvedConfigurationKey: "catalog-config-v1",
        publicChangeSequence: approved.public_change_sequence,
        approvedAt: configuredAt,
      });
    });

    const firstPage = page({
      runId: ids.samePageRun,
      sourceAt: firstAt,
      committedAt: firstAt,
      includeTargets: true,
      pullExternalIds: ["pull-retargeted"],
    });
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: firstAt,
      projections: firstPage.records.flatMap(({ projections }) => projections),
    });
    const firstMaximum = (await harness.client.public_change_causes.aggregate({
      where: { organization_id: ids.organization },
      _max: { sequence: true },
    }))._max.sequence!;

    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: secondAt,
      projections: [
        {
          platformKey: "platform-a",
          recordKind: "pack",
          externalId: "pack-2",
          content: packContent(secondAt),
          sourceUpdatedAt: secondAt,
          sourceCollectedAt: secondAt,
        },
        {
          platformKey: "platform-a",
          recordKind: "catalog_asset",
          externalId: "asset-2",
          content: assetContent(secondAt),
          sourceUpdatedAt: secondAt,
          sourceCollectedAt: secondAt,
        },
        {
          platformKey: "platform-a",
          recordKind: "pull",
          externalId: "pull-retargeted",
          content: pullContent(6_000),
          relationships: pullRelationships("pack-2", "asset-2"),
          sourceUpdatedAt: secondAt,
          sourceCollectedAt: secondAt,
        },
      ],
    });

    const latestPullRevision = await harness.client.$queryRaw<
      Array<{ revisionId: string }>
    >`
      select revision.id::text as "revisionId"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.entity_id = entity.id
       and revision.organization_id = entity.organization_id
      where entity.organization_id = ${ids.organization}::uuid
        and entity.platform_key = 'platform-a'
        and entity.record_kind = 'pull'
        and entity.external_id = 'pull-retargeted'
      order by revision.revision_number desc
      limit 1
    `;
    assert.equal(
      await harness.client.normalized_heat_observations.count({
        where: {
          organization_id: ids.organization,
          canonical_revision_id: latestPullRevision[0]!.revisionId,
          source_relationship_id: null,
        },
      }),
      0,
      "source-native V1 pull revisions must wait for exact confirmation causes",
    );
    const changedRelationshipHeat = await harness.client.$queryRaw<Array<{
      observationKind: string;
      relationshipKind: string;
      targetExternalId: string;
    }>>`
      select observation.observation_kind as "observationKind",
             relationship.relationship_kind as "relationshipKind",
             relationship.target_external_id as "targetExternalId"
      from public.normalized_heat_observations as observation
      join public.canonical_relationships as relationship
        on relationship.id = observation.source_relationship_id
       and relationship.organization_id = observation.organization_id
      where observation.organization_id = ${ids.organization}::uuid
        and observation.public_change_sequence > ${firstMaximum}
      order by observation.observation_kind, relationship.relationship_kind
    `;
    const changedRelationshipOutcomes = await harness.client.$queryRaw<Array<{
      status: string;
      reasonCode: string;
      relationshipKind: string;
      targetExternalId: string;
    }>>`
      select outcome.status, outcome.reason_code as "reasonCode",
             relationship.relationship_kind as "relationshipKind",
             relationship.target_external_id as "targetExternalId"
      from public.normalized_heat_observation_outcomes as outcome
      join public.canonical_relationships as relationship
        on relationship.id = outcome.source_relationship_id
       and relationship.organization_id = outcome.organization_id
      where outcome.organization_id = ${ids.organization}::uuid
        and outcome.public_change_sequence > ${firstMaximum}
      order by relationship.relationship_kind
    `;
    assert.deepEqual(changedRelationshipHeat, [
      {
        observationKind: "catalog_snapshot",
        relationshipKind: "card",
        targetExternalId: "asset-2",
      },
    ]);
    assert.deepEqual(changedRelationshipOutcomes, [
      {
        status: "normalized",
        reasonCode: "NORMALIZED",
        relationshipKind: "card",
        targetExternalId: "asset-2",
      },
      {
        status: "duplicate",
        reasonCode: "DUPLICATE_SOURCE_EVENT",
        relationshipKind: "pack",
        targetExternalId: "pack-2",
      },
    ]);

    const sameEdgeRevisionAt = new Date(secondAt.getTime() + 500);
    const beforeSameEdgeRevision =
      await harness.client.normalized_heat_observations.count();
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: sameEdgeRevisionAt,
      projections: [{
        platformKey: "platform-a",
        recordKind: "pull",
        externalId: "pull-retargeted",
        content: pullContent(7_000),
        relationships: pullRelationships("pack-2", "asset-2"),
        sourceUpdatedAt: sameEdgeRevisionAt,
        sourceCollectedAt: sameEdgeRevisionAt,
      }],
    });
    assert.equal(
      await harness.client.normalized_heat_observations.count(),
      beforeSameEdgeRevision + 1,
      "a repeated provider pull stays one realized event while catalog state revises",
    );
    const sameEdgeRevisionHeat = await harness.client.$queryRaw<Array<{
      observationKind: string;
      valueMinor: number;
    }>>`
      select observation.observation_kind as "observationKind",
             (revision.content_json -> 'value' ->> 'amountMinor')::integer
               as "valueMinor"
      from public.normalized_heat_observations as observation
      join public.canonical_revisions as revision
        on revision.id = observation.canonical_revision_id
       and revision.organization_id = observation.organization_id
      where observation.organization_id = ${ids.organization}::uuid
        and observation.source_relationship_id is not null
        and revision.content_json -> 'value' ->> 'amountMinor' = '7000'
      order by observation.observation_kind
    `;
    assert.deepEqual(sameEdgeRevisionHeat, [
      { observationKind: "catalog_snapshot", valueMinor: 7_000 },
    ]);
    const sameEdgeRevisionOutcomes = await harness.client.$queryRaw<Array<{
      candidateKind: string;
      status: string;
      reasonCode: string;
    }>>`
      select outcome.candidate_key as "candidateKind",
             outcome.status,
             outcome.reason_code as "reasonCode"
      from public.normalized_heat_observation_outcomes as outcome
      join public.canonical_revisions as revision
        on revision.id = outcome.canonical_revision_id
       and revision.organization_id = outcome.organization_id
      where outcome.organization_id = ${ids.organization}::uuid
        and revision.content_json -> 'value' ->> 'amountMinor' = '7000'
      order by outcome.status, outcome.candidate_key collate "C"
    `;
    assert.equal(sameEdgeRevisionOutcomes.length, 2);
    assert.deepEqual(
      sameEdgeRevisionOutcomes.map(({ status, reasonCode }) => ({
        status,
        reasonCode,
      })),
      [
        { status: "duplicate", reasonCode: "DUPLICATE_SOURCE_EVENT" },
        { status: "normalized", reasonCode: "NORMALIZED" },
      ],
    );

    const beforeOldAssetRefresh =
      await harness.client.normalized_heat_observations.count();
    const oldAssetRefreshAt = new Date(secondAt.getTime() + 1_000);
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: oldAssetRefreshAt,
      projections: [{
        platformKey: "platform-a",
        recordKind: "catalog_asset",
        externalId: "asset-1",
        content: assetContent(oldAssetRefreshAt),
        sourceUpdatedAt: oldAssetRefreshAt,
        sourceCollectedAt: oldAssetRefreshAt,
      }],
    });
    assert.equal(
      await harness.client.normalized_heat_observations.count(),
      beforeOldAssetRefresh,
      "a later V1 asset revision must not revive a superseded confirmed edge",
    );
  } finally {
    await harness.close();
  }
});

test("late V1 relationship resolution retries at its exact causal watermark", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const configuredAt = new Date(anchorAt.getTime() + 10_000);
    const pullAt = new Date(anchorAt.getTime() + 11_000);
    const pullCommittedAt = new Date(anchorAt.getTime() + 12_000);
    const revisedPullAt = new Date(anchorAt.getTime() + 12_500);
    const targetsAt = new Date(anchorAt.getTime() + 13_000);
    const fixture = await seed({ database: harness.client, configuredAt });
    const pullPage = page({
      runId: ids.latePullRun,
      sourceAt: pullAt,
      committedAt: pullCommittedAt,
      includeTargets: false,
      pullExternalIds: ["pull-late"],
    });
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: pullCommittedAt,
      projections: pullPage.records.flatMap(({ projections }) => projections),
    });
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: revisedPullAt,
      projections: [{
        platformKey: "platform-a",
        recordKind: "pull",
        externalId: "pull-late",
        content: pullContent(6_000),
        relationships: pullRelationships(),
        sourceUpdatedAt: revisedPullAt,
        sourceCollectedAt: revisedPullAt,
      }],
    });
    assert.equal(await harness.client.normalized_heat_observations.count(), 0);
    const unresolved = await harness.client.canonical_relationships.findMany({
      where: { organization_id: ids.organization },
    });
    assert.equal(unresolved.length, 2);
    assert.ok(unresolved.every(({ resolved_public_change_sequence }) =>
      resolved_public_change_sequence === null));
    assert.equal(await harness.client.source_relationship_confirmation_sets.count({
      where: { organization_id: ids.organization },
    }), 2);
    assert.equal(await harness.client.source_relationship_confirmations.count({
      where: { organization_id: ids.organization },
    }), 4);

    const targetsPage = page({
      runId: ids.lateTargetsRun,
      sourceAt: targetsAt,
      committedAt: targetsAt,
      includeTargets: true,
      pullExternalIds: [],
    });
    const currentHead = await harness.client.public_change_causes.aggregate({
      where: { organization_id: ids.organization },
      _max: { sequence: true },
    });
    await mutateHeatBackfillFixture(harness.client, async (transaction) => {
      await transaction.normalized_heat_relationship_backfills.update({
        where: { organization_id: ids.organization },
        data: {
          phase: "relationships",
          target_public_change_sequence: currentHead._max.sequence! + 1_000n,
          processed_through_public_change_sequence: 0n,
          processed_through_confirmation_public_change_sequence: 0n,
          processed_through_confirmation_set_id: null,
          processed_through_relationship_id: null,
          target_relationship_source_count: 0n,
          relationship_source_count: 0n,
          target_catalog_observation_count: null,
          catalog_observation_count: 0n,
          failure_code: null,
          completed_at: null,
        },
      });
    });
    await assert.rejects(
      harness.client.$transaction(async (transaction) => {
        const [targetCause] = await allocatePublicChangeCauses(transaction, {
          organizationId: ids.organization,
          changes: [{
            changeKind: "provider_projection",
            entityKey: "provider:platform-a:pack:pack-1",
            sourceKey: "platform-a",
            sourceRevisionKey: fixture.sourceRevisionId,
            occurredAt: targetsAt,
            catalogImpact: {
              kind: "catalog",
              providerPlatformKeys: ["platform-a"],
            },
          }],
        });
        if (!targetCause) throw new Error("Target cause is missing.");
        const target = await transaction.canonical_entities.create({
          data: {
            organization_id: ids.organization,
            platform_key: "platform-a",
            record_kind: "pack",
            external_id: "pack-1",
            created_at: targetsAt,
            updated_at: targetsAt,
          },
        });
        await resolveConfirmedRelationshipsForNewTargets(transaction, {
          organizationId: ids.organization,
          sourceRevisionKey: fixture.sourceRevisionId,
          acceptedAt: targetsAt,
          mode: "forward",
          entities: [{
            id: target.id,
            platformKey: target.platform_key,
            recordKind: target.record_kind,
            externalId: target.external_id,
            publicChangeSequence: targetCause.sequence,
          }],
        });
      }),
      /crosses frozen Heat coverage/i,
    );
    assert.ok((await harness.client.canonical_relationships.findMany({
      where: { organization_id: ids.organization },
    })).every(({ resolved_public_change_sequence }) =>
      resolved_public_change_sequence === null));
    await mutateHeatBackfillFixture(harness.client, async (transaction) => {
      await transaction.normalized_heat_relationship_backfills.update({
        where: { organization_id: ids.organization },
        data: {
          phase: "complete",
          target_public_change_sequence: 0n,
          processed_through_public_change_sequence: 0n,
          processed_through_confirmation_public_change_sequence: 0n,
          processed_through_confirmation_set_id: null,
          processed_through_relationship_id: null,
          next_catalog_order_sequence: 1n,
          target_relationship_source_count: 0n,
          relationship_source_count: 0n,
          target_catalog_observation_count: 0n,
          catalog_observation_count: 0n,
          failure_code: null,
          completed_at: targetsAt,
        },
      });
    });
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: targetsAt,
      projections: targetsPage.records.flatMap(({ projections }) => projections),
    });

    const relationshipRows = await relationships(harness.client);
    assert.equal(relationshipRows.length, 2);
    const packRelationship = relationshipRows.find(
      ({ relationshipKind }) => relationshipKind === "pack",
    )!;
    const cardRelationship = relationshipRows.find(
      ({ relationshipKind }) => relationshipKind === "card",
    )!;
    const completedAt = relationshipRows.reduce(
      (maximum, relationship) =>
        relationship.resolvedPublicChangeSequence > maximum
          ? relationship.resolvedPublicChangeSequence
          : maximum,
      0n,
    );
    const relationshipObservations = await harness.client
      .normalized_heat_observations.findMany({
        where: {
          organization_id: ids.organization,
          source_relationship_id: { not: null },
        },
        orderBy: [
          { observation_kind: "asc" },
          { occurred_at: "asc" },
        ],
      });
    assert.equal(relationshipObservations.length, 3);
    assert.equal(new Set(relationshipObservations.map(
      ({ observation_key }) => observation_key,
    )).size, 3, "catalog revisions are set-scoped but the realized pull is not");
    const pulls = relationshipObservations.filter(
      ({ observation_kind }) => observation_kind === "pull",
    );
    const catalogs = relationshipObservations.filter(
      ({ observation_kind }) => observation_kind === "catalog_snapshot",
    );
    assert.equal(pulls.length, 1);
    assert.equal(catalogs.length, 2);
    const canonicalCatalogOrder = [...catalogs].sort((left, right) => {
      if (left.public_change_sequence < right.public_change_sequence) return -1;
      if (left.public_change_sequence > right.public_change_sequence) return 1;
      return left.observation_key < right.observation_key
        ? -1
        : left.observation_key > right.observation_key ? 1 : 0;
    });
    const assignedCatalogOrder = [...catalogs].sort(
      (left, right) =>
        left.catalog_order_sequence! - right.catalog_order_sequence!,
    );
    assert.deepEqual(
      assignedCatalogOrder.map(({ observation_key }) => observation_key),
      canonicalCatalogOrder.map(({ observation_key }) => observation_key),
      "forward and historical catalog ordering use the same causal/key tie-break",
    );
    assert.ok(pulls.every(({ source_relationship_id }) =>
      source_relationship_id === packRelationship.relationshipId));
    assert.equal(
      pulls[0]!.public_change_sequence,
      packRelationship.resolvedPublicChangeSequence,
    );
    assert.equal(pulls[0]!.occurred_at.toISOString(), pullAt.toISOString());
    assert.ok(catalogs.every(({ public_change_sequence }) =>
      public_change_sequence === completedAt));
    assert.ok(catalogs.every(({ source_relationship_id }) =>
      source_relationship_id === cardRelationship.relationshipId));
    assert.ok(catalogs.every(({ occurred_at }) =>
      occurred_at.toISOString() === targetsAt.toISOString()));
    assert.ok(catalogs.every(({ available_chase_count, outcome_keys }) =>
      available_chase_count === 1 && outcome_keys.length === 1));
    assert.ok(catalogs.some(({ canonical_revision_id }) =>
      canonical_revision_id === pulls[0]!.canonical_revision_id));
    const relationshipOutcomes = await harness.client.$queryRaw<Array<{
      valueMinor: number;
      relationshipKind: string;
      status: string;
      reasonCode: string;
    }>>`
      select (revision.content_json -> 'value' ->> 'amountMinor')::integer
               as "valueMinor",
             relationship.relationship_kind as "relationshipKind",
             outcome.status,
             outcome.reason_code as "reasonCode"
      from public.normalized_heat_observation_outcomes as outcome
      join public.canonical_revisions as revision
        on revision.id = outcome.canonical_revision_id
       and revision.organization_id = outcome.organization_id
      join public.canonical_relationships as relationship
        on relationship.id = outcome.source_relationship_id
       and relationship.organization_id = outcome.organization_id
      where outcome.organization_id = ${ids.organization}::uuid
      order by "valueMinor", relationship.relationship_kind
    `;
    assert.deepEqual(relationshipOutcomes, [
      {
        valueMinor: 5_000,
        relationshipKind: "card",
        status: "normalized",
        reasonCode: "NORMALIZED",
      },
      {
        valueMinor: 5_000,
        relationshipKind: "pack",
        status: "normalized",
        reasonCode: "NORMALIZED",
      },
      {
        valueMinor: 6_000,
        relationshipKind: "card",
        status: "normalized",
        reasonCode: "NORMALIZED",
      },
      {
        valueMinor: 6_000,
        relationshipKind: "pack",
        status: "duplicate",
        reasonCode: "DUPLICATE_SOURCE_EVENT",
      },
    ]);

    const settledSequence = await settleAll({
      database: harness.client,
      settledAt: new Date(targetsAt.getTime() + 1_000),
    });
    const firstResolution = relationshipRows.reduce(
      (minimum, relationship) =>
        relationship.resolvedPublicChangeSequence < minimum
          ? relationship.resolvedPublicChangeSequence
          : minimum,
      relationshipRows[0]!.resolvedPublicChangeSequence,
    );
    const reader = new PrismaNormalizedHeatObservationRepository(harness.client, {
      organizationId: ids.organization,
    });
    const commonWindow = {
      organizationId: ids.organization,
      publicRepackIds: [ids.publicRepack],
      occurredAtGte: pullAt.toISOString(),
      occurredAtLt: new Date(targetsAt.getTime() + 1).toISOString(),
      limit: 100,
    } as const;
    const beforeResolution = await reader.listSettledNormalizedHeatObservations({
      ...commonWindow,
      causalSequenceLte: firstResolution - 1n,
    });
    assert.ok(beforeResolution.observations.every(({ kind }) => kind !== "pull"));
    const afterResolution = await reader.listSettledNormalizedHeatObservations({
      ...commonWindow,
      causalSequenceLte: settledSequence,
    });
    assert.equal(
      afterResolution.observations.filter(({ kind }) => kind === "pull").length,
      1,
    );
    assert.equal(
      afterResolution.observations.filter(
        ({ kind }) => kind === "catalog_snapshot",
      ).length,
      beforeResolution.observations.filter(
        ({ kind }) => kind === "catalog_snapshot",
      ).length + 2,
    );
  } finally {
    await harness.close();
  }
});

test("preserved pre-migration V1 rows backfill relationships and causal catalog order in bounded resumable steps", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const historicalAt = new Date(anchorAt.getTime() - 8 * 24 * 60 * 60 * 1_000);
    const sourceAt = new Date(historicalAt.getTime() + 1_000);
    const committedAt = new Date(historicalAt.getTime() + 2_000);
    const fixture = await seed({ database: harness.client, configuredAt: historicalAt });
    const adoptedPage = page({
      runId: ids.samePageRun,
      sourceAt,
      committedAt,
      includeTargets: true,
      pullExternalIds: ["pull-backfill"],
    });
    const backfillPlans = new Map<
      string,
      ProviderSourceCanonicalProjectionPlan
    >();
    await createRun(fixture.setup, ids.samePageRun, committedAt);
    await fixture.ingestion.commitPage(adoptedPage);
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: committedAt,
      projections: adoptedPage.records.flatMap(({ projections }) => projections),
      backfillPlans,
    });
    await createRun(
      fixture.setup,
      ids.legacyOnlyRun,
      new Date(committedAt.getTime() + 1_000),
    );
    await fixture.ingestion.commitPage(page({
      runId: ids.legacyOnlyRun,
      sourceAt: new Date(sourceAt.getTime() + 1_000),
      committedAt: new Date(committedAt.getTime() + 1_000),
      includeTargets: true,
      pullExternalIds: ["pull-legacy-only"],
    }));

    const physicalRelationships = await harness.client.$queryRaw<Array<{
      relationshipId: string;
      sourceExternalId: string;
    }>>`
      select relationship.id::text as "relationshipId",
             source.external_id as "sourceExternalId"
      from public.canonical_relationships as relationship
      join public.canonical_entities as source
        on source.id = relationship.source_entity_id
       and source.organization_id = relationship.organization_id
      where relationship.organization_id = ${ids.organization}::uuid
        and source.record_kind = 'pull'
      order by source.external_id, relationship.relationship_kind
    `;
    const adoptedRelationshipIds = physicalRelationships
      .filter(({ sourceExternalId }) => sourceExternalId === "pull-backfill")
      .map(({ relationshipId }) => relationshipId)
      .sort();
    const legacyOnlyRelationshipIds = physicalRelationships
      .filter(({ sourceExternalId }) => sourceExternalId === "pull-legacy-only")
      .map(({ relationshipId }) => relationshipId)
      .sort();
    assert.equal(adoptedRelationshipIds.length, 2);
    assert.equal(legacyOnlyRelationshipIds.length, 2);
    const declarations = await harness.client.$queryRaw<Array<{
      pullExternalId: string;
      relationshipKind: string;
    }>>`
      select pull_external_id as "pullExternalId",
             relationship_kind as "relationshipKind"
      from public.provider_v1_pull_relationship_declarations
      where organization_id = ${ids.organization}::uuid
      order by pull_external_id collate "C", relationship_kind collate "C"
    `;
    assert.deepEqual(declarations, [
      { pullExternalId: "pull-backfill", relationshipKind: "card" },
      { pullExternalId: "pull-backfill", relationshipKind: "pack" },
    ]);

    const legacyCatalog = await harness.client.normalized_heat_observations
      .findFirstOrThrow({
        where: {
          organization_id: ids.organization,
          source_relationship_id: null,
          observation_kind: "catalog_snapshot",
        },
      });
    const legacyOutcome = await harness.client.normalized_heat_observation_outcomes
      .findFirstOrThrow({
        where: {
          organization_id: ids.organization,
          observation_id: legacyCatalog.id,
        },
      });
    await harness.client.normalized_heat_observation_outcomes.deleteMany({
      where: { organization_id: ids.organization },
    });
    await harness.client.normalized_heat_observations.deleteMany({
      where: { organization_id: ids.organization },
    });
    await harness.client.normalized_heat_observations.create({
      data: {
        ...legacyCatalog,
        catalog_order_sequence: null,
      },
    });
    await harness.client.normalized_heat_observation_outcomes.create({
      data: legacyOutcome,
    });
    const targetOccurrence = await harness.client.source_delivery_occurrences
      .aggregate({
        where: {
          organization_id: ids.organization,
          source_revision_id: fixture.sourceRevisionId,
        },
        _max: { id: true },
      });
    await harness.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmations disable trigger user",
      );
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmation_sets disable trigger user",
      );
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmation_backfills disable trigger user",
      );
      await transaction.source_relationship_confirmations.deleteMany({
        where: { organization_id: ids.organization },
      });
      await transaction.source_relationship_confirmation_sets.deleteMany({
        where: { organization_id: ids.organization },
      });
      await transaction.source_relationship_confirmation_backfills.update({
        where: {
          organization_id_source_revision_id: {
            organization_id: ids.organization,
            source_revision_id: fixture.sourceRevisionId,
          },
        },
        data: {
          phase: "pending",
          target_delivery_occurrence_id: targetOccurrence._max.id!,
          retry_eligibility_cutoff_at: anchorAt,
          processed_through_source_record_id: null,
          target_semantic_set_count: 1n,
          confirmed_semantic_set_count: 0n,
          failure_code: null,
          started_at: null,
          completed_at: null,
          updated_at: anchorAt,
        },
      });
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmation_backfills enable trigger user",
      );
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmation_sets enable trigger user",
      );
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmations enable trigger user",
      );
    });
    await mutateHeatBackfillFixture(harness.client, async (transaction) => {
      await transaction.normalized_heat_relationship_backfills.update({
        where: { organization_id: ids.organization },
        data: {
          phase: "awaiting_confirmations",
          target_public_change_sequence: 0n,
          processed_through_public_change_sequence: 0n,
          processed_through_confirmation_public_change_sequence: 0n,
          processed_through_confirmation_set_id: null,
          processed_through_relationship_id: null,
          next_catalog_order_sequence: 1n,
          target_relationship_source_count: 0n,
          relationship_source_count: 0n,
          initial_catalog_observation_count: 1n,
          target_catalog_observation_count: null,
          catalog_observation_count: 0n,
          failure_code: null,
          started_at: null,
          completed_at: null,
          updated_at: anchorAt,
        },
      });
    });

    const reader = new PrismaNormalizedHeatObservationRepository(harness.client, {
      organizationId: ids.organization,
    });
    const blocked = await reader.listSettledNormalizedHeatObservations({
      organizationId: ids.organization,
      publicRepackIds: [ids.publicRepack],
      occurredAtGte: historicalAt.toISOString(),
      occurredAtLt: anchorAt.toISOString(),
      causalSequenceLte: 0n,
      limit: 100,
    });
    assert.deepEqual(blocked, {
      observations: [],
      sourceCoverageComplete: false,
      truncated: false,
    });
    await assert.rejects(
      reader.closeSettledWindow({
        closedBefore: anchorAt,
        throughSettledSequence: 0n,
        updatedAt: anchorAt,
      }),
      /backfill is incomplete/i,
    );
    await assert.rejects(
      harness.client.$transaction((transaction) =>
        persistNormalizedHeatObservationsForCanonicalWrites(transaction, {
          organizationId: ids.organization,
          revisions: [],
          confirmedRelationships: [],
          createdAt: anchorAt,
        })),
      /backfill is incomplete/i,
    );

    const confirmationBackfill = () =>
      new PrismaSourceRelationshipConfirmationBackfillRepository(
        harness.client,
        {
          organizationId: ids.organization,
          actorPseudonymKey: "heat-v1-source-native",
          clock: { now: () => anchorAt },
          resolver: {
            resolvePullProjection(candidate) {
              const projection = backfillPlans.get(
                candidate.semanticObservationId,
              );
              if (!projection) throw new Error("Backfill projection is missing.");
              return projection;
            },
          },
        },
      );
    const confirmationProgress = await Promise.all([
      confirmationBackfill().runToCompletion({ batchSize: 1 }),
      confirmationBackfill().runToCompletion({ batchSize: 1 }),
    ]);
    assert.ok(confirmationProgress.every(({ phase }) => phase === "complete"));
    const confirmationCheckpoint = await harness.client
      .source_relationship_confirmation_backfills.findUniqueOrThrow({
        where: {
          organization_id_source_revision_id: {
            organization_id: ids.organization,
            source_revision_id: fixture.sourceRevisionId,
          },
        },
      });
    assert.equal(confirmationCheckpoint.phase, "complete");
    assert.equal(confirmationCheckpoint.confirmed_semantic_set_count, 1n);

    const first = new PrismaNormalizedHeatRelationshipBackfillRepository(
      harness.client,
      { organizationId: ids.organization, clock: { now: () => anchorAt } },
    );
    const second = new PrismaNormalizedHeatRelationshipBackfillRepository(
      harness.client,
      { organizationId: ids.organization, clock: { now: () => anchorAt } },
    );
    const progress = await Promise.all([
      first.runToCompletion({
        relationshipBatchSize: 1,
        catalogOrderBatchSize: 1,
      }),
      second.runToCompletion({
        relationshipBatchSize: 1,
        catalogOrderBatchSize: 1,
      }),
    ]);
    assert.ok(progress.every(({ phase }) => phase === "complete"));
    assert.ok(progress.every(({ relationshipSourceCount }) =>
      relationshipSourceCount === 2n));
    assert.ok(progress.every(({ catalogObservationCount }) =>
      catalogObservationCount === 2n));

    const observations = await harness.client.normalized_heat_observations.findMany({
      where: { organization_id: ids.organization },
      orderBy: [
        { public_change_sequence: "asc" },
        { observation_key: "asc" },
      ],
    });
    assert.equal(observations.length, 3);
    assert.equal(
      observations.filter(({ source_relationship_id }) =>
        source_relationship_id !== null).length,
      2,
    );
    assert.deepEqual(
      observations.flatMap(({ source_relationship_id }) =>
        source_relationship_id === null ? [] : [source_relationship_id]).sort(),
      adoptedRelationshipIds,
    );
    assert.ok(observations.every(({ source_relationship_id }) =>
      source_relationship_id === null
      || !legacyOnlyRelationshipIds.includes(source_relationship_id)));
    const catalog = observations.filter(
      ({ observation_kind }) => observation_kind === "catalog_snapshot",
    );
    assert.deepEqual(catalog.map(({ catalog_order_sequence }) =>
      catalog_order_sequence), [1, 2]);
    assert.ok(catalog[0]!.public_change_sequence < catalog[1]!.public_change_sequence);
    const checkpoint = await harness.client.normalized_heat_window_checkpoints
      .findUniqueOrThrow({
        where: { organization_id: ids.organization },
        select: { next_catalog_sequence: true },
      });
    assert.equal(checkpoint.next_catalog_sequence, 3n);

    const replay = await first.runToCompletion({
      relationshipBatchSize: 1,
      catalogOrderBatchSize: 1,
    });
    assert.equal(replay.phase, "complete");
    assert.equal(await harness.client.normalized_heat_observations.count(), 3);
  } finally {
    await harness.close();
  }
});

test("historical confirmation-set backfill is batch-invariant for one deferred physical edge", async () => {
  const runScenario = async (relationshipBatchSize: 1 | 500) => {
    const harness = await createMigratedTestDatabase();
    try {
      const historicalBase = new Date(
        anchorAt.getTime() - 8 * 24 * 60 * 60 * 1_000,
      );
      const configuredAt = new Date(historicalBase.getTime() + 14_000);
      const originalAt = new Date(historicalBase.getTime() + 15_000);
      const correctionAt = new Date(historicalBase.getTime() + 16_000);
      const targetsAt = new Date(historicalBase.getTime() + 17_000);
      const fixture = await seed({ database: harness.client, configuredAt });
      await writeSourceNativeV1Page({
        database: harness.client,
        fixture,
        acceptedAt: originalAt,
        projections: [{
          platformKey: "platform-a",
          recordKind: "pull",
          externalId: "pull-historical-shared-edge",
          content: pullContent(5_000),
          relationships: pullRelationships(),
          sourceUpdatedAt: originalAt,
          sourceCollectedAt: originalAt,
        }],
      });
      await writeSourceNativeV1Page({
        database: harness.client,
        fixture,
        acceptedAt: correctionAt,
        projections: [{
          platformKey: "platform-a",
          recordKind: "pull",
          externalId: "pull-historical-shared-edge",
          content: pullContent(6_000),
          relationships: pullRelationships(),
          sourceUpdatedAt: correctionAt,
          sourceCollectedAt: correctionAt,
        }],
      });
      await writeSourceNativeV1Page({
        database: harness.client,
        fixture,
        acceptedAt: targetsAt,
        projections: [
          {
            platformKey: "platform-a",
            recordKind: "pack",
            externalId: "pack-1",
            content: packContent(targetsAt),
            sourceUpdatedAt: targetsAt,
            sourceCollectedAt: targetsAt,
          },
          {
            platformKey: "platform-a",
            recordKind: "catalog_asset",
            externalId: "asset-1",
            content: assetContent(targetsAt),
            sourceUpdatedAt: targetsAt,
            sourceCollectedAt: targetsAt,
          },
        ],
      });
      await settleAll({
        database: harness.client,
        settledAt: new Date(targetsAt.getTime() + 1_000),
      });
      assert.equal(await harness.client.source_relationship_confirmation_sets.count({
        where: { organization_id: ids.organization },
      }), 2);
      assert.equal(await harness.client.source_relationship_confirmations.count({
        where: { organization_id: ids.organization },
      }), 4);

      await harness.client.normalized_heat_observation_outcomes.deleteMany({
        where: { organization_id: ids.organization },
      });
      await harness.client.normalized_heat_observations.deleteMany({
        where: { organization_id: ids.organization },
      });
      await mutateHeatBackfillFixture(harness.client, async (transaction) => {
        await transaction.normalized_heat_relationship_backfills.update({
          where: { organization_id: ids.organization },
          data: {
            phase: "awaiting_confirmations",
            target_public_change_sequence: 0n,
            processed_through_public_change_sequence: 0n,
            processed_through_confirmation_public_change_sequence: 0n,
            processed_through_confirmation_set_id: null,
            processed_through_relationship_id: null,
            next_catalog_order_sequence: 1n,
            target_relationship_source_count: 0n,
            relationship_source_count: 0n,
            initial_catalog_observation_count: 0n,
            target_catalog_observation_count: null,
            catalog_observation_count: 0n,
            failure_code: null,
            started_at: null,
            completed_at: null,
            updated_at: targetsAt,
          },
        });
      });

      const progress = await new PrismaNormalizedHeatRelationshipBackfillRepository(
        harness.client,
        { organizationId: ids.organization, clock: { now: () => targetsAt } },
      ).runToCompletion({
        relationshipBatchSize,
        catalogOrderBatchSize: 1,
      });
      if (relationshipBatchSize === 500) {
        await assert.rejects(
          harness.client.normalized_heat_relationship_backfills.update({
            where: { organization_id: ids.organization },
            data: { updated_at: new Date(targetsAt.getTime() + 1) },
          }),
          /relationship backfill is terminal/i,
        );
        await assert.rejects(
          harness.client.normalized_heat_relationship_backfills.delete({
            where: { organization_id: ids.organization },
          }),
          /relationship backfill cannot be deleted/i,
        );
        const causalCatalog = await harness.client.normalized_heat_observations
          .findMany({
            where: {
              organization_id: ids.organization,
              observation_kind: "catalog_snapshot",
            },
            orderBy: [
              { public_change_sequence: "asc" },
              { observation_key: "asc" },
            ],
          });
        assert.equal(causalCatalog.length, 2);
        await harness.client.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            "alter table public.normalized_heat_observations disable trigger user",
          );
          await transaction.normalized_heat_observations.updateMany({
            where: { organization_id: ids.organization },
            data: { catalog_order_sequence: null },
          });
          await transaction.$executeRawUnsafe(
            "alter table public.normalized_heat_observations enable trigger user",
          );
        });
        await mutateHeatBackfillFixture(harness.client, async (transaction) => {
          await transaction.normalized_heat_relationship_backfills.update({
            where: { organization_id: ids.organization },
            data: {
              phase: "catalog_order",
              next_catalog_order_sequence: 1n,
              catalog_observation_count: 0n,
              completed_at: null,
              updated_at: targetsAt,
            },
          });
        });
        await assert.rejects(
          harness.client.$executeRaw`
            update public.normalized_heat_observations
            set catalog_order_sequence = case
              when id = cast(${causalCatalog[0]!.id} as uuid) then 2
              else 1
            end
            where organization_id = cast(${ids.organization} as uuid)
              and id in (
                cast(${causalCatalog[0]!.id} as uuid),
                cast(${causalCatalog[1]!.id} as uuid)
              )
          `,
          /catalog order batch rank is invalid/i,
        );
        await harness.client.normalized_heat_relationship_backfills.update({
          where: { organization_id: ids.organization },
          data: {
            catalog_observation_count: 1n,
            next_catalog_order_sequence: 2n,
          },
        });
        await harness.client.$executeRaw`
          update public.normalized_heat_observations
          set catalog_order_sequence = case
            when id = cast(${causalCatalog[0]!.id} as uuid) then 2
            else 3
          end
          where organization_id = cast(${ids.organization} as uuid)
            and id in (
              cast(${causalCatalog[0]!.id} as uuid),
              cast(${causalCatalog[1]!.id} as uuid)
            )
        `;
        await harness.client.normalized_heat_relationship_backfills.update({
          where: { organization_id: ids.organization },
          data: {
            catalog_observation_count: 2n,
            next_catalog_order_sequence: 3n,
          },
        });
        await assert.rejects(
          new PrismaNormalizedHeatRelationshipBackfillRepository(
            harness.client,
            { organizationId: ids.organization, clock: { now: () => targetsAt } },
          ).runToCompletion({
            relationshipBatchSize: 500,
            catalogOrderBatchSize: 2,
          }),
          /relationship completion is invalid/i,
          "a forged checkpoint jump cannot complete with catalog order 2..N+1",
        );
        await harness.client.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            "alter table public.normalized_heat_observations disable trigger user",
          );
          await transaction.normalized_heat_observations.updateMany({
            where: { organization_id: ids.organization },
            data: { catalog_order_sequence: null },
          });
          await transaction.$executeRawUnsafe(
            "alter table public.normalized_heat_observations enable trigger user",
          );
        });
        await mutateHeatBackfillFixture(harness.client, async (transaction) => {
          await transaction.normalized_heat_relationship_backfills.update({
            where: { organization_id: ids.organization },
            data: {
              catalog_observation_count: 0n,
              next_catalog_order_sequence: 1n,
            },
          });
        });
        const reordered = await new
          PrismaNormalizedHeatRelationshipBackfillRepository(
            harness.client,
            { organizationId: ids.organization, clock: { now: () => targetsAt } },
          ).runToCompletion({
            relationshipBatchSize: 500,
            catalogOrderBatchSize: 2,
          });
        assert.equal(reordered.phase, "complete");
      }
      const observations = await harness.client.$queryRaw<Array<{
        observationKind: string;
        valueMinor: number;
      }>>`
        select observation.observation_kind as "observationKind",
               (revision.content_json -> 'value' ->> 'amountMinor')::integer
                 as "valueMinor"
        from public.normalized_heat_observations as observation
        join public.canonical_revisions as revision
          on revision.id = observation.canonical_revision_id
         and revision.organization_id = observation.organization_id
        where observation.organization_id = ${ids.organization}::uuid
        order by observation.observation_kind, "valueMinor"
      `;
      const outcomes = await harness.client.$queryRaw<Array<{
        relationshipKind: string;
        valueMinor: number;
        status: string;
        reasonCode: string;
      }>>`
        select relationship.relationship_kind as "relationshipKind",
               (revision.content_json -> 'value' ->> 'amountMinor')::integer
                 as "valueMinor",
               outcome.status,
               outcome.reason_code as "reasonCode"
        from public.normalized_heat_observation_outcomes as outcome
        join public.canonical_revisions as revision
          on revision.id = outcome.canonical_revision_id
         and revision.organization_id = outcome.organization_id
        join public.canonical_relationships as relationship
          on relationship.id = outcome.source_relationship_id
         and relationship.organization_id = outcome.organization_id
        where outcome.organization_id = ${ids.organization}::uuid
        order by "valueMinor", relationship.relationship_kind
      `;
      if (relationshipBatchSize === 500) {
        const frozenCatalog = await harness.client.normalized_heat_observations
          .findFirstOrThrow({
            where: {
              organization_id: ids.organization,
              observation_kind: "catalog_snapshot",
            },
          });
        let signalCheckpointLocked!: () => void;
        const checkpointLocked = new Promise<void>((resolve) => {
          signalCheckpointLocked = resolve;
        });
        let releaseCheckpoint!: () => void;
        const checkpointRelease = new Promise<void>((resolve) => {
          releaseCheckpoint = resolve;
        });
        await mutateHeatBackfillFixture(harness.client, async (transaction) => {
          await transaction.normalized_heat_relationship_backfills.update({
            where: { organization_id: ids.organization },
            data: { phase: "catalog_order", completed_at: null },
          });
        });
        const transition = harness.client.$transaction(async (transaction) => {
          await transaction.$queryRaw`
            select organization_id
            from public.normalized_heat_relationship_backfills
            where organization_id = ${ids.organization}::uuid
            for update
          `;
          signalCheckpointLocked();
          await checkpointRelease;
        });
        await checkpointLocked;
        try {
          await assert.rejects(
            harness.client.$transaction(async (transaction) => {
              await transaction.$executeRaw`set local lock_timeout = '100ms'`;
              await transaction.normalized_heat_observations.create({
                data: {
                  ...frozenCatalog,
                  id: randomUUID(),
                  observation_key: "e".repeat(64),
                  catalog_order_sequence: null,
                },
              });
            }),
            /lock timeout/i,
            "catalog membership writes must serialize with the phase transition",
          );
          await assert.rejects(
            harness.client.normalized_heat_observations.delete({
              where: {
                id_organization_id: {
                  id: frozenCatalog.id,
                  organization_id: ids.organization,
                },
              },
            }),
            /catalog order transition is in progress/i,
            "retention deletes must fail without waiting on the checkpoint lock",
          );
        } finally {
          releaseCheckpoint();
          await transition;
        }
        await assert.rejects(
          harness.client.normalized_heat_observations.create({
            data: {
              ...frozenCatalog,
              id: randomUUID(),
              observation_key: "f".repeat(64),
              catalog_order_sequence: null,
            },
          }),
          /catalog order is frozen/i,
        );
        await assert.rejects(
          harness.client.normalized_heat_observations.delete({
            where: {
              id_organization_id: {
                id: frozenCatalog.id,
                organization_id: ids.organization,
              },
            },
          }),
          /catalog order is frozen/i,
        );
      }
      return {
        relationshipSourceCount: progress.relationshipSourceCount,
        observations,
        outcomes,
      };
    } finally {
      await harness.close();
    }
  };

  const oneAtATime = await runScenario(1);
  const oneTransaction = await runScenario(500);
  assert.deepEqual(oneTransaction, oneAtATime);
  assert.equal(oneAtATime.relationshipSourceCount, 4n);
  assert.deepEqual(oneAtATime.observations, [
    { observationKind: "catalog_snapshot", valueMinor: 5_000 },
    { observationKind: "catalog_snapshot", valueMinor: 6_000 },
    { observationKind: "pull", valueMinor: 5_000 },
  ]);
  assert.deepEqual(oneAtATime.outcomes, [
    {
      relationshipKind: "card",
      valueMinor: 5_000,
      status: "normalized",
      reasonCode: "NORMALIZED",
    },
    {
      relationshipKind: "pack",
      valueMinor: 5_000,
      status: "normalized",
      reasonCode: "NORMALIZED",
    },
    {
      relationshipKind: "card",
      valueMinor: 6_000,
      status: "normalized",
      reasonCode: "NORMALIZED",
    },
    {
      relationshipKind: "pack",
      valueMinor: 6_000,
      status: "duplicate",
      reasonCode: "DUPLICATE_SOURCE_EVENT",
    },
  ]);
});

test("multi-pack expansion beyond 1,000 candidates fails closed", () => {
  const packCandidates = Array.from(
    { length: 1_001 },
    (_value, index) => `pack-bound-${index}`,
  );
  assert.throws(
    () => assertNormalizedHeatExpandedWriteBound(packCandidates, []),
    /Expanded Heat normalization write exceeds its transaction bound/,
  );
  assert.doesNotThrow(() =>
    assertNormalizedHeatExpandedWriteBound(packCandidates.slice(0, 1_000), []));
});

test("source-native multi-pack expansion above 1,000 rolls back the database transaction", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const configuredAt = new Date(anchorAt.getTime() + 20_000);
    const sourceAt = new Date(anchorAt.getTime() + 21_000);
    const fixture = await seed({ database: harness.client, configuredAt });
    const packExternalIds = Array.from(
      { length: 1_001 },
      (_value, index) => `bound-pack-${String(index).padStart(4, "0")}`,
    );
    await writeSourceNativeV1Page({
      database: harness.client,
      fixture,
      acceptedAt: sourceAt,
      projections: [{
        platformKey: "platform-a",
        recordKind: "catalog_asset",
        externalId: "bound-asset",
        content: { ...assetContent(sourceAt), name: "Bound Asset" },
        sourceUpdatedAt: sourceAt,
        sourceCollectedAt: sourceAt,
      }],
    });
    for (let offset = 0; offset < packExternalIds.length; offset += 500) {
      const batchAt = new Date(sourceAt.getTime() + offset + 1);
      const packs = packExternalIds.slice(offset, offset + 500);
      await writeSourceNativeV1Page({
        database: harness.client,
        fixture,
        acceptedAt: batchAt,
        projections: packs.map((externalId) => ({
            platformKey: "platform-a",
            recordKind: "pack" as const,
            externalId,
            content: { ...packContent(batchAt), name: externalId },
            sourceUpdatedAt: batchAt,
            sourceCollectedAt: batchAt,
          })),
      });
      const pullAt = new Date(batchAt.getTime() + 1);
      await writeSourceNativeV1Page({
        database: harness.client,
        fixture,
        acceptedAt: pullAt,
        projections: packs.map((packExternalId, index) => ({
            platformKey: "platform-a",
            recordKind: "pull" as const,
            externalId: `bound-pull-${offset + index}`,
            content: pullContent(5_000),
            relationships: pullRelationships(packExternalId, "bound-asset"),
            sourceUpdatedAt: pullAt,
            sourceCollectedAt: pullAt,
          })),
      });
    }
    const baselineEntityCount = await harness.client.canonical_entities.count({
      where: { organization_id: ids.organization },
    });
    const baselineRelationshipCount =
      await harness.client.canonical_relationships.count({
        where: { organization_id: ids.organization },
      });
    const refreshAt = new Date(sourceAt.getTime() + 2_000);
    await assert.rejects(
      writeSourceNativeV1Page({
        database: harness.client,
        fixture,
        acceptedAt: refreshAt,
        // This must reach the stable expansion bound inside the same transaction
        // budget used by the production ingestion repository.
        transactionTimeoutMs: PACKSCOUT_TRANSACTION_OPTIONS.timeout,
        projections: [{
          platformKey: "platform-a",
          recordKind: "catalog_asset",
          externalId: "bound-asset",
          content: { ...assetContent(refreshAt), name: "Bound Asset revised" },
          sourceUpdatedAt: refreshAt,
          sourceCollectedAt: refreshAt,
        }],
      }),
      /Expanded Heat normalization write exceeds its transaction bound/,
    );
    assert.equal(await harness.client.canonical_entities.count({
      where: { organization_id: ids.organization },
    }), baselineEntityCount);
    assert.equal(await harness.client.canonical_relationships.count({
      where: { organization_id: ids.organization },
    }), baselineRelationshipCount);
  } finally {
    await harness.close();
  }
});
