#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION =
  "packscout.provider-manifest-readiness.v1";
export const CERTIFICATION_ARTIFACT_VERSION =
  "packscout.provider-manifest-readiness-certification.v1";
export const NEAREST_RANK_RULE = "nearest-rank-ceiling-v1";
export const PUBLICATION_P95_TARGET_MILLISECONDS = 60_000;
export const HEAT_EXPIRY_MILLISECONDS = 15 * 60_000;
export const MINIMUM_TIMING_SAMPLE_COUNT = 20;

const MAXIMUM_INPUT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_TIMING_SAMPLE_COUNT = 10_000;
const MAXIMUM_SAFE_COUNT = 1_000_000_000;
// Frozen launch bounds mirror the versioned provider, manifest, and Heat
// publication contracts. Changing them requires a new evidence schema.
const MAXIMUM_PROVIDER_BATCH_COUNT = 4_096;
const MAXIMUM_PROVIDER_COUNT = 8;
const MAXIMUM_CATEGORY_COUNT = 4_096;
const MAXIMUM_COLLECTIBLE_COUNT = 100_000;
const MAXIMUM_REPACK_COUNT = 8_000;
const MAXIMUM_REPACK_CHASE_COUNT = 250_000;
const MAXIMUM_SEARCH_SHARD_COUNT = 250;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLATFORM_PATTERN =
  /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/u;
const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const ISO_INSTANT_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

const TOP_LEVEL_KEYS = [
  "certification",
  "configuration",
  "evidenceLevel",
  "fixture",
  "heat",
  "manifest",
  "monitor",
  "providers",
  "reset",
  "retention",
  "rollback",
  "rotation",
  "schemaVersion",
  "scope",
  "timing",
];

const ALLOWED_COMMANDS = new Set([
  "npm run check:prisma",
  "npm run test:contracts",
  "npm run test:convex",
  "npm run test:database",
  "npm run test:frontend",
  "npm run test:services",
  "npm run test:worker",
  "npm run verify:framework",
]);

const PROTECTED_KEY_FRAGMENTS = [
  "actor",
  "apikey",
  "attemptid",
  "authorization",
  "credential",
  "databaseurl",
  "deploymentid",
  "header",
  "identifier",
  "keyid",
  "manifestid",
  "nonce",
  "operationid",
  "organizationid",
  "password",
  "payload",
  "providerid",
  "quarantine",
  "raw",
  "releaseid",
  "runid",
  "secret",
  "selector",
  "tenant",
  "token",
  "uri",
  "url",
  "uuid",
];

const PROTECTED_STRING_PATTERN =
  /(?:https?:\/\/|postgres(?:ql)?:\/\/|file:\/\/|authorization\s*:|bearer\s+|cookie\s*:|x-api-key|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:password|secret|token)\s*[=:])/iu;

export class ReadinessEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReadinessEvidenceError";
    this.code = code;
  }
}

function refuse(code) {
  throw new ReadinessEvidenceError(code);
}

function isPlainRecord(value) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function rejectProtectedContent(value) {
  if (typeof value === "string") {
    if (PROTECTED_STRING_PATTERN.test(value)) {
      refuse("EVIDENCE_PROTECTED_FIELD");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectProtectedContent(item);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (PROTECTED_KEY_FRAGMENTS.some((fragment) =>
      normalized.includes(fragment))) {
      refuse("EVIDENCE_PROTECTED_FIELD");
    }
    rejectProtectedContent(nested);
  }
}

function requireRecord(value, requiredKeys, missingCode = "EVIDENCE_VALUE_INVALID") {
  if (!isPlainRecord(value)) refuse(missingCode);
  const allowed = new Set(requiredKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    refuse("EVIDENCE_FIELD_UNKNOWN");
  }
  if (requiredKeys.some((key) =>
    !Object.prototype.hasOwnProperty.call(value, key))) {
    refuse(missingCode);
  }
  return value;
}

function requireArray(value, minimum, maximum, code) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    refuse(code);
  }
  return value;
}

function requireEnum(value, allowed, code = "EVIDENCE_VALUE_INVALID") {
  if (typeof value !== "string" || !allowed.includes(value)) refuse(code);
  return value;
}

function requireSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    refuse("EVIDENCE_DIGEST_INVALID");
  }
  return value;
}

function requireCommit(value) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    refuse("EVIDENCE_COMMIT_INVALID");
  }
  return value;
}

function requireDecimal(value) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    refuse("EVIDENCE_WATERMARK_INVALID");
  }
  return value;
}

function requireLabel(value) {
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) {
    refuse("EVIDENCE_LABEL_INVALID");
  }
  return value;
}

function requirePlatform(value) {
  if (typeof value !== "string" || !PLATFORM_PATTERN.test(value)) {
    refuse("EVIDENCE_PLATFORM_SET_INVALID");
  }
  return value;
}

function requireCount(value, maximum = MAXIMUM_SAFE_COUNT) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    refuse("EVIDENCE_COUNT_INVALID");
  }
  return value;
}

function requireTrue(value, code) {
  if (value !== true) refuse(code);
  return true;
}

function requireInstant(value, code = "EVIDENCE_TIME_INVALID") {
  if (
    typeof value !== "string" ||
    !ISO_INSTANT_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    refuse(code);
  }
  return value;
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireSortedUnique(values, code) {
  if (values.some((value, index) =>
    index > 0 && compareCanonicalText(values[index - 1], value) >= 0)) {
    refuse(code);
  }
}

function requireStableCode(value) {
  if (typeof value !== "string" || !STABLE_CODE_PATTERN.test(value)) {
    refuse("EVIDENCE_TIMING_SAMPLES_INVALID");
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareCanonicalText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  refuse("EVIDENCE_CANONICALIZATION_FAILED");
}

export function nearestRank(values, percentile) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !Number.isInteger(percentile) ||
    percentile < 1 ||
    percentile > 100 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    refuse("EVIDENCE_TIMING_SAMPLES_INVALID");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile * sorted.length) / 100);
  return sorted[rank - 1];
}

function validateTimingSample(value) {
  if (!isPlainRecord(value) || typeof value.outcome !== "string") {
    refuse("EVIDENCE_TIMING_SAMPLES_INVALID");
  }
  if (value.outcome === "success") {
    requireRecord(value, ["durationMs", "outcome"],
      "EVIDENCE_TIMING_SAMPLES_INVALID");
    if (
      !Number.isSafeInteger(value.durationMs) ||
      value.durationMs < 0 ||
      value.durationMs > 86_400_000
    ) {
      refuse("EVIDENCE_TIMING_SAMPLES_INVALID");
    }
    return { durationMs: value.durationMs, outcome: "success" };
  }
  if (value.outcome === "error") {
    requireRecord(value, ["errorCode", "outcome"],
      "EVIDENCE_TIMING_SAMPLES_INVALID");
    return { errorCode: requireStableCode(value.errorCode), outcome: "error" };
  }
  refuse("EVIDENCE_TIMING_SAMPLES_INVALID");
}

export function summarizeTimingSamples(samples) {
  const input = requireArray(
    samples,
    MINIMUM_TIMING_SAMPLE_COUNT,
    MAXIMUM_TIMING_SAMPLE_COUNT,
    "EVIDENCE_TIMING_SAMPLES_INVALID",
  );
  const normalized = input.map(validateTimingSample);
  const durations = normalized
    .filter(({ outcome }) => outcome === "success")
    .map(({ durationMs }) => durationMs);
  if (durations.length === 0) refuse("EVIDENCE_TIMING_SAMPLES_INVALID");
  return {
    errorCount: normalized.length - durations.length,
    maxMs: Math.max(...durations),
    p50Ms: nearestRank(durations, 50),
    p95Ms: nearestRank(durations, 95),
    rule: NEAREST_RANK_RULE,
    sampleCount: normalized.length,
    successCount: durations.length,
  };
}

function compareTimingSamples(left, right) {
  if (left.outcome !== right.outcome) {
    return compareCanonicalText(left.outcome, right.outcome);
  }
  if (left.outcome === "success") return left.durationMs - right.durationMs;
  return compareCanonicalText(left.errorCode, right.errorCode);
}

function validateFixture(value) {
  const record = requireRecord(value, ["name", "version"]);
  return { name: requireLabel(record.name), version: requireLabel(record.version) };
}

