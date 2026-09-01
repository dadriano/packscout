import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaManifestGateIntentRepository } from
  "./manifest-gate-intent-repository.ts";
import { PrismaManifestReconciliationJobRepository } from
  "./manifest-reconciliation-job-repository.ts";
import {
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  PromotionJobPersistenceError,
  promotionJobDeliveryDigest,
  promotionJobSha256,
} from "./promotion-job-persistence-types.ts";
import { PrismaProviderPromotionInvocationProjectionRepository } from
  "./provider-promotion-invocation-projection-repository.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const organizationId = "70000000-0000-4000-8000-000000000001";
const providerOne = "70000000-0000-4000-8000-000000000002";
const providerTwo = "70000000-0000-4000-8000-000000000003";

function delivery(opaqueKey: string, issuedAt: Date) {
  return {
    opaqueKey,
    issuedAt,
    expiresAt: new Date(
      issuedAt.getTime() + PROMOTION_JOB_DELIVERY_RETENTION_MS,
    ),
  };
}

function beginInput(input: Readonly<{
  opaqueKey: string;
  now: Date;
  trigger?:
    | { kind: "manual" }
    | { kind: "change_wake"; observedWakeGeneration: bigint }
    | {
        kind: "reconciliation_cron";
        scheduleEpoch: bigint;
        scheduleWindowIndex: bigint;
        scheduledDueAt: Date;
      };
}>) {
  const issuedAt = new Date(input.now.getTime() - 1_000);
  return {
    delivery: delivery(input.opaqueKey, issuedAt),
    trigger: input.trigger ?? { kind: "manual" as const },
    now: input.now,
    requestedAt: input.now,
    startedAt: input.now,
    ownershipKey: "manifest-promotion-test",
    ownershipToken: randomUUID(),
    ownershipExpiresAt: new Date(input.now.getTime() + 60_000),
  };
}

function code(expected: PromotionJobPersistenceError["code"]) {
  return (error: unknown): boolean =>
    error instanceof PromotionJobPersistenceError && error.code === expected;
}

