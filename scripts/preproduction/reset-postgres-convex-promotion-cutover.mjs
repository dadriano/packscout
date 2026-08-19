#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const CONVEX_CATALOG_RESET_TABLES = Object.freeze([
  "dataReleaseState",
  "blockedDataReleaseManifests",
  "dataReleaseOperations",
  "dataReleaseBatches",
  "dataReleaseCollectibleReconciliation",
  "dataReleaseRepackReconciliation",
  "dataReleasePublications",
  "repackSearchShards",
  "repackChases",
  "collectibles",
  "repacks",
  "categories",
  "vendors",
  "dataReleases",
]);

export const CONVEX_HEAT_RESET_TABLES = Object.freeze([
  "repackHeatState",
  "repackHeatOperations",
  "repackHeatBatches",
  "repackHeatPublications",
  "repackHeatSnapshots",
  "repackHeatSignals",
  "repackHeatSignalSets",
]);

// This ordering clears public pointers before their referenced documents. The
// list is deliberately closed: callers cannot add a table through arguments or
// environment configuration.
export const CONVEX_RESET_TABLES = Object.freeze([
  CONVEX_CATALOG_RESET_TABLES[0],
  CONVEX_HEAT_RESET_TABLES[0],
  ...CONVEX_CATALOG_RESET_TABLES.slice(1, 7),
  ...CONVEX_HEAT_RESET_TABLES.slice(1),
  ...CONVEX_CATALOG_RESET_TABLES.slice(7),
]);

export const PRESERVED_CONVEX_TABLES = Object.freeze(["dataReleaseAuthNonces"]);

export const PROTECTED_POSTGRES_TABLES = Object.freeze([
  "canonical_entities",
  "canonical_relationships",
  "canonical_revisions",
  "public_change_causes",
  "public_change_catalog_impacts",
  "public_derivation_obligations",
  "settled_public_watermarks",
  "provider_catalog_checkpoints",
  "catalog_manifest_lifecycle_checkpoints",
  "approved_public_catalog_configurations",
  "public_repack_identity_mappings",
  "normalized_heat_window_checkpoints",
  "normalized_heat_observations",
  "normalized_heat_observation_outcomes",
]);

const REQUIRED_POSTGRES_TABLES = Object.freeze([
  "organizations",
  "promotion_operations",
  "promotion_attempts",
  "promotion_lanes",
  ...PROTECTED_POSTGRES_TABLES,
]);

export const POSTGRES_DELETE_STEPS = Object.freeze([
  Object.freeze({
    name: "promotion_operations",
    sql: `/* cutover:delete:promotion_operations */
      DELETE FROM public.promotion_operations AS operation
      USING public.promotion_attempts AS attempt
      WHERE operation.attempt_id = attempt.id
        AND operation.organization_id = attempt.organization_id
        AND operation.deployment_key = attempt.deployment_key
        AND operation.lane_key = attempt.lane_key
        AND operation.organization_id = $1::uuid
        AND operation.deployment_key = $2
        AND operation.lane_key = ANY($3::text[])
        AND attempt.organization_id = $1::uuid
        AND attempt.deployment_key = $2
        AND attempt.lane_key = ANY($3::text[])`,
  }),
  Object.freeze({
    name: "promotion_attempts",
    sql: `/* cutover:delete:promotion_attempts */
      DELETE FROM public.promotion_attempts
      WHERE organization_id = $1::uuid
        AND deployment_key = $2
        AND lane_key = ANY($3::text[])`,
  }),
  Object.freeze({
    name: "promotion_lanes",
    sql: `/* cutover:delete:promotion_lanes */
      DELETE FROM public.promotion_lanes
      WHERE organization_id = $1::uuid
        AND deployment_key = $2
        AND lane_key = ANY($3::text[])`,
  }),
]);

const TARGET_LANES = Object.freeze(["catalog", "heat"]);
const ACTIVE_ATTEMPT_STATES = Object.freeze([
  "assembling",
  "ready",
  "in_progress",
  "retry_wait",
]);
const CONFIRMATION_PREFIX = "RESET PREPRODUCTION";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const APPROVAL_PATTERN = /^[A-Z][A-Z0-9_-]{2,63}$/u;
const CONVEX_PREPRODUCTION_SELECTOR_PATTERN =
  /^(?:(?:[a-z0-9][a-z0-9-]{0,62}):){0,2}preproduction$/u;
const PRODUCTION_TOKEN_PATTERN =
  /(?:^|[./:_-])(?:prod|production|live)(?=$|[./:_-])/iu;

