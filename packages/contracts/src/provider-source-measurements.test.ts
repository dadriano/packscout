import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerSourceMeasurementsSchema,
  unavailableProviderSourceMeasurements,
} from "./provider-source-measurements.ts";

const measuredAt = "2026-08-30T12:00:00.000Z";
const measured = {
  storage: {
    state: "available", measuredAt,
    counts: { total: 10, categories: 1, packs: 1, collectibles: 1, aliases: 1,
      instances: 1, packContents: 1, accounts: 1, pulls: 1, pullItems: 1, marketEvents: 1 },
  },
  records: { state: "available", measuredAt, processed: 12, accepted: 9 },
  activity: {
    state: "available", measuredAt, historyMeasuredAt: measuredAt, lastCommittedPageAt: null,
    importLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
    promotionLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
    quarantine: { open: 1, resolved: 2, expired: 3, retained: 6 },
  },
};

test("provider measurements distinguish unavailable evidence from a measured empty database", () => {
  const unavailable = unavailableProviderSourceMeasurements("database_unreachable");
  assert.deepEqual(providerSourceMeasurementsSchema.parse(unavailable), unavailable);
  assert.equal(providerSourceMeasurementsSchema.safeParse({
    ...unavailable, storage: { ...unavailable.storage, counts: measured.storage.counts },
  }).success, false);
  assert.equal(providerSourceMeasurementsSchema.safeParse({
    ...measured,
    storage: { ...measured.storage, counts: Object.fromEntries(
      Object.keys(measured.storage.counts).map((key) => [key, 0]),
    ) },
    records: { ...measured.records, processed: 0, accepted: 0 },
  }).success, true);
});

test("exact provider measurements reconcile totals and preserve safe numeric precision", () => {
  assert.deepEqual(providerSourceMeasurementsSchema.parse(measured), measured);
  for (const total of [11, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(providerSourceMeasurementsSchema.safeParse({
      ...measured, storage: { ...measured.storage, counts: { ...measured.storage.counts, total } },
    }).success, false);
  }
  assert.equal(providerSourceMeasurementsSchema.safeParse({
    ...measured, records: { ...measured.records, accepted: 13 },
  }).success, false);
});

test("a whole-provider unavailable result cannot be built from a storage-only reason", () => {
  // The storage-only reason obliges an estimate, which this helper does not
  // report, so accepting it would return a value its own type rejects. The
  // constraint is in the type: without the directive below this line fails to
  // compile, and if the argument is ever widened again the directive does.
  // @ts-expect-error count_exceeds_budget is not a whole-provider reason
  const invalid = () => unavailableProviderSourceMeasurements("count_exceeds_budget");
  assert.equal(typeof invalid, "function");

  // Every reason the helper does accept round-trips through the schema.
  for (const reason of ["not_configured", "unsupported", "database_unreachable", "query_failed"] as const) {
    const measurements = unavailableProviderSourceMeasurements(reason);
    assert.deepEqual(providerSourceMeasurementsSchema.parse(measurements), measurements);
  }
});

test("an estimate never occupies the field that means an exact count", () => {
  const estimate = { measuredAt, counts: measured.storage.counts };
  const estimated = providerSourceMeasurementsSchema.parse({
    ...measured,
    storage: { state: "unavailable", reason: "count_exceeds_budget" },
    storageEstimate: estimate,
  });
  // A reader that knows only `storage` is told nothing was counted.
  assert.equal(estimated.storage.state, "unavailable");
  assert.deepEqual(estimated.storageEstimate, estimate);

  // The two answers are mutually exclusive in both directions.
  assert.equal(providerSourceMeasurementsSchema.safeParse({
    ...measured, storageEstimate: estimate,
  }).success, false, "an exact count must not also carry an estimate");
  assert.equal(providerSourceMeasurementsSchema.safeParse({
    ...measured, storage: { state: "unavailable", reason: "count_exceeds_budget" },
  }).success, false, "rows left uncounted for budget must report an estimate");

  // An estimate is still a full, self-consistent set of counts.
  assert.equal(providerSourceMeasurementsSchema.safeParse({
    ...measured,
    storage: { state: "unavailable", reason: "count_exceeds_budget" },
    storageEstimate: { ...estimate, counts: { ...estimate.counts, total: 11 } },
  }).success, false);
});

test("separate statements may report separate snapshot times", () => {
  const split = providerSourceMeasurementsSchema.parse({
    ...measured, records: { ...measured.records, measuredAt: "2026-08-30T11:00:00.000Z" },
  });
  assert.equal(split.records.state === "available" && split.records.measuredAt,
    "2026-08-30T11:00:00.000Z");
  assert.equal(split.storage.state === "available" && split.storage.measuredAt, measuredAt);
});

test("lease measurements never expose owners or claim to verify OS process liveness", () => {
  for (const field of ["owner", "leaseOwner", "processAlive"]) {
    assert.equal(providerSourceMeasurementsSchema.safeParse({
      ...measured, activity: { ...measured.activity,
        importLease: { ...measured.activity.importLease, [field]: "private-host" } },
    }).success, false);
  }
});

test("cached activity history retains its own required observation time beside fresh leases", () => {
  const historyMeasuredAt = "2026-08-30T11:59:15.000Z";
  const result = providerSourceMeasurementsSchema.parse({
    ...measured, activity: { ...measured.activity, historyMeasuredAt },
  });
  assert.equal(result.activity.state, "available");
  if (result.activity.state !== "available") return;
  assert.equal(result.activity.measuredAt, measuredAt);
  assert.equal(result.activity.historyMeasuredAt, historyMeasuredAt);
  for (const invalid of [undefined, null, "recently"]) {
    assert.equal(providerSourceMeasurementsSchema.safeParse({
      ...measured, activity: { ...measured.activity, historyMeasuredAt: invalid },
    }).success, false);
  }
});
