#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
} from "@packscout/contracts";
import {
  BoundedProviderDatabaseGateway,
  ProviderDatabaseDestinationPolicy,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  createCentralDatabaseLifecycle,
  locateProviderDatabase,
  providerMixedCursorFingerprint,
  type CentralPrismaClient,
  type CentralQueryClient,
  type CanonicalJsonValue,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import { loadPhygitalsDataforrestRepositoryEnvironment } from
  "./activate-phygitals-dataforrest-source.mts";
import { readPhygitalsDataforrestActivationEnvironment } from
  "./activate-phygitals-dataforrest-source-plan.mjs";
import {
  assertProviderReviewActivationDatabaseRoute,
  runPinnedProviderReviewActivationDatabaseProof,
  type ProviderReviewActivationDatabaseProof,
} from "./provider-review-activation-database-proof.mts";
import {
  PhygitalsCardV4ReplayError,
  assertPhygitalsV4ReplaySnapshot,
  executeGuardedPhygitalsV4Replay,
  phygitalsV4ReplayPins as pins,
  probePhygitalsV4CardMapping,
  refusePhygitalsV4Replay as refuse,
  type PhygitalsV4ReplaySnapshot,
} from "./prepare-phygitals-native-card-v4-replay-plan.mts";

const replayAction = "provider.local_phygitals_card_v4_replay_prepared";
const newAdapter = DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION;

function exactConfiguration(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && (value as Record<string, unknown>).platform === "phygitals";
}

async function centralSnapshot(client: CentralQueryClient) {
  const [provider, previous, configCount, sourceCount] = await Promise.all([
    client.providers.findUniqueOrThrow({ where: { id: pins.providerId }, include: {
      active_config_version: { include: { source_credential: true } },
      database_nodes: { include: { credential: true } },
    } }),
    client.provider_config_versions.findUniqueOrThrow({ where: { id: pins.previousConfigId } }),
    client.provider_config_versions.count({ where: { provider_id: pins.providerId } }),
    client.provider_credential_versions.count({ where: { provider_id: pins.providerId, credential_kind: "source" } }),
  ]);
  const config = provider.active_config_version;
  const source = config?.source_credential;
  const node = provider.database_nodes[0];
  const phase = provider.active_config_version_id === pins.previousConfigId ? "previous"
    : provider.active_config_version_id === pins.configId ? "prepared" : "unexpected";
  if (
    phase === "unexpected" || provider.organization_id !== pins.organizationId ||
    provider.provider_key !== "phygitals" || provider.lifecycle !== "active" ||
    provider.topology_version !== 2n || provider.row_version !== (phase === "previous" ? 5n : 6n) ||
    provider.database_nodes.length !== 1 || node === undefined ||
    node.id !== pins.nodeId || node.row_version !== 1n || !node.enabled ||
    node.credential_version_id !== pins.databaseCredentialId ||
    node.host !== "127.0.0.1" || node.port !== 55_435 ||
    node.database_name !== "packscout_phygitals" || node.ssl_mode !== "disable" ||
    node.credential.provider_id !== pins.providerId || node.credential.credential_kind !== "database" ||
    node.credential.lifecycle !== "active" || node.credential.retired_at !== null ||
    node.credential.revoked_at !== null ||
    config === null || config.provider_id !== pins.providerId ||
    config.version_number !== (phase === "previous" ? 3n : 4n) ||
    config.adapter_key !== (phase === "previous" ? DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION : newAdapter) ||
    config.endpoint_url !== DATAFORREST_EVENTS_V1_ENDPOINT ||
    config.source_credential_version_id !== pins.sourceCredentialId ||
    config.schedule_seconds !== 3_600 || config.stale_after_seconds !== 86_400 ||
    config.expires_at !== null || !exactConfiguration(config.configuration) ||
    source === null || source === undefined || source.id !== pins.sourceCredentialId ||
    source.provider_id !== pins.providerId || source.credential_kind !== "source" ||
    source.lifecycle !== "active" || source.version_number !== 1n ||
    source.activated_at === null || source.activated_at.getTime() > Date.now() ||
    source.retired_at !== null || source.revoked_at !== null ||
    previous.provider_id !== pins.providerId || previous.version_number !== 3n ||
    previous.adapter_key !== DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION ||
    previous.source_credential_version_id !== pins.sourceCredentialId ||
    previous.endpoint_url !== DATAFORREST_EVENTS_V1_ENDPOINT ||
    !exactConfiguration(previous.configuration) || previous.expires_at !== null ||
    sourceCount !== 1 || configCount !== (phase === "previous" ? 3 : 4)
  ) return refuse("PHYGITALS_REPLAY_CENTRAL_STATE_UNEXPECTED");
  const admin = await client.operator_memberships.findFirst({
    where: { organization_id: pins.organizationId, operator_id: previous.created_by_operator_id,
      role: "admin", operator: { state: "active" } },
    select: { operator_id: true },
  });
  if (admin === null) refuse("PHYGITALS_REPLAY_OPERATOR_UNAVAILABLE");
  if (phase === "prepared") {
    const [test, audit] = await Promise.all([
      client.provider_connection_tests.findUnique({ where: { id: pins.activationTestId } }),
      client.audit_events.findUnique({ where: { id: pins.auditId } }),
    ]);
    if (test === null || audit === null || test.provider_id !== pins.providerId ||
      test.config_version_id !== pins.configId || test.test_kind !== "activation" ||
      test.outcome !== "succeeded" || test.source_credential_version_id !== pins.sourceCredentialId ||
      test.database_credential_version_id !== pins.databaseCredentialId ||
      test.database_node_id !== pins.nodeId || test.topology_version !== 2n ||
      test.database_node_row_version !== 1n || test.response_status !== 200 ||
      audit.subject_id !== pins.providerId || audit.organization_id !== pins.organizationId ||
      audit.action !== replayAction || audit.outcome !== "success") {
      refuse("PHYGITALS_REPLAY_ATTESTATION_UNEXPECTED");
    }
  }
  const sourceFingerprint = createHash("sha256").update(source.ciphertext)
    .update(source.nonce).update(source.auth_tag).update(String(source.key_version)).digest("hex");
  return { provider, config, source, node, phase, sourceFingerprint, operatorId: admin.operator_id };
}

type CentralSnapshot = Awaited<ReturnType<typeof centralSnapshot>>;

function databasePins(snapshot: CentralSnapshot) {
  return {
    organizationId: pins.organizationId, providerId: pins.providerId, providerKey: pins.providerKey,
    configVersionId: snapshot.config.id, providerRowVersion: snapshot.provider.row_version,
    topologyVersion: 2n, nodeId: pins.nodeId, nodeRowVersion: 1n,
    databaseCredentialVersionId: pins.databaseCredentialId,
    host: "127.0.0.1" as const, port: 55_435,
    databaseName: "packscout_phygitals", sslMode: "disable" as const,
  };
}

export async function readPhygitalsV4ReplaySnapshot(database: ProviderPrismaClient): Promise<PhygitalsV4ReplaySnapshot> {
  const [identity, runtime, run, activeRunCount, actionableCommandCount, runCount, commandCount,
    pageCount, quarantineCount, exactHistoricalQuarantineCount, promotionChangeCount, ...canonicalCounts] =
    await Promise.all([
      database.database_identity.findUniqueOrThrow({ where: { singleton_key: true } }),
      database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      database.provider_runs.findUnique({ where: { id: pins.stoppedRunId } }),
      database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      database.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      database.provider_runs.count(), database.control_commands.count(),
      database.provider_run_pages.count(), database.quarantine_records.count(),
      database.quarantine_records.count({ where: {
        provider_run_id: { in: [pins.firstRunId, pins.stoppedRunId] }, state: "expired",
        reason_code: "SOURCE_RECORD_MAPPING_INVALID", retry_count: 0,
      } }),
      database.promotion_changes.count(), database.categories.count(), database.packs.count(),
      database.collectibles.count(), database.pack_contents.count(), database.provider_accounts.count(),
      database.pulls.count(), database.pull_items.count(), database.market_events.count(),
      database.collectible_name_aliases.count(), database.collectible_instances.count(),
    ]);
  const [canonicalRows, firstRun, firstQuarantines] = await Promise.all([
    database.collectibles.findMany({ take: 742, orderBy: { collectible_key: "asc" },
      select: { id: true, collectible_key: true, row_version: true } }),
    database.provider_runs.findUniqueOrThrow({ where: { id: pins.firstRunId } }),
    database.quarantine_records.count({ where: { provider_run_id: pins.firstRunId,
      state: "expired", reason_code: "SOURCE_RECORD_MAPPING_INVALID", retry_count: 0 } }),
  ]);
  if (firstRun.state !== "incomplete" || firstRun.page_count !== 133 ||
    firstRun.catalog_record_count !== 13_300 || firstRun.quarantined_count !== 13_300 ||
    firstRun.accepted_count !== 0 || firstRun.material_change_count !== 0 ||
    firstRun.finished_at?.toISOString() !== "2026-08-30T01:08:36.882Z" ||
    firstRun.final_cursor_hash !== "26dafbeaea75906df5a56d9f6bcf51816c771ce0237991b23ed832c3d8741f0a" ||
    firstQuarantines !== 13_300) refuse("PHYGITALS_REPLAY_PRIOR_HISTORY_CHANGED");
  const canonicalIdentityDigest = createHash("sha256").update(JSON.stringify(canonicalRows,
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
  if (runtime.central_provider_id !== identity.provider_id || runtime.provider_key !== identity.provider_key) {
    refuse("PHYGITALS_REPLAY_DATABASE_IDENTITY_UNEXPECTED");
  }
  return {
    providerId: identity.provider_id ?? "", providerKey: identity.provider_key ?? "",
    databaseRole: identity.database_role, schemaVersion: identity.schema_version,
    runtimeState: runtime.operating_state, generation: runtime.state_generation.toString(),
    cachedConfigId: runtime.cached_config_version_id, cursorHash: runtime.source_cursor_hash,
    cachedConfigNumber: runtime.cached_config_version_number?.toString() ?? null,
    cursorPresent: runtime.source_cursor !== null,
    cursorFingerprintMatches: providerMixedCursorFingerprint(runtime.source_cursor as CanonicalJsonValue | null)
      === runtime.source_cursor_hash,
    activeRunCount, actionableCommandCount, runCount, commandCount,
    pageCount, quarantineCount, exactHistoricalQuarantineCount, promotionChangeCount,
    canonicalCount: canonicalCounts.reduce((total, count) => total + count, 0),
    canonicalIdentityDigest,
    run: run === null ? null : {
      id: run.id, state: run.state, configId: run.config_version_id,
      configNumber: run.config_version_number.toString(), commandId: run.control_command_id,
      pageCount: run.page_count, catalogCount: run.catalog_record_count,
      pullCount: run.pull_record_count, marketCount: run.market_event_record_count,
      acceptedCount: run.accepted_count, duplicateCount: run.duplicate_count,
      quarantinedCount: run.quarantined_count, materialChangeCount: run.material_change_count,
      finalCursorHash: run.final_cursor_hash, reachedHead: run.reached_source_head,
      failureCode: run.failure_code, finishedAt: run.finished_at?.toISOString() ?? null,
      workerFence: run.worker_fence.toString(),
    },
  };
}

async function probeReplaySources(token: string, checkpoints: readonly Readonly<{
  page_number: number;
  requested_cursor: unknown;
}>[]) {
  if (checkpoints.length !== 3 || checkpoints.some((checkpoint, index) =>
    checkpoint.page_number !== [134, 140, 151][index])) refuse("PHYGITALS_REPLAY_PROBE_BOUNDARY_CHANGED");
  const requests = [{ label: "origin", cursor: null as string | null }];
  for (const checkpoint of checkpoints) {
    const cursor = checkpoint.requested_cursor;
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      refuse("PHYGITALS_REPLAY_PROBE_CURSOR_INVALID");
    }
    const envelope = cursor as Record<string, unknown>;
    if (typeof envelope.value !== "string" || envelope.value.length === 0 ||
      envelope.value.length > 16_384 || envelope.adapterVersion !== DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION ||
      envelope.sourceInstanceId !== pins.providerId || envelope.sourceRevisionId !== pins.previousConfigId) {
      refuse("PHYGITALS_REPLAY_PROBE_CURSOR_INVALID");
    }
    requests.push({ label: `stopped-run-page-${checkpoint.page_number}`, cursor: envelope.value });
  }
  const pages = [];
  for (const request of requests) {
    pages.push({ label: request.label, ...await probePhygitalsV4CardMapping(token, request.cursor) });
  }
  if (!pages.some((page) => page.chaseCount > 0) || !pages.some((page) => page.assetCount > 0) ||
    !pages.some((page) => page.inventoryCount > 0) || !pages.some((page) => page.nftCount > 0)) {
    refuse("PHYGITALS_REPLAY_WRAPPER_COVERAGE_MISSING");
  }
  return {
    checkKind: "bounded_phygitals_origin_and_boundary_mapping", adapterVersion: newAdapter,
    recordCount: pages.reduce((count, page) => count + page.recordCount, 0),
    collectibleCount: pages.reduce((count, page) => count + page.collectibleCount, 0),
    quarantineCount: 0, responseStatus: 200,
    responseBytes: pages.reduce((count, page) => count + page.responseBytes, 0),
    durationMilliseconds: pages.reduce((duration, page) => duration + page.durationMilliseconds, 0),
    pages, checkedAt: new Date().toISOString(),
  };
}

async function activateRevision(input: Readonly<{
  central: CentralPrismaClient;
  before: CentralSnapshot;
  sourceProof: Awaited<ReturnType<typeof probeReplaySources>>;
  databaseProof: ProviderReviewActivationDatabaseProof;
}>): Promise<void> {
  await input.central.$transaction(async (transaction) => {
    await transaction.$queryRaw`select id from providers where id = ${pins.providerId}::uuid for update`;
    await transaction.$queryRaw`select id from provider_database_nodes where id = ${pins.nodeId}::uuid for update`;
    await transaction.$queryRaw`select id from provider_credential_versions where id in
      (${pins.sourceCredentialId}::uuid, ${pins.databaseCredentialId}::uuid) order by id for update`;
    const locked = await centralSnapshot(transaction);
    if (locked.sourceFingerprint !== input.before.sourceFingerprint ||
      locked.provider.row_version !== input.before.provider.row_version ||
      locked.config.id !== input.before.config.id || locked.phase !== input.before.phase) {
      refuse("PHYGITALS_REPLAY_AUTHORITY_CHANGED");
    }
    if (locked.phase === "prepared") return;
    const now = new Date();
    if (now.getTime() - Date.parse(input.sourceProof.checkedAt) > 120_000 ||
      now.getTime() - Date.parse(input.databaseProof.checkedAt) > 120_000) {
      refuse("PHYGITALS_REPLAY_PROOF_EXPIRED");
    }
    await transaction.provider_config_versions.create({ data: {
      id: pins.configId, provider_id: pins.providerId, version_number: 4n,
      adapter_key: newAdapter, endpoint_url: DATAFORREST_EVENTS_V1_ENDPOINT,
      source_credential_version_id: pins.sourceCredentialId,
      schedule_seconds: 3_600, stale_after_seconds: 86_400,
      configuration: { platform: "phygitals" }, expires_at: null,
      created_by_operator_id: locked.operatorId, created_at: now,
    } });
    const [digest] = await transaction.$queryRaw<Array<{ digest: string }>>`
      select packscout_activation_target_digest_nullable_source(
        ${pins.providerId}::uuid, ${pins.configId}::uuid, ${pins.sourceCredentialId}::uuid,
        ${pins.databaseCredentialId}::uuid, 2::bigint, ${pins.nodeId}::uuid, 1::bigint) as digest
    `;
    if (digest === undefined) refuse("PHYGITALS_REPLAY_DIGEST_UNAVAILABLE");
    await transaction.provider_connection_tests.create({ data: {
      id: pins.activationTestId, provider_id: pins.providerId, config_version_id: pins.configId,
      source_credential_version_id: pins.sourceCredentialId,
      database_credential_version_id: pins.databaseCredentialId,
      topology_version: 2n, database_node_id: pins.nodeId, database_node_row_version: 1n,
      target_digest: digest.digest, test_kind: "activation", outcome: "succeeded",
      latency_ms: Math.round(input.sourceProof.durationMilliseconds), response_status: 200,
      result_summary: {
        checkKind: "bounded_source_mapping_and_database_contract", adapterVersion: newAdapter,
        platform: "phygitals", sourceProof: { ...input.sourceProof }, databaseProof: { ...input.databaseProof },
        replayOfRunId: pins.stoppedRunId, preservedQuarantineCount: 15_092,
      },
      record_counts: { records: input.sourceProof.recordCount, collectibles: input.sourceProof.collectibleCount, quarantined: 0 },
      tested_by_operator_id: locked.operatorId, tested_at: now, created_at: now,
    } });
    const updated = await transaction.providers.updateMany({
      where: { id: pins.providerId, row_version: 5n, active_config_version_id: pins.previousConfigId },
      data: { active_config_version_id: pins.configId, row_version: { increment: 1n }, updated_at: now },
    });
    if (updated.count !== 1) refuse("PHYGITALS_REPLAY_AUTHORITY_CHANGED");
    await transaction.audit_events.create({ data: {
      id: pins.auditId, organization_id: pins.organizationId,
      actor_key: "system:local-phygitals-card-replay-v4", action: replayAction,
      subject_type: "provider", subject_id: pins.providerId, outcome: "success",
      metadata_json: {
        previousConfigId: pins.previousConfigId, configId: pins.configId, adapterKey: newAdapter,
        stoppedRunId: pins.stoppedRunId, preservedQuarantineCount: 15_092,
        mappingRecordCount: input.sourceProof.recordCount, sourceCredentialReused: true,
      }, occurred_at: now,
    } });
    await transaction.$executeRaw`select packscout_assert_provider_activation(${pins.providerId}::uuid)`;
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 30_000 });
}

/** No automatic queue/run. Only the approved checkpoint can advance to config v4 at origin. */
export async function preparePhygitalsNativeCardV4Replay(input: Readonly<{ apply: boolean }>) {
  const fileEnvironment = await loadPhygitalsDataforrestRepositoryEnvironment();
  const environment = readPhygitalsDataforrestActivationEnvironment({
    processEnvironment: process.env, fileEnvironment,
  });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.credentialKeyVersion,
    keys: new Map([[environment.credentialKeyVersion, environment.credentialKey]]) });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"],
      allowedPorts: [55_435], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 30_000,
  });
  try {
    await central.start();
    const before = await centralSnapshot(central.client);
    const target = { organizationId: pins.organizationId, providerId: pins.providerId };
    const route = await locateProviderDatabase(central.client, target);
    if (route.state !== "ready") return refuse("PHYGITALS_REPLAY_ROUTE_UNAVAILABLE");
    assertProviderReviewActivationDatabaseRoute(route.route, databasePins(before));
    const checkpoint = await gateway.runWithCachedProviderDatabase(route.route, readPhygitalsV4ReplaySnapshot);
    if (checkpoint.state !== "reachable") return refuse("PHYGITALS_REPLAY_DATABASE_UNREACHABLE");
    const localPhase = assertPhygitalsV4ReplaySnapshot(checkpoint.value);
    if (before.phase === "previous" && localPhase !== "previous") refuse("PHYGITALS_REPLAY_AUTHORITY_CHANGED");
    let token = cipher.decrypt({ ciphertext: before.source.ciphertext, nonce: before.source.nonce,
      authTag: before.source.auth_tag, keyVersion: before.source.key_version },
    { organizationId: pins.organizationId, providerId: pins.providerId, revisionId: pins.sourceCredentialId });
    let sourceProof: Awaited<ReturnType<typeof probeReplaySources>>;
    try {
      const boundaries = await gateway.runWithCachedProviderDatabase(route.route, (database) =>
        database.provider_run_pages.findMany({ where: { provider_run_id: pins.stoppedRunId,
          page_number: { in: [134, 140, 151] } }, orderBy: { page_number: "asc" },
          select: { page_number: true, requested_cursor: true } }));
      if (boundaries.state !== "reachable") return refuse("PHYGITALS_REPLAY_BOUNDARIES_UNREACHABLE");
      sourceProof = await probeReplaySources(token, boundaries.value);
    } finally { token = ""; }
    const databaseProof = await runPinnedProviderReviewActivationDatabaseProof({
      centralDatabaseUrl: environment.centralDatabaseUrl, cipher,
      pins: databasePins(before), requireIdle: true,
    });
    if (!input.apply) return { outcome: "verified_only", checkpoint: checkpoint.value, sourceProof, databaseProof };
    const preparation = await gateway.runWithCachedProviderDatabase(route.route, async (database) => {
      const leases = new PrismaProviderWorkerLeaseRepository(database);
      const acquired = await leases.acquire({ role: "import", owner: pins.owner, leaseMilliseconds: 120_000 });
      if (acquired.kind === "held") return refuse("PHYGITALS_REPLAY_LEASE_HELD");
      try {
        const frozen = await readPhygitalsV4ReplaySnapshot(database);
        const phase = assertPhygitalsV4ReplaySnapshot(frozen);
        if (phase !== localPhase) refuse("PHYGITALS_REPLAY_CHECKPOINT_CHANGED");
        const after = await executeGuardedPhygitalsV4Replay({
          readCheckpoint: () => readPhygitalsV4ReplaySnapshot(database),
          activate: () => activateRevision({ central: central.client, before, sourceProof, databaseProof }),
          synchronize: async () => {
            const renewed = await leases.renew({ role: "import", owner: pins.owner,
              fence: acquired.lease.fence, leaseMilliseconds: 120_000 });
            if (renewed === null) refuse("PHYGITALS_REPLAY_LEASE_LOST");
            const synchronized = await new PrismaProviderRuntimeRepository(database).synchronizeConfiguration({
              centralProviderId: pins.providerId, providerKey: "phygitals",
              configVersionId: pins.configId, configVersionNumber: 4n,
              configuration: { adapterKey: newAdapter, settings: { platform: "phygitals" } },
              expiresAt: null, scheduleSeconds: 3_600, nextDueAt: null, synchronizedAt: new Date(),
            });
            if (synchronized.kind !== "updated" && synchronized.kind !== "unchanged") {
              refuse("PHYGITALS_REPLAY_RUNTIME_SYNC_REFUSED");
            }
          },
        });
        if (phase === "previous") await database.local_audit_events.create({ data: {
          action: replayAction, target_id: pins.stoppedRunId, correlation_id: pins.correlationId,
          target_type: "provider_run", outcome: "success",
          details: { previousConfigId: pins.previousConfigId, configId: pins.configId,
            previousCursorHash: pins.cursorHash, cursorResetBy: "immutable_configuration_sync",
            historicalQuarantinesPreserved: 15_092, canonicalChangesBeforeReplay: 741 },
          occurred_at: new Date(),
        } });
        return after;
      } finally {
        await leases.release({ role: "import", owner: pins.owner, fence: acquired.lease.fence });
      }
    });
    if (preparation.state !== "reachable") refuse("PHYGITALS_REPLAY_PREPARATION_FAILED");
    const after = await centralSnapshot(central.client);
    return { outcome: "prepared", providerId: pins.providerId, configVersionId: after.config.id,
      configVersionNumber: 4, adapterKey: newAdapter, activationTestId: pins.activationTestId,
      preservedRunId: pins.stoppedRunId, preservedQuarantineCount: 15_092,
      preservedCanonicalCount: 741, canonicalIdentityDigest: pins.canonicalIdentityDigest,
      cursorAtOrigin: true, sourceProof, databaseProof };
  } finally {
    environment.credentialKey.fill(0);
    for (const key of Object.keys(fileEnvironment)) { fileEnvironment[key] = ""; delete fileEnvironment[key]; }
    await gateway.close().catch(() => undefined);
    await central.close().catch(() => undefined);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length !== 1 || !["--verify", "--apply"].includes(argumentsList[0]!)) {
    console.error(JSON.stringify({ failureCode: "PHYGITALS_REPLAY_ARGUMENTS_INVALID" }));
    process.exitCode = 1;
  } else {
    preparePhygitalsNativeCardV4Replay({ apply: argumentsList[0] === "--apply" })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error: unknown) => {
        console.error(JSON.stringify({ failureCode: error instanceof PhygitalsCardV4ReplayError
          ? error.code : "PHYGITALS_REPLAY_FAILED" }));
        process.exitCode = 1;
      });
  }
}
