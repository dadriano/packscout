import assert from "node:assert/strict";
import { test } from "node:test";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import {
  persistNormalizedHeatObservationsForCanonicalWrites,
  PrismaNormalizedHeatObservationRepository,
} from "./normalized-heat-observation-repository.ts";
import {
  PrismaPublicRepackIdentityMappingRepository,
  PublicRepackIdentityMappingConflictError,
} from "./public-repack-identity-mapping-repository.ts";
import { cleanupExpiredNormalizedHeatHistory } from "./normalized-heat-retention-repository.ts";
import type { PackscoutTransactionClient } from "./database.ts";
import type { CommitPageInput } from "./pipeline-types.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "55000000-0000-4000-8000-000000000001",
  otherOrganization: "55000000-0000-4000-8000-000000000002",
  provider: "55000000-0000-4000-8000-000000000010",
  configuration: "55000000-0000-4000-8000-000000000020",
  firstRun: "55000000-0000-4000-8000-000000000030",
  secondRun: "55000000-0000-4000-8000-000000000031",
  lateRun: "55000000-0000-4000-8000-000000000032",
  malformedRun: "55000000-0000-4000-8000-000000000033",
  missingMappingRun: "55000000-0000-4000-8000-000000000034",
  mappedAfterApprovalRun: "55000000-0000-4000-8000-000000000035",
  highSequenceRun: "55000000-0000-4000-8000-000000000036",
  reparentRun: "55000000-0000-4000-8000-000000000037",
  removalRun: "55000000-0000-4000-8000-000000000038",
  exactArithmeticRun: "55000000-0000-4000-8000-000000000039",
  publicRepack: "11111111-1111-5111-8111-111111111111",
  secondPublicRepack: "33333333-3333-5333-8333-333333333333",
} as const;

const configuredAt = new Date("2026-08-15T10:00:00.000Z");
const sourceAt = new Date("2026-08-15T10:01:00.000Z");
const collectedAt = new Date("2026-08-15T10:01:01.000Z");
const committedAt = new Date("2026-08-15T10:01:02.000Z");

function packContent() {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "pack",
    availability: "active",
    priceValueMinor: 2_500,
    priceCurrency: "USD",
    buybackPercent: 80,
  };
}

function assetContent(externalId: string) {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "catalog_asset",
    relatedPackExternalId: "pack-1",
    availability: "active",
    name: externalId,
  };
}

function pullContent(externalId: string, value: unknown) {
  return {
    eventKind: "pull",
    occurredAt: sourceAt.toISOString(),
    collectedAt: collectedAt.toISOString(),
    packExternalId: "pack-1",
    assetExternalId: `${externalId}-asset`,
    value,
    valueSource: "provider-reported",
    actorKeys: { opener: "actor:v1:private-pseudonym" },
  };
}

function initialPage(runId: string): CommitPageInput {
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: null,
    hasMore: false,
    payload: {
      provider: "private-provider-payload",
      wallet_address: "0x-raw-wallet-must-not-leak",
    },
    committedAt,
    records: [
      {
        recordKind: "catalog",
        externalId: "catalog-page-1",
        sourceTime: sourceAt,
        collectedAt,
        payload: { raw: "private-catalog" },
        projections: [
          {
            platformKey: "platform-a",
            recordKind: "pack",
            externalId: "pack-1",
            content: packContent(),
            sourceUpdatedAt: sourceAt,
            sourceCollectedAt: collectedAt,
          },
          {
            platformKey: "platform-a",
            recordKind: "catalog_asset",
            externalId: "asset-1",
            content: assetContent("asset-1"),
            sourceUpdatedAt: sourceAt,
            sourceCollectedAt: collectedAt,
          },
          {
            platformKey: "platform-a",
            recordKind: "catalog_asset",
            externalId: "asset-2",
            content: assetContent("asset-2"),
            sourceUpdatedAt: sourceAt,
            sourceCollectedAt: collectedAt,
          },
        ],
      },
      {
        recordKind: "pull",
        externalId: "pull-valued",
        sourceTime: sourceAt,
        collectedAt,
        payload: { rawActor: "private-valued-actor" },
        projections: [{
          platformKey: "platform-a",
          recordKind: "pull",
          externalId: "pull-valued",
          content: pullContent("pull-valued", {
            amountMinor: 5_000,
            currency: "USD",
          }),
          sourceUpdatedAt: sourceAt,
          sourceCollectedAt: collectedAt,
        }],
      },
      {
        recordKind: "pull",
        externalId: "pull-missing-value",
        sourceTime: sourceAt,
        collectedAt,
        payload: { rawActor: "private-null-actor" },
        projections: [{
          platformKey: "platform-a",
          recordKind: "pull",
          externalId: "pull-missing-value",
          content: pullContent("pull-missing-value", null),
          sourceUpdatedAt: sourceAt,
          sourceCollectedAt: collectedAt,
        }],
      },
    ],
  };
}