test("central manifest ledger, gates, and sanitized projections stay separate", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "promotion-central-test",
        name: "Promotion central test",
      },
    });
    await harness.client.providers.createMany({
      data: [{
        id: providerOne,
        organization_id: organizationId,
        provider_key: "promotion_provider_one",
        display_name: "Provider one",
      }, {
        id: providerTwo,
        organization_id: organizationId,
        provider_key: "promotion_provider_two",
        display_name: "Provider two",
      }],
    });
    const manifest = new PrismaManifestReconciliationJobRepository(
      harness.client,
    );
    const gates = new PrismaManifestGateIntentRepository(harness.client);
    const projections = new PrismaProviderPromotionInvocationProjectionRepository(
      harness.client,
    );
    const base = new Date("2026-08-03T12:00:00.000Z");

    assert.notEqual(
      promotionJobDeliveryDigest("provider_publication", "shared-token"),
      promotionJobDeliveryDigest("manifest_reconciliation", "shared-token"),
    );
    await manifest.coalesceWake({
      requestedGeneration: 1n,
      cause: "provider_completion",
      requestedAt: base,
    });
    const firstInput = beginInput({
      opaqueKey: "central-manifest-wake-one",
      now: new Date(base.getTime() + 1_000),
      trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    });
    const first = await manifest.beginOrRecoverInvocation(firstInput);
    assert.equal(first.disposition, "started");
    await manifest.coalesceWake({
      requestedGeneration: 2n,
      cause: "manifest_eligibility_change",
      requestedAt: new Date(base.getTime() + 2_000),
    });
    assert.equal(
      (await manifest.beginOrRecoverInvocation(firstInput)).invocation?.runId,
      first.invocation?.runId,
    );

    const manifestAttemptId = randomUUID();
    const manifestObservedAt = new Date(base.getTime() + 3_000);
    await manifest.recordProgress({
      runId: first.invocation!.runId,
      ownershipToken: firstInput.ownershipToken,
      now: manifestObservedAt,
      progress: {
        beforeLanePosition: 4n,
        afterLanePosition: 5n,
        beforeSettledPosition: 3n,
        afterSettledPosition: 4n,
        cycleCount: 1,
        promotionAttemptCount: 1,
        publicationCount: 1,
        operationCount: 0,
      },
      attempts: [{
        attemptKind: "manifest",
        attemptId: manifestAttemptId,
        observedState: "complete",
        targetPosition: 5n,
        retryCount: 0,
        safeFailureCode: null,
        publicReleaseId: null,
        releaseFingerprint: null,
        totalOperationCount: 0,
        orderedOperationDigest: promotionJobSha256("manifest-ordered"),
        recentOperations: [],
        observedAt: manifestObservedAt,
      }],
    });
    const releaseId = randomUUID();
    const releaseFingerprint = promotionJobSha256("manifest-release");
    const terminal = await manifest.terminalize({
      runId: first.invocation!.runId,
      ownershipToken: firstInput.ownershipToken,
      finishedAt: new Date(base.getTime() + 4_000),
      outcome: "caught_up",
      acknowledgeObservedWake: true,
      resultActiveGeneration: 7n,
      resultPublicReleaseId: releaseId,
      resultReleaseFingerprint: releaseFingerprint,
    });
    assert.equal(terminal.resultActiveGeneration, 7n);
    assert.equal(terminal.resultPublicReleaseId, releaseId);
    await assert.rejects(
      harness.client.manifest_reconciliation_job_invocations.update({
        where: { run_id: terminal.runId },
        data: { outcome: "failed" },
      }),
      "terminal manifest summaries are immutable",
    );
    assert.equal(
      (await manifest.loadInvocation(terminal.runId, {
        includeAttempts: true,
      }))?.attemptSnapshots?.[0]?.attemptId,
      manifestAttemptId,
    );
    const remainingWake = await manifest.loadWakeIntent();
    assert.deepEqual(
      [remainingWake.requestedGeneration, remainingWake.acknowledgedGeneration],
      [2n, 1n],
    );
    assert.equal(await manifest.releaseRetentionProtection({
      runId: terminal.runId,
      releasedAt: new Date(base.getTime() + 4_500),
      expectedRelatedAttemptSetDigest: terminal.relatedAttemptSetDigest,
      validateRelease: async (_transaction, digest) => {
        assert.equal(digest, terminal.relatedAttemptSetDigest);
      },
    }), true);
    await harness.client.manifest_reconciliation_job_invocations.delete({
      where: { run_id: terminal.runId },
    });
    assert.equal(
      (await manifest.beginOrRecoverInvocation(firstInput)).disposition,
      "existing_pruned",
    );

    const gateEvidenceOne = promotionJobSha256("gate-evidence-one");
    const gateEvidenceTwo = promotionJobSha256("gate-evidence-two");
    await gates.coalesce({
      providerId: providerOne,
      requestedGeneration: 1n,
      cause: "provider_completion",
      evidenceDigest: gateEvidenceOne,
      requestedAt: base,
    });
    await gates.coalesce({
      providerId: providerOne,
      requestedGeneration: 2n,
      cause: "provider_completion",
      evidenceDigest: gateEvidenceTwo,
      requestedAt: new Date(base.getTime() + 1_000),
    });
    const acknowledgedOne = await gates.acknowledge({
      providerId: providerOne,
      observedGeneration: 1n,
      acknowledgedAt: new Date(base.getTime() + 2_000),
    });
    assert.deepEqual([
      acknowledgedOne.requestedGeneration,
      acknowledgedOne.acknowledgedGeneration,
      acknowledgedOne.pending,
    ], [2n, 1n, true]);
    assert.deepEqual(
      (await gates.listPending({ limit: 10 })).map((gate) => gate.providerId),
      [providerOne],
    );
    await assert.rejects(gates.acknowledge({
      providerId: providerOne,
      observedGeneration: 3n,
      acknowledgedAt: new Date(base.getTime() + 3_000),
    }), code("PROMOTION_JOB_GATE_INTENT_INVALID"));

    await gates.coalesce({
      providerId: providerTwo,
      requestedGeneration: 1n,
      cause: "provider_completion",
      evidenceDigest: promotionJobSha256("gate-evidence-provider-two"),
      requestedAt: new Date(base.getTime() + 3_500),
    });
    const firstClaim = await gates.claimNext({
      owner: "manifest-promotion-test:fair-queue",
      now: new Date(base.getTime() + 4_000),
      claimMilliseconds: 60_000,
    });
    assert.equal(firstClaim?.providerId, providerOne);
    await gates.deferClaim({
      providerId: firstClaim!.providerId,
      claimToken: firstClaim!.claimToken,
      observedGeneration: firstClaim!.observedGeneration,
      failureCode: "PROVIDER_GATEWAY_UNREACHABLE",
      observedAt: new Date(base.getTime() + 4_100),
      retryAt: new Date(base.getTime() + 64_100),
    });
    const secondClaim = await gates.claimNext({
      owner: "manifest-promotion-test:fair-queue",
      now: new Date(base.getTime() + 4_200),
      claimMilliseconds: 60_000,
    });
    assert.equal(
      secondClaim?.providerId,
      providerTwo,
      "provider one deferral cannot prevent provider two from being claimed",
    );
    await gates.acknowledgeClaim({
      providerId: secondClaim!.providerId,
      claimToken: secondClaim!.claimToken,
      observedGeneration: secondClaim!.observedGeneration,
      acknowledgedAt: new Date(base.getTime() + 4_300),
    });
    await assert.rejects(gates.acknowledgeClaim({
      providerId: firstClaim!.providerId,
      claimToken: firstClaim!.claimToken,
      observedGeneration: firstClaim!.observedGeneration,
      acknowledgedAt: new Date(base.getTime() + 4_400),
    }), code("PROMOTION_JOB_GATE_INTENT_INVALID"));
    const retriedClaim = await gates.claimNext({
      owner: "manifest-promotion-test:fair-queue",
      now: new Date(base.getTime() + 65_000),
      claimMilliseconds: 60_000,
    });
    assert.equal(retriedClaim?.providerId, providerOne);
    await gates.acknowledgeClaim({
      providerId: retriedClaim!.providerId,
      claimToken: retriedClaim!.claimToken,
      observedGeneration: retriedClaim!.observedGeneration,
      acknowledgedAt: new Date(base.getTime() + 65_100),
    });

    const rawProviderInvocationId = randomUUID();
    const rawProviderAttemptId = randomUUID();
    const rawProviderReleaseId = randomUUID();
    const providerObservedAt = new Date(base.getTime() + 5_000);
    const projectionInput = {
      providerId: providerOne,
      opaqueProviderInvocationId: rawProviderInvocationId,
      triggerKind: "manual" as const,
      outcome: "caught_up" as const,
      scheduledCheckinAt: null,
      startedAt: providerObservedAt,
      finishedAt: new Date(providerObservedAt.getTime() + 1_000),
      progress: {
        beforeLanePosition: 20n,
        afterLanePosition: 21n,
        beforeSettledPosition: 19n,
        afterSettledPosition: 20n,
        cycleCount: 1,
        promotionAttemptCount: 1,
        publicationCount: 1,
        operationCount: 0,
      },
      safeFailureCode: null,
      attempts: [{
        attemptKind: "provider" as const,
        attemptId: rawProviderAttemptId,
        observedState: "complete",
        targetPosition: 21n,
        retryCount: 0,
        safeFailureCode: null,
        publicReleaseId: rawProviderReleaseId,
        releaseFingerprint: promotionJobSha256("provider-release"),
        totalOperationCount: 0,
        orderedOperationDigest: promotionJobSha256("provider-ordered-central"),
        recentOperations: [],
        observedAt: providerObservedAt,
      }],
      projectedAt: new Date(providerObservedAt.getTime() + 2_000),
    };
    const projected = await projections.project(projectionInput);
    const replayedProjection = await projections.project(projectionInput);
    assert.equal(replayedProjection.id, projected.id);
    assert.equal(
      await harness.client.provider_promotion_invocation_projections.count(),
      1,
    );
    assert.doesNotMatch(
      projected.canonicalDetailBody,
      new RegExp([
        rawProviderInvocationId,
        rawProviderAttemptId,
        rawProviderReleaseId,
      ].join("|"), "u"),
    );
    assert.match(projected.canonicalDetailBody, /attemptIdentityDigest/u);
    await assert.rejects(
      harness.client.provider_promotion_invocation_projections.update({
        where: { id: projected.id },
        data: { projection_digest: promotionJobSha256("tampered") },
      }),
      "central provider projections are immutable",
    );
    await assert.rejects(projections.project({
      ...projectionInput,
      outcome: "failed",
      safeFailureCode: "REMOTE_FAILED",
    }), code("PROMOTION_JOB_PROJECTION_CONFLICT"));

    const secondProjection = await projections.project({
      ...projectionInput,
      providerId: providerTwo,
    });
    assert.notEqual(
      secondProjection.providerInvocationIdDigest,
      projected.providerInvocationIdDigest,
    );
    assert.equal((await gates.load(providerOne))?.acknowledgedGeneration, 2n);
    assert.equal((await manifest.loadWakeIntent()).requestedGeneration, 2n);

    const baselineAt = new Date("2026-08-04T12:00:00.000Z");
    await manifest.activateSchedule({
      scheduleEpoch: 1n,
      baselineAt,
      activatedAt: baselineAt,
    });
    const dueAt = new Date(baselineAt.getTime() + 60_000);
    const cronInput = beginInput({
      opaqueKey: "manifest-cron-window-one",
      now: dueAt,
      trigger: {
        kind: "reconciliation_cron",
        scheduleEpoch: 1n,
        scheduleWindowIndex: 1n,
        scheduledDueAt: dueAt,
      },
    });
    const cron = await manifest.beginOrRecoverInvocation(cronInput);
    await manifest.terminalize({
      runId: cron.invocation!.runId,
      ownershipToken: cronInput.ownershipToken,
      finishedAt: new Date(dueAt.getTime() + 1_000),
      outcome: "coalesced",
      resultActiveGeneration: 7n,
      resultPublicReleaseId: releaseId,
      resultReleaseFingerprint: releaseFingerprint,
    });
    assert.equal((await manifest.loadSchedule()).lastAdmittedWindowIndex, 1n);

    const old = new Date("2026-01-01T00:00:00.000Z");
    const oldInput = beginInput({ opaqueKey: "manifest-old", now: old });
    const oldAdmission = await manifest.beginOrRecoverInvocation(oldInput);
    await manifest.terminalize({
      runId: oldAdmission.invocation!.runId,
      ownershipToken: oldInput.ownershipToken,
      finishedAt: new Date(old.getTime() + 1_000),
      outcome: "no_change",
      resultActiveGeneration: 0n,
    });
    const pruned = await manifest.prune({
      now: new Date("2026-09-01T00:00:00.000Z"),
      maximumRows: 100,
    });
    assert.ok(pruned.invocationSummariesDeleted >= 1);
    assert.ok(pruned.tombstonesDeleted >= 1);
    assert.equal(await manifest.loadInvocation(oldAdmission.invocation!.runId), null);
  } finally {
    await harness.close();
  }
});