const ERROR_MESSAGES = Object.freeze({
  CUTOVER_ARGUMENT_INVALID: "Cutover arguments are invalid.",
  CUTOVER_ENVIRONMENT_FORBIDDEN:
    "The cutover is restricted to an attested preproduction environment.",
  CUTOVER_TARGET_INVALID: "The preproduction cutover target is invalid.",
  CUTOVER_TARGET_DIGEST_MISMATCH:
    "The approved database target digest does not match the configured target.",
  CUTOVER_APPROVAL_INVALID: "The cutover approval reference is invalid.",
  CUTOVER_CONFIRMATION_REQUIRED:
    "The target-bound cutover confirmation is required for execution.",
  CUTOVER_WORKER_ATTESTATION_REQUIRED:
    "Stopped-worker attestation is required for the cutover.",
  CUTOVER_DATABASE_UNAVAILABLE:
    "The preproduction database could not be inspected safely.",
  CUTOVER_DATABASE_SCHEMA_INVALID:
    "The preproduction database does not have the required cutover schema.",
  CUTOVER_TARGET_BINDING_NOT_FOUND:
    "The approved organization and deployment binding was not found.",
  CUTOVER_LIVE_WORK_PRESENT:
    "Live or ambiguously delivered promotion work prevents the cutover.",
  CUTOVER_PROTECTED_STATE_CHANGED:
    "Protected PostgreSQL state changed during the cutover.",
  CUTOVER_DATABASE_RESET_FAILED:
    "The PostgreSQL promotion reset transaction did not commit.",
  CUTOVER_CONVEX_BACKUP_FAILED:
    "The Convex backup was not durably verified; no cleanup may proceed.",
  CUTOVER_CONVEX_RESET_FAILED:
    "An allowlisted Convex cleanup command did not complete.",
  CUTOVER_EVIDENCE_WRITE_FAILED:
    "Durable cutover evidence could not be written.",
  CUTOVER_ARTIFACT_PREPARATION_FAILED:
    "Cutover artifacts could not be prepared safely.",
  CUTOVER_RECOVERY_REQUIRED:
    "The staged cutover requires operator-directed recovery from durable evidence.",
  CUTOVER_INTERNAL_FAILURE: "The cutover failed safely.",
});

export class CutoverResetError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.CUTOVER_INTERNAL_FAILURE);
    this.name = "CutoverResetError";
    this.code = ERROR_MESSAGES[code] ? code : "CUTOVER_INTERNAL_FAILURE";
  }
}

function cutoverError(error, fallbackCode) {
  return error instanceof CutoverResetError
    ? error
    : new CutoverResetError(fallbackCode);
}

function requireEnvironmentValue(environment, name, errorCode) {
  const value = environment[name]?.trim();
  if (!value) throw new CutoverResetError(errorCode);
  return value;
}

function sha256(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function equalDigest(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function containsProductionToken(value) {
  return PRODUCTION_TOKEN_PATTERN.test(value);
}

function assertPreproductionRuntime(environment) {
  const cutoverEnvironment = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_ENVIRONMENT",
    "CUTOVER_ENVIRONMENT_FORBIDDEN",
  );
  const databaseEnvironment = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_DATABASE_ENVIRONMENT",
    "CUTOVER_ENVIRONMENT_FORBIDDEN",
  );
  if (
    cutoverEnvironment !== "preproduction" ||
    databaseEnvironment !== "preproduction"
  ) {
    throw new CutoverResetError("CUTOVER_ENVIRONMENT_FORBIDDEN");
  }

  for (const name of [
    "NODE_ENV",
    "VERCEL_ENV",
    "PACKSCOUT_RUNTIME_ENVIRONMENT",
    "APP_ENV",
    "ENVIRONMENT",
  ]) {
    const value = environment[name]?.trim();
    if (value && containsProductionToken(value)) {
      throw new CutoverResetError("CUTOVER_ENVIRONMENT_FORBIDDEN");
    }
  }

  for (const name of [
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
  ]) {
    if (environment[name]?.trim()) {
      throw new CutoverResetError("CUTOVER_TARGET_INVALID");
    }
  }

  const implicitConvexDeployment = environment.CONVEX_DEPLOYMENT?.trim();
  if (
    implicitConvexDeployment &&
    containsProductionToken(implicitConvexDeployment)
  ) {
    throw new CutoverResetError("CUTOVER_ENVIRONMENT_FORBIDDEN");
  }
}

function parseDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    parsed.pathname.length <= 1 ||
    parsed.hash
  ) {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }

  let databaseName;
  let databaseUser;
  let redactedTarget;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
    databaseUser = decodeURIComponent(parsed.username);
    const targetUrl = new URL(parsed.href);
    targetUrl.password = "";
    redactedTarget = decodeURIComponent(targetUrl.href);
  } catch {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !databaseUser ||
    [parsed.hostname, databaseName, databaseUser, redactedTarget].some(
      containsProductionToken,
    )
  ) {
    throw new CutoverResetError("CUTOVER_ENVIRONMENT_FORBIDDEN");
  }
  return Object.freeze({ parsed, databaseName, databaseUser });
}

export function computeDatabaseTargetDigest(databaseUrl) {
  const { parsed } = parseDatabaseUrl(databaseUrl);
  const target = new URL(parsed.href);
  target.password = "";
  target.hash = "";
  target.hostname = target.hostname.toLowerCase();
  return sha256("packscout-cutover-database-v1", target.href);
}

export function computeTargetScopeDigest({
  organizationId,
  deploymentKey,
  convexDeployment,
  databaseTargetDigest,
}) {
  return sha256(
    "packscout-provider-manifest-cutover-v1",
    organizationId.toLowerCase(),
    deploymentKey,
    convexDeployment,
    databaseTargetDigest,
  );
}

export function requiredConfirmation(targetScopeDigest) {
  if (!SHA256_PATTERN.test(targetScopeDigest)) {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }
  return `${CONFIRMATION_PREFIX} ${targetScopeDigest.slice(0, 16)}`;
}

function parseExecutionMode(argv) {
  let mode = "dry-run";
  let explicitMode = false;
  for (const argument of argv) {
    if (argument !== "--execute" && argument !== "--dry-run") {
      throw new CutoverResetError("CUTOVER_ARGUMENT_INVALID");
    }
    if (explicitMode) {
      throw new CutoverResetError("CUTOVER_ARGUMENT_INVALID");
    }
    explicitMode = true;
    mode = argument === "--execute" ? "execute" : "dry-run";
  }
  return mode;
}

