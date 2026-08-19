import {
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
  REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
  parseRepackHeatTimestampMillis,
  publicRepackIdSchema,
} from "@packscout/contracts";
import type { RepackHeatObservation } from "./repack-heat-calculator.ts";

export const CANONICAL_HEAT_PROJECTION_VERSION =
  "canonical_heat_projection_v1" as const;
export const NORMALIZED_HEAT_OBSERVATION_VERSION =
  "normalized_heat_observation_v1" as const;
export const NORMALIZED_HEAT_MAXIMUM_BASIS_POINTS = 10_000_000 as const;
export const NORMALIZED_HEAT_MAXIMUM_AVAILABLE_CHASE_COUNT = 10_000 as const;

const observationKeyPattern = /^[0-9a-f]{64}$/;
const outcomeKeyPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;

const protectedFieldNames = new Set([
  "actor",
  "actorid",
  "credential",
  "credentials",
  "internalrunid",
  "organization",
  "organizationid",
  "providerid",
  "providerpayload",
  "quarantine",
  "quarantinedetail",
  "raw",
  "rawpayload",
  "runid",
  "secret",
  "secrets",
  "sourcepayload",
  "tenant",
  "tenantid",
  "token",
  "tokens",
  "userid",
  "useridentity",
]);

export type NormalizedHeatObservationErrorCode =
  | "NORMALIZED_HEAT_INPUT_INVALID"
  | "NORMALIZED_HEAT_PROTECTED_FIELD";

export class NormalizedHeatObservationError extends Error {
  constructor(readonly code: NormalizedHeatObservationErrorCode) {
    super("Normalized Heat observation input was rejected safely.");
    this.name = "NormalizedHeatObservationError";
  }
}

interface CanonicalHeatProjectionBase {
  readonly schemaVersion: typeof CANONICAL_HEAT_PROJECTION_VERSION;
  readonly sourceObservationKey: string;
  readonly publicRepackId: string;
  readonly occurredAt: string;
  readonly causalSequence: bigint;
}

export interface CanonicalHeatPullProjection
  extends CanonicalHeatProjectionBase {
  readonly kind: "pull";
  readonly realizedReturnBasisPoints: number | null;
  readonly valueMultipleBasisPoints: number | null;
}

export interface CanonicalHeatCatalogProjection
  extends CanonicalHeatProjectionBase {
  readonly kind: "catalog_snapshot";
  readonly catalogSequence: number;
  readonly availableChaseCount: number;
  readonly outcomeKeys: readonly string[];
}

export type CanonicalHeatProjection =
  | CanonicalHeatPullProjection
  | CanonicalHeatCatalogProjection;

interface NormalizedHeatObservationBase {
  readonly schemaVersion: typeof NORMALIZED_HEAT_OBSERVATION_VERSION;
  readonly observationKey: string;
  readonly publicRepackId: string;
  readonly occurredAt: string;
  readonly causalSequence: bigint;
}

export interface NormalizedHeatPullObservation
  extends NormalizedHeatObservationBase {
  readonly kind: "pull";
  readonly realizedReturnBasisPoints: number | null;
  readonly valueMultipleBasisPoints: number | null;
}

export interface NormalizedHeatCatalogObservation
  extends NormalizedHeatObservationBase {
  readonly kind: "catalog_snapshot";
  readonly catalogSequence: number;
  readonly availableChaseCount: number;
  readonly outcomeKeys: readonly string[];
}

export type NormalizedHeatObservation =
  | NormalizedHeatPullObservation
  | NormalizedHeatCatalogObservation;

type PlainRecord = Record<string, unknown>;

function refuse(code: NormalizedHeatObservationErrorCode): never {
  throw new NormalizedHeatObservationError(code);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function containsProtectedNormalizedHeatField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProtectedNormalizedHeatField);
  }
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      protectedFieldNames.has(normalizedFieldName(key)) ||
      containsProtectedNormalizedHeatField(nested),
  );
}

function assertExactKeys(record: PlainRecord, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    parseRepackHeatTimestampMillis(value) === null
  ) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  return value;
}

function publicRepackId(value: unknown): string {
  const parsed = publicRepackIdSchema.safeParse(value);
  if (!parsed.success) refuse("NORMALIZED_HEAT_INPUT_INVALID");
  return parsed.data;
}

function observationKey(value: unknown): string {
  if (typeof value !== "string" || !observationKeyPattern.test(value)) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  return value;
}

function causalSequence(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  return value;
}

function boundedInteger(
  value: unknown,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  return value;
}

function nullableBasisPoints(value: unknown): number | null {
  return value === null
    ? null
    : boundedInteger(value, NORMALIZED_HEAT_MAXIMUM_BASIS_POINTS);
}

function canonicalOutcomeKeys(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT
  ) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  const keys = value.map((key) => {
    if (typeof key !== "string" || !outcomeKeyPattern.test(key)) {
      refuse("NORMALIZED_HEAT_INPUT_INVALID");
    }
    return key;
  });
  if (keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  return Object.freeze(keys);
}

const canonicalBaseKeys = [
  "schemaVersion",
  "kind",
  "sourceObservationKey",
  "publicRepackId",
  "occurredAt",
  "causalSequence",
] as const;

const normalizedBaseKeys = [
  "schemaVersion",
  "kind",
  "observationKey",
  "publicRepackId",
  "occurredAt",
  "causalSequence",
] as const;

