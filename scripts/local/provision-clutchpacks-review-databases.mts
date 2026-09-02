#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createNodePasswordHasher } from
  "../../apps/admin/server/auth/crypto.ts";
import { directProvisionOperatorRequestSchema } from
  "../../packages/contracts/src/auth.ts";
import { AesGcmProviderCredentialCipher } from
  "../../packages/services/src/provider-credential-cipher.ts";
import {
  CLUTCHPACKS_REVIEW_DATABASES,
  ClutchpacksReviewProvisionError,
  assertDistinctClusterProofs,
  assertNoClutchpacksProvisionArguments,
  assertResumableClusterTopology,
  buildClutchpacksProvisionPlan,
  readClutchpacksProvisionEnvironment,
  safeClutchpacksProvisionFailure,
  type ClutchpacksReviewDatabaseTarget,
  type ProvisionClusterEnvironment,
  type ReadClusterEnvironment,
} from "./clutchpacks-review-database-plan.mjs";
import {
  assertFixedPg16Binaries,
  assertProvisionClusterLayout,
  clusterDatabaseUrl,
  clusterMigrationUrl,
  ensureFixedClusterRoot,
  initializeFixedCluster,
  inspectFixedCluster,
  markFixedClusterProvisioned,
  readConnectedClusterProof,
  startFixedCluster,
  stopFixedCluster,
} from "./clutchpacks-review-cluster-runtime.mts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const schemaFiles = Object.freeze({
  central: path.join(repositoryRoot, "packages/database/prisma/central/schema.prisma"),
  provider: path.join(repositoryRoot, "packages/database/prisma/provider/schema.prisma"),
});
const prismaExecutable = path.join(
  repositoryRoot,
  "node_modules/prisma/build/index.js",
);

const CENTRAL_RUNTIME_TABLES = Object.freeze([
  "organizations",
  "operators",
  "operator_memberships",
  "operator_sessions",
  "auth_rate_limits",
  "audit_events",
  "worker_instances",
  "email_message_intents",
  "email_message_attempts",
  "email_link_tokens",
  "global_activity_events",
  "providers",
  "provider_public_profile_versions",
  "provider_config_versions",
  "provider_credential_versions",
  "provider_database_nodes",
  "provider_connection_tests",
  "provider_activity_events",
  "provider_completion_publish_plans",
  "provider_health",
  "admin_alerts",
  "global_categories",
  "global_collectibles",
  "global_collectible_categories",
  "global_collectible_name_aliases",
  "provider_category_correlations",
  "provider_collectible_correlations",
  "correlation_suggestions",
  "catalog_ledger",
  "collectible_aliases",
  "catalog_decision_events",
  "catalog_promotion_changes",
  "provider_release_invalidation_ledger",
  "provider_release_invalidations",
  "provider_invalidation_checkpoints",
  "catalog_consumer_checkpoints",
  "catalog_versions",
  "catalog_version_batches",
  "catalog_publication_operations",
  "manifest_activation_state",
  "manifest_activation_operations",
  "manifest_activation_status_observations",
  "manifest_activation_state_observations",
  "artifact_retention_executions",
  "manifest_reconciliation_job_wake",
  "manifest_reconciliation_job_schedule",
  "promotion_job_liveness_evaluator_state",
  "promotion_job_liveness_observations",
  "promotion_job_liveness_conditions",
  "manifest_reconciliation_job_invocations",
  "manifest_reconciliation_job_delivery_tombstones",
  "manifest_reconciliation_invocation_details",
  "manifest_gate_intents",
  "provider_promotion_invocation_projections",
  "provider_promotion_projection_retention_state",
]);
const CENTRAL_DELETE_TABLES = Object.freeze([
  "auth_rate_limits",
  "worker_instances",
  "email_message_intents",
  "email_message_attempts",
  "email_link_tokens",
  "manifest_reconciliation_job_invocations",
  "manifest_reconciliation_job_delivery_tombstones",
  "provider_promotion_invocation_projections",
]);
const PROVIDER_RUNTIME_TABLES = Object.freeze([
  "categories",
  "packs",
  "collectibles",
  "collectible_name_aliases",
  "collectible_instances",
  "pack_contents",
  "pack_content_snapshots",
  "provider_accounts",
  "pulls",
  "pull_items",
  "market_events",
  "promotion_ledger",
  "promotion_changes",
  "provider_runtime",
  "provider_state_events",
  "provider_worker_states",
  "provider_runs",
  "provider_run_pages",
  "control_commands",
  "quarantine_records",
  "quarantine_attempts",
  "pack_ev_recomputation_requests",
  "retention_executions",
  "local_audit_events",
  "provider_activity_outbox",
  "provider_change_consumers",
  "provider_releases",
  "provider_release_batches",
  "provider_publication_batch_evidence",
  "provider_publication_operations",
  "provider_publication_receipts",
  "provider_publication_state",
  "provider_promotion_job_wake",
  "provider_promotion_job_schedule",
  "provider_promotion_job_invocations",
  "provider_promotion_projection_outbox",
  "provider_promotion_job_delivery_tombstones",
  "provider_promotion_invocation_details",
]);
const PROVIDER_DELETE_TABLES = Object.freeze([
  "provider_activity_outbox",
  "provider_promotion_job_invocations",
  "provider_promotion_job_delivery_tombstones",
]);
const PROVIDER_RUNTIME_SEQUENCES = Object.freeze([
  "provider_state_events_sequence_seq",
  "local_audit_events_sequence_seq",
]);