function requireAbsolutePath(environment, name) {
  const value = requireEnvironmentValue(
    environment,
    name,
    "CUTOVER_TARGET_INVALID",
  );
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }
  return path.normalize(value);
}

export function parseCutoverConfiguration({
  argv = process.argv.slice(2),
  environment = process.env,
} = {}) {
  const mode = parseExecutionMode(argv);
  assertPreproductionRuntime(environment);

  const organizationId = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_ORGANIZATION_ID",
    "CUTOVER_TARGET_INVALID",
  );
  const deploymentKey = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_DEPLOYMENT_KEY",
    "CUTOVER_TARGET_INVALID",
  );
  const convexDeployment = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_CONVEX_DEPLOYMENT",
    "CUTOVER_TARGET_INVALID",
  );
  if (
    !UUID_PATTERN.test(organizationId) ||
    !DEPLOYMENT_KEY_PATTERN.test(deploymentKey) ||
    containsProductionToken(deploymentKey) ||
    !CONVEX_PREPRODUCTION_SELECTOR_PATTERN.test(convexDeployment)
  ) {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }

  const approvalReference = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_APPROVAL_REFERENCE",
    "CUTOVER_APPROVAL_INVALID",
  );
  if (!APPROVAL_PATTERN.test(approvalReference)) {
    throw new CutoverResetError("CUTOVER_APPROVAL_INVALID");
  }
  if (environment.PACKSCOUT_CUTOVER_WORKERS_STOPPED?.trim() !== "YES") {
    throw new CutoverResetError("CUTOVER_WORKER_ATTESTATION_REQUIRED");
  }

  const databaseUrl = requireEnvironmentValue(
    environment,
    "PACKSCOUT_DATABASE_URL",
    "CUTOVER_TARGET_INVALID",
  );
  const databaseIdentity = parseDatabaseUrl(databaseUrl);
  const databaseTargetDigest = computeDatabaseTargetDigest(databaseUrl);
  const approvedDatabaseTargetDigest = requireEnvironmentValue(
    environment,
    "PACKSCOUT_CUTOVER_DATABASE_TARGET_SHA256",
    "CUTOVER_TARGET_DIGEST_MISMATCH",
  );
  if (!equalDigest(databaseTargetDigest, approvedDatabaseTargetDigest)) {
    throw new CutoverResetError("CUTOVER_TARGET_DIGEST_MISMATCH");
  }

  const targetScopeDigest = computeTargetScopeDigest({
    organizationId,
    deploymentKey,
    convexDeployment,
    databaseTargetDigest,
  });
  const confirmation = requiredConfirmation(targetScopeDigest);
  if (
    mode === "execute" &&
    environment.PACKSCOUT_CUTOVER_CONFIRMATION !== confirmation
  ) {
    throw new CutoverResetError("CUTOVER_CONFIRMATION_REQUIRED");
  }

  const evidenceFile = requireAbsolutePath(
    environment,
    "PACKSCOUT_CUTOVER_EVIDENCE_FILE",
  );
  const backupDirectory = requireAbsolutePath(
    environment,
    "PACKSCOUT_CUTOVER_BACKUP_DIRECTORY",
  );
  if (evidenceFile === backupDirectory) {
    throw new CutoverResetError("CUTOVER_TARGET_INVALID");
  }

  return Object.freeze({
    dryRun: mode === "dry-run",
    organizationId: organizationId.toLowerCase(),
    deploymentKey,
    convexDeployment,
    approvalReferenceDigest: sha256(
      "packscout-cutover-approval-v1",
      approvalReference,
    ),
    databaseUrl,
    databaseName: databaseIdentity.databaseName,
    databaseUser: databaseIdentity.databaseUser,
    databaseTargetDigest,
    targetScopeDigest,
    confirmation,
    evidenceFile,
    backupDirectory,
  });
}

function normalizeCount(value, errorCode = "CUTOVER_DATABASE_UNAVAILABLE") {
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new CutoverResetError(errorCode);
  }
  return normalized;
}

function compareDecimal(left, operator, right) {
  const leftValue = BigInt(normalizeCount(left));
  const rightValue = BigInt(normalizeCount(right));
  if (operator === ">") return leftValue > rightValue;
  return leftValue === rightValue;
}

function protectedTableDigest(table, rowCount, contentMd5) {
  if (!PROTECTED_POSTGRES_TABLES.includes(table)) {
    throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
  }
  const normalizedCount = normalizeCount(rowCount);
  if (!/^[0-9a-f]{32}$/u.test(contentMd5)) {
    throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
  }
  return sha256(
    "packscout-protected-postgres-table-v1",
    table,
    normalizedCount,
    contentMd5,
  );
}

