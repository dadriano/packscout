import assert from "node:assert/strict";
import test from "node:test";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  PrismaPromotionJobLivenessRepository,
  PrismaPromotionJobLivenessRosterRepository,
  type PromotionJobLivenessRosterSnapshotRecord,
  type PromotionJobScheduleHealthRecord,
  type PromotionJobScheduleLivenessRecord,
  type ProviderPromotionLivenessObservationRecord,
  type SuccessfulPromotionJobLivenessCycleRecord,
} from "./promotion-job-liveness-repository.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const organizationA = "81000000-0000-4000-8000-000000000001";
const organizationB = "81000000-0000-4000-8000-000000000002";
const providerA = "82000000-0000-4000-8000-000000000001";
const providerB = "82000000-0000-4000-8000-000000000002";
const providerDisabled = "82000000-0000-4000-8000-000000000003";
const baseline = new Date("2026-09-01T12:00:00.000Z");

interface ConditionProjection {
  subject_kind: "provider_schedule" | "manifest_schedule";
  subject_key: string;
  organization_id: string | null;
  provider_id: string | null;
  schedule_epoch: bigint;
  condition_state: "active" | "resolved";
  delivery_action: "raise" | "recover" | null;
  delivery_state: "pending" | "retry_wait" | "delivered" | null;
  delivery_attempt_count: number;
}

async function seed(central: CentralPrismaClient): Promise<void> {
  await central.organizations.createMany({
    data: [{
      id: organizationA,
      slug: "promotion-liveness-a",
      name: "Promotion liveness A",
    }, {
      id: organizationB,
      slug: "promotion-liveness-b",
      name: "Promotion liveness B",
    }],
  });
  // This test observes roster/condition behavior, not activation graph setup.
  // Disable only the deferred activation guard while inserting exact fixture
  // lifecycles; every liveness FK and row-version trigger remains enabled.
  await central.$executeRawUnsafe(
    'alter table "providers" disable trigger "providers_exact_activation_guard"',
  );
  try {
    await central.providers.createMany({
      data: [{
        id: providerA,
        organization_id: organizationA,
        provider_key: "provider_a",
        display_name: "Provider A",
        lifecycle: "active",
      }, {
        id: providerB,
        organization_id: organizationB,
        provider_key: "provider_b",
        display_name: "Provider B",
        lifecycle: "active",
      }, {
        id: providerDisabled,
        organization_id: organizationA,
        provider_key: "provider_disabled",
        display_name: "Provider disabled",
        lifecycle: "disabled",
      }],
    });
  } finally {
    await central.$executeRawUnsafe(
      'alter table "providers" enable trigger "providers_exact_activation_guard"',
    );
  }
}

function judgment(input: Readonly<{
  evaluatedAt: Date;
  health?: PromotionJobScheduleHealthRecord;
  lifecycle?: "pending_activation" | "active" | "paused";
  epoch?: bigint;
  lastCheckinAt?: Date | null;
}>): PromotionJobScheduleLivenessRecord {
  const lifecycle = input.lifecycle ?? "active";
  const health = lifecycle === "active" ? input.health ?? "healthy" : "inactive";
  const latest = lifecycle === "active" ? 3n : 0n;
  const missed = health === "alerting" ? 3n : health === "overdue" ? 2n : 0n;
  return {
    lifecycle,
    scheduleEpoch: input.epoch ?? (lifecycle === "pending_activation" ? 0n : 1n),
    health,
    latestCountableWindowIndex: latest,
    lastAdmittedWindowIndex: latest - missed,
    missedWindowCount: missed,
    lastScheduledCheckinAt: input.lastCheckinAt ?? null,
    evaluatedAt: input.evaluatedAt,
  };
}

