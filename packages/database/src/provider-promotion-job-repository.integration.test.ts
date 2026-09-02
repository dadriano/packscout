import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient as ProviderPrismaClient } from
  "../prisma/generated/provider/index.js";
import {
  createProviderHarness,
  type ProviderHarness,
} from "./provider-canonical-integration-support.ts";
import {
  EMPTY_PROMOTION_ATTEMPT_SET_DIGEST,
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  PromotionJobPersistenceError,
  promotionJobSha256,
} from "./promotion-job-persistence-types.ts";
import { PrismaProviderPromotionJobRepository } from
  "./provider-promotion-job-repository.ts";

const owner = "provider-promotion-test";

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
  token?: string;
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
    ownershipKey: owner,
    ownershipToken: input.token ?? randomUUID(),
    ownershipExpiresAt: new Date(input.now.getTime() + 60_000),
  };
}

function code(expected: PromotionJobPersistenceError["code"]) {
  return (error: unknown): boolean =>
    error instanceof PromotionJobPersistenceError && error.code === expected;
}

async function twoProviders(): Promise<Readonly<{
  first: ProviderHarness;
  second: ProviderHarness;
  close(): Promise<void>;
}>> {
  const first = await createProviderHarness();
  let second: ProviderHarness | undefined;
  try {
    second = await createProviderHarness();
    return {
      first,
      second,
      async close() {
        await Promise.allSettled([first.close(), second!.close()]);
      },
    };
  } catch (error) {
    await first.close();
    throw error;
  }
}