export function buildProtectedSnapshot(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length !== PROTECTED_POSTGRES_TABLES.length
  ) {
    throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
  }
  const byTable = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      !PROTECTED_POSTGRES_TABLES.includes(entry.table) ||
      byTable.has(entry.table)
    ) {
      throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
    }
    const rowCount = normalizeCount(entry.rowCount);
    if (!SHA256_PATTERN.test(entry.digest)) {
      throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
    }
    byTable.set(
      entry.table,
      Object.freeze({
        table: entry.table,
        rowCount,
        digest: entry.digest,
      }),
    );
  }
  const tables = Object.freeze(
    PROTECTED_POSTGRES_TABLES.map((table) => {
      const entry = byTable.get(table);
      if (!entry) throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
      return entry;
    }),
  );
  const combinedDigest = sha256(
    "packscout-protected-postgres-snapshot-v1",
    ...tables.flatMap(({ table, rowCount, digest }) => [
      table,
      rowCount,
      digest,
    ]),
  );
  return Object.freeze({
    tableCount: tables.length,
    combinedDigest,
    tables,
  });
}

function sanitizeProtectedSnapshot(snapshot) {
  return buildProtectedSnapshot(snapshot?.tables ?? []);
}

function snapshotsEqual(left, right) {
  return (
    left.combinedDigest === right.combinedDigest &&
    left.tableCount === right.tableCount &&
    left.tables.every((entry, index) => {
      const other = right.tables[index];
      return (
        entry.table === other.table &&
        entry.rowCount === other.rowCount &&
        entry.digest === other.digest
      );
    })
  );
}

function sanitizeSafetyResult(result) {
  return Object.freeze({
    organizationFound: result?.organizationFound === true,
    targetLaneCount: normalizeCount(result?.targetLaneCount),
    targetAttemptCount: normalizeCount(result?.targetAttemptCount),
    targetOperationCount: normalizeCount(result?.targetOperationCount),
    liveClaimCount: normalizeCount(result?.liveClaimCount),
    sentOperationCount: normalizeCount(result?.sentOperationCount),
  });
}

function assertSafeForReset(safety) {
  if (
    !safety.organizationFound ||
    !compareDecimal(
      safety.targetLaneCount,
      "=",
      String(TARGET_LANES.length),
    )
  ) {
    throw new CutoverResetError("CUTOVER_TARGET_BINDING_NOT_FOUND");
  }
  if (
    compareDecimal(safety.liveClaimCount, ">", "0") ||
    compareDecimal(safety.sentOperationCount, ">", "0")
  ) {
    throw new CutoverResetError("CUTOVER_LIVE_WORK_PRESENT");
  }
}

async function queryProtectedSnapshot(client, organizationId) {
  const entries = [];
  for (const table of PROTECTED_POSTGRES_TABLES) {
    // The table interpolation is safe because it comes only from the frozen
    // source allowlist above. Row data never leaves PostgreSQL: only a count
    // and an aggregate of per-row hashes are returned.
    const result = await client.query(
      `/* cutover:protected:${table} */
       SELECT count(*)::text AS row_count,
              md5(coalesce(string_agg(row_md5, '' ORDER BY row_md5), ''))
                AS content_md5
       FROM (
         SELECT md5(to_jsonb(protected_row)::text) AS row_md5
         FROM public.${table} AS protected_row
         WHERE organization_id = $1::uuid
       ) AS protected_hashes`,
      [organizationId],
    );
    const row = result.rows?.[0];
    entries.push({
      table,
      rowCount: row?.row_count,
      digest: protectedTableDigest(table, row?.row_count, row?.content_md5),
    });
  }
  return buildProtectedSnapshot(entries);
}

async function querySafety(client, scope) {
  const result = await client.query(
    `/* cutover:safety */
     SELECT
       EXISTS (
         SELECT 1 FROM public.organizations
         WHERE id = $1::uuid
       ) AS organization_found,
       (
         SELECT count(*)::text FROM public.promotion_lanes
         WHERE organization_id = $1::uuid
           AND deployment_key = $2
           AND lane_key = ANY($3::text[])
       ) AS target_lane_count,
       (
         SELECT count(*)::text FROM public.promotion_attempts
         WHERE organization_id = $1::uuid
           AND deployment_key = $2
           AND lane_key = ANY($3::text[])
       ) AS target_attempt_count,
       (
         SELECT count(*)::text FROM public.promotion_operations
         WHERE organization_id = $1::uuid
           AND deployment_key = $2
           AND lane_key = ANY($3::text[])
       ) AS target_operation_count,
       (
         SELECT count(*)::text FROM public.promotion_attempts
         WHERE organization_id = $1::uuid
           AND deployment_key = $2
           AND lane_key = ANY($3::text[])
           AND state = ANY($4::text[])
           AND claim_expires_at > transaction_timestamp()
       ) AS live_claim_count,
       (
         SELECT count(*)::text FROM public.promotion_operations
         WHERE organization_id = $1::uuid
           AND deployment_key = $2
           AND lane_key = ANY($3::text[])
           AND state = 'sent'
       ) AS sent_operation_count`,
    [
      scope.organizationId,
      scope.deploymentKey,
      TARGET_LANES,
      ACTIVE_ATTEMPT_STATES,
    ],
  );
  const row = result.rows?.[0];
  return sanitizeSafetyResult({
    organizationFound: row?.organization_found === true,
    targetLaneCount: row?.target_lane_count,
    targetAttemptCount: row?.target_attempt_count,
    targetOperationCount: row?.target_operation_count,
    liveClaimCount: row?.live_claim_count,
    sentOperationCount: row?.sent_operation_count,
  });
}

function protectedLockSql() {
  const tables = PROTECTED_POSTGRES_TABLES.map(
    (table) => `public.${table}`,
  ).join(", ");
  return `/* cutover:lock:protected */ LOCK TABLE ${tables} IN SHARE MODE`;
}