function cycle(input: Readonly<{
  evaluatedAt: Date;
  roster: PromotionJobLivenessRosterSnapshotRecord;
  providerJudgments: Readonly<Record<string,
    PromotionJobScheduleLivenessRecord | "unavailable">>;
  manifest: PromotionJobScheduleLivenessRecord;
}>): SuccessfulPromotionJobLivenessCycleRecord {
  const providerObservations: ProviderPromotionLivenessObservationRecord[] =
    input.roster.providers.map((provider) => {
      const value = input.providerJudgments[provider.providerId];
      if (value === undefined) throw new Error("Missing provider fixture.");
      return value === "unavailable"
        ? {
            provider,
            observedAt: new Date(input.evaluatedAt.getTime() + 5),
            failureCode: "database_unreachable",
            observation: { evidenceSource: "unavailable", judgment: null },
          }
        : {
            provider,
            observedAt: new Date(input.evaluatedAt.getTime() + 5),
            failureCode: null,
            observation: { evidenceSource: "live", judgment: value },
          };
    });
  const live = [
    ...providerObservations
      .filter(({ observation }) => observation.evidenceSource === "live")
      .map(({ observation }) => observation.judgment!),
    input.manifest,
  ];
  const count = (health: PromotionJobScheduleHealthRecord): number =>
    live.filter((row) => row.health === health).length;
  const healthyCount = count("healthy") + count("inactive");
  const unavailableCount = providerObservations.length - (live.length - 1);
  return {
    evaluatedAt: input.evaluatedAt,
    roster: input.roster,
    providerObservations,
    manifestObservation: {
      observedAt: new Date(input.evaluatedAt.getTime() + 10),
      judgment: input.manifest,
    },
    summary: {
      expectedCount: input.roster.providers.length + 1,
      reachableCount: live.length,
      unavailableCount,
      healthyCount,
      overdueCount: count("overdue"),
      alertingCount: count("alerting"),
    },
  };
}

async function conditions(
  central: CentralPrismaClient,
): Promise<readonly ConditionProjection[]> {
  return central.$queryRaw<ConditionProjection[]>`
    select subject_kind, subject_key, organization_id, provider_id,
      schedule_epoch, condition_state, delivery_action, delivery_state,
      delivery_attempt_count
    from promotion_job_liveness_conditions
    order by subject_kind, subject_key, schedule_epoch
  `;
}

test("dynamic roster pagination is complete and fails closed at capacity", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await seed(harness.client);
    const paged = new PrismaPromotionJobLivenessRosterRepository(
      harness.client,
      { pageSize: 1, maximumProviders: 2 },
    );
    const first = await paged.captureEligibleRoster();
    const second = await paged.captureEligibleRoster();
    assert.deepEqual(
      first.providers.map(({ providerId }) => providerId),
      [providerA, providerB],
    );
    assert.equal(first.rosterDigest, second.rosterDigest);
    assert.ok(second.rosterVersion >= first.rosterVersion);
    await assert.rejects(
      new PrismaPromotionJobLivenessRosterRepository(
        harness.client,
        { pageSize: 1, maximumProviders: 1 },
      ).captureEligibleRoster(),
      /exceeds evaluator capacity/u,
    );
    const providerBeforeArchive = await harness.client.providers.findUniqueOrThrow({
      where: { id: providerB },
      select: { updated_at: true },
    });
    await harness.client.providers.update({
      where: { id: providerB },
      data: {
        lifecycle: "archived",
        row_version: { increment: 1 },
        updated_at: new Date(providerBeforeArchive.updated_at.getTime() + 1),
      },
    });
    const changed = await paged.captureEligibleRoster();
    assert.deepEqual(changed.providers.map(({ providerId }) => providerId), [providerA]);
    assert.notEqual(changed.rosterDigest, first.rosterDigest);
  } finally {
    await harness.close();
  }
});

