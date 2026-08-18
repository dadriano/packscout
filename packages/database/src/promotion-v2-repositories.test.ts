import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import { PrismaCatalogPromotionBootstrapProofRepository } from
  "./catalog-promotion-bootstrap-proof-repository.ts";
import {
  ApprovedPublicCatalogConfigurationPersistenceError,
} from "./catalog-release-source-repository.ts";
import { selectManifestDefinitionRequestBody } from
  "./catalog-promotion-bootstrap-candidate.ts";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import { PrismaPromotionReadinessRepository } from
  "./promotion-readiness-repository.ts";
import {
  PromotionV2PersistenceError,
  promotionV2Sha256,
  type ProviderPromotionCheckpointIdentity,
} from "./promotion-v2-types.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  completedExpectedHead,
  manifestActivationFixture,
  manifestActiveStateEvidence,
  manifestRefreshFixture,
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
  seedPromotionV2VerifiedEmptyBootstrap,
} from "./promotion-v2-test-fixtures.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "5a000000-0000-4000-8000-000000000001";
const deploymentKey = "promotion-v2-test";
const platformKey = "alpha-platform";
const requestedAt = new Date("2026-08-16T12:00:00.000Z");

function checkpoint(
  lastSuccessfulObservationAt = requestedAt,
): ProviderPromotionCheckpointIdentity {
  return {
    platformKey,
    sharedConfigurationEpoch: {
      configurationKey: "catalog-v1",
      revision: 1,
      publicChangeSequence: 1n,
      configurationHash: "a".repeat(64),
    },
    settledSequence: 10n,
    sourceHeadSequence: 10n,
    settledAt: requestedAt,
    sourceHeadAt: requestedAt,
    lastSuccessfulObservationAt,
    staleAt: new Date(lastSuccessfulObservationAt.getTime() + 900_000),
    freshness: "fresh",
    blockedState: { kind: "ready" },
  };
}