export function createPostgresCutoverDatabaseFromPool(pool, expectedIdentity) {
  async function connect() {
    try {
      return await pool.connect();
    } catch {
      throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
    }
  }

  async function validateSchemaAndIdentity(client) {
    const identityResult = await client.query(
      `/* cutover:database-identity */
       SELECT current_database() AS database_name,
              current_user AS database_user`,
    );
    const identity = identityResult.rows?.[0];
    if (
      identity?.database_name !== expectedIdentity.databaseName ||
      identity?.database_user !== expectedIdentity.databaseUser
    ) {
      throw new CutoverResetError("CUTOVER_TARGET_INVALID");
    }

    const schemaResult = await client.query(
      `/* cutover:required-schema */
       SELECT required.table_name
       FROM unnest($1::text[]) AS required(table_name)
       LEFT JOIN information_schema.tables AS present
         ON present.table_schema = 'public'
        AND present.table_name = required.table_name
       WHERE present.table_name IS NULL`,
      [REQUIRED_POSTGRES_TABLES],
    );
    if ((schemaResult.rows?.length ?? 0) !== 0) {
      throw new CutoverResetError("CUTOVER_DATABASE_SCHEMA_INVALID");
    }
  }

  return Object.freeze({
    async preflight(scope) {
      const client = await connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionStarted = true;
        await client.query("SET LOCAL statement_timeout = '30min'");
        await validateSchemaAndIdentity(client);
        const safety = await querySafety(client, scope);
        assertSafeForReset(safety);
        const protectedSnapshot = await queryProtectedSnapshot(
          client,
          scope.organizationId,
        );
        await client.query("COMMIT");
        transactionStarted = false;
        return Object.freeze({ safety, protectedSnapshot });
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The stable preflight error remains the actionable outcome.
          }
        }
        throw cutoverError(error, "CUTOVER_DATABASE_UNAVAILABLE");
      } finally {
        client.release();
      }
    },

    async reset(scope, expectedPreflight) {
      const expectedSafety = sanitizeSafetyResult(expectedPreflight?.safety);
      const expectedSnapshot = sanitizeProtectedSnapshot(
        expectedPreflight?.protectedSnapshot,
      );
      const client = await connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
        transactionStarted = true;
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '30min'");
        await client.query(
          `/* cutover:lock:promotion */
           LOCK TABLE public.promotion_lanes,
                      public.promotion_attempts,
                      public.promotion_operations
           IN SHARE ROW EXCLUSIVE MODE`,
        );
        await client.query(protectedLockSql());

        const safety = await querySafety(client, scope);
        assertSafeForReset(safety);
        if (
          safety.targetLaneCount !== expectedSafety.targetLaneCount ||
          safety.targetAttemptCount !== expectedSafety.targetAttemptCount ||
          safety.targetOperationCount !== expectedSafety.targetOperationCount ||
          safety.organizationFound !== expectedSafety.organizationFound
        ) {
          throw new CutoverResetError("CUTOVER_PROTECTED_STATE_CHANGED");
        }
        const before = await queryProtectedSnapshot(
          client,
          scope.organizationId,
        );
        if (!snapshotsEqual(before, expectedSnapshot)) {
          throw new CutoverResetError("CUTOVER_PROTECTED_STATE_CHANGED");
        }

        const deleted = {};
        const parameters = [
          scope.organizationId,
          scope.deploymentKey,
          TARGET_LANES,
        ];
        for (const step of POSTGRES_DELETE_STEPS) {
          const result = await client.query(step.sql, parameters);
          deleted[step.name] = normalizeCount(
            result.rowCount ?? 0,
            "CUTOVER_DATABASE_RESET_FAILED",
          );
        }

        const residual = await querySafety(client, scope);
        if (
          !residual.organizationFound ||
          compareDecimal(residual.targetLaneCount, ">", "0") ||
          compareDecimal(residual.targetAttemptCount, ">", "0") ||
          compareDecimal(residual.targetOperationCount, ">", "0") ||
          compareDecimal(residual.liveClaimCount, ">", "0") ||
          compareDecimal(residual.sentOperationCount, ">", "0") ||
          deleted.promotion_lanes !== expectedSafety.targetLaneCount ||
          deleted.promotion_attempts !== expectedSafety.targetAttemptCount ||
          deleted.promotion_operations !== expectedSafety.targetOperationCount
        ) {
          throw new CutoverResetError("CUTOVER_DATABASE_RESET_FAILED");
        }

        const after = await queryProtectedSnapshot(
          client,
          scope.organizationId,
        );
        if (!snapshotsEqual(before, after)) {
          throw new CutoverResetError("CUTOVER_PROTECTED_STATE_CHANGED");
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return Object.freeze({
          deleted: Object.freeze(deleted),
          protectedSnapshot: after,
        });
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The caller receives a stable reset failure either way.
          }
        }
        throw cutoverError(error, "CUTOVER_DATABASE_RESET_FAILED");
      } finally {
        client.release();
      }
    },

    async close() {
      try {
        await pool.end();
      } catch {
        throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
      }
    },
  });
}

export async function createPostgresCutoverDatabase(config) {
  let Pool;
  try {
    ({ Pool } = await import("pg"));
  } catch {
    throw new CutoverResetError("CUTOVER_DATABASE_UNAVAILABLE");
  }
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: "packscout_preproduction_cutover",
  });
  return createPostgresCutoverDatabaseFromPool(pool, {
    databaseName: config.databaseName,
    databaseUser: config.databaseUser,
  });
}