function validateScope(value) {
  const record = requireRecord(value, [
    "deploymentDigest",
    "organizationDigest",
  ]);
  return {
    deploymentDigest: requireSha256(record.deploymentDigest),
    organizationDigest: requireSha256(record.organizationDigest),
  };
}

function validateConfiguration(value) {
  const record = requireRecord(value, [
    "enabledPlatforms",
    "epochHash",
    "epochSequence",
  ]);
  const platforms = requireArray(
    record.enabledPlatforms,
    1,
    8,
    "EVIDENCE_PLATFORM_SET_INVALID",
  ).map(requirePlatform);
  requireSortedUnique(platforms, "EVIDENCE_PLATFORM_SET_INVALID");
  return {
    enabledPlatforms: platforms,
    epochHash: requireSha256(record.epochHash),
    epochSequence: requireDecimal(record.epochSequence),
  };
}

function boundedCount(value, minimum, maximum) {
  const count = requireCount(value);
  if (count < minimum || count > maximum) refuse("EVIDENCE_COUNT_INVALID");
  return count;
}

function validateProviderCatalogCounts(value) {
  const record = requireRecord(value, [
    "batches",
    "categories",
    "collectibles",
    "repackChases",
    "repacks",
    "searchShards",
    "vendors",
  ]);
  return {
    batches: boundedCount(record.batches, 1, MAXIMUM_PROVIDER_BATCH_COUNT),
    categories: boundedCount(record.categories, 0, MAXIMUM_CATEGORY_COUNT),
    collectibles: boundedCount(
      record.collectibles,
      0,
      MAXIMUM_COLLECTIBLE_COUNT,
    ),
    repackChases: boundedCount(
      record.repackChases,
      0,
      MAXIMUM_REPACK_CHASE_COUNT,
    ),
    repacks: boundedCount(record.repacks, 0, MAXIMUM_REPACK_COUNT),
    searchShards: boundedCount(
      record.searchShards,
      0,
      MAXIMUM_SEARCH_SHARD_COUNT,
    ),
    vendors: boundedCount(record.vendors, 1, 1),
  };
}

function validateManifestCatalogCounts(value, providerCount) {
  const record = requireRecord(value, [
    "batches",
    "categories",
    "collectibles",
    "providers",
    "repackChases",
    "repacks",
    "searchShards",
    "vendors",
  ]);
  return {
    batches: boundedCount(
      record.batches,
      providerCount,
      providerCount * MAXIMUM_PROVIDER_BATCH_COUNT,
    ),
    categories: boundedCount(record.categories, 0, MAXIMUM_CATEGORY_COUNT),
    collectibles: boundedCount(
      record.collectibles,
      0,
      MAXIMUM_COLLECTIBLE_COUNT,
    ),
    providers: boundedCount(record.providers, providerCount, providerCount),
    repackChases: boundedCount(
      record.repackChases,
      0,
      MAXIMUM_REPACK_CHASE_COUNT,
    ),
    repacks: boundedCount(record.repacks, 0, MAXIMUM_REPACK_COUNT),
    searchShards: boundedCount(
      record.searchShards,
      0,
      MAXIMUM_SEARCH_SHARD_COUNT,
    ),
    vendors: boundedCount(record.vendors, 1, MAXIMUM_PROVIDER_COUNT),
  };
}

function validateProviders(value, platforms) {
  const providers = requireArray(
    value,
    platforms.length,
    platforms.length,
    "EVIDENCE_PROVIDER_SET_INVALID",
  ).map((candidate) => {
    const record = requireRecord(candidate, [
      "activeWatermark",
      "affectedSettledWatermark",
      "completedWatermark",
      "contentHash",
      "counts",
      "platformKey",
      "receiptDigest",
      "requestDigest",
    ]);
    const activeWatermark = requireDecimal(record.activeWatermark);
    const affectedSettledWatermark = requireDecimal(
      record.affectedSettledWatermark,
    );
    const completedWatermark = requireDecimal(record.completedWatermark);
    if (
      BigInt(activeWatermark) > BigInt(completedWatermark) ||
      BigInt(completedWatermark) > BigInt(affectedSettledWatermark)
    ) {
      refuse("EVIDENCE_PROVIDER_WATERMARK_INVALID");
    }
    return {
      activeWatermark,
      affectedSettledWatermark,
      completedWatermark,
      contentHash: requireSha256(record.contentHash),
      counts: validateProviderCatalogCounts(record.counts),
      platformKey: requirePlatform(record.platformKey),
      receiptDigest: requireSha256(record.receiptDigest),
      requestDigest: requireSha256(record.requestDigest),
    };
  });
  requireSortedUnique(
    providers.map(({ platformKey }) => platformKey),
    "EVIDENCE_PROVIDER_SET_INVALID",
  );
  if (providers.some(({ platformKey }, index) => platformKey !== platforms[index])) {
    refuse("EVIDENCE_PROVIDER_SET_INVALID");
  }
  return providers;
}

