import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderPrismaClient,
  ProviderPulseHistory,
  ProviderPulseLeases,
  ProviderPulseRecordTotals,
  ProviderPulseStorageCounts,
} from "@packscout/database";
import { ProviderPulseMeasurementReader } from "./provider-pulse-measurements.ts";

const measuredAt = "2026-08-30T12:00:00.000Z";
const identity = { organizationId: "org-a", providerId: "provider-a", configurationId: "config-a" };
const storage: ProviderPulseStorageCounts = {
  measuredAt, precision: "exact",
  counts: { total: 10, categories: 1, packs: 1, collectibles: 1, aliases: 1,
    instances: 1, packContents: 1, accounts: 1, pulls: 1, pullItems: 1, marketEvents: 1 },
};
const records: ProviderPulseRecordTotals = { measuredAt, processed: 20, accepted: 12 };
const leases: ProviderPulseLeases = {
  measuredAt,
  importLease: { state: "active", heartbeatAt: measuredAt, expiresAt: "2026-08-30T12:01:00.000Z" },
  promotionLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
};
const history: ProviderPulseHistory = {
  measuredAt, lastCommittedPageAt: "2026-08-30T11:59:55.000Z",
  quarantine: { open: 2, resolved: 1, expired: 4, retained: 7 },
};
const activity = { ...leases, historyMeasuredAt: history.measuredAt,
  lastCommittedPageAt: history.lastCommittedPageAt, quarantine: history.quarantine };
const database = () => ({}) as ProviderPrismaClient;

test("exact totals and activity history stay cached for sixty seconds while leases are refreshed", async () => {
  let now = Date.parse(measuredAt);
  let scans = 0;
  let historyReads = 0;
  let leaseReads = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(now), () => ({
    async readStorageCounts() { scans += 1; return { ...storage, measuredAt: new Date(now).toISOString() }; },
    async readRecordTotals() { return { ...records, measuredAt: new Date(now).toISOString() }; },
    async readHistory() { historyReads += 1; return { ...history, measuredAt: new Date(now).toISOString() }; },
    async readLeases() { leaseReads += 1; return { ...leases, measuredAt: new Date(now).toISOString() }; },
  }));
  const client = database();
  await reader.read(client, identity);
  now += 5_000;
  const second = await reader.read(client, identity);
  assert.equal(scans, 1);
  assert.equal(historyReads, 1);
  assert.equal(leaseReads, 2);
  assert.equal(second.storage.state === "available" && second.storage.measuredAt, measuredAt);
  assert.equal(second.activity.state === "available" && second.activity.measuredAt, new Date(now).toISOString());
  assert.equal(second.activity.state === "available" && second.activity.historyMeasuredAt, measuredAt);
  now += 55_000;
  const refreshed = await reader.read(client, identity);
  assert.equal(scans, 2);
  assert.equal(historyReads, 2);
  assert.equal(leaseReads, 3);
  assert.equal(refreshed.storage.state === "available" && refreshed.storage.measuredAt, new Date(now).toISOString());
  assert.equal(refreshed.activity.state === "available" && refreshed.activity.historyMeasuredAt, new Date(now).toISOString());
});

test("tenant, provider, configuration, and authorized gateway client changes invalidate both history caches", async () => {
  let scans = 0;
  let historyReads = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readStorageCounts() { scans += 1; return storage; },
    async readRecordTotals() { return records; },
    async readHistory() { historyReads += 1; return history; },
    async readLeases() { return leases; },
  }));
  const client = database();
  await reader.read(client, identity);
  await reader.read(client, { ...identity, organizationId: "org-b" });
  await reader.read(client, { ...identity, providerId: "provider-b" });
  await reader.read(client, { ...identity, configurationId: "config-b" });
  await reader.read(database(), { ...identity, configurationId: "config-b" });
  assert.equal(scans, 5);
  assert.equal(historyReads, 5);
});