export function buildConvexCommandEnvironment(environment = process.env) {
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "CI",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ]);
  const childEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      (allowedNames.has(name) || name.startsWith("LC_")) &&
      value !== undefined
    ) {
      childEnvironment[name] = value;
    }
  }
  childEnvironment.FORCE_COLOR = "0";
  childEnvironment.NO_COLOR = "1";
  return Object.freeze(childEnvironment);
}

export function createCommandRunner({
  cwd = repositoryRoot,
  environment = process.env,
  timeoutMilliseconds = 30 * 60 * 1000,
} = {}) {
  return Object.freeze({
    run(command, args) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          detached: process.platform !== "win32",
          env: buildConvexCommandEnvironment(environment),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.resume();
        child.stderr?.resume();
        let settled = false;
        let aborting = false;
        let forceTimer = null;
        let finishTimer = null;
        const signalChildGroup = (signal) => {
          try {
            if (
              process.platform !== "win32" &&
              Number.isSafeInteger(child.pid) &&
              child.pid > 0
            ) {
              process.kill(-child.pid, signal);
            } else {
              child.kill(signal);
            }
          } catch {
            // The group may have exited between the liveness check and signal.
          }
        };
        const onInterrupt = () => beginAbort();
        const cleanup = () => {
          clearTimeout(timeoutTimer);
          if (forceTimer !== null) clearTimeout(forceTimer);
          if (finishTimer !== null) clearTimeout(finishTimer);
          process.removeListener("SIGINT", onInterrupt);
          process.removeListener("SIGTERM", onInterrupt);
        };
        const finish = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const beginAbort = () => {
          if (settled || aborting) return;
          aborting = true;
          signalChildGroup("SIGTERM");
          forceTimer = setTimeout(() => {
            signalChildGroup("SIGKILL");
            finishTimer = setTimeout(
              () => finish(new Error("command failed")),
              1_000,
            );
          }, 5_000);
        };
        const timeoutTimer = setTimeout(beginAbort, timeoutMilliseconds);
        timeoutTimer.unref();
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onInterrupt);
        child.once("error", () => {
          if (!aborting) finish(new Error("command failed"));
        });
        child.once("exit", (code) => {
          if (aborting) return;
          if (code === 0) finish();
          else finish(new Error("command failed"));
        });
      });
    },
  });
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function syncFileAndDirectory(filePath) {
  const fileHandle = await open(filePath, "r");
  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  const directoryHandle = await open(path.dirname(filePath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export function createArtifactManager({ clock = () => new Date() } = {}) {
  return Object.freeze({
    async prepare(backupDirectory) {
      try {
        await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
        const directoryStat = await stat(backupDirectory);
        if (
          !directoryStat.isDirectory() ||
          (directoryStat.mode & 0o077) !== 0
        ) {
          throw new Error("not a directory");
        }
        const temporaryDirectory = await mkdtemp(
          path.join(os.tmpdir(), "packscout-preproduction-cutover-"),
        );
        const emptyFile = path.join(temporaryDirectory, "empty.json");
        await writeFile(emptyFile, "[]\n", { encoding: "utf8", mode: 0o600 });
        const timestamp = clock()
          .toISOString()
          .replaceAll(/[^0-9]/gu, "");
        const backupFile = path.join(
          backupDirectory,
          `convex-before-cutover-${timestamp}-${randomUUID()}.zip`,
        );
        return Object.freeze({ temporaryDirectory, emptyFile, backupFile });
      } catch {
        throw new CutoverResetError("CUTOVER_ARTIFACT_PREPARATION_FAILED");
      }
    },

    async verifyBackup(artifacts) {
      try {
        const backupStat = await stat(artifacts.backupFile);
        if (!backupStat.isFile() || backupStat.size <= 0) {
          throw new Error("empty backup");
        }
        await chmod(artifacts.backupFile, 0o600);
        await syncFileAndDirectory(artifacts.backupFile);
        return Object.freeze({
          byteLength: normalizeCount(backupStat.size),
          sha256: await hashFile(artifacts.backupFile),
        });
      } catch {
        throw new CutoverResetError("CUTOVER_CONVEX_BACKUP_FAILED");
      }
    },

    async cleanup(artifacts) {
      if (!artifacts?.temporaryDirectory) return;
      await rm(artifacts.temporaryDirectory, { recursive: true, force: true });
    },
  });
}

export function createEvidenceWriter(evidenceFile) {
  return Object.freeze({
    async append(record) {
      try {
        await mkdir(path.dirname(evidenceFile), {
          recursive: true,
          mode: 0o700,
        });
        const handle = await open(evidenceFile, "a", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const directoryHandle = await open(path.dirname(evidenceFile), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch {
        throw new CutoverResetError("CUTOVER_EVIDENCE_WRITE_FAILED");
      }
    },
  });
}

function convexExportArguments(artifacts, config) {
  return [
    "--no-install",
    "convex",
    "export",
    "--path",
    artifacts.backupFile,
    "--deployment",
    config.convexDeployment,
  ];
}

function convexClearArguments(table, artifacts, config) {
  if (!CONVEX_RESET_TABLES.includes(table)) {
    throw new CutoverResetError("CUTOVER_CONVEX_RESET_FAILED");
  }
  return [
    "--no-install",
    "convex",
    "import",
    artifacts.emptyFile,
    "--table",
    table,
    "--replace",
    "--yes",
    "--deployment",
    config.convexDeployment,
  ];
}

function sanitizeBackupProof(proof) {
  const byteLength = normalizeCount(
    proof?.byteLength,
    "CUTOVER_CONVEX_BACKUP_FAILED",
  );
  if (!SHA256_PATTERN.test(proof?.sha256 ?? "")) {
    throw new CutoverResetError("CUTOVER_CONVEX_BACKUP_FAILED");
  }
  return Object.freeze({ byteLength, sha256: proof.sha256 });
}

function sanitizeDeletedCounts(deleted) {
  const result = {};
  for (const { name } of POSTGRES_DELETE_STEPS) {
    result[name] = normalizeCount(
      deleted?.[name],
      "CUTOVER_DATABASE_RESET_FAILED",
    );
  }
  return Object.freeze(result);
}

function publicProtectedProof(snapshot) {
  return Object.freeze({
    tableCount: snapshot.tableCount,
    combinedDigest: snapshot.combinedDigest,
    tables: snapshot.tables,
  });
}

async function appendEvidence(evidence, clock, base, stage, details = {}) {
  const time = clock();
  if (!(time instanceof Date) || Number.isNaN(time.valueOf())) {
    throw new CutoverResetError("CUTOVER_EVIDENCE_WRITE_FAILED");
  }
  try {
    await evidence.append(
      Object.freeze({
        schemaVersion: 1,
        recordedAt: time.toISOString(),
        targetScopeDigest: base.targetScopeDigest,
        approvalReferenceDigest: base.approvalReferenceDigest,
        dryRun: base.dryRun,
        stage,
        ...details,
      }),
    );
  } catch {
    throw new CutoverResetError("CUTOVER_EVIDENCE_WRITE_FAILED");
  }
}

export async function runCutoverReset(config, suppliedDependencies = {}) {
  const clock = suppliedDependencies.clock ?? (() => new Date());
  const commands = suppliedDependencies.commands ?? createCommandRunner();
  const evidence =
    suppliedDependencies.evidence ?? createEvidenceWriter(config.evidenceFile);
  const artifactsManager =
    suppliedDependencies.artifacts ?? createArtifactManager({ clock });
  const database =
    suppliedDependencies.database ??
    (await createPostgresCutoverDatabase(config));
  const scope = Object.freeze({
    organizationId: config.organizationId,
    deploymentKey: config.deploymentKey,
  });
  const evidenceBase = Object.freeze({
    targetScopeDigest: config.targetScopeDigest,
    approvalReferenceDigest: config.approvalReferenceDigest,
    dryRun: config.dryRun === true,
  });

  let artifacts = null;
  let backupProof = null;
  let destructiveStageStarted = false;
  let postgresResetStarted = false;
  const clearedTables = [];
  try {
    await appendEvidence(evidence, clock, evidenceBase, "validated", {
      convexResetTableCount: CONVEX_RESET_TABLES.length,
      preservedConvexTables: PRESERVED_CONVEX_TABLES,
      postgresResetTables: POSTGRES_DELETE_STEPS.map(({ name }) => name),
    });

    let preflight;
    try {
      preflight = await database.preflight(scope);
    } catch (error) {
      throw cutoverError(error, "CUTOVER_DATABASE_UNAVAILABLE");
    }
    const safety = sanitizeSafetyResult(preflight?.safety);
    assertSafeForReset(safety);
    const protectedSnapshot = sanitizeProtectedSnapshot(
      preflight?.protectedSnapshot,
    );
    const sanitizedPreflight = Object.freeze({ safety, protectedSnapshot });
    await appendEvidence(evidence, clock, evidenceBase, "preflight_complete", {
      safety,
      protectedState: publicProtectedProof(protectedSnapshot),
    });

    if (config.dryRun === true) {
      await appendEvidence(evidence, clock, evidenceBase, "dry_run_complete", {
        requiredConfirmation: requiredConfirmation(config.targetScopeDigest),
        convexCatalogTableCount: CONVEX_CATALOG_RESET_TABLES.length,
        convexHeatTableCount: CONVEX_HEAT_RESET_TABLES.length,
      });
      return Object.freeze({
        ok: true,
        dryRun: true,
        stage: "dry_run_complete",
        targetScopeDigest: config.targetScopeDigest,
        requiredConfirmation: requiredConfirmation(config.targetScopeDigest),
        convexResetTableCount: CONVEX_RESET_TABLES.length,
        protectedTableCount: protectedSnapshot.tableCount,
        protectedStateDigest: protectedSnapshot.combinedDigest,
      });
    }

    artifacts = await artifactsManager.prepare(config.backupDirectory);
    await appendEvidence(evidence, clock, evidenceBase, "backup_started");
    try {
      await commands.run("npx", convexExportArguments(artifacts, config));
      backupProof = sanitizeBackupProof(
        await artifactsManager.verifyBackup(artifacts),
      );
    } catch (error) {
      throw cutoverError(error, "CUTOVER_CONVEX_BACKUP_FAILED");
    }
    await appendEvidence(evidence, clock, evidenceBase, "backup_complete", {
      backup: backupProof,
    });

    for (const table of CONVEX_RESET_TABLES) {
      await appendEvidence(
        evidence,
        clock,
        evidenceBase,
        "convex_clear_started",
        {
          table,
        },
      );
      destructiveStageStarted = true;
      try {
        await commands.run(
          "npx",
          convexClearArguments(table, artifacts, config),
        );
      } catch {
        throw new CutoverResetError("CUTOVER_CONVEX_RESET_FAILED");
      }
      clearedTables.push(table);
      await appendEvidence(
        evidence,
        clock,
        evidenceBase,
        "convex_table_cleared",
        {
          table,
          clearedTableCount: clearedTables.length,
        },
      );
    }

    await appendEvidence(
      evidence,
      clock,
      evidenceBase,
      "postgres_reset_started",
      {
        clearedTableCount: clearedTables.length,
      },
    );
    postgresResetStarted = true;
    let resetResult;
    try {
      resetResult = await database.reset(scope, sanitizedPreflight);
    } catch (error) {
      throw cutoverError(error, "CUTOVER_DATABASE_RESET_FAILED");
    }
    const deleted = sanitizeDeletedCounts(resetResult?.deleted);
    const protectedAfter = sanitizeProtectedSnapshot(
      resetResult?.protectedSnapshot,
    );
    if (!snapshotsEqual(protectedSnapshot, protectedAfter)) {
      throw new CutoverResetError("CUTOVER_PROTECTED_STATE_CHANGED");
    }

    await appendEvidence(evidence, clock, evidenceBase, "complete", {
      backup: backupProof,
      convexClearedTables: clearedTables,
      preservedConvexTables: PRESERVED_CONVEX_TABLES,
      postgresDeleted: deleted,
      protectedState: publicProtectedProof(protectedAfter),
    });
    return Object.freeze({
      ok: true,
      dryRun: false,
      stage: "complete",
      targetScopeDigest: config.targetScopeDigest,
      backupSha256: backupProof.sha256,
      convexClearedTableCount: clearedTables.length,
      postgresDeleted: deleted,
      protectedTableCount: protectedAfter.tableCount,
      protectedStateDigest: protectedAfter.combinedDigest,
    });
  } catch (error) {
    const failure = cutoverError(error, "CUTOVER_INTERNAL_FAILURE");
    if (destructiveStageStarted) {
      try {
        await appendEvidence(
          evidence,
          clock,
          evidenceBase,
          "recovery_required",
          {
            failureCode: failure.code,
            backup: backupProof,
            clearedTableCount: clearedTables.length,
            postgresResetStarted,
          },
        );
      } catch {
        // Recovery is still required even when the final evidence append fails.
      }
      throw new CutoverResetError("CUTOVER_RECOVERY_REQUIRED");
    }
    try {
      await appendEvidence(evidence, clock, evidenceBase, "failed", {
        failureCode: failure.code,
      });
    } catch {
      if (failure.code !== "CUTOVER_EVIDENCE_WRITE_FAILED") {
        throw new CutoverResetError("CUTOVER_EVIDENCE_WRITE_FAILED");
      }
    }
    throw failure;
  } finally {
    if (artifacts) {
      try {
        await artifactsManager.cleanup(artifacts);
      } catch {
        // The only disposable artifact is a generated directory containing [];
        // the verified backup is deliberately outside it and is never removed.
      }
    }
    try {
      await database.close?.();
    } catch {
      // Do not replace a completed reset or a more actionable staged failure.
    }
  }
}

function helpText() {
  return `Usage: node scripts/preproduction/reset-postgres-convex-promotion-cutover.mjs [--dry-run|--execute]

Dry-run is the default. Configuration is accepted only through these explicit
environment variables:
  PACKSCOUT_CUTOVER_ENVIRONMENT=preproduction
  PACKSCOUT_CUTOVER_DATABASE_ENVIRONMENT=preproduction
  PACKSCOUT_CUTOVER_ORGANIZATION_ID
  PACKSCOUT_CUTOVER_DEPLOYMENT_KEY
  PACKSCOUT_CUTOVER_CONVEX_DEPLOYMENT=<...:preproduction>
  PACKSCOUT_CUTOVER_DATABASE_TARGET_SHA256
  PACKSCOUT_CUTOVER_APPROVAL_REFERENCE
  PACKSCOUT_CUTOVER_WORKERS_STOPPED=YES
  PACKSCOUT_CUTOVER_EVIDENCE_FILE=<absolute path>
  PACKSCOUT_CUTOVER_BACKUP_DIRECTORY=<absolute path>
  PACKSCOUT_DATABASE_URL

Execution also requires PACKSCOUT_CUTOVER_CONFIRMATION equal to the target-bound
phrase emitted by a successful dry-run. To calculate the non-secret database
target digest, run this script with --print-database-target-digest.`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(helpText());
    return;
  }
  if (argv.length === 1 && argv[0] === "--print-database-target-digest") {
    assertPreproductionRuntime(process.env);
    const databaseUrl = requireEnvironmentValue(
      process.env,
      "PACKSCOUT_DATABASE_URL",
      "CUTOVER_TARGET_INVALID",
    );
    console.log(
      JSON.stringify({
        databaseTargetDigest: computeDatabaseTargetDigest(databaseUrl),
      }),
    );
    return;
  }

  const config = parseCutoverConfiguration({ argv, environment: process.env });
  const result = await runCutoverReset(config);
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const failure = cutoverError(error, "CUTOVER_INTERNAL_FAILURE");
    console.error(
      JSON.stringify({
        ok: false,
        error: { code: failure.code, message: failure.message },
      }),
    );
    process.exitCode = 1;
  });
}
