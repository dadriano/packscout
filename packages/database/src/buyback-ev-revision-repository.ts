import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PUBLIC_REASON_CODES_V1,
  packScoutBuybackEvMetricsAreConsistentV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
} from "@packscout/contracts";
import type { PackScoutBuybackEvConfidenceLimitationCodeV1 } from "@packscout/contracts";
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
import type {
  PackscoutPrismaClient,
  PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { isPrismaUniqueConstraintError } from "./prisma-error.ts";

/**
 * Immutable revision store for `packscout-buyback-adjusted-ev-v1`
 * (task buyback-adjusted-ev/005).
 *
 * Completed available and unavailable calculations are append-only rows in
 * `buyback_ev_revisions`; failed or unbindable work only ever reaches the
 * separate `buyback_ev_persistence_failures` ledger, so it can never advance
 * completed freshness or occupy a completed identity. Historical pre-buyback
 * results live in `canonical_revisions` under their original method version
 * and are structurally unreachable from this store.
 */

const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PLATFORM_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const PRODUCT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u;
const SOURCE_REVISION_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,126}[A-Za-z0-9])?$/u;
const MAX_SOURCE_REFERENCES = 16;
const MAX_MONEY_MINOR_UNITS = 1_000_000_000_000;
const PERSIST_ATTEMPTS = 3;

export const BUYBACK_EV_FAILURE_REASON_CODES = Object.freeze([
  "CONTRACT_VIOLATION",
  "IDENTITY_REUSE_CONFLICT",
  "RESULT_CONFLICT",
  "UNBINDABLE_RESULT",
] as const);

export type BuybackEvFailureReasonCode =
  (typeof BUYBACK_EV_FAILURE_REASON_CODES)[number];

export type BuybackEvRevisionIntegrityCode =
  | "ARITHMETIC_INVARIANTS_VIOLATED"
  | "ROW_SHAPE_INVALID";

/** A stored revision no longer satisfies its persisted invariants. */
export class BuybackEvRevisionIntegrityError extends Error {
  constructor(readonly code: BuybackEvRevisionIntegrityCode) {
    super("PackScout buyback EV revision failed read validation.");
    this.name = "BuybackEvRevisionIntegrityError";
  }
}

export interface BuybackEvRevisionSourceReference {
  readonly referenceIndex: number;
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256: string | null;
  readonly canonicalRevisionId: string | null;
}

export interface BuybackEvRevisionMetrics {
  readonly packPriceMinorUnits: number;
  readonly underlyingOutcomeEvMinorUnits: number;
  readonly drawMultiplier: number;
  readonly grossEvMinorUnits: number;
  readonly grossReturnBasisPoints: number;
  readonly evDollarsMinorUnits: number;
  readonly evPercentBasisPoints: number;
}

export interface BuybackEvRevisionConfidence {
  readonly scoreBasisPoints: number;
  readonly band: "low" | "medium" | "high";
  readonly limitationCodes: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[];
}

export type BuybackEvRevisionFreshness =
  | Readonly<{
      state: "current" | "expired";
      sourceAgeMilliseconds: number;
      expiresAt: string;
    }>
  | Readonly<{
      state: "unknown_source_time";
      sourceAgeMilliseconds: null;
      expiresAt: null;
    }>;

export interface BuybackEvRevisionRecord {
  readonly revisionId: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly lifecycle: "completed";
  readonly status: "available" | "unavailable";
  readonly revisionNumber: number;
  readonly calculationKey: string;
  readonly effectiveFingerprint: string;
  readonly resultHash: string;
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256: string | null;
  readonly observationCoherence: "provider_revision" | "guarded_collection";
  readonly oddsSource: "current_remaining_inventory" | "platform_published";
  readonly usedClosedRangeMidpoint: boolean;
  readonly calculatedAt: string;
  readonly dataAsOf:
    | Readonly<{ state: "known"; observedAt: string }>
    | Readonly<{ state: "unknown_source_time"; observedAt: null }>;
  readonly metrics: BuybackEvRevisionMetrics | null;
  readonly confidence: BuybackEvRevisionConfidence | null;
  readonly freshness: BuybackEvRevisionFreshness;
  readonly internalReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
  readonly publicPrimaryReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly createdAt: string;
}

export interface PersistBuybackEvRevisionRowInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly status: "available" | "unavailable";
  readonly calculationKey: string;
  readonly effectiveFingerprint: string;
  readonly resultHash: string;
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256: string | null;
  readonly observationCoherence: "provider_revision" | "guarded_collection";
  readonly oddsSource: "current_remaining_inventory" | "platform_published";
  readonly usedClosedRangeMidpoint: boolean;
  readonly calculatedAt: string;
  readonly dataAsOf:
    | Readonly<{ state: "known"; observedAt: string }>
    | Readonly<{ state: "unknown_source_time"; observedAt: null }>;
  readonly metrics: BuybackEvRevisionMetrics | null;
  readonly confidence: BuybackEvRevisionConfidence | null;
  readonly freshness: BuybackEvRevisionFreshness;
  readonly internalReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
  readonly publicPrimaryReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly sourceReferences: readonly BuybackEvRevisionSourceReference[];
}

export type PersistBuybackEvRevisionRowResult =
  | Readonly<{ outcome: "created"; row: BuybackEvRevisionRecord }>
  | Readonly<{ outcome: "unchanged"; row: BuybackEvRevisionRecord }>
  | Readonly<{ outcome: "identity_conflict" }>
  | Readonly<{ outcome: "result_conflict" }>;

export interface RecordBuybackEvPersistenceFailureInput {
  readonly organizationId: string;
  readonly failureKey: string;
  readonly reasonCode: BuybackEvFailureReasonCode;
  readonly providerId: string | null;
  readonly platformKey: string | null;
  readonly productKey: string | null;
  readonly seenAt: string;
}

export interface BuybackEvRevisionTrace {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly status: "available" | "unavailable";
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly platformKey: string;
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly calculationKey: string;
  readonly effectiveFingerprint: string;
  readonly resultHash: string;
  readonly calculatedAt: string;
  readonly sourceReferences: readonly BuybackEvRevisionSourceReference[];
}

type RevisionRow = NonNullable<
  Awaited<ReturnType<PackscoutPrismaClient["buyback_ev_revisions"]["findFirst"]>>
>;

function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new RangeError(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function requireHex64(value: string, field: string): string {
  if (!HEX_64_PATTERN.test(value)) {
    throw new RangeError(`${field} must be a lowercase sha-256 hex digest.`);
  }
  return value;
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) throw new RangeError(`${field} is invalid.`);
  return value;
}

function requireCanonicalTimestamp(value: string, field: string): Date {
  const milliseconds = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new RangeError(`${field} must be a canonical UTC millisecond timestamp.`);
  }
  return new Date(milliseconds);
}

function safeNumber(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new BuybackEvRevisionIntegrityError("ROW_SHAPE_INVALID");
  }
  return numeric;
}

function memberOf<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return (values as readonly string[]).includes(value);
}