function refuse(code: string): never {
  throw new ClutchpacksReviewProvisionError(code);
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    refuse("POSTGRES_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes("\0") || /[\r\n]/u.test(value)) {
    refuse("PROVISION_CREDENTIAL_INVALID");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function qualifiedTables(tables: readonly string[]): string {
  return tables.map((table) => `public.${quoteIdentifier(table)}`).join(", ");
}

export function migrateReviewDatabase(input: {
  readonly databaseUrl: string;
  readonly role: "central" | "provider";
}): void {
  const environmentKey = input.role === "central"
    ? "PACKSCOUT_CENTRAL_DATABASE_URL"
    : "PACKSCOUT_PROVIDER_DATABASE_URL";
  const result = spawnSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", schemaFiles[input.role]],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: "/opt/homebrew/opt/postgresql@16/bin:/usr/bin:/bin",
        NODE_ENV: "development",
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
        [environmentKey]: input.databaseUrl,
      },
      maxBuffer: 2 * 1_048_576,
    },
  );
  if (result.error || result.status !== 0) refuse("PRISMA_MIGRATION_FAILED");
}

export async function createReviewClusterDatabase(input: {
  readonly cluster: ClutchpacksReviewDatabaseTarget;
  readonly clusterAdminPassword: string;
  readonly appPassword: string;
}): Promise<void> {
  const adminUrl = clusterDatabaseUrl({
    cluster: input.cluster,
    databaseName: "postgres",
    username: input.cluster.clusterAdminRoleName,
    password: input.clusterAdminPassword,
  });
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const roles = await pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolconnlimit: number;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolname: string;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(`
      select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
             rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
      from pg_catalog.pg_roles
      where rolname !~ '^pg_'
      order by rolname
    `);
    const databases = await pool.query<{ datname: string; owner_name: string }>(`
      select datname, pg_catalog.pg_get_userbyid(datdba) as owner_name
      from pg_catalog.pg_database order by datname
    `);
    const resume = assertResumableClusterTopology(input.cluster, {
      roles: roles.rows,
      databases: databases.rows,
    });
    if (!resume.ownerRoleExists) {
      await pool.query(`
        create role ${quoteIdentifier(input.cluster.ownerRoleName)}
        nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      `);
    }
    if (!resume.appRoleExists) {
      await pool.query(`
        create role ${quoteIdentifier(input.cluster.appRoleName)}
        login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
        connection limit 20 password ${quoteLiteral(input.appPassword)}
      `);
    }
    if (!resume.targetDatabaseExists) {
      await pool.query(`
        create database ${quoteIdentifier(input.cluster.databaseName)}
        owner ${quoteIdentifier(input.cluster.ownerRoleName)}
        encoding 'UTF8' template template0
      `);
    }
    for (const databaseName of [
      "postgres",
      "template0",
      "template1",
      input.cluster.databaseName,
    ]) {
      await pool.query(`
        revoke all on database ${quoteIdentifier(databaseName)} from public
      `);
    }
    await pool.query(`
      grant connect on database ${quoteIdentifier(input.cluster.databaseName)}
      to ${quoteIdentifier(input.cluster.appRoleName)}
    `);
    const connectDatabases = await pool.query<{ datname: string }>(`
      select datname from pg_catalog.pg_database
      where has_database_privilege($1, datname, 'CONNECT')
      order by datname
    `, [input.cluster.appRoleName]);
    if (
      JSON.stringify(connectDatabases.rows.map((row) => row.datname)) !==
        JSON.stringify([input.cluster.databaseName])
    ) {
      refuse("CLUSTER_ROLE_ISOLATION_FAILED");
    }
  } catch (error) {
    if (error instanceof ClutchpacksReviewProvisionError) throw error;
    refuse("CLUSTER_DATABASE_CREATE_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function initializeReviewProviderIdentity(input: {
  readonly databaseUrl: string;
  readonly providerId: string;
  readonly providerKey: string;
}): Promise<void> {
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  try {
    await pool.query(
      "select public.initialize_provider_database_identity($1::uuid, $2::text)",
      [input.providerId, input.providerKey],
    );
  } catch {
    refuse("PROVIDER_IDENTITY_INITIALIZATION_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function grantExplicitReviewRuntimeAccess(input: {
  readonly cluster: ClutchpacksReviewDatabaseTarget;
  readonly clusterAdminPassword: string;
  readonly provider: boolean;
}): Promise<void> {
  const pool = new Pool({
    connectionString: clusterDatabaseUrl({
      cluster: input.cluster,
      username: input.cluster.clusterAdminRoleName,
      password: input.clusterAdminPassword,
    }),
    max: 1,
  });
  const runtimeTables = input.provider
    ? PROVIDER_RUNTIME_TABLES
    : CENTRAL_RUNTIME_TABLES;
  try {
    await pool.query("revoke all on schema public from public");
    await pool.query(`
      grant usage on schema public to ${quoteIdentifier(input.cluster.appRoleName)}
    `);
    await pool.query(`
      grant select on table public.database_identity, public._prisma_migrations
      to ${quoteIdentifier(input.cluster.appRoleName)}
    `);
    await pool.query(`
      grant select, insert, update on table ${qualifiedTables(runtimeTables)}
      to ${quoteIdentifier(input.cluster.appRoleName)}
    `);
    if (!input.provider) {
      await pool.query(`
        grant delete on table ${qualifiedTables(CENTRAL_DELETE_TABLES)}
        to ${quoteIdentifier(input.cluster.appRoleName)}
      `);
    } else {
      await pool.query(`
        grant delete on table ${qualifiedTables(PROVIDER_DELETE_TABLES)}
        to ${quoteIdentifier(input.cluster.appRoleName)}
      `);
      await pool.query(`
        grant usage, select on sequence ${qualifiedTables(PROVIDER_RUNTIME_SEQUENCES)}
        to ${quoteIdentifier(input.cluster.appRoleName)}
      `);
      await pool.query(`
        revoke all on function
          public.initialize_provider_database_identity(uuid, text)
        from public, ${quoteIdentifier(input.cluster.appRoleName)}
      `);
    }
  } catch {
    refuse("RUNTIME_ROLE_GRANT_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function expectReviewProviderInitializerDenied(input: {
  readonly providerUrl: string;
  readonly providerKey: string;
}): Promise<void> {
  const pool = new Pool({ connectionString: input.providerUrl, max: 1 });
  try {
    const privilege = await pool.query<{ may_initialize: boolean }>(`
      select has_function_privilege(
        current_user,
        'public.initialize_provider_database_identity(uuid, text)',
        'EXECUTE'
      ) as may_initialize
    `);
    if (privilege.rows[0]?.may_initialize !== false) {
      refuse("PROVIDER_INITIALIZER_PERMISSION_PROOF_FAILED");
    }
    await pool.query(
      "select public.initialize_provider_database_identity($1::uuid, $2::text)",
      [randomUUID(), input.providerKey],
    );
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "42501"
    ) return;
    if (error instanceof ClutchpacksReviewProvisionError) throw error;
    refuse("PROVIDER_INITIALIZER_PERMISSION_PROOF_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
  refuse("PROVIDER_INITIALIZER_PERMISSION_PROOF_FAILED");
}

export async function expectReviewConnectionDenied(
  databaseUrl: string,
): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    await pool.query("select 1");
  } catch {
    return;
  } finally {
    await pool.end().catch(() => undefined);
  }
  refuse("CLUSTER_ROLE_ISOLATION_FAILED");
}

function deterministicProvisionUuid(seed: string, label: string): string {
  const bytes = createHash("sha256")
    .update("packscout-local-review-provisioning-v1\0", "utf8")
    .update(seed, "utf8")
    .update("\0", "utf8")
    .update(label, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = bytes.toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

function createProvisionIds(
  centralSystemIdentifier: string,
  providerSystemIdentifier: string,
) {
  const seed = `${centralSystemIdentifier}:${providerSystemIdentifier}`;
  const id = (label: string): string => deterministicProvisionUuid(seed, label);
  return Object.freeze({
    organizationId: id("organization"),
    operatorId: id("operator"),
    membershipId: id("membership"),
    providerId: id("provider"),
    configVersionId: id("provider-config"),
    databaseCredentialVersionId: id("database-credential"),
    databaseNodeId: id("database-node"),
    activationTestId: id("activation-test"),
    auditEventId: id("audit-event"),
  });
}

async function registerCentralMetadata(input: {
  readonly centralUrl: string;
  readonly providerPassword: string;
  readonly bootstrap: ProvisionClusterEnvironment["bootstrap"];
  readonly credentialKey: ProvisionClusterEnvironment["credentialKey"];
  readonly ids: ReturnType<typeof createProvisionIds>;
}): Promise<void> {
  const account = directProvisionOperatorRequestSchema.safeParse({
    email: input.bootstrap.adminEmail,
    displayName: input.bootstrap.adminDisplayName,
    password: input.bootstrap.adminPassword,
    role: "admin",
  });
  if (!account.success) refuse("BOOTSTRAP_ADMIN_INPUT_INVALID");
  const passwordHasher = createNodePasswordHasher();
  const credentialCipher = new AesGcmProviderCredentialCipher({
    primaryVersion: input.credentialKey.version,
    keys: new Map([[input.credentialKey.version, input.credentialKey.bytes]]),
  });
  const credentialPlaintext = JSON.stringify({
    username: CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
    password: input.providerPassword,
  });
  const credentialScope = {
    organizationId: input.ids.organizationId,
    providerId: input.ids.providerId,
    revisionId: input.ids.databaseCredentialVersionId,
  };
  const pool = new Pool({ connectionString: input.centralUrl, max: 1 });
  let counts;
  try {
    counts = await pool.query<{
      activation_test_expected: string;
      activation_test_total: string;
      audit_event_expected: string;
      audit_event_total: string;
      config_expected: string;
      config_total: string;
      credential_expected: string;
      credential_total: string;
      database_node_expected: string;
      database_node_total: string;
      membership_expected: string;
      membership_total: string;
      operator_expected: string;
      operator_total: string;
      organization_expected: string;
      organization_total: string;
      provider_expected: string;
      provider_total: string;
    }>(`
      select
        (select count(*)::text from organizations) as organization_total,
        (select count(*)::text from organizations where id = $1::uuid)
          as organization_expected,
        (select count(*)::text from operators) as operator_total,
        (select count(*)::text from operators where id = $2::uuid)
          as operator_expected,
        (select count(*)::text from operator_memberships) as membership_total,
        (select count(*)::text from operator_memberships where id = $3::uuid)
          as membership_expected,
        (select count(*)::text from providers) as provider_total,
        (select count(*)::text from providers where id = $4::uuid)
          as provider_expected,
        (select count(*)::text from provider_config_versions) as config_total,
        (select count(*)::text from provider_config_versions where id = $5::uuid)
          as config_expected,
        (select count(*)::text from provider_credential_versions)
          as credential_total,
        (select count(*)::text from provider_credential_versions where id = $6::uuid)
          as credential_expected,
        (select count(*)::text from provider_database_nodes) as database_node_total,
        (select count(*)::text from provider_database_nodes where id = $7::uuid)
          as database_node_expected,
        (select count(*)::text from provider_connection_tests)
          as activation_test_total,
        (select count(*)::text from provider_connection_tests where id = $8::uuid)
          as activation_test_expected,
        (select count(*)::text from audit_events) as audit_event_total,
        (select count(*)::text from audit_events where id = $9::uuid)
          as audit_event_expected
    `, [
      input.ids.organizationId,
      input.ids.operatorId,
      input.ids.membershipId,
      input.ids.providerId,
      input.ids.configVersionId,
      input.ids.databaseCredentialVersionId,
      input.ids.databaseNodeId,
      input.ids.activationTestId,
      input.ids.auditEventId,
    ]);
  } catch {
    await pool.end().catch(() => undefined);
    refuse("CENTRAL_REGISTRATION_FAILED");
  }
  const existingCounts = Object.values(counts.rows[0] ?? {});
  const registrationAbsent = existingCounts.length === 18 &&
    existingCounts.every((count) => count === "0");
  const registrationPresent = existingCounts.length === 18 &&
    existingCounts.every((count) => count === "1");
  if (!registrationAbsent && !registrationPresent) {
    await pool.end().catch(() => undefined);
    refuse("CENTRAL_REGISTRATION_STATE_UNEXPECTED");
  }
  if (registrationPresent) {
    let existing;
    try {
      existing = await pool.query<{
        activation_test_matches: boolean;
        audit_event_matches: boolean;
        auth_tag: Buffer;
        ciphertext: Buffer;
        config_matches: boolean;
        credential_matches: boolean;
        database_node_matches: boolean;
        key_version: number;
        membership_matches: boolean;
        nonce: Buffer;
        operator_matches: boolean;
        organization_matches: boolean;
        password_hash: string;
        provider_matches: boolean;
      }>(`
        select
          exists(select 1 from organizations where id = $1::uuid
            and slug = $10 and name = $11) as organization_matches,
          exists(select 1 from operators where id = $2::uuid
            and email_normalized = $12 and display_name = $13
            and state = 'active') as operator_matches,
          (select password_hash from operators where id = $2::uuid)
            as password_hash,
          exists(select 1 from operator_memberships where id = $3::uuid
            and organization_id = $1::uuid and operator_id = $2::uuid
            and role = 'admin') as membership_matches,
          exists(select 1 from providers where id = $4::uuid
            and organization_id = $1::uuid and provider_key = 'clutchpacks'
            and lifecycle = 'active' and active_config_version_id = $5::uuid)
            as provider_matches,
          exists(select 1 from provider_config_versions where id = $5::uuid
            and provider_id = $4::uuid and version_number = 1
            and adapter_key = $14 and expires_at is null) as config_matches,
          exists(select 1 from provider_credential_versions where id = $6::uuid
            and provider_id = $4::uuid and credential_kind = 'database'
            and version_number = 1 and lifecycle = 'active')
            as credential_matches,
          (select ciphertext from provider_credential_versions where id = $6::uuid)
            as ciphertext,
          (select nonce from provider_credential_versions where id = $6::uuid)
            as nonce,
          (select auth_tag from provider_credential_versions where id = $6::uuid)
            as auth_tag,
          (select key_version from provider_credential_versions where id = $6::uuid)
            as key_version,
          exists(select 1 from provider_database_nodes where id = $7::uuid
            and provider_id = $4::uuid and node_key = 'primary'
            and host = '127.0.0.1' and port = $15
            and database_name = $16 and credential_version_id = $6::uuid
            and enabled = true) as database_node_matches,
          exists(select 1 from provider_connection_tests where id = $8::uuid
            and provider_id = $4::uuid and config_version_id = $5::uuid
            and database_credential_version_id = $6::uuid
            and database_node_id = $7::uuid and outcome = 'succeeded')
            as activation_test_matches,
          exists(select 1 from audit_events where id = $9::uuid
            and organization_id = $1::uuid and subject_id = $4::uuid
            and action = 'provider.local_provision' and outcome = 'success')
            as audit_event_matches
      `, [
        input.ids.organizationId,
        input.ids.operatorId,
        input.ids.membershipId,
        input.ids.providerId,
        input.ids.configVersionId,
        input.ids.databaseCredentialVersionId,
        input.ids.databaseNodeId,
        input.ids.activationTestId,
        input.ids.auditEventId,
        input.bootstrap.organizationSlug,
        input.bootstrap.organizationName,
        account.data.email,
        account.data.displayName,
        CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
        CLUTCHPACKS_REVIEW_DATABASES.provider.port,
        CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      ]);
    } catch {
      await pool.end().catch(() => undefined);
      refuse("CENTRAL_REGISTRATION_FAILED");
    }
    const row = existing.rows[0];
    let decryptedCredential: string | null = null;
    try {
      if (row !== undefined) {
        decryptedCredential = credentialCipher.decrypt({
          ciphertext: new Uint8Array(row.ciphertext),
          nonce: new Uint8Array(row.nonce),
          authTag: new Uint8Array(row.auth_tag),
          keyVersion: row.key_version,
        }, credentialScope);
      }
    } catch {
      decryptedCredential = null;
    }
    const passwordMatches = row === undefined
      ? false
      : await passwordHasher.verify(
          row.password_hash,
          account.data.password,
        ).catch(() => false);
    if (
      row === undefined || !row.organization_matches || !row.operator_matches ||
      !row.membership_matches || !row.provider_matches || !row.config_matches ||
      !row.credential_matches || !row.database_node_matches ||
      !row.activation_test_matches || !row.audit_event_matches ||
      !passwordMatches || decryptedCredential !== credentialPlaintext
    ) {
      await pool.end().catch(() => undefined);
      refuse("CENTRAL_REGISTRATION_STATE_UNEXPECTED");
    }
    await pool.end().catch(() => undefined);
    return;
  }
  let passwordHash: string;
  let encryptedDatabaseCredential: ReturnType<
    AesGcmProviderCredentialCipher["encrypt"]
  >;
  try {
    passwordHash = await passwordHasher.hash(account.data.password);
    encryptedDatabaseCredential = credentialCipher.encrypt(
      credentialPlaintext,
      credentialScope,
    );
  } catch {
    await pool.end().catch(() => undefined);
    refuse("CENTRAL_REGISTRATION_FAILED");
  }
  const client = await pool.connect().catch(async () => {
    await pool.end().catch(() => undefined);
    return refuse("CENTRAL_REGISTRATION_FAILED");
  });
  try {
    await client.query("begin");
    const now = new Date();
    await client.query(`
      insert into organizations (id, slug, name, created_at)
      values ($1::uuid, $2, $3, $4)
    `, [
      input.ids.organizationId,
      input.bootstrap.organizationSlug,
      input.bootstrap.organizationName,
      now,
    ]);
    await client.query(`
      insert into operators (
        id, email_normalized, display_name, password_hash, state,
        row_version, created_at, updated_at
      ) values ($1::uuid, $2, $3, $4, 'active', 1, $5, $5)
    `, [
      input.ids.operatorId,
      account.data.email,
      account.data.displayName,
      passwordHash,
      now,
    ]);
    await client.query(`
      insert into operator_memberships (
        id, organization_id, operator_id, role, created_at, updated_at
      ) values ($1::uuid, $2::uuid, $3::uuid, 'admin', $4, $4)
    `, [
      input.ids.membershipId,
      input.ids.organizationId,
      input.ids.operatorId,
      now,
    ]);
    await client.query(`
      insert into providers (
        id, organization_id, provider_key, display_name, lifecycle,
        topology_version, row_version, created_at, updated_at
      ) values ($1::uuid, $2::uuid, $3, 'ClutchPacks', 'draft', 1, 1, $4, $4)
    `, [
      input.ids.providerId,
      input.ids.organizationId,
      CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey,
      now,
    ]);
    await client.query(`
      insert into provider_config_versions (
        id, provider_id, version_number, adapter_key, endpoint_url,
        source_credential_version_id, schedule_seconds, stale_after_seconds,
        configuration, expires_at, created_by_operator_id, created_at
      ) values (
        $1::uuid, $2::uuid, 1, $3, 'https://clutchpacks.local.invalid/capture',
        null, 3600, 86400, $4::jsonb, null, $5::uuid, $6
      )
    `, [
      input.ids.configVersionId,
      input.ids.providerId,
      CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
      JSON.stringify({
        adapterKey: CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
      }),
      input.ids.operatorId,
      now,
    ]);
    await client.query(`
      insert into provider_credential_versions (
        id, provider_id, credential_kind, version_number, ciphertext,
        nonce, auth_tag, key_version, lifecycle, activated_at, created_at
      ) values (
        $1::uuid, $2::uuid, 'database', 1, $3, $4, $5, $6,
        'active', $7, $7
      )
    `, [
      input.ids.databaseCredentialVersionId,
      input.ids.providerId,
      Buffer.from(encryptedDatabaseCredential.ciphertext),
      Buffer.from(encryptedDatabaseCredential.nonce),
      Buffer.from(encryptedDatabaseCredential.authTag),
      encryptedDatabaseCredential.keyVersion,
      now,
    ]);
    await client.query(`
      insert into provider_database_nodes (
        id, provider_id, node_key, node_role, host, port, database_name,
        ssl_mode, credential_version_id, region, enabled, row_version,
        created_at, updated_at
      ) values (
        $1::uuid, $2::uuid, 'primary', 'primary', '127.0.0.1', $3, $4,
        'disable', $5::uuid, 'local', true, 1, $6, $6
      )
    `, [
      input.ids.databaseNodeId,
      input.ids.providerId,
      CLUTCHPACKS_REVIEW_DATABASES.provider.port,
      CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      input.ids.databaseCredentialVersionId,
      now,
    ]);
    const provider = await client.query<{ topology_version: string }>(`
      select topology_version::text from providers where id = $1::uuid
    `, [input.ids.providerId]);
    const topologyVersion = provider.rows[0]?.topology_version;
    if (topologyVersion === undefined) refuse("CENTRAL_REGISTRATION_FAILED");
    await client.query(`
      insert into provider_connection_tests (
        id, provider_id, config_version_id, source_credential_version_id,
        database_credential_version_id, topology_version, database_node_id,
        database_node_row_version, target_digest, test_kind, outcome,
        latency_ms, response_status, sanitized_code, result_summary,
        record_counts, has_more, next_cursor_present, tested_by_operator_id,
        tested_at, created_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, null, $4::uuid, $5::bigint,
        $6::uuid, 1,
        packscout_activation_target_digest_nullable_source(
          $2::uuid, $3::uuid, null, $4::uuid, $5::bigint, $6::uuid, 1
        ),
        'activation', 'succeeded', null, null, null, $7::jsonb,
        null, null, null, $8::uuid, $9, $9
      )
    `, [
      input.ids.activationTestId,
      input.ids.providerId,
      input.ids.configVersionId,
      input.ids.databaseCredentialVersionId,
      topologyVersion,
      input.ids.databaseNodeId,
      JSON.stringify({
        databaseRole: "provider",
        schemaVersion: CLUTCHPACKS_REVIEW_DATABASES.provider.schemaVersion,
      }),
      input.ids.operatorId,
      now,
    ]);
    await client.query(`
      update providers
      set lifecycle = 'active', active_config_version_id = $2::uuid,
          row_version = row_version + 1,
          updated_at = greatest($3, updated_at + interval '1 microsecond')
      where id = $1::uuid
    `, [input.ids.providerId, input.ids.configVersionId, now]);
    await client.query(`
      insert into audit_events (
        id, organization_id, actor_key, action, subject_type, subject_id,
        outcome, metadata_json, occurred_at
      ) values (
        $1::uuid, $2::uuid, 'system:local-clutchpacks-provisioner',
        'provider.local_provision', 'provider', $3::uuid, 'success',
        $4::jsonb, $5
      )
    `, [
      input.ids.auditEventId,
      input.ids.organizationId,
      input.ids.providerId,
      JSON.stringify({
        adapterKey: CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
        databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
        clusterPort: CLUTCHPACKS_REVIEW_DATABASES.provider.port,
      }),
      now,
    ]);
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => undefined);
    refuse("CENTRAL_REGISTRATION_FAILED");
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

async function verifyProvisionedData(input: {
  readonly centralUrl: string;
  readonly providerUrl: string;
  readonly ids: ReturnType<typeof createProvisionIds>;
}): Promise<void> {
  const central = new Pool({ connectionString: input.centralUrl, max: 1 });
  const provider = new Pool({ connectionString: input.providerUrl, max: 1 });
  try {
    const centralProof = await central.query<{
      admin_count: string;
      identity_insert: boolean;
      provider_count: string;
      schema_create: boolean;
      unauthorized_delete: boolean;
    }>(`
      select
        (select count(*)::text from providers saved
          where saved.id = $1::uuid and saved.provider_key = 'clutchpacks'
            and saved.lifecycle = 'active') as provider_count,
        (select count(*)::text from operator_memberships membership
          where membership.organization_id = $2::uuid
            and membership.operator_id = $3::uuid
            and membership.role = 'admin') as admin_count,
        has_table_privilege(current_user, 'public.database_identity', 'INSERT')
          as identity_insert,
        has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
        has_table_privilege(current_user, 'public.audit_events', 'DELETE')
          as unauthorized_delete
    `, [input.ids.providerId, input.ids.organizationId, input.ids.operatorId]);
    const providerProof = await provider.query<{
      identity_insert: boolean;
      provider_id: string;
      provider_key: string;
      runtime_count: string;
      schema_create: boolean;
      unauthorized_delete: boolean;
      worker_roles: string[];
    }>(`
      select identity.provider_id::text, identity.provider_key,
             (select count(*)::text from provider_runtime runtime
               where runtime.singleton_key = true
                 and runtime.central_provider_id = identity.provider_id
                 and runtime.provider_key = identity.provider_key) as runtime_count,
             (select array_agg(worker_role::text order by worker_role::text)
               from provider_worker_states) as worker_roles,
             has_table_privilege(current_user, 'public.database_identity', 'INSERT')
               as identity_insert,
             has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
             has_table_privilege(current_user, 'public.provider_runs', 'DELETE')
               as unauthorized_delete
      from database_identity identity where identity.singleton_key = true
    `);
    const centralRow = centralProof.rows[0];
    const providerRow = providerProof.rows[0];
    if (
      centralProof.rows.length !== 1 ||
      centralRow?.provider_count !== "1" || centralRow.admin_count !== "1" ||
      centralRow.identity_insert || centralRow.schema_create ||
      centralRow.unauthorized_delete ||
      providerProof.rows.length !== 1 ||
      providerRow?.provider_id !== input.ids.providerId ||
      providerRow.provider_key !== CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey ||
      providerRow.runtime_count !== "1" ||
      providerRow.worker_roles.join(",") !== "import,promotion" ||
      providerRow.identity_insert || providerRow.schema_create ||
      providerRow.unauthorized_delete
    ) {
      refuse("PROVISION_READINESS_FAILED");
    }
  } catch (error) {
    if (error instanceof ClutchpacksReviewProvisionError) throw error;
    refuse("PROVISION_READINESS_FAILED");
  } finally {
    await Promise.allSettled([central.end(), provider.end()]);
  }
}

function appPasswordFor(
  environment: ReadClusterEnvironment,
  cluster: ClutchpacksReviewDatabaseTarget,
): string {
  const password = cluster.clusterKey === "control"
    ? environment.centralAppPassword
    : environment.providerAppPassword;
  if (password === null) refuse("PROVISION_CREDENTIAL_INVALID");
  return password;
}

async function inspectAction(environment: ReadClusterEnvironment): Promise<void> {
  const clusters = [];
  for (const cluster of environment.selected) {
    const filesystem = await inspectFixedCluster(cluster);
    const appPassword = cluster.clusterKey === "control"
      ? environment.centralAppPassword
      : environment.providerAppPassword;
    const connected = filesystem.running &&
        filesystem.directoryState === "provisioned" && appPassword !== null
      ? await readConnectedClusterProof({
          cluster,
          appPassword,
        })
      : null;
    clusters.push({ filesystem, connected });
  }
  emit({
    ok: true,
    operation: "inspect_packscout_review_clusters",
    target: environment.target,
    clusters,
    credentialsPrinted: false,
  });
}

async function startAction(environment: ReadClusterEnvironment): Promise<void> {
  const cluster = environment.selected[0];
  if (cluster === undefined) refuse("CLUSTER_ACTION_INVALID");
  const filesystem = await startFixedCluster(cluster);
  const connected = filesystem.directoryState === "provisioned"
    ? await readConnectedClusterProof({
        cluster,
        appPassword: appPasswordFor(environment, cluster),
      })
    : null;
  emit({
    ok: true,
    operation: "start_packscout_review_cluster",
    filesystem,
    connected,
    credentialsPrinted: false,
  });
}

async function provisionAction(
  environment: ProvisionClusterEnvironment,
): Promise<void> {
  const centralCluster = CLUTCHPACKS_REVIEW_DATABASES.central;
  const providerCluster = CLUTCHPACKS_REVIEW_DATABASES.provider;
  await assertProvisionClusterLayout();
  await ensureFixedClusterRoot();
  const centralMarker = await initializeFixedCluster(
    centralCluster,
    environment.centralClusterAdminPassword,
  );
  const providerMarker = await initializeFixedCluster(
    providerCluster,
    environment.providerClusterAdminPassword,
  );
  assertDistinctClusterProofs(
    { ...centralCluster, systemIdentifier: centralMarker.systemIdentifier },
    { ...providerCluster, systemIdentifier: providerMarker.systemIdentifier },
  );

  const started: ClutchpacksReviewDatabaseTarget[] = [];
  try {
    const centralBeforeStart = await inspectFixedCluster(centralCluster);
    await startFixedCluster(centralCluster);
    if (!centralBeforeStart.running) started.push(centralCluster);
    const providerBeforeStart = await inspectFixedCluster(providerCluster);
    await startFixedCluster(providerCluster);
    if (!providerBeforeStart.running) started.push(providerCluster);
    await createReviewClusterDatabase({
      cluster: centralCluster,
      clusterAdminPassword: environment.centralClusterAdminPassword,
      appPassword: environment.centralAppPassword,
    });
    await createReviewClusterDatabase({
      cluster: providerCluster,
      clusterAdminPassword: environment.providerClusterAdminPassword,
      appPassword: environment.providerAppPassword,
    });
    const centralMigrationUrl = clusterMigrationUrl({
      cluster: centralCluster,
      clusterAdminPassword: environment.centralClusterAdminPassword,
    });
    const providerMigrationUrl = clusterMigrationUrl({
      cluster: providerCluster,
      clusterAdminPassword: environment.providerClusterAdminPassword,
    });
    migrateReviewDatabase({ databaseUrl: centralMigrationUrl, role: "central" });
    migrateReviewDatabase({ databaseUrl: providerMigrationUrl, role: "provider" });
    const ids = createProvisionIds(
      centralMarker.systemIdentifier,
      providerMarker.systemIdentifier,
    );
    const plan = buildClutchpacksProvisionPlan(ids);
    await initializeReviewProviderIdentity({
      databaseUrl: providerMigrationUrl,
      providerId: ids.providerId,
      providerKey: providerCluster.providerKey!,
    });
    await grantExplicitReviewRuntimeAccess({
      cluster: centralCluster,
      clusterAdminPassword: environment.centralClusterAdminPassword,
      provider: false,
    });
    await grantExplicitReviewRuntimeAccess({
      cluster: providerCluster,
      clusterAdminPassword: environment.providerClusterAdminPassword,
      provider: true,
    });
    const centralUrl = clusterDatabaseUrl({
      cluster: centralCluster,
      username: centralCluster.appRoleName,
      password: environment.centralAppPassword,
    });
    const providerUrl = clusterDatabaseUrl({
      cluster: providerCluster,
      username: providerCluster.appRoleName,
      password: environment.providerAppPassword,
    });
    await expectReviewProviderInitializerDenied({
      providerUrl,
      providerKey: providerCluster.providerKey!,
    });
    await Promise.all([
      expectReviewConnectionDenied(clusterDatabaseUrl({
        cluster: providerCluster,
        username: centralCluster.appRoleName,
        password: environment.centralAppPassword,
      })),
      expectReviewConnectionDenied(clusterDatabaseUrl({
        cluster: centralCluster,
        username: providerCluster.appRoleName,
        password: environment.providerAppPassword,
      })),
    ]);
    await registerCentralMetadata({
      centralUrl,
      providerPassword: environment.providerAppPassword,
      bootstrap: environment.bootstrap,
      credentialKey: environment.credentialKey,
      ids,
    });
    await verifyProvisionedData({ centralUrl, providerUrl, ids });
    await markFixedClusterProvisioned(centralCluster);
    await markFixedClusterProvisioned(providerCluster);
    const [centralProof, providerProof] = await Promise.all([
      readConnectedClusterProof({
        cluster: centralCluster,
        appPassword: environment.centralAppPassword,
      }),
      readConnectedClusterProof({
        cluster: providerCluster,
        appPassword: environment.providerAppPassword,
      }),
    ]);
    assertDistinctClusterProofs(centralProof, providerProof);
    emit({
      ok: true,
      operation: "provision_packscout_review_clusters",
      clusters: [centralProof, providerProof],
      identities: plan.identities,
      providerIdentity: plan.providerIdentity,
      adapterKey: CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
      credentialCipher: "packscout-provider-credential:v1",
      grants: "explicit-current-runtime-tables",
      credentialsPrinted: false,
    });
  } catch (error) {
    for (const cluster of started.toReversed()) {
      await stopFixedCluster(cluster).catch(() => undefined);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  assertNoClutchpacksProvisionArguments(process.argv.slice(2));
  const environment = readClutchpacksProvisionEnvironment(process.env);
  await assertFixedPg16Binaries();
  if (environment.action === "inspect") {
    await inspectAction(environment);
    return;
  }
  if (environment.action === "start") {
    await startAction(environment);
    return;
  }
  if (environment.action === "stop") {
    const cluster = environment.selected[0];
    if (cluster === undefined) refuse("CLUSTER_ACTION_INVALID");
    emit({
      ok: true,
      operation: "stop_packscout_review_cluster",
      filesystem: await stopFixedCluster(cluster),
    });
    return;
  }
  if (environment.action !== "provision") refuse("CLUSTER_ACTION_INVALID");
  await provisionAction(environment);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(safeClutchpacksProvisionFailure(error))}\n`);
    process.exitCode = 1;
  });
}
