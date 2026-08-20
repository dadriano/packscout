import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  CATALOG_RETENTION_SCHEMA_VERSION,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestReceiptDigest,
  catalogManifestTerminalReceiptSha256,
  catalogRetentionManifestReceiptSchema,
  catalogRetentionManifestRequestSchema,
  catalogRetentionProviderReceiptSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionReceiptDigest,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseCompletedHeadResultV1Schema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseStartRequestSchema,
  type CatalogManifestBlockReceipt,
  type CatalogRetentionManifestRequest,
  type CatalogRetentionProviderRequest,
  type CatalogRetentionProtectionSet,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  serializeHeatManifestSourceProof,
  type ActiveCatalogHeatManifest,
} from "./active-catalog-heat-manifest.ts";
import { PrismaCatalogPromotionRetentionRepository } from
  "./catalog-promotion-retention-repository.ts";
import {
  CatalogPromotionRetentionPersistenceError,
} from "./catalog-promotion-retention-types.ts";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import {
  providerPromotionPreparedSummaryBody,
} from "./provider-promotion-repository-validation.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  completedExpectedHead,
  manifestActivationFixture,
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
  seedPromotionV2VerifiedEmptyBootstrap,
  type ManifestActivationFixture,
  type ProviderPublicationFixture,
} from "./promotion-v2-test-fixtures.ts";
import {
  promotionV2Sha256,
  providerCheckpointIdentityBody,
} from "./promotion-v2-types.ts";
import {
  createMigratedTestDatabase,
  type MigratedTestDatabase,
} from "./test-support.ts";

const deploymentKey = "catalog-retention-test";
const platformKey = "alpha";
const startedAt = new Date("2026-08-16T12:00:00.000Z");
const SHA_F = "f".repeat(64);

function at(milliseconds: number): Date {
  return new Date(startedAt.getTime() + milliseconds);
}

async function seedScope(
  harness: MigratedTestDatabase,
  organizationId: string,
  slug: string,
) {
  await harness.client.organizations.create({
    data: { id: organizationId, slug, name: slug },
  });
  await seedPromotionV2AuthoritativeConfiguration(
    harness, organizationId, [platformKey], startedAt,
  );
  await seedPromotionV2VerifiedEmptyBootstrap(
    harness, organizationId, deploymentKey, [platformKey], startedAt,
  );
}

async function publishProvider(
  harness: MigratedTestDatabase,
  organizationId: string,
  publication: ProviderPublicationFixture,
  offset: number,
) {
  const repository = new PrismaProviderPromotionRepository(harness.client, {
    organizationId, deploymentKey, platformKey,
  });
  await repository.enqueueEvaluation({
    checkpoint: publication.checkpoint,
    requestedAt: at(offset),
  });
  const claim = await repository.claim({
    workerId: `provider-${offset}`,
    now: at(offset),
    leaseExpiresAt: at(offset + 60_000),
  });
  assert.ok(claim);
  await repository.persistPreparedOperations({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: at(offset + 1),
    summary: publication.summary,
    operations: publication.operations,
  });
  for (const [index, operation] of publication.operations.entries()) {
    assert.equal(await repository.markOperationSent({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      sentAt: at(offset + 10 + index * 2),
    }), true);
    assert.equal(await repository.acknowledgeOperation({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      acknowledgedAt: at(offset + 11 + index * 2),
      evidence: publication.evidence[index]!,
    }), true);
  }
  assert.equal(await repository.complete({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    outcome: publication.summary.classification === "publish"
      ? "published" : "reused",
    completedAt: at(offset + 100),
  }), true);
  return { repository, attemptId: claim.attemptId };
}

