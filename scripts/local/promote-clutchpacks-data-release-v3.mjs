#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assertSameConnectedPostgresIdentity,
  connectedPostgresIdentityBindingParts,
  readConnectedPostgresIdentity,
} from "./connected-postgres-identity.mjs";

/**
 * Local ClutchPacks canonical PostgreSQL -> shiny-newt-310 data_release_v3
 * promotion runner.
 *
 * Safety is intentionally two phase:
 *
 *   1. `--stage` recomputes every canonical ClutchPacks EV revision, assembles
 *      one deterministic release, rejects any positive signed PackScout EV,
 *      then stages/finalizes and reads the signed lifecycle status back. It
 *      never activates.
 *   2. `--activate` accepts only that already-complete fingerprint, checks the
 *      expected active pointer, repeats the EV-sign check, activates through
 *      the production publisher, and reads all 17 packs plus bounded public
 *      category/collectible/chase probes back from the complete release.
 *
 * With no arguments the command is a write-free dry run that prints the
 * target-bound staging confirmation. This one-off local boundary is pinned to
 * the imported canary database and the separate Convex deployment requested
 * for the initial ClutchPacks proof; it cannot target Neon or production.
 */

export const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks";
export const CLUTCHPACKS_EXPECTED_REPACK_COUNT = 17;
export const CLUTCHPACKS_SETTLEMENT_MAX_AGE_MILLISECONDS = 3_600_000;
export const CLUTCHPACKS_RELEASE_MIN_REMAINING_LIFETIME_MILLISECONDS =
  15 * 60_000;
export const CLUTCHPACKS_CONVEX_AUTH_CLOCK_SKEW_ALLOWANCE_MILLISECONDS =
  5 * 60_000;
export const CLUTCHPACKS_MAX_CHASE_READBACK_COLLECTIBLES = 64;
export const CLUTCHPACKS_CANARY_DATABASE_NAME =
  "packscout_clutchpacks_v3_canary";
export const CLUTCHPACKS_CONVEX_PUBLICATION_URL =
  "https://shiny-newt-310.convex.site/";
export const CLUTCHPACKS_CONVEX_QUERY_URL =
  "https://shiny-newt-310.convex.cloud/";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN =
  /^(?=.{4,64}$)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,54})[._-]v[1-9][0-9]*$/u;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const ERROR_MESSAGES = Object.freeze({
  CLUTCHPACKS_V3_ARGUMENT_INVALID:
    "The ClutchPacks data release command arguments are invalid.",
  CLUTCHPACKS_V3_TARGET_INVALID:
    "The ClutchPacks data release target is not the approved local canary and shiny-newt deployment.",
  CLUTCHPACKS_V3_CONFIRMATION_REQUIRED:
    "The target-bound ClutchPacks data release confirmation is required.",
  CLUTCHPACKS_V3_SCOPE_INVALID:
    "The release is not scoped to the complete governed ClutchPacks V3 catalog.",
  CLUTCHPACKS_V3_CANONICAL_UNSETTLED:
    "The requested read is not the latest fully settled ClutchPacks canonical watermark.",
  CLUTCHPACKS_V3_SETTLEMENT_STALE:
    "The latest settled ClutchPacks canonical watermark is outside the 60-minute publication window.",
  CLUTCHPACKS_V3_BACKFILL_BLOCKED:
    "The ClutchPacks EV backfill did not reconcile completely.",
  CLUTCHPACKS_V3_EVIDENCE_STALE:
    "ClutchPacks evidence lacks the required remaining publication lifetime; a fresh settled canonical cause is required.",
  CLUTCHPACKS_V3_PLAN_BLOCKED:
    "The ClutchPacks data release plan is blocked.",
  CLUTCHPACKS_V3_POSITIVE_EV:
    "A positive signed ClutchPacks PackScout EV was found; publication is blocked pending an explicit methodology decision.",
  CLUTCHPACKS_V3_STAGING_DIVERGENT:
    "The staged ClutchPacks release did not read back exactly.",
  CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED:
    "The active Convex release pointer changed outside the requested activation.",
  CLUTCHPACKS_V3_RELEASE_MISMATCH:
    "The assembled release does not match the operator-approved staged fingerprint.",
  CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT:
    "The activated ClutchPacks release did not reconcile through the public V3 catalog queries.",
  CLUTCHPACKS_V3_ACTIVATION_ROLLED_BACK:
    "ClutchPacks activation verification failed and the prior release was restored.",
  CLUTCHPACKS_V3_EXECUTION_FAILED:
    "The ClutchPacks data release command failed safely.",
});

export class ClutchpacksDataReleaseV3PromotionError extends Error {
  constructor(code, options) {
    const safeCode = ERROR_MESSAGES[code]
      ? code
      : "CLUTCHPACKS_V3_EXECUTION_FAILED";
    super(ERROR_MESSAGES[safeCode], options);
    this.name = "ClutchpacksDataReleaseV3PromotionError";
    this.code = safeCode;
  }
}

function refuse(code, options) {
  throw new ClutchpacksDataReleaseV3PromotionError(code, options);
}

function required(environment, name, maximumBytes = 4_096) {
  const value = environment[name]?.trim();
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\r\n]/u.test(value)
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  return value;
}

function safeDatabaseTarget(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !parsed.username ||
    parsed.pathname !== `/${CLUTCHPACKS_CANARY_DATABASE_NAME}` ||
    parsed.search ||
    parsed.hash
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  const safe = new URL(parsed.href);
  safe.password = "";
  safe.hostname = safe.hostname.toLowerCase();
  return safe.href;
}

function exactHttpsOrigin(value, expected) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== expected
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  return parsed.href;
}

function decodePublicationSecret(value) {
  if (!CANONICAL_BASE64_PATTERN.test(value)) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength < 32 ||
    bytes.byteLength > 256 ||
    bytes.toString("base64") !== value
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  return new Uint8Array(bytes);
}

