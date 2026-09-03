import { createHash } from "node:crypto";
import {
  canonicalJson,
  packScoutBuybackEvConfidenceResultV1Schema,
  packScoutBuybackEvInputV1Schema,
  packScoutBuybackEvMetricsAreConsistentV1,
  containsProtectedEvPublicationKeyV3,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
  type PackScoutBuybackEvDataAsOfV1,
  type PackScoutBuybackEvInputV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
} from "@packscout/contracts";

/**
 * Revision identity, effective fingerprint, and sanitized publication
 * projection for the immutable buyback-adjusted EV revision store
 * (task buyback-adjusted-ev/005).
 *
 * All hashes are domain-separated sha-256 digests of canonical JSON, so a
 * byte-identical replay always reproduces the same digest and any key-order
 * difference in caller objects is irrelevant.
 */

export const PACKSCOUT_BUYBACK_EV_REVISION_STORE_VERSION =
  "packscout-buyback-ev-revision-store-v1" as const;
export const PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION =
  "packscout-buyback-ev-revision-publication-v1" as const;
export const PACKSCOUT_BUYBACK_EV_REVISION_MAX_SOURCE_REFERENCES = 16;

const IDENTITY_HASH_DOMAIN = "packscout.buyback-ev.calculation-identity.v1";
const FINGERPRINT_HASH_DOMAIN = "packscout.buyback-ev.effective-fingerprint.v1";
const RESULT_HASH_DOMAIN = "packscout.buyback-ev.result.v1";
const FAILURE_HASH_DOMAIN = "packscout.buyback-ev.persistence-failure.v1";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * One calculation identity: the method version, its confidence-policy
 * version, one product revision, one coherent observation set, and the
 * provider-source revision that governed the evidence normalization.
 */
export interface PackScoutBuybackEvCalculationIdentityV1 {
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly platformKey: string;
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256: string | null;
  readonly observationCoherence: "provider_revision" | "guarded_collection";
  readonly providerSourceRevisionId: string;
}

export function computePackScoutBuybackEvCalculationIdentityKeyV1(
  identity: PackScoutBuybackEvCalculationIdentityV1,
): string {
  return sha256({
    hashDomain: IDENTITY_HASH_DOMAIN,
    methodVersion: identity.methodVersion,
    confidencePolicyVersion: identity.confidencePolicyVersion,
    platformKey: identity.platformKey,
    productKey: identity.productKey,
    productRevisionId: identity.productRevisionId,
    observation: {
      sourceRevisionId: identity.sourceRevisionId,
      sourceManifestSha256: identity.sourceManifestSha256,
      observationCoherence: identity.observationCoherence,
    },
    providerSourceRevisionId: identity.providerSourceRevisionId,
  });
}

/**
 * The governing evidence behind one completed calculation. A complete
 * calculator input carries every economic input: price, currency
 * normalization and parity approvals, odds and pool evidence, stated values,
 * buyback payouts and eligibility, draw semantics, and the coherent
 * observation with its freshness evidence (`observedAt`). An unavailable
 * outcome without a complete input is fingerprinted over its bounded
 * unavailability evidence instead.
 */
export type PackScoutBuybackEvGoverningEvidenceV1 =
  | Readonly<{ kind: "complete_input"; input: PackScoutBuybackEvInputV1 }>
  | Readonly<{
      kind: "unavailable_evidence";
      dataAsOf: PackScoutBuybackEvDataAsOfV1;
      internalReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
    }>;

/**
 * Deterministic, replay-stable effective fingerprint over the calculation
 * identity and every governing input. The calculation clock is deliberately
 * excluded: replaying one completed delivery never mints new history, and a
 * different clock over the same identity is a rejected identity reuse.
 */
export function computePackScoutBuybackEvEffectiveFingerprintV1(input: {
  readonly identity: PackScoutBuybackEvCalculationIdentityV1;
  readonly evidence: PackScoutBuybackEvGoverningEvidenceV1;
}): string {
  const evidence =
    input.evidence.kind === "complete_input"
      ? {
        kind: input.evidence.kind,
        input: packScoutBuybackEvInputV1Schema.parse(input.evidence.input),
      }
      : {
        kind: input.evidence.kind,
        dataAsOf: input.evidence.dataAsOf,
        internalReasons: [...input.evidence.internalReasons],
      };
  return sha256({
    hashDomain: FINGERPRINT_HASH_DOMAIN,
    identityKey: computePackScoutBuybackEvCalculationIdentityKeyV1(
      input.identity,
    ),
    evidence,
  });
}

/**
 * Canonical digest of the exact persisted outputs: the protected calculation
 * result plus its task-003 confidence evaluation (or null when the failed
 * availability gate owns the unavailable state).
 */