function validateManifest(value, providers) {
  const providerCount = providers.length;
  const record = requireRecord(value, [
    "activeManifestHash",
    "aggregateHash",
    "confirmedSequence",
    "counts",
    "pointerResult",
    "previousManifestHash",
    "providerReferenceSetHash",
    "publicDtoHash",
    "receiptDigest",
    "requestDigest",
    "requestedSequence",
  ]);
  const requestedSequence = requireDecimal(record.requestedSequence);
  const confirmedSequence = requireDecimal(record.confirmedSequence);
  if (confirmedSequence !== requestedSequence) {
    refuse("EVIDENCE_MANIFEST_SEQUENCE_INVALID");
  }
  const counts = validateManifestCatalogCounts(record.counts, providerCount);
  const sum = (key) => providers.reduce(
    (total, provider) => total + provider.counts[key],
    0,
  );
  const maximum = (key) => Math.max(
    ...providers.map((provider) => provider.counts[key]),
  );
  if (
    counts.batches !== sum("batches") ||
    counts.vendors !== providerCount ||
    counts.repacks !== sum("repacks") ||
    counts.repackChases !== sum("repackChases") ||
    counts.searchShards !== sum("searchShards") ||
    counts.categories < maximum("categories") ||
    counts.categories > sum("categories") ||
    counts.collectibles < maximum("collectibles") ||
    counts.collectibles > sum("collectibles")
  ) {
    refuse("EVIDENCE_COUNT_INVALID");
  }
  return {
    activeManifestHash: requireSha256(record.activeManifestHash),
    aggregateHash: requireSha256(record.aggregateHash),
    confirmedSequence,
    counts,
    pointerResult: requireEnum(
      record.pointerResult,
      ["activated", "unchanged"],
    ),
    previousManifestHash: record.previousManifestHash === null
      ? null
      : requireSha256(record.previousManifestHash),
    providerReferenceSetHash: requireSha256(record.providerReferenceSetHash),
    publicDtoHash: requireSha256(record.publicDtoHash),
    receiptDigest: requireSha256(record.receiptDigest),
    requestDigest: requireSha256(record.requestDigest),
    requestedSequence,
  };
}

function validateHeat(value, manifest) {
  const record = requireRecord(value, [
    "expiryOutcome",
    "frameHash",
    "frameSequence",
    "manifestHash",
    "providerReferenceSetHash",
    "receiptDigest",
    "requestDigest",
    "signalCount",
    "signalSetHash",
    "sourceWatermark",
  ]);
  const result = {
    expiryOutcome: requireEnum(
      record.expiryOutcome,
      ["unavailable_after_15_minutes"],
    ),
    frameHash: requireSha256(record.frameHash),
    frameSequence: requireDecimal(record.frameSequence),
    manifestHash: requireSha256(record.manifestHash),
    providerReferenceSetHash: requireSha256(record.providerReferenceSetHash),
    receiptDigest: requireSha256(record.receiptDigest),
    requestDigest: requireSha256(record.requestDigest),
    signalCount: boundedCount(record.signalCount, 0, MAXIMUM_REPACK_COUNT),
    signalSetHash: requireSha256(record.signalSetHash),
    sourceWatermark: requireDecimal(record.sourceWatermark),
  };
  if (
    result.manifestHash !== manifest.activeManifestHash ||
    result.providerReferenceSetHash !== manifest.providerReferenceSetHash
  ) {
    refuse("EVIDENCE_HEAT_ALIGNMENT_INVALID");
  }
  if (result.signalCount !== manifest.counts.repacks) {
    refuse("EVIDENCE_COUNT_INVALID");
  }
  return result;
}

