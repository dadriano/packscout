#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
} from "@packscout/contracts";
import dotenv from "dotenv";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { AesGcmProviderCredentialCipher } from "@packscout/services";
import {
  CollectorCryptDataforrestActivationError,
  assertNoCollectorCryptActivationArguments,
  collectorCryptDataforrestConfiguration,
  readCollectorCryptDataforrestActivationEnvironment,
  safeCollectorCryptDataforrestActivationError,
} from "./activate-collector-crypt-dataforrest-source-plan.mjs";
import {
  runBoundedProviderReviewSourceLiveCheck,
  type ProviderReviewSourceLiveCheckResult,
} from "./provider-review-source-live-check.mts";
import {
  runPinnedProviderReviewActivationDatabaseProof,
  type ProviderReviewActivationDatabasePins,
  type ProviderReviewActivationDatabaseProof,
} from "./provider-review-activation-database-proof.mts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repositoryEnvironmentPath = path.join(repositoryRoot, ".env");
const COLLECTOR_PROVIDER_KEY = "collector_crypt";
const CLUTCHPACKS_PROVIDER_KEY = "clutchpacks";
const ACTIVATION_ACTOR =
  "system:local-collector-crypt-dataforrest-activation";
const ACTIVATION_ACTION = "provider.local_dataforrest_activation";

interface CollectorSnapshotRow extends QueryResultRow {
  readonly provider_id: string;
  readonly organization_id: string;
  readonly provider_key: string;
  readonly lifecycle: string;
  readonly active_config_version_id: string;
  readonly topology_version: string;
  readonly provider_row_version: string;
  readonly config_id: string;
  readonly config_version_number: string;
  readonly adapter_key: string;
  readonly endpoint_url: string;
  readonly source_credential_version_id: string | null;
  readonly schedule_seconds: number;
  readonly stale_after_seconds: number;
  readonly configuration: unknown;
  readonly expires_at: Date | null;
  readonly created_by_operator_id: string;
  readonly node_id: string;
  readonly node_key: string;
  readonly node_role: string;
  readonly host: string;
  readonly port: number;
  readonly database_name: string;
  readonly ssl_mode: string;
  readonly database_credential_version_id: string;
  readonly node_enabled: boolean;
  readonly node_row_version: string;
  readonly database_credential_kind: string;
  readonly database_credential_version_number: string;
  readonly database_credential_lifecycle: string;
  readonly database_credential_activated_at: Date | null;
  readonly database_credential_retired_at: Date | null;
  readonly database_credential_revoked_at: Date | null;
  readonly source_credential_id: string | null;
  readonly source_credential_kind: string | null;
  readonly source_credential_version_number: string | null;
  readonly source_credential_lifecycle: string | null;
  readonly source_credential_activated_at: Date | null;
  readonly source_credential_retired_at: Date | null;
  readonly source_credential_revoked_at: Date | null;
}

interface CollectorSnapshotCounts extends QueryResultRow {
  readonly provider_count: string;
  readonly config_count: string;
  readonly database_credential_count: string;
  readonly source_credential_count: string;
  readonly node_count: string;
  readonly admin_count: string;
  readonly baseline_activation_count: string;
  readonly live_activation_count: string;
  readonly activation_audit_count: string;
}

interface CollectorSnapshot {
  readonly row: CollectorSnapshotRow;
  readonly counts: CollectorSnapshotCounts;
}

interface SourceAuthorityRow extends QueryResultRow {
  readonly provider_id: string;
  readonly organization_id: string;
  readonly provider_row_version: string;
  readonly config_id: string;
  readonly adapter_key: string;
  readonly endpoint_url: string;
  readonly configuration: unknown;
  readonly expires_at: Date | null;
  readonly credential_id: string;
  readonly credential_kind: string;
  readonly credential_version_number: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly auth_tag: Buffer;
  readonly key_version: number;
  readonly credential_lifecycle: string;
  readonly activated_at: Date | null;
  readonly retired_at: Date | null;
  readonly revoked_at: Date | null;
}

interface SourceAuthorityPin {
  readonly providerId: string;
  readonly providerRowVersion: string;
  readonly configId: string;
  readonly credentialId: string;
  readonly credentialFingerprint: string;
}