test("concurrent authorized refreshes share both pending history scans but read their own leases", async () => {
  let finish: (value: ProviderPulseStorageCounts) => void = () => { throw new Error("query not started"); };
  let finishHistory: (value: ProviderPulseHistory) => void = () => { throw new Error("query not started"); };
  let scans = 0;
  let historyReads = 0;
  let leaseReads = 0;
  const waiting = new Promise<ProviderPulseStorageCounts>((resolve) => { finish = resolve; });
  const waitingHistory = new Promise<ProviderPulseHistory>((resolve) => { finishHistory = resolve; });
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    readStorageCounts() { scans += 1; return waiting; },
    async readRecordTotals() { return records; },
    readHistory() { historyReads += 1; return waitingHistory; },
    async readLeases() { leaseReads += 1; return leases; },
  }));
  const client = database();
  const first = reader.read(client, identity);
  const second = reader.read(client, identity);
  assert.equal(scans, 1);
  assert.equal(historyReads, 1);
  assert.equal(leaseReads, 2);
  finish(storage);
  finishHistory(history);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
});

test("a timed-out count query leaves retained-run, page and lease evidence available without invented zeros", async () => {
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readStorageCounts() { throw new Error("statement timeout"); },
    async readRecordTotals() { return records; },
    async readHistory() { return history; },
    async readLeases() { return leases; },
  }));
  const result = await reader.read(database(), identity);
  assert.deepEqual(result.storage, { state: "unavailable", reason: "query_failed" });
  // Counting stored rows is the only read that timed out. The retained-run
  // aggregate reads its own small table and is not withheld with it.
  assert.deepEqual(result.records, { state: "available", ...records });
  assert.deepEqual(result.activity, { state: "available", ...activity });
  assert.equal(JSON.stringify(result).includes("statement timeout"), false);
});

test("a shared transient count failure retries on the next refresh before sixty seconds", async () => {
  let now = Date.parse(measuredAt);
  let scans = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(now), () => ({
    async readStorageCounts() {
      scans += 1;
      if (scans === 1) throw new Error("temporary database failure");
      return { ...storage, measuredAt: new Date(now).toISOString() };
    },
    async readRecordTotals() { return { ...records, measuredAt: new Date(now).toISOString() }; },
    async readHistory() { return history; },
    async readLeases() { return leases; },
  }));
  const client = database();
  const failures = await Promise.all([reader.read(client, identity), reader.read(client, identity)]);
  assert.equal(scans, 1, "concurrent reads share even the failing query");
  for (const failure of failures) {
    assert.deepEqual(failure.storage, { state: "unavailable", reason: "query_failed" });
    assert.equal(failure.records.state, "available");
    assert.equal(failure.activity.state, "available");
  }

  now += 5_000;
  const recovered = await reader.read(client, identity);
  assert.equal(scans, 2, "the next refresh retries instead of waiting for cache expiry");
  assert.deepEqual(recovered.storage, { state: "available", measuredAt: new Date(now).toISOString(), precision: "exact", counts: storage.counts });
  // The retained-run aggregate succeeded first time, so it is still served
  // from its own cache and keeps the snapshot time it was measured in.
  assert.deepEqual(recovered.records, { state: "available", measuredAt, processed: records.processed, accepted: records.accepted });
  await reader.read(client, identity);
  assert.equal(scans, 2, "successful recovery remains cached");
});

test("a late count failure cannot evict a newer scope's pending or successful query", async () => {
  let failFirst: (error: Error) => void = () => { throw new Error("query not started"); };
  let finishSecond: (value: ProviderPulseStorageCounts) => void = () => { throw new Error("query not started"); };
  const firstQuery = new Promise<ProviderPulseStorageCounts>((_resolve, reject) => { failFirst = reject; });
  const secondQuery = new Promise<ProviderPulseStorageCounts>((resolve) => { finishSecond = resolve; });
  let scans = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    readStorageCounts() { scans += 1; return scans === 1 ? firstQuery : secondQuery; },
    async readRecordTotals() { return records; },
    async readHistory() { return history; },
    async readLeases() { return leases; },
  }));
  const client = database();
  const nextIdentity = { ...identity, configurationId: "config-b" };
  const oldRead = reader.read(client, identity);
  const replacement = reader.read(client, nextIdentity);
  assert.equal(scans, 2);
  failFirst(new Error("old query failed"));
  assert.equal((await oldRead).storage.state, "unavailable");
  const concurrentReplacement = reader.read(client, nextIdentity);
  assert.equal(scans, 2, "the late failure preserves the newer in-flight entry");
  finishSecond(storage);
  const recovered = await Promise.all([replacement, concurrentReplacement]);
  assert.deepEqual(recovered[0], recovered[1]);
  assert.equal(recovered[0]!.storage.state, "available");
  await reader.read(client, nextIdentity);
  assert.equal(scans, 2, "the replacement remains cached after completion");
});