function validateReset(value) {
  const record = requireRecord(value, [
    "approvedConfigurationAfterHash",
    "approvedConfigurationBeforeHash",
    "backupDigest",
    "canonicalPostgresAfterHash",
    "canonicalPostgresBeforeHash",
    "causalSettlementAfterHash",
    "causalSettlementBeforeHash",
    "newPublicationState",
    "normalizedHeatAfterHash",
    "normalizedHeatBeforeHash",
    "obsoleteConvexDocumentCount",
    "obsoletePostgresRowCount",
    "proofDigest",
  ], "EVIDENCE_RESET_MISSING");
  const result = {
    approvedConfigurationAfterHash: requireSha256(
      record.approvedConfigurationAfterHash,
    ),
    approvedConfigurationBeforeHash: requireSha256(
      record.approvedConfigurationBeforeHash,
    ),
    backupDigest: requireSha256(record.backupDigest),
    canonicalPostgresAfterHash: requireSha256(record.canonicalPostgresAfterHash),
    canonicalPostgresBeforeHash: requireSha256(
      record.canonicalPostgresBeforeHash,
    ),
    causalSettlementAfterHash: requireSha256(record.causalSettlementAfterHash),
    causalSettlementBeforeHash: requireSha256(
      record.causalSettlementBeforeHash,
    ),
    newPublicationState: requireEnum(
      record.newPublicationState,
      ["proven_empty"],
      "EVIDENCE_RESET_PRESERVATION_FAILED",
    ),
    normalizedHeatAfterHash: requireSha256(record.normalizedHeatAfterHash),
    normalizedHeatBeforeHash: requireSha256(record.normalizedHeatBeforeHash),
    obsoleteConvexDocumentCount: requireCount(
      record.obsoleteConvexDocumentCount,
    ),
    obsoletePostgresRowCount: requireCount(record.obsoletePostgresRowCount),
    proofDigest: requireSha256(record.proofDigest),
  };
  const preserved = [
    [result.approvedConfigurationBeforeHash, result.approvedConfigurationAfterHash],
    [result.canonicalPostgresBeforeHash, result.canonicalPostgresAfterHash],
    [result.causalSettlementBeforeHash, result.causalSettlementAfterHash],
    [result.normalizedHeatBeforeHash, result.normalizedHeatAfterHash],
  ];
  if (preserved.some(([before, after]) => before !== after)) {
    refuse("EVIDENCE_RESET_PRESERVATION_FAILED");
  }
  return result;
}

function validateRetention(value) {
  const record = requireRecord(value, [
    "abandonedCleanupHours",
    "activeAndPreviousProtected",
    "additionalManifestCount",
    "completedHeadsProtected",
    "inFlightProtected",
    "maximumDocumentsPerMutation",
    "proofDigest",
    "receiptDigest",
    "retentionDays",
    "rollbackAndBlockTargetsProtected",
    "sharedReferencesProtected",
  ]);
  const result = {
    abandonedCleanupHours: requireCount(record.abandonedCleanupHours, 24),
    activeAndPreviousProtected: requireTrue(
      record.activeAndPreviousProtected,
      "EVIDENCE_RETENTION_INVALID",
    ),
    additionalManifestCount: requireCount(record.additionalManifestCount, 3),
    completedHeadsProtected: requireTrue(
      record.completedHeadsProtected,
      "EVIDENCE_RETENTION_INVALID",
    ),
    inFlightProtected: requireTrue(
      record.inFlightProtected,
      "EVIDENCE_RETENTION_INVALID",
    ),
    maximumDocumentsPerMutation: requireCount(
      record.maximumDocumentsPerMutation,
      100,
    ),
    proofDigest: requireSha256(record.proofDigest),
    receiptDigest: requireSha256(record.receiptDigest),
    retentionDays: requireCount(record.retentionDays, 7),
    rollbackAndBlockTargetsProtected: requireTrue(
      record.rollbackAndBlockTargetsProtected,
      "EVIDENCE_RETENTION_INVALID",
    ),
    sharedReferencesProtected: requireTrue(
      record.sharedReferencesProtected,
      "EVIDENCE_RETENTION_INVALID",
    ),
  };
  if (
    result.maximumDocumentsPerMutation !== 100 ||
    result.abandonedCleanupHours !== 24 ||
    result.additionalManifestCount !== 3 ||
    result.retentionDays !== 7
  ) {
    refuse("EVIDENCE_RETENTION_INVALID");
  }
  return result;
}