async function createRun(
  setup: PipelineSetupRepository,
  runId: string,
  createdAt = committedAt,
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

async function commitSinglePull(input: {
  ingestion: IngestionPersistenceRepository;
  setup: PipelineSetupRepository;
  runId: string;
  externalId: string;
  packExternalId: string;
  occurredAt: Date;
  value: unknown;
}): Promise<void> {
  await createRun(input.setup, input.runId, new Date(committedAt.getTime() + 10_000));
  await input.ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: input.runId,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: null,
    hasMore: false,
    payload: { externalId: input.externalId },
    committedAt: new Date(committedAt.getTime() + 10_000),
    records: [{
      recordKind: "pull",
      externalId: input.externalId,
      sourceTime: input.occurredAt,
      collectedAt,
      payload: { protected: "never-normalized" },
      projections: [{
        platformKey: "platform-a",
        recordKind: "pull",
        externalId: input.externalId,
        content: {
          ...pullContent(input.externalId, input.value),
          occurredAt: input.occurredAt.toISOString(),
          packExternalId: input.packExternalId,
        },
        sourceUpdatedAt: input.occurredAt,
        sourceCollectedAt: collectedAt,
      }],
    }],
  });
}

async function commitCatalogAssetChange(input: {
  ingestion: IngestionPersistenceRepository;
  setup: PipelineSetupRepository;
  runId: string;
  occurredAt: Date;
  relatedPackExternalId: string | null;
}): Promise<void> {
  await createRun(input.setup, input.runId, input.occurredAt);
  await input.ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: input.runId,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: null,
    hasMore: false,
    payload: { asset: "asset-2" },
    committedAt: input.occurredAt,
    records: [{
      recordKind: "catalog",
      externalId: `catalog-${input.runId}`,
      sourceTime: input.occurredAt,
      collectedAt: input.occurredAt,
      payload: { protected: "never-normalized" },
      projections: [
        ...(input.relatedPackExternalId === "unmapped-pack" ? [{
          platformKey: "platform-a",
          recordKind: "pack" as const,
          externalId: "unmapped-pack",
          content: packContent(),
          sourceUpdatedAt: new Date(input.occurredAt.getTime() - 1),
          sourceCollectedAt: input.occurredAt,
        }] : []),
        {
          platformKey: "platform-a",
          recordKind: "catalog_asset",
          externalId: "asset-2",
          content: {
            schemaVersion: "catalog-projection-v1",
            entityType: "catalog_asset",
            relatedPackExternalId: input.relatedPackExternalId,
            availability: "active",
            name: "asset-2",
          },
          sourceUpdatedAt: input.occurredAt,
          sourceCollectedAt: input.occurredAt,
        },
      ],
    }],
  });
}

async function commitExactArithmeticEvidence(input: {
  ingestion: IngestionPersistenceRepository;
  setup: PipelineSetupRepository;
  occurredAt: Date;
}): Promise<void> {
  await createRun(input.setup, ids.exactArithmeticRun, input.occurredAt);
  await input.ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.exactArithmeticRun,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: null,
    hasMore: false,
    payload: { calculation: "exact" },
    committedAt: input.occurredAt,
    records: [
      {
        recordKind: "catalog",
        externalId: "catalog-exact-arithmetic",
        sourceTime: input.occurredAt,
        collectedAt: input.occurredAt,
        payload: { protected: "pack-price" },
        projections: [{
          platformKey: "platform-a",
          recordKind: "pack",
          externalId: "pack-1",
          content: {
            ...packContent(),
            priceValueMinor: 1_229_539_150_168_567,
            buybackPercent: null,
          },
          sourceUpdatedAt: input.occurredAt,
          sourceCollectedAt: input.occurredAt,
        }],
      },
      {
        recordKind: "pull",
        externalId: "pull-exact-arithmetic",
        sourceTime: input.occurredAt,
        collectedAt: input.occurredAt,
        payload: { protected: "pull-value" },
        projections: [{
          platformKey: "platform-a",
          recordKind: "pull",
          externalId: "pull-exact-arithmetic",
          content: {
            ...pullContent("pull-exact-arithmetic", {
              amountMinor: 5_505_323_021_837_267,
              currency: "USD",
            }),
            occurredAt: input.occurredAt.toISOString(),
          },
          sourceUpdatedAt: input.occurredAt,
          sourceCollectedAt: input.occurredAt,
        }],
      },
    ],
  });
}

