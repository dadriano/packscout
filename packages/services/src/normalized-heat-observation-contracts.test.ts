import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
  REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
} from "@packscout/contracts";
import {
  CANONICAL_HEAT_PROJECTION_VERSION,
  NORMALIZED_HEAT_MAXIMUM_AVAILABLE_CHASE_COUNT,
  NORMALIZED_HEAT_MAXIMUM_BASIS_POINTS,
  NORMALIZED_HEAT_OBSERVATION_VERSION,
  NormalizedHeatObservationError,
  compareNormalizedHeatObservations,
  normalizeCanonicalHeatProjection,
  toRepackHeatObservation,
} from "./normalized-heat-observation-contracts.ts";

const publicRepackId = "55000000-0000-5000-8000-000000000001";
const occurredAt = "2026-08-15T12:00:00.000Z";
const pullKey = "a".repeat(64);
const catalogKey = "b".repeat(64);

function pullProjection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CANONICAL_HEAT_PROJECTION_VERSION,
    kind: "pull",
    sourceObservationKey: pullKey,
    publicRepackId,
    occurredAt,
    causalSequence: 41n,
    realizedReturnBasisPoints: null,
    valueMultipleBasisPoints: 0,
    ...overrides,
  };
}

function catalogProjection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CANONICAL_HEAT_PROJECTION_VERSION,
    kind: "catalog_snapshot",
    sourceObservationKey: catalogKey,
    publicRepackId,
    occurredAt,
    causalSequence: 42n,
    catalogSequence: 7,
    availableChaseCount: 3,
    outcomeKeys: ["alpha", "beta"],
    ...overrides,
  };
}

function normalizedError(code: NormalizedHeatObservationError["code"]) {
  return (error: unknown) =>
    error instanceof NormalizedHeatObservationError && error.code === code;
}

test("maps only allowlisted pull evidence and preserves null separately from zero", () => {
  const first = normalizeCanonicalHeatProjection(pullProjection());
  const replay = normalizeCanonicalHeatProjection(pullProjection());

  assert.deepEqual(first, replay);
  assert.deepEqual(first, {
    schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
    kind: "pull",
    observationKey: pullKey,
    publicRepackId,
    occurredAt,
    causalSequence: 41n,
    realizedReturnBasisPoints: null,
    valueMultipleBasisPoints: 0,
  });
  assert.deepEqual(toRepackHeatObservation(first), {
    kind: "pull",
    publicRepackId,
    occurredAt,
    realizedReturnBasisPoints: null,
    valueMultipleBasisPoints: 0,
  });
});

test("maps bounded canonical catalog evidence with sorted unique outcome keys", () => {
  const normalized = normalizeCanonicalHeatProjection(
    catalogProjection({
      catalogSequence: REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
    }),
  );

  assert.deepEqual(toRepackHeatObservation(normalized), {
    kind: "catalog_snapshot",
    publicRepackId,
    occurredAt,
    sequence: REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
    availableChaseCount: 3,
    outcomeKeys: ["alpha", "beta"],
  });
  assert.throws(
    () =>
      normalizeCanonicalHeatProjection(
        catalogProjection({ outcomeKeys: ["beta", "alpha"] }),
      ),
    normalizedError("NORMALIZED_HEAT_INPUT_INVALID"),
  );
  assert.throws(
    () =>
      normalizeCanonicalHeatProjection(
        catalogProjection({
          availableChaseCount:
            NORMALIZED_HEAT_MAXIMUM_AVAILABLE_CHASE_COUNT + 1,
        }),
      ),
    normalizedError("NORMALIZED_HEAT_INPUT_INVALID"),
  );
  assert.throws(
    () =>
      normalizeCanonicalHeatProjection(
        catalogProjection({
          outcomeKeys: Array.from(
            {
              length:
                REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT + 1,
            },
            (_, index) => `key-${index.toString().padStart(5, "0")}`,
          ),
        }),
      ),
    normalizedError("NORMALIZED_HEAT_INPUT_INVALID"),
  );
  assert.throws(
    () =>
      normalizeCanonicalHeatProjection(
        catalogProjection({ outcomeKeys: ["alpha", "alpha"] }),
      ),
    normalizedError("NORMALIZED_HEAT_INPUT_INVALID"),
  );
  assert.throws(
    () =>
      normalizeCanonicalHeatProjection(
        catalogProjection({
          catalogSequence: REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE + 1,
        }),
      ),
    normalizedError("NORMALIZED_HEAT_INPUT_INVALID"),
  );
});

test("orders equal-time observations deterministically by catalog sequence", () => {
  const later = normalizeCanonicalHeatProjection(
    catalogProjection({ sourceObservationKey: "c".repeat(64), catalogSequence: 9 }),
  );
  const earlier = normalizeCanonicalHeatProjection(
    catalogProjection({ sourceObservationKey: "d".repeat(64), catalogSequence: 8 }),
  );

  assert.deepEqual(
    [later, earlier].sort(compareNormalizedHeatObservations),
    [earlier, later],
  );
});

test("rejects malformed evidence before it can enter aggregation", () => {
  for (const candidate of [
    pullProjection({ occurredAt: "2026-08-15T12:00:00Z" }),
    pullProjection({ realizedReturnBasisPoints: -1 }),
    pullProjection({
      realizedReturnBasisPoints: NORMALIZED_HEAT_MAXIMUM_BASIS_POINTS + 1,
    }),
    pullProjection({ valueMultipleBasisPoints: Number.NaN }),
    pullProjection({ unsupportedEvidence: 1 }),
    { ...pullProjection(), valueMultipleBasisPoints: undefined },
  ]) {
    assert.throws(
      () => normalizeCanonicalHeatProjection(candidate),
      normalizedError("NORMALIZED_HEAT_INPUT_INVALID"),
    );
  }
});

test("rejects protected fields recursively without echoing their values", () => {
  for (const field of [
    "organizationId",
    "tenantId",
    "providerId",
    "actorId",
    "rawPayload",
    "credential",
  ]) {
    const secret = `never-log-${field}`;
    assert.throws(
      () =>
        normalizeCanonicalHeatProjection({
          ...pullProjection(),
          envelope: { [field]: secret },
        }),
      (error: unknown) =>
        error instanceof NormalizedHeatObservationError &&
        error.code === "NORMALIZED_HEAT_PROTECTED_FIELD" &&
        !error.message.includes(secret),
    );
  }
});

test("calculator-facing serialization contains no organization, provider, actor, or raw fields", () => {
  const serialized = JSON.stringify(
    [pullProjection(), catalogProjection()]
      .map(normalizeCanonicalHeatProjection)
      .map(toRepackHeatObservation),
  ).toLowerCase();

  for (const protectedName of [
    "organization",
    "tenant",
    "provider",
    "actor",
    "raw",
    "causalsequence",
    "observationkey",
  ]) {
    assert.equal(serialized.includes(protectedName), false);
  }
});