function validateMonitorEvent(value) {
  const record = requireRecord(value, [
    "failureObservedAt",
    "firedAt",
    "recoveryObservedAt",
    "resolvedAt",
  ], "EVIDENCE_MONITOR_MISSING");
  const result = {
    failureObservedAt: requireInstant(record.failureObservedAt,
      "EVIDENCE_MONITOR_INVALID"),
    firedAt: requireInstant(record.firedAt, "EVIDENCE_MONITOR_INVALID"),
    recoveryObservedAt: requireInstant(record.recoveryObservedAt,
      "EVIDENCE_MONITOR_INVALID"),
    resolvedAt: requireInstant(record.resolvedAt, "EVIDENCE_MONITOR_INVALID"),
  };
  const failure = Date.parse(result.failureObservedAt);
  const fired = Date.parse(result.firedAt);
  const recovery = Date.parse(result.recoveryObservedAt);
  const resolved = Date.parse(result.resolvedAt);
  if (
    fired < failure ||
    fired - failure >= HEAT_EXPIRY_MILLISECONDS ||
    recovery < fired ||
    resolved < recovery
  ) {
    refuse("EVIDENCE_MONITOR_INVALID");
  }
  return {
    event: result,
    fireLatencyMs: fired - failure,
    resolutionLatencyMs: resolved - recovery,
  };
}

function validateMonitor(value) {
  const record = requireRecord(
    value,
    ["heatNotAdvancing", "processDown"],
    "EVIDENCE_MONITOR_MISSING",
  );
  const heatNotAdvancing = validateMonitorEvent(record.heatNotAdvancing);
  const processDown = validateMonitorEvent(record.processDown);
  return {
    normalized: {
      heatNotAdvancing: heatNotAdvancing.event,
      processDown: processDown.event,
    },
    result: {
      heatNotAdvancingFireLatencyMs: heatNotAdvancing.fireLatencyMs,
      heatNotAdvancingResolutionLatencyMs:
        heatNotAdvancing.resolutionLatencyMs,
      processDownFireLatencyMs: processDown.fireLatencyMs,
      processDownResolutionLatencyMs: processDown.resolutionLatencyMs,
    },
  };
}

function validateRotation(value) {
  const record = requireRecord(value, [
    "newKeyTerminalAt",
    "newKeyTerminalReceiptDigest",
    "oldKeyRetiredAt",
    "oldKeyRetirementProofDigest",
    "overlapProofDigest",
    "overlapStartedAt",
    "retryableOperationCountAtRetirement",
    "role",
  ], "EVIDENCE_ROTATION_MISSING");
  const result = {
    newKeyTerminalAt: requireInstant(record.newKeyTerminalAt,
      "EVIDENCE_ROTATION_INVALID"),
    newKeyTerminalReceiptDigest: requireSha256(
      record.newKeyTerminalReceiptDigest,
    ),
    oldKeyRetiredAt: requireInstant(record.oldKeyRetiredAt,
      "EVIDENCE_ROTATION_INVALID"),
    oldKeyRetirementProofDigest: requireSha256(
      record.oldKeyRetirementProofDigest,
    ),
    overlapProofDigest: requireSha256(record.overlapProofDigest),
    overlapStartedAt: requireInstant(record.overlapStartedAt,
      "EVIDENCE_ROTATION_INVALID"),
    retryableOperationCountAtRetirement: requireCount(
      record.retryableOperationCountAtRetirement,
    ),
    role: requireEnum(record.role, [
      "heat",
      "manifest_clear",
      "manifest_publish",
      "manifest_rollback",
      "provider",
      "retention",
    ], "EVIDENCE_ROTATION_INVALID"),
  };
  const overlap = Date.parse(result.overlapStartedAt);
  const terminal = Date.parse(result.newKeyTerminalAt);
  const retired = Date.parse(result.oldKeyRetiredAt);
  if (
    terminal < overlap ||
    retired - terminal < HEAT_EXPIRY_MILLISECONDS ||
    result.retryableOperationCountAtRetirement !== 0
  ) {
    refuse("EVIDENCE_ROTATION_INVALID");
  }
  return result;
}

