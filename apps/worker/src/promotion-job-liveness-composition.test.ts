import assert from "node:assert/strict";
import test from "node:test";
import type {
  CentralPrismaClient,
  PromotionJobLivenessConditionDelivery,
  ProviderPrismaClient,
} from "@packscout/database";
import {
  CentralPromotionJobLivenessConditionPublisher,
  GatewayProviderPromotionScheduleSource,
} from "./promotion-job-liveness-composition.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000001";
const base = new Date("2026-09-01T12:03:00.001Z");

function systemDelivery(): PromotionJobLivenessConditionDelivery {
  return {
    conditionId: "30000000-0000-4000-8000-000000000001",
    eventId: "40000000-0000-4000-8000-000000000001",
    action: "raise",
    scope: "system",
    subject: "manifest_schedule",
    organizationId: null,
    providerId: null,
    scheduleEpoch: 1n,
    missedWindowCount: 3n,
    anchorLastScheduledCheckinAt: null,
    evaluatedAt: base,
    attemptCount: 0,
  };
}

test("provider schedule reads use the exact roster identity through the bounded gateway", async () => {
  const scheduleRow = {
    lifecycle: "active",
    scheduleEpoch: 2n,
    cadenceSeconds: 60,
    baselineAt: new Date("2026-09-01T12:00:00.000Z"),
    activatedAt: new Date("2026-09-01T12:00:00.000Z"),
    pausedAt: null,
    lastAdmittedWindowIndex: 2n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:02:00.000Z"),
    nextExpectedCheckinAt: new Date("2026-09-01T12:03:00.000Z"),
  };
  const provider = {
    $queryRaw: () => Promise.resolve([scheduleRow]),
  } as unknown as ProviderPrismaClient;
  const source = new GatewayProviderPromotionScheduleSource({
    async runWithAdminProviderDatabase(input, operation) {
      assert.deepEqual(input, { organizationId, providerId });
      return {
        state: "reachable",
        providerId,
        value: await operation(provider),
        observedAt: base.toISOString(),
      };
    },
  });
  const result = await source.readSchedule({
    organizationId,
    providerId,
    providerKey: "provider_one",
  });
  assert.equal(result.state, "reachable");
  if (result.state !== "reachable") return;
  assert.equal(result.value.authority, "provider_publication");
  assert.equal(result.value.scheduleEpoch, 2n);
});

test("manifest conditions go only to the external system sink", async () => {
  const received: PromotionJobLivenessConditionDelivery[] = [];
  const publisher = new CentralPromotionJobLivenessConditionPublisher(
    {} as CentralPrismaClient,
    {
      publish(delivery) {
        received.push(delivery);
        return Promise.resolve({ state: "delivered" });
      },
    },
  );
  assert.deepEqual(await publisher.publish(systemDelivery()), {
    state: "delivered",
  });
  assert.deepEqual(received, [systemDelivery()]);
});

test("malformed provider delivery is rejected before any tenant alert write", async () => {
  const publisher = new CentralPromotionJobLivenessConditionPublisher(
    {} as CentralPrismaClient,
    {
      publish: () => Promise.reject(new Error("must not be called")),
    },
  );
  const malformed = {
    ...systemDelivery(),
    scope: "provider" as const,
    subject: "provider_schedule" as const,
  };
  assert.deepEqual(await publisher.publish(malformed), {
    state: "retryable_failure",
    failureCode: "PROMOTION_JOB_CONDITION_SCOPE_INVALID",
  });
});

test("provider condition alerts carry only scoped schedule evidence", async () => {
  const received: unknown[] = [];
  const publisher = new CentralPromotionJobLivenessConditionPublisher(
    {} as CentralPrismaClient,
    {
      publish: () => Promise.reject(new Error("must not receive provider alerts")),
    },
    {
      publish(event) {
        received.push(event);
        return Promise.resolve({
          status: event.kind === "machinery_recovered" ? "resolved" : "accepted",
          alertId: "50000000-0000-4000-8000-000000000001",
          failureCode: null,
        });
      },
    },
  );
  const raised = {
    ...systemDelivery(),
    scope: "provider" as const,
    subject: "provider_schedule" as const,
    organizationId,
    providerId,
  };
  assert.deepEqual(await publisher.publish(raised), { state: "delivered" });
  assert.deepEqual(received[0], {
    id: raised.eventId,
    organizationId,
    kind: "provider_schedule_overdue",
    severity: "warning",
    providerId,
    runId: null,
    quarantineId: null,
    dedupeKey: `promotion-job:provider-schedule:${providerId}:1`,
    recoveryKey: `promotion-job:provider-schedule:${providerId}:1`,
    title: "Provider promotion schedule missed three windows",
    summary:
      "The provider promotion schedule missed at least three trusted reconciliation windows.",
    evidence: {
      outcome: "PROVIDER_PROMOTION_SCHEDULE_ALERTING",
      count: 3,
      thresholdCount: 3,
    },
    occurredAt: base.toISOString(),
  });
  const recovered = {
    ...raised,
    eventId: "40000000-0000-4000-8000-000000000002",
    action: "recover" as const,
  };
  assert.deepEqual(await publisher.publish(recovered), { state: "delivered" });
  assert.deepEqual(received[1], {
    id: recovered.eventId,
    organizationId,
    kind: "machinery_recovered",
    severity: "info",
    providerId,
    runId: null,
    quarantineId: null,
    dedupeKey: `promotion-job:provider-schedule:${providerId}:1:recovered`,
    recoveryKey: `promotion-job:provider-schedule:${providerId}:1`,
    title: "Provider promotion schedule recovered",
    summary:
      "A strictly newer trusted reconciliation check-in recovered the provider promotion schedule.",
    evidence: { outcome: "PROVIDER_PROMOTION_SCHEDULE_RECOVERED" },
    occurredAt: base.toISOString(),
  });
});
