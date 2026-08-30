import { createHash } from "node:crypto";
import {
  type CentralQueryClient, type ProviderPrismaClient, type ProviderTransactionClient,
  type CentralPrismaClient, type CanonicalJsonObject,
} from "@packscout/database";
import { collectorHandoff as pins, handoffDigest, handoffId, refuseHandoff, reEnvelopeCollectorCursor,
  type CollectorHandoffCheckpoint } from "./collector-crypt-checkpoint-handoff-plan.mts";
import type { CollectorHandoffCanary } from "./collector-crypt-checkpoint-handoff-canary.mts";

const exactSettings = (value: unknown) => handoffDigest(value) === handoffDigest({ platform: pins.providerKey });
const fingerprint = (credential: { ciphertext: Uint8Array; nonce: Uint8Array; auth_tag: Uint8Array; key_version: number }) =>
  createHash("sha256").update(credential.ciphertext).update(credential.nonce).update(credential.auth_tag)
    .update(String(credential.key_version)).digest("hex");

export async function readCollectorHandoffAuthority(client: CentralQueryClient, operationId: string) {
  const nextConfigId = handoffId(operationId, "config");
  const [provider, previous, versions, stage] = await Promise.all([
    client.providers.findUniqueOrThrow({ where: { id: pins.providerId }, include: {
      database_nodes: { include: { credential: true } },
    } }),
    client.provider_config_versions.findFirst({ where: { provider_id: pins.providerId, version_number: 2n },
      include: { source_credential: true } }),
    client.provider_config_versions.findMany({ where: { provider_id: pins.providerId }, orderBy: { version_number: "asc" } }),
    client.audit_events.findUnique({ where: { id: handoffId(operationId, "stage-audit") } }),
  ]);
  const node = provider.database_nodes[0];
  const source = previous?.source_credential;
  const next = versions.find((version) => version.id === nextConfigId);
  const now = new Date();
  if (provider.organization_id !== pins.organizationId || provider.provider_key !== pins.providerKey ||
    provider.lifecycle !== "active" || provider.database_nodes.length !== 1 || !node ||
    node.host !== "127.0.0.1" || node.port !== pins.port || node.database_name !== pins.databaseName ||
    node.ssl_mode !== "disable" || !node.enabled || node.node_role !== "primary" ||
    node.credential.provider_id !== pins.providerId || node.credential.credential_kind !== "database" ||
    node.credential.lifecycle !== "active" || node.credential.activated_at === null ||
    node.credential.activated_at > now || node.credential.retired_at !== null || node.credential.revoked_at !== null ||
    !previous || previous.adapter_key !== pins.previousAdapter || previous.endpoint_url !== pins.endpoint ||
    !exactSettings(previous.configuration) || previous.expires_at !== null || !source ||
    source.provider_id !== pins.providerId || source.credential_kind !== "source" || source.lifecycle !== "active" ||
    source.activated_at === null || source.activated_at > now || source.retired_at !== null || source.revoked_at !== null ||
    ![previous.id, nextConfigId].includes(provider.active_config_version_id ?? "") ||
    versions.length !== (next ? 3 : 2) ||
    (next && (next.version_number !== 3n || next.adapter_key !== pins.nextAdapter || next.endpoint_url !== previous.endpoint_url ||
      next.source_credential_version_id !== source.id || next.schedule_seconds !== previous.schedule_seconds ||
      next.stale_after_seconds !== previous.stale_after_seconds || !exactSettings(next.configuration) || next.expires_at !== null)) ||
    Boolean(next) !== Boolean(stage)) refuseHandoff("HANDOFF_CENTRAL_AUTHORITY_CHANGED");
  const membership = await client.operator_memberships.findFirst({ where: {
    organization_id: pins.organizationId, operator_id: previous.created_by_operator_id,
    role: "admin", operator: { state: "active" },
  }, select: { operator_id: true } });
  if (!membership) refuseHandoff("HANDOFF_OPERATOR_UNAVAILABLE");
  const authorityDigest = handoffDigest({ providerId: provider.id, organizationId: provider.organization_id,
    previous, sourceFingerprint: fingerprint(source), databaseFingerprint: fingerprint(node.credential),
    nodeId: node.id, nodeVersion: node.row_version, databaseCredentialId: node.credential.id,
    topologyVersion: provider.topology_version, operatorId: membership.operator_id });
  if (stage && (stage.action !== `${pins.action}.staged` || stage.subject_id !== pins.providerId ||
    stage.organization_id !== pins.organizationId || stage.outcome !== "success" ||
    typeof stage.metadata_json !== "object" || stage.metadata_json === null || Array.isArray(stage.metadata_json) ||
    stage.metadata_json.authorityDigest !== authorityDigest)) refuseHandoff("HANDOFF_STAGED_AUTHORITY_CHANGED");
  return { provider, previous, next, node, source, stage, nextConfigId, authorityDigest,
    operatorId: membership.operator_id, active: provider.active_config_version_id === nextConfigId };
}
export type CollectorHandoffAuthority = Awaited<ReturnType<typeof readCollectorHandoffAuthority>>;