function validateRollback(value) {
  const record = requireRecord(value, [
    "afterPointerHash",
    "beforePointerHash",
    "receiptDigest",
    "rollbackTargetHash",
    "targetRestored",
  ]);
  const result = {
    afterPointerHash: requireSha256(record.afterPointerHash),
    beforePointerHash: requireSha256(record.beforePointerHash),
    receiptDigest: requireSha256(record.receiptDigest),
    rollbackTargetHash: requireSha256(record.rollbackTargetHash),
    targetRestored: requireTrue(
      record.targetRestored,
      "EVIDENCE_ROLLBACK_INVALID",
    ),
  };
  if (
    result.afterPointerHash !== result.rollbackTargetHash ||
    result.beforePointerHash === result.afterPointerHash
  ) {
    refuse("EVIDENCE_ROLLBACK_INVALID");
  }
  return result;
}

function validateTiming(value) {
  const record = requireRecord(value, [
    "heatMs",
    "providerToManifestMs",
    "rule",
  ]);
  if (record.rule !== NEAREST_RANK_RULE) {
    refuse("EVIDENCE_TIMING_RULE_INVALID");
  }
  const providerToManifestMs = requireArray(
    record.providerToManifestMs,
    MINIMUM_TIMING_SAMPLE_COUNT,
    MAXIMUM_TIMING_SAMPLE_COUNT,
    "EVIDENCE_TIMING_SAMPLES_INVALID",
  ).map(validateTimingSample).sort(compareTimingSamples);
  const heatMs = requireArray(
    record.heatMs,
    MINIMUM_TIMING_SAMPLE_COUNT,
    MAXIMUM_TIMING_SAMPLE_COUNT,
    "EVIDENCE_TIMING_SAMPLES_INVALID",
  ).map(validateTimingSample).sort(compareTimingSamples);
  return {
    normalized: { heatMs, providerToManifestMs, rule: NEAREST_RANK_RULE },
    result: {
      heat: summarizeTimingSamples(heatMs),
      providerToManifest: summarizeTimingSamples(providerToManifestMs),
    },
  };
}

function validateCertification(value) {
  const record = requireRecord(value, ["commands", "commit"]);
  const commit = requireCommit(record.commit);
  const commands = requireArray(
    record.commands,
    1,
    ALLOWED_COMMANDS.size,
    "EVIDENCE_COMMAND_INVALID",
  ).map((candidate) => {
    const command = requireRecord(candidate, [
      "command",
      "commit",
      "exitCode",
      "resultDigest",
    ]);
    if (typeof command.command !== "string" ||
        !ALLOWED_COMMANDS.has(command.command)) {
      refuse("EVIDENCE_COMMAND_INVALID");
    }
    const commandCommit = requireCommit(command.commit);
    if (commandCommit !== commit) refuse("EVIDENCE_COMMIT_MISMATCH");
    if (command.exitCode !== 0) refuse("EVIDENCE_COMMAND_FAILED");
    return {
      command: command.command,
      commit: commandCommit,
      exitCode: 0,
      resultDigest: requireSha256(command.resultDigest),
    };
  });
  requireSortedUnique(
    commands.map(({ command }) => command),
    "EVIDENCE_COMMAND_INVALID",
  );
  if (!commands.some(({ command }) => command === "npm run verify:framework")) {
    refuse("EVIDENCE_VERIFY_COMMAND_MISSING");
  }
  return { commands, commit };
}

function requireCriticalTopLevelEvidence(input) {
  if (!isPlainRecord(input)) refuse("EVIDENCE_INPUT_INVALID");
  if (!Object.prototype.hasOwnProperty.call(input, "reset")) {
    refuse("EVIDENCE_RESET_MISSING");
  }
  if (!Object.prototype.hasOwnProperty.call(input, "monitor")) {
    refuse("EVIDENCE_MONITOR_MISSING");
  }
  if (!Object.prototype.hasOwnProperty.call(input, "rotation")) {
    refuse("EVIDENCE_ROTATION_MISSING");
  }
}