async function bindCurrentBootstrapProviderReference(
  harness: MigratedTestDatabase,
  organizationId: string,
  activePublication: ProviderPublicationFixture,
  activePublishArtifactAttemptId: string,
  localPublication: ProviderPublicationFixture,
  localCompletedAttemptId: string,
) {
  const activeTerminal = await harness.client.provider_promotion_operations
    .findFirstOrThrow({
      where: {
        attempt_id: activePublishArtifactAttemptId,
        operation_kind: "finalize",
      },
    });
  const localTerminal = await harness.client.provider_promotion_operations
    .findFirstOrThrow({
      where: {
        attempt_id: localCompletedAttemptId,
        operation_kind: "finalize",
      },
    });
  assert.ok(
    activeTerminal.canonical_receipt_body && activeTerminal.receipt_sha256,
  );
  assert.ok(localTerminal.receipt_sha256);
  const lane = await harness.client.manifest_promotion_lanes.findUniqueOrThrow({
    where: {
      organization_id_deployment_key: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
      },
    },
    select: { current_bootstrap_proof_revision: true },
  });
  const currentRevision = lane.current_bootstrap_proof_revision!;
  const nextRevision = currentRevision + 1n;
  await harness.client.$transaction(async (transaction) => {
    assert.equal(await transaction.$executeRaw(Prisma.sql`
      insert into public.catalog_promotion_bootstrap_proofs (
        organization_id, deployment_key, proof_revision, proof_kind,
        active_state_request_body, active_state_request_sha256,
        active_state_receipt_body, active_state_receipt_sha256,
        active_state_response_body, active_state_response_sha256,
        manifest_definition_request_body,
        manifest_definition_request_sha256,
        manifest_terminal_request_body, manifest_terminal_request_sha256,
        manifest_receipt_body, manifest_receipt_sha256,
        manifest_response_body, manifest_response_sha256,
        active_state_body, active_state_sha256, verified_at
      )
      select organization_id, deployment_key, ${nextRevision}, proof_kind,
             active_state_request_body, active_state_request_sha256,
             active_state_receipt_body, active_state_receipt_sha256,
             active_state_response_body, active_state_response_sha256,
             manifest_definition_request_body,
             manifest_definition_request_sha256,
             manifest_terminal_request_body, manifest_terminal_request_sha256,
             manifest_receipt_body, manifest_receipt_sha256,
             manifest_response_body, manifest_response_sha256,
             active_state_body, active_state_sha256, verified_at
      from public.catalog_promotion_bootstrap_proofs
      where organization_id = ${organizationId}::uuid
        and deployment_key = ${deploymentKey}
        and proof_revision = ${currentRevision}
    `), 1);
    assert.equal(await transaction.$executeRaw(Prisma.sql`
      insert into public.catalog_promotion_bootstrap_provider_proofs (
        organization_id, deployment_key, proof_revision, platform_key, ordinal,
        public_provider_release_id, provider_release_fingerprint,
        provider_terminal_operation_id, provider_terminal_receipt_body,
        provider_terminal_receipt_sha256, provider_terminal_response_body,
        provider_terminal_response_sha256, publish_artifact_attempt_id,
        completed_head_request_body, completed_head_request_sha256,
        completed_head_receipt_body, completed_head_receipt_sha256,
        completed_head_response_body, completed_head_response_sha256,
        remote_completed_head_body, remote_completed_head_sha256,
        local_completed_attempt_id, local_completed_public_provider_release_id,
        local_completed_provider_release_fingerprint,
        local_completed_terminal_receipt_sha256
      )
      select organization_id, deployment_key, ${nextRevision}, platform_key,
             ordinal,
             ${activePublication.summary.publicProviderReleaseId}::uuid,
             ${activePublication.summary.providerReleaseFingerprint},
             ${activeTerminal.operation_id},
             ${activeTerminal.canonical_receipt_body},
             ${activeTerminal.receipt_sha256},
             ${activeTerminal.exact_response_body},
             ${activeTerminal.response_sha256},
             ${activePublishArtifactAttemptId}::uuid,
             completed_head_request_body, completed_head_request_sha256,
             completed_head_receipt_body, completed_head_receipt_sha256,
             completed_head_response_body, completed_head_response_sha256,
             remote_completed_head_body, remote_completed_head_sha256,
             ${localCompletedAttemptId}::uuid,
             ${localPublication.summary.publicProviderReleaseId}::uuid,
             ${localPublication.summary.providerReleaseFingerprint},
             ${localTerminal.receipt_sha256}
      from public.catalog_promotion_bootstrap_provider_proofs
      where organization_id = ${organizationId}::uuid
        and deployment_key = ${deploymentKey}
        and proof_revision = ${currentRevision}
        and platform_key = ${platformKey}
    `), 1);
    assert.equal(await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set current_bootstrap_proof_revision = ${nextRevision}
      where organization_id = ${organizationId}::uuid
        and deployment_key = ${deploymentKey}
        and current_bootstrap_proof_revision = ${currentRevision}
    `), 1);
  });
}

async function activateManifest(
  harness: MigratedTestDatabase,
  organizationId: string,
  publication: ProviderPublicationFixture,
  publishArtifactAttemptId: string,
  offset: number,
): Promise<ManifestActivationFixture> {
  const repository = new PrismaManifestPromotionRepository(harness.client, {
    organizationId, deploymentKey,
  });
  const claim = await repository.claim({
    workerId: `manifest-${offset}`,
    now: at(offset),
    leaseExpiresAt: at(offset + 60_000),
  });
  assert.ok(claim);
  const activation = await manifestActivationFixture({
    publication,
    organizationId,
    evaluationSequence: claim.evaluationSequence,
    publishArtifactAttemptId,
    operationTag: String(offset),
  });
  await harness.client.manifest_promotion_attempts.update({
    where: { id: claim.attemptId },
    data: {
      evaluation_snapshot_body: activation.snapshotBody,
      evaluation_snapshot_sha256: activation.snapshotSha256,
    },
  });
  await repository.persistPreparedOperation({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: at(offset + 1),
    summary: activation.summary,
    operation: activation.operation,
  });
  await repository.markOperationSent({
    attemptId: claim.attemptId,
    operationId: activation.operation.operationId,
    claimToken: claim.claimToken,
    sentAt: at(offset + 2),
  });
  await repository.acknowledgeOperation({
    attemptId: claim.attemptId,
    operationId: activation.operation.operationId,
    claimToken: claim.claimToken,
    acknowledgedAt: at(offset + 3),
    evidence: activation.evidence,
  });
  await repository.complete({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    outcome: "activated",
    completedAt: at(offset + 4),
  });
  return activation;
}

async function blockManifestForRecovery(
  harness: MigratedTestDatabase,
  organizationId: string,
  publication: ProviderPublicationFixture,
  publishArtifactAttemptId: string,
  operationAt: Date,
  operationTag = "block-recovery",
) {
  const repository = new PrismaManifestPromotionRepository(harness.client, {
    organizationId, deploymentKey,
  });
  const claim = await repository.claim({
    workerId: "manifest-block-recovery",
    now: operationAt,
    leaseExpiresAt: new Date(operationAt.getTime() + 60_000),
  });
  assert.ok(claim);
  const activation = await manifestActivationFixture({
    publication,
    organizationId,
    evaluationSequence: claim.evaluationSequence,
    publishArtifactAttemptId,
    operationTag,
  });
  const manifest = activation.summary.manifestIdentity;
  assert.ok(manifest);
  await harness.client.manifest_promotion_attempts.update({
    where: { id: claim.attemptId },
    data: {
      evaluation_snapshot_body: activation.snapshotBody,
      evaluation_snapshot_sha256: activation.snapshotSha256,
    },
  });
  const operationId = `manifest:block:${manifest.publicReleaseId}:${operationTag}`;
  const request = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    blockSequence: "1",
    reason: "MANIFEST_SECURITY_INVALID",
  } as const;
  const canonicalRequestBody = canonicalJson(request);
  const operation = {
    operationIndex: 0,
    operationId,
    operationKind: "block" as const,
    requestPath: PRODUCTION_CATALOG_MANIFEST_PATHS.block,
    canonicalRequestBody,
  };
  await repository.persistPreparedOperation({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: new Date(operationAt.getTime() + 1),
    summary: { ...activation.summary, operationKind: "block" },
    operation,
  });
  assert.equal(await repository.markOperationSent({
    attemptId: claim.attemptId,
    operationId,
    claimToken: claim.claimToken,
    sentAt: new Date(operationAt.getTime() + 2),
  }), true);
  const withoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "block" as const,
    operationId,
    idempotencyKey: operationId,
    publicReleaseId: request.publicReleaseId,
    manifestFingerprint: request.manifestFingerprint,
    terminalState: "blocked" as const,
    result: "blocked" as const,
    serverTime: new Date(operationAt.getTime() + 3).toISOString(),
    requestDigest: promotionV2Sha256(canonicalRequestBody),
    details: {
      blockSequence: request.blockSequence,
      reason: request.reason,
    },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
  } satisfies CatalogManifestBlockReceipt;
  assert.equal(await repository.acknowledgeOperation({
    attemptId: claim.attemptId,
    operationId,
    claimToken: claim.claimToken,
    acknowledgedAt: new Date(operationAt.getTime() + 3),
    evidence: { canonicalReceiptBody: canonicalJson(receipt) },
  }), true);
  assert.equal(await repository.complete({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    outcome: "blocked",
    completedAt: new Date(operationAt.getTime() + 4),
  }), true);
  return { attemptId: claim.attemptId, manifest };
}

function protectionSet(
  request: CatalogRetentionManifestRequest | CatalogRetentionProviderRequest,
  releases: CatalogRetentionProtectionSet["providerReleasesByPlatform"] = [{
    platformKey, releases: [],
  }],
): CatalogRetentionProtectionSet {
  return {
    authoritativeEvaluationTime: startedAt.toISOString(),
    postgresProofSnapshotId: request.postgresProof.snapshotId,
    postgresProofSnapshotSequence: request.postgresProof.snapshotSequence,
    postgresProofSnapshotDigest: request.postgresProof.snapshotDigest,
    manifests: [],
    providerReleasesByPlatform: releases,
  };
}

async function manifestEvidence(request: CatalogRetentionManifestRequest) {
  const withoutDigest = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationKind: "retainManifests" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    terminalState: "complete" as const,
    result: "retained" as const,
    serverTime: startedAt.toISOString(),
    requestDigest: await catalogRetentionPublicationRequestDigest(request),
    expectedRetentionGeneration: request.expectedRetentionGeneration,
    retentionGeneration: request.expectedRetentionGeneration + 1,
    phase: "manifests" as const,
    platformKey: null,
    details: {
      maximumDocuments: request.maximumDocuments,
      deletedDocumentCount: 0,
      deletedRetentionOperationCount: 0,
      hasMore: false,
      protectionSet: protectionSet(request),
      selectedManifest: null,
      deletedManifestCount: 0,
      deletedManifestReferenceCount: 0,
    },
  };
  const receipt = catalogRetentionManifestReceiptSchema.parse({
    ...withoutDigest,
    receiptDigest: await catalogRetentionReceiptDigest(withoutDigest),
  });
  return signedEvidence(receipt);
}

async function providerEvidence(
  request: CatalogRetentionProviderRequest,
  input: Readonly<{
    selected: Readonly<{
      platformKey: string;
      publicProviderReleaseId: string;
      providerReleaseFingerprint: string;
      lifecycle: "complete";
    }> | null;
    protectedReleases?: CatalogRetentionProtectionSet[
      "providerReleasesByPlatform"
    ];
  }>,
) {
  const selected = input.selected;
  const deleted = selected === null ? 0 : 1;
  const withoutDigest = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationKind: "retainProviderReleases" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    terminalState: "complete" as const,
    result: "retained" as const,
    serverTime: startedAt.toISOString(),
    requestDigest: await catalogRetentionPublicationRequestDigest(request),
    expectedRetentionGeneration: request.expectedRetentionGeneration,
    retentionGeneration: request.expectedRetentionGeneration + 1,
    phase: "provider_releases" as const,
    platformKey: request.platformKey,
    details: {
      maximumDocuments: request.maximumDocuments,
      deletedDocumentCount: deleted,
      deletedRetentionOperationCount: 0,
      hasMore: false,
      protectionSet: protectionSet(
        request, input.protectedReleases,
      ),
      manifestPhaseComplete: true as const,
      selectedProviderRelease: selected,
      deletedProviderReleaseCount: deleted,
      deletedProviderOwnedDocumentCount: deleted,
    },
  };
  const receipt = catalogRetentionProviderReceiptSchema.parse({
    ...withoutDigest,
    receiptDigest: await catalogRetentionReceiptDigest(withoutDigest),
  });
  return signedEvidence(receipt);
}

function signedEvidence(receipt: Readonly<{ receiptDigest: string }>) {
  return {
    canonicalReceiptBody: canonicalJson(receipt),
    exactResponseBody: JSON.stringify({
      responseAuth: {
        signatureVersion: "v1",
        keyId: "retention.v1",
        receiptDigest: receipt.receiptDigest,
        signature: SHA_F,
      },
      receipt,
      ok: true,
    }, null, 2),
  };
}

function manifestRequest(body: string): CatalogRetentionManifestRequest {
  return catalogRetentionManifestRequestSchema.parse(JSON.parse(body));
}

function providerRequest(body: string): CatalogRetentionProviderRequest {
  return catalogRetentionProviderRequestSchema.parse(JSON.parse(body));
}

test("concurrent barrier acquisition and operation preparation converge to one durable identity", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000000";
  try {
    await seedScope(harness, organizationId, "retention-race");
    const independent = await harness.createIndependentClient();
    const first = new PrismaCatalogPromotionRetentionRepository(
      harness.client, { organizationId, deploymentKey },
    );
    const second = new PrismaCatalogPromotionRetentionRepository(
      independent, { organizationId, deploymentKey },
    );

    const claims = await Promise.all([
      first.acquireBarrier(), second.acquireBarrier(),
    ]);
    assert.equal(claims[0].barrierToken, claims[1].barrierToken);
    assert.equal(claims[0].barrierGeneration, claims[1].barrierGeneration);
    assert.deepEqual(claims.map(({ resumed }) => resumed).sort(), [false, true]);

    const operations = await Promise.all([
      first.prepareOperation({
        barrierToken: claims[0].barrierToken,
        phase: "manifests",
        maximumDocuments: 90,
      }),
      second.prepareOperation({
        barrierToken: claims[1].barrierToken,
        phase: "manifests",
        maximumDocuments: 90,
      }),
    ]);
    assert.ok(operations[0] && operations[1]);
    assert.equal(operations[0].operationId, operations[1].operationId);
    assert.equal(
      operations[0].canonicalRequestBody,
      operations[1].canonicalRequestBody,
    );
    assert.equal(await harness.client.catalog_promotion_retention_operations.count({
      where: { organization_id: organizationId, deployment_key: deploymentKey },
    }), 1);

    const tamperedSnapshotBody = canonicalJson({
      ...claims[0].postgresProof,
      evaluatedAt: at(1).toISOString(),
    });
    await assert.rejects(() =>
      harness.client.catalog_promotion_retention_barriers.update({
        where: {
          organization_id_deployment_key: {
            organization_id: organizationId,
            deployment_key: deploymentKey,
          },
        },
        data: { snapshot_body: tamperedSnapshotBody },
      }), /active catalog retention barrier is immutable/u);
  } finally {
    await harness.close();
  }
});

test("only unresolved acknowledged provider work authorizes rollback recovery", async () => {
  const harness = await createMigratedTestDatabase();
  const recoveringOrganizationId =
    "95000000-0000-4000-8000-000000000022";
  const terminalOrganizationId =
    "95000000-0000-4000-8000-000000000023";
  try {
    await seedScope(
      harness, recoveringOrganizationId, "retention-provider-recovery",
    );
    const recoveringPublication = await providerPublicationFixture({
      operationTag: "recovering-provider",
    });
    const recoveringRepository = new PrismaProviderPromotionRepository(
      harness.client,
      { organizationId: recoveringOrganizationId, deploymentKey, platformKey },
    );
    await recoveringRepository.enqueueEvaluation({
      checkpoint: recoveringPublication.checkpoint,
      requestedAt: at(1_000),
    });
    const claim = await recoveringRepository.claim({
      workerId: "provider-recovery-proof",
      now: at(1_000),
      leaseExpiresAt: at(61_000),
    });
    assert.ok(claim);
    await recoveringRepository.persistPreparedOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      preparedAt: at(1_001),
      summary: recoveringPublication.summary,
      operations: recoveringPublication.operations,
    });
    for (const [index, operation] of
      recoveringPublication.operations.entries()) {
      assert.equal(await recoveringRepository.markOperationSent({
        attemptId: claim.attemptId,
        operationId: operation.operationId,
        claimToken: claim.claimToken,
        sentAt: at(1_010 + index * 2),
      }), true);
      assert.equal(await recoveringRepository.acknowledgeOperation({
        attemptId: claim.attemptId,
        operationId: operation.operationId,
        claimToken: claim.claimToken,
        acknowledgedAt: at(1_011 + index * 2),
        evidence: recoveringPublication.evidence[index]!,
      }), true);
    }

    const recoveringBarrier = await new
      PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId: recoveringOrganizationId, deploymentKey,
      }).acquireBarrier();
    const recoveringProtections = recoveringBarrier.postgresProof
      .providerProtectionsByPlatform.find(({ platformKey: key }) =>
        key === platformKey)?.releases ?? [];
    assert.deepEqual(recoveringProtections.map((protection) => ({
      publicProviderReleaseId: protection.release.publicProviderReleaseId,
      reason: protection.reason,
      operationKind: protection.operationProof.operationKind,
      operationState: protection.operationProof.operationState,
      canonicalRequestBody: protection.operationProof.canonicalRequestBody,
    })), [{
      publicProviderReleaseId:
        recoveringPublication.summary.publicProviderReleaseId,
      reason: "rollback_recovery",
      operationKind: "finalize",
      operationState: "acknowledged",
      canonicalRequestBody: null,
    }]);

    await seedScope(
      harness, terminalOrganizationId, "retention-provider-terminal",
    );
    const terminalPublication = await providerPublicationFixture({
      operationTag: "terminal-provider",
    });
    await publishProvider(
      harness, terminalOrganizationId, terminalPublication, 2_000,
    );
    const terminalBarrier = await new
      PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId: terminalOrganizationId, deploymentKey,
      }).acquireBarrier();
    assert.deepEqual(
      terminalBarrier.postgresProof.providerProtectionsByPlatform,
      [],
      "ordinary terminal publication is not an authorized recovery target",
    );
  } finally {
    await harness.close();
  }
});

test("current bootstrap provider references remain protected after head and manifest advance", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000032";
  try {
    await seedScope(
      harness,
      organizationId,
      "retention-current-bootstrap-provider",
    );
    const bootstrapPublication = await providerPublicationFixture({
      operationTag: "bootstrap-provider-root",
    });
    const bootstrapProvider = await publishProvider(
      harness,
      organizationId,
      bootstrapPublication,
      10_000,
    );
    const localProof: ProviderReleaseImmutableProofV1 = {
      ...bootstrapPublication.summary.immutableProof,
      publicProviderReleaseId: "61000000-0000-5000-8000-000000000032",
      providerReleaseFingerprint: "b".repeat(64),
      dataAsOf: at(20_000).toISOString(),
    };
    const localPublication = await providerPublicationFixture({
      sequence: 20n,
      predecessor: completedExpectedHead(bootstrapPublication),
      immutableProof: localProof,
      operationTag: "bootstrap-provider-local-head",
    });
    const localProvider = await publishProvider(
      harness,
      organizationId,
      localPublication,
      20_000,
    );
    await bindCurrentBootstrapProviderReference(
      harness,
      organizationId,
      bootstrapPublication,
      bootstrapProvider.attemptId,
      localPublication,
      localProvider.attemptId,
    );

    const successorProof: ProviderReleaseImmutableProofV1 = {
      ...localPublication.summary.immutableProof,
      publicProviderReleaseId: "61000000-0000-5000-8000-000000000033",
      providerReleaseFingerprint: "c".repeat(64),
      dataAsOf: at(30_000).toISOString(),
    };
    const successor = await providerPublicationFixture({
      sequence: 30n,
      predecessor: completedExpectedHead(localPublication),
      immutableProof: successorProof,
      operationTag: "bootstrap-provider-successor",
    });
    const successorProvider = await publishProvider(
      harness,
      organizationId,
      successor,
      30_000,
    );
    await activateManifest(
      harness,
      organizationId,
      successor,
      successorProvider.attemptId,
      40_000,
    );

    const barrier = await new PrismaCatalogPromotionRetentionRepository(
      harness.client,
      { organizationId, deploymentKey },
    ).acquireBarrier();
    assert.equal(
      barrier.postgresProof.completedHeads[0]?.completedHead
        .publicProviderReleaseId,
      successor.summary.publicProviderReleaseId,
    );
    assert.equal(
      barrier.postgresProof.activeState.state.observation
        ?.providerSelections[0]?.publicProviderReleaseId,
      successor.summary.publicProviderReleaseId,
    );
    const protections = barrier.postgresProof.providerProtectionsByPlatform
      .find(({ platformKey: key }) => key === platformKey)?.releases ?? [];
    assert.deepEqual(protections.map((protection) => ({
      publicProviderReleaseId: protection.release.publicProviderReleaseId,
      providerReleaseFingerprint:
        protection.release.providerReleaseFingerprint,
      reason: protection.reason,
      operationKind: protection.operationProof.operationKind,
      operationState: protection.operationProof.operationState,
      canonicalRequestBody: protection.operationProof.canonicalRequestBody,
    })), [bootstrapPublication, localPublication].map((publication) => ({
      publicProviderReleaseId: publication.summary.publicProviderReleaseId,
      providerReleaseFingerprint:
        publication.summary.providerReleaseFingerprint,
      reason: "rollback_recovery",
      operationKind: "finalize",
      operationState: "acknowledged",
      canonicalRequestBody: null,
    })));
  } finally {
    await harness.close();
  }
});

test("terminal manifest block authorization expires after the recovery window", async () => {
  const harness = await createMigratedTestDatabase();
  const protectedOrganizationId =
    "95000000-0000-4000-8000-000000000024";
  const expiredOrganizationId =
    "95000000-0000-4000-8000-000000000025";
  try {
    const operationAt = new Date();
    await seedScope(
      harness, protectedOrganizationId, "retention-manifest-block-protected",
    );
    const protectedPublication = await providerPublicationFixture({
      operationTag: "manifest-block-protected",
    });
    const protectedProvider = await publishProvider(
      harness, protectedOrganizationId, protectedPublication, 3_000,
    );
    const protectedBlock = await blockManifestForRecovery(
      harness,
      protectedOrganizationId,
      protectedPublication,
      protectedProvider.attemptId,
      operationAt,
    );
    const protectedBarrier = await new
      PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId: protectedOrganizationId, deploymentKey,
      }).acquireBarrier();
    assert.deepEqual(protectedBarrier.postgresProof.manifestProtections.map(
      (protection) => ({
        publicReleaseId: protection.manifest.publicReleaseId,
        reason: protection.reason,
        operationKind: protection.operationProof.operationKind,
        canonicalRequestBody: protection.operationProof.canonicalRequestBody,
      }),
    ), [{
      publicReleaseId: protectedBlock.manifest.publicReleaseId,
      reason: "block_recovery",
      operationKind: "block",
      canonicalRequestBody: null,
    }]);

    await seedScope(
      harness, expiredOrganizationId, "retention-manifest-block-expired",
    );
    const expiredPublication = await providerPublicationFixture({
      operationTag: "manifest-block-expired",
    });
    const expiredProvider = await publishProvider(
      harness, expiredOrganizationId, expiredPublication, 4_000,
    );
    await blockManifestForRecovery(
      harness,
      expiredOrganizationId,
      expiredPublication,
      expiredProvider.attemptId,
      new Date(operationAt.getTime() - 8 * 24 * 60 * 60 * 1_000),
    );
    const expiredBarrier = await new
      PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId: expiredOrganizationId, deploymentKey,
      }).acquireBarrier();
    assert.deepEqual(expiredBarrier.postgresProof.manifestProtections, []);
  } finally {
    await harness.close();
  }
});

test("proof overflow fails stably and rolls back barrier acquisition", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000026";
  try {
    await seedScope(harness, organizationId, "retention-proof-overflow");
    const publication = await providerPublicationFixture({
      operationTag: "retention-proof-overflow",
    });
    const published = await publishProvider(
      harness, organizationId, publication, 5_000,
    );
    const operationAt = new Date();
    const first = await blockManifestForRecovery(
      harness,
      organizationId,
      publication,
      published.attemptId,
      operationAt,
      "proof-overflow-0",
    );
    const [sourceAttempt, sourceOperation] = await Promise.all([
      harness.client.manifest_promotion_attempts.findUniqueOrThrow({
        where: { id: first.attemptId },
      }),
      harness.client.manifest_promotion_operations.findUniqueOrThrow({
        where: { attempt_id: first.attemptId },
      }),
    ]);
    const sourceSummary = JSON.parse(
      sourceAttempt.prepared_summary_body!,
    ) as Record<string, unknown>;
    const evaluations = [];
    const attempts = [];
    const operations = [];
    for (let index = 1; index < 33; index += 1) {
      const suffix = (1_000 + index).toString().padStart(12, "0");
      const attemptId = `95000000-0000-4000-8000-${suffix}`;
      const publicReleaseId = `96000000-0000-5000-8000-${suffix}`;
      const manifestFingerprint = index.toString(16).padStart(64, "0");
      const evaluationSequence = sourceAttempt.evaluation_sequence +
        BigInt(index);
      const operationId = `manifest:block:proof-overflow-${index}`;
      const identity = {
        ...first.manifest,
        publicReleaseId,
        manifestFingerprint,
      };
      const preparedSummaryBody = canonicalJson({
        ...sourceSummary,
        manifestIdentity: identity,
      });
      const request = {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationId,
        idempotencyKey: operationId,
        publicReleaseId,
        manifestFingerprint,
        blockSequence: "1",
        reason: "MANIFEST_SECURITY_INVALID",
      } as const;
      const canonicalRequestBody = canonicalJson(request);
      const serverTime = new Date(
        operationAt.getTime() + index * 10,
      ).toISOString();
      const withoutDigest = {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationKind: "block" as const,
        operationId,
        idempotencyKey: operationId,
        publicReleaseId,
        manifestFingerprint,
        terminalState: "blocked" as const,
        result: "blocked" as const,
        serverTime,
        requestDigest: promotionV2Sha256(canonicalRequestBody),
        details: { blockSequence: "1", reason: request.reason },
      };
      const receipt = {
        ...withoutDigest,
        receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
      } satisfies CatalogManifestBlockReceipt;
      const canonicalReceiptBody = canonicalJson(receipt);
      evaluations.push({
        organization_id: organizationId,
        deployment_key: deploymentKey,
        evaluation_sequence: evaluationSequence,
        cause: "observation_succeeded",
        cause_identity: `retention-proof-overflow-${index}`,
        cause_sha256: index.toString(16).padStart(64, "0"),
        requested_at: new Date(serverTime),
      });
      attempts.push({
        ...sourceAttempt,
        id: attemptId,
        evaluation_sequence: evaluationSequence,
        prepared_summary_body: preparedSummaryBody,
        prepared_summary_sha256: promotionV2Sha256(preparedSummaryBody),
        public_release_id: publicReleaseId,
        manifest_fingerprint: manifestFingerprint,
        terminal_at: new Date(serverTime),
        created_at: new Date(serverTime),
        updated_at: new Date(serverTime),
      });
      operations.push({
        ...sourceOperation,
        id: `97000000-0000-4000-8000-${suffix}`,
        attempt_id: attemptId,
        operation_id: operationId,
        canonical_request_body: canonicalRequestBody,
        request_sha256: promotionV2Sha256(canonicalRequestBody),
        last_sent_at: new Date(serverTime),
        acknowledged_at: new Date(serverTime),
        canonical_receipt_body: canonicalReceiptBody,
        receipt_sha256: await catalogManifestTerminalReceiptSha256(receipt),
        exact_response_body: null,
        response_sha256: null,
        created_at: new Date(serverTime),
        updated_at: new Date(serverTime),
      });
    }
    await harness.client.$transaction([
      harness.client.manifest_promotion_evaluations.createMany({
        data: evaluations,
      }),
      harness.client.manifest_promotion_attempts.createMany({ data: attempts }),
      harness.client.manifest_promotion_operations.createMany({
        data: operations,
      }),
    ]);

    await assert.rejects(
      new PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId, deploymentKey,
      }).acquireBarrier(),
      (error) =>
        error instanceof CatalogPromotionRetentionPersistenceError &&
        error.code === "CATALOG_PROMOTION_RETENTION_PROOF_INCOMPLETE",
    );
    assert.equal(
      await harness.client.catalog_promotion_retention_barriers.count({
        where: { organization_id: organizationId, deployment_key: deploymentKey },
      }),
      0,
    );
  } finally {
    await harness.close();
  }
});

test("barrier resumes exact operations, rejects live lane writes, and isolates tenants", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000001";
  const otherOrganizationId = "95000000-0000-4000-8000-000000000002";
  try {
    await seedScope(harness, organizationId, "retention-barrier");
    await seedScope(harness, otherOrganizationId, "retention-barrier-other");
    const repository = new PrismaCatalogPromotionRetentionRepository(
      harness.client, { organizationId, deploymentKey },
    );
    const barrier = await repository.acquireBarrier();
    assert.equal(barrier.resumed, false);
    assert.equal(barrier.barrierGeneration, 1n);
    assert.deepEqual(
      barrier.postgresProof.completedHeads.map(({ platformKey }) => platformKey),
      [platformKey],
    );
    const restarted = new PrismaCatalogPromotionRetentionRepository(
      harness.client, { organizationId, deploymentKey },
    );
    assert.deepEqual(await restarted.loadBarrier(), {
      ...barrier, resumed: true,
    });
    await assert.rejects(() => repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "manifests",
      maximumDocuments: 8,
    }), (error) => error instanceof CatalogPromotionRetentionPersistenceError &&
      error.code === "CATALOG_PROMOTION_RETENTION_INPUT_INVALID");
    await assert.rejects(() => repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "manifests",
      maximumDocuments: 91,
    }), (error) => error instanceof CatalogPromotionRetentionPersistenceError &&
      error.code === "CATALOG_PROMOTION_RETENTION_INPUT_INVALID");

    const publication = await providerPublicationFixture();
    const provider = new PrismaProviderPromotionRepository(harness.client, {
      organizationId, deploymentKey, platformKey,
    });
    await assert.rejects(() => provider.enqueueEvaluation({
      checkpoint: publication.checkpoint,
      requestedAt: at(1_000),
    }));
    const manifest = new PrismaManifestPromotionRepository(harness.client, {
      organizationId, deploymentKey,
    });
    await assert.rejects(() => manifest.enqueueEvaluation({
      cause: "observation_succeeded",
      causeIdentity: "barrier-blocked",
      requestedAt: at(1_000),
    }));
    const other = new PrismaProviderPromotionRepository(harness.client, {
      organizationId: otherOrganizationId, deploymentKey, platformKey,
    });
    assert.equal((await other.enqueueEvaluation({
      checkpoint: publication.checkpoint,
      requestedAt: at(1_000),
    })).result, "created");

    const manifestOperation = await repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "manifests",
      maximumDocuments: 90,
    });
    assert.ok(manifestOperation);
    assert.equal((await restarted.loadPendingOperation({
      barrierToken: barrier.barrierToken,
    }))?.canonicalRequestBody, manifestOperation.canonicalRequestBody);
    await repository.markOperationSent({
      barrierToken: barrier.barrierToken,
      operationId: manifestOperation.operationId,
      sentAt: at(2_000),
    });
    const request = manifestRequest(manifestOperation.canonicalRequestBody);
    const evidence = await manifestEvidence(request);
    await assert.rejects(() => repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: manifestOperation.operationId,
      acknowledgedAt: at(2_001),
      evidence: {
        ...evidence,
        exactResponseBody: evidence.exactResponseBody.replace(
          manifestOperation.operationId, "retention:wrong",
        ),
      },
    }), (error) => error instanceof CatalogPromotionRetentionPersistenceError &&
      error.code === "CATALOG_PROMOTION_RETENTION_RECEIPT_INVALID");
    const acknowledgement = await repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: manifestOperation.operationId,
      acknowledgedAt: at(2_002),
      evidence,
    });
    assert.equal(acknowledgement.postgresCleanupPending, false);
    assert.deepEqual(await repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: manifestOperation.operationId,
      acknowledgedAt: at(2_003),
      evidence,
    }), acknowledgement);

    const providerOperation = await repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "provider_releases",
      platformKey,
      maximumDocuments: 90,
    });
    assert.ok(providerOperation);
    await repository.markOperationSent({
      barrierToken: barrier.barrierToken,
      operationId: providerOperation.operationId,
      sentAt: at(3_000),
    });
    await repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: providerOperation.operationId,
      acknowledgedAt: at(3_001),
      evidence: await providerEvidence(
        providerRequest(providerOperation.canonicalRequestBody),
        { selected: null },
      ),
    });
    assert.equal(await repository.releaseBarrier({
      barrierToken: barrier.barrierToken,
    }), true);
    await assert.rejects(() => repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "manifests",
      maximumDocuments: 90,
    }), (error) => error instanceof CatalogPromotionRetentionPersistenceError &&
      error.code === "CATALOG_PROMOTION_RETENTION_BARRIER_INACTIVE");
  } finally {
    await harness.close();
  }
});

async function seedReuseHistory(
  harness: MigratedTestDatabase,
  organizationId: string,
  publication: ProviderPublicationFixture,
  count: number,
) {
  const lane = await harness.client.manifest_promotion_lanes.findUniqueOrThrow({
    where: {
      organization_id_deployment_key: {
        organization_id: organizationId, deployment_key: deploymentKey,
      },
    },
  });
  for (let index = 0; index < count; index += 1) {
    const fixture = await providerPublicationFixture({
      sequence: BigInt(100 + index),
      classification: "reuse",
      predecessor: completedExpectedHead(publication),
      immutableProof: publication.summary.immutableProof,
      operationTag: `history-${index}`,
    });
    const checkpointBody = providerCheckpointIdentityBody(fixture.checkpoint);
    const summaryBody = providerPromotionPreparedSummaryBody(fixture.summary);
    const attemptId = `96000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await harness.client.$executeRaw(Prisma.sql`
      insert into public.provider_promotion_evaluations (
        organization_id, deployment_key, platform_key, evaluation_sequence,
        checkpoint_body, checkpoint_sha256, settled_checkpoint,
        source_head_checkpoint, requested_at
      ) values (
        cast(${organizationId} as uuid), ${deploymentKey}, ${platformKey},
        ${BigInt(100 + index)}, ${checkpointBody},
        ${promotionV2Sha256(checkpointBody)}, ${BigInt(100 + index)},
        ${BigInt(100 + index)}, ${at(10_000 + index)}
      )
    `);
    await harness.client.$executeRaw(Prisma.sql`
      insert into public.provider_promotion_attempts (
        id, organization_id, deployment_key, platform_key,
        evaluation_sequence, bootstrap_proof_revision,
        bootstrap_provider_set_sha256, target_checkpoint, state,
        prepared_classification, prepared_summary_body,
        prepared_summary_sha256, public_provider_release_id,
        provider_release_fingerprint, expected_completed_head_sha256,
        prepared_at, terminal_at
      ) values (
        cast(${attemptId} as uuid), cast(${organizationId} as uuid),
        ${deploymentKey}, ${platformKey}, ${BigInt(100 + index)},
        ${lane.current_bootstrap_proof_revision!},
        ${lane.bootstrap_provider_set_sha256!}, ${BigInt(100 + index)},
        'reused', 'reuse', ${summaryBody}, ${promotionV2Sha256(summaryBody)},
        cast(${fixture.summary.publicProviderReleaseId} as uuid),
        ${fixture.summary.providerReleaseFingerprint},
        ${promotionV2Sha256(canonicalJson(fixture.summary.expectedCompletedHead))},
        ${at(10_000 + index)}, ${at(10_000 + index)}
      )
    `);
    const operation = fixture.operations[0]!;
    const evidence = fixture.evidence[0]!;
    const exactResponseBody = evidence.exactResponseBody ?? null;
    await harness.client.provider_promotion_operations.create({
      data: {
        attempt_id: attemptId,
        organization_id: organizationId,
        deployment_key: deploymentKey,
        platform_key: platformKey,
        operation_index: 0,
        operation_id: operation.operationId,
        operation_kind: operation.operationKind,
        request_path: operation.requestPath,
        canonical_request_body: operation.canonicalRequestBody,
        request_sha256: promotionV2Sha256(operation.canonicalRequestBody),
        state: "acknowledged",
        send_count: 1,
        last_sent_at: at(10_000 + index),
        acknowledged_at: at(10_000 + index),
        canonical_receipt_body: evidence.canonicalReceiptBody,
        receipt_sha256: promotionV2Sha256(evidence.canonicalReceiptBody),
        exact_response_body: exactResponseBody,
        response_sha256: exactResponseBody === null
          ? null : promotionV2Sha256(exactResponseBody),
      },
    });
  }
}

test("selected retired provider graph deletes in bounded chunks without touching current or unrelated evaluations", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000011";
  try {
    await seedScope(harness, organizationId, "retention-cleanup");
    const first = await providerPublicationFixture({ operationTag: "first" });
    await publishProvider(harness, organizationId, first, 1_000);
    await seedReuseHistory(harness, organizationId, first, 5);
    const nextProof: ProviderReleaseImmutableProofV1 = {
      ...first.summary.immutableProof,
      publicProviderReleaseId: "61000000-0000-5000-8000-000000000099",
      providerReleaseFingerprint: "e".repeat(64),
      dataAsOf: at(20_000).toISOString(),
    };
    const second = await providerPublicationFixture({
      sequence: 20n,
      predecessor: completedExpectedHead(first),
      immutableProof: nextProof,
      operationTag: "second",
    });
    await publishProvider(harness, organizationId, second, 20_000);

    const unrelatedCheckpoint = providerCheckpointIdentityBody({
      ...second.checkpoint,
      settledSequence: 999n,
      sourceHeadSequence: 999n,
      settledAt: at(30_000),
      sourceHeadAt: at(30_000),
      lastSuccessfulObservationAt: at(30_000),
      staleAt: at(930_000),
      freshness: "fresh",
    });
    await harness.client.provider_promotion_evaluations.create({
      data: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
        platform_key: platformKey,
        evaluation_sequence: 999n,
        checkpoint_body: unrelatedCheckpoint,
        checkpoint_sha256: promotionV2Sha256(unrelatedCheckpoint),
        settled_checkpoint: 999n,
        source_head_checkpoint: 999n,
        requested_at: at(30_000),
      },
    });

    const repository = new PrismaCatalogPromotionRetentionRepository(
      harness.client, { organizationId, deploymentKey },
    );
    const barrier = await repository.acquireBarrier();
    const manifestOperation = await repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "manifests",
      maximumDocuments: 90,
    });
    assert.ok(manifestOperation);
    await repository.markOperationSent({
      barrierToken: barrier.barrierToken,
      operationId: manifestOperation.operationId,
      sentAt: at(40_000),
    });
    await repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: manifestOperation.operationId,
      acknowledgedAt: at(40_001),
      evidence: await manifestEvidence(
        manifestRequest(manifestOperation.canonicalRequestBody),
      ),
    });
    const providerOperation = await repository.prepareOperation({
      barrierToken: barrier.barrierToken,
      phase: "provider_releases",
      platformKey,
      maximumDocuments: 90,
    });
    assert.ok(providerOperation);
    await repository.markOperationSent({
      barrierToken: barrier.barrierToken,
      operationId: providerOperation.operationId,
      sentAt: at(41_000),
    });
    const protectedReleases = [{
      platformKey,
      releases: [{
        publicProviderReleaseId: second.summary.publicProviderReleaseId,
        providerReleaseFingerprint:
          second.summary.providerReleaseFingerprint,
        lifecycle: "complete" as const,
        reasons: ["completed_head" as const],
      }],
    }];
    const request = providerRequest(providerOperation.canonicalRequestBody);
    const unsafeEvidence = await providerEvidence(request, {
      selected: {
        platformKey,
        publicProviderReleaseId: second.summary.publicProviderReleaseId,
        providerReleaseFingerprint:
          second.summary.providerReleaseFingerprint,
        lifecycle: "complete",
      },
      protectedReleases,
    });
    await assert.rejects(() => repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: providerOperation.operationId,
      acknowledgedAt: at(41_001),
      evidence: unsafeEvidence,
    }), (error) => error instanceof CatalogPromotionRetentionPersistenceError &&
      error.code === "CATALOG_PROMOTION_RETENTION_UNSAFE");
    const selected = {
      platformKey,
      publicProviderReleaseId: first.summary.publicProviderReleaseId,
      providerReleaseFingerprint: first.summary.providerReleaseFingerprint,
      lifecycle: "complete" as const,
    };
    const acknowledgement = await repository.acknowledgeOperation({
      barrierToken: barrier.barrierToken,
      operationId: providerOperation.operationId,
      acknowledgedAt: at(41_002),
      evidence: await providerEvidence(request, {
        selected, protectedReleases,
      }),
    });
    assert.equal(acknowledgement.postgresCleanupPending, true);

    const restartedClient = await harness.createIndependentClient();
    const restarted = new PrismaCatalogPromotionRetentionRepository(
      restartedClient, { organizationId, deploymentKey },
    );
    const cleanupAfterRestart = await restarted.loadOperationRequiringCleanup({
      barrierToken: barrier.barrierToken,
    });
    assert.equal(cleanupAfterRestart?.operationId, providerOperation.operationId);
    assert.equal(cleanupAfterRestart?.state, "acknowledged");
    assert.equal(cleanupAfterRestart?.postgresCleanupComplete, false);
    assert.equal(await restarted.loadPendingOperation({
      barrierToken: barrier.barrierToken,
    }), null);
    for (const maximumRows of [9, 101]) {
      await assert.rejects(() => restarted.deleteProviderArtifactChunk({
        barrierToken: barrier.barrierToken,
        operationId: providerOperation.operationId,
        maximumRows,
      }), (error) =>
        error instanceof CatalogPromotionRetentionPersistenceError &&
        error.code === "CATALOG_PROMOTION_RETENTION_INPUT_INVALID");
    }

    const chunks: number[] = [];
    const racedProgress = await Promise.all([
      repository.deleteProviderArtifactChunk({
        barrierToken: barrier.barrierToken,
        operationId: providerOperation.operationId,
        maximumRows: 10,
      }),
      restarted.deleteProviderArtifactChunk({
        barrierToken: barrier.barrierToken,
        operationId: providerOperation.operationId,
        maximumRows: 10,
      }),
    ]);
    let complete = false;
    for (const progress of racedProgress) {
      chunks.push(progress.deletedRowCount);
      assert.ok(progress.deletedRowCount <= 10);
      if (!progress.complete) assert.ok(progress.deletedRowCount > 0);
      complete ||= progress.complete;
    }
    while (!complete) {
      const progress = await restarted.deleteProviderArtifactChunk({
        barrierToken: barrier.barrierToken,
        operationId: providerOperation.operationId,
        maximumRows: 10,
      });
      chunks.push(progress.deletedRowCount);
      assert.ok(progress.deletedRowCount <= 10);
      if (!progress.complete) assert.ok(progress.deletedRowCount > 0);
      complete = progress.complete;
    }
    assert.ok(chunks.length > 1);
    assert.ok(chunks.some((count) => count > 0));
    assert.equal(await restarted.loadOperationRequiringCleanup({
      barrierToken: barrier.barrierToken,
    }), null);
    assert.deepEqual(await repository.deleteProviderArtifactChunk({
      barrierToken: barrier.barrierToken,
      operationId: providerOperation.operationId,
      maximumRows: 100,
    }), { deletedRowCount: 0, complete: true });
    assert.equal(await harness.client.provider_release_artifacts.count({
      where: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
        public_provider_release_id: first.summary.publicProviderReleaseId,
      },
    }), 0);
    assert.equal(await harness.client.provider_release_artifacts.count({
      where: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
        public_provider_release_id: second.summary.publicProviderReleaseId,
      },
    }), 1);
    assert.ok(await harness.client.provider_promotion_evaluations.findUnique({
      where: {
        organization_id_deployment_key_platform_key_evaluation_sequence: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          platform_key: platformKey,
          evaluation_sequence: 999n,
        },
      },
    }));
    assert.equal(await repository.releaseBarrier({
      barrierToken: barrier.barrierToken,
    }), true);
  } finally {
    await harness.close();
  }
});

