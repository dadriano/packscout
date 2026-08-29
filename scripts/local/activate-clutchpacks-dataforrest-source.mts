#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
} from "@packscout/contracts";
import dotenv from "dotenv";
import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";
import { AesGcmProviderCredentialCipher } from
  "../../packages/services/src/provider-credential-cipher.ts";
import {
  ClutchpacksDataforrestActivationError,
  assertNoClutchpacksActivationArguments,
  clutchpacksDataforrestConfiguration,
  readClutchpacksDataforrestActivationEnvironment,
  safeClutchpacksDataforrestActivationError,
  safeClutchpacksDataforrestSnapshotError,
  takeOptionalClutchpacksDataforrestToken,
} from "./activate-clutchpacks-dataforrest-source-plan.mjs";
import { runBoundedClutchpacksDataforrestLiveCheck } from
  "./activate-clutchpacks-dataforrest-source-live-check.mts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repositoryEnvironmentPath = path.join(repositoryRoot, ".env");
const LOCAL_CAPTURE_ADAPTER = "local-capture-clutchpacks-v1";
const LOCAL_CAPTURE_ENDPOINT = "https://clutchpacks.local.invalid/capture";
const ACTIVATION_ACTOR = "system:local-clutchpacks-dataforrest-activation";
const ACTIVATION_ACTION = "provider.local_dataforrest_activation";
const ADAPTER_PROFILE_UPGRADE_ACTION =
  "provider.local_dataforrest_adapter_profile_upgrade";

interface ProviderRow extends QueryResultRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_key: string;
  readonly lifecycle: string;
  readonly active_config_version_id: string | null;
  readonly topology_version: string;
  readonly row_version: string;
}

interface ConfigRow extends QueryResultRow {
  readonly id: string;
  readonly version_number: string;
  readonly adapter_key: string;
  readonly endpoint_url: string;
  readonly source_credential_version_id: string | null;
  readonly schedule_seconds: number;
  readonly stale_after_seconds: number;
  readonly configuration: unknown;
  readonly expires_at: Date | null;
  readonly created_by_operator_id: string;
}

interface NodeRow extends QueryResultRow {
  readonly id: string;
  readonly node_key: string;
  readonly node_role: string;
  readonly host: string;
  readonly port: number;
  readonly database_name: string;
  readonly ssl_mode: string;
  readonly credential_version_id: string;
  readonly enabled: boolean;
  readonly row_version: string;
  readonly credential_kind: string;
  readonly credential_version_number: string;
  readonly credential_lifecycle: string;
  readonly credential_activated_at: Date | null;
  readonly credential_retired_at: Date | null;
  readonly credential_revoked_at: Date | null;
}

interface SourceCredentialRow extends QueryResultRow {
  readonly id: string;
  readonly credential_kind: string;
  readonly version_number: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly auth_tag: Buffer;
  readonly key_version: number;
  readonly lifecycle: string;
  readonly activated_at: Date | null;
  readonly retired_at: Date | null;
  readonly revoked_at: Date | null;
}

interface CountRow extends QueryResultRow {
  readonly provider_count: string;
  readonly config_count: string;
  readonly credential_count: string;
  readonly source_credential_count: string;
  readonly node_count: string;
  readonly admin_count: string;
  readonly admin_operator_id: string | null;
}

interface EvidenceRow extends QueryResultRow {
  readonly exact_test_count: string;
  readonly audit_count: string;
}

interface ActivationSnapshot {
  readonly provider: ProviderRow;
  readonly config: ConfigRow;
  readonly node: NodeRow;
  readonly sourceCredential: SourceCredentialRow | null;
  readonly counts: CountRow;
  readonly evidence: EvidenceRow;
}

type SqlClient = Pool | PoolClient;

function refuse(code: string): never {
  throw new ClutchpacksDataforrestActivationError(code);
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

async function loadRepositoryEnvironment(): Promise<Record<string, string>> {
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
    if (error instanceof ClutchpacksDataforrestActivationError) throw error;
    return refuse("ACTIVATION_ENVIRONMENT_FILE_UNSAFE");
  }
}