test("provider-local replay, generation, schedule, detail, and retention converge", async () => {
  const pair = await twoProviders();
  const independent = new ProviderPrismaClient({
    datasources: { db: { url: pair.first.databaseUrl } },
  });
  try {
    await independent.$connect();
    const first = new PrismaProviderPromotionJobRepository(pair.first.client);
    const concurrent = new PrismaProviderPromotionJobRepository(independent);
    const second = new PrismaProviderPromotionJobRepository(pair.second.client);
    const base = new Date("2026-08-01T12:00:00.000Z");

    await assert.rejects(pair.first.client.$transaction(async (transaction) => {
      await first.coalesceWake({
        requestedGeneration: 1n,
        cause: "canonical_settlement",
        requestedAt: base,
      }, transaction);
      throw new Error("causal transaction rollback");
    }));
    assert.equal((await first.loadWakeIntent()).requestedGeneration, 0n);

    await first.coalesceWake({
      requestedGeneration: 1n,
      cause: "canonical_settlement",
      requestedAt: base,
    });
    const deliveryAttemptedAt = new Date(base.getTime() + 100);
    await first.recordWakeDelivery({
      generation: 1n,
      state: "accepted",
      attemptedAt: deliveryAttemptedAt,
    });
    await first.recordWakeDelivery({
      generation: 1n,
      state: "delivered",
      attemptedAt: deliveryAttemptedAt,
    });
    await first.recordWakeDelivery({
      generation: 1n,
      state: "accepted",
      attemptedAt: new Date(deliveryAttemptedAt.getTime() + 100),
    });
    assert.equal((await first.loadWakeIntent()).latestDeliveryState, "delivered");
    const firstInput = beginInput({
      opaqueKey: "shared-provider-delivery",
      now: new Date(base.getTime() + 1_000),
      trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    });
    const admissions = await Promise.all([
      first.beginOrRecoverInvocation(firstInput),
      concurrent.beginOrRecoverInvocation(firstInput),
    ]);
    assert.deepEqual(
      admissions.map((item) => item.disposition).sort(),
      ["existing", "started"],
    );
    const started = admissions.find((item) => item.disposition === "started")!;
    assert.ok(started.invocation);

    await second.coalesceWake({
      requestedGeneration: 1n,
      cause: "canonical_settlement",
      requestedAt: base,
    });
    const independentPhysical = await second.beginOrRecoverInvocation({
      ...firstInput,
      ownershipToken: randomUUID(),
    });
    assert.equal(independentPhysical.disposition, "started");
    assert.notEqual(
      independentPhysical.invocation?.runId,
      started.invocation.runId,
    );
    assert.equal(
      independentPhysical.invocation?.deliveryKeyDigest,
      started.invocation.deliveryKeyDigest,
      "same authority digest is isolated by the physical provider database",
    );

    await first.coalesceWake({
      requestedGeneration: 2n,
      cause: "central_invalidation",
      requestedAt: new Date(base.getTime() + 2_000),
    });
    const replay = await first.beginOrRecoverInvocation(firstInput);
    assert.equal(replay.disposition, "existing");
    assert.equal(replay.invocation?.runId, started.invocation.runId);
    const reconstructedEnvelopeReplay = await first.beginOrRecoverInvocation({
      ...firstInput,
      delivery: delivery(
        firstInput.delivery.opaqueKey,
        new Date(firstInput.delivery.issuedAt.getTime() + 500),
      ),
      requestedAt: new Date(firstInput.requestedAt.getTime() + 500),
      startedAt: new Date(firstInput.startedAt.getTime() + 500),
      now: new Date(firstInput.now.getTime() + 500),
      ownershipExpiresAt: new Date(
        firstInput.ownershipExpiresAt.getTime() + 500,
      ),
    });
    assert.equal(reconstructedEnvelopeReplay.disposition, "existing");
    assert.equal(
      reconstructedEnvelopeReplay.invocation?.runId,
      started.invocation.runId,
    );
    await assert.rejects(first.beginOrRecoverInvocation({
      ...firstInput,
      trigger: { kind: "change_wake", observedWakeGeneration: 2n },
    }), code("PROMOTION_JOB_DELIVERY_CONFLICT"));

    const observedAt = new Date(base.getTime() + 3_000);
    const attemptId = randomUUID();
    await first.recordProgress({
      runId: started.invocation.runId,
      ownershipToken: firstInput.ownershipToken,
      now: observedAt,
      progress: {
        beforeLanePosition: 10n,
        afterLanePosition: 11n,
        beforeSettledPosition: 8n,
        afterSettledPosition: 9n,
        cycleCount: 1,
        promotionAttemptCount: 1,
        publicationCount: 1,
        operationCount: 1,
      },
      attempts: [{
        attemptKind: "provider",
        attemptId,
        observedState: "complete",
        targetPosition: 11n,
        retryCount: 0,
        safeFailureCode: null,
        publicReleaseId: null,
        releaseFingerprint: null,
        totalOperationCount: 1,
        orderedOperationDigest: promotionJobSha256("provider-ordered"),
        recentOperations: [{
          operationIndex: 0,
          operationKind: "publish",
          state: "acknowledged",
          sendCount: 1,
          sentAt: observedAt,
          acknowledgedAt: observedAt,
          operationIdDigest: promotionJobSha256("provider-operation"),
          requestDigest: promotionJobSha256("provider-request"),
          receiptDigest: promotionJobSha256("provider-receipt"),
        }],
        observedAt,
      }],
    });
    const detailed = await first.loadInvocation(started.invocation.runId, {
      includeAttempts: true,
    });
    assert.equal(detailed?.attemptSnapshots?.[0]?.attemptId, attemptId);
    assert.equal(detailed?.progress.afterSettledPosition, 9n);

    const terminal = await first.terminalize({
      runId: started.invocation.runId,
      ownershipToken: firstInput.ownershipToken,
      finishedAt: new Date(base.getTime() + 4_000),
      outcome: "caught_up",
      acknowledgeObservedWake: true,
    });
    assert.equal(terminal.retentionProtected, true);
    assert.deepEqual(
      await first.loadWakeIntent().then((wake) => [
        wake.requestedGeneration,
        wake.acknowledgedGeneration,
        wake.pending,
      ]),
      [2n, 1n, true],
    );
    await assert.rejects(
      pair.first.client.provider_promotion_job_invocations.update({
        where: { run_id: terminal.runId },
        data: { outcome: "failed" },
      }),
      "terminal summaries are immutable outside the retention-release path",
    );
    assert.equal(await first.releaseRetentionProtection({
      runId: terminal.runId,
      releasedAt: new Date(base.getTime() + 5_000),
      expectedRelatedAttemptSetDigest: terminal.relatedAttemptSetDigest,
      validateRelease: async (_transaction, digest) => {
        assert.equal(digest, terminal.relatedAttemptSetDigest);
      },
    }), true);

    await pair.first.client.provider_promotion_job_invocations.delete({
      where: { run_id: terminal.runId },
    });
    const prunedReplay = await first.beginOrRecoverInvocation(firstInput);
    assert.equal(prunedReplay.disposition, "existing_pruned");

    const baselineAt = new Date("2026-08-02T12:00:00.000Z");
    await first.activateSchedule({
      scheduleEpoch: 1n,
      baselineAt,
      activatedAt: baselineAt,
    });
    const dueAt = new Date(baselineAt.getTime() + 60_000);
    const cronInput = beginInput({
      opaqueKey: "provider-cron-window-one",
      now: dueAt,
      trigger: {
        kind: "reconciliation_cron",
        scheduleEpoch: 1n,
        scheduleWindowIndex: 1n,
        scheduledDueAt: dueAt,
      },
    });
    const cron = await first.beginOrRecoverInvocation(cronInput);
    assert.equal(cron.scheduledCheckinAt?.getTime(), dueAt.getTime());
    assert.equal((await first.loadSchedule()).lastAdmittedWindowIndex, 1n);
    await first.terminalize({
      runId: cron.invocation!.runId,
      ownershipToken: cronInput.ownershipToken,
      finishedAt: new Date(dueAt.getTime() + 1_000),
      outcome: "no_change",
    });
    assert.equal(
      (await first.beginOrRecoverInvocation(cronInput)).disposition,
      "existing",
    );
    await assert.rejects(first.beginOrRecoverInvocation(beginInput({
      opaqueKey: "forged-same-window",
      now: new Date(dueAt.getTime() + 2_000),
      trigger: {
        kind: "reconciliation_cron",
        scheduleEpoch: 1n,
        scheduleWindowIndex: 1n,
        scheduledDueAt: dueAt,
      },
    })), code("PROMOTION_JOB_SCHEDULE_INVALID"));
    await first.pauseSchedule({
      scheduleEpoch: 1n,
      pausedAt: new Date(dueAt.getTime() + 3_000),
    });
    assert.equal((await first.loadSchedule()).lifecycle, "paused");
    await first.activateSchedule({
      scheduleEpoch: 2n,
      baselineAt: new Date(dueAt.getTime() + 4_000),
      activatedAt: new Date(dueAt.getTime() + 4_000),
    });
    assert.equal((await first.loadSchedule()).lastAdmittedWindowIndex, null);

    const acknowledgedAt = new Date(dueAt.getTime() + 5_000);
    await first.coalesceWake({
      requestedGeneration: 10n,
      cause: "canonical_settlement",
      requestedAt: acknowledgedAt,
    });
    const acknowledgeInput = beginInput({
      opaqueKey: "provider-acknowledge-generation-ten",
      now: new Date(acknowledgedAt.getTime() + 1_000),
      trigger: { kind: "change_wake", observedWakeGeneration: 10n },
    });
    const acknowledge = await first.beginOrRecoverInvocation(acknowledgeInput);
    await first.terminalize({
      runId: acknowledge.invocation!.runId,
      ownershipToken: acknowledgeInput.ownershipToken,
      finishedAt: new Date(acknowledgedAt.getTime() + 2_000),
      outcome: "caught_up",
      acknowledgeObservedWake: true,
    });
    assert.equal((await first.loadWakeIntent()).pending, false);

    const continuationInput = beginInput({
      opaqueKey: "provider-continuation-after-acknowledged-race",
      now: new Date(acknowledgedAt.getTime() + 3_000),
    });
    const continuation = await first.beginOrRecoverInvocation(
      continuationInput,
    );
    await concurrent.coalesceWake({
      requestedGeneration: 11n,
      cause: "canonical_settlement",
      requestedAt: new Date(acknowledgedAt.getTime() + 3_500),
    });
    const continued = await first.terminalize({
      runId: continuation.invocation!.runId,
      ownershipToken: continuationInput.ownershipToken,
      finishedAt: new Date(acknowledgedAt.getTime() + 4_000),
      outcome: "continuation_required",
      safeFailureCode: "PROVIDER_PROMOTION_DEADLINE",
      continuation: {
        // Deliberately stale: terminalization must advance from the locked
        // generation rather than closing with an acknowledged continuation.
        requestedGeneration: 1n,
        requestedAt: new Date(acknowledgedAt.getTime() + 4_000),
      },
    });
    assert.equal(continued.continuationGeneration, 12n);
    assert.deepEqual(
      await first.loadWakeIntent().then((wake) => [
        wake.requestedGeneration,
        wake.acknowledgedGeneration,
        wake.pending,
      ]),
      [12n, 10n, true],
    );

    const old = new Date("2026-01-01T00:00:00.000Z");
    const oldInput = beginInput({ opaqueKey: "provider-old", now: old });
    const oldAdmission = await first.beginOrRecoverInvocation(oldInput);
    await first.terminalize({
      runId: oldAdmission.invocation!.runId,
      ownershipToken: oldInput.ownershipToken,
      finishedAt: new Date(old.getTime() + 1_000),
      outcome: "coalesced",
    });
    const prune = await first.prune({
      now: new Date("2026-09-01T00:00:00.000Z"),
      maximumRows: 100,
    });
    assert.ok(prune.invocationSummariesDeleted >= 1);
    assert.ok(prune.tombstonesDeleted >= 1);
    assert.equal(await first.loadInvocation(oldAdmission.invocation!.runId), null);

    const expiredAt = new Date("2026-09-01T12:00:00.000Z");
    const scheduleBefore = await first.loadSchedule();
    await assert.rejects(first.beginOrRecoverInvocation({
      ...beginInput({ opaqueKey: "expired-provider", now: expiredAt }),
      delivery: delivery(
        "expired-provider",
        new Date(expiredAt.getTime() - PROMOTION_JOB_DELIVERY_RETENTION_MS),
      ),
    }), code("PROMOTION_JOB_DELIVERY_KEY_EXPIRED"));
    assert.deepEqual(await first.loadSchedule(), scheduleBefore);
    assert.equal(EMPTY_PROMOTION_ATTEMPT_SET_DIGEST.length, 64);
  } finally {
    await independent.$disconnect().catch(() => undefined);
    await pair.close();
  }
});