test("retention proof fails closed on head or active-manifest receipt inconsistencies", async () => {
  const harness = await createMigratedTestDatabase();
  const headOrganizationId = "95000000-0000-4000-8000-000000000019";
  const manifestOrganizationId = "95000000-0000-4000-8000-000000000020";
  try {
    await seedScope(harness, headOrganizationId, "retention-corrupt-head");
    const headPublication = await providerPublicationFixture({
      operationTag: "corrupt-head",
    });
    await publishProvider(harness, headOrganizationId, headPublication, 1_000);
    const headLane = await harness.client.provider_promotion_lanes
      .findUniqueOrThrow({
        where: {
          organization_id_deployment_key_platform_key: {
            organization_id: headOrganizationId,
            deployment_key: deploymentKey,
            platform_key: platformKey,
          },
        },
      });
    const completedHead = providerReleaseCompletedHeadResultV1Schema.parse(
      JSON.parse(headLane.completed_head_body!),
    );
    const inconsistentHeadBody = canonicalJson({
      ...completedHead,
      release: {
        ...completedHead.release,
        publicProviderReleaseId:
          "61000000-0000-5000-8000-000000000098",
      },
    });
    await harness.client.provider_promotion_lanes.update({
      where: {
        organization_id_deployment_key_platform_key: {
          organization_id: headOrganizationId,
          deployment_key: deploymentKey,
          platform_key: platformKey,
        },
      },
      data: {
        completed_head_body: inconsistentHeadBody,
        completed_head_sha256: promotionV2Sha256(inconsistentHeadBody),
      },
    });
    await assert.rejects(() =>
      new PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId: headOrganizationId, deploymentKey,
      }).acquireBarrier(), (error) =>
        error instanceof CatalogPromotionRetentionPersistenceError &&
        error.code === "CATALOG_PROMOTION_RETENTION_PROOF_INCOMPLETE");

    await seedScope(
      harness, manifestOrganizationId, "retention-corrupt-manifest",
    );
    const manifestPublication = await providerPublicationFixture({
      operationTag: "corrupt-manifest",
    });
    const published = await publishProvider(
      harness, manifestOrganizationId, manifestPublication, 3_000,
    );
    await activateManifest(
      harness, manifestOrganizationId, manifestPublication,
      published.attemptId, 4_000,
    );
    const manifestLane = await harness.client.manifest_promotion_lanes
      .findUniqueOrThrow({
        where: {
          organization_id_deployment_key: {
            organization_id: manifestOrganizationId,
            deployment_key: deploymentKey,
          },
        },
      });
    const activeState = activeCatalogManifestStateV1Schema.parse(
      JSON.parse(manifestLane.active_state_body!),
    );
    assert.ok(activeState.activeManifest && activeState.observation);
    const inconsistentManifestFingerprint = activeState.activeManifest
      .manifestFingerprint === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    const inconsistentStateBody = canonicalJson({
      ...activeState,
      activeManifest: {
        ...activeState.activeManifest,
        manifestFingerprint: inconsistentManifestFingerprint,
      },
    });
    activeCatalogManifestStateV1Schema.parse(JSON.parse(inconsistentStateBody));
    await harness.client.manifest_promotion_lanes.update({
      where: {
        organization_id_deployment_key: {
          organization_id: manifestOrganizationId,
          deployment_key: deploymentKey,
        },
      },
      data: {
        active_state_body: inconsistentStateBody,
        active_state_sha256: promotionV2Sha256(inconsistentStateBody),
        active_manifest_fingerprint: inconsistentManifestFingerprint,
      },
    });
    await assert.rejects(() =>
      new PrismaCatalogPromotionRetentionRepository(harness.client, {
        organizationId: manifestOrganizationId, deploymentKey,
      }).acquireBarrier(), (error) =>
        error instanceof CatalogPromotionRetentionPersistenceError &&
        error.code === "CATALOG_PROMOTION_RETENTION_PROOF_INCOMPLETE");
  } finally {
    await harness.close();
  }
});

