import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import { PrismaManifestGateIntentRepository } from
  "./manifest-gate-intent-repository.ts";
import { PrismaManifestReconciliationJobRepository } from
  "./manifest-reconciliation-job-repository.ts";
import {
  EMPTY_PROMOTION_ATTEMPT_SET_DIGEST,
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  PROMOTION_JOB_INVOCATION_LIMIT,
  PROMOTION_JOB_INVOCATION_RETENTION_MS,
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
    assert.equal(
      (await harness.client.provider_promotion_invocation_projections
        .findUniqueOrThrow({
          where: { id: projected.id },
          select: { organization_id: true },
        })).organization_id,
      organizationId,
      "central derives the projection tenant from its provider authority",
    );
    const [historyIndex] = await harness.client.$queryRaw<Array<{
      indexDefinition: string;
    }>>(CentralPrisma.sql`
      select indexdef as "indexDefinition"
      from pg_indexes
      where schemaname = current_schema()
        and tablename = 'provider_promotion_invocation_projections'
        and indexname =
          'provider_promotion_invocation_projections_org_history_idx'
    `);
    assert.match(
      historyIndex?.indexDefinition ?? "",
      /USING btree \(organization_id, started_at DESC, monitoring_order_key DESC\)/u,
      "the applied schema supports bounded organization-wide history ordering",
    );
    const queryPlan = await harness.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("set local enable_seqscan = off");
      return transaction.$queryRaw<Array<{ "QUERY PLAN": string }>>(
        CentralPrisma.sql`
          explain (costs off)
          select id
          from provider_promotion_invocation_projections
          where organization_id = ${organizationId}::uuid
          order by started_at desc, monitoring_order_key desc
          limit 101
        `,
      );
    });
    assert.match(
      queryPlan.map((row) => row["QUERY PLAN"]).join("\n"),
      /provider_promotion_invocation_projections_org_history_idx/u,
      "the organization-wide keyset query can use the new history index",
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
    await manifest.recordProgress({
      runId: oldAdmission.invocation!.runId,
      ownershipToken: oldInput.ownershipToken,
      now: new Date(old.getTime() + 500),
      progress: {
        beforeLanePosition: null,
        afterLanePosition: null,
        beforeSettledPosition: null,
        afterSettledPosition: null,
        cycleCount: 1,
        promotionAttemptCount: 1,
        publicationCount: 0,
        operationCount: 0,
      },
      attempts: [{
        attemptKind: "manifest",
        attemptId: randomUUID(),
        observedState: "deferred",
        targetPosition: 1n,
        retryCount: 0,
        safeFailureCode: "MANIFEST_GATE_RETRY_PENDING",
        publicReleaseId: null,
        releaseFingerprint: null,
        totalOperationCount: 0,
        orderedOperationDigest: promotionJobSha256("old-manifest-attempt"),
        recentOperations: [],
        observedAt: new Date(old.getTime() + 500),
      }],
      retentionProtected: true,
    });
    await manifest.terminalize({
      runId: oldAdmission.invocation!.runId,
      ownershipToken: oldInput.ownershipToken,
      finishedAt: new Date(old.getTime() + 1_000),
      outcome: "no_change",
      resultActiveGeneration: 0n,
    });
    assert.equal(
      (await manifest.loadInvocation(oldAdmission.invocation!.runId))
        ?.retentionProtected,
      true,
    );
    assert.deepEqual(await manifest.releasePrunableRetentionProtection({
      now: new Date("2026-09-01T00:00:00.000Z"),
      maximumRows: 100,
    }), { released: 1, moreEligible: false });
    assert.equal(
      (await manifest.loadInvocation(oldAdmission.invocation!.runId))
        ?.retentionProtected,
      false,
    );
    const pruned = await manifest.prune({
      now: new Date("2026-09-01T00:00:00.000Z"),
      maximumRows: 100,
    });
    assert.ok(pruned.invocationSummariesDeleted >= 1);
    assert.ok(pruned.tombstonesDeleted >= 1);
    assert.equal(await manifest.loadInvocation(oldAdmission.invocation!.runId), null);

    const capNow = new Date("2026-09-02T00:00:00.000Z");
    const capIssuedAt = new Date("2026-08-31T00:00:00.000Z");
    const capStartedAt = new Date("2026-09-01T00:00:00.000Z");
    const capFinishedAt = new Date("2026-09-01T00:00:01.000Z");
    await harness.client.$executeRaw(CentralPrisma.sql`
      insert into manifest_reconciliation_job_invocations (
        delivery_key_digest, trigger_evidence_digest, delivery_issued_at,
        delivery_expires_at, trigger_kind, lifecycle_state, outcome,
        requested_at, started_at, finished_at, related_attempt_set_digest,
        retention_protected, created_at, updated_at
      )
      select
        encode(sha256(convert_to('manifest-cap-delivery:' || ordinal, 'UTF8')),
          'hex'),
        encode(sha256(convert_to('manifest-cap-trigger:' || ordinal, 'UTF8')),
          'hex'),
        ${capIssuedAt},
        ${new Date(
          capIssuedAt.getTime() + PROMOTION_JOB_DELIVERY_RETENTION_MS,
        )},
        'manual', 'terminal', 'no_change', ${capStartedAt}, ${capStartedAt},
        ${capFinishedAt}, ${EMPTY_PROMOTION_ATTEMPT_SET_DIGEST}, true,
        ${capStartedAt}, ${capFinishedAt}
      from generate_series(
        1,
        ${PROMOTION_JOB_INVOCATION_LIMIT + 1}
      ) ordinal
    `);
    assert.deepEqual(await manifest.releasePrunableRetentionProtection({
      now: capNow,
      maximumRows: 1,
    }), { released: 1, moreEligible: false });
    const capPrune = await manifest.prune({
      now: capNow,
      maximumRows: 2,
    });
    assert.equal(capPrune.invocationSummariesDeleted, 2);
    assert.equal(
      await harness.client.manifest_reconciliation_job_invocations.count({
        where: { lifecycle_state: "terminal" },
      }),
      PROMOTION_JOB_INVOCATION_LIMIT,
      "released overflow converges to the total terminal-row cap",
    );

    assert.deepEqual(await projections.pruneScheduled({
      now: new Date("2026-10-04T00:00:00.000Z"),
      maximumRows: 100,
    }), { deleted: 2, moreEligible: false });
    assert.equal(
      await harness.client.provider_promotion_invocation_projections.count(),
      0,
    );
    const overflowDetail = '{"attempts":[]}';
    await harness.client.$executeRaw(CentralPrisma.sql`
      insert into provider_promotion_invocation_projections (
        provider_id, organization_id, provider_invocation_id_digest,
        projection_digest,
        trigger_kind, outcome, scheduled_checkin_at, started_at, finished_at,
        before_lane_position, after_lane_position,
        before_settled_position, after_settled_position,
        cycle_count, promotion_attempt_count, publication_count,
        operation_count, safe_failure_code, canonical_detail_body,
        canonical_detail_digest, projected_at, created_at
      )
      select
        ${providerOne}::uuid,
        ${organizationId}::uuid,
        encode(sha256(convert_to('overflow-invocation:' || ordinal, 'UTF8')),
          'hex'),
        encode(sha256(convert_to('overflow-projection:' || ordinal, 'UTF8')),
          'hex'),
        'manual', 'no_change', null,
        ${new Date("2026-09-01T00:00:00.000Z")},
        ${new Date("2026-09-01T00:00:01.000Z")},
        null, null, null, null, 0, 0, 0, 0, null,
        ${overflowDetail},
        encode(sha256(convert_to(${overflowDetail}, 'UTF8')), 'hex'),
        ${new Date("2026-09-01T00:00:02.000Z")},
        ${new Date("2026-09-01T00:00:02.000Z")}
      from generate_series(
        1,
        ${PROMOTION_JOB_INVOCATION_LIMIT + 1}
      ) ordinal
    `);
    await harness.client.$executeRaw(CentralPrisma.sql`
      update provider_promotion_projection_retention_state
      set after_provider_id = ${providerOne}::uuid,
          row_version = row_version + 1,
          updated_at = greatest(
            updated_at + interval '1 microsecond',
            clock_timestamp()
          )
      where singleton_key = true
    `);
    const [cursorBefore] = await harness.client.$queryRaw<Array<{
      afterProviderId: string | null;
      rowVersion: bigint;
      updatedAt: Date;
    }>>(CentralPrisma.sql`
      select after_provider_id::text as "afterProviderId",
        row_version as "rowVersion", updated_at as "updatedAt"
      from provider_promotion_projection_retention_state
      where singleton_key = true
    `);
    assert.equal(cursorBefore?.afterProviderId, providerOne);
    assert.deepEqual(await projections.pruneScheduled({
      now: new Date("2000-01-01T00:00:00.000Z"),
      maximumRows: 1,
    }), { deleted: 0, moreEligible: false });
    const [cursorAfter] = await harness.client.$queryRaw<Array<{
      afterProviderId: string | null;
      rowVersion: bigint;
      updatedAt: Date;
    }>>(CentralPrisma.sql`
      select after_provider_id::text as "afterProviderId",
        row_version as "rowVersion", updated_at as "updatedAt"
      from provider_promotion_projection_retention_state
      where singleton_key = true
    `);
    assert.equal(cursorAfter?.afterProviderId, null);
    assert.equal(cursorAfter?.rowVersion, cursorBefore!.rowVersion + 1n);
    assert.ok(cursorAfter!.updatedAt.getTime() > cursorBefore!.updatedAt.getTime());
    assert.deepEqual(await projections.pruneScheduled({
      now: new Date("2026-09-02T00:00:00.000Z"),
      maximumRows: 100,
    }), { deleted: 1, moreEligible: false });
    assert.equal(
      await harness.client.provider_promotion_invocation_projections.count(),
      PROMOTION_JOB_INVOCATION_LIMIT,
    );
  } finally {
    await harness.close();
  }
});