test("missing activity never discards stored counts, and malformed counts fail closed", async () => {
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readStorageCounts() { return storage; },
    async readRecordTotals() { return records; },
    async readHistory() { return history; },
    async readLeases() { throw new Error("lease query unavailable"); },
  }));
  const result = await reader.read(database(), identity);
  assert.equal(result.storage.state, "available");
  assert.deepEqual(result.activity, { state: "unavailable", reason: "query_failed" });

  const malformed = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readStorageCounts() { return { ...storage, counts: { ...storage.counts, total: -1 } }; },
    async readRecordTotals() { return records; },
    async readHistory() { return history; },
    async readLeases() { return leases; },
  }));
  const rejected = await malformed.read(database(), identity);
  assert.equal(rejected.storage.state, "unavailable");
  assert.equal(rejected.activity.state, "available");
});

for (const failure of ["query", "malformed"] as const) {
  test(`${failure} history failures retry on the next refresh without discarding cached totals`, async () => {
    let now = Date.parse(measuredAt);
    let scans = 0;
    let historyReads = 0;
    let leaseReads = 0;
    const reader = new ProviderPulseMeasurementReader(() => new Date(now), () => ({
      async readStorageCounts() { scans += 1; return storage; },
    async readRecordTotals() { return records; },
      async readHistory() {
        historyReads += 1;
        if (historyReads === 1) {
          if (failure === "query") throw new Error("history unavailable");
          return { ...history, quarantine: { ...history.quarantine, retained: 0 } };
        }
        return { ...history, measuredAt: new Date(now).toISOString() };
      },
      async readLeases() { leaseReads += 1; return { ...leases, measuredAt: new Date(now).toISOString() }; },
    }));
    const client = database();
    const failed = await Promise.all([reader.read(client, identity), reader.read(client, identity)]);
    assert.equal(historyReads, 1, "operators share the initial failed history scan");
    assert.equal(leaseReads, 2, "each refresh checks current leases");
    for (const result of failed) {
      assert.deepEqual(result.activity, { state: "unavailable", reason: "query_failed" });
      assert.equal(result.storage.state, "available");
      assert.equal(result.records.state, "available");
    }
    now += 5_000;
    const recovered = await reader.read(client, identity);
    assert.equal(historyReads, 2, "failure does not stay cached for sixty seconds");
    assert.equal(recovered.activity.state, "available");
    if (recovered.activity.state !== "available") return;
    assert.equal(recovered.activity.historyMeasuredAt, new Date(now).toISOString());
    assert.deepEqual(recovered.activity.quarantine, history.quarantine);
    await reader.read(client, identity);
    assert.equal(historyReads, 2, "validated recovery is cached");
    assert.equal(scans, 1, "the history failure does not invalidate exact totals");
  });
}