export function computePackScoutBuybackEvResultHashV1(input: {
  readonly calculation: unknown;
  readonly confidenceEvaluation: unknown | null;
}): string {
  return sha256({
    hashDomain: RESULT_HASH_DOMAIN,
    calculation: input.calculation,
    confidenceEvaluation: input.confidenceEvaluation,
  });
}

/** Bounded dedupe key for the failed-work ledger: fingerprint plus reason. */
export function computePackScoutBuybackEvFailureKeyV1(input: {
  readonly effectiveFingerprint: string;
  readonly reasonCode: string;
}): string {
  return sha256({
    hashDomain: FAILURE_HASH_DOMAIN,
    effectiveFingerprint: input.effectiveFingerprint,
    reasonCode: input.reasonCode,
  });
}

export interface PackScoutBuybackEvRevisionSourceReferenceV1 {
  readonly referenceIndex: number;
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256: string | null;
  readonly canonicalRevisionId: string | null;
}

export interface PackScoutBuybackEvRevisionMetricsV1 {
  readonly packPriceMinorUnits: number;
  readonly underlyingOutcomeEvMinorUnits: number;
  readonly drawMultiplier: number;
  readonly grossEvMinorUnits: number;
  readonly grossReturnBasisPoints: number;
  readonly evDollarsMinorUnits: number;
  readonly evPercentBasisPoints: number;
}

export interface PackScoutBuybackEvRevisionConfidenceV1 {
  readonly scoreBasisPoints: number;
  readonly band: "low" | "medium" | "high";
  readonly limitationCodes: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[];
}

export type PackScoutBuybackEvRevisionFreshnessV1 =
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

export type PackScoutBuybackEvRevisionDataAsOfV1 =
  | Readonly<{ state: "known"; observedAt: string }>
  | Readonly<{ state: "unknown_source_time"; observedAt: null }>;

/**
 * One stored completed revision as returned by the persistence port. This is
 * protected internal state: it never leaves the service boundary without the
 * sanitized publication projection below.
 */
export interface PackScoutBuybackEvRevisionRecordV1 {
  readonly revisionId: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerSourceRevisionId: string;
  readonly sourceInstanceId: string;
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
  readonly dataAsOf: PackScoutBuybackEvRevisionDataAsOfV1;
  readonly metrics: PackScoutBuybackEvRevisionMetricsV1 | null;
  readonly confidence: PackScoutBuybackEvRevisionConfidenceV1 | null;
  readonly freshness: PackScoutBuybackEvRevisionFreshnessV1;
  readonly internalReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
  readonly publicPrimaryReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly createdAt: string;
}

/** The immutable identity the persistence boundary returns to its caller. */
export interface PackScoutBuybackEvRevisionIdentityRecordV1 {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly status: "available" | "unavailable";
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly calculationKey: string;
  readonly effectiveFingerprint: string;
  readonly resultHash: string;
  readonly calculatedAt: string;
}

export type PackScoutBuybackEvRevisionPublicationProjectionV1 =
  | Readonly<{
      schemaVersion:
        typeof PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION;
      status: "available";
      methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
      confidencePolicyVersion:
        typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
      metrics: Readonly<{
        grossEvMoney: Readonly<{ minorUnits: number; currency: "USD" }>;
        grossReturnBasisPoints: number;
        evDollars: Readonly<{ minorUnits: number; currency: "USD" }>;
        evPercentBasisPoints: number;
      }>;
      confidence: Readonly<{
        policyVersion: typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
        scoreBasisPoints: number;
        band: "low" | "medium" | "high";
        limitationCodes: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[];
      }>;
      calculatedAt: string;
      dataAsOf: Readonly<{ state: "known"; observedAt: string }>;
      sourceAgeMilliseconds: number;
      expiresAt: string;
    }>
  | Readonly<{
      schemaVersion:
        typeof PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION;
      status: "unavailable";
      methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
      confidencePolicyVersion:
        typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
      metrics: null;
      confidence: null;
      calculatedAt: string;
      dataAsOf: PackScoutBuybackEvRevisionDataAsOfV1;
      publicReason: PackScoutBuybackEvPublicReasonCodeV1;
    }>;

export class PackScoutBuybackEvRevisionProjectionError extends Error {
  constructor(readonly code: "ROW_INVALID" | "PROTECTED_FIELD_LEAKED") {
    super("PackScout buyback EV revision cannot be projected for publication.");
    this.name = "PackScoutBuybackEvRevisionProjectionError";
  }
}