test("manifest recovery sweep terminalizes cron and manual orphans before later work", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    const repository = new PrismaManifestReconciliationJobRepository(
      harness.client,
    );
    const baselineAt = new Date("2026-01-01T00:00:00.000Z");
    await repository.activateSchedule({
      scheduleEpoch: 1n,
      baselineAt,
      activatedAt: baselineAt,
    });
    const manualInput = beginInput({
      opaqueKey: "manifest-expired-manual",
      now: baselineAt,
    });
    const manualOrphan = await repository.beginOrRecoverInvocation(manualInput);
    const firstDueAt = new Date(baselineAt.getTime() + 60_000);
    const orphanInput = beginInput({
      opaqueKey: "manifest-expired-cron-window-one",
      now: firstDueAt,
      trigger: {
        kind: "reconciliation_cron",
        scheduleEpoch: 1n,
        scheduleWindowIndex: 1n,
        scheduledDueAt: firstDueAt,
      },
    });
    const orphan = await repository.beginOrRecoverInvocation(orphanInput);
    const reconciledAt = orphanInput.ownershipExpiresAt;

    assert.deepEqual(await repository.reconcileExpiredInvocations({
      reconciledAt,
      maximumRows: 1,
    }), { reconciled: 1, moreEligible: true });
    const manualTerminal = await repository.loadInvocation(
      manualOrphan.invocation!.runId,
    );
    assert.deepEqual({
      triggerKind: manualTerminal?.trigger.kind,
      lifecycleState: manualTerminal?.lifecycleState,
      outcome: manualTerminal?.outcome,
      safeFailureCode: manualTerminal?.safeFailureCode,
      retentionProtected: manualTerminal?.retentionProtected,
    }, {
      triggerKind: "manual",
      lifecycleState: "terminal",
      outcome: "continuation_required",
      safeFailureCode: "MANIFEST_RECONCILIATION_INTERRUPTED",
      retentionProtected: true,
    });
    assert.deepEqual(await repository.reconcileExpiredInvocations({
      reconciledAt,
      maximumRows: 1,
    }), { reconciled: 1, moreEligible: false });
    const terminal = await repository.loadInvocation(orphan.invocation!.runId);
    assert.deepEqual({
      lifecycleState: terminal?.lifecycleState,
      outcome: terminal?.outcome,
      safeFailureCode: terminal?.safeFailureCode,
      retentionProtected: terminal?.retentionProtected,
    }, {
      lifecycleState: "terminal",
      outcome: "continuation_required",
      safeFailureCode: "MANIFEST_RECONCILIATION_INTERRUPTED",
      retentionProtected: true,
    });
    assert.equal((await repository.loadWakeIntent()).pending, true);
    assert.deepEqual(await repository.reconcileExpiredInvocations({
      reconciledAt,
      maximumRows: 1,
    }), { reconciled: 0, moreEligible: false });

    const secondDueAt = new Date(baselineAt.getTime() + 120_000);
    const laterInput = beginInput({
      opaqueKey: "manifest-cron-window-two-after-recovery",
      now: secondDueAt,
      trigger: {
        kind: "reconciliation_cron",
        scheduleEpoch: 1n,
        scheduleWindowIndex: 2n,
        scheduledDueAt: secondDueAt,
      },
    });
    const later = await repository.beginOrRecoverInvocation(laterInput);
    assert.equal(later.disposition, "started");
    await repository.terminalize({
      runId: later.invocation!.runId,
      ownershipToken: laterInput.ownershipToken,
      finishedAt: new Date(secondDueAt.getTime() + 1_000),
      outcome: "no_change",
      resultActiveGeneration: 0n,
    });
    assert.equal((await repository.loadSchedule()).lastAdmittedWindowIndex, 2n);

    const pruneAt = new Date(
      reconciledAt.getTime() + PROMOTION_JOB_INVOCATION_RETENTION_MS + 1,
    );
    assert.deepEqual(await repository.releasePrunableRetentionProtection({
      now: pruneAt,
      maximumRows: 10,
    }), { released: 2, moreEligible: false });
    const pruned = await repository.prune({ now: pruneAt, maximumRows: 10 });
    assert.equal(pruned.invocationSummariesDeleted, 2);
    assert.equal(
      await repository.loadInvocation(manualOrphan.invocation!.runId),
      null,
    );
    assert.equal(await repository.loadInvocation(orphan.invocation!.runId), null);
  } finally {
    await harness.close();
  }
});