function parsedBase(
  record: PlainRecord,
  keyField: "observationKey" | "sourceObservationKey",
) {
  return {
    observationKey: observationKey(record[keyField]),
    publicRepackId: publicRepackId(record.publicRepackId),
    occurredAt: canonicalTimestamp(record.occurredAt),
    causalSequence: causalSequence(record.causalSequence),
  } as const;
}

function normalizedFromRecord(record: PlainRecord): NormalizedHeatObservation {
  const base = parsedBase(record, "observationKey");
  if (record.kind === "pull") {
    assertExactKeys(record, [
      ...normalizedBaseKeys,
      "realizedReturnBasisPoints",
      "valueMultipleBasisPoints",
    ]);
    return Object.freeze({
      schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
      kind: "pull",
      ...base,
      realizedReturnBasisPoints: nullableBasisPoints(
        record.realizedReturnBasisPoints,
      ),
      valueMultipleBasisPoints: nullableBasisPoints(
        record.valueMultipleBasisPoints,
      ),
    });
  }
  if (record.kind === "catalog_snapshot") {
    assertExactKeys(record, [
      ...normalizedBaseKeys,
      "catalogSequence",
      "availableChaseCount",
      "outcomeKeys",
    ]);
    return Object.freeze({
      schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
      kind: "catalog_snapshot",
      ...base,
      catalogSequence: boundedInteger(
        record.catalogSequence,
        REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
      ),
      availableChaseCount: boundedInteger(
        record.availableChaseCount,
        NORMALIZED_HEAT_MAXIMUM_AVAILABLE_CHASE_COUNT,
      ),
      outcomeKeys: canonicalOutcomeKeys(record.outcomeKeys),
    });
  }
  return refuse("NORMALIZED_HEAT_INPUT_INVALID");
}

export function validateNormalizedHeatObservation(
  value: unknown,
): NormalizedHeatObservation {
  if (containsProtectedNormalizedHeatField(value)) {
    refuse("NORMALIZED_HEAT_PROTECTED_FIELD");
  }
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== NORMALIZED_HEAT_OBSERVATION_VERSION
  ) {
    return refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  return normalizedFromRecord(value);
}

export function normalizeCanonicalHeatProjection(
  value: unknown,
): NormalizedHeatObservation {
  if (containsProtectedNormalizedHeatField(value)) {
    refuse("NORMALIZED_HEAT_PROTECTED_FIELD");
  }
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== CANONICAL_HEAT_PROJECTION_VERSION
  ) {
    return refuse("NORMALIZED_HEAT_INPUT_INVALID");
  }
  const base = parsedBase(value, "sourceObservationKey");
  if (value.kind === "pull") {
    assertExactKeys(value, [
      ...canonicalBaseKeys,
      "realizedReturnBasisPoints",
      "valueMultipleBasisPoints",
    ]);
    return Object.freeze({
      schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
      kind: "pull",
      ...base,
      realizedReturnBasisPoints: nullableBasisPoints(
        value.realizedReturnBasisPoints,
      ),
      valueMultipleBasisPoints: nullableBasisPoints(
        value.valueMultipleBasisPoints,
      ),
    });
  }
  if (value.kind === "catalog_snapshot") {
    assertExactKeys(value, [
      ...canonicalBaseKeys,
      "catalogSequence",
      "availableChaseCount",
      "outcomeKeys",
    ]);
    return Object.freeze({
      schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
      kind: "catalog_snapshot",
      ...base,
      catalogSequence: boundedInteger(
        value.catalogSequence,
        REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
      ),
      availableChaseCount: boundedInteger(
        value.availableChaseCount,
        NORMALIZED_HEAT_MAXIMUM_AVAILABLE_CHASE_COUNT,
      ),
      outcomeKeys: canonicalOutcomeKeys(value.outcomeKeys),
    });
  }
  return refuse("NORMALIZED_HEAT_INPUT_INVALID");
}

export function compareNormalizedHeatObservations(
  left: NormalizedHeatObservation,
  right: NormalizedHeatObservation,
): number {
  const identityOrder =
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.publicRepackId.localeCompare(right.publicRepackId) ||
    left.kind.localeCompare(right.kind);
  if (identityOrder !== 0) return identityOrder;
  if (left.kind === "catalog_snapshot" && right.kind === "catalog_snapshot") {
    const sequenceOrder = left.catalogSequence - right.catalogSequence;
    if (sequenceOrder !== 0) return sequenceOrder;
  }
  return left.observationKey.localeCompare(right.observationKey);
}

/** Strip persistence and organization fields before invoking the public calculator. */
export function toRepackHeatObservation(
  observation: NormalizedHeatObservation,
): RepackHeatObservation {
  if (observation.kind === "pull") {
    return Object.freeze({
      kind: "pull",
      publicRepackId: observation.publicRepackId,
      occurredAt: observation.occurredAt,
      realizedReturnBasisPoints: observation.realizedReturnBasisPoints,
      valueMultipleBasisPoints: observation.valueMultipleBasisPoints,
    });
  }
  return Object.freeze({
    kind: "catalog_snapshot",
    publicRepackId: observation.publicRepackId,
    occurredAt: observation.occurredAt,
    sequence: observation.catalogSequence,
    availableChaseCount: observation.availableChaseCount,
    outcomeKeys: observation.outcomeKeys,
  });
}
