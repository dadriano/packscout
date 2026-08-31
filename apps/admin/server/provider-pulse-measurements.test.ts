import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderPrismaClient,
  ProviderPulseActivity,
  ProviderPulseTotals,
} from "@packscout/database";
import { ProviderPulseMeasurementReader } from "./provider-pulse-measurements.ts";

const measuredAt = "2026-08-30T12:00:00.000Z";
const identity = { organizationId: "org-a", providerId: "provider-a", configurationId: "config-a" };
const totals: ProviderPulseTotals = {
  measuredAt,
  counts: { total: 10, categories: 1, packs: 1, collectibles: 1, aliases: 1,
    instances: 1, packContents: 1, accounts: 1, pulls: 1, pullItems: 1, marketEvents: 1 },
  processed: 20, accepted: 12,
};
const activity: ProviderPulseActivity = {
  measuredAt, lastCommittedPageAt: "2026-08-30T11:59:55.000Z",
  importLease: { state: "active", heartbeatAt: measuredAt, expiresAt: "2026-08-30T12:01:00.000Z" },
  promotionLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
  quarantine: { open: 2, resolved: 1, expired: 4, retained: 7 },
};
const database = () => ({}) as ProviderPrismaClient;

test("exact totals stay cached for sixty seconds while current activity is refreshed", async () => {
  let now = Date.parse(measuredAt);
  let scans = 0;
  let activityReads = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(now), () => ({
    async readTotals() { scans += 1; return { ...totals, measuredAt: new Date(now).toISOString() }; },
    async readActivity() { activityReads += 1; return { ...activity, measuredAt: new Date(now).toISOString() }; },
  }));
  const client = database();
  await reader.read(client, identity);
  now += 5_000;
  const second = await reader.read(client, identity);
  assert.equal(scans, 1);
  assert.equal(activityReads, 2);
  assert.equal(second.storage.state === "available" && second.storage.measuredAt, measuredAt);
  assert.equal(second.activity.state === "available" && second.activity.measuredAt, new Date(now).toISOString());
  now += 55_000;
  const refreshed = await reader.read(client, identity);
  assert.equal(scans, 2);
  assert.equal(refreshed.storage.state === "available" && refreshed.storage.measuredAt, new Date(now).toISOString());
});

test("tenant, provider, configuration, and authorized gateway client changes invalidate cached totals", async () => {
  let scans = 0;
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readTotals() { scans += 1; return totals; },
    async readActivity() { return activity; },
  }));
  const client = database();
  await reader.read(client, identity);
  await reader.read(client, { ...identity, organizationId: "org-b" });
  await reader.read(client, { ...identity, providerId: "provider-b" });
  await reader.read(client, { ...identity, configurationId: "config-b" });
  await reader.read(database(), { ...identity, configurationId: "config-b" });
  assert.equal(scans, 5);
});

test("concurrent authorized refreshes share one exact count query", async () => {
  let finish: (value: ProviderPulseTotals) => void = () => { throw new Error("query not started"); };
  let scans = 0;
  const waiting = new Promise<ProviderPulseTotals>((resolve) => { finish = resolve; });
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    readTotals() { scans += 1; return waiting; },
    async readActivity() { return activity; },
  }));
  const client = database();
  const first = reader.read(client, identity);
  const second = reader.read(client, identity);
  assert.equal(scans, 1);
  finish(totals);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
});

test("a timed-out count query leaves durable page and lease evidence available without invented zeros", async () => {
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readTotals() { throw new Error("statement timeout"); },
    async readActivity() { return activity; },
  }));
  const result = await reader.read(database(), identity);
  assert.deepEqual(result.storage, { state: "unavailable", reason: "query_failed" });
  assert.deepEqual(result.records, { state: "unavailable", reason: "query_failed" });
  assert.deepEqual(result.activity, { state: "available", ...activity });
  assert.equal(JSON.stringify(result).includes("statement timeout"), false);
});

test("missing activity never discards exact retained counts, and malformed counts fail closed", async () => {
  const reader = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readTotals() { return totals; },
    async readActivity() { throw new Error("activity query unavailable"); },
  }));
  const result = await reader.read(database(), identity);
  assert.equal(result.storage.state, "available");
  assert.deepEqual(result.activity, { state: "unavailable", reason: "query_failed" });

  const malformed = new ProviderPulseMeasurementReader(() => new Date(measuredAt), () => ({
    async readTotals() { return { ...totals, counts: { ...totals.counts, total: -1 } }; },
    async readActivity() { return activity; },
  }));
  const rejected = await malformed.read(database(), identity);
  assert.equal(rejected.storage.state, "unavailable");
  assert.equal(rejected.activity.state, "available");
});
