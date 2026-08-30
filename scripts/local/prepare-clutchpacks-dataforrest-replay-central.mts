import { randomUUID } from "node:crypto";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
} from "@packscout/contracts";
import type { BoundedProviderDatabaseGateway } from "@packscout/database";
import { AesGcmProviderCredentialCipher } from
  "../../packages/services/src/provider-credential-cipher.ts";
import {
  ClutchpacksDataforrestActivationError,
  clutchpacksDataforrestConfiguration,
} from "./activate-clutchpacks-dataforrest-source-plan.mjs";
import { runBoundedClutchpacksDataforrestLiveCheck } from
  "./activate-clutchpacks-dataforrest-source-live-check.mts";
import {
  CLUTCHPACKS_REPLAY_CONFIG_VERSION,
  ClutchpacksReplayPreparationError,
  type ClutchpacksReplayActivationProof,
  type ClutchpacksReplayCentralState,
} from "./prepare-clutchpacks-dataforrest-replay-plan.mts";
import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";

const REPLAY_ACTOR = "system:local-clutchpacks-dataforrest-replay";
const REPLAY_ACTION = "provider.local_dataforrest_replay_prepared";
const PROVIDER_SCHEMA_VERSION = "distributed-provider-v1";

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
  readonly credential_lifecycle: string;
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

interface TestRow extends QueryResultRow {
  readonly id: string;
  readonly source_credential_version_id: string | null;
  readonly database_credential_version_id: string | null;
  readonly topology_version: string;
  readonly database_node_id: string | null;
  readonly database_node_row_version: string | null;
  readonly target_digest: string;
  readonly test_kind: string;
  readonly outcome: string;
  readonly result_summary: unknown;
}

interface AuditRow extends QueryResultRow {
  readonly id: string;
  readonly actor_key: string;
  readonly outcome: string;
  readonly metadata_json: unknown;
}

interface InternalSnapshot {
  readonly provider: ProviderRow;
  readonly configs: readonly ConfigRow[];
  readonly node: NodeRow;
  readonly sourceCredential: SourceCredentialRow;
  readonly v4Tests: readonly TestRow[];
  readonly v4Audits: readonly AuditRow[];
  readonly creatorIsActiveAdmin: boolean;
}

type SqlClient = Pool | PoolClient;

function refuse(
  code: ConstructorParameters<typeof ClutchpacksReplayPreparationError>[0],
): never {
  throw new ClutchpacksReplayPreparationError(code);
}

function positiveBigint(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}

function exactSourceConfiguration(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).platform === "clutchpacks";
}

function exactReplayAuditMetadata(
  value: unknown,
  input: Readonly<{
    v3: ConfigRow;
    v4: ConfigRow;
    topologyVersion: string;
  }>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  const expected = replayAuditMetadata(input);
  const keys = Object.keys(metadata).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every(
    (key, index) => key === expectedKeys[index]
      && metadata[key] === expected[key as keyof typeof expected],
  );
}

function replayAuditMetadata(input: Readonly<{
  v3: ConfigRow;
  v4: ConfigRow;
  topologyVersion: string;
}>): Readonly<Record<string, string | number>> {
  return Object.freeze({
    adapterKey: input.v4.adapter_key,
    configVersionId: input.v4.id,
    configVersionNumber: 4,
    fromConfigVersionId: input.v3.id,
    fromConfigVersionNumber: 3,
    replayCursorPolicy: "clear_on_provider_version_advance",
    reusedSourceCredentialVersion: 1,
    topologyVersion: input.topologyVersion,
  });
}

function configsCopyExactly(v3: ConfigRow, v4: ConfigRow): boolean {
  return v4.version_number === "4"
    && v4.adapter_key === v3.adapter_key
    && v4.endpoint_url === v3.endpoint_url
    && v4.source_credential_version_id === v3.source_credential_version_id
    && v4.schedule_seconds === v3.schedule_seconds
    && v4.stale_after_seconds === v3.stale_after_seconds
    && exactSourceConfiguration(v4.configuration)
    && JSON.stringify(v4.configuration) === JSON.stringify(v3.configuration)
    && v4.expires_at === null
    && v4.created_by_operator_id === v3.created_by_operator_id;
}