async function assertDatabaseIdentity(input: Readonly<{
  pool: Pool;
  databaseName: string;
  databaseRole: "central" | "provider";
  providerId: string | null;
  providerKey: string | null;
  schemaVersion: string;
  username: string;
  port: number;
}>): Promise<void> {
  const result = await input.pool.query<{
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
    row.current_database !== input.databaseName ||
    row.current_user !== input.username || row.server_port !== input.port ||
    row.database_role !== input.databaseRole ||
    row.schema_version !== input.schemaVersion ||
    row.provider_id !== input.providerId || row.provider_key !== input.providerKey
  ) {
    refuse("ACTIVATION_DATABASE_IDENTITY_MISMATCH");
  }
}

async function readActivationSnapshot(
  client: SqlClient,
  providerId: string,
  lockProvider = false,
): Promise<ActivationSnapshot> {
  if (lockProvider) {
    const lock = await client.query(
      "select id from providers where id = $1::uuid for update",
      [providerId],
    );
    if (lock.rows.length !== 1) refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const providerResult = await client.query<ProviderRow>(`
    select id, organization_id, provider_key, lifecycle,
           active_config_version_id, topology_version::text,
           row_version::text
    from providers where id = $1::uuid
  `, [providerId]);
  const provider = providerResult.rows[0];
  if (providerResult.rows.length !== 1 || provider === undefined ||
      provider.active_config_version_id === null) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const configResult = await client.query<ConfigRow>(`
    select id, version_number::text, adapter_key, endpoint_url,
           source_credential_version_id, schedule_seconds, stale_after_seconds,
           configuration, expires_at, created_by_operator_id
    from provider_config_versions
    where id = $1::uuid and provider_id = $2::uuid
  `, [provider.active_config_version_id, provider.id]);
  const nodesResult = await client.query<NodeRow>(`
    select node.id, node.node_key, node.node_role, node.host, node.port,
           node.database_name, node.ssl_mode, node.credential_version_id,
           node.enabled, node.row_version::text,
           credential.credential_kind,
           credential.version_number::text as credential_version_number,
           credential.lifecycle as credential_lifecycle,
           credential.activated_at as credential_activated_at,
           credential.retired_at as credential_retired_at,
           credential.revoked_at as credential_revoked_at
    from provider_database_nodes node
    join provider_credential_versions credential
      on credential.id = node.credential_version_id
     and credential.provider_id = node.provider_id
    where node.provider_id = $1::uuid
  `, [provider.id]);
  const countResult = await client.query<CountRow>(`
    select
      (select count(*)::text from providers where provider_key = 'clutchpacks')
        as provider_count,
      (select count(*)::text from provider_config_versions
       where provider_id = $1::uuid) as config_count,
      (select count(*)::text from provider_credential_versions
       where provider_id = $1::uuid) as credential_count,
      (select count(*)::text from provider_credential_versions
       where provider_id = $1::uuid and credential_kind = 'source')
        as source_credential_count,
      (select count(*)::text from provider_database_nodes
       where provider_id = $1::uuid) as node_count,
      (select count(*)::text from operator_memberships membership
       join operators operator on operator.id = membership.operator_id
       where membership.organization_id = $2::uuid
         and membership.role = 'admin' and operator.state = 'active')
        as admin_count,
      (select operator.id::text from operator_memberships membership
       join operators operator on operator.id = membership.operator_id
       where membership.organization_id = $2::uuid
         and membership.role = 'admin' and operator.state = 'active'
       order by operator.id::text
       limit 1)
        as admin_operator_id
  `, [provider.id, provider.organization_id]);
  const config = configResult.rows[0];
  const node = nodesResult.rows[0];
  const counts = countResult.rows[0];
  if (configResult.rows.length !== 1 || config === undefined ||
      nodesResult.rows.length !== 1 || node === undefined ||
      counts === undefined) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const sourceResult = config.source_credential_version_id === null
    ? { rows: [] as SourceCredentialRow[] }
    : await client.query<SourceCredentialRow>(`
        select id, credential_kind, version_number::text, ciphertext, nonce,
               auth_tag, key_version, lifecycle, activated_at, retired_at,
               revoked_at
        from provider_credential_versions
        where id = $1::uuid and provider_id = $2::uuid
      `, [config.source_credential_version_id, provider.id]);
  const evidenceResult = await client.query<EvidenceRow>(`
    select
      (select count(*)::text from provider_connection_tests test
       where test.provider_id = $1::uuid
         and test.config_version_id = $2::uuid
         and test.source_credential_version_id is not distinct from $3::uuid
         and test.database_credential_version_id = $4::uuid
         and test.topology_version = $5::bigint
         and test.database_node_id = $6::uuid
         and test.database_node_row_version = $7::bigint
         and test.target_digest = packscout_activation_target_digest_nullable_source(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint,
           $6::uuid, $7::bigint
         ) and test.test_kind = 'activation' and test.outcome = 'succeeded')
        as exact_test_count,
      (select count(*)::text from audit_events
       where organization_id = $8::uuid and subject_id = $1::uuid
         and actor_key = $9 and action in ($10, $11) and outcome = 'success')
        as audit_count
  `, [
    provider.id,
    config.id,
    config.source_credential_version_id,
    node.credential_version_id,
    provider.topology_version,
    node.id,
    node.row_version,
    provider.organization_id,
    ACTIVATION_ACTOR,
    ACTIVATION_ACTION,
    ADAPTER_PROFILE_UPGRADE_ACTION,
  ]);
  return Object.freeze({
    provider,
    config,
    node,
    sourceCredential: sourceResult.rows[0] ?? null,
    counts,
    evidence: evidenceResult.rows[0] ?? refuse("ACTIVATION_STATE_UNEXPECTED"),
  });
}

function baseStateMatches(snapshot: ActivationSnapshot): boolean {
  const { provider, node, counts } = snapshot;
  return provider.provider_key === "clutchpacks" &&
    provider.lifecycle === "active" &&
    isPositiveBigint(provider.topology_version) &&
    isPositiveBigint(provider.row_version) &&
    counts.provider_count === "1" && counts.node_count === "1" &&
    counts.admin_count === "1" && counts.admin_operator_id !== null &&
    node.node_key === "primary" && node.node_role === "primary" &&
    node.host === "127.0.0.1" && node.port === 55_432 &&
    node.database_name === "packscout_clutchpacks" &&
    node.ssl_mode === "disable" && node.enabled &&
    isPositiveBigint(node.row_version) &&
    node.credential_kind === "database" &&
    node.credential_version_number === "1" &&
    node.credential_lifecycle === "active" &&
    node.credential_activated_at !== null &&
    node.credential_retired_at === null && node.credential_revoked_at === null;
}

function baselineStateMatches(snapshot: ActivationSnapshot): boolean {
  const { config, counts } = snapshot;
  return baseStateMatches(snapshot) && counts.config_count === "1" &&
    counts.credential_count === "1" &&
    counts.source_credential_count === "0" &&
    config.version_number === "1" &&
    config.adapter_key === LOCAL_CAPTURE_ADAPTER &&
    config.endpoint_url === LOCAL_CAPTURE_ENDPOINT &&
    config.source_credential_version_id === null &&
    config.schedule_seconds === 3_600 && config.stale_after_seconds === 86_400 &&
    isExactObject(config.configuration, { adapterKey: LOCAL_CAPTURE_ADAPTER }) &&
    config.expires_at === null &&
    config.created_by_operator_id === counts.admin_operator_id &&
    snapshot.sourceCredential === null;
}

function activeDataforrestStateMatches(snapshot: ActivationSnapshot): boolean {
  const { config, counts, sourceCredential, evidence } = snapshot;
  const exactVersionShape =
    (config.version_number === "2" && counts.config_count === "2" &&
      evidence.audit_count === "1") ||
    (config.version_number === "3" && counts.config_count === "3" &&
      evidence.audit_count === "2");
  return baseStateMatches(snapshot) && exactVersionShape &&
    counts.credential_count === "2" &&
    counts.source_credential_count === "1" &&
    config.adapter_key ===
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion &&
    config.endpoint_url === DATAFORREST_EVENTS_V1_ENDPOINT &&
    config.source_credential_version_id !== null &&
    config.schedule_seconds === 3_600 && config.stale_after_seconds === 86_400 &&
    isExactObject(config.configuration, clutchpacksDataforrestConfiguration()) &&
    config.expires_at === null &&
    config.created_by_operator_id === counts.admin_operator_id &&
    sourceCredential !== null &&
    sourceCredential.id === config.source_credential_version_id &&
    sourceCredential.credential_kind === "source" &&
    sourceCredential.version_number === "1" &&
    sourceCredential.lifecycle === "active" &&
    sourceCredential.activated_at !== null &&
    sourceCredential.retired_at === null &&
    sourceCredential.revoked_at === null &&
    evidence.exact_test_count === "1";
}

/**
 * Temporary, exact local-review transition from the already-activated shared
 * v3 profile. Remove after all pre-launch local databases report dedicated
 * config v3; this is not a generic compatibility read or runtime fallback.
 */
function transitionalDataforrestV2StateMatches(
  snapshot: ActivationSnapshot,
): boolean {
  const { config, counts, sourceCredential, evidence } = snapshot;
  return baseStateMatches(snapshot) && counts.config_count === "2" &&
    counts.credential_count === "2" &&
    counts.source_credential_count === "1" &&
    config.version_number === "2" &&
    config.adapter_key === dataforrestEventsV1SourceAdapterManifest.adapterVersion &&
    config.endpoint_url === DATAFORREST_EVENTS_V1_ENDPOINT &&
    config.source_credential_version_id !== null &&
    config.schedule_seconds === 3_600 && config.stale_after_seconds === 86_400 &&
    isExactObject(config.configuration, clutchpacksDataforrestConfiguration()) &&
    config.expires_at === null &&
    config.created_by_operator_id === counts.admin_operator_id &&
    sourceCredential !== null &&
    sourceCredential.id === config.source_credential_version_id &&
    sourceCredential.credential_kind === "source" &&
    sourceCredential.version_number === "1" &&
    sourceCredential.lifecycle === "active" &&
    sourceCredential.activated_at !== null &&
    sourceCredential.retired_at === null &&
    sourceCredential.revoked_at === null &&
    evidence.exact_test_count === "1" && evidence.audit_count === "1";
}

async function readPlanningSnapshot(
  pool: Pool,
  providerId: string,
): Promise<ActivationSnapshot> {
  try {
    return await readActivationSnapshot(pool, providerId);
  } catch (error) {
    throw safeClutchpacksDataforrestSnapshotError(error);
  }
}

export interface ClutchpacksDataforrestActivationPlanningState {
  readonly state: "active" | "baseline" | "upgrade_required" | "unexpected";
  readonly providerKey: string;
  readonly configVersionNumber: number;
  readonly adminOperatorPresent: boolean;
}

/**
 * Exercises the production activation snapshot query and state classification
 * without reading a source credential or making a provider request.
 */
export async function inspectClutchpacksDataforrestActivationPlanningState(
  pool: Pool,
  providerId: string,
): Promise<ClutchpacksDataforrestActivationPlanningState> {
  const snapshot = await readPlanningSnapshot(pool, providerId);
  return Object.freeze({
    state: activeDataforrestStateMatches(snapshot)
      ? "active"
      : transitionalDataforrestV2StateMatches(snapshot)
        ? "upgrade_required"
      : baselineStateMatches(snapshot)
        ? "baseline"
        : "unexpected",
    providerKey: snapshot.provider.provider_key,
    configVersionNumber: Number(snapshot.config.version_number),
    adminOperatorPresent: snapshot.counts.admin_operator_id !== null,
  });
}

function decryptSnapshotSourceToken(input: Readonly<{
  snapshot: ActivationSnapshot;
  cipher: AesGcmProviderCredentialCipher;
}>): string {
  if (
    !activeDataforrestStateMatches(input.snapshot) &&
    !transitionalDataforrestV2StateMatches(input.snapshot)
  ) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const source = input.snapshot.sourceCredential!;
  try {
    return input.cipher.decrypt({
      ciphertext: new Uint8Array(source.ciphertext),
      nonce: new Uint8Array(source.nonce),
      authTag: new Uint8Array(source.auth_tag),
      keyVersion: source.key_version,
    }, {
      organizationId: input.snapshot.provider.organization_id,
      providerId: input.snapshot.provider.id,
      revisionId: source.id,
    });
  } catch {
    return refuse("ACTIVATION_ACTIVE_CREDENTIAL_INVALID");
  }
}

function assertTokenMatchesKnownState(input: Readonly<{
  snapshot: ActivationSnapshot;
  token: string;
  cipher: AesGcmProviderCredentialCipher;
}>): void {
  if (
    !activeDataforrestStateMatches(input.snapshot) &&
    !transitionalDataforrestV2StateMatches(input.snapshot)
  ) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  let decrypted = decryptSnapshotSourceToken(input);
  const actual = Buffer.from(decrypted, "utf8");
  const expected = Buffer.from(input.token, "utf8");
  const matches = actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected);
  actual.fill(0);
  expected.fill(0);
  decrypted = "";
  if (!matches) refuse("ACTIVATION_ACTIVE_CREDENTIAL_MISMATCH");
}