test("nonterminal Heat source proof protects its exact manifest/provider graph and Heat writes remain frozen", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000021";
  try {
    await seedScope(harness, organizationId, "retention-heat-proof");
    const publication = await providerPublicationFixture({
      operationTag: "heat-source",
    });
    const published = await publishProvider(
      harness, organizationId, publication, 1_000,
    );
    const activation = await activateManifest(
      harness, organizationId, publication, published.attemptId, 2_000,
    );
    const manifestSource: ActiveCatalogHeatManifest = {
      manifestAlignment: {
        publicReleaseId: activation.manifest.publicReleaseId,
        manifestFingerprint: activation.manifest.manifestFingerprint,
        sharedConfigurationEpoch:
          activation.manifest.sharedConfigurationEpoch,
        providerReferenceSetHash:
          activation.manifest.providerReferenceSetHash,
      },
      providerReferences: activation.manifest.providerReferences,
      publicRepackOwnership: [],
      publicRepackIds: [],
      confirmedManifestWatermark: 1n,
      terminalReceiptSha256: promotionV2Sha256(
        activation.evidence.canonicalReceiptBody,
      ),
    };
    const serialized = await serializeHeatManifestSourceProof(manifestSource);
    await harness.client.promotion_lanes.create({
      data: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
        lane_key: "heat",
        bootstrap_state: "verified_empty",
        bootstrap_verified_at: at(3_000),
        settled_watermark: 1n,
        settled_at: at(3_000),
        requested_watermark: 1n,
        requested_at: at(3_000),
      },
    });
    const heatAttempt = await harness.client.promotion_attempts.create({
      data: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
        lane_key: "heat",
        target_watermark: 1n,
        state: "ready",
        content_identity: "c".repeat(64),
        publication_identity: "heat-source-proof",
        prepared_classification: "publish",
        observation_sequence: 1,
        public_config_hash: "d".repeat(64),
        repack_search_index_hash: "e".repeat(64),
        prepared_at: at(3_000),
        manifest_source_proof_body: serialized.canonicalBody,
        manifest_source_proof_sha256: serialized.sha256,
      },
    });
    const repository = new PrismaCatalogPromotionRetentionRepository(
      harness.client, { organizationId, deploymentKey },
    );
    const barrier = await repository.acquireBarrier();
    assert.ok(barrier.postgresProof.manifestProtections.some((protection) =>
      protection.manifest.publicReleaseId ===
        activation.manifest.publicReleaseId &&
      protection.reason === "in_flight_attempt"));
    assert.ok(barrier.postgresProof.providerProtectionsByPlatform[0]?.releases
      .some((protection) => protection.release.publicProviderReleaseId ===
        publication.summary.publicProviderReleaseId &&
        protection.reason === "in_flight_attempt"));
    await assert.rejects(() => harness.client.promotion_attempts.update({
      where: { id: heatAttempt.id },
      data: { retry_count: { increment: 1 } },
    }));
    const guardedTables = await harness.client.$queryRaw<Array<{
      tableName: string;
    }>>(Prisma.sql`
      select event_object_table as "tableName"
      from information_schema.triggers
      where trigger_schema = 'public'
        and trigger_name like '%_retention_barrier'
      group by event_object_table
      order by event_object_table collate "C"
    `);
    assert.equal(guardedTables.length, 15);
    assert.ok(guardedTables.some(({ tableName }) =>
      tableName === "promotion_operations"));
  } finally {
    await harness.close();
  }
});