function exactV4Test(snapshot: InternalSnapshot, v4: ConfigRow): boolean {
  const test = snapshot.v4Tests[0];
  if (snapshot.v4Tests.length !== 1 || test === undefined) return false;
  const summary = test.result_summary;
  return test.source_credential_version_id === v4.source_credential_version_id
    && test.database_credential_version_id ===
      snapshot.node.credential_version_id
    && test.topology_version === snapshot.provider.topology_version
    && test.database_node_id === snapshot.node.id
    && test.database_node_row_version === snapshot.node.row_version
    && test.test_kind === "activation" && test.outcome === "succeeded"
    && typeof summary === "object" && summary !== null
    && !Array.isArray(summary)
    && (summary as Record<string, unknown>).checkKind ===
      "bounded_source_and_current_topology"
    && (summary as Record<string, unknown>).platform === "clutchpacks"
    && (summary as Record<string, unknown>).observedProviderSchemaVersion ===
      PROVIDER_SCHEMA_VERSION;
}

function baseV3Matches(snapshot: InternalSnapshot): boolean {
  const { provider, configs, node, sourceCredential } = snapshot;
  const v3 = configs.find(({ version_number }) => version_number === "3");
  const versions = configs.map(({ version_number }) => version_number).join(",");
  return v3 !== undefined
    && (versions === "1,2,3" || versions === "1,2,3,4")
    && provider.provider_key === "clutchpacks"
    && provider.lifecycle === "active"
    && provider.active_config_version_id !== null
    && positiveBigint(provider.topology_version)
    && positiveBigint(provider.row_version)
    && v3.adapter_key ===
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion
    && v3.endpoint_url === DATAFORREST_EVENTS_V1_ENDPOINT
    && v3.source_credential_version_id === sourceCredential.id
    && v3.schedule_seconds === 3_600
    && v3.stale_after_seconds === 86_400
    && exactSourceConfiguration(v3.configuration)
    && v3.expires_at === null
    && snapshot.creatorIsActiveAdmin
    && sourceCredential.credential_kind === "source"
    && sourceCredential.version_number === "1"
    && sourceCredential.lifecycle === "active"
    && sourceCredential.activated_at !== null
    && sourceCredential.retired_at === null
    && sourceCredential.revoked_at === null
    && node.node_key === "primary"
    && node.node_role === "primary"
    && node.host === "127.0.0.1"
    && node.port === 55_432
    && node.database_name === "packscout_clutchpacks"
    && node.ssl_mode === "disable"
    && node.enabled
    && positiveBigint(node.row_version)
    && node.credential_kind === "database"
    && node.credential_lifecycle === "active";
}

export function classifyClutchpacksReplayCentralSnapshot(
  snapshot: InternalSnapshot,
): ClutchpacksReplayCentralState {
  const { provider, configs } = snapshot;
  const v3 = configs.find(({ version_number }) => version_number === "3");
  const v4 = configs.find(({ version_number }) => version_number === "4");
  let phase: ClutchpacksReplayCentralState["phase"] = "unexpected";
  if (baseV3Matches(snapshot) && v3 !== undefined) {
    if (
      configs.length === 3
      && v4 === undefined
      && provider.active_config_version_id === v3.id
      && snapshot.v4Tests.length === 0
      && snapshot.v4Audits.length === 0
    ) {
      phase = "v3_active";
    } else if (
      configs.length === 4
      && v4 !== undefined
      && configsCopyExactly(v3, v4)
      && provider.active_config_version_id === v3.id
      && snapshot.v4Tests.length === 0
      && snapshot.v4Audits.length === 0
    ) {
      phase = "v4_candidate";
    } else if (
      configs.length === 4
      && v4 !== undefined
      && configsCopyExactly(v3, v4)
      && provider.active_config_version_id === v4.id
      && exactV4Test(snapshot, v4)
      && snapshot.v4Audits.length === 1
      && snapshot.v4Audits[0]?.actor_key === REPLAY_ACTOR
      && snapshot.v4Audits[0]?.outcome === "success"
      && exactReplayAuditMetadata(snapshot.v4Audits[0]?.metadata_json, {
        v3,
        v4,
        topologyVersion: provider.topology_version,
      })
    ) {
      phase = "v4_active";
    }
  }
  const selected = phase === "v3_active" ? v3 : v4 ?? v3;
  if (selected === undefined) refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
  return Object.freeze({
    phase,
    organizationId: provider.organization_id,
    providerId: provider.id,
    providerKey: "clutchpacks",
    operatorId: selected.created_by_operator_id,
    configVersionId: selected.id,
    configVersionNumber: BigInt(selected.version_number),
    providerRowVersion: BigInt(provider.row_version),
    topologyVersion: BigInt(provider.topology_version),
  });
}