test("canonical writes persist settled, bounded, public-safe Heat observations without replay duplication", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.client);
    await setup.createOrganization({
      id: ids.organization,
      slug: "heat-source",
      name: "Heat Source",
      createdAt: configuredAt,
    });
    await setup.createOrganization({
      id: ids.otherOrganization,
      slug: "not-public-heat-source",
      name: "Other Organization",
      createdAt: configuredAt,
    });
    await setup.createProviderSource({
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: "platform-a",
      displayName: "Private Provider",
      createdAt: configuredAt,
    });
    await setup.createConfigRevision({
      id: ids.configuration,
      organizationId: ids.organization,
      providerId: ids.provider,
      version: 1,
      adapterKey: "http-cursor-v1",
      endpointUrl: "https://private-provider.example/feed",
      authMode: "none",
      createdByActorKey: "operator:private",
      createdAt: configuredAt,
    });
    await setup.recordSuccessfulConnectionTest({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.configuration,
      actorKey: "operator:private",
      testedAt: configuredAt,
      latencyMs: 1,
    });
    await setup.activateConfiguration({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.configuration,
      actorKey: "operator:private",
      activatedAt: configuredAt,
      nextRunAt: configuredAt,
    });
    await createRun(setup, ids.firstRun);

    await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId: ids.organization,
        changes: [{
          changeKind: "public_configuration",
          entityKey: "public-config:v1:heat-source",
          sourceKey: "catalog-release",
          sourceRevisionKey: "catalog-config-v1",
          occurredAt: configuredAt,
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
      await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: ids.organization,
          configuration_key: "catalog-config-v1",
          revision: 1,
          configuration_json: { platforms: [{ platformKey: "platform-a" }] },
          configuration_hash: "1".padStart(64, "0"),
          approved_at: configuredAt,
          public_change_sequence: causes[0]!.sequence,
          created_at: configuredAt,
        },
      });
      const mapping = new PrismaPublicRepackIdentityMappingRepository(transaction);
      assert.deepEqual(
        await mapping.registerApprovedMappings({
          organizationId: ids.organization,
          approvedConfigurationKey: "catalog-config-v1",
          publicChangeSequence: causes[0]!.sequence,
          approvedAt: configuredAt,
          mappings: [{
            platformKey: "platform-a",
            packExternalId: "pack-1",
            publicRepackId: ids.publicRepack,
          }],
        }),
        { created: 1, existing: 0 },
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId: ids.organization,
        settledAt: configuredAt,
      });
    });

    assert.throws(
      () => new PrismaPublicRepackIdentityMappingRepository(
        harness.client as unknown as PackscoutTransactionClient,
      ),
      /active database transaction/,
    );
    await harness.client.$transaction(async (transaction) => {
      const mapping = new PrismaPublicRepackIdentityMappingRepository(transaction);
      assert.deepEqual(
        await mapping.registerApprovedMapping({
          organizationId: ids.organization,
          platformKey: "platform-a",
          packExternalId: "pack-1",
          publicRepackId: ids.publicRepack,
          approvedConfigurationKey: "catalog-config-v1",
          publicChangeSequence: 1n,
          approvedAt: configuredAt,
        }),
        { status: "existing" },
      );
      await assert.rejects(
        mapping.registerApprovedMapping({
          organizationId: ids.organization,
          platformKey: "platform-a",
          packExternalId: "pack-1",
          publicRepackId: "22222222-2222-5222-8222-222222222222",
          approvedConfigurationKey: "conflicting-config",
          publicChangeSequence: 1n,
          approvedAt: configuredAt,
        }),
        PublicRepackIdentityMappingConflictError,
      );
    });
    await assert.rejects(
      harness.client.public_repack_identity_mappings.update({
        where: {
          organization_id_platform_key_pack_external_id: {
            organization_id: ids.organization,
            platform_key: "platform-a",
            pack_external_id: "pack-1",
          },
        },
        data: { approved_configuration_key: "mutated" },
      }),
      /immutable/i,
    );

    const ingestion = new IngestionPersistenceRepository(harness.client, {
      retentionDays: 90,
      actorPseudonymKey: "heat-test-pseudonym-key",
    });
    const first = await ingestion.commitPage(initialPage(ids.firstRun));
    assert.equal(first.newCanonicalRevisions, 5);
    assert.equal(await harness.client.normalized_heat_observations.count(), 5);
    assert.equal(
      await harness.client.normalized_heat_observation_outcomes.count({
        where: { status: "normalized", reason_code: "NORMALIZED" },
      }),
      5,
    );

    const replaySources = await harness.client.$queryRaw<Array<{
      revisionId: string;
      entityId: string;
      platformKey: string;
      externalId: string;
      content: Record<string, unknown>;
      publicChangeSequence: bigint;
      occurredAt: Date;
    }>>`
      select revision.id::text as "revisionId",
             entity.id::text as "entityId",
             entity.platform_key as "platformKey",
             entity.external_id as "externalId",
             revision.content_json as content,
             revision.public_change_sequence as "publicChangeSequence",
             revision.source_updated_at as "occurredAt"
      from canonical_revisions as revision
      join canonical_entities as entity on entity.id = revision.entity_id
      where revision.organization_id = ${ids.organization}::uuid
        and entity.record_kind = 'pack'
      order by revision.public_change_sequence
      limit 1
    `;
    const replaySource = replaySources[0]!;
    const directReplayInput = {
      organizationId: ids.organization,
      revisions: [{ ...replaySource, recordKind: "pack" }],
      createdAt: new Date(committedAt.getTime() + 1),
    } as const;
    await assert.rejects(
      persistNormalizedHeatObservationsForCanonicalWrites(
        harness.client as unknown as PackscoutTransactionClient,
        directReplayInput,
      ),
      /active database transaction/,
    );
    const sequenceBeforeReplay =
      await harness.client.normalized_heat_window_checkpoints.findUniqueOrThrow({
        where: { organization_id: ids.organization },
        select: { next_catalog_sequence: true },
      });
    const directReplay = await harness.client.$transaction((transaction) =>
      persistNormalizedHeatObservationsForCanonicalWrites(
        transaction,
        directReplayInput,
      ));
    assert.deepEqual(directReplay, {
      normalized: 0,
      deferred: 0,
      rejected: 0,
      duplicate: 1,
    });
    const sequenceAfterReplay =
      await harness.client.normalized_heat_window_checkpoints.findUniqueOrThrow({
        where: { organization_id: ids.organization },
        select: { next_catalog_sequence: true },
      });
    assert.equal(
      sequenceAfterReplay.next_catalog_sequence,
      sequenceBeforeReplay.next_catalog_sequence,
    );

    const retainedHistoryAt = new Date("2026-08-01T00:00:00.000Z");
    const retainedHistoryUntil = new Date("2026-08-08T00:00:00.000Z");
    const retainedObservationId = "55000000-0000-4000-8000-000000000040";
    await harness.client.normalized_heat_observations.create({
      data: {
        id: retainedObservationId,
        organization_id: ids.organization,
        observation_key: "a".repeat(64),
        canonical_revision_id: replaySource.revisionId,
        public_change_sequence: replaySource.publicChangeSequence,
        mapping_public_change_sequence: 1n,
        public_repack_id: ids.publicRepack,
        observation_kind: "catalog_snapshot",
        occurred_at: retainedHistoryAt,
        catalog_sequence: 2_000_000_000,
        realized_return_basis_points: null,
        value_multiple_basis_points: null,
        available_chase_count: 0,
        outcome_keys: [],
        retained_until: retainedHistoryUntil,
        created_at: configuredAt,
      },
    });
    await harness.client.normalized_heat_observation_outcomes.create({
      data: {
        organization_id: ids.organization,
        candidate_key: "b".repeat(64),
        canonical_revision_id: replaySource.revisionId,
        public_change_sequence: replaySource.publicChangeSequence,
        mapping_public_change_sequence: 1n,
        public_repack_id: ids.publicRepack,
        occurred_at: retainedHistoryAt,
        status: "normalized",
        reason_code: "NORMALIZED",
        observation_id: retainedObservationId,
        retained_until: retainedHistoryUntil,
        created_at: configuredAt,
      },
    });
    const protectedObservation =
      await harness.client.normalized_heat_observations.findFirstOrThrow({
        where: {
          organization_id: ids.organization,
          id: { not: retainedObservationId },
        },
        select: { id: true, organization_id: true },
      });
    await assert.rejects(
      harness.client.normalized_heat_observations.delete({
        where: {
          id_organization_id: {
            id: protectedObservation.id,
            organization_id: protectedObservation.organization_id,
          },
        },
      }),
      /retention has not elapsed/,
    );
    const firstCleanup = await harness.client.$transaction((transaction) =>
      cleanupExpiredNormalizedHeatHistory(transaction, {
        organizationId: ids.organization,
        cutoffAt: configuredAt,
        limit: 1,
      }));
    assert.deepEqual(firstCleanup, {
      deletedOutcomes: 1,
      deletedObservations: 0,
      hasMore: true,
    });
    const secondCleanup = await harness.client.$transaction((transaction) =>
      cleanupExpiredNormalizedHeatHistory(transaction, {
        organizationId: ids.organization,
        cutoffAt: configuredAt,
        limit: 1,
      }));
    assert.deepEqual(secondCleanup, {
      deletedOutcomes: 0,
      deletedObservations: 1,
      hasMore: false,
    });
    assert.equal(await harness.client.normalized_heat_observations.count(), 5);

    const reader = new PrismaNormalizedHeatObservationRepository(harness.client, {
      organizationId: ids.organization,
    });
    const unsettled = await reader.listSettledNormalizedHeatObservations({
      organizationId: ids.organization,
      publicRepackIds: [ids.publicRepack],
      occurredAtGte: sourceAt.toISOString(),
      occurredAtLt: new Date(sourceAt.getTime() + 1).toISOString(),
      causalSequenceLte: 1n,
      limit: 100,
    });
    assert.deepEqual(unsettled.observations, []);
    await assert.rejects(
      reader.listSettledNormalizedHeatObservations({
        organizationId: ids.organization,
        publicRepackIds: [ids.publicRepack],
        occurredAtGte: sourceAt.toISOString(),
        occurredAtLt: new Date(sourceAt.getTime() + 1).toISOString(),
        causalSequenceLte: 6n,
        limit: 100,
      }),
      /beyond settlement/,
    );

    const settledAt = new Date(committedAt.getTime() + 1_000);
    const checkpoint = await harness.client.$transaction(async (transaction) => {
      await transaction.public_derivation_obligations.updateMany({
        where: { organization_id: ids.organization },
        data: {
          state: "succeeded",
          outcome_classification: "success",
          acknowledged_claim_token: "55000000-0000-4000-8000-000000000099",
          outcome_at: settledAt,
          updated_at: settledAt,
        },
      });
      return advanceSettledPublicWatermark(transaction, {
        organizationId: ids.organization,
        settledAt,
      });
    });
    assert.equal(checkpoint.settledSequence, 6n);

    const settled = await reader.listSettledNormalizedHeatObservations({
      organizationId: ids.organization,
      publicRepackIds: [ids.publicRepack],
      occurredAtGte: sourceAt.toISOString(),
      occurredAtLt: new Date(sourceAt.getTime() + 1).toISOString(),
      causalSequenceLte: 6n,
      limit: 100,
    });
    assert.equal(settled.truncated, false);
    assert.equal(settled.sourceCoverageComplete, true);
    assert.equal(settled.observations.length, 5);
    assert.ok(settled.observations.every(({ schemaVersion }) =>
      schemaVersion === "normalized_heat_observation_v1"));
    assert.ok(settled.observations.every(({ observationKey }) =>
      /^[0-9a-f]{64}$/.test(observationKey)));

    const catalogs = settled.observations.filter(
      (observation) => observation.kind === "catalog_snapshot",
    );
    assert.deepEqual(
      catalogs.map(({ causalSequence }) => causalSequence),
      [2n, 3n, 4n],
    );
    assert.deepEqual(
      catalogs.map(({ catalogSequence }) => catalogSequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      catalogs.map(({ availableChaseCount }) => availableChaseCount),
      [0, 1, 2],
      "each same-time catalog snapshot must reconstruct state as of its own cause",
    );
    assert.ok(catalogs.at(-1)!.outcomeKeys.every((key) =>
      /^[0-9a-f]{64}$/.test(key)));
    assert.deepEqual(
      catalogs.at(-1)!.outcomeKeys,
      [...catalogs.at(-1)!.outcomeKeys].sort(),
    );

    const valuedPull = settled.observations.find(
      (observation) =>
        observation.kind === "pull"
        && observation.valueMultipleBasisPoints !== null,
    );
    assert.equal(valuedPull?.kind, "pull");
    if (valuedPull?.kind === "pull") {
      assert.equal(valuedPull.valueMultipleBasisPoints, 20_000);
      assert.equal(valuedPull.realizedReturnBasisPoints, 16_000);
    }
    const nullPull = settled.observations.find(
      (observation) =>
        observation.kind === "pull"
        && observation.valueMultipleBasisPoints === null,
    );
    assert.equal(nullPull?.kind, "pull");
    if (nullPull?.kind === "pull") {
      assert.equal(nullPull.realizedReturnBasisPoints, null);
    }
    const serialized = JSON.stringify(
      settled.observations,
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
    );
    assert.doesNotMatch(
      serialized,
      /organization|provider|actor|wallet|payload|quarantine|platform-a|pack-1/i,
    );

    const repeatRead = await reader.listSettledNormalizedHeatObservations({
      organizationId: ids.organization,
      publicRepackIds: [ids.publicRepack],
      occurredAtGte: sourceAt.toISOString(),
      occurredAtLt: new Date(sourceAt.getTime() + 1).toISOString(),
      causalSequenceLte: 6n,
      limit: 100,
    });
    assert.deepEqual(repeatRead, settled);
    const overflow = await reader.listSettledNormalizedHeatObservations({
      organizationId: ids.organization,
      publicRepackIds: [ids.publicRepack],
      occurredAtGte: sourceAt.toISOString(),
      occurredAtLt: new Date(sourceAt.getTime() + 1).toISOString(),
      causalSequenceLte: 6n,
      limit: 1,
    });
    assert.deepEqual(overflow, {
      observations: [],
      sourceCoverageComplete: false,
      truncated: true,
    });
    await assert.rejects(
      reader.listSettledNormalizedHeatObservations({
        organizationId: ids.otherOrganization,
        publicRepackIds: [ids.publicRepack],
        occurredAtGte: sourceAt.toISOString(),
        occurredAtLt: new Date(sourceAt.getTime() + 1).toISOString(),
        causalSequenceLte: 6n,
        limit: 100,
      }),
      /not approved/,
    );

    await createRun(setup, ids.secondRun, new Date(committedAt.getTime() + 2_000));
    const replay = await ingestion.commitPage(initialPage(ids.secondRun));
    assert.equal(replay.newCanonicalRevisions, 0);
    assert.equal(await harness.client.normalized_heat_observations.count(), 5);
    assert.equal(await harness.client.normalized_heat_observation_outcomes.count(), 5);

    await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId: ids.organization,
        changes: [{
          changeKind: "public_configuration",
          entityKey: "public-config:v1:heat-source-second",
          sourceKey: "catalog-release",
          sourceRevisionKey: "catalog-config-v2",
          occurredAt: new Date(settledAt.getTime() + 500),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["platform-a"],
            sharedConfigurationEpoch: {
              configurationKey: "catalog-config-v2",
              revision: 2,
              configurationHash: "2".padStart(64, "0"),
            },
          },
        }],
      });
      const approvedAt = new Date(settledAt.getTime() + 500);
      await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: ids.organization,
          configuration_key: "catalog-config-v2",
          revision: 2,
          configuration_json: { platforms: [{ platformKey: "platform-a" }] },
          configuration_hash: "2".padStart(64, "0"),
          approved_at: approvedAt,
          public_change_sequence: causes[0]!.sequence,
          created_at: approvedAt,
        },
      });
      const transactionalMapping =
        new PrismaPublicRepackIdentityMappingRepository(transaction);
      assert.deepEqual(
        await transactionalMapping.registerApprovedMappings({
          organizationId: ids.organization,
          approvedConfigurationKey: "catalog-config-v2",
          publicChangeSequence: causes[0]!.sequence,
          approvedAt,
          mappings: [{
            platformKey: "platform-a",
            packExternalId: "pack-1",
            publicRepackId: ids.publicRepack,
          }],
        }),
        { created: 0, existing: 1 },
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId: ids.organization,
        settledAt: new Date(settledAt.getTime() + 500),
      });
    });
    const originalMapping =
      await harness.client.public_repack_identity_mappings.findUniqueOrThrow({
        where: {
          organization_id_platform_key_pack_external_id: {
            organization_id: ids.organization,
            platform_key: "platform-a",
            pack_external_id: "pack-1",
          },
        },
      });
    assert.equal(originalMapping.approved_configuration_key, "catalog-config-v1");
    assert.equal(originalMapping.public_change_sequence, 1n);

    await reader.closeSettledWindow({
      closedBefore: new Date(sourceAt.getTime() + 1),
      throughSettledSequence: 7n,
      updatedAt: new Date(settledAt.getTime() + 1_000),
    });
    await commitSinglePull({
      ingestion,
      setup,
      runId: ids.lateRun,
      externalId: "pull-late",
      packExternalId: "pack-1",
      occurredAt: sourceAt,
      value: { amountMinor: 1_000, currency: "USD" },
    });
    await commitSinglePull({
      ingestion,
      setup,
      runId: ids.malformedRun,
      externalId: "pull-malformed",
      packExternalId: "pack-1",
      occurredAt: new Date(sourceAt.getTime() + 1),
      value: { amountMinor: "not-an-integer", currency: "USD" },
    });
    await commitSinglePull({
      ingestion,
      setup,
      runId: ids.missingMappingRun,
      externalId: "pull-unmapped",
      packExternalId: "unmapped-pack",
      occurredAt: new Date(sourceAt.getTime() + 2),
      value: null,
    });
    assert.equal(await harness.client.normalized_heat_observations.count(), 5);
    assert.deepEqual(
      (
        await harness.client.normalized_heat_observation_outcomes.findMany({
          where: { status: { in: ["rejected", "deferred"] } },
          orderBy: { public_change_sequence: "asc" },
          select: { status: true, reason_code: true },
        })
      ).map(({ status, reason_code }) => [status, reason_code]),
      [
        ["rejected", "WINDOW_CLOSED"],
        ["rejected", "EVIDENCE_MALFORMED"],
        ["deferred", "MAPPING_MISSING"],
      ],
    );
    const unrelatedUnmappedCoverage =
      await reader.listSettledNormalizedHeatObservations({
        organizationId: ids.organization,
        publicRepackIds: [ids.publicRepack],
        occurredAtGte: new Date(sourceAt.getTime() + 2).toISOString(),
        occurredAtLt: new Date(sourceAt.getTime() + 3).toISOString(),
        causalSequenceLte: 10n,
        limit: 100,
      });
    assert.equal(unrelatedUnmappedCoverage.sourceCoverageComplete, true);
    assert.deepEqual(unrelatedUnmappedCoverage.observations, []);
    const mappedMalformedCoverage =
      await reader.listSettledNormalizedHeatObservations({
        organizationId: ids.organization,
        publicRepackIds: [ids.publicRepack],
        occurredAtGte: new Date(sourceAt.getTime() + 1).toISOString(),
        occurredAtLt: new Date(sourceAt.getTime() + 2).toISOString(),
        causalSequenceLte: 10n,
        limit: 100,
      });
    assert.equal(mappedMalformedCoverage.sourceCoverageComplete, false);
    const incompleteCoverage =
      await reader.listSettledNormalizedHeatObservations({
        organizationId: ids.organization,
        publicRepackIds: [ids.publicRepack],
        occurredAtGte: sourceAt.toISOString(),
        occurredAtLt: new Date(sourceAt.getTime() + 3).toISOString(),
        causalSequenceLte: 10n,
        limit: 100,
      });
    assert.equal(incompleteCoverage.truncated, false);
    assert.equal(incompleteCoverage.sourceCoverageComplete, false);
    assert.equal(incompleteCoverage.observations.length, 5);

    await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId: ids.organization,
        changes: [{
          changeKind: "public_configuration",
          entityKey: "public-config:v1:late-mapping",
          sourceKey: "catalog-release",
          sourceRevisionKey: "catalog-config-v3",
          occurredAt: new Date(sourceAt.getTime() + 3),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["platform-a"],
            sharedConfigurationEpoch: {
              configurationKey: "catalog-config-v3",
              revision: 3,
              configurationHash: "3".padStart(64, "0"),
            },
          },
        }],
      });
      const approvedAt = new Date(sourceAt.getTime() + 3);
      await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: ids.organization,
          configuration_key: "catalog-config-v3",
          revision: 3,
          configuration_json: { platforms: [{ platformKey: "platform-a" }] },
          configuration_hash: "3".padStart(64, "0"),
          approved_at: approvedAt,
          public_change_sequence: causes[0]!.sequence,
          created_at: approvedAt,
        },
      });
      const transactionalMapping =
        new PrismaPublicRepackIdentityMappingRepository(transaction);
      assert.deepEqual(
        await transactionalMapping.registerApprovedMappings({
          organizationId: ids.organization,
          approvedConfigurationKey: "catalog-config-v3",
          publicChangeSequence: causes[0]!.sequence,
          approvedAt,
          mappings: [{
            platformKey: "platform-a",
            packExternalId: "unmapped-pack",
            publicRepackId: ids.secondPublicRepack,
          }],
        }),
        { created: 1, existing: 0 },
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId: ids.organization,
        settledAt: new Date(sourceAt.getTime() + 3),
      });
    });
    await commitSinglePull({
      ingestion,
      setup,
      runId: ids.mappedAfterApprovalRun,
      externalId: "pull-after-mapping",
      packExternalId: "unmapped-pack",
      occurredAt: new Date(sourceAt.getTime() + 3),
      value: null,
    });
    assert.equal(await harness.client.normalized_heat_observations.count(), 6);
    const newlyMapped = await reader.listSettledNormalizedHeatObservations({
      organizationId: ids.organization,
      publicRepackIds: [ids.secondPublicRepack],
      occurredAtGte: new Date(sourceAt.getTime() + 3).toISOString(),
      occurredAtLt: new Date(sourceAt.getTime() + 4).toISOString(),
      causalSequenceLte: 12n,
      limit: 100,
    });
    assert.equal(newlyMapped.observations.length, 1);
    assert.equal(newlyMapped.observations[0]?.kind, "pull");

    const reparentAt = new Date(sourceAt.getTime() + 5);
    await commitCatalogAssetChange({
      ingestion,
      setup,
      runId: ids.reparentRun,
      occurredAt: reparentAt,
      relatedPackExternalId: "unmapped-pack",
    });
    const reparentSnapshots =
      await harness.client.normalized_heat_observations.findMany({
        where: {
          organization_id: ids.organization,
          occurred_at: reparentAt,
          observation_kind: "catalog_snapshot",
        },
        orderBy: { catalog_sequence: "asc" },
      });
    assert.equal(
      reparentSnapshots.length,
      2,
      JSON.stringify(reparentSnapshots.map((row) => ({
        repack: row.public_repack_id,
        count: row.available_chase_count,
        sequence: row.catalog_sequence,
      }))),
    );
    assert.deepEqual(
      reparentSnapshots.map(({ public_repack_id }) => public_repack_id).sort(),
      [ids.publicRepack, ids.secondPublicRepack].sort(),
    );
    assert.equal(
      reparentSnapshots[1]!.catalog_sequence,
      reparentSnapshots[0]!.catalog_sequence! + 1,
    );
    assert.deepEqual(
      reparentSnapshots.map(({ available_chase_count }) =>
        available_chase_count).sort(),
      [1, 1],
      "the old pack loses the moved asset while the new pack gains it",
    );
    assert.notEqual(
      reparentSnapshots[0]!.observation_key,
      reparentSnapshots[1]!.observation_key,
    );

    const removalAt = new Date(sourceAt.getTime() + 6);
    await commitCatalogAssetChange({
      ingestion,
      setup,
      runId: ids.removalRun,
      occurredAt: removalAt,
      relatedPackExternalId: null,
    });
    const removalSnapshot =
      await harness.client.normalized_heat_observations.findFirstOrThrow({
        where: {
          organization_id: ids.organization,
          occurred_at: removalAt,
          observation_kind: "catalog_snapshot",
        },
      });
    assert.equal(removalSnapshot.public_repack_id, ids.secondPublicRepack);
    assert.equal(removalSnapshot.available_chase_count, 0);
    assert.deepEqual(removalSnapshot.outcome_keys, []);

    const exactArithmeticAt = new Date(sourceAt.getTime() + 7);
    await commitExactArithmeticEvidence({
      ingestion,
      setup,
      occurredAt: exactArithmeticAt,
    });
    const exactPull =
      await harness.client.normalized_heat_observations.findFirstOrThrow({
        where: {
          organization_id: ids.organization,
          occurred_at: exactArithmeticAt,
          observation_kind: "pull",
        },
      });
    assert.equal(exactPull.value_multiple_basis_points, 44_775);
    assert.equal(exactPull.realized_return_basis_points, null);

    const highSequence = BigInt(2_147_483_647) + 1n;
    await harness.client.settled_public_watermarks.update({
      where: { organization_id: ids.organization },
      data: {
        next_sequence: highSequence,
        source_head_sequence: highSequence - 1n,
        settled_sequence: highSequence - 1n,
        source_head_at: new Date(sourceAt.getTime() + 4),
        settled_at: new Date(sourceAt.getTime() + 4),
        updated_at: new Date(sourceAt.getTime() + 4),
      },
    });
    await commitSinglePull({
      ingestion,
      setup,
      runId: ids.highSequenceRun,
      externalId: "pull-high-causal-sequence",
      packExternalId: "pack-1",
      occurredAt: new Date(sourceAt.getTime() + 4),
      value: null,
    });
    const highObservation =
      await harness.client.normalized_heat_observations.findFirstOrThrow({
        where: { public_change_sequence: highSequence },
      });
    assert.equal(highObservation.observation_kind, "pull");
    assert.equal(highObservation.catalog_sequence, null);
    const highSequenceRead =
      await reader.listSettledNormalizedHeatObservations({
        organizationId: ids.organization,
        publicRepackIds: [ids.publicRepack],
        occurredAtGte: new Date(sourceAt.getTime() + 4).toISOString(),
        occurredAtLt: new Date(sourceAt.getTime() + 5).toISOString(),
        causalSequenceLte: highSequence,
        limit: 100,
      });
    assert.equal(highSequenceRead.observations.length, 1);
    assert.equal(highSequenceRead.observations[0]?.causalSequence, highSequence);

    const immutableHistory = await harness.client.normalized_heat_observations.findMany({
      orderBy: [{ public_change_sequence: "asc" }],
      select: { observation_key: true, retained_until: true, occurred_at: true },
    });
    assert.equal(immutableHistory.length, 13);
    assert.ok(immutableHistory.every(({ retained_until, occurred_at }) =>
      retained_until.getTime() - occurred_at.getTime() === 7 * 24 * 60 * 60 * 1_000));
  } finally {
    await harness.close();
  }
});