async function activateDataforrest(input: Readonly<{
  pool: Pool;
  baseline: ActivationSnapshot;
  token: string;
  cipher: AesGcmProviderCredentialCipher;
}>): Promise<Readonly<{ configVersionId: string; sourceCredentialVersionId: string }>> {
  const sourceCredentialVersionId = randomUUID();
  const configVersionId = randomUUID();
  const activationTestId = randomUUID();
  const auditEventId = randomUUID();
  const liveCheck = await runBoundedClutchpacksDataforrestLiveCheck({
    token: input.token,
  });
  const encrypted = input.cipher.encrypt(input.token, {
    organizationId: input.baseline.provider.organization_id,
    providerId: input.baseline.provider.id,
    revisionId: sourceCredentialVersionId,
  });
  const client = await input.pool.connect();
  try {
    await client.query("begin isolation level serializable");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const locked = await readActivationSnapshot(
      client,
      input.baseline.provider.id,
      true,
    );
    if (!baselineStateMatches(locked) ||
        locked.provider.row_version !== input.baseline.provider.row_version) {
      refuse("ACTIVATION_STATE_CHANGED");
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
      locked.provider.id,
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
      locked.provider.id,
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
      DATAFORREST_EVENTS_V1_ENDPOINT,
      sourceCredentialVersionId,
      JSON.stringify(clutchpacksDataforrestConfiguration()),
      locked.counts.admin_operator_id,
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
          $7::uuid, $8::bigint
        ), 'activation', 'succeeded', $9, $10, null, $11::jsonb,
        $12::jsonb, null, null, $13::uuid, $14, $14
      )
    `, [
      activationTestId,
      locked.provider.id,
      configVersionId,
      sourceCredentialVersionId,
      locked.node.credential_version_id,
      locked.provider.topology_version,
      locked.node.id,
      locked.node.row_version,
      Math.round(liveCheck.durationMilliseconds),
      liveCheck.responseStatus,
      JSON.stringify({
        adapterVersion:
          dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
        checkKind: "bounded_source_contract",
        platform: "clutchpacks",
        responseBytes: liveCheck.responseBytes,
      }),
      JSON.stringify({ records: liveCheck.recordCount }),
      locked.counts.admin_operator_id,
      now,
    ]);
    const update = await client.query(`
      update providers
      set active_config_version_id = $2::uuid,
          row_version = row_version + 1,
          updated_at = greatest($4, updated_at + interval '1 microsecond')
      where id = $1::uuid and row_version = $3::bigint
      returning id
    `, [locked.provider.id, configVersionId, locked.provider.row_version, now]);
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
      locked.provider.organization_id,
      ACTIVATION_ACTOR,
      ACTIVATION_ACTION,
      locked.provider.id,
      JSON.stringify({
        adapterKey:
          dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
        configVersionNumber: 2,
        endpointHost: new URL(DATAFORREST_EVENTS_V1_ENDPOINT).hostname,
        liveCheckRecordCount: liveCheck.recordCount,
        sourceVersionNumber: 1,
      }),
      now,
    ]);
    await client.query("commit");
    return Object.freeze({ configVersionId, sourceCredentialVersionId });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof ClutchpacksDataforrestActivationError) throw error;
    return refuse("ACTIVATION_TRANSACTION_FAILED");
  } finally {
    client.release();
  }
}

async function upgradeDataforrestAdapterProfile(input: Readonly<{
  pool: Pool;
  transitional: ActivationSnapshot;
  cipher: AesGcmProviderCredentialCipher;
}>): Promise<Readonly<{
  configVersionId: string;
  sourceCredentialVersionId: string;
}>> {
  if (!transitionalDataforrestV2StateMatches(input.transitional)) {
    refuse("ACTIVATION_STATE_UNEXPECTED");
  }
  const sourceCredentialVersionId =
    input.transitional.config.source_credential_version_id!;
  let token = decryptSnapshotSourceToken({
    snapshot: input.transitional,
    cipher: input.cipher,
  });
  let liveCheck: Awaited<ReturnType<
    typeof runBoundedClutchpacksDataforrestLiveCheck
  >>;
  try {
    liveCheck = await runBoundedClutchpacksDataforrestLiveCheck({ token });
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
    const locked = await readActivationSnapshot(
      client,
      input.transitional.provider.id,
      true,
    );
    if (
      !transitionalDataforrestV2StateMatches(locked) ||
      locked.provider.row_version !== input.transitional.provider.row_version ||
      locked.config.source_credential_version_id !== sourceCredentialVersionId
    ) {
      refuse("ACTIVATION_STATE_CHANGED");
    }
    const now = new Date();
    await client.query(`
      insert into provider_config_versions (
        id, provider_id, version_number, adapter_key, endpoint_url,
        source_credential_version_id, schedule_seconds, stale_after_seconds,
        configuration, expires_at, created_by_operator_id, created_at
      ) values (
        $1::uuid, $2::uuid, 3, $3, $4, $5::uuid, 3600, 86400,
        $6::jsonb, null, $7::uuid, $8
      )
    `, [
      configVersionId,
      locked.provider.id,
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
      DATAFORREST_EVENTS_V1_ENDPOINT,
      sourceCredentialVersionId,
      JSON.stringify(clutchpacksDataforrestConfiguration()),
      locked.counts.admin_operator_id,
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
          $7::uuid, $8::bigint
        ), 'activation', 'succeeded', $9, $10, null, $11::jsonb,
        $12::jsonb, null, null, $13::uuid, $14, $14
      )
    `, [
      activationTestId,
      locked.provider.id,
      configVersionId,
      sourceCredentialVersionId,
      locked.node.credential_version_id,
      locked.provider.topology_version,
      locked.node.id,
      locked.node.row_version,
      Math.round(liveCheck.durationMilliseconds),
      liveCheck.responseStatus,
      JSON.stringify({
        adapterVersion:
          dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
        checkKind: "bounded_source_contract_profile_upgrade",
        platform: "clutchpacks",
        responseBytes: liveCheck.responseBytes,
        reusedSourceCredentialVersion: 1,
      }),
      JSON.stringify({ records: liveCheck.recordCount }),
      locked.counts.admin_operator_id,
      now,
    ]);
    const update = await client.query(`
      update providers
      set active_config_version_id = $2::uuid,
          row_version = row_version + 1,
          updated_at = greatest($4, updated_at + interval '1 microsecond')
      where id = $1::uuid and row_version = $3::bigint
      returning id
    `, [locked.provider.id, configVersionId, locked.provider.row_version, now]);
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
      locked.provider.organization_id,
      ACTIVATION_ACTOR,
      ADAPTER_PROFILE_UPGRADE_ACTION,
      locked.provider.id,
      JSON.stringify({
        adapterKey:
          dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
        configVersionNumber: 3,
        endpointHost: new URL(DATAFORREST_EVENTS_V1_ENDPOINT).hostname,
        fromAdapterKey: dataforrestEventsV1SourceAdapterManifest.adapterVersion,
        liveCheckRecordCount: liveCheck.recordCount,
        reusedSourceCredentialVersion: 1,
      }),
      now,
    ]);
    await client.query("commit");
    return Object.freeze({ configVersionId, sourceCredentialVersionId });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof ClutchpacksDataforrestActivationError) throw error;
    return refuse("ACTIVATION_TRANSACTION_FAILED");
  } finally {
    client.release();
  }
}