async function readSnapshot(
  client: SqlClient,
  providerId: string,
  lockProvider = false,
): Promise<InternalSnapshot> {
  if (lockProvider) {
    const locked = await client.query(
      "select id from providers where id = $1::uuid for update",
      [providerId],
    );
    if (locked.rows.length !== 1) refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
  }
  const providerResult = await client.query<ProviderRow>(`
    select id, organization_id, provider_key, lifecycle,
           active_config_version_id, topology_version::text, row_version::text
    from providers where id = $1::uuid
  `, [providerId]);
  const provider = providerResult.rows[0];
  if (providerResult.rows.length !== 1 || provider === undefined) {
    refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
  }
  const configsResult = await client.query<ConfigRow>(`
    select id, version_number::text, adapter_key, endpoint_url,
           source_credential_version_id, schedule_seconds,
           stale_after_seconds, configuration, expires_at,
           created_by_operator_id
    from provider_config_versions
    where provider_id = $1::uuid
    order by version_number, id
  `, [provider.id]);
  const v3 = configsResult.rows.find(
    ({ version_number }) => version_number === "3",
  );
  if (v3?.source_credential_version_id === null || v3 === undefined) {
    refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
  }
  const nodesResult = await client.query<NodeRow>(`
    select node.id, node.node_key, node.node_role, node.host, node.port,
           node.database_name, node.ssl_mode, node.credential_version_id,
           node.enabled, node.row_version::text, credential.credential_kind,
           credential.lifecycle as credential_lifecycle
    from provider_database_nodes node
    join provider_credential_versions credential
      on credential.id = node.credential_version_id
     and credential.provider_id = node.provider_id
    where node.provider_id = $1::uuid
  `, [provider.id]);
  if (nodesResult.rows.length !== 1 || nodesResult.rows[0] === undefined) {
    refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
  }
  const sourceResult = await client.query<SourceCredentialRow>(`
    select id, credential_kind, version_number::text, ciphertext, nonce,
           auth_tag, key_version, lifecycle, activated_at, retired_at,
           revoked_at
    from provider_credential_versions
    where id = $1::uuid and provider_id = $2::uuid
  `, [v3.source_credential_version_id, provider.id]);
  if (sourceResult.rows.length !== 1 || sourceResult.rows[0] === undefined) {
    refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
  }
  const v4 = configsResult.rows.find(
    ({ version_number }) => version_number === "4",
  );
  const tests = v4 === undefined
    ? []
    : (await client.query<TestRow>(`
        select id, source_credential_version_id,
               database_credential_version_id, topology_version::text,
               database_node_id, database_node_row_version::text,
               target_digest, test_kind, outcome, result_summary
        from provider_connection_tests
        where provider_id = $1::uuid and config_version_id = $2::uuid
        order by created_at, id
      `, [provider.id, v4.id])).rows;
  const audits = (await client.query<AuditRow>(`
    select id, actor_key, outcome, metadata_json
    from audit_events
    where organization_id = $1::uuid and subject_id = $2::uuid
      and subject_type = 'provider' and action = $3
    order by occurred_at, id
  `, [provider.organization_id, provider.id, REPLAY_ACTION])).rows;
  const admin = await client.query<{ present: boolean }>(`
    select exists(
      select 1 from operator_memberships membership
      join operators operator on operator.id = membership.operator_id
      where membership.organization_id = $1::uuid
        and membership.operator_id = $2::uuid
        and membership.role = 'admin' and operator.state = 'active'
    ) as present
  `, [provider.organization_id, v3.created_by_operator_id]);
  await client.query(
    "select packscout_assert_provider_activation($1::uuid)",
    [provider.id],
  );
  return Object.freeze({
    provider,
    configs: configsResult.rows,
    node: nodesResult.rows[0],
    sourceCredential: sourceResult.rows[0],
    v4Tests: tests,
    v4Audits: audits,
    creatorIsActiveAdmin: admin.rows[0]?.present === true,
  });
}

