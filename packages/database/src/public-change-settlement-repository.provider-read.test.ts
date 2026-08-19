import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ApprovedPublicCatalogConfigurationV1 } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PrismaCatalogReleaseSourceRepository,
} from "./catalog-release-source-repository.ts";
import { PrismaProviderConfigurationRepository } from "./provider-configuration-repository.ts";
import {
  loadProviderCausalReadinessInTransaction,
  PrismaProviderCatalogSettlementRepository,
} from "./public-change-settlement-repository.provider-read.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  createPublicDerivationObligations,
} from "./public-change-settlement-repository.ts";
import { prismaApprovedPublicRepackIdentityMaterializer } from "./public-repack-identity-mapping-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "55000000-0000-4000-8000-000000000001";
const providerId = "55000000-0000-4000-8000-000000000002";
const revisionId = "55000000-0000-4000-8000-000000000003";
const platformKey = "collector-crypt";
const publicCategoryId = "55000000-0000-5000-8000-000000000004";
const publicVendorId = "55000000-0000-5000-8000-000000000005";

function approvedConfiguration(
  approvedAt: Date,
): ApprovedPublicCatalogConfigurationV1 {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "catalog-empty-repacks-r1",
    revision: 1,
    approvedAt: approvedAt.toISOString(),
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: ["https://collector-crypt.example"],
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
      platformKey,
      vendor: {
        publicVendorId,
        vendorKey: platformKey,
        displayName: "Collector Crypt",
        logoUrl: null,
        websiteUrl: "https://collector-crypt.example",
        listingHosts: ["collector-crypt.example"],
        imageOrigins: ["https://collector-crypt.example"],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: [],
    collectibles: [],
  };
}