export function certifyProviderManifestReadiness(input) {
  rejectProtectedContent(input);
  requireCriticalTopLevelEvidence(input);
  const record = requireRecord(input, TOP_LEVEL_KEYS);
  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    refuse("EVIDENCE_SCHEMA_VERSION_UNSUPPORTED");
  }
  const evidenceLevel = requireEnum(
    record.evidenceLevel,
    ["local", "preproduction", "production"],
    "EVIDENCE_LEVEL_INVALID",
  );
  if (evidenceLevel === "local") refuse("EVIDENCE_LOCAL_NOT_CERTIFIABLE");

  const configuration = validateConfiguration(record.configuration);
  const providers = validateProviders(
    record.providers,
    configuration.enabledPlatforms,
  );
  const manifest = validateManifest(record.manifest, providers);
  const heat = validateHeat(record.heat, manifest);
  const monitor = validateMonitor(record.monitor);
  const timing = validateTiming(record.timing);
  if (
    timing.result.providerToManifest.errorCount > 0 ||
    timing.result.heat.errorCount > 0
  ) {
    refuse("EVIDENCE_TIMING_FAILURES_PRESENT");
  }
  if (
    timing.result.providerToManifest.p95Ms >=
      PUBLICATION_P95_TARGET_MILLISECONDS
  ) {
    refuse("EVIDENCE_PROVIDER_P95_EXCEEDED");
  }
  if (timing.result.heat.p95Ms >= PUBLICATION_P95_TARGET_MILLISECONDS) {
    refuse("EVIDENCE_HEAT_P95_EXCEEDED");
  }

  const evidence = {
    certification: validateCertification(record.certification),
    configuration,
    evidenceLevel,
    fixture: validateFixture(record.fixture),
    heat,
    manifest,
    monitor: monitor.normalized,
    providers,
    reset: validateReset(record.reset),
    retention: validateRetention(record.retention),
    rollback: validateRollback(record.rollback),
    rotation: validateRotation(record.rotation),
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    scope: validateScope(record.scope),
    timing: timing.normalized,
  };
  const artifact = {
    artifactVersion: CERTIFICATION_ARTIFACT_VERSION,
    certificationStatus: "passed",
    evidence,
    monitorResults: monitor.result,
    timingResults: timing.result,
  };
  const canonicalArtifact = canonicalJson(artifact);
  const artifactSha256 = sha256(canonicalArtifact);
  const canonicalEnvelope = canonicalJson({ artifact, artifactSha256 });
  const maximumMonitorFireLatency = Math.max(
    monitor.result.heatNotAdvancingFireLatencyMs,
    monitor.result.processDownFireLatencyMs,
  );
  const summary =
    `Task014 ${evidenceLevel} readiness PASS; ` +
    `provider p95=${timing.result.providerToManifest.p95Ms}ms; ` +
    `Heat p95=${timing.result.heat.p95Ms}ms; ` +
    `monitor max fire=${maximumMonitorFireLatency}ms; ` +
    `commit=${evidence.certification.commit.slice(0, 12)}; ` +
    `artifact sha256=${artifactSha256}`;
  return {
    artifact,
    artifactSha256,
    canonicalArtifact,
    canonicalEnvelope,
    summary,
  };
}

async function readInput(file) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    refuse("EVIDENCE_INPUT_UNREADABLE");
  }
  if (bytes.byteLength > MAXIMUM_INPUT_BYTES) refuse("EVIDENCE_INPUT_TOO_LARGE");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse("EVIDENCE_JSON_INVALID");
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || arguments_[0] === "-") {
    refuse("EVIDENCE_USAGE_INVALID");
  }
  const input = await readInput(arguments_[0]);
  const certified = certifyProviderManifestReadiness(input);
  process.stdout.write(`${certified.canonicalEnvelope}\n`);
  process.stderr.write(`${certified.summary}\n`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    const code = error instanceof ReadinessEvidenceError
      ? error.code
      : "EVIDENCE_UNEXPECTED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
