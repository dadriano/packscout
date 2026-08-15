import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationPublishResult } from "@packscout/contracts";
import {
  PromotionOperationalReadinessService,
  isPromotionReconciliationFailureCode,
  type PromotionReadinessDiagnostic,
} from "./promotion-operational-readiness.ts";

const organizationId = "52000000-0000-4000-8000-000000000001";
const deploymentScopeDigest = "d".repeat(64);
const now = new Date("2026-08-15T12:01:00.000Z");

function healthyDiagnostic(
  overrides: Partial<PromotionReadinessDiagnostic> = {},
): PromotionReadinessDiagnostic {
  return {
    activeAlertCount: 0,
    activeFailureAlertCount: 0,
    activeFailureAttemptId: null,
    canonicalSettledWatermark: 10n,
    canonicalSettledAt: new Date("2026-08-15T12:00:30.000Z"),
    canonicalSourceHeadWatermark: 10n,
    confirmedWatermark: 10n,
    laneTargetWatermark: 10n,
    laneTargetAt: new Date("2026-08-15T12:00:30.000Z"),
    latestFailedAttemptId: null,
    latestFailedWatermark: null,
    latestFailureCode: null,
    technicalFailureCount: 0,
    ...overrides,
  };
}

function harness(
  initial: PromotionReadinessDiagnostic,
  failOnce: "activation" | "failed" | "recovered" | "settlement" | null = null,
) {
  let diagnostic = initial;
  const calls: Array<{ name: string; input: unknown }> = [];
  let failed = false;
  function publish(name: string, input: unknown): Promise<NotificationPublishResult> {
    calls.push({ name, input });
    if (!failed && failOnce === name) {
      failed = true;
      return Promise.resolve({
        status: "failed",
        alertId: null,
        failureCode: "NOTIFICATION_PUBLISH_FAILED",
      });
    }
    return Promise.resolve({
      status: "accepted",
      alertId: null,
      failureCode: null,
    });
  }
  const readiness = new PromotionOperationalReadinessService(
    {
      promotionActivationDelayed(input) {
        return publish("activation", input);
      },
      promotionSettlementBlocked(input) {
        return publish("settlement", input);
      },
      promotionFailed(input) {
        return publish("failed", input);
      },
      promotionRecovered(input) {
        return publish("recovered", input);
      },
    },
    { load: async () => diagnostic },
    { now: () => new Date(now) },
    {
      organizationId,
      deploymentScopeDigest,
      lane: "catalog",
      targetSource: "canonical_settlement",
    },
  );
  return {
    calls,
    readiness,
    setDiagnostic(value: PromotionReadinessDiagnostic) {
      diagnostic = value;
    },
  };
}

test("one-minute activation lag and technical blocks alert once then recover together", async () => {
  const state = harness(healthyDiagnostic({
    canonicalSettledAt: new Date("2026-08-15T12:00:00.001Z"),
    confirmedWatermark: 9n,
  }));
  await state.readiness.assess();
  assert.deepEqual(state.calls, []);

  state.setDiagnostic(healthyDiagnostic({
    canonicalSettledAt: new Date("2026-08-15T12:00:00.000Z"),
    confirmedWatermark: 9n,
  }));
  await state.readiness.assess();
  await state.readiness.assess();
  assert.deepEqual(state.calls.map(({ name }) => name), ["activation"]);

  state.setDiagnostic(healthyDiagnostic({
    activeAlertCount: 1,
    canonicalSettledAt: new Date("2026-08-15T12:00:00.000Z"),
    canonicalSourceHeadWatermark: 12n,
    confirmedWatermark: 9n,
    technicalFailureCount: 2,
  }));
  await state.readiness.assess();
  await state.readiness.assess();
  assert.deepEqual(state.calls.map(({ name }) => name), [
    "activation",
    "settlement",
  ]);

  state.setDiagnostic(healthyDiagnostic({
    activeAlertCount: 2,
    canonicalSettledWatermark: 12n,
    canonicalSourceHeadWatermark: 12n,
    confirmedWatermark: 12n,
  }));
  await state.readiness.assess();
  await state.readiness.assess();
  assert.deepEqual(state.calls.map(({ name }) => name), [
    "activation",
    "settlement",
    "recovered",
  ]);
});

test("healthy startup is quiet but resolves durable alerts left by another process", async () => {
  const state = harness(healthyDiagnostic());
  await state.readiness.assess();
  assert.deepEqual(state.calls, []);

  const restarted = harness(healthyDiagnostic({ activeAlertCount: 1 }));
  await restarted.readiness.assess();
  assert.deepEqual(restarted.calls.map(({ name }) => name), ["recovered"]);
});

