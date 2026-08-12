import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderHealthProjectionService,
  ProviderHealthService,
  type ProviderHealthEvidence,
  type ProviderFreshnessOperationalHooks,
  type ProviderHealthProjectionRepository,
} from "./provider-health-service.ts";

class MutableClock {
  constructor(public current: Date) {}
  now(): Date {
    return this.current;
  }
}

function evidence(
  overrides: Partial<ProviderHealthEvidence> = {},
): ProviderHealthEvidence {
  return {
    organizationId: "organization-1",
    providerId: "provider-1",
    platformKey: "platform-1",
    displayName: "Platform One",
    providerState: "active",
    configRevisionId: "revision-1",
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
    nextDueAt: new Date("2026-08-06T12:05:00.000Z"),
    activeRun: null,
    latestRun: {
      id: "run-1",
      state: "succeeded",
      attemptedAt: new Date("2026-08-06T11:59:00.000Z"),
    },
    latestIncompleteRunId: null,
    lastAttemptedAt: new Date("2026-08-06T11:59:00.000Z"),
    lastHeadReachedAt: new Date("2026-08-06T11:59:00.000Z"),
    openQuarantineCount: 0,
    consecutiveFailures: 0,
    latestFailureCode: null,
    recoveredAt: null,
    mappingWarning: null,
    calculationWarning: null,
    ...overrides,
  };
}

test("custom stale thresholds use provider-head time and recover immediately", async () => {
  const clock = new MutableClock(new Date("2026-08-06T12:14:00.000Z"));
  let current = evidence({ staleAfterSeconds: 900 });
  const service = new ProviderHealthService(
    { loadHealthEvidence: async () => current },
    clock,
  );

  assert.equal((await service.getHealth({ organizationId: "organization-1", providerId: "provider-1" })).freshnessState, "fresh");
  clock.current = new Date("2026-08-06T12:14:00.001Z");
  assert.equal((await service.getHealth({ organizationId: "organization-1", providerId: "provider-1" })).freshnessState, "stale");

  current = evidence({
    lastHeadReachedAt: clock.current,
    consecutiveFailures: 0,
    latestFailureCode: null,
    recoveredAt: clock.current,
  });
  const recovered = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });
  assert.equal(recovered.freshnessState, "fresh");
  assert.equal(recovered.recoveredAt, "2026-08-06T12:14:00.001Z");
});

test("freshness and quarantine quality remain independent", async () => {
  const clock = new MutableClock(new Date("2026-08-06T12:00:00.000Z"));
  let current = evidence({
    openQuarantineCount: 4,
    latestIncompleteRunId: "run-incomplete",
  });
  const service = new ProviderHealthService(
    { loadHealthEvidence: async () => current },
    clock,
  );

  const freshWarning = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });
  assert.equal(freshWarning.freshnessState, "fresh");
  assert.equal(freshWarning.qualityState, "warning");
  assert.equal(freshWarning.openQuarantineCount, 4);

  current = evidence({
    lastHeadReachedAt: new Date("2026-08-06T11:00:00.000Z"),
    latestIncompleteRunId: "run-incomplete",
    openQuarantineCount: 0,
  });
  const resolvedOldQuarantine = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });
  assert.equal(resolvedOldQuarantine.freshnessState, "stale");
  assert.equal(resolvedOldQuarantine.qualityState, "healthy");
  assert.equal(resolvedOldQuarantine.latestIncompleteRunId, "run-incomplete");
});

test("mapping and calculation signals are bounded, independent quality evidence", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const service = new ProviderHealthService(
    {
      loadHealthEvidence: async () =>
        evidence({
          consecutiveFailures: 2,
          latestFailureCode: "IMPORT_MAPPING_FAILED",
          mappingWarning: {
            occurredAt: now,
            severity: "degraded",
            active: true,
          },
          calculationWarning: {
            occurredAt: new Date("2026-08-06T11:58:00.000Z"),
            severity: "warning",
            active: true,
          },
        }),
    },
    new MutableClock(now),
  );

  const health = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });
  assert.equal(health.freshnessState, "fresh");
  assert.equal(health.qualityState, "degraded");
  assert.equal(health.latestFailureClass, "mapping");
  assert.equal(health.latestMappingWarningAt, now.toISOString());
  assert.equal("failureSummary" in health, false);
});