test("provider and manifest lanes serialize claims, recover leases, and coalesce exact replay", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "promotion-v2-test",
        name: "Promotion V2 Test",
      },
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, [platformKey], requestedAt,
    );
    const provider = new PrismaProviderPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
      platformKey,
    });
    const manifest = new PrismaManifestPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });

    assert.deepEqual(await provider.enqueueEvaluation({
      checkpoint: checkpoint(),
      requestedAt,
    }), { evaluationSequence: 1n, result: "created" });
    await assert.rejects(
      () => provider.enqueueEvaluation({
        checkpoint: {
          ...checkpoint(),
          sharedConfigurationEpoch: {
            ...checkpoint().sharedConfigurationEpoch,
            configurationHash: "b".repeat(64),
          },
        },
        requestedAt: new Date(requestedAt.getTime() + 1),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_CHECKPOINT_REGRESSED",
    );
    await assert.rejects(
      () => provider.enqueueEvaluation({
        checkpoint: {
          ...checkpoint(),
          settledAt: new Date(requestedAt.getTime() + 1),
        },
        requestedAt: new Date(requestedAt.getTime() + 2),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_CHECKPOINT_REGRESSED",
    );
    await assert.rejects(
      () => provider.enqueueEvaluation({
        checkpoint: {
          ...checkpoint(),
          sourceHeadAt: new Date(requestedAt.getTime() + 1),
          freshness: "delayed",
        },
        requestedAt: new Date(requestedAt.getTime() + 3),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_CHECKPOINT_REGRESSED",
    );
    await assert.rejects(
      () => provider.claim({
        workerId: "provider-before-bootstrap",
        now: requestedAt,
        leaseExpiresAt: new Date(requestedAt.getTime() + 60_000),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_BOOTSTRAP_UNVERIFIED",
    );

    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "initial-empty-probe",
      requestedAt,
    }), { evaluationSequence: 1n, result: "created" });
    await seedPromotionV2VerifiedEmptyBootstrap(
      harness, organizationId, deploymentKey, [platformKey], requestedAt,
    );

    const providerLease = new Date(requestedAt.getTime() + 60_000);
    const providerClaims = await Promise.all([
      provider.claim({
        workerId: "provider-a",
        now: requestedAt,
        leaseExpiresAt: providerLease,
      }),
      provider.claim({
        workerId: "provider-b",
        now: requestedAt,
        leaseExpiresAt: providerLease,
      }),
    ]);
    const firstProviderClaim = providerClaims.find((claim) => claim !== null);
    assert.ok(firstProviderClaim);
    assert.equal(providerClaims.filter((claim) => claim !== null).length, 1);
    assert.equal(await provider.heartbeat({
      attemptId: firstProviderClaim.attemptId,
      claimToken: "5a000000-0000-4000-8000-000000000099",
      heartbeatAt: new Date(requestedAt.getTime() + 1_000),
      leaseExpiresAt: new Date(requestedAt.getTime() + 61_000),
    }), false);
    assert.equal(await provider.claim({
      workerId: "provider-too-early",
      now: new Date(requestedAt.getTime() + 30_000),
      leaseExpiresAt: new Date(requestedAt.getTime() + 90_000),
    }), null);
    const recovered = await provider.claim({
      workerId: "provider-recovered",
      now: new Date(requestedAt.getTime() + 61_000),
      leaseExpiresAt: new Date(requestedAt.getTime() + 121_000),
    });
    assert.ok(recovered);
    assert.equal(recovered.recovered, true);
    assert.notEqual(recovered.claimToken, firstProviderClaim.claimToken);
    const claimedProviderHealth = await provider.loadHealth({ now: requestedAt });
    assert.ok(claimedProviderHealth.activeAttemptStartedAt instanceof Date);

    assert.deepEqual(await provider.enqueueEvaluation({
      checkpoint: checkpoint(),
      requestedAt: new Date(requestedAt.getTime() + 62_000),
    }), { evaluationSequence: 1n, result: "coalesced" });
    assert.deepEqual(await provider.enqueueEvaluation({
      checkpoint: checkpoint(new Date(requestedAt.getTime() + 1_000)),
      requestedAt: new Date(requestedAt.getTime() + 63_000),
    }), { evaluationSequence: 2n, result: "created" });
    assert.equal(await provider.complete({
      attemptId: recovered.attemptId,
      claimToken: recovered.claimToken,
      outcome: "superseded",
      completedAt: new Date(requestedAt.getTime() + 64_000),
    }), true);

    const manifestLease = new Date(requestedAt.getTime() + 120_000);
    const manifestClaims = await Promise.all([
      manifest.claim({
        workerId: "manifest-a",
        now: requestedAt,
        leaseExpiresAt: manifestLease,
      }),
      manifest.claim({
        workerId: "manifest-b",
        now: requestedAt,
        leaseExpiresAt: manifestLease,
      }),
    ]);
    assert.equal(manifestClaims.filter((claim) => claim !== null).length, 1);
    const manifestClaim = manifestClaims.find((claim) => claim !== null);
    assert.ok(manifestClaim);
    assert.ok((await manifest.loadHealth({ now: requestedAt }))
      .activeAttemptStartedAt instanceof Date);
    assert.equal(await manifest.heartbeat({
      attemptId: manifestClaim.attemptId,
      claimToken: "5a000000-0000-4000-8000-000000000098",
      heartbeatAt: new Date(requestedAt.getTime() + 1_000),
      leaseExpiresAt: new Date(requestedAt.getTime() + 121_000),
    }), false);
    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "initial-empty-probe",
      requestedAt: new Date(requestedAt.getTime() + 1_000),
    }), { evaluationSequence: 1n, result: "coalesced" });
    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "observation_succeeded",
      causeIdentity: "observation-2",
      requestedAt: new Date(requestedAt.getTime() + 2_000),
    }), { evaluationSequence: 2n, result: "created" });

    const secondProviderClaim = await provider.claim({
      workerId: "provider-second-evaluation",
      now: new Date(requestedAt.getTime() + 65_000),
      leaseExpiresAt: new Date(requestedAt.getTime() + 125_000),
    });
    assert.ok(secondProviderClaim);
    await harness.client.provider_promotion_attempts.update({
      where: { id: secondProviderClaim.attemptId },
      data: {
        prepared_classification: "publish",
        prepared_summary_body: "{}",
        prepared_summary_sha256: "f".repeat(64),
        public_provider_release_id:
          "5a000000-0000-5000-8000-000000000010",
        provider_release_fingerprint: "1".repeat(64),
        expected_completed_head_sha256: "2".repeat(64),
        prepared_at: new Date(requestedAt.getTime() + 66_000),
      },
    });
    await assert.rejects(
      () => provider.claim({
        workerId: "provider-corrupt-recovery",
        now: new Date(requestedAt.getTime() + 126_000),
        leaseExpiresAt: new Date(requestedAt.getTime() + 186_000),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_STATE_CONFLICT",
    );

    await harness.client.manifest_promotion_attempts.update({
      where: { id: manifestClaim.attemptId },
      data: {
        prepared_operation_kind: "no_change",
        prepared_summary_body: "{}",
        prepared_summary_sha256: "e".repeat(64),
        evaluation_snapshot_body: "{}",
        evaluation_snapshot_sha256: "d".repeat(64),
        expected_active_state_sha256: "c".repeat(64),
        prepared_at: new Date(requestedAt.getTime() + 3_000),
      },
    });
    await assert.rejects(
      () => manifest.claim({
        workerId: "manifest-corrupt-recovery",
        now: new Date(requestedAt.getTime() + 121_000),
        leaseExpiresAt: new Date(requestedAt.getTime() + 181_000),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_STATE_CONFLICT",
    );
  } finally {
    await harness.close();
  }
});

test("bootstrap distinguishes an unproven probe from a concurrent proven transition", async () => {
  const harness = await createMigratedTestDatabase();
  const requestBody = canonicalJson({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "bootstrap-active-state",
  });
  const emptyState = {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  } as const;
  const receiptBody = canonicalJson({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activeState",
    operationId: "bootstrap-active-state",
    terminalState: "observed",
    result: "active_state",
    serverTime: requestedAt.toISOString(),
    requestDigest: promotionV2Sha256(requestBody),
    receiptDigest: "a".repeat(64),
    details: { activeState: emptyState },
  });
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "bootstrap-race",
        name: "Bootstrap Race",
      },
    });
    const proofs = new PrismaCatalogPromotionBootstrapProofRepository(
      harness.client,
      { organizationId, deploymentKey },
    );
    await assert.rejects(
      () => proofs.verifyEmpty({
        activeStateRequestBody: requestBody,
        activeStateReceiptBody: receiptBody,
        providers: [],
        verifiedAt: requestedAt,
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
    );

    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, [platformKey], requestedAt,
    );
    await seedPromotionV2VerifiedEmptyBootstrap(
      harness, organizationId, deploymentKey, [platformKey], requestedAt,
    );

    const clearedState = canonicalJson({
      generation: 1,
      activeManifest: null,
      previousManifest: null,
      observation: null,
      terminalReceiptSha256: "b".repeat(64),
    });
    await harness.client.manifest_promotion_lanes.update({
      where: {
        organization_id_deployment_key: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
        },
      },
      data: {
        bootstrap_state: "verified_cleared",
        bootstrap_verified_at: requestedAt,
        active_generation: 1n,
        active_state_body: clearedState,
        active_state_sha256: promotionV2Sha256(clearedState),
        active_state_receipt_body: "{}",
        active_state_receipt_sha256: promotionV2Sha256("{}"),
        active_terminal_receipt_sha256: "b".repeat(64),
        last_reconciled_at: requestedAt,
      },
    });
    await assert.rejects(
      () => proofs.verifyEmpty({
        activeStateRequestBody: requestBody,
        activeStateReceiptBody: receiptBody,
        providers: [],
        verifiedAt: new Date(requestedAt.getTime() + 1_000),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_STATE_CONFLICT",
    );
  } finally {
    await harness.close();
  }
});