/** No query text, raw payload, or opaque cursor is exposed by the caller's output projection. */
export async function readCollectorHandoffCheckpoint(database: ProviderPrismaClient | ProviderTransactionClient,
  input: Readonly<{ oldProcessAlive: boolean; runId?: string }>): Promise<CollectorHandoffCheckpoint> {
  const [identity, runtime, lease, run, activeRunCount, actionableCommandCount, ledger, [clock], runCount, otherOwnedWorkerLeaseCount] = await Promise.all([
    database.database_identity.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } }),
    input.runId ? database.provider_runs.findUnique({ where: { id: input.runId } })
      : database.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
    database.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    database.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.$queryRaw<Array<{ now: Date; active: number }>>`select clock_timestamp() as now,
      (select count(*)::integer from pg_stat_activity where datname=current_database()
        and pid<>pg_backend_pid() and (state='active' or xact_start is not null)) as active`,
    database.provider_runs.count(),
    database.provider_worker_states.count({ where: { worker_role: { not: "import" }, lease_owner: { not: null } } }),
  ]);
  if (!run || !clock || identity.provider_id !== runtime.central_provider_id || identity.provider_key !== runtime.provider_key) {
    refuseHandoff("HANDOFF_RUNTIME_IDENTITY_INVALID");
  }
  const lastPage = await database.provider_run_pages.findFirst({ where: { provider_run_id: run.id },
    orderBy: { page_number: "desc" }, select: { id: true, page_number: true, next_cursor: true, next_cursor_hash: true, continuation: true } });
  return { providerId: identity.provider_id ?? "", providerKey: identity.provider_key ?? "",
    databaseRole: identity.database_role, schemaVersion: identity.schema_version,
    runtimeState: runtime.operating_state, generation: runtime.state_generation.toString(), runtimeRowVersion: runtime.row_version.toString(),
    cachedConfigId: runtime.cached_config_version_id, cachedConfigNumber: runtime.cached_config_version_number?.toString() ?? null,
    cursor: runtime.source_cursor, cursorHash: runtime.source_cursor_hash, activeRunCount, runCount, otherOwnedWorkerLeaseCount, actionableCommandCount,
    otherActiveTransactionCount: clock.active, oldProcessAlive: input.oldProcessAlive, databaseNow: clock.now.toISOString(),
    lease: { owner: lease.lease_owner, fence: lease.lease_fence.toString(), expiresAt: lease.lease_expires_at?.toISOString() ?? null },
    ledgerSequence: ledger.last_sequence.toString(), run: { id: run.id, state: run.state,
      configId: run.config_version_id, configNumber: run.config_version_number.toString(), fence: run.worker_fence.toString(),
      pageCount: run.page_count, accepted: run.accepted_count, duplicates: run.duplicate_count,
      quarantines: run.quarantined_count, materialChanges: run.material_change_count,
      reachedHead: run.reached_source_head, finishedAt: run.finished_at?.toISOString() ?? null,
      failureCode: run.failure_code, finalCursor: run.final_cursor, finalCursorHash: run.final_cursor_hash },
    lastPage: lastPage ? { id: lastPage.id, number: lastPage.page_number, cursor: lastPage.next_cursor,
      cursorHash: lastPage.next_cursor_hash, continuation: lastPage.continuation } : null };
}

export function retainedCollectorCheckpoint(snapshot: CollectorHandoffCheckpoint) {
  return { runId: snapshot.run.id, runFence: snapshot.run.fence, generation: snapshot.generation,
    pageCount: snapshot.run.pageCount, accepted: snapshot.run.accepted, duplicates: snapshot.run.duplicates,
    quarantines: snapshot.run.quarantines, materialChanges: snapshot.run.materialChanges,
    runState: snapshot.run.state, failureCode: snapshot.run.failureCode, finishedAt: snapshot.run.finishedAt,
    lastPageId: snapshot.lastPage?.id ?? null, previousCursorHash: snapshot.run.finalCursorHash,
    ledgerSequence: snapshot.ledgerSequence };
}