test("central liveness keeps last-known evidence and isolates durable alert episodes", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await seed(harness.client);
    const roster = await new PrismaPromotionJobLivenessRosterRepository(
      harness.client,
      { pageSize: 1, maximumProviders: 2 },
    ).captureEligibleRoster();
    const repository = new PrismaPromotionJobLivenessRepository(harness.client);
    const firstAt = new Date("2026-09-01T12:03:00.001Z");
    await assert.rejects(repository.activateEvaluator({
      evaluatorEpoch: 1n,
      baselineAt: baseline,
      activatedAt: firstAt,
    }), /requires one complete successful cycle/u);
    const first = cycle({
      evaluatedAt: firstAt,
      roster,
      providerJudgments: {
        [providerA]: judgment({
          evaluatedAt: firstAt,
          health: "alerting",
          lastCheckinAt: new Date("2026-09-01T12:00:00.000Z"),
        }),
        [providerB]: judgment({
          evaluatedAt: firstAt,
          lastCheckinAt: new Date("2026-09-01T12:03:00.000Z"),
        }),
      },
      manifest: judgment({
        evaluatedAt: firstAt,
        health: "alerting",
        lastCheckinAt: new Date("2026-09-01T12:00:00.000Z"),
      }),
    });
    const independent = await harness.createIndependentLifecycle();
    const concurrent = new PrismaPromotionJobLivenessRepository(independent.client);
    const committed = await Promise.allSettled([
      repository.commitSuccessfulCycle(first),
      concurrent.commitSuccessfulCycle(first),
    ]);
    assert.ok(committed.some(({ status }) => status === "fulfilled"));
    assert.deepEqual((await conditions(harness.client)).map((row) => [
      row.subject_kind,
      row.organization_id,
      row.provider_id,
      row.condition_state,
      row.delivery_action,
      row.delivery_state,
    ]), [
      ["manifest_schedule", null, null, "active", "raise", "pending"],
      ["provider_schedule", organizationA, providerA, "active", "raise", "pending"],
    ]);
    assert.deepEqual(await repository.readWatchdogEvidence(), {
      lifecycle: "pending_activation",
      evaluatorEpoch: 0n,
      cadenceSeconds: 60,
      baselineAt: null,
      lastSuccessfulWindowIndex: null,
      lastSuccessfulEvaluationAt: null,
      evaluatedThrough: null,
      rosterDigest: null,
      expectedCount: null,
      reachableCount: null,
      unavailableCount: null,
    });
    await repository.activateEvaluator({
      evaluatorEpoch: 1n,
      baselineAt: baseline,
      activatedAt: firstAt,
    });
    assert.deepEqual(await repository.readWatchdogEvidence(), {
      lifecycle: "active",
      evaluatorEpoch: 1n,
      cadenceSeconds: 60,
      baselineAt: baseline,
      lastSuccessfulWindowIndex: 3n,
      lastSuccessfulEvaluationAt: firstAt,
      evaluatedThrough: firstAt,
      rosterDigest: roster.rosterDigest,
      expectedCount: 3,
      reachableCount: 3,
      unavailableCount: 0,
    });

    const pending = await repository.listPendingConditionDeliveries({
      now: firstAt,
      limit: 10,
    });
    assert.deepEqual(pending.map(({ scope }) => scope).sort(), ["provider", "system"]);
    const providerRaise = pending.find(({ scope }) => scope === "provider")!;
    assert.equal(await repository.recordConditionDeliveryAttempt({
      conditionId: providerRaise.conditionId,
      eventId: providerRaise.eventId,
      attemptedAt: new Date(firstAt.getTime() + 100),
    }), true);
    // Simulate a publish whose acknowledgement was lost. The durable attempt
    // marker makes later recovery conservative without opening a second event.
    const systemRaise = pending.find(({ scope }) => scope === "system")!;
    const systemAttemptedAt = new Date(firstAt.getTime() + 200);
    const systemRetryAt = new Date(firstAt.getTime() + 30_200);
    assert.equal(await repository.recordConditionDeliveryAttempt({
      conditionId: systemRaise.conditionId,
      eventId: systemRaise.eventId,
      attemptedAt: systemAttemptedAt,
    }), true);
    assert.equal(await repository.recordConditionDeliveryResult({
      conditionId: systemRaise.conditionId,
      eventId: systemRaise.eventId,
      attemptedAt: systemAttemptedAt,
      result: {
        state: "retry_wait",
        failureCode: "SYSTEM_SINK_OFFLINE",
        retryAt: systemRetryAt,
      },
    }), true);
    assert.equal((await repository.listPendingConditionDeliveries({
      now: new Date(systemRetryAt.getTime() - 1),
      limit: 10,
    })).some(({ eventId }) => eventId === systemRaise.eventId), false);
    assert.equal((await repository.listPendingConditionDeliveries({
      now: systemRetryAt,
      limit: 10,
    })).some(({ eventId }) => eventId === systemRaise.eventId), true);
    assert.equal(await repository.recordConditionDeliveryAttempt({
      conditionId: systemRaise.conditionId,
      eventId: systemRaise.eventId,
      attemptedAt: systemRetryAt,
    }), true);
    assert.equal(await repository.recordConditionDeliveryResult({
      conditionId: systemRaise.conditionId,
      eventId: systemRaise.eventId,
      attemptedAt: systemRetryAt,
      result: { state: "delivered" },
    }), true);

    const outageAt = new Date("2026-09-01T12:04:00.001Z");
    await repository.commitSuccessfulCycle(cycle({
      evaluatedAt: outageAt,
      roster,
      providerJudgments: {
        [providerA]: "unavailable",
        [providerB]: judgment({
          evaluatedAt: outageAt,
          lastCheckinAt: new Date("2026-09-01T12:04:00.000Z"),
        }),
      },
      manifest: judgment({
        evaluatedAt: outageAt,
        lastCheckinAt: new Date("2026-09-01T12:04:00.000Z"),
      }),
    }));
    const retained = await repository.readObservation(`provider:${providerA}`);
    assert.equal(retained?.evidenceSource, "last_known");
    assert.equal(retained?.routeFailureCode, "DATABASE_UNREACHABLE");
    assert.equal(retained?.judgment?.health, "alerting");
    assert.equal(
      (await conditions(harness.client)).find(({ provider_id }) =>
        provider_id === providerA)?.condition_state,
      "active",
    );

    const replayAt = new Date("2026-09-01T12:05:00.001Z");
    await repository.commitSuccessfulCycle(cycle({
      evaluatedAt: replayAt,
      roster,
      providerJudgments: {
        [providerA]: judgment({
          evaluatedAt: replayAt,
          lastCheckinAt: new Date("2026-09-01T12:00:00.000Z"),
        }),
        [providerB]: judgment({ evaluatedAt: replayAt }),
      },
      manifest: judgment({ evaluatedAt: replayAt }),
    }));
    assert.equal(
      (await conditions(harness.client)).find(({ provider_id }) =>
        provider_id === providerA)?.condition_state,
      "active",
      "reachability plus stale cron evidence must not recover",
    );

    const recoveredAt = new Date("2026-09-01T12:06:00.001Z");
    await repository.commitSuccessfulCycle(cycle({
      evaluatedAt: recoveredAt,
      roster,
      providerJudgments: {
        [providerA]: judgment({
          evaluatedAt: recoveredAt,
          lastCheckinAt: new Date("2026-09-01T12:06:00.000Z"),
        }),
        [providerB]: judgment({ evaluatedAt: recoveredAt }),
      },
      manifest: judgment({ evaluatedAt: recoveredAt }),
    }));
    const providerCondition = (await conditions(harness.client))
      .find(({ provider_id }) => provider_id === providerA)!;
    assert.deepEqual([
      providerCondition.condition_state,
      providerCondition.delivery_action,
      providerCondition.delivery_state,
    ], ["resolved", "recover", "pending"]);

    const bAlertingAt = new Date("2026-09-01T12:08:00.001Z");
    await repository.commitSuccessfulCycle(cycle({
      evaluatedAt: bAlertingAt,
      roster,
      providerJudgments: {
        [providerA]: judgment({ evaluatedAt: bAlertingAt }),
        [providerB]: judgment({
          evaluatedAt: bAlertingAt,
          health: "alerting",
          epoch: 2n,
        }),
      },
      manifest: judgment({ evaluatedAt: bAlertingAt }),
    }));
    const bPausedAt = new Date("2026-09-01T12:09:00.001Z");
    await repository.commitSuccessfulCycle(cycle({
      evaluatedAt: bPausedAt,
      roster,
      providerJudgments: {
        [providerA]: judgment({ evaluatedAt: bPausedAt }),
        [providerB]: judgment({
          evaluatedAt: bPausedAt,
          lifecycle: "paused",
          epoch: 2n,
        }),
      },
      manifest: judgment({ evaluatedAt: bPausedAt }),
    }));
    const pausedCondition = (await conditions(harness.client))
      .find(({ provider_id, schedule_epoch }) =>
        provider_id === providerB && schedule_epoch === 2n)!;
    assert.deepEqual([
      pausedCondition.condition_state,
      pausedCondition.delivery_action,
      pausedCondition.delivery_state,
    ], ["resolved", null, null], "pause cancels a never-attempted open");

    const evaluator = await repository.readEvaluatorState();
    assert.deepEqual([
      evaluator.expectedCount,
      evaluator.reachableCount,
      evaluator.unavailableCount,
      evaluator.lastSuccessfulWindowIndex,
    ], [3, 3, 0, 9n]);
    assert.deepEqual(await repository.readWatchdogEvidence(), {
      lifecycle: "active",
      evaluatorEpoch: 1n,
      cadenceSeconds: 60,
      baselineAt: baseline,
      lastSuccessfulWindowIndex: 9n,
      lastSuccessfulEvaluationAt: bPausedAt,
      evaluatedThrough: bPausedAt,
      rosterDigest: roster.rosterDigest,
      expectedCount: 3,
      reachableCount: 3,
      unavailableCount: 0,
    });

    const beforeFailure = await repository.readObservation(`provider:${providerA}`);
    await repository.recordFailedCycle({
      evaluatedAt: new Date("2026-09-01T12:10:00.001Z"),
      failureCode: "registry_enumeration_failed",
      roster: null,
    });
    const failed = await repository.readEvaluatorState();
    assert.equal(failed.state, "failed");
    assert.equal(failed.lastFailureCode, "REGISTRY_ENUMERATION_FAILED");
    assert.deepEqual(
      await repository.readObservation(`provider:${providerA}`),
      beforeFailure,
      "failed cycles retain but stale the last trusted observation",
    );
  } finally {
    await harness.close();
  }
});