function sha256(...values) {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function exactTextMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

export function buildClutchpacksV3StageConfirmation(targetDigest) {
  if (!SHA256_PATTERN.test(targetDigest)) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  return `STAGE CLUTCHPACKS DATA RELEASE V3 ${targetDigest.slice(0, 16)}`;
}

export function buildClutchpacksV3ActivationConfirmation({
  targetDigest,
  releaseFingerprint,
  expectedActivePublicReleaseId,
}) {
  if (
    !SHA256_PATTERN.test(targetDigest) ||
    !SHA256_PATTERN.test(releaseFingerprint) ||
    (expectedActivePublicReleaseId !== null &&
      !UUID_PATTERN.test(expectedActivePublicReleaseId))
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  const digest = sha256(
    "packscout.clutchpacks-data-release-v3-activation.v1",
    targetDigest,
    releaseFingerprint,
    expectedActivePublicReleaseId ?? "genesis",
  );
  return `ACTIVATE CLUTCHPACKS DATA RELEASE V3 ${digest.slice(0, 16)}`;
}

export function bindClutchpacksDataReleaseV3DatabaseIdentity(
  command,
  databaseIdentity,
) {
  let identityParts;
  try {
    identityParts = connectedPostgresIdentityBindingParts(databaseIdentity);
  } catch {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  const targetDigest = sha256(
    "packscout.clutchpacks-data-release-v3-target.v2",
    command.targetScopeDigest,
    ...identityParts,
  );
  const stageConfirmation = buildClutchpacksV3StageConfirmation(targetDigest);
  const activationConfirmation = command.mode === "activate"
    ? buildClutchpacksV3ActivationConfirmation({
        targetDigest,
        releaseFingerprint: command.expectedReleaseFingerprint,
        expectedActivePublicReleaseId: command.expectedActivePublicReleaseId,
      })
    : null;
  return Object.freeze({
    ...command,
    databaseIdentity,
    targetDigest,
    stageConfirmation,
    activationConfirmation,
  });
}

export async function readClutchpacksDataReleaseV3DatabaseIdentity(database) {
  try {
    return await readConnectedPostgresIdentity(
      (sql) => database.$queryRawUnsafe(sql),
      CLUTCHPACKS_CANARY_DATABASE_NAME,
    );
  } catch {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
}

function parseModeArguments(argv) {
  if (argv.length === 0 ||
      (argv.length === 1 && argv[0] === "--dry-run")) {
    return { mode: "dry_run", expectedReleaseFingerprint: null,
      expectedActivePublicReleaseId: null };
  }
  if (argv.length === 1 && argv[0] === "--stage") {
    return { mode: "stage", expectedReleaseFingerprint: null,
      expectedActivePublicReleaseId: null };
  }
  if (argv[0] !== "--activate") {
    refuse("CLUTCHPACKS_V3_ARGUMENT_INVALID");
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--expected-release-fingerprint", "--expected-active-release"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      refuse("CLUTCHPACKS_V3_ARGUMENT_INVALID");
    }
    values.set(flag, value);
  }
  const expectedReleaseFingerprint =
    values.get("--expected-release-fingerprint");
  const expectedActive = values.get("--expected-active-release");
  if (
    !SHA256_PATTERN.test(expectedReleaseFingerprint ?? "") ||
    expectedActive === undefined ||
    (expectedActive !== "genesis" && !UUID_PATTERN.test(expectedActive))
  ) {
    refuse("CLUTCHPACKS_V3_ARGUMENT_INVALID");
  }
  return {
    mode: "activate",
    expectedReleaseFingerprint,
    expectedActivePublicReleaseId:
      expectedActive === "genesis" ? null : expectedActive,
  };
}

export function parseClutchpacksDataReleaseV3Command({ argv, environment }) {
  const mode = parseModeArguments(argv);
  if (
    environment.NODE_ENV === "production" ||
    environment.PACKSCOUT_RUNTIME_ENVIRONMENT?.trim() !== "local"
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  const organizationId = required(
    environment,
    "PACKSCOUT_PUBLIC_ORGANIZATION_ID",
  ).toLowerCase();
  const readAt = required(environment, "PACKSCOUT_CLUTCHPACKS_V3_READ_AT");
  const databaseUrl = required(environment, "PACKSCOUT_DATABASE_URL");
  const publicationBaseUrl = exactHttpsOrigin(
    required(environment, "PACKSCOUT_CONVEX_PUBLICATION_BASE_URL"),
    CLUTCHPACKS_CONVEX_PUBLICATION_URL,
  );
  const queryUrl = exactHttpsOrigin(
    required(environment, "PACKSCOUT_CONVEX_URL"),
    CLUTCHPACKS_CONVEX_QUERY_URL,
  );
  const keyId = required(
    environment,
    "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_ID",
  );
  if (
    !UUID_PATTERN.test(organizationId) ||
    !Number.isFinite(Date.parse(readAt)) ||
    new Date(readAt).toISOString() !== readAt ||
    !KEY_ID_PATTERN.test(keyId)
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  const databaseTarget = safeDatabaseTarget(databaseUrl);
  const targetScopeDigest = sha256(
    "packscout.clutchpacks-data-release-v3-target-scope.v1",
    organizationId,
    readAt,
    databaseTarget,
    publicationBaseUrl,
    queryUrl,
    keyId,
    String(CLUTCHPACKS_EXPECTED_REPACK_COUNT),
  );
  const secret = mode.mode === "dry_run"
    ? null
    : decodePublicationSecret(required(
      environment,
      "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64",
    ));
  const catalogReadToken = environment.PACKSCOUT_CATALOG_READ_TOKEN?.trim() ||
    null;
  if (
    catalogReadToken !== null &&
    (catalogReadToken.length < 32 || catalogReadToken.length > 512)
  ) {
    refuse("CLUTCHPACKS_V3_TARGET_INVALID");
  }
  return Object.freeze({
    ...mode,
    organizationId,
    readAt,
    databaseUrl,
    publicationBaseUrl,
    queryUrl,
    keyId,
    secret,
    catalogReadToken,
    targetScopeDigest,
  });
}

function repackRecords(plan) {
  return recordsForKind(plan, "repacks");
}

const DATA_RELEASE_V3_ENTITY_KINDS = Object.freeze([
  "categories",
  "collectibles",
  "repacks",
  "chases",
]);

function recordsForKind(plan, kind) {
  return plan?.batches
    ?.filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records) ?? [];
}

function entityKey(kind, record) {
  if (kind === "categories") return record.publicCategoryId;
  if (kind === "collectibles") return record.publicCollectibleId;
  if (kind === "repacks") return record.publicRepackId;
  return `${record.publicRepackId}\0${record.publicCollectibleId}`;
}

function sortedEntityRecords(kind, records) {
  return [...records].sort((left, right) => {
    const leftKey = entityKey(kind, left);
    const rightKey = entityKey(kind, right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function exactIdSet(values) {
  return [...new Set(values)].sort();
}

export function assertClutchpacksCatalogScope(snapshot) {
  const products = snapshot?.products;
  const categories = snapshot?.categories;
  const collectibles = snapshot?.collectibles;
  const chases = snapshot?.chases;
  if (
    snapshot?.organizationId === undefined ||
    !Array.isArray(products) ||
    !Array.isArray(categories) ||
    !Array.isArray(collectibles) ||
    !Array.isArray(chases) ||
    products.length !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    categories.length === 0 ||
    collectibles.length === 0 ||
    products.some((product) =>
      product.platformKey !== CLUTCHPACKS_PLATFORM_KEY ||
      product.vendorKey !== CLUTCHPACKS_PLATFORM_KEY) ||
    exactIdSet(products.map((product) => product.productKey)).length !==
      products.length ||
    exactIdSet(products.map((product) => product.publicRepackId)).length !==
      products.length ||
    exactIdSet(categories.map((category) => category.publicCategoryId)).length !==
      categories.length ||
    exactIdSet(collectibles.map((collectible) =>
      collectible.publicCollectibleId)).length !== collectibles.length ||
    exactIdSet(chases.map((chase) => entityKey("chases", chase))).length !==
      chases.length
  ) {
    refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
  }
  const publicRepackIds = exactIdSet(
    products.map((product) => product.publicRepackId),
  );
  const publicCategoryIds = new Set(
    categories.map((category) => category.publicCategoryId),
  );
  const publicCollectibleIds = new Set(
    collectibles.map((collectible) => collectible.publicCollectibleId),
  );
  if (
    products.some((product) =>
      !Array.isArray(product.categories) ||
      product.categories.some((category) =>
        !publicCategoryIds.has(category.publicCategoryId))) ||
    collectibles.some((collectible) =>
      !Array.isArray(collectible.publicCategoryIds) ||
      collectible.publicCategoryIds.some((categoryId) =>
        !publicCategoryIds.has(categoryId))) ||
    chases.some((chase) =>
      !publicRepackIds.includes(chase.publicRepackId) ||
      !publicCollectibleIds.has(chase.publicCollectibleId))
  ) {
    refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
  }
  return Object.freeze({
    expectedPublicRepackIds: publicRepackIds,
    entityCounts: Object.freeze({
      categories: categories.length,
      collectibles: collectibles.length,
      repacks: products.length,
      chases: chases.length,
    }),
    entities: Object.freeze({ products, categories, collectibles, chases }),
  });
}

export function assertClutchpacksPlanCompleteness(plan, scope) {
  if (plan?.classification !== "publish") {
    refuse("CLUTCHPACKS_V3_PLAN_BLOCKED");
  }
  const actual = Object.fromEntries(DATA_RELEASE_V3_ENTITY_KINDS.map((kind) => [
    kind,
    recordsForKind(plan, kind),
  ]));
  const batchIndexes = plan.batches?.map((batch) => batch.batchIndex) ?? [];
  if (
    plan.batches?.some((batch) =>
      !DATA_RELEASE_V3_ENTITY_KINDS.includes(batch.kind)) ||
    !isDeepStrictEqual(
      [...batchIndexes].sort((left, right) => left - right),
      Array.from({ length: plan.batches?.length ?? 0 }, (_, index) => index),
    ) ||
    plan.manifest?.batchCount !== plan.batches?.length ||
    !Number.isSafeInteger(plan.manifest?.counts?.searchShards) ||
    plan.manifest.counts.searchShards <= 0 ||
    plan.batches.filter((batch) => batch.kind === "repacks").length !==
      plan.manifest.counts.searchShards ||
    DATA_RELEASE_V3_ENTITY_KINDS.some((kind) =>
      actual[kind].length !== plan.manifest.counts[kind]) ||
    !isDeepStrictEqual(
      {
        categories: plan.manifest.counts.categories,
        collectibles: plan.manifest.counts.collectibles,
        repacks: plan.manifest.counts.repacks,
        chases: plan.manifest.counts.chases,
      },
      scope.entityCounts,
    ) ||
    !isDeepStrictEqual(
      sortedEntityRecords("categories", actual.categories),
      sortedEntityRecords("categories", scope.entities.categories),
    ) ||
    !isDeepStrictEqual(
      sortedEntityRecords("collectibles", actual.collectibles),
      sortedEntityRecords("collectibles", scope.entities.collectibles),
    ) ||
    !isDeepStrictEqual(
      sortedEntityRecords("chases", actual.chases),
      sortedEntityRecords("chases", scope.entities.chases),
    ) ||
    !isDeepStrictEqual(
      exactIdSet(actual.repacks.map((detail) => detail.publicRepackId)),
      scope.expectedPublicRepackIds,
    ) ||
    plan.manifest.topChaseCount !==
      actual.repacks.filter((detail) => detail.topChase !== null).length
  ) {
    refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
  }
  return Object.freeze({ ...plan.manifest.counts });
}

export function assertLatestClutchpacksSettledWatermark(watermark, command) {
  if (
    watermark?.organizationId !== command.organizationId ||
    watermark.settledAt?.toISOString?.() !== command.readAt ||
    typeof watermark.settledSequence !== "bigint" ||
    watermark.settledSequence <= 0n ||
    watermark.settledSequence !== watermark.sourceHeadSequence ||
    !Array.isArray(watermark.sourceHeads) ||
    watermark.sourceHeads.some((head) => head.settled !== true)
  ) {
    refuse("CLUTCHPACKS_V3_CANONICAL_UNSETTLED");
  }
}

/**
 * The governed read clock is also a publication clock. Replaying a historical
 * watermark can look fresh when evidence is scored at `readAt`, while the
 * public server clock expires that same estimate immediately. Refuse future
 * clocks and clocks older than the public 60-minute source-age window before
 * recomputation can write a revision.
 */
export function assertClutchpacksSettlementPublishableNow(
  watermark,
  currentTimeMilliseconds,
) {
  const settledAtMilliseconds = watermark?.settledAt?.getTime?.();
  if (
    !Number.isSafeInteger(currentTimeMilliseconds) ||
    !Number.isFinite(settledAtMilliseconds) ||
    settledAtMilliseconds > currentTimeMilliseconds ||
    currentTimeMilliseconds - settledAtMilliseconds >
      CLUTCHPACKS_SETTLEMENT_MAX_AGE_MILLISECONDS
  ) {
    refuse("CLUTCHPACKS_V3_SETTLEMENT_STALE");
  }
}

export function assertClutchpacksBackfill(backfill, expectedPublicRepackIds) {
  const ledger = backfill?.ledger;
  const rowIds = ledger?.rows?.map((row) => row.publicRepackId) ?? [];
  if (
    backfill?.classification !== "ready" ||
    ledger?.classification !== "ready" ||
    ledger?.counts?.total !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    ledger?.rows?.length !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    ledger.rows.some((row) => row.platformKey !== CLUTCHPACKS_PLATFORM_KEY) ||
    ledger.recomputation?.created + ledger.recomputation?.unchanged !==
      CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    ledger.recomputation?.superseded !== 0 ||
    ledger.recomputation?.rejected !== 0 ||
    ledger.recomputation?.unbindable !== 0 ||
    ledger.recomputation?.skippedNoEvidence !== 0 ||
    !isDeepStrictEqual(exactIdSet(rowIds), expectedPublicRepackIds)
  ) {
    refuse("CLUTCHPACKS_V3_BACKFILL_BLOCKED");
  }
  // A duplicate-only delivery occurrence does not advance the canonical
  // watermark and is intentionally outside this read clock. Never treat it
  // as an EV refresh: staging waits for a fresh governed canonical cause.
  if (ledger.rows.some((row) =>
    row.sourceAgeBucket === "stale_or_expired" ||
    row.sourceAgeBucket === "unknown_source_time")) {
    refuse("CLUTCHPACKS_V3_EVIDENCE_STALE");
  }
  return ledger;
}

/** Blocks both independently signed EV measures and their gross-return basis. */
export function assertNoPositiveClutchpacksEv(plan, expectedPublicRepackIds) {
  if (plan?.classification !== "publish") {
    refuse("CLUTCHPACKS_V3_PLAN_BLOCKED");
  }
  const details = repackRecords(plan);
  if (
    plan.manifest?.counts?.repacks !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    details.length !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    details.some((detail) => detail.vendorKey !== CLUTCHPACKS_PLATFORM_KEY) ||
    !isDeepStrictEqual(
      exactIdSet(details.map((detail) => detail.publicRepackId)),
      expectedPublicRepackIds,
    )
  ) {
    refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
  }
  for (const detail of details) {
    const estimate = detail.evEstimates?.packScout;
    if (estimate?.status === "unavailable") continue;
    if (
      !estimate?.metrics ||
      estimate.metrics.evDollars.minorUnits > 0 ||
      estimate.metrics.evPercentBasisPoints > 0 ||
      estimate.metrics.grossReturnBasisPoints > 10_000
    ) {
      refuse("CLUTCHPACKS_V3_POSITIVE_EV");
    }
  }
  return details;
}

/**
 * A release assembled at a valid historical read clock can still be stale at
 * the wall clock used by Convex public queries. Current estimates must retain
 * enough of their exact publication deadline for the write, exhaustive
 * readback, and operator handoff. Convex signed publication auth permits five
 * minutes of clock skew, so every local gate reserves that allowance in
 * addition to the fifteen minutes advertised by a successful result. Sold-out
 * history is intentionally permanent and therefore carries a null expiry.
 */
export function assertClutchpacksPlanFreshAtWallClock(
  plan,
  currentTimeMilliseconds,
) {
  if (!Number.isSafeInteger(currentTimeMilliseconds)) {
    refuse("CLUTCHPACKS_V3_EVIDENCE_STALE");
  }
  for (const detail of repackRecords(plan)) {
    const estimate = detail.evEstimates?.packScout;
    if (estimate?.status === "unavailable") continue;
    if (estimate?.status === "sold_out_historical") {
      if (estimate.expiresAt !== null) {
        refuse("CLUTCHPACKS_V3_EVIDENCE_STALE");
      }
      continue;
    }
    const expiresAtMilliseconds = Date.parse(estimate?.expiresAt ?? "");
    if (
      estimate?.status !== "current" ||
      !Number.isFinite(expiresAtMilliseconds) ||
      new Date(expiresAtMilliseconds).toISOString() !== estimate.expiresAt ||
      expiresAtMilliseconds - currentTimeMilliseconds <
        CLUTCHPACKS_RELEASE_MIN_REMAINING_LIFETIME_MILLISECONDS +
          CLUTCHPACKS_CONVEX_AUTH_CLOCK_SKEW_ALLOWANCE_MILLISECONDS
    ) {
      refuse("CLUTCHPACKS_V3_EVIDENCE_STALE");
    }
  }
}

function assertStatusMatchesPlan(status, plan) {
  if (
    status === null ||
    status.lifecycle !== "complete" ||
    status.publicReleaseId !== plan.publicReleaseId ||
    status.releaseFingerprint !== plan.releaseFingerprint ||
    status.acceptedBatchCount !== plan.manifest.batchCount ||
    status.acceptedBatchChainHash !== plan.manifest.batchChainHash ||
    status.acceptedTopChaseCount !== plan.manifest.topChaseCount ||
    status.acceptedSearchRowCount !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    !SHA256_PATTERN.test(status.acceptedSearchRowSetHash) ||
    !isDeepStrictEqual(status.acceptedCounts, plan.manifest.counts) ||
    !isDeepStrictEqual(
      status.acceptedEntityChainHashes,
      plan.manifest.entityChainHashes,
    ) ||
    status.completedAt === null
  ) {
    refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
  }
}

function sameActiveState(left, right) {
  return left.generation === right.generation &&
    (left.activeRelease?.publicReleaseId ?? null) ===
      (right.activeRelease?.publicReleaseId ?? null) &&
    (left.activeRelease?.releaseFingerprint ?? null) ===
      (right.activeRelease?.releaseFingerprint ?? null);
}

function publicCollectibleDisplay(collectible) {
  return {
    publicCollectibleId: collectible.publicCollectibleId,
    name: collectible.name,
    collectibleType: collectible.collectibleType,
    publicCategoryIds: collectible.publicCategoryIds,
    primaryImage: collectible.primaryImage,
    valuation: collectible.valuation,
  };
}

function withoutDynamicHeat(record) {
  if (
    record === null ||
    typeof record !== "object" ||
    !Object.hasOwn(record, "heat")
  ) {
    refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
  }
  const { heat, ...stored } = record;
  if (heat === null || typeof heat !== "object") {
    refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
  }
  return stored;
}

function plannedRepackSummary(detail) {
  const { description: _description, actions: _actions, ...summary } = detail;
  return summary;
}

function firstMiddleLast(records) {
  if (records.length === 0) return [];
  const indexes = [...new Set([
    0,
    Math.floor((records.length - 1) / 2),
    records.length - 1,
  ])];
  return indexes.map((index) => records[index]);
}

/**
 * A full public lookup sweep over thousands of standalone collectibles would
 * be both operationally unsafe and redundant: every public V3 query first
 * proves the active release's finalized accepted counts and entity-chain
 * hashes. We therefore add deterministic first/middle/last direct and search
 * probes, plus exhaustive direct probes for every collectible referenced by a
 * chase while that chase surface remains within this command's fixed budget.
 */
export function clutchpacksCollectibleReadbackProbes(scope) {
  const collectibles = sortedEntityRecords(
    "collectibles",
    scope?.entities?.collectibles ?? [],
  );
  const chaseCollectibleIds = exactIdSet(
    (scope?.entities?.chases ?? []).map((chase) => chase.publicCollectibleId),
  );
  if (
    collectibles.length === 0 ||
    chaseCollectibleIds.length >
      CLUTCHPACKS_MAX_CHASE_READBACK_COLLECTIBLES
  ) {
    refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
  }
  const byId = new Map(collectibles.map((collectible) => [
    collectible.publicCollectibleId,
    collectible,
  ]));
  const directRepresentative = firstMiddleLast(collectibles);
  const directIds = exactIdSet([
    ...directRepresentative.map((collectible) =>
      collectible.publicCollectibleId),
    ...chaseCollectibleIds,
  ]);
  const direct = directIds.map((publicCollectibleId) => {
    const collectible = byId.get(publicCollectibleId);
    if (collectible === undefined) {
      refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
    }
    return collectible;
  });
  const normalizedNameCounts = new Map();
  for (const collectible of collectibles) {
    const name = collectible.normalizedName;
    normalizedNameCounts.set(name, (normalizedNameCounts.get(name) ?? 0) + 1);
  }
  // Search is name-addressed and bounded. Only a name unique within the exact
  // release guarantees that the requested public identity cannot be crowded
  // out by same-name cards in the capped result set.
  const searchCandidates = collectibles.filter((collectible) =>
    typeof collectible.normalizedName === "string" &&
    collectible.normalizedName.length >= 2 &&
    normalizedNameCounts.get(collectible.normalizedName) === 1);
  const search = firstMiddleLast(searchCandidates);
  if (search.length === 0) {
    refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
  }
  return Object.freeze({
    direct: Object.freeze(direct),
    search: Object.freeze(search),
  });
}

export function assertClutchpacksPublicReadBack(readBack, plan, scope) {
  const shell = readBack?.shell;
  const list = readBack?.list;
  const details = readBack?.details;
  const dashboard = readBack?.dashboard;
  const collectibleReads = readBack?.collectibleReads;
  const collectibleSearches = readBack?.collectibleSearches;
  const probes = clutchpacksCollectibleReadbackProbes(scope);
  const expectedIds = scope.expectedPublicRepackIds;
  const expectedProductCategoryIds = exactIdSet(
    scope.entities.products.flatMap((product) =>
      product.categories.map((category) => category.publicCategoryId)),
  );
  if (
    shell?.ok !== true ||
    shell.data?.release?.publicReleaseId !== plan.publicReleaseId ||
    shell.data.release.dataAsOf !== plan.manifest.dataAsOf ||
    shell.data.release.methodVersion !== plan.manifest.methodVersion ||
    shell.data.release.confidencePolicyVersion !==
      plan.manifest.confidencePolicyVersion ||
    shell.data.release.publicEvPolicyVersion !==
      plan.manifest.publicEvPolicyVersion ||
    list?.ok !== true ||
    list.data?.release?.publicReleaseId !== plan.publicReleaseId ||
    list.data?.range?.total !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    list.data?.rows?.length !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    list.data?.details?.length !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    list.data?.nextCursor !== null ||
    !isDeepStrictEqual(
      exactIdSet(list.data?.rows?.map((row) => row.publicRepackId) ?? []),
      expectedIds,
    ) ||
    !Array.isArray(details) ||
    details.length !== CLUTCHPACKS_EXPECTED_REPACK_COUNT ||
    details.some((result) =>
      result?.ok !== true ||
      result.data?.vendorKey !== CLUTCHPACKS_PLATFORM_KEY) ||
    !isDeepStrictEqual(
      exactIdSet(details.map((result) => result.data.publicRepackId)),
      expectedIds,
    ) ||
    dashboard?.ok !== true ||
    dashboard.data?.release?.publicReleaseId !== plan.publicReleaseId ||
    !isDeepStrictEqual(
      exactIdSet(dashboard.data?.facets?.categories?.map(
        (category) => category.key,
      ) ?? []),
      expectedProductCategoryIds,
    ) ||
    !Array.isArray(collectibleReads) ||
    collectibleReads.length !== probes.direct.length ||
    !Array.isArray(collectibleSearches) ||
    collectibleSearches.length !== probes.search.length
  ) {
    refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
  }
  const plannedDetails = sortedEntityRecords("repacks", repackRecords(plan));
  const listedDetails = sortedEntityRecords(
    "repacks",
    list.data.details.map(withoutDynamicHeat),
  );
  const directDetails = sortedEntityRecords(
    "repacks",
    details.map((result) => withoutDynamicHeat(result.data)),
  );
  const plannedSummaries = sortedEntityRecords(
    "repacks",
    plannedDetails.map(plannedRepackSummary),
  );
  const listedSummaries = sortedEntityRecords(
    "repacks",
    list.data.rows.map(withoutDynamicHeat),
  );
  if (
    !isDeepStrictEqual(listedDetails, plannedDetails) ||
    !isDeepStrictEqual(directDetails, plannedDetails) ||
    !isDeepStrictEqual(listedSummaries, plannedSummaries)
  ) {
    refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
  }
  const collectibleReadById = new Map();
  const publicChases = [];
  for (const read of collectibleReads) {
    const result = read?.result;
    const desired = result?.data?.desiredCollectible;
    if (
      read?.publicCollectibleId !== desired?.publicCollectibleId ||
      result?.ok !== true ||
      result.data?.release?.publicReleaseId !== plan.publicReleaseId ||
      typeof desired?.publicCollectibleId !== "string" ||
      collectibleReadById.has(desired.publicCollectibleId) ||
      !Array.isArray(result.data.matches) ||
      result.data.total !== result.data.matches.length
    ) {
      refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
    }
    collectibleReadById.set(desired.publicCollectibleId, result);
    publicChases.push(...result.data.matches.map((match) => match.chase));
  }
  for (const collectible of probes.direct) {
    const result = collectibleReadById.get(collectible.publicCollectibleId);
    const expectedChases = sortedEntityRecords(
      "chases",
      scope.entities.chases.filter((chase) =>
        chase.publicCollectibleId === collectible.publicCollectibleId),
    );
    if (
      result === undefined ||
      !isDeepStrictEqual(
        result.data.desiredCollectible,
        publicCollectibleDisplay(collectible),
      ) ||
      result.data.total !== expectedChases.length ||
      !isDeepStrictEqual(
        sortedEntityRecords(
          "chases",
          result.data.matches.map((match) => match.chase),
        ),
        expectedChases,
      )
    ) {
      refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
    }
  }
  for (const [index, expected] of probes.search.entries()) {
    const search = collectibleSearches[index];
    const result = search?.result;
    const exactMatch = result?.data?.matches?.find((collectible) =>
      collectible.publicCollectibleId === expected.publicCollectibleId);
    if (
      search?.publicCollectibleId !== expected.publicCollectibleId ||
      search?.search !== expected.normalizedName ||
      result?.ok !== true ||
      result.data?.release?.publicReleaseId !== plan.publicReleaseId ||
      !isDeepStrictEqual(exactMatch, expected)
    ) {
      refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
    }
  }
  if (
    !isDeepStrictEqual(
      sortedEntityRecords("chases", publicChases),
      sortedEntityRecords("chases", scope.entities.chases),
    )
  ) {
    refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
  }
  const plannedById = new Map(plannedDetails.map((detail) => [
    detail.publicRepackId,
    detail.evEstimates?.packScout,
  ]));
  const publicDetails = [
    ...list.data.details,
    ...details.map((result) => result.data),
  ];
  for (const detail of publicDetails) {
    const estimate = detail.evEstimates?.packScout;
    const planned = plannedById.get(detail.publicRepackId);
    if (
      planned === undefined ||
      !estimate ||
      !isDeepStrictEqual(estimate, planned) ||
      !["current", "sold_out_historical", "unavailable"].includes(
        estimate.status,
      ) ||
      (estimate.status !== "unavailable" &&
        (!estimate.metrics ||
        estimate.metrics.evDollars.minorUnits > 0 ||
        estimate?.metrics?.evPercentBasisPoints > 0 ||
        estimate?.metrics?.grossReturnBasisPoints > 10_000))
    ) {
      refuse("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
    }
  }
}

/**
 * Binds the publisher's actual server-side activation CAS to the predecessor
 * approved by the operator confirmation. A fresh port read may prove that
 * predecessor still active; it can never silently replace it with a newer
 * pointer when constructing the activate request.
 */
export function operatorBoundDataReleaseV3ActivationPort(
  publication,
  plan,
  expectedActivePublicReleaseId,
) {
  let activationReceiptReturned = false;
  return Object.freeze({
    async activeState() {
      const state = await publication.activeState();
      const activeId = state.activeRelease?.publicReleaseId ?? null;
      if (
        (!activationReceiptReturned &&
          activeId !== expectedActivePublicReleaseId) ||
        (activationReceiptReturned &&
          (activeId !== plan.publicReleaseId ||
            (state.previousRelease?.publicReleaseId ?? null) !==
              expectedActivePublicReleaseId))
      ) {
        refuse("CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED");
      }
      return state;
    },
    status: (publicReleaseId) => publication.status(publicReleaseId),
    start: (request) => publication.start(request),
    applyBatch: (request) => publication.applyBatch(request),
    finalize: (request) => publication.finalize(request),
    async activate(request) {
      if (
        request.publicReleaseId !== plan.publicReleaseId ||
        request.releaseFingerprint !== plan.releaseFingerprint ||
        request.expectedActivePublicReleaseId !==
          expectedActivePublicReleaseId
      ) {
        refuse("CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED");
      }
      const receipt = await publication.activate(request);
      activationReceiptReturned = true;
      return receipt;
    },
    rollback() {
      refuse("CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED");
    },
  });
}

function recoveryRequiredResult(command, plan, verificationError) {
  return Object.freeze({
    schemaVersion: "packscout.clutchpacks-data-release-v3-result.v1",
    status: "activated_but_unverified_recovery_required",
    targetDigest: command.targetDigest,
    databaseIdentity: command.databaseIdentity,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    expectedRepackCount: CLUTCHPACKS_EXPECTED_REPACK_COUNT,
    acceptedEntityCounts: Object.freeze({ ...plan.manifest.counts }),
    minimumRemainingLifetimeMilliseconds:
      CLUTCHPACKS_RELEASE_MIN_REMAINING_LIFETIME_MILLISECONDS,
    expectedPriorPublicReleaseId: command.expectedActivePublicReleaseId,
    verificationCode:
      verificationError instanceof ClutchpacksDataReleaseV3PromotionError
        ? verificationError.code
        : "CLUTCHPACKS_V3_EXECUTION_FAILED",
  });
}

async function recoverUnverifiedActivation(
  opened,
  command,
  plan,
  verificationError,
) {
  let state;
  try {
    state = await opened.publication.activeState();
  } catch {
    return recoveryRequiredResult(command, plan, verificationError);
  }
  const activeId = state.activeRelease?.publicReleaseId ?? null;
  const previousId = state.previousRelease?.publicReleaseId ?? null;
  if (
    activeId !== plan.publicReleaseId ||
    command.expectedActivePublicReleaseId === plan.publicReleaseId
  ) {
    return null;
  }
  if (
    previousId !== command.expectedActivePublicReleaseId ||
    command.expectedActivePublicReleaseId === null
  ) {
    return recoveryRequiredResult(command, plan, verificationError);
  }
  try {
    await opened.rollback({
      expectedActivePublicReleaseId: plan.publicReleaseId,
      targetPublicReleaseId: command.expectedActivePublicReleaseId,
    });
  } catch {
    return recoveryRequiredResult(command, plan, verificationError);
  }
  return Object.freeze({ status: "rolled_back" });
}

function assertPlanIdentity(first, second) {
  if (
    second?.classification !== "publish" ||
    first.publicReleaseId !== second.publicReleaseId ||
    first.releaseFingerprint !== second.releaseFingerprint
  ) {
    refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
  }
}

/**
 * Allows the reconciliation runner to stage only the exact plan that already
 * passed the Clutch scope, freshness, and signed-EV gates. A changed second
 * canonical read is refused at `start`, before the real port receives a
 * staging write; activation and rollback are impossible through this port.
 */
export function exactDataReleaseV3StagingPort(publication, plan) {
  const expectedStart = {
    schemaVersion: "data_release_v3",
    operationId: `${plan.publicReleaseId}:start`,
    idempotencyKey: `${plan.publicReleaseId}:start`,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    manifest: plan.manifest,
  };
  const expectedFinalize = {
    schemaVersion: "data_release_v3",
    operationId: `${plan.publicReleaseId}:finalize`,
    idempotencyKey: `${plan.publicReleaseId}:finalize`,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    expectedCounts: plan.manifest.counts,
    expectedEntityChainHashes: plan.manifest.entityChainHashes,
    expectedTopChaseCount: plan.manifest.topChaseCount,
    expectedBatchCount: plan.manifest.batchCount,
    expectedBatchChainHash: plan.manifest.batchChainHash,
  };
  const expectedBatches = new Map(plan.batches.map((batch) => [
    batch.batchIndex,
    {
      schemaVersion: "data_release_v3",
      operationId: `${plan.publicReleaseId}:batch:${batch.batchIndex}`,
      idempotencyKey: `${plan.publicReleaseId}:batch:${batch.batchIndex}`,
      publicReleaseId: plan.publicReleaseId,
      batchIndex: batch.batchIndex,
      kind: batch.kind,
      batchHash: batch.batchHash,
      records: batch.records,
    },
  ]));
  let startWasAlreadyComplete = false;
  const applied = new Set();
  return Object.freeze({
    activeState: () => publication.activeState(),
    status(publicReleaseId) {
      if (publicReleaseId !== plan.publicReleaseId) {
        refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
      }
      return publication.status(publicReleaseId);
    },
    async start(request) {
      if (!isDeepStrictEqual(request, expectedStart)) {
        refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
      }
      const receipt = await publication.start(request);
      startWasAlreadyComplete = receipt.result === "already_complete";
      return receipt;
    },
    applyBatch(request) {
      if (
        applied.has(request.batchIndex) ||
        !isDeepStrictEqual(request, expectedBatches.get(request.batchIndex))
      ) {
        refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
      }
      applied.add(request.batchIndex);
      return publication.applyBatch(request);
    },
    finalize(request) {
      if (
        !isDeepStrictEqual(request, expectedFinalize) ||
        (!startWasAlreadyComplete && applied.size !== expectedBatches.size)
      ) {
        refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
      }
      return publication.finalize(request);
    },
    activate() {
      refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
    },
    rollback() {
      refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
    },
  });
}

function assertClutchpacksDataReleaseV3Confirmation(command, environment) {
  if (command.mode === "dry_run") return;
  const expected = command.mode === "stage"
    ? command.stageConfirmation
    : command.activationConfirmation;
  if (!exactTextMatches(
    environment.PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION,
    expected,
  )) {
    refuse("CLUTCHPACKS_V3_CONFIRMATION_REQUIRED");
  }
}

async function reverifyClutchpacksDataReleaseV3Database(
  opened,
  expectedIdentity,
) {
  try {
    assertSameConnectedPostgresIdentity(
      await opened.readDatabaseIdentity(),
      expectedIdentity,
    );
  } catch (error) {
    if (error instanceof ClutchpacksDataReleaseV3PromotionError) throw error;
    refuse("CLUTCHPACKS_V3_TARGET_INVALID", { cause: error });
  }
}

export async function runClutchpacksDataReleaseV3Promotion({
  argv,
  environment,
  dependencies = createProductionDependencies(),
  writeOutput = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
}) {
  const parsedCommand = parseClutchpacksDataReleaseV3Command({
    argv,
    environment,
  });
  let opened;
  try {
    const databaseIdentity = await dependencies.readDatabaseIdentity(
      parsedCommand,
    );
    const command = bindClutchpacksDataReleaseV3DatabaseIdentity(
      parsedCommand,
      databaseIdentity,
    );
    assertClutchpacksDataReleaseV3Confirmation(command, environment);
    if (command.mode === "dry_run") {
      const result = Object.freeze({
        schemaVersion: "packscout.clutchpacks-data-release-v3-result.v1",
        status: "planned",
        targetDigest: command.targetDigest,
        databaseIdentity: command.databaseIdentity,
        expectedRepackCount: CLUTCHPACKS_EXPECTED_REPACK_COUNT,
        requiredStageConfirmation: command.stageConfirmation,
        activationRequested: false,
      });
      writeOutput(result);
      return result;
    }

    opened = await dependencies.open(command);
    await reverifyClutchpacksDataReleaseV3Database(
      opened,
      command.databaseIdentity,
    );
    const watermark = await opened.loadSettledWatermark();
    assertLatestClutchpacksSettledWatermark(watermark, command);
    assertClutchpacksSettlementPublishableNow(watermark, dependencies.now());
    let snapshot;
    try {
      snapshot = await opened.catalog.loadCatalogSnapshot({
        readAt: command.readAt,
      });
    } catch (error) {
      // A mapped source asset without a public name/identity is canonical
      // incompleteness, not an execution outage. Preserve the fail-closed
      // adapter rule and report it through the stable promotion scope code.
      if (error?.code === "PUBLIC_IDENTITY_MAPPING_MISSING") {
        refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
      }
      throw error;
    }
    if (snapshot.organizationId !== command.organizationId) {
      refuse("CLUTCHPACKS_V3_SCOPE_INVALID");
    }
    const scope = assertClutchpacksCatalogScope(snapshot);
    // Prove up front that the bounded post-activation public proof is
    // addressable; never discover an ambiguous search surface only after CAS.
    clutchpacksCollectibleReadbackProbes(scope);
    const expectedIds = scope.expectedPublicRepackIds;
    await reverifyClutchpacksDataReleaseV3Database(
      opened,
      command.databaseIdentity,
    );
    const preflight = await opened.runBackfill({ stage: false });
    const ledger = assertClutchpacksBackfill(preflight, expectedIds);
    const plan = await opened.assembler.assemble({ readAt: command.readAt });
    assertClutchpacksPlanCompleteness(plan, scope);
    assertNoPositiveClutchpacksEv(plan, expectedIds);
    assertClutchpacksPlanFreshAtWallClock(plan, dependencies.now());

    if (command.mode === "stage") {
      const activeBefore = await opened.publication.activeState();
      const stagingWatermark = await opened.loadSettledWatermark();
      const stagingCurrentTime = dependencies.now();
      assertLatestClutchpacksSettledWatermark(stagingWatermark, command);
      assertClutchpacksSettlementPublishableNow(
        stagingWatermark,
        stagingCurrentTime,
      );
      assertClutchpacksPlanFreshAtWallClock(plan, stagingCurrentTime);
      await reverifyClutchpacksDataReleaseV3Database(
        opened,
        command.databaseIdentity,
      );
      const staged = await opened.stagePlan(plan);
      const stagedLedger = assertClutchpacksBackfill(staged, expectedIds);
      if (
        stagedLedger.staging?.staged !== true ||
        stagedLedger.staging.lifecycle !== "complete" ||
        stagedLedger.staging.activePointerMoved !== false
      ) {
        refuse("CLUTCHPACKS_V3_STAGING_DIVERGENT");
      }
      const stagedPlan = await opened.assembler.assemble({ readAt: command.readAt });
      assertPlanIdentity(plan, stagedPlan);
      assertClutchpacksPlanCompleteness(stagedPlan, scope);
      assertNoPositiveClutchpacksEv(stagedPlan, expectedIds);
      assertClutchpacksPlanFreshAtWallClock(stagedPlan, dependencies.now());
      const status = await opened.publication.status(plan.publicReleaseId);
      assertStatusMatchesPlan(status, plan);
      const activeAfter = await opened.publication.activeState();
      if (!sameActiveState(activeBefore, activeAfter)) {
        refuse("CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED");
      }
      const expectedActivePublicReleaseId =
        activeBefore.activeRelease?.publicReleaseId ?? null;
      const result = Object.freeze({
        schemaVersion: "packscout.clutchpacks-data-release-v3-result.v1",
        status: "staged",
        targetDigest: command.targetDigest,
        databaseIdentity: command.databaseIdentity,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        expectedRepackCount: CLUTCHPACKS_EXPECTED_REPACK_COUNT,
        acceptedRepackCount: status.acceptedCounts.repacks,
        canonicalEntityCounts: Object.freeze({
          ...scope.entityCounts,
          searchShards: plan.manifest.counts.searchShards,
        }),
        acceptedEntityCounts: Object.freeze({ ...status.acceptedCounts }),
        minimumRemainingLifetimeMilliseconds:
          CLUTCHPACKS_RELEASE_MIN_REMAINING_LIFETIME_MILLISECONDS,
        activePointerMoved: false,
        expectedActivePublicReleaseId,
        requiredActivationConfirmation:
          buildClutchpacksV3ActivationConfirmation({
            targetDigest: command.targetDigest,
            releaseFingerprint: plan.releaseFingerprint,
            expectedActivePublicReleaseId,
          }),
        classificationCounts: ledger.counts,
      });
      writeOutput(result);
      return result;
    }

    if (plan.releaseFingerprint !== command.expectedReleaseFingerprint) {
      refuse("CLUTCHPACKS_V3_RELEASE_MISMATCH");
    }
    const stagedStatus = await opened.publication.status(plan.publicReleaseId);
    assertStatusMatchesPlan(stagedStatus, plan);
    const activeBefore = await opened.publication.activeState();
    if (
      (activeBefore.activeRelease?.publicReleaseId ?? null) !==
        command.expectedActivePublicReleaseId
    ) {
      refuse("CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED");
    }
    assertNoPositiveClutchpacksEv(plan, expectedIds);
    const activationWatermark = await opened.loadSettledWatermark();
    const activationCurrentTime = dependencies.now();
    assertLatestClutchpacksSettledWatermark(activationWatermark, command);
    assertClutchpacksSettlementPublishableNow(
      activationWatermark,
      activationCurrentTime,
    );
    assertClutchpacksPlanFreshAtWallClock(plan, activationCurrentTime);
    await reverifyClutchpacksDataReleaseV3Database(
      opened,
      command.databaseIdentity,
    );
    let outcome;
    try {
      outcome = await opened.activate(
        plan,
        command.expectedActivePublicReleaseId,
      );
    } catch (activationError) {
      const recovery = await recoverUnverifiedActivation(
        opened,
        command,
        plan,
        activationError,
      );
      if (recovery === null) throw activationError;
      if (recovery.status === "rolled_back") {
        refuse("CLUTCHPACKS_V3_ACTIVATION_ROLLED_BACK", {
          cause: activationError,
        });
      }
      writeOutput(recovery);
      return recovery;
    }
    let readBack;
    try {
      const readBackCurrentTime = dependencies.now();
      assertClutchpacksPlanFreshAtWallClock(plan, readBackCurrentTime);
      readBack = await opened.readPublicRelease({
        plan,
        scope,
        expectedIds,
        currentTime: readBackCurrentTime,
        catalogReadToken: command.catalogReadToken,
      });
      assertClutchpacksPublicReadBack(readBack, plan, scope);
      // Network/readback time consumes the same release lifetime. Re-read the
      // wall clock so a slow but internally successful proof cannot report an
      // already-short-lived release as activated.
      assertClutchpacksPlanFreshAtWallClock(plan, dependencies.now());
    } catch (verificationError) {
      if (outcome.outcome !== "activated") throw verificationError;
      const recovery = await recoverUnverifiedActivation(
        opened,
        command,
        plan,
        verificationError,
      );
      if (recovery === null) throw verificationError;
      if (recovery.status === "rolled_back") {
        refuse("CLUTCHPACKS_V3_ACTIVATION_ROLLED_BACK", {
          cause: verificationError,
        });
      }
      writeOutput(recovery);
      return recovery;
    }
    const result = Object.freeze({
      schemaVersion: "packscout.clutchpacks-data-release-v3-result.v1",
      status: outcome.outcome === "unchanged" ? "already_active" : "activated",
      targetDigest: command.targetDigest,
      databaseIdentity: command.databaseIdentity,
      publicReleaseId: plan.publicReleaseId,
      releaseFingerprint: plan.releaseFingerprint,
      expectedRepackCount: CLUTCHPACKS_EXPECTED_REPACK_COUNT,
      publicReadBackCount: readBack.details.length,
      canonicalEntityCounts: Object.freeze({
        ...scope.entityCounts,
        searchShards: plan.manifest.counts.searchShards,
      }),
      acceptedEntityCounts: Object.freeze({ ...stagedStatus.acceptedCounts }),
      // Every successful public query is lifecycle-gated by the finalized
      // accepted counts and entity hashes. Bounded record probes then prove
      // the corresponding public category, collectible, and chase paths.
      publicEntityReadBackCounts: Object.freeze({
        ...stagedStatus.acceptedCounts,
      }),
      publicProbeCounts: Object.freeze({
        repackDetails: readBack.details.length,
        collectibleDirect: readBack.collectibleReads.length,
        collectibleSearch: readBack.collectibleSearches.length,
      }),
      minimumRemainingLifetimeMilliseconds:
        CLUTCHPACKS_RELEASE_MIN_REMAINING_LIFETIME_MILLISECONDS,
      classificationCounts: ledger.counts,
    });
    writeOutput(result);
    return result;
  } catch (error) {
    if (error instanceof ClutchpacksDataReleaseV3PromotionError) throw error;
    throw new ClutchpacksDataReleaseV3PromotionError(
      "CLUTCHPACKS_V3_EXECUTION_FAILED",
      { cause: error },
    );
  } finally {
    await opened?.close();
  }
}

export function createProductionDependencies() {
  return {
    now: () => Date.now(),
    async readDatabaseIdentity(command) {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: command.databaseUrl });
      try {
        await client.connect();
        return await readConnectedPostgresIdentity(
          async (sql) => (await client.query(sql)).rows,
          CLUTCHPACKS_CANARY_DATABASE_NAME,
        );
      } catch (error) {
        if (error instanceof ClutchpacksDataReleaseV3PromotionError) throw error;
        refuse("CLUTCHPACKS_V3_TARGET_INVALID", { cause: error });
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    async open(command) {
      const [database, services] = await Promise.all([
        import("../../packages/database/src/index.ts"),
        import("../../packages/services/src/index.ts"),
      ]);
      const lifecycle = database.createPrismaClientLifecycle({
        databaseUrl: command.databaseUrl,
      });
      await lifecycle.start();
      try {
        const source = new database.PrismaDataReleaseV3CanonicalCatalogSource(
          lifecycle.client,
          command.organizationId,
        );
        const catalog = new services.DataReleaseV3CanonicalCatalogAdapter(source);
        const repository = new database.BuybackEvRevisionRepository(
          lifecycle.client,
        );
        const store = new services.PackScoutBuybackEvRevisionStore(repository);
        const recomputation =
          new services.PackScoutBuybackAdjustedEvRecomputationService(store);
        const assembler = new services.DataReleaseV3ReleaseAssembler(
          catalog,
          recomputation,
        );
        const evidenceRepository =
          new database.PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
            lifecycle.client,
            command.organizationId,
          );
        const evidence =
          new services.ClutchpacksCanonicalV3BuybackEvEvidenceSourceV1({
            organizationId: command.organizationId,
            repository: evidenceRepository,
          });
        const settlement =
          new database.PrismaPublicChangeSettlementRepository(
            lifecycle.client,
          );
        const publication =
          new services.SignedConvexDataReleaseV3PublicationClient({
            baseUrl: command.publicationBaseUrl,
            keyId: command.keyId,
            secret: command.secret,
          });
        const runBackfill = (publicationPort) =>
          new services.PackScoutBuybackEvBackfillReconciliationRunnerV1({
            catalog,
            recomputation,
            assembler,
            evidence,
            ...(publicationPort ? { publication: publicationPort } : {}),
          }).run({ readAt: command.readAt });
        const publisher = new services.DataReleaseV3ReleasePublisher(publication);
        return {
          catalog,
          assembler,
          publication,
          readDatabaseIdentity: () =>
            readClutchpacksDataReleaseV3DatabaseIdentity(lifecycle.client),
          loadSettledWatermark: () =>
            settlement.getSettledWatermark(command.organizationId),
          runBackfill: () => runBackfill(null),
          stagePlan: (plan) => runBackfill(
            exactDataReleaseV3StagingPort(publication, plan),
          ),
          activate: (plan, expectedActivePublicReleaseId) =>
            new services.DataReleaseV3ReleasePublisher(
              operatorBoundDataReleaseV3ActivationPort(
                publication,
                plan,
                expectedActivePublicReleaseId,
              ),
            ).publish(plan),
          rollback: (input) => publisher.rollback(input),
          readPublicRelease: (input) => readPublicRelease(command, input),
          close: () => lifecycle.close(),
        };
      } catch (error) {
        await lifecycle.close();
        throw error;
      }
    },
  };
}

async function readPublicRelease(command, input) {
  const [{ ConvexHttpClient }, { api }] = await Promise.all([
    import("convex/browser"),
    import("../../convex/_generated/api.js"),
  ]);
  const client = new ConvexHttpClient(command.queryUrl);
  const withToken = (value) => command.catalogReadToken === null
    ? value
    : { ...value, catalogReadToken: command.catalogReadToken };
  const shell = await client.query(
    api.publicRepacksV3.getPublicShellStatusV3,
    withToken({}),
  );
  const list = await client.query(
    api.publicRepacksV3.listPublicRepacksV3,
    withToken({ pageSize: 50, currentTime: input.currentTime }),
  );
  const details = list?.ok === true
    ? await Promise.all(list.data.rows.map((row) => client.query(
      api.publicRepacksV3.getPublicRepackV3,
      withToken({
        publicRepackId: row.publicRepackId,
        publicReleaseId: input.plan.publicReleaseId,
        currentTime: input.currentTime,
      }),
    )))
    : [];
  const dashboard = await client.query(
    api.publicRepacksV3.getDashboardBundleV3,
    withToken({
      filters: { availability: "all" },
      currentTime: input.currentTime,
    }),
  );
  const probes = clutchpacksCollectibleReadbackProbes(input.scope);
  const collectibleReads = await Promise.all(
    probes.direct.map(async (collectible) => ({
      publicCollectibleId: collectible.publicCollectibleId,
      result: await client.query(
      api.publicRepacksV3.findRepacksByDesiredCollectibleV3,
      withToken({
        publicCollectibleId: collectible.publicCollectibleId,
        filters: { availability: "all" },
        sort: "match_confidence",
        direction: "desc",
        limit: 50,
        currentTime: input.currentTime,
      }),
      ),
    })),
  );
  const collectibleSearches = await Promise.all(
    probes.search.map(async (collectible) => ({
      publicCollectibleId: collectible.publicCollectibleId,
      search: collectible.normalizedName,
      result: await client.query(
        api.publicRepacksV3.searchPublicCollectiblesV3,
        withToken({ search: collectible.normalizedName, limit: 20 }),
      ),
    })),
  );
  return {
    shell,
    list,
    details,
    dashboard,
    collectibleReads,
    collectibleSearches,
  };
}

async function main() {
  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: process.argv.slice(2),
    environment: process.env,
  });
  if (result.status === "activated_but_unverified_recovery_required") {
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const safe = error instanceof ClutchpacksDataReleaseV3PromotionError
      ? error
      : new ClutchpacksDataReleaseV3PromotionError(
        "CLUTCHPACKS_V3_EXECUTION_FAILED",
      );
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