test("terminal failures retain only bounded identifiers and recover after confirmation", async () => {
  const state = harness(healthyDiagnostic({ confirmedWatermark: 8n }));
  await state.readiness.publicationFailed({
    attemptId: "52000000-0000-4000-8000-000000000002",
    targetWatermark: 10n,
    failureCode: "PUBLICATION_RESPONSE_AUTH_INVALID",
  });
  assert.equal(state.calls[0]?.name, "failed");
  assert.deepEqual(state.calls[0]?.input, {
    organizationId,
    deploymentScopeDigest,
    lane: "catalog",
    attemptId: "52000000-0000-4000-8000-000000000002",
    targetWatermark: 10n,
    confirmedWatermark: 8n,
    failureCode: "PUBLICATION_RESPONSE_AUTH_INVALID",
    reconciliation: true,
  });

  state.setDiagnostic(healthyDiagnostic({
    activeAlertCount: 1,
    confirmedWatermark: 10n,
  }));
  await state.readiness.assess();
  assert.deepEqual(state.calls.map(({ name }) => name), [
    "failed",
    "recovered",
  ]);
  assert.equal(isPromotionReconciliationFailureCode("CATALOG_PLAN_BLOCKED"), false);
  assert.equal(isPromotionReconciliationFailureCode("CATALOG_LEDGER_INVALID"), true);
});

test("a terminal ledger row restores an alert lost after the terminal commit", async () => {
  const state = harness(healthyDiagnostic({
    confirmedWatermark: 8n,
    latestFailedAttemptId: "52000000-0000-4000-8000-000000000003",
    latestFailedWatermark: 10n,
    latestFailureCode: "CATALOG_RETRY_EXHAUSTED",
  }));
  await state.readiness.assess();
  assert.equal(state.calls[0]?.name, "failed");

  state.setDiagnostic(healthyDiagnostic({
    activeAlertCount: 1,
    activeFailureAlertCount: 1,
    activeFailureAttemptId: "52000000-0000-4000-8000-000000000003",
    confirmedWatermark: 8n,
    latestFailedAttemptId: "52000000-0000-4000-8000-000000000003",
    latestFailedWatermark: 10n,
    latestFailureCode: "CATALOG_RETRY_EXHAUSTED",
  }));
  await state.readiness.assess();
  assert.deepEqual(state.calls.map(({ name }) => name), ["failed"]);
});

test("a newer failed attempt supersedes an older active failure alert", async () => {
  const diagnostic = healthyDiagnostic({
    activeAlertCount: 1,
    activeFailureAlertCount: 1,
    activeFailureAttemptId: "52000000-0000-4000-8000-000000000005",
    confirmedWatermark: 8n,
    latestFailedAttemptId: "52000000-0000-4000-8000-000000000006",
    latestFailedWatermark: 10n,
    latestFailureCode: "CATALOG_RETRY_EXHAUSTED",
  });
  const state = harness(diagnostic);
  await state.readiness.assess();
  assert.equal(state.calls[0]?.name, "failed");
  assert.equal(
    (state.calls[0]?.input as { attemptId: string }).attemptId,
    "52000000-0000-4000-8000-000000000006",
  );

  const restarted = harness(healthyDiagnostic({
    ...diagnostic,
    activeFailureAttemptId: "52000000-0000-4000-8000-000000000006",
  }));
  await restarted.readiness.assess();
  assert.deepEqual(restarted.calls, []);
});

test("a failed notification write is retried from the terminal ledger row", async () => {
  const state = harness(healthyDiagnostic({
    confirmedWatermark: 8n,
    latestFailedAttemptId: "52000000-0000-4000-8000-000000000004",
    latestFailedWatermark: 10n,
    latestFailureCode: "CATALOG_RETRY_EXHAUSTED",
  }), "failed");

  await assert.rejects(
    state.readiness.assess(),
    /Promotion operational notification failed/u,
  );
  await state.readiness.assess();
  assert.deepEqual(state.calls.map(({ name }) => name), ["failed", "failed"]);
});

test("production scope and the one-minute activation target fail closed", () => {
  const events = {
    promotionActivationDelayed: async () => ({ status: "accepted" as const, alertId: null, failureCode: null }),
    promotionSettlementBlocked: async () => ({ status: "accepted" as const, alertId: null, failureCode: null }),
    promotionFailed: async () => ({ status: "accepted" as const, alertId: null, failureCode: null }),
    promotionRecovered: async () => ({ status: "accepted" as const, alertId: null, failureCode: null }),
  };
  assert.throws(
    () => new PromotionOperationalReadinessService(
      events,
      { load: async () => healthyDiagnostic() },
      { now: () => new Date(now) },
      {
        organizationId,
        deploymentScopeDigest: "production-us",
        lane: "catalog",
        targetSource: "canonical_settlement",
      },
    ),
    /readiness scope/u,
  );
  assert.throws(
    () => new PromotionOperationalReadinessService(
      events,
      { load: async () => healthyDiagnostic() },
      { now: () => new Date(now) },
      {
        organizationId,
        deploymentScopeDigest,
        lane: "catalog",
        targetSource: "canonical_settlement",
        activationAlertAfterMilliseconds: 59_999,
      },
    ),
    /activation target/u,
  );
});