function rowToRecord(
  row: RevisionRow,
  validate: boolean,
): BuybackEvRevisionRecord {
  const status = row.status === "available" ? "available" : "unavailable";
  const metrics: BuybackEvRevisionMetrics | null =
    row.gross_ev_minor_units === null ||
      row.gross_return_basis_points === null ||
      row.ev_dollars_minor_units === null ||
      row.ev_percent_basis_points === null ||
      row.pack_price_minor_units === null ||
      row.underlying_outcome_ev_minor_units === null ||
      row.draw_multiplier === null
      ? null
      : {
        packPriceMinorUnits: safeNumber(row.pack_price_minor_units),
        underlyingOutcomeEvMinorUnits: safeNumber(
          row.underlying_outcome_ev_minor_units,
        ),
        drawMultiplier: row.draw_multiplier,
        grossEvMinorUnits: safeNumber(row.gross_ev_minor_units),
        grossReturnBasisPoints: safeNumber(row.gross_return_basis_points),
        evDollarsMinorUnits: safeNumber(row.ev_dollars_minor_units),
        evPercentBasisPoints: safeNumber(row.ev_percent_basis_points),
      };
  const confidence: BuybackEvRevisionConfidence | null =
    row.confidence_score_basis_points === null || row.confidence_band === null
      ? null
      : {
        scoreBasisPoints: row.confidence_score_basis_points,
        band: row.confidence_band as "low" | "medium" | "high",
        limitationCodes: row.confidence_limitation_codes.filter(
          (code): code is PackScoutBuybackEvConfidenceLimitationCodeV1 =>
            memberOf(PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1, code),
        ),
      };
  if (
    row.freshness_state !== "unknown_source_time" &&
    (row.source_age_milliseconds === null || row.freshness_expires_at === null)
  ) {
    throw new BuybackEvRevisionIntegrityError("ROW_SHAPE_INVALID");
  }
  const freshness: BuybackEvRevisionFreshness =
    row.freshness_state === "unknown_source_time" ||
      row.source_age_milliseconds === null ||
      row.freshness_expires_at === null
      ? { state: "unknown_source_time", sourceAgeMilliseconds: null, expiresAt: null }
      : {
        state: row.freshness_state === "current" ? "current" : "expired",
        sourceAgeMilliseconds: safeNumber(row.source_age_milliseconds),
        expiresAt: row.freshness_expires_at.toISOString(),
      };
  const record: BuybackEvRevisionRecord = {
    revisionId: row.id,
    organizationId: row.organization_id,
    providerId: row.provider_id,
    configurationRevisionId: row.configuration_revision_id,
    platformKey: row.platform_key,
    productKey: row.product_key,
    productRevisionId: row.product_revision_id,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    lifecycle: "completed",
    status,
    revisionNumber: row.revision_number,
    calculationKey: row.calculation_key,
    effectiveFingerprint: row.effective_fingerprint,
    resultHash: row.result_hash,
    sourceRevisionId: row.source_revision_id,
    sourceManifestSha256: row.source_manifest_sha256,
    observationCoherence:
      row.observation_coherence === "provider_revision"
        ? "provider_revision"
        : "guarded_collection",
    oddsSource:
      row.odds_source === "current_remaining_inventory"
        ? "current_remaining_inventory"
        : "platform_published",
    usedClosedRangeMidpoint: row.used_closed_range_midpoint,
    calculatedAt: row.calculated_at.toISOString(),
    dataAsOf:
      row.data_as_of_state === "known" && row.data_observed_at !== null
        ? { state: "known", observedAt: row.data_observed_at.toISOString() }
        : { state: "unknown_source_time", observedAt: null },
    metrics,
    confidence,
    freshness,
    internalReasons: row.internal_reasons.filter(
      (code): code is PackScoutBuybackEvInternalReasonCodeV1 =>
        memberOf(PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1, code),
    ),
    publicPrimaryReason:
      row.public_primary_reason !== null &&
        memberOf(PACKSCOUT_BUYBACK_EV_PUBLIC_REASON_CODES_V1, row.public_primary_reason)
        ? row.public_primary_reason
        : null,
    createdAt: row.created_at.toISOString(),
  };
  if (validate) validateRecordInvariants(record);
  return record;
}

/**
 * Re-proves the persisted arithmetic and shape relationships on read so a
 * corrupted or inconsistent row fails validation instead of being served.
 */