test("provider publication persists exact ordered evidence, advances heads, and atomically reconciles manifests", async () => {
  const harness = await createMigratedTestDatabase();
  const scopeOrganizationId = "5a000000-0000-4000-8000-000000000010";
  const otherOrganizationId = "5a000000-0000-4000-8000-000000000011";
  const operationBase = new Date("2026-08-16T13:00:00.000Z");
  try {
    await harness.client.organizations.createMany({
      data: [
        { id: scopeOrganizationId, slug: "provider-publication", name: "Provider Publication" },
        { id: otherOrganizationId, slug: "provider-publication-other", name: "Other Provider" },
      ],
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, scopeOrganizationId, ["alpha"], operationBase,
    );
    await seedPromotionV2VerifiedEmptyBootstrap(
      harness, scopeOrganizationId, deploymentKey, ["alpha"], operationBase,
    );
    const provider = new PrismaProviderPromotionRepository(harness.client, {
      organizationId: scopeOrganizationId,
      deploymentKey,
      platformKey: "alpha",
    });
    const beta = new PrismaProviderPromotionRepository(harness.client, {
      organizationId: scopeOrganizationId,
      deploymentKey,
      platformKey: "beta",
    });
    const other = new PrismaProviderPromotionRepository(harness.client, {
      organizationId: otherOrganizationId,
      deploymentKey,
      platformKey: "alpha",
    });
    const publication = await providerPublicationFixture();
    assert.deepEqual(await provider.enqueueEvaluation({
      checkpoint: publication.checkpoint,
      requestedAt: operationBase,
    }), { evaluationSequence: 1n, result: "created" });
    const initialClaim = await provider.claim({
      workerId: "provider-publisher",
      now: operationBase,
      leaseExpiresAt: new Date(operationBase.getTime() + 60_000),
    });
    assert.ok(initialClaim);
    assert.equal(initialClaim.checkpointSha256, publication.summary.checkpointSha256);
    const prepared = await provider.persistPreparedOperations({
      attemptId: initialClaim.attemptId,
      claimToken: initialClaim.claimToken,
      preparedAt: new Date(operationBase.getTime() + 1_000),
      summary: publication.summary,
      operations: publication.operations,
    });
    assert.ok(prepared);
    assert.deepEqual(
      prepared.map(({ operationIndex, operationId, operationKind, state }) => ({
        operationIndex, operationId, operationKind, state,
      })),
      publication.operations.map(({ operationIndex, operationId, operationKind }) => ({
        operationIndex, operationId, operationKind, state: "pending",
      })),
    );
    assert.deepEqual(
      prepared.map(({ canonicalRequestBody, requestSha256 }) => ({
        canonicalRequestBody, requestSha256,
      })),
      publication.operations.map(({ canonicalRequestBody }) => ({
        canonicalRequestBody,
        requestSha256: promotionV2Sha256(canonicalRequestBody),
      })),
    );
    await assert.rejects(
      () => provider.markOperationSent({
        attemptId: initialClaim.attemptId,
        operationId: publication.operations[1]!.operationId,
        claimToken: initialClaim.claimToken,
        sentAt: new Date(operationBase.getTime() + 2_000),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_OPERATION_ORDER",
    );
    await assert.rejects(
      () => provider.acknowledgeOperation({
        attemptId: initialClaim.attemptId,
        operationId: publication.operations[0]!.operationId,
        claimToken: initialClaim.claimToken,
        acknowledgedAt: new Date(operationBase.getTime() + 2_000),
        evidence: publication.evidence[0]!,
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_OPERATION_ORDER",
    );
    assert.equal(await provider.markOperationSent({
      attemptId: initialClaim.attemptId,
      operationId: publication.operations[0]!.operationId,
      claimToken: initialClaim.claimToken,
      sentAt: new Date(operationBase.getTime() + 2_000),
    }), true);
    assert.equal(await provider.acknowledgeOperation({
      attemptId: initialClaim.attemptId,
      operationId: publication.operations[0]!.operationId,
      claimToken: initialClaim.claimToken,
      acknowledgedAt: new Date(operationBase.getTime() + 61_000),
      evidence: publication.evidence[0]!,
    }), false);
    const recovered = await provider.claim({
      workerId: "provider-status-first-restart",
      now: new Date(operationBase.getTime() + 61_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 121_000),
    });
    assert.ok(recovered);
    const recoveredFirst = await provider.firstUnacknowledgedOperation({
      attemptId: recovered.attemptId,
      claimToken: recovered.claimToken,
      now: new Date(operationBase.getTime() + 62_000),
    });
    assert.equal(recoveredFirst?.operationId, publication.operations[0]!.operationId);
    assert.equal(recoveredFirst?.state, "sent");
    assert.equal(recoveredFirst?.sendCount, 1);
    assert.equal(await provider.acknowledgeOperation({
      attemptId: recovered.attemptId,
      operationId: publication.operations[0]!.operationId,
      claimToken: recovered.claimToken,
      acknowledgedAt: new Date(operationBase.getTime() + 63_000),
      evidence: publication.evidence[0]!,
    }), true);
    for (let index = 1; index < publication.operations.length; index += 1) {
      const operation = publication.operations[index]!;
      assert.equal(await provider.markOperationSent({
        attemptId: recovered.attemptId,
        operationId: operation.operationId,
        claimToken: recovered.claimToken,
        sentAt: new Date(operationBase.getTime() + 64_000 + index * 2_000),
      }), true);
      assert.equal(await provider.acknowledgeOperation({
        attemptId: recovered.attemptId,
        operationId: operation.operationId,
        claimToken: recovered.claimToken,
        acknowledgedAt: new Date(operationBase.getTime() + 65_000 + index * 2_000),
        evidence: publication.evidence[index]!,
      }), true);
    }
    assert.equal(await provider.complete({
      attemptId: recovered.attemptId,
      claimToken: recovered.claimToken,
      outcome: "published",
      completedAt: new Date(operationBase.getTime() + 75_000),
    }), true);
    const completed = await provider.loadCompletedHead();
    assert.ok(completed);
    assert.equal(completed.terminalOperationKind, "finalize");
    assert.equal(completed.terminalReceiptSha256, publication.terminalReceiptSha256);
    assert.equal(completed.exactResponseBody, publication.evidence.at(-1)!.exactResponseBody);
    const providerReadiness = new PrismaPromotionReadinessRepository(
      harness.client,
      {
        organizationId: scopeOrganizationId,
        deploymentKey,
        lane: "provider",
        platformKey: "alpha",
      },
    );
    const completedReadiness = await providerReadiness.load();
    assert.equal(
      completedReadiness.confirmedWatermark,
      publication.checkpoint.settledSequence,
      "provider completion reconciles its own terminal work",
    );
    assert.equal(
      completedReadiness.activationConfirmedWatermark,
      publication.checkpoint.settledSequence,
      "an unproven lifecycle is recovery-only and does not report active lag",
    );
    const artifact = await provider.loadReleaseArtifact({
      publicProviderReleaseId: publication.summary.publicProviderReleaseId,
    });
    assert.ok(artifact);
    assert.equal(artifact.publishAttemptId, recovered.attemptId);
    assert.equal(artifact.operations.length, 3);
    assert.equal(await beta.loadCompletedHead(), null);
    assert.equal(await other.loadCompletedHead(), null);
    const manifestAfterPublish = await harness.client.$queryRaw<Array<{
      cause: string;
      causeIdentity: string;
      evaluationSequence: bigint;
    }>>(Prisma.sql`
      select cause, cause_identity as "causeIdentity",
             evaluation_sequence as "evaluationSequence"
      from public.manifest_promotion_evaluations
      where organization_id = cast(${scopeOrganizationId} as uuid)
        and deployment_key = ${deploymentKey}
      order by evaluation_sequence
    `);
    assert.deepEqual(manifestAfterPublish.map(({ cause, evaluationSequence }) => ({
      cause, evaluationSequence,
    })), [{ cause: "provider_completed", evaluationSequence: 1n }]);
    assert.match(manifestAfterPublish[0]!.causeIdentity, /^alpha:provider:finalize:/u);
    const manifest = new PrismaManifestPromotionRepository(harness.client, {
      organizationId: scopeOrganizationId,
      deploymentKey,
    });
    const manifestClaim = await manifest.claim({
      workerId: "manifest-activate",
      now: new Date(operationBase.getTime() + 76_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 77_000),
    });
    assert.ok(manifestClaim);
    const activation = await manifestActivationFixture({
      publication,
      organizationId: scopeOrganizationId,
      evaluationSequence: manifestClaim.evaluationSequence,
      publishArtifactAttemptId: recovered.attemptId,
    });
    await harness.client.manifest_promotion_attempts.update({
      where: { id: manifestClaim.attemptId },
      data: {
        evaluation_snapshot_body: activation.snapshotBody,
        evaluation_snapshot_sha256: activation.snapshotSha256,
      },
    });
    const staleEnablementProjection = JSON.parse(activation.snapshotBody) as {
      providerFacts: Array<{
        minimumEligibleCheckpoint: string;
        completedHead: { selectedCheckpoint: string };
      }>;
    };
    staleEnablementProjection.providerFacts[0]!.minimumEligibleCheckpoint =
      String(BigInt(
        staleEnablementProjection.providerFacts[0]!.completedHead
          .selectedCheckpoint,
      ) + 1n);
    const staleEnablementBody = canonicalJson(staleEnablementProjection);
    const staleEnablementSha256 = promotionV2Sha256(staleEnablementBody);
    await harness.client.manifest_promotion_attempts.update({
      where: { id: manifestClaim.attemptId },
      data: {
        evaluation_snapshot_body: staleEnablementBody,
        evaluation_snapshot_sha256: staleEnablementSha256,
      },
    });
    await assert.rejects(
      () => manifest.persistPreparedOperation({
        attemptId: manifestClaim.attemptId,
        claimToken: manifestClaim.claimToken,
        preparedAt: new Date(operationBase.getTime() + 76_050),
        summary: {
          ...activation.summary,
          evaluationSnapshotSha256: staleEnablementSha256,
        },
        operation: activation.operation,
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_OPERATION_CONFLICT",
    );
    await harness.client.manifest_promotion_attempts.update({
      where: { id: manifestClaim.attemptId },
      data: {
        evaluation_snapshot_body: activation.snapshotBody,
        evaluation_snapshot_sha256: activation.snapshotSha256,
      },
    });
    const tamperedRequest = JSON.parse(
      activation.operation.canonicalRequestBody,
    ) as {
      observation: {
        staleAt: string;
        providerSelections: Array<{ staleAt: string }>;
      };
    };
    const tamperedStaleAt = new Date(
      Date.parse(tamperedRequest.observation.staleAt) + 1_000,
    ).toISOString();
    tamperedRequest.observation.staleAt = tamperedStaleAt;
    tamperedRequest.observation.providerSelections[0]!.staleAt = tamperedStaleAt;
    await assert.rejects(
      () => manifest.persistPreparedOperation({
        attemptId: manifestClaim.attemptId,
        claimToken: manifestClaim.claimToken,
        preparedAt: new Date(operationBase.getTime() + 76_100),
        summary: activation.summary,
        operation: {
          ...activation.operation,
          canonicalRequestBody: canonicalJson(tamperedRequest),
        },
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_OPERATION_CONFLICT",
    );
    const manifestOperation = await manifest.persistPreparedOperation({
      attemptId: manifestClaim.attemptId,
      claimToken: manifestClaim.claimToken,
      preparedAt: new Date(operationBase.getTime() + 76_200),
      summary: activation.summary,
      operation: activation.operation,
    });
    assert.equal(manifestOperation?.state, "pending");
    assert.equal(await manifest.markOperationSent({
      attemptId: manifestClaim.attemptId,
      operationId: activation.operation.operationId,
      claimToken: manifestClaim.claimToken,
      sentAt: new Date(operationBase.getTime() + 76_500),
    }), true);
    assert.equal(await manifest.acknowledgeOperation({
      attemptId: manifestClaim.attemptId,
      operationId: activation.operation.operationId,
      claimToken: manifestClaim.claimToken,
      acknowledgedAt: new Date(operationBase.getTime() + 78_000),
      evidence: activation.evidence,
    }), false);
    const recoveredManifest = await manifest.claim({
      workerId: "manifest-status-first-restart",
      now: new Date(operationBase.getTime() + 78_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 140_000),
    });
    assert.ok(recoveredManifest);
    assert.equal((await manifest.firstUnacknowledgedOperation({
      attemptId: recoveredManifest.attemptId,
      claimToken: recoveredManifest.claimToken,
      now: new Date(operationBase.getTime() + 78_100),
    }))?.state, "sent");
    assert.equal(await manifest.acknowledgeOperation({
      attemptId: recoveredManifest.attemptId,
      operationId: activation.operation.operationId,
      claimToken: recoveredManifest.claimToken,
      acknowledgedAt: new Date(operationBase.getTime() + 79_000),
      evidence: activation.evidence,
    }), true);
    assert.equal(await manifest.complete({
      attemptId: recoveredManifest.attemptId,
      claimToken: recoveredManifest.claimToken,
      outcome: "activated",
      completedAt: new Date(operationBase.getTime() + 79_500),
    }), true);
    const activeHealth = await manifest.loadHealth({
      now: new Date(operationBase.getTime() + 79_600),
    });
    assert.equal(activeHealth.activeGeneration, 1n);
    assert.equal(
      activeHealth.activePublicReleaseId,
      activation.manifest.publicReleaseId,
    );
    assert.equal(await harness.client.manifest_active_provider_selections.count({
      where: { organization_id: scopeOrganizationId },
    }), 1);
    const activeReadiness = await providerReadiness.load();
    assert.equal(
      activeReadiness.confirmedWatermark,
      publication.checkpoint.settledSequence,
    );
    assert.equal(
      activeReadiness.activationConfirmedWatermark,
      publication.checkpoint.settledSequence,
      "provider activation readiness advances with its manifest selection",
    );
    await assert.rejects(
      () => seedPromotionV2AuthoritativeConfiguration(
        harness,
        scopeOrganizationId,
        ["beta"],
        new Date(operationBase.getTime() + 79_700),
        2,
      ),
      (error) => error instanceof
          ApprovedPublicCatalogConfigurationPersistenceError &&
        error.code === "PUBLIC_CONFIGURATION_PROMOTION_RECOVERY_REQUIRED",
    );

    const reuse = await providerPublicationFixture({
      sequence: 20n,
      classification: "reuse",
      predecessor: completedExpectedHead(publication),
      immutableProof: publication.summary.immutableProof,
    });
    await provider.enqueueEvaluation({
      checkpoint: reuse.checkpoint,
      requestedAt: new Date(operationBase.getTime() + 80_000),
    });
    const reuseClaim = await provider.claim({
      workerId: "provider-reuse",
      now: new Date(operationBase.getTime() + 80_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 140_000),
    });
    assert.ok(reuseClaim);
    await provider.persistPreparedOperations({
      attemptId: reuseClaim.attemptId,
      claimToken: reuseClaim.claimToken,
      preparedAt: new Date(operationBase.getTime() + 81_000),
      summary: reuse.summary,
      operations: reuse.operations,
    });
    assert.equal(await provider.markOperationSent({
      attemptId: reuseClaim.attemptId,
      operationId: reuse.operations[0]!.operationId,
      claimToken: reuseClaim.claimToken,
      sentAt: new Date(operationBase.getTime() + 82_000),
    }), true);
    assert.equal(await provider.acknowledgeOperation({
      attemptId: reuseClaim.attemptId,
      operationId: reuse.operations[0]!.operationId,
      claimToken: reuseClaim.claimToken,
      acknowledgedAt: new Date(operationBase.getTime() + 83_000),
      evidence: reuse.evidence[0]!,
    }), true);
    assert.equal(await provider.complete({
      attemptId: reuseClaim.attemptId,
      claimToken: reuseClaim.claimToken,
      outcome: "reused",
      completedAt: new Date(operationBase.getTime() + 84_000),
    }), true);
    const reusedHead = await provider.loadCompletedHead();
    assert.ok(reusedHead);
    assert.equal(reusedHead.targetCheckpoint, 20n);
    assert.equal(reusedHead.terminalOperationKind, "confirmReuse");
    assert.equal(reusedHead.publishArtifactAttemptId, recovered.attemptId);
    assert.equal((await provider.loadReleaseArtifact({
      publicProviderReleaseId: publication.summary.publicProviderReleaseId,
    }))?.operations.length, 3);

    const casClaim = await manifest.claim({
      workerId: "manifest-cas",
      now: new Date(operationBase.getTime() + 85_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 145_000),
    });
    assert.ok(casClaim);
    assert.equal(casClaim.evaluationSequence, 2n);
    const refresh = manifestRefreshFixture({
      publication: reuse,
      manifest: activation.manifest,
      activeState: activation.activeState,
      organizationId: scopeOrganizationId,
      evaluationSequence: casClaim.evaluationSequence,
      publishArtifactAttemptId: recovered.attemptId,
      operationTag: "reuse-20",
    });
    await harness.client.manifest_promotion_attempts.update({
      where: { id: casClaim.attemptId },
      data: {
        evaluation_snapshot_body: refresh.snapshotBody,
        evaluation_snapshot_sha256: refresh.snapshotSha256,
      },
    });
    await manifest.persistPreparedOperation({
      attemptId: casClaim.attemptId,
      claimToken: casClaim.claimToken,
      preparedAt: new Date(operationBase.getTime() + 86_000),
      summary: refresh.summary,
      operation: refresh.operation,
    });
    const activeStateEvidence = await manifestActiveStateEvidence({
      state: activation.activeState,
      operationTag: "cas-20",
    });
    const canonicalCasErrorBody = canonicalJson({
      error: "Manifest state changed.",
      code: "CATALOG_MANIFEST_STATE_CONFLICT",
    });
    await assert.rejects(
      () => manifest.recordCasLoss({
        attemptId: casClaim.attemptId,
        claimToken: casClaim.claimToken,
        canonicalErrorBody: canonicalCasErrorBody,
        observedAt: new Date(operationBase.getTime() + 87_000),
        activeStateEvidence,
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_STATE_CONFLICT",
    );
    await manifest.markOperationSent({
      attemptId: casClaim.attemptId,
      operationId: refresh.operation.operationId,
      claimToken: casClaim.claimToken,
      sentAt: new Date(operationBase.getTime() + 87_000),
    });
    assert.equal(await manifest.deferCasLoss({
      attemptId: casClaim.attemptId,
      claimToken: casClaim.claimToken,
      canonicalErrorBody: canonicalCasErrorBody,
      observedAt: new Date(operationBase.getTime() + 87_250),
      retryAt: new Date(operationBase.getTime() + 87_750),
    }), true);
    assert.equal(await manifest.claim({
      workerId: "manifest-cas-probe-too-early",
      now: new Date(operationBase.getTime() + 87_500),
      leaseExpiresAt: new Date(operationBase.getTime() + 147_500),
    }), null);
    const pendingCasClaim = await manifest.claim({
      workerId: "manifest-cas-probe-recovery",
      now: new Date(operationBase.getTime() + 87_750),
      leaseExpiresAt: new Date(operationBase.getTime() + 147_750),
    });
    assert.ok(pendingCasClaim);
    assert.deepEqual(pendingCasClaim.pendingCasLoss, {
      failureCode: "CATALOG_MANIFEST_STATE_CONFLICT",
      canonicalErrorBody: canonicalCasErrorBody,
    });
    const pendingCasOperations = await manifest.listOperations({
      attemptId: pendingCasClaim.attemptId,
    });
    assert.equal(pendingCasOperations.length, 1);
    assert.equal(pendingCasOperations[0]!.state, "sent");
    assert.equal(pendingCasOperations[0]!.sendCount, 1);
    const activeSelection = await harness.client
      .manifest_active_provider_selections.findFirstOrThrow({
        where: { organization_id: scopeOrganizationId },
        select: { selection_body: true },
      });
    await harness.client.manifest_active_provider_selections.updateMany({
      where: { organization_id: scopeOrganizationId },
      data: { selection_sha256: "f".repeat(64) },
    });
    await assert.rejects(
      () => manifest.acknowledgeActiveState({
        attemptId: pendingCasClaim.attemptId,
        claimToken: pendingCasClaim.claimToken,
        reconciledAt: new Date(operationBase.getTime() + 87_400),
        evidence: activeStateEvidence,
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_ACTIVE_STATE_UNPROVEN",
    );
    await assert.rejects(
      () => manifest.recordCasLoss({
        attemptId: pendingCasClaim.attemptId,
        claimToken: pendingCasClaim.claimToken,
        canonicalErrorBody: canonicalCasErrorBody,
        observedAt: new Date(operationBase.getTime() + 87_500),
        activeStateEvidence,
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_ACTIVE_STATE_UNPROVEN",
    );
    await harness.client.manifest_active_provider_selections.updateMany({
      where: { organization_id: scopeOrganizationId },
      data: {
        selection_sha256: promotionV2Sha256(activeSelection.selection_body),
      },
    });
    assert.deepEqual(await manifest.recordCasLoss({
      attemptId: pendingCasClaim.attemptId,
      claimToken: pendingCasClaim.claimToken,
      canonicalErrorBody: canonicalCasErrorBody,
      observedAt: new Date(operationBase.getTime() + 88_000),
      activeStateEvidence,
    }), { evaluationSequence: 3n });
    assert.equal((await manifest.listOperations({
      attemptId: pendingCasClaim.attemptId,
    }))[0]!.sendCount, 1);
    let manifestHealth = await manifest.loadHealth({
      now: new Date(operationBase.getTime() + 89_000),
    });
    assert.equal(manifestHealth.confirmedEvaluationSequence, 1n);
    assert.equal(manifestHealth.requestedEvaluationSequence, 3n);
    const casSuccessor = await manifest.claim({
      workerId: "manifest-cas-successor",
      now: new Date(operationBase.getTime() + 89_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 149_000),
    });
    assert.ok(casSuccessor);
    const successorRefresh = manifestRefreshFixture({
      publication: reuse,
      manifest: activation.manifest,
      activeState: activation.activeState,
      organizationId: scopeOrganizationId,
      evaluationSequence: casSuccessor.evaluationSequence,
      publishArtifactAttemptId: recovered.attemptId,
      operationTag: "reuse-20-successor",
    });
    await harness.client.manifest_promotion_attempts.update({
      where: { id: casSuccessor.attemptId },
      data: {
        evaluation_snapshot_body: successorRefresh.snapshotBody,
        evaluation_snapshot_sha256: successorRefresh.snapshotSha256,
      },
    });
    await manifest.persistPreparedOperation({
      attemptId: casSuccessor.attemptId,
      claimToken: casSuccessor.claimToken,
      preparedAt: new Date(operationBase.getTime() + 90_000),
      summary: {
        ...successorRefresh.summary,
        operationKind: "no_change",
      },
      operation: null,
    });
    assert.equal(await manifest.complete({
      attemptId: casSuccessor.attemptId,
      claimToken: casSuccessor.claimToken,
      outcome: "no_change",
      completedAt: new Date(operationBase.getTime() + 91_000),
    }), true);
    manifestHealth = await manifest.loadHealth({
      now: new Date(operationBase.getTime() + 92_000),
    });
    assert.equal(manifestHealth.confirmedEvaluationSequence, 3n);

    const reconciliation = await providerPublicationFixture({
      sequence: 30n,
      classification: "reuse",
      predecessor: completedExpectedHead(reuse),
      immutableProof: publication.summary.immutableProof,
    });
    await provider.enqueueEvaluation({
      checkpoint: reconciliation.checkpoint,
      requestedAt: new Date(operationBase.getTime() + 90_000),
    });
    const reconciliationClaim = await provider.claim({
      workerId: "provider-reconcile",
      now: new Date(operationBase.getTime() + 90_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 150_000),
    });
    assert.ok(reconciliationClaim);
    await provider.persistPreparedOperations({
      attemptId: reconciliationClaim.attemptId,
      claimToken: reconciliationClaim.claimToken,
      preparedAt: new Date(operationBase.getTime() + 91_000),
      summary: reconciliation.summary,
      operations: reconciliation.operations,
    });
    await provider.markOperationSent({
      attemptId: reconciliationClaim.attemptId,
      operationId: reconciliation.operations[0]!.operationId,
      claimToken: reconciliationClaim.claimToken,
      sentAt: new Date(operationBase.getTime() + 92_000),
    });
    assert.deepEqual(await provider.recordReconciliationLoss({
      attemptId: reconciliationClaim.attemptId,
      claimToken: reconciliationClaim.claimToken,
      failureCode: "PROVIDER_RELEASE_STATE_CONFLICT",
      canonicalErrorBody: canonicalJson({
        error: "Provider state changed.",
        code: "PROVIDER_RELEASE_STATE_CONFLICT",
      }),
      observedAt: new Date(operationBase.getTime() + 93_000),
    }), { evaluationSequence: 4n });
    const lostHealth = await provider.loadHealth({
      now: new Date(operationBase.getTime() + 94_000),
    });
    assert.equal(lostHealth.confirmedEvaluationSequence, 2n);
    assert.equal(lostHealth.requestedEvaluationSequence, 4n);
    const successor = await provider.claim({
      workerId: "provider-reconcile-successor",
      now: new Date(operationBase.getTime() + 94_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 154_000),
    });
    assert.ok(successor);
    assert.equal(successor.evaluationSequence, 4n);
    const successorFixture = await providerPublicationFixture({
      sequence: 30n,
      classification: "reuse",
      predecessor: completedExpectedHead(reuse),
      immutableProof: publication.summary.immutableProof,
      operationTag: "30-reconciled",
    });
    await provider.persistPreparedOperations({
      attemptId: successor.attemptId,
      claimToken: successor.claimToken,
      preparedAt: new Date(operationBase.getTime() + 95_000),
      summary: successorFixture.summary,
      operations: successorFixture.operations,
    });
    await provider.markOperationSent({
      attemptId: successor.attemptId,
      operationId: successorFixture.operations[0]!.operationId,
      claimToken: successor.claimToken,
      sentAt: new Date(operationBase.getTime() + 96_000),
    });
    await provider.acknowledgeOperation({
      attemptId: successor.attemptId,
      operationId: successorFixture.operations[0]!.operationId,
      claimToken: successor.claimToken,
      acknowledgedAt: new Date(operationBase.getTime() + 97_000),
      evidence: successorFixture.evidence[0]!,
    });
    assert.equal(await provider.complete({
      attemptId: successor.attemptId,
      claimToken: successor.claimToken,
      outcome: "reused",
      completedAt: new Date(operationBase.getTime() + 98_000),
    }), true);
    const recoveredHealth = await provider.loadHealth({
      now: new Date(operationBase.getTime() + 99_000),
    });
    assert.equal(recoveredHealth.confirmedEvaluationSequence, 4n);
    assert.equal(recoveredHealth.completedCheckpoint, 30n);
    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "configuration_settled",
      causeIdentity: "omit-alpha-before-configuration-removal",
      requestedAt: new Date(operationBase.getTime() + 100_000),
    }), { evaluationSequence: 5n, result: "created" });
    const omissionClaim = await manifest.claim({
      workerId: "manifest-omission-proof",
      now: new Date(operationBase.getTime() + 100_000),
      leaseExpiresAt: new Date(operationBase.getTime() + 160_000),
    });
    assert.ok(omissionClaim);
    const manifestBeforeOmission = await manifest.loadHealth({
      now: new Date(operationBase.getTime() + 100_500),
    });
    const clearEvidence = await manifestActiveStateEvidence({
      state: {
        generation: Number(manifestBeforeOmission.activeGeneration + 1n),
        activeManifest: null,
        previousManifest: null,
        observation: null,
        terminalReceiptSha256: "9".repeat(64),
      },
      operationTag: "omission-before-remove-alpha",
    });
    assert.equal(await manifest.acknowledgeActiveState({
      attemptId: omissionClaim.attemptId,
      claimToken: omissionClaim.claimToken,
      reconciledAt: new Date(operationBase.getTime() + 101_000),
      evidence: clearEvidence,
    }), true);
    assert.equal(await harness.client.manifest_active_provider_selections.count({
      where: { organization_id: scopeOrganizationId },
    }), 0);
    await seedPromotionV2AuthoritativeConfiguration(
      harness,
      scopeOrganizationId,
      ["beta"],
      new Date(operationBase.getTime() + 102_000),
      2,
    );
    assert.equal((await harness.client.manifest_promotion_attempts.findUniqueOrThrow({
      where: { id: omissionClaim.attemptId },
    })).state, "superseded");
    assert.equal(await harness.client.manifest_promotion_evaluations.count({
      where: { organization_id: scopeOrganizationId },
    }), 5);
    assert.equal(await harness.client.manifest_promotion_evaluations.count({
      where: { organization_id: otherOrganizationId },
    }), 0);
  } finally {
    await harness.close();
  }
});

test("manifest terminal failure remains unconfirmed until a distinct successful evaluation", async () => {
  const harness = await createMigratedTestDatabase();
  const scopeOrganizationId = "5a000000-0000-4000-8000-000000000020";
  const base = new Date("2026-08-16T14:00:00.000Z");
  const emptyState = {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  } as const;
  const emptyStateBody = canonicalJson(emptyState);
  try {
    await harness.client.organizations.create({
      data: {
        id: scopeOrganizationId,
        slug: "manifest-terminal-failure",
        name: "Manifest Terminal Failure",
      },
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, scopeOrganizationId, ["alpha"], base,
    );
    const manifest = new PrismaManifestPromotionRepository(harness.client, {
      organizationId: scopeOrganizationId,
      deploymentKey,
    });
    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "failed-evaluation-1",
      requestedAt: base,
    }), { evaluationSequence: 1n, result: "created" });
    await seedPromotionV2VerifiedEmptyBootstrap(
      harness, scopeOrganizationId, deploymentKey, ["alpha"], base,
    );
    const failed = await manifest.claim({
      workerId: "manifest-fails",
      now: base,
      leaseExpiresAt: new Date(base.getTime() + 60_000),
    });
    assert.ok(failed);
    assert.equal(await manifest.complete({
      attemptId: failed.attemptId,
      claimToken: failed.claimToken,
      outcome: "failed",
      failureClass: "reconciliation",
      failureCode: "CATALOG_MANIFEST_STATE_CONFLICT",
      completedAt: new Date(base.getTime() + 1_000),
    }), true);
    let health = await manifest.loadHealth({
      now: new Date(base.getTime() + 2_000),
    });
    assert.equal(health.requestedEvaluationSequence, 1n);
    assert.equal(health.confirmedEvaluationSequence, 0n);
    assert.equal(await manifest.claim({
      workerId: "manifest-identical-idle",
      now: new Date(base.getTime() + 2_000),
      leaseExpiresAt: new Date(base.getTime() + 62_000),
    }), null);
    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "failed-evaluation-1",
      requestedAt: new Date(base.getTime() + 3_000),
    }), { evaluationSequence: 1n, result: "coalesced" });
    assert.equal(await manifest.claim({
      workerId: "manifest-coalesced-idle",
      now: new Date(base.getTime() + 3_000),
      leaseExpiresAt: new Date(base.getTime() + 63_000),
    }), null);
    const readinessAfterRestart = await new PrismaPromotionReadinessRepository(
      harness.client,
      { organizationId: scopeOrganizationId, deploymentKey, lane: "manifest" },
    ).load();
    assert.equal(readinessAfterRestart.latestFailedAttemptId, failed.attemptId);
    assert.equal(readinessAfterRestart.latestFailedWatermark, 1n);
    assert.equal(readinessAfterRestart.confirmedWatermark, 0n);

    assert.deepEqual(await manifest.enqueueEvaluation({
      cause: "observation_succeeded",
      causeIdentity: "successful-evaluation-2",
      requestedAt: new Date(base.getTime() + 4_000),
    }), { evaluationSequence: 2n, result: "created" });
    const successor = await manifest.claim({
      workerId: "manifest-successor",
      now: new Date(base.getTime() + 4_000),
      leaseExpiresAt: new Date(base.getTime() + 64_000),
    });
    assert.ok(successor);
    const snapshot = canonicalJson({
      schemaVersion: 1,
      evaluationSequence: "2",
      eligibility: {
        organizationId: scopeOrganizationId,
        sharedConfigurationEpoch: {
          configurationKey: "catalog-v1",
          revision: 1,
          publicChangeSequence: "1",
          configurationHash: "a".repeat(64),
        },
        confidencePolicyVersion: "confidence-v1",
        staleAfterSeconds: 900,
        configuredPlatformKeys: ["alpha"],
        enabledPlatformKeys: [],
        lifecycleDecisionSequence: "1",
        checkpointDigests: [],
      },
      providerFacts: [],
      activeStateBody: emptyStateBody,
      activeStateSha256: promotionV2Sha256(emptyStateBody),
    });
    const snapshotSha256 = promotionV2Sha256(snapshot);
    await harness.client.manifest_promotion_attempts.update({
      where: { id: successor.attemptId },
      data: {
        evaluation_snapshot_body: snapshot,
        evaluation_snapshot_sha256: snapshotSha256,
      },
    });
    assert.equal(await manifest.persistPreparedOperation({
      attemptId: successor.attemptId,
      claimToken: successor.claimToken,
      preparedAt: new Date(base.getTime() + 5_000),
      summary: {
        operationKind: "no_change",
        evaluationSnapshotSha256: snapshotSha256,
        expectedActiveState: emptyState,
        sharedConfigurationEpoch: {
          configurationKey: "catalog-v1",
          revision: 1,
          publicChangeSequence: "1",
          configurationHash: "a".repeat(64),
        },
        enabledPlatformKeys: [],
        providerSelections: [],
        manifestIdentity: null,
      },
      operation: null,
    }), null);
    assert.equal(await manifest.complete({
      attemptId: successor.attemptId,
      claimToken: successor.claimToken,
      outcome: "no_change",
      completedAt: new Date(base.getTime() + 6_000),
    }), true);
    health = await manifest.loadHealth({
      now: new Date(base.getTime() + 7_000),
    });
    assert.equal(health.confirmedEvaluationSequence, 2n);
    const readinessRecovered = await new PrismaPromotionReadinessRepository(
      harness.client,
      { organizationId: scopeOrganizationId, deploymentKey, lane: "manifest" },
    ).load();
    assert.equal(readinessRecovered.latestFailedWatermark, 1n);
    assert.equal(readinessRecovered.confirmedWatermark, 2n);
  } finally {
    await harness.close();
  }
});

test("bootstrap definition selection accepts reactivation of one immutable manifest and rejects substituted bytes", async () => {
  const publication = await providerPublicationFixture();
  const activation = await manifestActivationFixture({
    publication,
    organizationId,
    evaluationSequence: 1n,
    publishArtifactAttemptId: "5a000000-0000-4000-8000-000000000088",
  });
  assert.ok(activation.activeState.activeManifest);
  const reactivation = JSON.parse(
    activation.operation.canonicalRequestBody,
  ) as Record<string, unknown> & {
    manifest: Record<string, unknown>;
  };
  reactivation.operationId = "manifest:activate:reactivated";
  reactivation.idempotencyKey = "manifest:activate:reactivated";
  reactivation.expectedActiveState = {
    generation: 2,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: "f".repeat(64),
  };
  const reactivationBody = canonicalJson(reactivation);
  assert.equal(selectManifestDefinitionRequestBody({
    activeManifest: activation.activeState.activeManifest,
    terminalRequestBody: reactivationBody,
    definitionRequestBodies: [
      activation.operation.canonicalRequestBody,
      reactivationBody,
    ],
  }), reactivationBody);
  const substituted = canonicalJson({
    ...reactivation,
    manifest: {
      ...reactivation.manifest,
      confidencePolicyVersion: "substituted-policy",
    },
  });
  assert.equal(selectManifestDefinitionRequestBody({
    activeManifest: activation.activeState.activeManifest,
    terminalRequestBody: reactivationBody,
    definitionRequestBodies: [activation.operation.canonicalRequestBody, substituted],
  }), null);
});