function assertExpected(
  actual: ClutchpacksReplayCentralState,
  expected: ClutchpacksReplayCentralState,
): void {
  if (
    actual.phase !== expected.phase
    || actual.providerId !== expected.providerId
    || actual.organizationId !== expected.organizationId
    || actual.configVersionId !== expected.configVersionId
    || actual.configVersionNumber !== expected.configVersionNumber
    || actual.providerRowVersion !== expected.providerRowVersion
    || actual.topologyVersion !== expected.topologyVersion
  ) refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
}

export interface ClutchpacksReplayProviderAuthority {
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly configuration: Readonly<{
    adapterKey: string;
    settings: Readonly<{ platform: "clutchpacks" }>;
  }>;
  readonly expiresAt: null;
  readonly scheduleSeconds: number;
}

export class ClutchpacksReplayCentralRepository {
  constructor(private readonly dependencies: Readonly<{
    pool: Pool;
    cipher: AesGcmProviderCredentialCipher;
    activationTargetTester: Pick<
      BoundedProviderDatabaseGateway,
      "testActivationTarget"
    >;
  }>) {}

  async inspect(providerId: string): Promise<ClutchpacksReplayCentralState> {
    return classifyClutchpacksReplayCentralSnapshot(
      await readSnapshot(this.dependencies.pool, providerId),
    );
  }

  async appendV4(
    expected: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayCentralState> {
    if (expected.phase !== "v3_active") {
      refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
    }
    const client = await this.dependencies.pool.connect();
    try {
      await client.query("begin isolation level serializable");
      await client.query("set local statement_timeout = '30s'");
      await client.query("set local lock_timeout = '5s'");
      const locked = await readSnapshot(client, expected.providerId, true);
      const state = classifyClutchpacksReplayCentralSnapshot(locked);
      assertExpected(state, expected);
      const v3 = locked.configs.find(
        ({ version_number }) => version_number === "3",
      )!;
      await client.query(`
        insert into provider_config_versions (
          id, provider_id, version_number, adapter_key, endpoint_url,
          source_credential_version_id, schedule_seconds,
          stale_after_seconds, configuration, expires_at,
          created_by_operator_id, created_at
        )
        select $1::uuid, provider_id, 4, adapter_key, endpoint_url,
               source_credential_version_id, schedule_seconds,
               stale_after_seconds, configuration, expires_at,
               created_by_operator_id, clock_timestamp()
        from provider_config_versions
        where id = $2::uuid and provider_id = $3::uuid
      `, [randomUUID(), v3.id, locked.provider.id]);
      const candidate = classifyClutchpacksReplayCentralSnapshot(
        await readSnapshot(client, expected.providerId, false),
      );
      if (candidate.phase !== "v4_candidate") {
        refuse("REPLAY_V4_APPEND_FAILED");
      }
      await client.query("commit");
      return candidate;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof ClutchpacksReplayPreparationError) throw error;
      return refuse("REPLAY_V4_APPEND_FAILED");
    } finally {
      client.release();
    }
  }