export function validateRecordInvariants(record: BuybackEvRevisionRecord): void {
  if (record.lifecycle !== "completed" ||
    record.methodVersion !== PACKSCOUT_BUYBACK_EV_METHOD_VERSION) {
    throw new BuybackEvRevisionIntegrityError("ROW_SHAPE_INVALID");
  }
  if (record.status === "available") {
    if (
      record.metrics === null ||
      record.confidence === null ||
      record.dataAsOf.state !== "known" ||
      record.freshness.state !== "current" ||
      record.internalReasons.length > 0 ||
      record.publicPrimaryReason !== null
    ) {
      throw new BuybackEvRevisionIntegrityError("ROW_SHAPE_INVALID");
    }
    if (
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: record.metrics.grossEvMinorUnits,
        grossReturnBasisPoints: record.metrics.grossReturnBasisPoints,
        evDollarsMinorUnits: record.metrics.evDollarsMinorUnits,
        evPercentBasisPoints: record.metrics.evPercentBasisPoints,
        packPriceMinorUnits: record.metrics.packPriceMinorUnits,
      })
    ) {
      throw new BuybackEvRevisionIntegrityError("ARITHMETIC_INVARIANTS_VIOLATED");
    }
    return;
  }
  if (
    record.metrics !== null ||
    record.confidence !== null ||
    record.internalReasons.length === 0 ||
    record.publicPrimaryReason === null
  ) {
    throw new BuybackEvRevisionIntegrityError("ROW_SHAPE_INVALID");
  }
}

function validateRowInput(input: PersistBuybackEvRevisionRowInput): void {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.providerId, "providerId");
  requireUuid(input.configurationRevisionId, "configurationRevisionId");
  requirePattern(input.platformKey, PLATFORM_KEY_PATTERN, "platformKey");
  requirePattern(input.productKey, PRODUCT_KEY_PATTERN, "productKey");
  requirePattern(
    input.productRevisionId,
    SOURCE_REVISION_PATTERN,
    "productRevisionId",
  );
  requirePattern(
    input.sourceRevisionId,
    SOURCE_REVISION_PATTERN,
    "sourceRevisionId",
  );
  requireHex64(input.calculationKey, "calculationKey");
  requireHex64(input.effectiveFingerprint, "effectiveFingerprint");
  requireHex64(input.resultHash, "resultHash");
  if (input.sourceManifestSha256 !== null) {
    requireHex64(input.sourceManifestSha256, "sourceManifestSha256");
  }
  requireCanonicalTimestamp(input.calculatedAt, "calculatedAt");
  if (input.dataAsOf.state === "known") {
    requireCanonicalTimestamp(input.dataAsOf.observedAt, "dataAsOf.observedAt");
  }
  if (input.metrics !== null) {
    for (const [field, value] of Object.entries(input.metrics)) {
      if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MONEY_MINOR_UNITS * 10_000) {
        throw new RangeError(`metrics.${field} is out of bounds.`);
      }
    }
  }
  if (
    input.sourceReferences.length < 1 ||
    input.sourceReferences.length > MAX_SOURCE_REFERENCES
  ) {
    throw new RangeError(
      `sourceReferences must contain between 1 and ${MAX_SOURCE_REFERENCES} entries.`,
    );
  }
  const seen = new Set<string>();
  input.sourceReferences.forEach((reference, index) => {
    if (reference.referenceIndex !== index) {
      throw new RangeError("sourceReferences must be densely indexed from zero.");
    }
    requirePattern(
      reference.sourceRevisionId,
      SOURCE_REVISION_PATTERN,
      `sourceReferences[${index}].sourceRevisionId`,
    );
    if (reference.sourceManifestSha256 !== null) {
      requireHex64(
        reference.sourceManifestSha256,
        `sourceReferences[${index}].sourceManifestSha256`,
      );
    }
    if (reference.canonicalRevisionId !== null) {
      requireUuid(
        reference.canonicalRevisionId,
        `sourceReferences[${index}].canonicalRevisionId`,
      );
    }
    if (seen.has(reference.sourceRevisionId)) {
      throw new RangeError("sourceReferences must not repeat a source revision.");
    }
    seen.add(reference.sourceRevisionId);
  });
  if (!seen.has(input.sourceRevisionId)) {
    throw new RangeError(
      "sourceReferences must include the governing observation source revision.",
    );
  }
}