test("provider readiness accepts a settled terminal HTTP run and fails closed for every incomplete state", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const activatedAt = new Date("2026-08-16T08:00:00.000Z");
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "provider-readiness",
        name: "Provider Readiness",
      },
    });
    await harness.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: platformKey,
        display_name: "Collector Crypt",
        state: "draft",
        created_at: new Date(activatedAt.getTime() - 60_000),
        updated_at: new Date(activatedAt.getTime() - 60_000),
      },
    });
    await harness.client.provider_config_revisions.create({
      data: {
        id: revisionId,
        organization_id: organizationId,
        provider_id: providerId,
        version: 1,
        adapter_key: "data-forrest-v2",
        endpoint_url: "https://provider.example/v1/events",
        auth_mode: "none",
        schedule_seconds: 300,
        stale_after_seconds: 900,
        tested_at: new Date(activatedAt.getTime() - 30_000),
        tested_by_actor_key: "actor:test",
        created_by_actor_key: "actor:test",
        created_at: new Date(activatedAt.getTime() - 60_000),
        source_mode: "http",
      },
    });

    const preActivationRunFinishedAt = new Date(activatedAt.getTime() - 1_000);
    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date(preActivationRunFinishedAt.getTime() - 1_000),
        finished_at: preActivationRunFinishedAt,
        reached_provider_head: true,
        created_at: new Date(preActivationRunFinishedAt.getTime() - 1_000),
      },
    });
    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date(activatedAt.getTime() - 500),
        finished_at: new Date(activatedAt.getTime() + 500),
        reached_provider_head: true,
        created_at: new Date(activatedAt.getTime() - 500),
      },
    });

    const activation = await new PrismaProviderConfigurationRepository(
      harness.client,
    ).activateRevision({
      organizationId,
      providerId,
      expectedRevisionId: revisionId,
      actorKey: "actor:test",
      activatedAt,
      nextRunAt: new Date(activatedAt.getTime() + 300_000),
    });
    assert.equal(activation.kind, "updated");
    const [atomicActivation] = await harness.client.$queryRaw<Array<{
      transactionId: string;
      providerTransactionId: string;
      impactTransactionId: string;
      providerCheckpointTransactionId: string;
      manifestCheckpointTransactionId: string;
      watermarkTransactionId: string;
    }>>(Prisma.sql`
      select cause.authoritative_transaction_id as "transactionId",
             provider.xmin::text as "providerTransactionId",
             impact.xmin::text as "impactTransactionId",
             provider_checkpoint.xmin::text as "providerCheckpointTransactionId",
             manifest_checkpoint.xmin::text as "manifestCheckpointTransactionId",
             watermark.xmin::text as "watermarkTransactionId"
      from public.public_change_causes as cause
      join public.provider_sources as provider
        on provider.organization_id = cause.organization_id
       and provider.id = ${providerId}::uuid
      join public.public_change_catalog_impacts as impact
        on impact.organization_id = cause.organization_id
       and impact.cause_sequence = cause.sequence
      join public.provider_catalog_checkpoints as provider_checkpoint
        on provider_checkpoint.organization_id = cause.organization_id
       and provider_checkpoint.platform_key = ${platformKey}
      join public.catalog_manifest_lifecycle_checkpoints as manifest_checkpoint
        on manifest_checkpoint.organization_id = cause.organization_id
      join public.settled_public_watermarks as watermark
        on watermark.organization_id = cause.organization_id
      where cause.organization_id = ${organizationId}::uuid
        and cause.entity_key = ${`provider:v1:${providerId}`}
    `);
    assert.ok(atomicActivation);
    assert.deepEqual(
      new Set([
        atomicActivation.transactionId,
        atomicActivation.providerTransactionId,
        atomicActivation.impactTransactionId,
        atomicActivation.providerCheckpointTransactionId,
        atomicActivation.manifestCheckpointTransactionId,
        atomicActivation.watermarkTransactionId,
      ]).size,
      1,
      "activation, lifecycle impact, and every settlement head share one PostgreSQL transaction",
    );

    const approvedAt = new Date(activatedAt.getTime() + 60_000);
    const approved = await new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    ).approveConfiguration(
      approvedConfiguration(approvedAt),
      prismaApprovedPublicRepackIdentityMaterializer,
    );
    assert.equal(approved.configuration.repacks.length, 0);
    assert.equal(approved.heatRematerialization, null);
    assert.equal(
      await harness.client.public_repack_identity_mappings.count({
        where: { organization_id: organizationId },
      }),
      0,
    );
    assert.equal(
      await harness.client.approved_public_catalog_configurations.count({
        where: { organization_id: organizationId },
      }),
      1,
      "empty repack governance still persists the approved epoch",
    );

    const reads = new PrismaProviderCatalogSettlementRepository(harness.client);
    assert.deepEqual(
      (await reads.loadManifestEligibilitySnapshot({ organizationId }))
        ?.enabledPlatformKeys,
      [platformKey],
    );
    assert.equal(
      await reads.loadProviderPromotionCheckpoint({
        organizationId,
        platformKey,
      }),
      null,
      "a run created before the active lifecycle decision is not a backfill even if it finishes later",
    );

    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        trigger: "archive",
        archive_sha256: "a".repeat(64),
        requested_by_actor_key: "actor:test",
        state: "succeeded",
        started_at: approvedAt,
        finished_at: new Date(approvedAt.getTime() + 5_000),
        reached_provider_head: true,
        created_at: approvedAt,
      },
    });
    assert.equal(
      await reads.loadProviderPromotionCheckpoint({ organizationId, platformKey }),
      null,
      "an archive-trigger run cannot satisfy the live HTTP backfill boundary",
    );

    const activeRunId = randomUUID();
    const queuedAt = new Date(approvedAt.getTime() + 10_000);
    await harness.client.import_runs.create({
      data: {
        id: activeRunId,
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        trigger: "scheduled",
        state: "queued",
        created_at: queuedAt,
      },
    });
    assert.equal(
      await reads.loadProviderPromotionCheckpoint({ organizationId, platformKey }),
      null,
      "queued is not a completed backfill",
    );
    await harness.client.import_runs.update({
      where: { id: activeRunId },
      data: { state: "running", started_at: queuedAt },
    });
    assert.equal(
      await reads.loadProviderPromotionCheckpoint({ organizationId, platformKey }),
      null,
      "running is not a completed backfill",
    );
    await harness.client.import_runs.update({
      where: { id: activeRunId },
      data: {
        state: "failed",
        reached_provider_head: true,
        finished_at: new Date(queuedAt.getTime() + 1_000),
        failure_code: "TEST_FAILURE",
      },
    });
    assert.equal(
      await reads.loadProviderPromotionCheckpoint({ organizationId, platformKey }),
      null,
      "failed is not a completed backfill even when it reports the head",
    );

    for (const input of [
      {
        state: "incomplete" as const,
        reachedProviderHead: true,
        finishedAt: new Date(queuedAt.getTime() + 2_000),
      },
      {
        state: "succeeded" as const,
        reachedProviderHead: false,
        finishedAt: new Date(queuedAt.getTime() + 3_000),
      },
    ]) {
      await harness.client.import_runs.create({
        data: {
          organization_id: organizationId,
          provider_id: providerId,
          config_revision_id: revisionId,
          trigger: "scheduled",
          state: input.state,
          started_at: queuedAt,
          finished_at: input.finishedAt,
          reached_provider_head: input.reachedProviderHead,
          created_at: queuedAt,
        },
      });
      assert.equal(
        await reads.loadProviderPromotionCheckpoint({
          organizationId,
          platformKey,
        }),
        null,
        `${input.state}/${input.reachedProviderHead} is not a completed backfill`,
      );
    }

    const terminalPageSettledAt = new Date(approvedAt.getTime() + 30_000);
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:collector-crypt-terminal-page",
          sourceKey: platformKey,
          sourceRevisionKey: revisionId,
          occurredAt: terminalPageSettledAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: [platformKey],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: terminalPageSettledAt,
      });
    });
    const successfulRunFinishedAt = new Date(
      terminalPageSettledAt.getTime() + 1_000,
    );
    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        trigger: "scheduled",
        state: "succeeded",
        started_at: queuedAt,
        finished_at: successfulRunFinishedAt,
        reached_provider_head: true,
        created_at: queuedAt,
      },
    });
    const ready = await reads.loadProviderPromotionCheckpoint({
      organizationId,
      platformKey,
    });
    assert.equal(
      ready?.lastSuccessfulObservationAt.toISOString(),
      successfulRunFinishedAt.toISOString(),
    );
    assert.equal(ready?.freshness, "fresh");
    const readySnapshot = await reads.loadManifestEligibilitySnapshot({
      organizationId,
    });
    assert.ok(readySnapshot?.checkpoints[0]);
    const [causalReadiness] = await harness.client.$transaction(
      (transaction) => loadProviderCausalReadinessInTransaction(transaction, {
        organizationId,
        checkpoints: [readySnapshot.checkpoints[0]!],
      }),
    );
    assert.equal(
      causalReadiness?.completedBackfillAt?.toISOString(),
      successfulRunFinishedAt.toISOString(),
      "the first post-activation succeeded head run is the completed backfill",
    );

    const blockedAt = new Date(successfulRunFinishedAt.getTime() + 1_000);
    let blockedSequence = 0n;
    await harness.client.$transaction(async (transaction) => {
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:collector-crypt-pending-ev",
          sourceKey: platformKey,
          sourceRevisionKey: revisionId,
          occurredAt: blockedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: [platformKey],
          },
        }],
      });
      blockedSequence = cause!.sequence;
      await createPublicDerivationObligations(transaction, {
        organizationId,
        causeSequences: [blockedSequence],
        derivationKind: "estimated_ev",
        derivationKey: "collector-crypt-pending-ev",
        createdAt: blockedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: blockedAt,
      });
    });
    assert.equal(
      await reads.loadProviderPromotionCheckpoint({ organizationId, platformKey }),
      null,
      "a successful head run cannot bypass an unsettled provider obligation",
    );

    const recoveredAt = new Date(blockedAt.getTime() + 1_000);
    await harness.client.$transaction(async (transaction) => {
      await transaction.public_derivation_obligations.updateMany({
        where: {
          organization_id: organizationId,
          cause_sequence: blockedSequence,
        },
        data: {
          state: "succeeded",
          outcome_classification: "success",
          acknowledged_claim_token: randomUUID(),
          outcome_at: recoveredAt,
          updated_at: recoveredAt,
        },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: recoveredAt,
      });
    });
    assert.equal(
      (await reads.loadProviderPromotionCheckpoint({
        organizationId,
        platformKey,
      }))?.lastSuccessfulObservationAt.toISOString(),
      successfulRunFinishedAt.toISOString(),
      "settlement recovery reuses the already-completed causal backfill",
    );
  } finally {
    await harness.close();
  }
});