export async function runClutchpacksDataforrestActivationCli(input: Readonly<{
  argumentsList?: readonly string[];
  processEnvironment?: NodeJS.ProcessEnv;
  write?: (value: string) => void;
}> = {}): Promise<void> {
  assertNoClutchpacksActivationArguments(
    input.argumentsList ?? process.argv.slice(2),
  );
  const processEnvironment = input.processEnvironment ?? process.env;
  let token = takeOptionalClutchpacksDataforrestToken(processEnvironment);
  let fileEnvironment: Record<string, string> | null = null;
  let environment: ReturnType<
    typeof readClutchpacksDataforrestActivationEnvironment
  > | null = null;
  let central: Pool | null = null;
  let provider: Pool | null = null;
  try {
    fileEnvironment = await loadRepositoryEnvironment();
    environment = readClutchpacksDataforrestActivationEnvironment({
      processEnvironment,
      fileEnvironment,
    });
    const centralUrl = new URL(environment.centralDatabaseUrl);
    const providerUrl = new URL(environment.providerDatabaseUrl);
    central = new Pool({ connectionString: environment.centralDatabaseUrl, max: 1 });
    provider = new Pool({ connectionString: environment.providerDatabaseUrl, max: 1 });
    await assertDatabaseIdentity({
      pool: central,
      databaseName: "packscout",
      databaseRole: "central",
      providerId: null,
      providerKey: null,
      schemaVersion: "distributed-central-v1",
      username: decodeURIComponent(centralUrl.username),
      port: 55_431,
    });
    await assertDatabaseIdentity({
      pool: provider,
      databaseName: "packscout_clutchpacks",
      databaseRole: "provider",
      providerId: environment.providerId,
      providerKey: "clutchpacks",
      schemaVersion: "distributed-provider-v1",
      username: decodeURIComponent(providerUrl.username),
      port: 55_432,
    });
    const cipher = new AesGcmProviderCredentialCipher({
      primaryVersion: environment.credentialKeyVersion,
      keys: new Map([[
        environment.credentialKeyVersion,
        environment.credentialKey,
      ]]),
    });
    let snapshot = await readPlanningSnapshot(central, environment.providerId);
    let outcome: "activated" | "already_active" | "upgraded";
    if (activeDataforrestStateMatches(snapshot)) {
      if (token !== null) {
        assertTokenMatchesKnownState({ snapshot, token, cipher });
      }
      outcome = "already_active";
    } else if (transitionalDataforrestV2StateMatches(snapshot)) {
      if (token !== null) {
        assertTokenMatchesKnownState({ snapshot, token, cipher });
      }
      await upgradeDataforrestAdapterProfile({
        pool: central,
        transitional: snapshot,
        cipher,
      });
      snapshot = await readPlanningSnapshot(central, environment.providerId);
      if (!activeDataforrestStateMatches(snapshot)) {
        refuse("ACTIVATION_STATE_UNEXPECTED");
      }
      outcome = "upgraded";
    } else {
      if (!baselineStateMatches(snapshot)) refuse("ACTIVATION_STATE_UNEXPECTED");
      if (token === null) refuse("DATAFORREST_TOKEN_REQUIRED");
      await activateDataforrest({ pool: central, baseline: snapshot, token, cipher });
      snapshot = await readPlanningSnapshot(central, environment.providerId);
      assertTokenMatchesKnownState({ snapshot, token, cipher });
      outcome = "activated";
    }
    await central.query(
      "select packscout_assert_provider_activation($1::uuid)",
      [environment.providerId],
    );
    (input.write ?? ((value) => process.stdout.write(value)))(
      `${JSON.stringify({
        outcome,
        providerId: snapshot.provider.id,
        providerKey: snapshot.provider.provider_key,
        configVersionId: snapshot.config.id,
        configVersionNumber: Number(snapshot.config.version_number),
        adapterKey: snapshot.config.adapter_key,
        endpointHost: new URL(snapshot.config.endpoint_url).hostname,
      })}\n`,
    );
  } finally {
    token = null;
    environment?.credentialKey.fill(0);
    if (fileEnvironment !== null) {
      for (const key of Object.keys(fileEnvironment)) {
        fileEnvironment[key] = "";
        delete fileEnvironment[key];
      }
    }
    await Promise.all([
      central?.end().catch(() => undefined),
      provider?.end().catch(() => undefined),
    ]);
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  runClutchpacksDataforrestActivationCli().catch((error: unknown) => {
    const safe = safeClutchpacksDataforrestActivationError(error);
    console.error(JSON.stringify({
      level: "error",
      event: "clutchpacks_dataforrest_activation_failed",
      failureCode: safe.code,
    }));
    process.exitCode = 1;
  });
}