  async testV4(
    candidate: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayActivationProof> {
    const snapshot = await readSnapshot(
      this.dependencies.pool,
      candidate.providerId,
    );
    const state = classifyClutchpacksReplayCentralSnapshot(snapshot);
    assertExpected(state, candidate);
    if (state.phase !== "v4_candidate") {
      refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
    }
    let token: string;
    try {
      token = this.dependencies.cipher.decrypt({
        ciphertext: new Uint8Array(snapshot.sourceCredential.ciphertext),
        nonce: new Uint8Array(snapshot.sourceCredential.nonce),
        authTag: new Uint8Array(snapshot.sourceCredential.auth_tag),
        keyVersion: snapshot.sourceCredential.key_version,
      }, {
        organizationId: snapshot.provider.organization_id,
        providerId: snapshot.provider.id,
        revisionId: snapshot.sourceCredential.id,
      });
    } catch {
      return refuse("REPLAY_V4_TEST_FAILED");
    }
    let liveCheck: Awaited<ReturnType<
      typeof runBoundedClutchpacksDataforrestLiveCheck
    >>;
    try {
      liveCheck = await runBoundedClutchpacksDataforrestLiveCheck({ token });
    } catch (error) {
      if (error instanceof ClutchpacksDataforrestActivationError) {
        return refuse("REPLAY_V4_TEST_FAILED");
      }
      return refuse("REPLAY_V4_TEST_FAILED");
    } finally {
      token = "";
    }
    const topology = await this.dependencies.activationTargetTester
      .testActivationTarget({
        organizationId: state.organizationId,
        providerId: state.providerId,
        configVersionId: state.configVersionId,
        expectedRowVersion: state.providerRowVersion,
      });
    if (
      topology.state !== "reachable"
      || topology.observedSchemaVersion !== PROVIDER_SCHEMA_VERSION
    ) refuse("REPLAY_V4_TEST_FAILED");
    return Object.freeze({
      configVersionId: state.configVersionId,
      providerRowVersion: state.providerRowVersion,
      topologyVersion: state.topologyVersion,
      databaseNodeId: snapshot.node.id,
      databaseNodeRowVersion: BigInt(snapshot.node.row_version),
      databaseCredentialVersionId: snapshot.node.credential_version_id,
      sourceCredentialVersionId: snapshot.sourceCredential.id,
      observedProviderSchemaVersion: topology.observedSchemaVersion,
      durationMilliseconds: liveCheck.durationMilliseconds,
      responseStatus: liveCheck.responseStatus,
      responseBytes: liveCheck.responseBytes,
      recordCount: liveCheck.recordCount,
    });
  }

  async activateV4(
    candidate: ClutchpacksReplayCentralState,
    proof: ClutchpacksReplayActivationProof,
  ): Promise<ClutchpacksReplayCentralState> {
    const client = await this.dependencies.pool.connect();
    try {
      await client.query("begin isolation level serializable");
      await client.query("set local statement_timeout = '30s'");
      await client.query("set local lock_timeout = '5s'");
      const locked = await readSnapshot(client, candidate.providerId, true);
      const state = classifyClutchpacksReplayCentralSnapshot(locked);
      assertExpected(state, candidate);
      const v3 = locked.configs.find(
        ({ version_number }) => version_number === "3",
      )!;
      const v4 = locked.configs.find(
        ({ version_number }) => version_number === "4",
      )!;
      if (
        state.phase !== "v4_candidate"
        || proof.configVersionId !== v4.id
        || proof.providerRowVersion !== BigInt(locked.provider.row_version)
        || proof.topologyVersion !== BigInt(locked.provider.topology_version)
        || proof.databaseNodeId !== locked.node.id
        || proof.databaseNodeRowVersion !== BigInt(locked.node.row_version)
        || proof.databaseCredentialVersionId !==
          locked.node.credential_version_id
        || proof.sourceCredentialVersionId !== locked.sourceCredential.id
        || proof.observedProviderSchemaVersion !== PROVIDER_SCHEMA_VERSION
      ) refuse("REPLAY_V4_ACTIVATION_FAILED");
      const nowResult = await client.query<{ database_now: Date }>(
        "select clock_timestamp() as database_now",
      );
      const now = nowResult.rows[0]?.database_now;
      if (!(now instanceof Date)) refuse("REPLAY_V4_ACTIVATION_FAILED");
      await client.query(`
        insert into provider_connection_tests (
          id, provider_id, config_version_id,
          source_credential_version_id, database_credential_version_id,
          topology_version, database_node_id, database_node_row_version,
          target_digest, test_kind, outcome, latency_ms, response_status,
          sanitized_code, result_summary, record_counts, has_more,
          next_cursor_present, tested_by_operator_id, tested_at, created_at
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
        randomUUID(),
        locked.provider.id,
        v4.id,
        locked.sourceCredential.id,
        locked.node.credential_version_id,
        locked.provider.topology_version,
        locked.node.id,
        locked.node.row_version,
        Math.round(proof.durationMilliseconds),
        proof.responseStatus,
        JSON.stringify({
          checkKind: "bounded_source_and_current_topology",
          observedProviderSchemaVersion: proof.observedProviderSchemaVersion,
          platform: "clutchpacks",
          responseBytes: proof.responseBytes,
        }),
        JSON.stringify({ records: proof.recordCount }),
        v4.created_by_operator_id,
        now,
      ]);
      const activated = await client.query(`
        update providers
        set active_config_version_id = $2::uuid,
            row_version = row_version + 1,
            updated_at = greatest($5, updated_at + interval '1 microsecond')
        where id = $1::uuid
          and active_config_version_id = $3::uuid
          and row_version = $4::bigint
        returning id
      `, [
        locked.provider.id,
        v4.id,
        v3.id,
        locked.provider.row_version,
        now,
      ]);
      if (activated.rows.length !== 1) {
        refuse("REPLAY_V4_ACTIVATION_FAILED");
      }
      await client.query(`
        insert into audit_events (
          id, organization_id, actor_key, action, subject_type, subject_id,
          outcome, metadata_json, occurred_at
        ) values (
          $1::uuid, $2::uuid, $3, $4, 'provider', $5::uuid, 'success',
          $6::jsonb, $7
        )
      `, [
        randomUUID(),
        locked.provider.organization_id,
        REPLAY_ACTOR,
        REPLAY_ACTION,
        locked.provider.id,
        JSON.stringify(replayAuditMetadata({
          v3,
          v4,
          topologyVersion: locked.provider.topology_version,
        })),
        now,
      ]);
      await client.query(
        "select packscout_assert_provider_activation($1::uuid)",
        [locked.provider.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof ClutchpacksReplayPreparationError) throw error;
      return refuse("REPLAY_V4_ACTIVATION_FAILED");
    } finally {
      client.release();
    }
    const active = await this.inspect(candidate.providerId);
    if (active.phase !== "v4_active") {
      refuse("REPLAY_V4_ACTIVATION_FAILED");
    }
    return active;
  }

  async authority(
    expected: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayProviderAuthority> {
    const snapshot = await readSnapshot(
      this.dependencies.pool,
      expected.providerId,
    );
    const state = classifyClutchpacksReplayCentralSnapshot(snapshot);
    assertExpected(state, expected);
    if (state.phase !== "v4_active") {
      refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
    }
    const v4 = snapshot.configs.find(
      ({ version_number }) => version_number === "4",
    )!;
    return Object.freeze({
      configVersionId: v4.id,
      configVersionNumber: CLUTCHPACKS_REPLAY_CONFIG_VERSION,
      configuration: Object.freeze({
        adapterKey: v4.adapter_key,
        settings: clutchpacksDataforrestConfiguration(),
      }),
      expiresAt: null,
      scheduleSeconds: v4.schedule_seconds,
    });
  }
}