export async function stageCollectorHandoff(input: Readonly<{
  central: CentralPrismaClient; authority: CollectorHandoffAuthority; operationId: string;
  checkpoint: CollectorHandoffCheckpoint; sourceProof: CollectorHandoffCanary;
  nextCursorHash: string;
}>): Promise<void> {
  await input.central.$transaction(async (tx) => {
    await tx.$queryRaw`select id from providers where id=${pins.providerId}::uuid for update`;
    await tx.$queryRaw`select id from provider_database_nodes where id=${input.authority.node.id}::uuid for update`;
    await tx.$queryRaw`select id from provider_credential_versions where id in
      (${input.authority.source.id}::uuid,${input.authority.node.credential.id}::uuid) order by id for update`;
    const current = await readCollectorHandoffAuthority(tx, input.operationId);
    if (current.authorityDigest !== input.authority.authorityDigest ||
      current.provider.row_version !== input.authority.provider.row_version) refuseHandoff("HANDOFF_CENTRAL_CAS_FAILED");
    const retained = retainedCollectorCheckpoint(input.checkpoint);
    const migrated = reEnvelopeCollectorCursor({ cursor: input.checkpoint.run.finalCursor,
      cursorHash: input.checkpoint.run.finalCursorHash, previousConfigId: current.previous.id, nextConfigId: current.nextConfigId });
    const proof = input.sourceProof;
    if (proof.checkKind !== "collector_saved_cursor_1000_record_canary" || proof.adapterKey !== pins.nextAdapter ||
      proof.previousConfigId !== current.previous.id || proof.nextConfigId !== current.nextConfigId ||
      proof.opaqueValueHash !== migrated.opaqueValueHash || input.nextCursorHash !== migrated.cursorHash ||
      proof.requestedRecords !== 1000 || proof.recordCount !== 1000 || proof.responseStatus !== 200 ||
      !Number.isSafeInteger(proof.responseBytes) || proof.responseBytes <= 0 || proof.responseBytes > 8 * 1024 * 1024 ||
      !Number.isFinite(proof.durationMilliseconds) || proof.durationMilliseconds < 0 ||
      !Number.isFinite(Date.parse(proof.checkedAt))) refuseHandoff("HANDOFF_CANARY_PROOF_INVALID");
    const metadata = { authorityDigest: current.authorityDigest,
      originalProviderRowVersion: current.provider.row_version.toString(),
      checkpoint: retained, checkpointDigest: handoffDigest(retained), nextCursorHash: input.nextCursorHash,
      opaqueValueHash: input.sourceProof.opaqueValueHash, previousConfigId: current.previous.id,
      nextConfigId: current.nextConfigId, operationId: input.operationId };
    if (current.stage) {
      const stored = current.stage.metadata_json as Record<string, unknown>;
      if (stored.checkpointDigest !== metadata.checkpointDigest || stored.nextCursorHash !== input.nextCursorHash ||
        stored.opaqueValueHash !== input.sourceProof.opaqueValueHash) refuseHandoff("HANDOFF_STAGED_CHECKPOINT_CHANGED");
      return;
    }
    const age = Date.now() - Date.parse(proof.checkedAt);
    if (age < 0 || age > 120_000) refuseHandoff("HANDOFF_CANARY_EXPIRED");
    const now = new Date();
    await tx.provider_config_versions.create({ data: { id: current.nextConfigId, provider_id: pins.providerId,
      version_number: 3n, adapter_key: pins.nextAdapter, endpoint_url: current.previous.endpoint_url,
      source_credential_version_id: current.source.id, schedule_seconds: current.previous.schedule_seconds,
      stale_after_seconds: current.previous.stale_after_seconds, configuration: { platform: pins.providerKey },
      expires_at: null, created_by_operator_id: current.operatorId, created_at: now } });
    const [digest] = await tx.$queryRaw<Array<{ digest: string }>>`select packscout_activation_target_digest_nullable_source(
      ${pins.providerId}::uuid,${current.nextConfigId}::uuid,${current.source.id}::uuid,
      ${current.node.credential.id}::uuid,${current.provider.topology_version}::bigint,
      ${current.node.id}::uuid,${current.node.row_version}::bigint) as digest`;
    if (!digest) refuseHandoff("HANDOFF_ACTIVATION_DIGEST_UNAVAILABLE");
    await tx.provider_connection_tests.create({ data: { id: handoffId(input.operationId, "activation-test"),
      provider_id: pins.providerId, config_version_id: current.nextConfigId, source_credential_version_id: current.source.id,
      database_credential_version_id: current.node.credential.id, topology_version: current.provider.topology_version,
      database_node_id: current.node.id, database_node_row_version: current.node.row_version, target_digest: digest.digest,
      test_kind: "activation", outcome: "succeeded", latency_ms: Math.round(input.sourceProof.durationMilliseconds),
      response_status: 200, result_summary: { checkKind: "bounded_source_and_paused_database_checkpoint",
        sourceProof: { ...input.sourceProof }, checkpoint: retained, authorityDigest: current.authorityDigest },
      record_counts: { sourceRecords: 1000 }, tested_by_operator_id: current.operatorId, tested_at: now, created_at: now } });
    await tx.audit_events.create({ data: { id: handoffId(input.operationId, "stage-audit"),
      organization_id: pins.organizationId, actor_key: "system:local-collector-checkpoint-handoff",
      action: `${pins.action}.staged`, subject_type: "provider", subject_id: pins.providerId,
      outcome: "success", metadata_json: metadata, occurred_at: now } });
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 30_000 });
}