/**
 * Final tripwire before a projection leaves the service boundary: any
 * protected task-001 spelling or revision-layer spelling
 * (`underlyingOutcomeEvMinorUnits`, `drawMultiplier`, ...) anywhere in the
 * projection fails closed as `PROTECTED_FIELD_LEAKED`. The sanitizer's
 * field-by-field construction makes this unreachable today; the guard exists
 * so any future drift in the projection shape can never leak silently.
 */
export function assertPackScoutBuybackEvProjectionLeaksNoProtectedFieldV1(
  projection: PackScoutBuybackEvRevisionPublicationProjectionV1,
): void {
  if (containsProtectedEvPublicationKeyV3(projection)) {
    throw new PackScoutBuybackEvRevisionProjectionError("PROTECTED_FIELD_LEAKED");
  }
}

/**
 * Projects one stored revision into its sanitized publication shape. The
 * projection exposes only the approved public allowlist: four metrics,
 * confidence, versions, timestamps, source age, expiry, and one bounded
 * public reason. Provenance, protected evidence, internal reasons, raw
 * payloads, credentials, and organization identifiers never appear, and the
 * shared protected-field scan re-proves that before the projection is
 * returned. Corrupted arithmetic or confidence fails validation here as well.
 */
export function sanitizePackScoutBuybackEvRevisionForPublicationV1(
  record: Pick<PackScoutBuybackEvRevisionRecordV1,
    "status" | "metrics" | "confidence" | "dataAsOf" | "freshness" |
    "methodVersion" | "confidencePolicyVersion" | "calculatedAt" | "publicPrimaryReason">,
): PackScoutBuybackEvRevisionPublicationProjectionV1 {
  let projection: PackScoutBuybackEvRevisionPublicationProjectionV1;
  if (record.status === "available") {
    if (
      record.metrics === null ||
      record.confidence === null ||
      record.dataAsOf.state !== "known" ||
      record.freshness.state !== "current" ||
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: record.metrics.grossEvMinorUnits,
        grossReturnBasisPoints: record.metrics.grossReturnBasisPoints,
        evDollarsMinorUnits: record.metrics.evDollarsMinorUnits,
        evPercentBasisPoints: record.metrics.evPercentBasisPoints,
        packPriceMinorUnits: record.metrics.packPriceMinorUnits,
      })
    ) {
      throw new PackScoutBuybackEvRevisionProjectionError("ROW_INVALID");
    }
    const confidence = packScoutBuybackEvConfidenceResultV1Schema.safeParse({
      policyVersion: record.confidencePolicyVersion,
      scoreBasisPoints: record.confidence.scoreBasisPoints,
      band: record.confidence.band,
      limitationCodes: [...record.confidence.limitationCodes],
    });
    if (!confidence.success) {
      throw new PackScoutBuybackEvRevisionProjectionError("ROW_INVALID");
    }
    projection = {
      schemaVersion: PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION,
      status: "available",
      methodVersion: record.methodVersion,
      confidencePolicyVersion: record.confidencePolicyVersion,
      metrics: {
        grossEvMoney: {
          minorUnits: record.metrics.grossEvMinorUnits,
          currency: "USD",
        },
        grossReturnBasisPoints: record.metrics.grossReturnBasisPoints,
        evDollars: {
          minorUnits: record.metrics.evDollarsMinorUnits,
          currency: "USD",
        },
        evPercentBasisPoints: record.metrics.evPercentBasisPoints,
      },
      confidence: confidence.data,
      calculatedAt: record.calculatedAt,
      dataAsOf: { state: "known", observedAt: record.dataAsOf.observedAt },
      sourceAgeMilliseconds: record.freshness.sourceAgeMilliseconds,
      expiresAt: record.freshness.expiresAt,
    };
  } else {
    if (
      record.metrics !== null ||
      record.confidence !== null ||
      record.publicPrimaryReason === null
    ) {
      throw new PackScoutBuybackEvRevisionProjectionError("ROW_INVALID");
    }
    projection = {
      schemaVersion: PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION,
      status: "unavailable",
      methodVersion: record.methodVersion,
      confidencePolicyVersion: record.confidencePolicyVersion,
      metrics: null,
      confidence: null,
      calculatedAt: record.calculatedAt,
      dataAsOf:
        record.dataAsOf.state === "known"
          ? { state: "known", observedAt: record.dataAsOf.observedAt }
          : { state: "unknown_source_time", observedAt: null },
      publicReason: record.publicPrimaryReason,
    };
  }
  assertPackScoutBuybackEvProjectionLeaksNoProtectedFieldV1(projection);
  return projection;
}

export interface PackScoutBuybackEvRevisionTraceV1 {
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
  readonly sourceReferences: readonly PackScoutBuybackEvRevisionSourceReferenceV1[];
}
