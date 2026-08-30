import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dataReleaseV3RetainedEvWitnessRequestSchema, dataReleaseV3RetainedEvWitnessSchema,
  dataReleaseV3RetainedEvWitnessWithinByteLimit, MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES,
  dataReleaseV3RetainedEvWitnessReadinessRequestSchema, dataReleaseV3RetainedEvWitnessReadinessSchema,
} from "./data-release-v3-retained-ev-witness.ts";
import { buildPublicRepackDetailV3 } from "./__fixtures__/data-release-v3.fixture.ts";

const detail = buildPublicRepackDetailV3();
const scope = { vendorKey: detail.vendorKey, publicVendorId: detail.publicVendorId, publicRepackId: detail.publicRepackId };
const releaseId = "10000000-0000-4000-8000-000000000001";
const request = { expectedActivePublicReleaseId: releaseId, expectedActiveReleaseFingerprint: "a".repeat(64),
  expectedGeneration: 2, scopes: [scope] };
const value = { estimate: detail.evEstimates.packScout, calculationPriceUsdMinor: 10_000,
  sourcePublicReleaseId: releaseId, latestUnavailableAttempt: null };
const witness = { generation: 2, activePublicReleaseId: releaseId, activeReleaseFingerprint: "a".repeat(64),
  retention: { operationId: "activation-2", direction: "forward", changesSha256: "b".repeat(64) },
  entries: [{ ...scope, activeFacts: { availability: detail.availability,
    estimate: detail.evEstimates.packScout, calculationPriceUsdMinor: 10_000 }, retained: value }],
  witnessSha256: "c".repeat(64) };

test("retained witness scope admission is unique and fixed at 100 with exact active pins", () => {
  const scopes = Array.from({ length: 100 }, (_, index) => ({ ...scope,
    publicRepackId: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}` }));
  assert.equal(dataReleaseV3RetainedEvWitnessRequestSchema.safeParse({ ...request, scopes }).success, true);
  for (const patch of [{ scopes: [] }, { scopes: [...scopes, scope] }, { scopes: [scope, scope] },
    { expectedGeneration: 0 }, { expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { expectedActiveReleaseFingerprint: "invalid" }, { extra: true }]) {
    assert.equal(dataReleaseV3RetainedEvWitnessRequestSchema.safeParse({ ...request, ...patch }).success, false);
  }
});

test("retained witness accepts only original raw economics with a later explicit failure marker", () => {
  assert.equal(dataReleaseV3RetainedEvWitnessSchema.safeParse(witness).success, true);
  const at = detail.evEstimates.packScout.calculatedAt;
  const later = { calculatedAt: new Date(Date.parse(at) + 60_000).toISOString(), reason: "SOURCE_EVIDENCE_UNAVAILABLE" };
  assert.equal(dataReleaseV3RetainedEvWitnessSchema.safeParse({ ...witness, entries: [{ ...witness.entries[0],
    retained: { ...value, latestUnavailableAttempt: later } }] }).success, true);
  for (const retained of [null, { ...value, calculationPriceUsdMinor: 20_000 },
    { ...value, sourcePublicReleaseId: "untrusted" },
    { ...value, latestUnavailableAttempt: { ...later, calculatedAt: at } },
    { ...value, latestUnavailableAttempt: { ...later, reason: "UNKNOWN" } },
    { ...value, estimate: { ...value.estimate, status: "last_known" } }]) {
    assert.equal(dataReleaseV3RetainedEvWitnessSchema.safeParse({ ...witness,
      entries: [{ ...witness.entries[0], retained }] }).success, false);
  }
});

test("retained witness byte ceiling admits exactly 512 KiB and rejects the next byte", () => {
  assert.equal(dataReleaseV3RetainedEvWitnessWithinByteLimit("x".repeat(MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES - 2)), true);
  assert.equal(dataReleaseV3RetainedEvWitnessWithinByteLimit("x".repeat(MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES - 1)), false);
});

test("readiness alone admits exact empty genesis and refuses half-null or invented pointer evidence", () => {
  assert.equal(dataReleaseV3RetainedEvWitnessReadinessRequestSchema.safeParse({
    expectedGeneration: 0, expectedActivePublicReleaseId: null, expectedActiveReleaseFingerprint: null }).success, true);
  assert.equal(dataReleaseV3RetainedEvWitnessReadinessRequestSchema.safeParse({
    expectedGeneration: 0, expectedActivePublicReleaseId: releaseId, expectedActiveReleaseFingerprint: null }).success, false);
  const empty = { generation: 0, activePublicReleaseId: null, activeReleaseFingerprint: null, retention: null };
  assert.equal(dataReleaseV3RetainedEvWitnessReadinessSchema.safeParse(empty).success, true);
  for (const patch of [{ generation: 1 }, { activePublicReleaseId: releaseId }, { retention: witness.retention }]) {
    assert.equal(dataReleaseV3RetainedEvWitnessReadinessSchema.safeParse({ ...empty, ...patch }).success, false);
  }
});