export async function activateCollectorHandoffLast(input: Readonly<{
  central: CentralPrismaClient; operationId: string; authorityDigest: string;
  checkpoint: CollectorHandoffCheckpoint;
}>): Promise<void> {
  await input.central.$transaction(async (tx) => {
    await tx.$queryRaw`select id from providers where id=${pins.providerId}::uuid for update`;
    const before = await readCollectorHandoffAuthority(tx, input.operationId);
    await tx.$queryRaw`select id from provider_database_nodes where id=${before.node.id}::uuid for update`;
    await tx.$queryRaw`select id from provider_credential_versions where id in
      (${before.source.id}::uuid,${before.node.credential.id}::uuid) order by id for update`;
    const current = await readCollectorHandoffAuthority(tx, input.operationId);
    const metadata = current.stage?.metadata_json as Record<string, unknown> | undefined;
    const migrated = reEnvelopeCollectorCursor({ cursor: input.checkpoint.run.finalCursor,
      cursorHash: input.checkpoint.run.finalCursorHash, previousConfigId: current.previous.id, nextConfigId: current.nextConfigId });
    if (!current.stage || !metadata || current.authorityDigest !== input.authorityDigest ||
      metadata.checkpointDigest !== handoffDigest(retainedCollectorCheckpoint(input.checkpoint)) ||
      metadata.nextCursorHash !== input.checkpoint.cursorHash || input.checkpoint.cachedConfigId !== current.nextConfigId ||
      input.checkpoint.cachedConfigNumber !== "3" || input.checkpoint.cursorHash !== migrated.cursorHash ||
      handoffDigest(input.checkpoint.cursor) !== handoffDigest(migrated.cursor) ||
      input.checkpoint.runtimeState !== "paused") refuseHandoff("HANDOFF_ACTIVATION_NOT_PREPARED");
    if (current.active) return;
    if (current.provider.row_version.toString() !== metadata.originalProviderRowVersion) refuseHandoff("HANDOFF_CENTRAL_CAS_FAILED");
    const changed = await tx.providers.updateMany({ where: { id: pins.providerId,
      row_version: current.provider.row_version, active_config_version_id: current.previous.id },
    data: { active_config_version_id: current.nextConfigId, row_version: { increment: 1n }, updated_at: new Date() } });
    if (changed.count !== 1) refuseHandoff("HANDOFF_CENTRAL_CAS_FAILED");
    await tx.audit_events.create({ data: { id: handoffId(input.operationId, "activation-audit"),
      organization_id: pins.organizationId, actor_key: "system:local-collector-checkpoint-handoff",
      action: `${pins.action}.activated`, subject_type: "provider", subject_id: pins.providerId,
      outcome: "success", metadata_json: { operationId: input.operationId, previousConfigId: current.previous.id,
        nextConfigId: current.nextConfigId, cursorHash: input.checkpoint.cursorHash,
        checkpointDigest: handoffDigest(retainedCollectorCheckpoint(input.checkpoint)) }, occurred_at: new Date() } });
    await tx.$executeRaw`select packscout_assert_provider_activation(${pins.providerId}::uuid)`;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 30_000 });
}

export function collectorLocalConfiguration(): CanonicalJsonObject {
  return { adapterKey: pins.nextAdapter, settings: { platform: pins.providerKey } };
}