export class BuybackEvRevisionRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async persistCompletedRevision(
    input: PersistBuybackEvRevisionRowInput,
  ): Promise<PersistBuybackEvRevisionRowResult> {
    validateRowInput(input);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.database.$transaction(
          (transaction) => this.persistWithinTransaction(transaction, input),
          PACKSCOUT_TRANSACTION_OPTIONS,
        );
      } catch (error) {
        const retryable = isPrismaUniqueConstraintError(error, {
          fields: [
            "organization_id",
            "platform_key",
            "product_key",
            "revision_number",
          ],
          constraintNames: ["buyback_ev_revisions_product_number_unique"],
        });
        if (!retryable || attempt >= PERSIST_ATTEMPTS) throw error;
      }
    }
  }

  private async persistWithinTransaction(
    transaction: PackscoutTransactionClient,
    input: PersistBuybackEvRevisionRowInput,
  ): Promise<PersistBuybackEvRevisionRowResult> {
    await this.assertTenantScope(transaction, input);
    const existing = await transaction.buyback_ev_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        calculation_key: input.calculationKey,
      },
    });
    if (existing) {
      if (existing.effective_fingerprint !== input.effectiveFingerprint) {
        return { outcome: "identity_conflict" };
      }
      if (existing.result_hash !== input.resultHash) {
        return { outcome: "result_conflict" };
      }
      return { outcome: "unchanged", row: rowToRecord(existing, true) };
    }
    const fingerprintOwner = await transaction.buyback_ev_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        effective_fingerprint: input.effectiveFingerprint,
      },
      select: { id: true },
    });
    if (fingerprintOwner) {
      return { outcome: "identity_conflict" };
    }
    const latest = await transaction.buyback_ev_revisions.aggregate({
      _max: { revision_number: true },
      where: {
        organization_id: input.organizationId,
        platform_key: input.platformKey,
        product_key: input.productKey,
      },
    });
    const created = await transaction.buyback_ev_revisions.create({
      data: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        configuration_revision_id: input.configurationRevisionId,
        platform_key: input.platformKey,
        product_key: input.productKey,
        product_revision_id: input.productRevisionId,
        method_version: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        confidence_policy_version:
          PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        lifecycle: "completed",
        status: input.status,
        revision_number: (latest._max.revision_number ?? 0) + 1,
        calculation_key: input.calculationKey,
        effective_fingerprint: input.effectiveFingerprint,
        result_hash: input.resultHash,
        source_revision_id: input.sourceRevisionId,
        source_manifest_sha256: input.sourceManifestSha256,
        observation_coherence: input.observationCoherence,
        odds_source: input.oddsSource,
        used_closed_range_midpoint: input.usedClosedRangeMidpoint,
        calculated_at: new Date(input.calculatedAt),
        data_as_of_state: input.dataAsOf.state,
        data_observed_at:
          input.dataAsOf.state === "known"
            ? new Date(input.dataAsOf.observedAt)
            : null,
        pack_price_minor_units:
          input.metrics === null ? null : BigInt(input.metrics.packPriceMinorUnits),
        underlying_outcome_ev_minor_units:
          input.metrics === null
            ? null
            : BigInt(input.metrics.underlyingOutcomeEvMinorUnits),
        draw_multiplier: input.metrics?.drawMultiplier ?? null,
        gross_ev_minor_units:
          input.metrics === null ? null : BigInt(input.metrics.grossEvMinorUnits),
        gross_return_basis_points:
          input.metrics === null
            ? null
            : BigInt(input.metrics.grossReturnBasisPoints),
        ev_dollars_minor_units:
          input.metrics === null
            ? null
            : BigInt(input.metrics.evDollarsMinorUnits),
        ev_percent_basis_points:
          input.metrics === null
            ? null
            : BigInt(input.metrics.evPercentBasisPoints),
        confidence_score_basis_points: input.confidence?.scoreBasisPoints ?? null,
        confidence_band: input.confidence?.band ?? null,
        confidence_limitation_codes: [
          ...(input.confidence?.limitationCodes ?? []),
        ],
        freshness_state: input.freshness.state,
        source_age_milliseconds:
          input.freshness.sourceAgeMilliseconds === null
            ? null
            : BigInt(input.freshness.sourceAgeMilliseconds),
        freshness_expires_at:
          input.freshness.expiresAt === null
            ? null
            : new Date(input.freshness.expiresAt),
        internal_reasons: [...input.internalReasons],
        public_primary_reason: input.publicPrimaryReason,
      },
    });
    await transaction.buyback_ev_revision_source_refs.createMany({
      data: input.sourceReferences.map((reference) => ({
        organization_id: input.organizationId,
        revision_id: created.id,
        reference_index: reference.referenceIndex,
        source_revision_id: reference.sourceRevisionId,
        source_manifest_sha256: reference.sourceManifestSha256,
        canonical_revision_id: reference.canonicalRevisionId,
      })),
    });
    return { outcome: "created", row: rowToRecord(created, true) };
  }

  private async assertTenantScope(
    transaction: PackscoutTransactionClient,
    input: PersistBuybackEvRevisionRowInput,
  ): Promise<void> {
    const provider = await transaction.provider_sources.findFirst({
      where: { id: input.providerId },
      select: { organization_id: true, platform_key: true },
    });
    if (
      !provider ||
      provider.organization_id !== input.organizationId ||
      provider.platform_key !== input.platformKey
    ) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "The provider does not belong to the organization and platform scope.",
      );
    }
    const configuration = await transaction.provider_config_revisions.findFirst({
      where: { id: input.configurationRevisionId },
      select: { organization_id: true, provider_id: true },
    });
    if (
      !configuration ||
      configuration.organization_id !== input.organizationId ||
      configuration.provider_id !== input.providerId
    ) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "The configuration revision does not belong to the provider scope.",
      );
    }
    const canonicalRevisionIds = input.sourceReferences
      .map((reference) => reference.canonicalRevisionId)
      .filter((value): value is string => value !== null);
    if (canonicalRevisionIds.length > 0) {
      const matched = await transaction.canonical_revisions.count({
        where: {
          id: { in: canonicalRevisionIds },
          organization_id: input.organizationId,
        },
      });
      if (matched !== new Set(canonicalRevisionIds).size) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "A canonical source revision reference is outside the organization scope.",
        );
      }
    }
  }

  async recordPersistenceFailure(
    input: RecordBuybackEvPersistenceFailureInput,
  ): Promise<Readonly<{ occurrenceCount: number; created: boolean }>> {
    requireUuid(input.organizationId, "organizationId");
    requireHex64(input.failureKey, "failureKey");
    if (input.providerId !== null) requireUuid(input.providerId, "providerId");
    if (input.platformKey !== null) {
      requirePattern(input.platformKey, PLATFORM_KEY_PATTERN, "platformKey");
    }
    if (input.productKey !== null) {
      requirePattern(input.productKey, PRODUCT_KEY_PATTERN, "productKey");
    }
    const seenAt = requireCanonicalTimestamp(input.seenAt, "seenAt");
    return this.database.$transaction(async (transaction) => {
      if (input.providerId !== null) {
        const provider = await transaction.provider_sources.findFirst({
          where: { id: input.providerId },
          select: { organization_id: true },
        });
        if (!provider || provider.organization_id !== input.organizationId) {
          throw new PersistenceError(
            "TENANT_SCOPE_VIOLATION",
            "The failure provider does not belong to the organization scope.",
          );
        }
      }
      const existing = await transaction.buyback_ev_persistence_failures.findUnique({
        where: {
          organization_id_failure_key: {
            organization_id: input.organizationId,
            failure_key: input.failureKey,
          },
        },
        select: {
          occurrence_count: true,
          reason_code: true,
          last_seen_at: true,
        },
      });
      if (!existing) {
        await transaction.buyback_ev_persistence_failures.create({
          data: {
            organization_id: input.organizationId,
            failure_key: input.failureKey,
            lifecycle: "failed",
            reason_code: input.reasonCode,
            provider_id: input.providerId,
            platform_key: input.platformKey,
            product_key: input.productKey,
            occurrence_count: 1,
            first_seen_at: seenAt,
            last_seen_at: seenAt,
          },
        });
        return { occurrenceCount: 1, created: true };
      }
      if (existing.reason_code !== input.reasonCode) {
        throw new PersistenceError(
          "IDEMPOTENCY_CONFLICT",
          "A persistence failure key cannot change its bounded reason.",
        );
      }
      const lastSeenAt =
        existing.last_seen_at.getTime() > seenAt.getTime()
          ? existing.last_seen_at
          : seenAt;
      await transaction.buyback_ev_persistence_failures.update({
        where: {
          organization_id_failure_key: {
            organization_id: input.organizationId,
            failure_key: input.failureKey,
          },
        },
        data: {
          occurrence_count: existing.occurrence_count + 1,
          last_seen_at: lastSeenAt,
        },
      });
      return { occurrenceCount: existing.occurrence_count + 1, created: false };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  /**
   * Deterministic completed-current selection: the highest revision number for
   * the requested method version among completed rows. Historical pre-buyback
   * results live in a different store and can never satisfy this query.
   */
  async getCurrentCompletedRevision(input: {
    organizationId: string;
    platformKey: string;
    productKey: string;
    methodVersion: string;
  }): Promise<BuybackEvRevisionRecord | null> {
    requireUuid(input.organizationId, "organizationId");
    requirePattern(input.platformKey, PLATFORM_KEY_PATTERN, "platformKey");
    requirePattern(input.productKey, PRODUCT_KEY_PATTERN, "productKey");
    const row = await this.database.buyback_ev_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        platform_key: input.platformKey,
        product_key: input.productKey,
        lifecycle: "completed",
        method_version: input.methodVersion,
      },
      orderBy: { revision_number: "desc" },
    });
    return row === null ? null : rowToRecord(row, true);
  }

  async getRevisionTrace(input: {
    organizationId: string;
    revisionId: string;
  }): Promise<BuybackEvRevisionTrace | null> {
    requireUuid(input.organizationId, "organizationId");
    requireUuid(input.revisionId, "revisionId");
    const row = await this.database.buyback_ev_revisions.findFirst({
      where: { id: input.revisionId, organization_id: input.organizationId },
    });
    if (row === null) return null;
    const record = rowToRecord(row, true);
    const references = await this.database.buyback_ev_revision_source_refs.findMany({
      where: {
        revision_id: input.revisionId,
        organization_id: input.organizationId,
      },
      orderBy: { reference_index: "asc" },
    });
    return {
      revisionId: record.revisionId,
      revisionNumber: record.revisionNumber,
      status: record.status,
      methodVersion: record.methodVersion,
      confidencePolicyVersion: record.confidencePolicyVersion,
      platformKey: record.platformKey,
      productKey: record.productKey,
      productRevisionId: record.productRevisionId,
      calculationKey: record.calculationKey,
      effectiveFingerprint: record.effectiveFingerprint,
      resultHash: record.resultHash,
      calculatedAt: record.calculatedAt,
      sourceReferences: references.map((reference) => ({
        referenceIndex: reference.reference_index,
        sourceRevisionId: reference.source_revision_id,
        sourceManifestSha256: reference.source_manifest_sha256,
        canonicalRevisionId: reference.canonical_revision_id,
      })),
    };
  }
}
