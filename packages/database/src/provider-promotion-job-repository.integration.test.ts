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
  providerPromotionInvocationProjectionRecord,
} from "./central-promotion-job-records.ts";
import { providerActivityEventDigest } from
  "./provider-activity-contract.ts";
import {
  EMPTY_PROMOTION_ATTEMPT_SET_DIGEST,
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  PROMOTION_JOB_INVOCATION_RETENTION_MS,
  PromotionJobPersistenceError,
  promotionJobSha256,
} from "./promotion-job-persistence-types.ts";
import { PrismaProviderActivityOutboxRepository } from
  "./provider-activity-outbox-repository.ts";
import { PrismaProviderPromotionJobRepository } from
  "./provider-promotion-job-repository.ts";

const owner = "provider-promotion-test";

function retainedGenericActivity(eventAt: Date) {
  const identity = {
    id: randomUUID(),
    eventType: "provider.test.retained",
    severity: "info" as const,
    dedupeKey: "provider-test-retained",
    recoveryKey: "provider-test-retained",
    localRunId: null,
    localQuarantineId: null,
    title: "Provider activity remains retained",
    summary: "Generic provider activity is not projection transport.",
    evidence: { state: "retained" },
    eventAt,
  };
  return { ...identity, eventDigest: providerActivityEventDigest(identity) };
}

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
    await first.terminalize({
      runId: started.invocation.runId,
      ownershipToken: firstInput.ownershipToken,
      finishedAt: new Date(base.getTime() + 4_000),
      outcome: "caught_up",
      acknowledgeObservedWake: true,
    });
    assert.equal(
      await pair.first.client.provider_promotion_projection_outbox.count({
        where: { invocation_run_id: terminal.runId },
      }),
      1,
      "terminal replay keeps one durable projection envelope",
    );
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
    const pending = await new PrismaProviderActivityOutboxRepository(
      pair.first.client,
    ).readPendingBatch({ providerId: pair.first.providerId, limit: 10 });
    const projectionEvent = pending.events.find((event) =>
      event.eventType === "provider_promotion_invocation_terminal"
    );
    assert.ok(projectionEvent);
    assert.equal(projectionEvent.localRunId, null);
    assert.doesNotMatch(JSON.stringify(projectionEvent), new RegExp(
      [terminal.runId, attemptId].join("|"),
      "u",
    ));
    const projectionInput = await first.loadProjectionForRelay({
      providerId: pair.first.providerId,
      event: projectionEvent,
      projectedAt: new Date(base.getTime() + 5_000),
    });
    const projection = providerPromotionInvocationProjectionRecord(
      projectionInput,
    );
    await assert.rejects(first.acknowledgeProjectionDelivery({
      providerId: pair.first.providerId,
      event: projectionEvent,
      projected: {
        ...projection,
        projectionDigest: promotionJobSha256("wrong-central-projection"),
      },
      deliveredAt: new Date(base.getTime() + 5_000),
    }), code("PROMOTION_JOB_PROJECTION_CONFLICT"));
    assert.equal(
      (await first.loadInvocation(terminal.runId))?.retentionProtected,
      true,
      "an inexact central receipt cannot release provider-local evidence",
    );
    assert.deepEqual((await Promise.all([
      first.acknowledgeProjectionDelivery({
        providerId: pair.first.providerId,
        event: projectionEvent,
        projected: projection,
        deliveredAt: new Date(base.getTime() + 5_000),
      }),
      concurrent.acknowledgeProjectionDelivery({
        providerId: pair.first.providerId,
        event: projectionEvent,
        projected: projection,
        deliveredAt: new Date(base.getTime() + 5_001),
      }),
    ])).sort(), ["already_delivered", "delivered"]);
    assert.equal(
      (await first.loadInvocation(terminal.runId))?.retentionProtected,
      false,
    );
    await assert.rejects(
      pair.first.client.provider_activity_outbox.delete({
        where: { id: projectionEvent.id },
      }),
      /provider_activity_outbox_history_immutable/u,
      "a delivered projection envelope stays immutable while mapped",
    );

    await pair.first.client.provider_promotion_job_invocations.delete({
      where: { run_id: terminal.runId },
    });
    assert.equal(
      await pair.first.client.provider_promotion_projection_outbox.count({
        where: { activity_event_id: projectionEvent.id },
      }),
      0,
      "invocation pruning cascades the provider-local relay mapping",
    );
    const prunedReplay = await first.beginOrRecoverInvocation(firstInput);
    assert.equal(prunedReplay.disposition, "existing_pruned");
    await first.prune({
      now: new Date(
        projectionEvent.eventAt.getTime()
          + PROMOTION_JOB_DELIVERY_RETENTION_MS - 1,
      ),
      maximumRows: 1,
    });
    assert.ok(await pair.first.client.provider_activity_outbox.findUnique({
      where: { id: projectionEvent.id },
    }), "an orphan projection envelope remains before its 30-day boundary");

    const genericActivity = retainedGenericActivity(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await pair.first.client.provider_activity_outbox.create({
      data: {
        id: genericActivity.id,
        event_digest: genericActivity.eventDigest,
        event_type: genericActivity.eventType,
        severity: genericActivity.severity,
        dedupe_key: genericActivity.dedupeKey,
        recovery_key: genericActivity.recoveryKey,
        local_run_id: null,
        local_quarantine_id: null,
        title: genericActivity.title,
        summary: genericActivity.summary,
        evidence: genericActivity.evidence,
        event_at: genericActivity.eventAt,
        delivery_state: "delivered",
        delivery_attempt_count: 1,
        last_delivery_attempt_at: genericActivity.eventAt,
        delivered_at: genericActivity.eventAt,
        created_at: genericActivity.eventAt,
        updated_at: genericActivity.eventAt,
      },
    });
    await assert.rejects(
      pair.first.client.provider_activity_outbox.delete({
        where: { id: genericActivity.id },
      }),
      /provider_activity_outbox_history_immutable/u,
      "the narrow guard exception never applies to generic activity",
    );

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
    const remainingProjectionEvents =
      await new PrismaProviderActivityOutboxRepository(pair.first.client)
        .readPendingBatch({ providerId: pair.first.providerId, limit: 100 });
    for (const event of remainingProjectionEvents.events) {
      if (event.eventType !== "provider_promotion_invocation_terminal") {
        continue;
      }
      const input = await first.loadProjectionForRelay({
        providerId: pair.first.providerId,
        event,
        projectedAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      await first.acknowledgeProjectionDelivery({
        providerId: pair.first.providerId,
        event,
        projected: providerPromotionInvocationProjectionRecord(input),
        deliveredAt: new Date("2026-09-01T00:00:00.000Z"),
      });
    }
    const eligibleProjectionEventsBefore =
      await pair.first.client.provider_activity_outbox.count({
        where: {
          event_type: "provider_promotion_invocation_terminal",
          delivery_state: "delivered",
        },
      });
    const prune = await first.prune({
      now: new Date("2026-09-01T00:00:00.000Z"),
      maximumRows: 1,
    });
    const eligibleProjectionEventsAfter =
      await pair.first.client.provider_activity_outbox.count({
        where: {
          event_type: "provider_promotion_invocation_terminal",
          delivery_state: "delivered",
        },
      });
    assert.equal(prune.invocationSummariesDeleted, 1);
    assert.equal(prune.tombstonesDeleted, 1);
    assert.equal(
      eligibleProjectionEventsBefore - eligibleProjectionEventsAfter,
      1,
      "one retention pass deletes at most its bounded event volume",
    );
    assert.equal(await first.loadInvocation(oldAdmission.invocation!.runId), null);
    await first.prune({
      now: new Date("2026-09-01T00:00:00.000Z"),
      maximumRows: 100,
    });
    assert.equal(
      await pair.first.client.provider_activity_outbox.findUnique({
        where: { id: projectionEvent.id },
      }),
      null,
      "an acknowledged orphan projection envelope expires after 30 days",
    );
    assert.ok(await pair.first.client.provider_activity_outbox.findUnique({
      where: { id: genericActivity.id },
    }), "generic provider activity remains immutable and retained");

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

test("provider recovery sweep terminalizes cron and manual orphans before later work", async () => {
  const harness = await createProviderHarness();
  try {
    const repository = new PrismaProviderPromotionJobRepository(harness.client);
    const baselineAt = new Date("2026-01-01T00:00:00.000Z");
    await repository.activateSchedule({
      scheduleEpoch: 1n,
      baselineAt,
      activatedAt: baselineAt,
    });
    const manualInput = beginInput({
      opaqueKey: "provider-expired-manual",
      now: baselineAt,
    });
    const manualOrphan = await repository.beginOrRecoverInvocation(manualInput);
    const firstDueAt = new Date(baselineAt.getTime() + 60_000);
    const orphanInput = beginInput({
      opaqueKey: "provider-expired-cron-window-one",
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
      safeFailureCode: "PROVIDER_PROMOTION_INTERRUPTED",
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
      safeFailureCode: "PROVIDER_PROMOTION_INTERRUPTED",
      retentionProtected: true,
    });
    assert.equal((await repository.loadWakeIntent()).pending, true);
    assert.equal(
      await harness.client.provider_promotion_projection_outbox.count({
        where: {
          invocation_run_id: {
            in: [manualOrphan.invocation!.runId, orphan.invocation!.runId],
          },
        },
      }),
      2,
      "each hard-crash reconciliation emits one durable monitoring envelope",
    );
    assert.deepEqual(await repository.reconcileExpiredInvocations({
      reconciledAt,
      maximumRows: 1,
    }), { reconciled: 0, moreEligible: false });

    const secondDueAt = new Date(baselineAt.getTime() + 120_000);
    const laterInput = beginInput({
      opaqueKey: "provider-cron-window-two-after-recovery",
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
    });
    assert.equal((await repository.loadSchedule()).lastAdmittedWindowIndex, 2n);

    const pending = await new PrismaProviderActivityOutboxRepository(
      harness.client,
    ).readPendingBatch({ providerId: harness.providerId, limit: 10 });
    for (const recovered of [manualOrphan, orphan]) {
      const mapping = await harness.client.provider_promotion_projection_outbox
        .findUniqueOrThrow({
          where: { invocation_run_id: recovered.invocation!.runId },
        });
      const event = pending.events.find(
        ({ id }) => id === mapping.activity_event_id,
      );
      assert.ok(event);
      const projectionInput = await repository.loadProjectionForRelay({
        providerId: harness.providerId,
        event,
        projectedAt: new Date(reconciledAt.getTime() + 1_000),
      });
      await repository.acknowledgeProjectionDelivery({
        providerId: harness.providerId,
        event,
        projected: providerPromotionInvocationProjectionRecord(projectionInput),
        deliveredAt: new Date(reconciledAt.getTime() + 1_000),
      });
      assert.equal(
        (await repository.loadInvocation(recovered.invocation!.runId))
          ?.retentionProtected,
        false,
      );
    }

    const pruned = await repository.prune({
      now: new Date(
        reconciledAt.getTime() + PROMOTION_JOB_INVOCATION_RETENTION_MS + 1,
      ),
      maximumRows: 10,
    });
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