test("a mapping failure degrades quality without relying on quarantine state", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const service = new ProviderHealthService(
    {
      loadHealthEvidence: async () =>
        evidence({
          openQuarantineCount: 0,
          latestFailureCode: "IMPORT_MAPPING_FAILED",
          consecutiveFailures: 1,
        }),
    },
    new MutableClock(now),
  );

  const health = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });
  assert.equal(health.freshnessState, "fresh");
  assert.equal(health.qualityState, "degraded");
});

test("projection commands use one clock and reject unsafe failure values", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const calls: Array<{ kind: string; at: Date }> = [];
  const repository: ProviderHealthProjectionRepository = {
    loadHealthEvidence: async () => evidence(),
    async recordRunOutcome(input) {
      calls.push({ kind: "run", at: input.finishedAt });
    },
    async recordQualitySignal(input) {
      calls.push({ kind: input.kind, at: input.occurredAt });
    },
    async resolveQualitySignal(input) {
      calls.push({ kind: `resolve:${input.kind}`, at: input.resolvedAt });
    },
  };
  const service = new ProviderHealthProjectionService(
    repository,
    new MutableClock(now),
  );

  await service.recordRunOutcome({
    organizationId: "organization-1",
    providerId: "provider-1",
    reachedProviderHead: false,
    failureCode: "IMPORT_TIMEOUT",
  });
  await service.recordQualitySignal({
    organizationId: "organization-1",
    providerId: "provider-1",
    kind: "calculation",
    severity: "warning",
  });
  await service.resolveQualitySignal({
    organizationId: "organization-1",
    providerId: "provider-1",
    kind: "calculation",
  });
  assert.deepEqual(calls, [
    { kind: "run", at: now },
    { kind: "calculation", at: now },
    { kind: "resolve:calculation", at: now },
  ]);
  await assert.rejects(
    () =>
      service.recordRunOutcome({
        organizationId: "organization-1",
        providerId: "provider-1",
        reachedProviderHead: false,
        failureCode: "raw upstream body leaked",
      }),
    /failure code is invalid/,
  );
});

test("freshness reads report bounded metrics and deduplicatable stale events", async () => {
  const calls: string[] = [];
  const operational: ProviderFreshnessOperationalHooks = {
    events: {
      async providerStale(input) {
        calls.push(`event:${input.ageSeconds}`);
        return { status: "accepted", alertId: null, failureCode: null };
      },
    },
    reporter: {
      freshness(input) {
        calls.push(`metric:${input.state}:${input.ageSeconds}`);
      },
    },
  };
  const service = new ProviderHealthService(
    {
      loadHealthEvidence: async () =>
        evidence({
          lastHeadReachedAt: new Date("2026-08-06T11:00:00.000Z"),
          staleAfterSeconds: 900,
        }),
    },
    new MutableClock(new Date("2026-08-06T12:00:00.000Z")),
    operational,
  );

  const result = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });

  assert.equal(result.freshnessState, "stale");
  assert.deepEqual(calls, ["metric:STALE:3600", "event:3600"]);
});

test("freshness reporting failures cannot hide protected health", async () => {
  let eventAttempted = false;
  const service = new ProviderHealthService(
    {
      loadHealthEvidence: async () =>
        evidence({ lastHeadReachedAt: new Date("2026-08-06T11:00:00.000Z") }),
    },
    new MutableClock(new Date("2026-08-06T12:00:00.000Z")),
    {
      events: {
        providerStale: async () => {
          eventAttempted = true;
          throw new Error("notification unavailable");
        },
      },
      reporter: {
        freshness() {
          throw new Error("metrics unavailable");
        },
      },
    },
  );

  const result = await service.getHealth({
    organizationId: "organization-1",
    providerId: "provider-1",
  });
  assert.equal(result.freshnessState, "stale");
  assert.equal(eventAttempted, true);
});
