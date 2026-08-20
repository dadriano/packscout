import assert from "node:assert/strict";
import { test } from "node:test";
import {
  operationalNotificationSchema,
  type OperationalNotification,
} from "@packscout/contracts";
import type {
  OperationalLog,
  OperationalMetric,
} from "./operational-events.ts";
import {
  PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1,
  PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1,
  PackScoutBuybackEvOperationalEventLeakError,
  PackScoutBuybackEvOperationalMonitorV1,
  assertPackScoutBuybackEvOperationalEventSanitizedV1,
  packScoutBuybackEvAlertMappingForConditionV1,
  packScoutBuybackEvVersionCodeV1,
} from "./buyback-adjusted-ev-operational-monitor.ts";
import type { PackScoutBuybackEvBackfillLedgerV1 } from "./buyback-adjusted-ev-backfill-reconciliation.ts";

const ORGANIZATION_ID = "42000000-0000-4000-8000-000000000001";
const PROVIDER_ID = "42000000-0000-4000-8000-000000000002";

function harness() {
  const published: OperationalNotification[] = [];
  const metrics: OperationalMetric[] = [];
  const logs: OperationalLog[] = [];
  let sequence = 0;
  const monitor = new PackScoutBuybackEvOperationalMonitorV1({
    publisher: {
      async publish(event) {
        published.push(event);
        return { status: "accepted", alertId: event.id, failureCode: null };
      },
    },
    ids: {
      id: () => {
        sequence += 1;
        return `13000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      },
    },
    clock: { now: () => new Date("2026-08-19T12:00:00.000Z") },
    observability: {
      metric: (metric) => metrics.push(metric),
      log: (entry) => logs.push(entry),
    },
  });
  return { monitor, published, metrics, logs };
}

function ledgerFixture(): PackScoutBuybackEvBackfillLedgerV1 {
  return {
    schemaVersion: "packscout-buyback-ev-backfill-reconciliation-v1",
    organizationId: ORGANIZATION_ID,
    readAt: "2026-08-19T12:00:00.000Z",
    classification: "ready",
    methodVersions: ["packscout-buyback-adjusted-ev-v1"],
    confidencePolicyVersions: ["packscout-buyback-adjusted-ev-confidence-v1"],
    counts: {
      total: 4,
      recomputedAvailable: 2,
      deterministicUnavailable: 1,
      soldOutHistorical: 1,
      byPublicReason: { BUYBACK_UNAVAILABLE: 1 },
      byConfidenceBand: { low: 0, medium: 1, high: 2 },
      bySourceAge: {
        fresh_within_15_minutes: 2,
        delayed_over_15_through_30_minutes: 1,
        delayed_over_30_through_60_minutes: 0,
        stale_or_expired: 0,
        unknown_source_time: 1,
      },
    },
    recomputation: {
      created: 3,
      unchanged: 1,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
      skippedNoEvidence: 0,
    },
    staging: {
      staged: true,
      publicReleaseId: "20000000-0000-8000-8000-000000000001",
      releaseFingerprint: "a".repeat(64),
      lifecycle: "complete",
      priorActivePublicReleaseId: null,
      activePointerMoved: false,
    },
    rows: [],
    blockedReasons: [],
  };
}

test("every required alert condition is mapped to a deduplicatable bounded event", async () => {
  const { monitor, published } = harness();
  const results = [
    await monitor.recomputationBacklog({
      organizationId: ORGANIZATION_ID,
      providerId: PROVIDER_ID,
      queuedCount: 17,
      oldestQueuedAgeSeconds: 420,
    }),
    await monitor.methodMismatch({
      organizationId: ORGANIZATION_ID,
      observedMethodVersion: "packscout-estimated-ev-v1",
    }),
    await monitor.publicationRejected({
      organizationId: ORGANIZATION_ID,
      stage: "finalize",
      code: "PUBLICATION_RECONCILIATION_FAILED",
    }),
    await monitor.freshnessExpired({
      organizationId: ORGANIZATION_ID,
      providerId: PROVIDER_ID,
      expiredCount: 3,
      oldestSourceAgeSeconds: 4_000,
    }),
  ];
  assert.deepEqual(
    results.map(({ status }) => status),
    ["accepted", "accepted", "accepted", "accepted"],
  );
  assert.equal(published.length, PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1.length);
  for (const event of published) {
    // Every event revalidates against the shared notification contract.
    assert.equal(operationalNotificationSchema.safeParse(event).success, true);
    assert.match(event.dedupeKey, /^buyback-ev:/);
    assert.match(event.recoveryKey, /^buyback-ev:/);
  }
  // The mapping table matches what actually got emitted.
  for (const [index, condition] of PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1.entries()) {
    const mapping = packScoutBuybackEvAlertMappingForConditionV1(condition);
    assert.equal(published[index]!.kind, mapping.kind);
    assert.equal(published[index]!.severity, mapping.severity);
    const prefix = mapping.dedupeKeyPattern.slice(
      0,
      mapping.dedupeKeyPattern.indexOf("<"),
    );
    assert.ok(published[index]!.dedupeKey.startsWith(prefix));
  }
  // Re-emitting the same condition reuses the identical dedupe key.
  const before = published[0]!.dedupeKey;
  await monitor.recomputationBacklog({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    queuedCount: 18,
    oldestQueuedAgeSeconds: 460,
  });
  assert.equal(published.at(-1)!.dedupeKey, before);
});

test("no emitted alert, metric, or log carries money, payloads, credentials, or identities", async () => {
  const { monitor, published, metrics, logs } = harness();
  await monitor.recomputationBacklog({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    queuedCount: 2,
    oldestQueuedAgeSeconds: 61,
  });
  await monitor.methodMismatch({
    organizationId: ORGANIZATION_ID,
    observedMethodVersion: "estimated-ev-v2",
  });
  await monitor.publicationRejected({
    organizationId: ORGANIZATION_ID,
    stage: "activate",
    code: "PUBLICATION_DATA_REGRESSION",
  });
  await monitor.freshnessExpired({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    expiredCount: 1,
    oldestSourceAgeSeconds: 3_700,
  });
  monitor.reportBackfillLedger(ledgerFixture());
  monitor.reportQueueLag({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    oldestQueuedAgeSeconds: 45,
  });
  monitor.reportRecomputationAge({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    sourceAgeSeconds: 120,
  });
  const serialized = JSON.stringify({ published, metrics, logs });
  for (const forbidden of [
    "minorUnits",
    "grossEv",
    "evDollars",
    "packPrice",
    "statedValue",
    "payload",
    "authorization",
    "bearer ",
    "credential",
    "secret",
    "password",
    "wallet",
    "userId",
    "email",
    "@example.com",
    "$1",
  ]) {
    assert.equal(
      serialized.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `operational output leaked ${forbidden}`,
    );
  }
  // The tripwire itself refuses representative leak attempts.
  for (const leak of [
    { grossEvMoney: { minorUnits: 8_500 } },
    { note: "authorization: Bearer abc" },
    { payload: "raw-bytes" },
    { contact: "buyer@example.com" },
    { evidence: { failureCode: "OK" }, summary: "price is $12 now" },
    { wallet: "0x0123456789abcdef0123456789abcdef" },
  ]) {
    assert.throws(
      () => assertPackScoutBuybackEvOperationalEventSanitizedV1(leak),
      PackScoutBuybackEvOperationalEventLeakError,
    );
  }
  // Bounded backfill telemetry uses only stable outcome codes.
  for (const metric of metrics) {
    assert.ok(
      metric.outcomeCode === null ||
        /^[A-Z][A-Z0-9_]{0,127}$/.test(metric.outcomeCode),
      `unbounded outcome code ${String(metric.outcomeCode)}`,
    );
  }
});

test("telemetry failures never change a monitoring outcome and invalid scopes fail closed", async () => {
  const published: OperationalNotification[] = [];
  const monitor = new PackScoutBuybackEvOperationalMonitorV1({
    publisher: {
      async publish(event) {
        published.push(event);
        return { status: "accepted", alertId: event.id, failureCode: null };
      },
    },
    ids: { id: () => "13000000-0000-4000-8000-000000000099" },
    clock: { now: () => new Date("2026-08-19T12:00:00.000Z") },
    observability: {
      metric: () => {
        throw new Error("metrics sink down");
      },
      log: () => {
        throw new Error("log sink down");
      },
    },
  });
  const delivered = await monitor.freshnessExpired({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    expiredCount: 1,
    oldestSourceAgeSeconds: 3_700,
  });
  assert.equal(delivered.status, "accepted");
  assert.equal(published.length, 1);

  // A scope that cannot form a bounded dedupe key is refused, not degraded.
  const refused = await monitor.recomputationBacklog({
    organizationId: ORGANIZATION_ID,
    providerId: "NOT A SCOPE",
    queuedCount: 1,
    oldestQueuedAgeSeconds: 10,
  });
  assert.equal(refused.status, "failed");
  assert.equal(published.length, 1);
});

test("version labels sanitize into stable uppercase codes", () => {
  assert.equal(
    packScoutBuybackEvVersionCodeV1("packscout-buyback-adjusted-ev-v1"),
    "PACKSCOUT_BUYBACK_ADJUSTED_EV_V1",
  );
  assert.equal(packScoutBuybackEvVersionCodeV1("///"), "UNKNOWN_VERSION");
  assert.equal(
    PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1.length,
    PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1.length,
  );
});