test("protocol-max unresolved provider plan defers retention before proof construction", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "95000000-0000-4000-8000-000000000031";
  try {
    await seedScope(harness, organizationId, "retention-max-plan");
    const publication = await providerPublicationFixture({
      operationTag: "retention-max-plan",
    });
    const provider = new PrismaProviderPromotionRepository(harness.client, {
      organizationId, deploymentKey, platformKey,
    });
    await provider.enqueueEvaluation({
      checkpoint: publication.checkpoint,
      requestedAt: at(1_000),
    });
    const claim = await provider.claim({
      workerId: "retention-max-plan",
      now: at(1_000),
      leaseExpiresAt: at(61_000),
    });
    assert.ok(claim);

    const startTemplate = publication.operations.find(({ operationKind }) =>
      operationKind === "start");
    const batchTemplate = publication.operations.find(({ operationKind }) =>
      operationKind === "applyBatch");
    const finalizeTemplate = publication.operations.find(({ operationKind }) =>
      operationKind === "finalize");
    assert.ok(startTemplate && batchTemplate && finalizeTemplate);
    const parsedStart = providerReleaseStartRequestSchema.parse(
      JSON.parse(startTemplate.canonicalRequestBody),
    );
    const parsedBatch = providerReleaseApplyBatchRequestSchema.parse(
      JSON.parse(batchTemplate.canonicalRequestBody),
    );
    const parsedFinalize = providerReleaseFinalizeRequestSchema.parse(
      JSON.parse(finalizeTemplate.canonicalRequestBody),
    );
    const release = {
      ...parsedStart.release,
      batchCount: MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
    };
    const operations = [
      {
        operationIndex: 0,
        operationId: "provider:start:alpha:retention-max",
        operationKind: "start",
        requestPath: startTemplate.requestPath,
        request: {
          ...parsedStart,
          operationId: "provider:start:alpha:retention-max",
          idempotencyKey: "provider:start:alpha:retention-max",
          release,
        },
      },
      ...Array.from(
        { length: MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT },
        (_, batchIndex) => {
          const operationId = `provider:batch:alpha:retention-max:${batchIndex}`;
          return {
            operationIndex: batchIndex + 1,
            operationId,
            operationKind: "applyBatch",
            requestPath: batchTemplate.requestPath,
            request: {
              ...parsedBatch,
              operationId,
              idempotencyKey: operationId,
              release,
              batch: { ...parsedBatch.batch, batchIndex },
            },
          };
        },
      ),
      {
        operationIndex: MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT + 1,
        operationId: "provider:finalize:alpha:retention-max",
        operationKind: "finalize",
        requestPath: finalizeTemplate.requestPath,
        request: {
          ...parsedFinalize,
          operationId: "provider:finalize:alpha:retention-max",
          idempotencyKey: "provider:finalize:alpha:retention-max",
          release,
        },
      },
    ] as const;
    const preparedSummary = {
      ...publication.summary,
      immutableProof: {
        ...publication.summary.immutableProof,
        batchCount: MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
      },
    };
    const preparedSummaryBody = providerPromotionPreparedSummaryBody(
      preparedSummary,
    );
    await harness.client.provider_promotion_attempts.update({
      where: { id: claim.attemptId },
      data: {
        state: "ready",
        prepared_classification: "publish",
        prepared_summary_body: preparedSummaryBody,
        prepared_summary_sha256: promotionV2Sha256(preparedSummaryBody),
        public_provider_release_id:
          preparedSummary.publicProviderReleaseId,
        provider_release_fingerprint:
          preparedSummary.providerReleaseFingerprint,
        expected_completed_head_sha256: promotionV2Sha256(canonicalJson(
          preparedSummary.expectedCompletedHead,
        )),
        prepared_at: at(1_001),
      },
    });
    await harness.client.provider_promotion_operations.createMany({
      data: operations.map((operation) => {
        const body = canonicalJson(operation.request);
        return {
          attempt_id: claim.attemptId,
          organization_id: organizationId,
          deployment_key: deploymentKey,
          platform_key: platformKey,
          operation_index: operation.operationIndex,
          operation_id: operation.operationId,
          operation_kind: operation.operationKind,
          request_path: operation.requestPath,
          canonical_request_body: body,
          request_sha256: promotionV2Sha256(body),
        };
      }),
    });

    await assert.rejects(
      new PrismaCatalogPromotionRetentionRepository(
        harness.client, { organizationId, deploymentKey },
      ).acquireBarrier(),
      (error) =>
        error instanceof CatalogPromotionRetentionPersistenceError &&
        error.code === "CATALOG_PROMOTION_RETENTION_STATE_CONFLICT",
    );
    assert.equal(
      await harness.client.catalog_promotion_retention_barriers.count({
        where: { organization_id: organizationId, deployment_key: deploymentKey },
      }),
      0,
    );
  } finally {
    await harness.close();
  }
});