test("lease failure leaves valid cached history intact for the next fresh lease observation", async () => {
  let now = Date.parse(measuredAt);
  let historyReads = 0;
  let leaseReads = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(now), () => ({
    async readStorageCounts() { return storage; },
    async readRecordTotals() { return records; },
    async readHistory() { historyReads += 1; return history; },
    async readLeases() {
      leaseReads += 1;
      if (leaseReads === 1) throw new Error("lease query failed");
      return { ...leases, measuredAt: new Date(now).toISOString(),
        importLease: { ...leases.importLease, state: "expired" as const } };
    },
  }));
  const client = database();
  assert.deepEqual((await reader.read(client, identity)).activity, { state: "unavailable", reason: "query_failed" });
  now += 5_000;
  const recovered = await reader.read(client, identity);
  assert.equal(historyReads, 1);
  assert.equal(leaseReads, 2);
  assert.equal(recovered.activity.state, "available");
  if (recovered.activity.state !== "available") return;
  assert.equal(recovered.activity.measuredAt, new Date(now).toISOString());
  assert.equal(recovered.activity.historyMeasuredAt, measuredAt);
  assert.equal(recovered.activity.importLease.state, "expired", "leases are not served from the history cache");
});

for (const replacementSettled of [false, true]) {
  test(`late history failure preserves a ${replacementSettled ? "completed" : "pending"} replacement snapshot`, async () => {
    let failFirst!: (error: Error) => void;
    let finishSecond!: (value: ProviderPulseHistory) => void;
    const firstQuery = new Promise<ProviderPulseHistory>((_resolve, reject) => { failFirst = reject; });
    const secondQuery = new Promise<ProviderPulseHistory>((resolve) => { finishSecond = resolve; });
    let historyReads = 0;
    const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
      async readStorageCounts() { return storage; },
    async readRecordTotals() { return records; },
      readHistory() { historyReads += 1; return historyReads === 1 ? firstQuery : secondQuery; },
      async readLeases() { return leases; },
    }));
    const client = database();
    const nextIdentity = { ...identity, configurationId: "config-b" };
    const oldRead = reader.read(client, identity);
    const replacement = reader.read(client, nextIdentity);
    if (replacementSettled) {
      finishSecond(history);
      assert.equal((await replacement).activity.state, "available");
    }
    failFirst(new Error("old history query failed"));
    assert.equal((await oldRead).activity.state, "unavailable");
    const latest = reader.read(client, nextIdentity);
    assert.equal(historyReads, 2, "a late failure cannot evict newer scope evidence");
    if (!replacementSettled) finishSecond(history);
    const results = await Promise.all([replacement, latest]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]!.activity.state, "available");
    await reader.read(client, nextIdentity);
    assert.equal(historyReads, 2);
  });
}

test("estimated counts are carried to the reader instead of being withheld or presented as exact", async () => {
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readStorageCounts() { return { ...storage, precision: "estimated" as const }; },
    async readRecordTotals() { return records; },
    async readHistory() { return history; },
    async readLeases() { return leases; },
  }));
  const result = await reader.read(database(), identity);
  assert.equal(result.storage.state, "available");
  assert.equal(result.storage.state === "available" && result.storage.precision, "estimated");
  assert.equal(result.storage.state === "available" && result.storage.counts.total, storage.counts.total);
});

test("a failed retained-run aggregate leaves stored counts measured, and each recovers alone", async () => {
  let now = Date.parse(measuredAt);
  let recordReads = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(now), () => ({
    async readStorageCounts() { return storage; },
    async readRecordTotals() {
      recordReads += 1;
      if (recordReads === 1) throw new Error("retained-run aggregate failed");
      return { ...records, measuredAt: new Date(now).toISOString() };
    },
    async readHistory() { return history; },
    async readLeases() { return leases; },
  }));
  const client = database();
  const failed = await reader.read(client, identity);
  assert.deepEqual(failed.records, { state: "unavailable", reason: "query_failed" });
  assert.equal(failed.storage.state, "available", "stored counts are not withheld with the aggregate");

  now += 5_000;
  const recovered = await reader.read(client, identity);
  assert.equal(recordReads, 2, "the failed aggregate retries on the next refresh");
  assert.equal(recovered.records.state, "available");
  // Each measurement carries the snapshot it was actually read in.
  assert.equal(recovered.records.state === "available" && recovered.records.measuredAt,
    new Date(now).toISOString());
  assert.equal(recovered.storage.state === "available" && recovered.storage.measuredAt, measuredAt);
});