type SqlClient = Pool | PoolClient;

function refuse(code: string): never {
  throw new CollectorCryptDataforrestActivationError(code);
}

function isExactObject(
  value: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every(
    (key, index) =>
      key === expectedKeys[index] && actual[key] === expected[key],
  );
}

function isPositiveBigint(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}

function credentialFingerprint(row: SourceAuthorityRow): string {
  return createHash("sha256")
    .update(row.ciphertext)
    .update(row.nonce)
    .update(row.auth_tag)
    .update(String(row.key_version), "utf8")
    .digest("hex");
}

function sourceAuthorityPin(row: SourceAuthorityRow): SourceAuthorityPin {
  return Object.freeze({
    providerId: row.provider_id,
    providerRowVersion: row.provider_row_version,
    configId: row.config_id,
    credentialId: row.credential_id,
    credentialFingerprint: credentialFingerprint(row),
  });
}

function pinsMatch(
  left: Readonly<SourceAuthorityPin>,
  right: Readonly<SourceAuthorityPin>,
): boolean {
  return left.providerId === right.providerId &&
    left.providerRowVersion === right.providerRowVersion &&
    left.configId === right.configId &&
    left.credentialId === right.credentialId &&
    left.credentialFingerprint === right.credentialFingerprint;
}

export async function loadCollectorCryptDataforrestRepositoryEnvironment():
Promise<Record<string, string>> {
  try {
    const metadata = await lstat(repositoryEnvironmentPath);
    const currentUserId = typeof process.getuid === "function"
      ? process.getuid()
      : null;
    if (
      !metadata.isFile() || metadata.isSymbolicLink() ||
      (currentUserId !== null && metadata.uid !== currentUserId) ||
      (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0
    ) {
      refuse("ACTIVATION_ENVIRONMENT_FILE_UNSAFE");
    }
    return dotenv.parse(await readFile(repositoryEnvironmentPath, "utf8"));
  } catch (error) {
    if (error instanceof CollectorCryptDataforrestActivationError) throw error;
    return refuse("ACTIVATION_ENVIRONMENT_FILE_UNSAFE");
  }
}

async function assertCentralDatabaseIdentity(pool: Pool): Promise<void> {
  const result = await pool.query<{
    current_database: string;
    current_user: string;
    server_port: number | null;
    database_role: string;
    schema_version: string;
    provider_id: string | null;
    provider_key: string | null;
  }>(`
    select current_database(), current_user, inet_server_port() as server_port,
           database_role, schema_version, provider_id, provider_key
    from database_identity where singleton_key = true
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || row === undefined ||
    row.current_database !== "packscout" ||
    row.current_user !== "packscout_control_app" ||
    row.server_port !== 55_431 || row.database_role !== "central" ||
    row.schema_version !== "distributed-central-v1" ||
    row.provider_id !== null || row.provider_key !== null
  ) {
    refuse("ACTIVATION_DATABASE_IDENTITY_MISMATCH");
  }
}

async function readCollectorSnapshot(
  client: SqlClient,
  providerId: string | null = null,
): Promise<CollectorSnapshot> {
  const result = await client.query<CollectorSnapshotRow>(`
    select provider.id::text as provider_id,
           provider.organization_id::text as organization_id,
           provider.provider_key, provider.lifecycle,
           provider.active_config_version_id::text,
           provider.topology_version::text,
           provider.row_version::text as provider_row_version,
           config.id::text as config_id,
           config.version_number::text as config_version_number,
           config.adapter_key, config.endpoint_url,
           config.source_credential_version_id::text,
           config.schedule_seconds, config.stale_after_seconds,
           config.configuration, config.expires_at,
           config.created_by_operator_id::text,
           node.id::text as node_id, node.node_key, node.node_role,
           node.host, node.port, node.database_name, node.ssl_mode,
           node.credential_version_id::text as database_credential_version_id,
           node.enabled as node_enabled,
           node.row_version::text as node_row_version,
           database_credential.credential_kind as database_credential_kind,
           database_credential.version_number::text
             as database_credential_version_number,
           database_credential.lifecycle as database_credential_lifecycle,
           database_credential.activated_at
             as database_credential_activated_at,
           database_credential.retired_at as database_credential_retired_at,
           database_credential.revoked_at as database_credential_revoked_at,
           source_credential.id::text as source_credential_id,
           source_credential.credential_kind as source_credential_kind,
           source_credential.version_number::text
             as source_credential_version_number,
           source_credential.lifecycle as source_credential_lifecycle,
           source_credential.activated_at as source_credential_activated_at,
           source_credential.retired_at as source_credential_retired_at,
           source_credential.revoked_at as source_credential_revoked_at
    from providers provider
    join provider_config_versions config
      on config.id = provider.active_config_version_id
     and config.provider_id = provider.id
    join provider_database_nodes node on node.provider_id = provider.id
    join provider_credential_versions database_credential
      on database_credential.id = node.credential_version_id
     and database_credential.provider_id = provider.id
    left join provider_credential_versions source_credential
      on source_credential.id = config.source_credential_version_id
     and source_credential.provider_id = provider.id
    where provider.provider_key = $1
      and ($2::uuid is null or provider.id = $2::uuid)
  `, [COLLECTOR_PROVIDER_KEY, providerId]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const countsResult = await client.query<CollectorSnapshotCounts>(`
    select
      (select count(*)::text from providers
       where provider_key = $1 and organization_id = $2::uuid)
        as provider_count,
      (select count(*)::text from provider_config_versions
       where provider_id = $3::uuid) as config_count,
      (select count(*)::text from provider_credential_versions
       where provider_id = $3::uuid and credential_kind = 'database')
        as database_credential_count,
      (select count(*)::text from provider_credential_versions
       where provider_id = $3::uuid and credential_kind = 'source')
        as source_credential_count,
      (select count(*)::text from provider_database_nodes
       where provider_id = $3::uuid) as node_count,
      (select count(*)::text from operator_memberships membership
       join operators operator on operator.id = membership.operator_id
       where membership.organization_id = $2::uuid
         and membership.role = 'admin' and operator.state = 'active')
        as admin_count,
      (select count(*)::text from provider_connection_tests test
       where test.provider_id = $3::uuid
         and test.config_version_id = $4::uuid
         and test.source_credential_version_id is null
         and test.database_credential_version_id = $5::uuid
         and test.topology_version = $6::bigint
         and test.database_node_id = $7::uuid
         and test.database_node_row_version = $8::bigint
         and test.target_digest =
           packscout_activation_target_digest_nullable_source(
             $3::uuid, $4::uuid, null, $5::uuid, $6::bigint,
             $7::uuid, $8::bigint)
         and test.test_kind = 'activation' and test.outcome = 'succeeded'
         and test.result_summary @> $9::jsonb)
        as baseline_activation_count,
      (select count(*)::text from provider_connection_tests test
       where test.provider_id = $3::uuid
         and test.config_version_id = $4::uuid
         and test.source_credential_version_id is not distinct from $10::uuid
         and test.database_credential_version_id = $5::uuid
         and test.topology_version = $6::bigint
         and test.database_node_id = $7::uuid
         and test.database_node_row_version = $8::bigint
         and test.target_digest =
           packscout_activation_target_digest_nullable_source(
             $3::uuid, $4::uuid, $10::uuid, $5::uuid, $6::bigint,
             $7::uuid, $8::bigint)
         and test.test_kind = 'activation' and test.outcome = 'succeeded'
         and test.latency_ms is not null
         and test.response_status between 200 and 299
         and test.result_summary @> $11::jsonb
         and test.record_counts = '{"records":1}'::jsonb)
        as live_activation_count,
      (select count(*)::text from audit_events
       where organization_id = $2::uuid and subject_id = $3::uuid
         and actor_key = $12 and action = $13 and outcome = 'success')
        as activation_audit_count
  `, [
    COLLECTOR_PROVIDER_KEY,
    row.organization_id,
    row.provider_id,
    row.config_id,
    row.database_credential_version_id,
    row.topology_version,
    row.node_id,
    row.node_row_version,
    JSON.stringify({
      activationScope: "database_reachability_only",
      executionCapability: "uninstalled",
      sourceCheckPerformed: false,
      sourceCredentialPresent: false,
    }),
    row.source_credential_version_id,
    JSON.stringify({
      adapterVersion:
        dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      checkKind: "bounded_source_and_database_contract",
      platform: COLLECTOR_PROVIDER_KEY,
      databaseRole: "provider",
      schemaVersion: "distributed-provider-v1",
    }),
    ACTIVATION_ACTOR,
    ACTIVATION_ACTION,
  ]);
  const counts = countsResult.rows[0];
  if (countsResult.rows.length !== 1 || counts === undefined) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  return Object.freeze({ row, counts });
}

function exactCollectorBaseState(snapshot: CollectorSnapshot): boolean {
  const { row, counts } = snapshot;
  return row.provider_key === COLLECTOR_PROVIDER_KEY &&
    row.lifecycle === "active" &&
    row.active_config_version_id === row.config_id &&
    isPositiveBigint(row.topology_version) &&
    isPositiveBigint(row.provider_row_version) &&
    counts.provider_count === "1" && counts.node_count === "1" &&
    counts.admin_count === "1" &&
    row.node_key === "primary" && row.node_role === "primary" &&
    row.host === "127.0.0.1" && row.port === 55_434 &&
    row.database_name === "packscout_collector_crypt" &&
    row.ssl_mode === "disable" && row.node_enabled &&
    isPositiveBigint(row.node_row_version) &&
    row.database_credential_kind === "database" &&
    row.database_credential_version_number === "1" &&
    row.database_credential_lifecycle === "active" &&
    row.database_credential_activated_at !== null &&
    row.database_credential_retired_at === null &&
    row.database_credential_revoked_at === null;
}

function exactCollectorBaselineState(snapshot: CollectorSnapshot): boolean {
  const { row, counts } = snapshot;
  return exactCollectorBaseState(snapshot) &&
    row.config_version_number === "1" && counts.config_count === "1" &&
    counts.database_credential_count === "1" &&
    counts.source_credential_count === "0" &&
    row.adapter_key ===
      dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion &&
    row.endpoint_url === DATAFORREST_EVENTS_V1_ENDPOINT &&
    row.source_credential_version_id === null &&
    row.schedule_seconds === 3_600 && row.stale_after_seconds === 86_400 &&
    isExactObject(row.configuration, collectorCryptDataforrestConfiguration()) &&
    row.expires_at === null && row.source_credential_id === null &&
    counts.baseline_activation_count === "1" &&
    counts.live_activation_count === "0" &&
    counts.activation_audit_count === "0";
}

function exactCollectorActiveState(snapshot: CollectorSnapshot): boolean {
  const { row, counts } = snapshot;
  return exactCollectorBaseState(snapshot) &&
    row.config_version_number === "2" && counts.config_count === "2" &&
    counts.database_credential_count === "1" &&
    counts.source_credential_count === "1" &&
    row.adapter_key ===
      dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion &&
    row.endpoint_url === DATAFORREST_EVENTS_V1_ENDPOINT &&
    row.source_credential_version_id !== null &&
    row.schedule_seconds === 3_600 && row.stale_after_seconds === 86_400 &&
    isExactObject(row.configuration, collectorCryptDataforrestConfiguration()) &&
    row.expires_at === null &&
    row.source_credential_id === row.source_credential_version_id &&
    row.source_credential_kind === "source" &&
    row.source_credential_version_number === "1" &&
    row.source_credential_lifecycle === "active" &&
    row.source_credential_activated_at !== null &&
    row.source_credential_retired_at === null &&
    row.source_credential_revoked_at === null &&
    counts.baseline_activation_count === "0" &&
    counts.live_activation_count === "1" &&
    counts.activation_audit_count === "1";
}

function collectorDatabasePins(
  snapshot: CollectorSnapshot,
): Readonly<ProviderReviewActivationDatabasePins> {
  if (!exactCollectorBaseState(snapshot)) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const { row } = snapshot;
  return Object.freeze({
    organizationId: row.organization_id,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    configVersionId: row.config_id,
    providerRowVersion: BigInt(row.provider_row_version),
    topologyVersion: BigInt(row.topology_version),
    nodeId: row.node_id,
    nodeRowVersion: BigInt(row.node_row_version),
    databaseCredentialVersionId: row.database_credential_version_id,
    host: "127.0.0.1",
    port: 55_434,
    databaseName: "packscout_collector_crypt",
    sslMode: "disable",
  });
}

async function readClutchpacksSourceAuthorityRow(input: Readonly<{
  client: SqlClient;
  organizationId: string;
}>): Promise<SourceAuthorityRow> {
  const result = await input.client.query<SourceAuthorityRow>(`
    select provider.id::text as provider_id,
           provider.organization_id::text as organization_id,
           provider.row_version::text as provider_row_version,
           config.id::text as config_id, config.adapter_key,
           config.endpoint_url, config.configuration, config.expires_at,
           credential.id::text as credential_id,
           credential.credential_kind,
           credential.version_number::text as credential_version_number,
           credential.ciphertext, credential.nonce, credential.auth_tag,
           credential.key_version, credential.lifecycle as credential_lifecycle,
           credential.activated_at, credential.retired_at,
           credential.revoked_at
    from providers provider
    join provider_config_versions config
      on config.id = provider.active_config_version_id
     and config.provider_id = provider.id
    join provider_credential_versions credential
      on credential.id = config.source_credential_version_id
     and credential.provider_id = provider.id
    where provider.organization_id = $1::uuid
      and provider.provider_key = $2 and provider.lifecycle = 'active'
  `, [input.organizationId, CLUTCHPACKS_PROVIDER_KEY]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || row === undefined ||
    row.adapter_key !==
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion ||
    row.endpoint_url !== DATAFORREST_EVENTS_V1_ENDPOINT ||
    !isExactObject(row.configuration, { platform: CLUTCHPACKS_PROVIDER_KEY }) ||
    row.expires_at !== null || row.credential_kind !== "source" ||
    !isPositiveBigint(row.credential_version_number) ||
    row.credential_lifecycle !== "active" || row.activated_at === null ||
    row.retired_at !== null || row.revoked_at !== null
  ) {
    refuse("SOURCE_AUTHORITY_UNAVAILABLE");
  }
  return row;
}

function decryptClutchpacksSourceToken(input: Readonly<{
  row: SourceAuthorityRow;
  cipher: AesGcmProviderCredentialCipher;
}>): string {
  try {
    const plaintext = input.cipher.decrypt({
      ciphertext: new Uint8Array(input.row.ciphertext),
      nonce: new Uint8Array(input.row.nonce),
      authTag: new Uint8Array(input.row.auth_tag),
      keyVersion: input.row.key_version,
    }, {
      organizationId: input.row.organization_id,
      providerId: input.row.provider_id,
      revisionId: input.row.credential_id,
    });
    if (
      plaintext.length < 16 || plaintext.length > 4_096 ||
      plaintext.trim() !== plaintext || /[\r\n\0]/u.test(plaintext)
    ) {
      refuse("SOURCE_AUTHORITY_INVALID");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof CollectorCryptDataforrestActivationError) throw error;
    return refuse("SOURCE_AUTHORITY_INVALID");
  }
}

export interface CollectorCryptDataforrestActivationPlanningState {
  readonly state: "active" | "baseline" | "unexpected";
  readonly providerId: string;
  readonly providerKey: "collector_crypt";
  readonly configVersionNumber: number;
}

/** Reads only central metadata; it never decrypts or contacts DataForrest. */
export async function inspectCollectorCryptDataforrestActivationPlanningState(
  pool: Pool,
): Promise<CollectorCryptDataforrestActivationPlanningState> {
  const snapshot = await readCollectorSnapshot(pool);
  return Object.freeze({
    state: exactCollectorActiveState(snapshot)
      ? "active"
      : exactCollectorBaselineState(snapshot)
        ? "baseline"
        : "unexpected",
    providerId: snapshot.row.provider_id,
    providerKey: COLLECTOR_PROVIDER_KEY,
    configVersionNumber: Number(snapshot.row.config_version_number),
  });
}

async function activateCollectorCrypt(input: Readonly<{
  pool: Pool;
  baseline: CollectorSnapshot;
  cipher: AesGcmProviderCredentialCipher;
  databaseProof: Readonly<ProviderReviewActivationDatabaseProof>;
}>): Promise<Readonly<{
  configVersionId: string;
  sourceCredentialVersionId: string;
  liveCheck: Readonly<ProviderReviewSourceLiveCheckResult>;
}>> {
  if (
    input.databaseProof.checkKind !== "pinned_provider_database_gateway" ||
    input.databaseProof.databaseRole !== "provider" ||
    input.databaseProof.schemaVersion !== "distributed-provider-v1" ||
    input.databaseProof.runtimeState !== "idle" ||
    input.databaseProof.idleRequired !== true
  ) {
    refuse("ACTIVATION_DATABASE_PROOF_FAILED");
  }
  const sourceAuthorityRow = await readClutchpacksSourceAuthorityRow({
    client: input.pool,
    organizationId: input.baseline.row.organization_id,
  });
  const authorityPin = sourceAuthorityPin(sourceAuthorityRow);
  let token = decryptClutchpacksSourceToken({
    row: sourceAuthorityRow,
    cipher: input.cipher,
  });
  let liveCheck: Readonly<ProviderReviewSourceLiveCheckResult>;
  let encrypted: ReturnType<AesGcmProviderCredentialCipher["encrypt"]>;
  const sourceCredentialVersionId = randomUUID();
  try {
    liveCheck = await runBoundedProviderReviewSourceLiveCheck({
      providerKey: COLLECTOR_PROVIDER_KEY,
      token,
    });
    encrypted = input.cipher.encrypt(token, {
      organizationId: input.baseline.row.organization_id,
      providerId: input.baseline.row.provider_id,
      revisionId: sourceCredentialVersionId,
    });
  } finally {
    token = "";
  }

  const configVersionId = randomUUID();
  const activationTestId = randomUUID();
  const auditEventId = randomUUID();
  const client = await input.pool.connect();
  try {
    await client.query("begin isolation level serializable");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const lockedIds = [
      input.baseline.row.provider_id,
      authorityPin.providerId,
    ].toSorted();
    const locks = await client.query<{ id: string }>(`
      select id::text from providers
      where id = any($1::uuid[]) order by id for update
    `, [lockedIds]);
    if (locks.rows.length !== 2) refuse("ACTIVATION_STATE_CHANGED");
    const lockedBaseline = await readCollectorSnapshot(
      client,
      input.baseline.row.provider_id,
    );
    if (
      !exactCollectorBaselineState(lockedBaseline) ||
      lockedBaseline.row.provider_row_version !==
        input.baseline.row.provider_row_version ||
      lockedBaseline.row.config_id !== input.baseline.row.config_id ||
      lockedBaseline.row.topology_version !==
        input.baseline.row.topology_version ||
      lockedBaseline.row.node_id !== input.baseline.row.node_id ||
      lockedBaseline.row.node_row_version !== input.baseline.row.node_row_version ||
      lockedBaseline.row.database_credential_version_id !==
        input.baseline.row.database_credential_version_id
    ) {
      refuse("ACTIVATION_STATE_CHANGED");
    }
    const lockedAuthority = await readClutchpacksSourceAuthorityRow({
      client,
      organizationId: input.baseline.row.organization_id,
    });
    if (!pinsMatch(authorityPin, sourceAuthorityPin(lockedAuthority))) {
      refuse("SOURCE_AUTHORITY_CHANGED");
    }

    const now = new Date();
    await client.query(`
      insert into provider_credential_versions (
        id, provider_id, credential_kind, version_number, ciphertext, nonce,
        auth_tag, key_version, lifecycle, activated_at, created_at
      ) values (
        $1::uuid, $2::uuid, 'source', 1, $3, $4, $5, $6,
        'active', $7, $7
      )
    `, [
      sourceCredentialVersionId,
      lockedBaseline.row.provider_id,
      Buffer.from(encrypted.ciphertext),
      Buffer.from(encrypted.nonce),
      Buffer.from(encrypted.authTag),
      encrypted.keyVersion,
      now,
    ]);
    await client.query(`
      insert into provider_config_versions (
        id, provider_id, version_number, adapter_key, endpoint_url,
        source_credential_version_id, schedule_seconds, stale_after_seconds,
        configuration, expires_at, created_by_operator_id, created_at
      ) values (
        $1::uuid, $2::uuid, 2, $3, $4, $5::uuid, 3600, 86400,
        $6::jsonb, null, $7::uuid, $8
      )
    `, [
      configVersionId,
      lockedBaseline.row.provider_id,
      dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
      DATAFORREST_EVENTS_V1_ENDPOINT,
      sourceCredentialVersionId,
      JSON.stringify(collectorCryptDataforrestConfiguration()),
      lockedBaseline.row.created_by_operator_id,
      now,
    ]);
    await client.query(`
      insert into provider_connection_tests (
        id, provider_id, config_version_id, source_credential_version_id,
        database_credential_version_id, topology_version, database_node_id,
        database_node_row_version, target_digest, test_kind, outcome,
        latency_ms, response_status, sanitized_code, result_summary,
        record_counts, has_more, next_cursor_present, tested_by_operator_id,
        tested_at, created_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint,
        $7::uuid, $8::bigint,
        packscout_activation_target_digest_nullable_source(
          $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint,
          $7::uuid, $8::bigint),
        'activation', 'succeeded', $9, $10, null, $11::jsonb,
        $12::jsonb, null, null, $13::uuid, $14, $14
      )
    `, [
      activationTestId,
      lockedBaseline.row.provider_id,
      configVersionId,
      sourceCredentialVersionId,
      lockedBaseline.row.database_credential_version_id,
      lockedBaseline.row.topology_version,
      lockedBaseline.row.node_id,
      lockedBaseline.row.node_row_version,
      Math.round(liveCheck.durationMilliseconds),
      liveCheck.responseStatus,
      JSON.stringify({
        adapterVersion:
          dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
        checkKind: "bounded_source_and_database_contract",
        platform: COLLECTOR_PROVIDER_KEY,
        databaseRole: input.databaseProof.databaseRole,
        schemaVersion: input.databaseProof.schemaVersion,
        databaseProof: input.databaseProof,
        responseBytes: liveCheck.responseBytes,
      }),
      JSON.stringify({ records: liveCheck.recordCount }),
      lockedBaseline.row.created_by_operator_id,
      now,
    ]);
    const update = await client.query(`
      update providers
      set active_config_version_id = $2::uuid,
          row_version = row_version + 1,
          updated_at = greatest($4, updated_at + interval '1 microsecond')
      where id = $1::uuid and row_version = $3::bigint
      returning id
    `, [
      lockedBaseline.row.provider_id,
      configVersionId,
      lockedBaseline.row.provider_row_version,
      now,
    ]);
    if (update.rows.length !== 1) refuse("ACTIVATION_STATE_CHANGED");
    await client.query(`
      insert into audit_events (
        id, organization_id, actor_key, action, subject_type, subject_id,
        outcome, metadata_json, occurred_at
      ) values (
        $1::uuid, $2::uuid, $3, $4, 'provider', $5::uuid, 'success',
        $6::jsonb, $7
      )
    `, [
      auditEventId,
      lockedBaseline.row.organization_id,
      ACTIVATION_ACTOR,
      ACTIVATION_ACTION,
      lockedBaseline.row.provider_id,
      JSON.stringify({
        adapterKey:
          dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
        configVersionNumber: 2,
        endpointHost: new URL(DATAFORREST_EVENTS_V1_ENDPOINT).hostname,
        liveCheckRecordCount: liveCheck.recordCount,
        clonedAuthorityProviderKey: CLUTCHPACKS_PROVIDER_KEY,
        sourceVersionNumber: 1,
        databaseProofKind: input.databaseProof.checkKind,
        databaseProofCheckedAt: input.databaseProof.checkedAt,
      }),
      now,
    ]);
    await client.query(
      "select packscout_assert_provider_activation($1::uuid)",
      [lockedBaseline.row.provider_id],
    );
    await client.query("commit");
    return Object.freeze({
      configVersionId,
      sourceCredentialVersionId,
      liveCheck,
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof CollectorCryptDataforrestActivationError) throw error;
    return refuse("ACTIVATION_TRANSACTION_FAILED");
  } finally {
    client.release();
  }
}

export async function runCollectorCryptDataforrestActivationCli(input: Readonly<{
  argumentsList?: readonly string[];
  processEnvironment?: NodeJS.ProcessEnv;
  write?: (value: string) => void;
}> = {}): Promise<void> {
  assertNoCollectorCryptActivationArguments(
    input.argumentsList ?? process.argv.slice(2),
  );
  const processEnvironment = input.processEnvironment ?? process.env;
  let fileEnvironment: Record<string, string> | null = null;
  let environment: ReturnType<
    typeof readCollectorCryptDataforrestActivationEnvironment
  > | null = null;
  let central: Pool | null = null;
  try {
    fileEnvironment =
      await loadCollectorCryptDataforrestRepositoryEnvironment();
    environment = readCollectorCryptDataforrestActivationEnvironment({
      processEnvironment,
      fileEnvironment,
    });
    central = new Pool({
      connectionString: environment.centralDatabaseUrl,
      max: 1,
    });
    await assertCentralDatabaseIdentity(central);
    const cipher = new AesGcmProviderCredentialCipher({
      primaryVersion: environment.credentialKeyVersion,
      keys: new Map([[
        environment.credentialKeyVersion,
        environment.credentialKey,
      ]]),
    });
    let snapshot = await readCollectorSnapshot(central);
    const alreadyActive = exactCollectorActiveState(snapshot);
    if (!alreadyActive && !exactCollectorBaselineState(snapshot)) {
      refuse("ACTIVATION_STATE_UNEXPECTED");
    }
    const databaseProof = await runPinnedProviderReviewActivationDatabaseProof({
      centralDatabaseUrl: environment.centralDatabaseUrl,
      cipher,
      pins: collectorDatabasePins(snapshot),
      requireIdle: !alreadyActive,
    });
    let outcome: "activated" | "already_active";
    let liveCheck: Readonly<ProviderReviewSourceLiveCheckResult> | null = null;
    if (alreadyActive) {
      outcome = "already_active";
    } else {
      const activation = await activateCollectorCrypt({
        pool: central,
        baseline: snapshot,
        cipher,
        databaseProof,
      });
      liveCheck = activation.liveCheck;
      snapshot = await readCollectorSnapshot(
        central,
        snapshot.row.provider_id,
      );
      if (
        !exactCollectorActiveState(snapshot) ||
        snapshot.row.config_id !== activation.configVersionId ||
        snapshot.row.source_credential_version_id !==
          activation.sourceCredentialVersionId
      ) {
        refuse("ACTIVATION_STATE_UNEXPECTED");
      }
      outcome = "activated";
    }
    await central.query(
      "select packscout_assert_provider_activation($1::uuid)",
      [snapshot.row.provider_id],
    );
    (input.write ?? ((value) => process.stdout.write(value)))(
      `${JSON.stringify({
        outcome,
        providerId: snapshot.row.provider_id,
        providerKey: snapshot.row.provider_key,
        configVersionId: snapshot.row.config_id,
        configVersionNumber: Number(snapshot.row.config_version_number),
        sourceCredentialVersionId: snapshot.row.source_credential_version_id,
        adapterKey: snapshot.row.adapter_key,
        endpointHost: new URL(snapshot.row.endpoint_url).hostname,
        databaseProof,
        liveCheck: liveCheck === null
          ? null
          : {
              durationMilliseconds: liveCheck.durationMilliseconds,
              recordCount: liveCheck.recordCount,
              responseBytes: liveCheck.responseBytes,
              responseStatus: liveCheck.responseStatus,
            },
      })}\n`,
    );
  } finally {
    environment?.credentialKey.fill(0);
    if (fileEnvironment !== null) {
      for (const key of Object.keys(fileEnvironment)) {
        fileEnvironment[key] = "";
        delete fileEnvironment[key];
      }
    }
    await central?.end().catch(() => undefined);
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  runCollectorCryptDataforrestActivationCli().catch((error: unknown) => {
    const safe = safeCollectorCryptDataforrestActivationError(error);
    console.error(JSON.stringify({
      level: "error",
      event: "collector_crypt_dataforrest_activation_failed",
      failureCode: safe.code,
    }));
    process.exitCode = 1;
  });
}
