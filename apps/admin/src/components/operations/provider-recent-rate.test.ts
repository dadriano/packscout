import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSourceOperationsSource } from "@packscout/contracts";
import { operationSource, operationsOverview } from "../../testing/provider-source-operations-fixture.ts";
import { expireRecentRates, isRecentRateEligible, observeRecentRates, readRecentRate, recentRateValue, type RecentRateHistory } from "./provider-recent-rate.ts";

const epoch = Date.parse("2026-08-21T12:00:00.000Z");
const organization = "organization-a";
const source = operationSource(0);

function sample(history: RecentRateHistory, seconds: number, processed: number, options: {
  source?: ProviderSourceOperationsSource; organization?: string; receivedAt?: number;
} = {}): RecentRateHistory {
  const overview = operationsOverview();
  const provider = options.source ?? source;
  overview.refreshedAt = new Date(epoch + seconds * 1_000).toISOString();
  overview.sources = [{ ...provider, progress: { ...provider.progress, records: { ...provider.progress.records, total: processed } } }];
  return observeRecentRates(history, overview, options.organization ?? organization, options.receivedAt ?? seconds * 1_000);
}

test("recent rate measures actual distinct sample time and never guesses a cold-start zero", () => {
  let history = sample({}, 0, 100);
  assert.equal(readRecentRate(history, source, organization).state, "measuring");
  const initial = history[source.providerId];
  history = sample(history, 0, 100, { receivedAt: 1_000 });
  assert.equal(history[source.providerId], initial, "a duplicate snapshot is idempotent");
  history = sample(history, 4, 140);
  assert.equal(readRecentRate(history, source, organization).state, "measuring");
  history = sample(history, 5, 150);
  assert.deepEqual(readRecentRate(history, source, organization), {
    state: "available", recordsPerSecond: 10, windowMilliseconds: 5_000, sampleCount: 3,
  });
  assert.equal(initial!.samples.length, 1, "sampling never mutates previous state");
});

test("zero needs unchanged observations and small positive rates stay visibly nonzero", () => {
  const unchanged = sample(sample({}, 0, 100), 5, 100);
  assert.equal(recentRateValue(readRecentRate(unchanged, source, organization)), "0");
  const tiny = sample(sample({}, 0, 100), 15, 101);
  assert.equal(recentRateValue(readRecentRate(tiny, source, organization)), "<0.1");
});

test("recent rate uses at most sixty seconds and keeps a bounded observation history", () => {
  let history: RecentRateHistory = {};
  for (let seconds = 0; seconds <= 90; seconds += 5) {
    history = sample(history, seconds, seconds <= 30 ? seconds * 10 : 300 + (seconds - 30) * 2);
  }
  assert.deepEqual(readRecentRate(history, source, organization), {
    state: "available", recordsPerSecond: 2, windowMilliseconds: 60_000, sampleCount: 13,
  });
  history = {};
  for (let index = 0; index <= 50; index += 1) history = sample(history, index / 5, index);
  assert.equal(history[source.providerId]!.samples.length, 32);
  assert.deepEqual(readRecentRate(history, source, organization), {
    state: "available", recordsPerSecond: 5, windowMilliseconds: 6_200, sampleCount: 32,
  });
});

test("counter regressions, backwards time, and long observation or receipt gaps restart measurement", () => {
  const measured = sample(sample({}, 0, 100), 5, 150);
  for (const restarted of [
    sample(measured, 10, 140),
    sample(measured, 4, 200),
    sample(measured, 21, 200),
    sample(measured, 10, 200, { receivedAt: 21_000 }),
    sample(measured, 10, 200, { receivedAt: 1_000 }),
    sample(measured, 5, 200),
  ]) assert.equal(readRecentRate(restarted, source, organization).state, "measuring");
});

test("repeated snapshots do not extend the local freshness deadline", () => {
  const measured = sample(sample({}, 0, 100), 5, 150);
  const duplicate = sample(measured, 5, 150, { receivedAt: 14_000 });
  assert.equal(expireRecentRates(duplicate, 20_000), duplicate);
  const expired = expireRecentRates(duplicate, 20_001);
  assert.equal(readRecentRate(expired, source, organization).state, "unavailable");
  assert.equal(readRecentRate(sample(expired, 5, 150, { receivedAt: 21_000 }), source, organization).state, "measuring");
});

test("tenant, provider, configuration, run identity, and run start changes cannot reuse a rate", () => {
  const measured = sample(sample({}, 0, 100), 5, 150);
  for (const change of [
    (next: ProviderSourceOperationsSource) => { next.providerId = operationSource(1).providerId; },
    (next: ProviderSourceOperationsSource) => { next.source!.sourceRevisionId = operationSource(1).source!.sourceRevisionId; },
    (next: ProviderSourceOperationsSource) => { next.activeRun!.id = "00000000-0000-4000-8000-000000000999"; },
    (next: ProviderSourceOperationsSource) => { next.activeRun!.startedAt = "2026-08-21T12:00:01.000Z"; },
  ]) {
    const next = operationSource(0);
    change(next);
    assert.equal(readRecentRate(measured, next, organization).state, "unavailable");
    assert.equal(readRecentRate(sample(measured, 10, 1_000, { source: next }), next, organization).state, "measuring");
  }
  assert.equal(readRecentRate(measured, source, "organization-b").state, "unavailable");
  assert.equal(readRecentRate(sample(measured, 10, 1_000, { organization: "organization-b" }), source, "organization-b").state, "measuring");
});

test("only a running source and run with a valid observed import lease can be sampled", () => {
  const changes = [
    (next: ProviderSourceOperationsSource) => { next.configured = false; },
    (next: ProviderSourceOperationsSource) => { next.source!.lifecycle = "paused"; },
    (next: ProviderSourceOperationsSource) => { next.source!.pauseRequested = true; },
    (next: ProviderSourceOperationsSource) => { next.activeRun = null; },
    (next: ProviderSourceOperationsSource) => { next.activeRun!.state = "succeeded"; },
    (next: ProviderSourceOperationsSource) => { next.processor!.activity = "action_required"; },
    (next: ProviderSourceOperationsSource) => { next.processor!.activity = "paused"; },
    (next: ProviderSourceOperationsSource) => { next.measurements.activity = { state: "unavailable", reason: "database_unreachable" }; },
    (next: ProviderSourceOperationsSource) => { if (next.measurements.activity.state === "available") next.measurements.activity.importLease.state = "expired"; },
  ];
  for (const change of changes) {
    const next = operationSource(0);
    change(next);
    assert.equal(isRecentRateEligible(next), false);
    assert.deepEqual(sample({}, 0, 100, { source: next }), {});
  }
});
