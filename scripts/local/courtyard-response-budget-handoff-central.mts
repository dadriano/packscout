import { DATAFORREST_EVENTS_V1_ENDPOINT } from "@packscout/contracts";
import type { CentralPrismaClient, CentralQueryClient } from "@packscout/database";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { courtyardHandoff as pins, courtyardHandoffId as id, refuseCourtyardHandoff as refuse,
  courtyardCanarySchema, reEnvelopeCourtyardCursor, retainedCourtyardCheckpoint,
  type CourtyardCheckpoint, type CourtyardReceipt, type CourtyardCanaryProof } from "./courtyard-response-budget-handoff-plan.mts";

export async function readCourtyardHandoffAuthority(client: CentralQueryClient, operationId: string) {
  const previous = await client.provider_config_versions.findUniqueOrThrow({ where: { id: pins.previousConfigId },
    include: { source_credential: true, provider: { include: { database_nodes: { include: { credential: true } } } } } });
  const provider = previous.provider; const source = previous.source_credential; const node = provider.database_nodes[0];
  const [versions, stage] = await Promise.all([
    client.provider_config_versions.findMany({ where: { provider_id: provider.id }, orderBy: { version_number: "asc" } }),
    client.audit_events.findUnique({ where: { id: id(operationId, "stage-audit") } }),
  ]);
  const nextConfigId = id(operationId, "config"); const next = versions.find((version) => version.id === nextConfigId);
  const credentialActive = (credential: NonNullable<typeof source> | undefined) => credential && credential.provider_id === provider.id &&
    credential.lifecycle === "active" && credential.activated_at !== null && credential.activated_at <= new Date() &&
    credential.retired_at === null && credential.revoked_at === null;
  if (provider.id !== pins.providerId || previous.provider_id !== pins.providerId || provider.organization_id !== pins.organizationId || provider.provider_key !== pins.providerKey || provider.lifecycle !== "active" ||
    provider.database_nodes.length !== 1 || !node || !node.enabled || node.node_role !== "primary" ||
    node.host !== "127.0.0.1" || node.port !== pins.port || node.database_name !== pins.databaseName || node.ssl_mode !== "disable" ||
    !credentialActive(node.credential) || node.credential.credential_kind !== "database" ||
    previous.version_number !== 2n || previous.adapter_key !== pins.previousAdapter || previous.endpoint_url !== DATAFORREST_EVENTS_V1_ENDPOINT ||
    previous.expires_at !== null || handoffDigest(previous.configuration) !== handoffDigest({ platform: pins.providerKey }) ||
    !source || !credentialActive(source) || source.credential_kind !== "source" ||
    ![pins.previousConfigId, nextConfigId].includes(provider.active_config_version_id ?? "") || versions.length !== (next ? 3 : 2) ||
    Boolean(stage) !== Boolean(next) || (next && (next.version_number !== 3n || next.adapter_key !== pins.nextAdapter ||
      next.source_credential_version_id !== source.id || next.endpoint_url !== previous.endpoint_url ||
      next.schedule_seconds !== previous.schedule_seconds || next.stale_after_seconds !== previous.stale_after_seconds ||
      next.expires_at !== null || handoffDigest(next.configuration) !== handoffDigest(previous.configuration)))) refuse("COURTYARD_CENTRAL_AUTHORITY_CHANGED");
  const membership = await client.operator_memberships.findFirst({ where: { organization_id: pins.organizationId,
    operator_id: previous.created_by_operator_id, role: "admin", operator: { state: "active" } } });
  if (!membership) refuse("COURTYARD_OPERATOR_UNAVAILABLE");
  const authorityDigest = handoffDigest({ providerId: provider.id, organizationId: provider.organization_id,
    config: { id: previous.id, adapter: previous.adapter_key, endpoint: previous.endpoint_url, settings: previous.configuration,
      schedule: previous.schedule_seconds, stale: previous.stale_after_seconds }, source, databaseCredential: node.credential,
    nodeId: node.id, nodeVersion: node.row_version, topologyVersion: provider.topology_version, operatorId: membership.operator_id });
  const metadata = stage?.metadata_json as Record<string, unknown> | undefined;
  if (stage && (stage.subject_id !== provider.id || stage.organization_id !== pins.organizationId || stage.action !== `${pins.action}.staged` ||
    stage.outcome !== "success" || metadata?.authorityDigest !== authorityDigest)) refuse("COURTYARD_STAGED_AUTHORITY_CHANGED");
  return { provider, previous, source, node, nextConfigId, next, stage, metadata, authorityDigest,
    operatorId: membership.operator_id, active: provider.active_config_version_id === nextConfigId };
}
export type CourtyardAuthority = Awaited<ReturnType<typeof readCourtyardHandoffAuthority>>;

export function validateCourtyardCanaryBinding(input: Readonly<{ proof: unknown; providerId: string;
  nextConfigId: string; opaqueValueHash: string; fresh: boolean; now?: number }>) {
  const parsed = courtyardCanarySchema.safeParse(input.proof);
  if (!parsed.success || parsed.data.providerId !== input.providerId || parsed.data.nextConfigId !== input.nextConfigId ||
    parsed.data.opaqueValueHash !== input.opaqueValueHash) refuse("COURTYARD_PROOF_BINDING_CHANGED");
  const age = (input.now ?? Date.now()) - Date.parse(parsed.data.checkedAt);
  if (input.fresh && (!Number.isFinite(age) || age < 0 || age > 120000)) refuse("COURTYARD_CANARY_EXPIRED");
  return parsed.data;
}

async function lockAuthority(tx: CentralQueryClient, authority: CourtyardAuthority) {
  await tx.$queryRaw`select id from providers where id=${authority.provider.id}::uuid for update`;
  await tx.$queryRaw`select id from provider_database_nodes where id=${authority.node.id}::uuid for update`;
  await tx.$queryRaw`select id from provider_credential_versions where id in
    (${authority.source.id}::uuid,${authority.node.credential.id}::uuid) order by id for update`;
}

export async function stageCourtyardHandoff(input: Readonly<{ central: CentralPrismaClient; authority: CourtyardAuthority;
  receipt: CourtyardReceipt; checkpoint: CourtyardCheckpoint; sourceProof: CourtyardCanaryProof }>) {
  const { receipt } = input;
  const migrated = reEnvelopeCourtyardCursor({ cursor: input.checkpoint.run.finalCursor,
    cursorHash: input.checkpoint.run.finalCursorHash, providerId: receipt.providerId, nextConfigId: receipt.nextConfigId });
  const proof = validateCourtyardCanaryBinding({ proof: input.sourceProof, providerId: receipt.providerId,
    nextConfigId: receipt.nextConfigId, opaqueValueHash: migrated.opaqueValueHash, fresh: false });
  if (input.checkpoint.runtimeState !== "paused" || input.checkpoint.generation !== "22" ||
    handoffDigest(retainedCourtyardCheckpoint(input.checkpoint)) !== receipt.checkpointDigest) refuse("COURTYARD_PROOF_BINDING_CHANGED");
  await input.central.$transaction(async (tx) => {
    await lockAuthority(tx, input.authority);
    const current = await readCourtyardHandoffAuthority(tx, receipt.operationId);
    if (current.authorityDigest !== receipt.authorityDigest || current.provider.row_version !== input.authority.provider.row_version) refuse("COURTYARD_CENTRAL_CAS_FAILED");
    if (current.stage) {
      if (current.metadata?.checkpointDigest !== receipt.checkpointDigest || current.metadata?.nextCursorHash !== migrated.cursorHash ||
        current.metadata?.receiptDigest !== handoffDigest(receipt)) refuse("COURTYARD_STAGED_CHECKPOINT_CHANGED");
      return;
    }
    validateCourtyardCanaryBinding({ proof, providerId: receipt.providerId, nextConfigId: receipt.nextConfigId,
      opaqueValueHash: migrated.opaqueValueHash, fresh: true });
    const now = new Date();
    await tx.provider_config_versions.create({ data: { id: current.nextConfigId, provider_id: current.provider.id,
      version_number: 3n, adapter_key: pins.nextAdapter, endpoint_url: current.previous.endpoint_url,
      source_credential_version_id: current.source.id, schedule_seconds: current.previous.schedule_seconds,
      stale_after_seconds: current.previous.stale_after_seconds, configuration: { platform: pins.providerKey },
      expires_at: null, created_by_operator_id: current.operatorId, created_at: now } });
    const [digest] = await tx.$queryRaw<Array<{ digest: string }>>`select packscout_activation_target_digest_nullable_source(
      ${current.provider.id}::uuid,${current.nextConfigId}::uuid,${current.source.id}::uuid,
      ${current.node.credential.id}::uuid,${current.provider.topology_version}::bigint,
      ${current.node.id}::uuid,${current.node.row_version}::bigint) as digest`;
    if (!digest) refuse("COURTYARD_ACTIVATION_DIGEST_UNAVAILABLE");
    await tx.provider_connection_tests.create({ data: { id: id(receipt.operationId, "activation-test"), provider_id: current.provider.id,
      config_version_id: current.nextConfigId, source_credential_version_id: current.source.id,
      database_credential_version_id: current.node.credential.id, topology_version: current.provider.topology_version,
      database_node_id: current.node.id, database_node_row_version: current.node.row_version, target_digest: digest.digest,
      test_kind: "activation", outcome: "succeeded", latency_ms: Math.round(proof.durationMilliseconds), response_status: 200,
      result_summary: { sourceProof: proof, pausedCheckpoint: retainedCourtyardCheckpoint(input.checkpoint), receiptDigest: handoffDigest(receipt) },
      record_counts: { sourceRecords: 100, canonicalValidCollectibles: proof.collectibleValidated,
        canonicalQuarantined: proof.canonicalQuarantined, mapperQuarantined: 0 },
      tested_by_operator_id: current.operatorId, tested_at: now, created_at: now } });
    await tx.audit_events.create({ data: { id: id(receipt.operationId, "stage-audit"), organization_id: pins.organizationId,
      actor_key: "system:local-courtyard-response-budget-handoff", action: `${pins.action}.staged`, subject_type: "provider",
      subject_id: current.provider.id, outcome: "success", metadata_json: { authorityDigest: current.authorityDigest,
        checkpointDigest: receipt.checkpointDigest, receiptDigest: handoffDigest(receipt), nextCursorHash: migrated.cursorHash,
        originalProviderRowVersion: current.provider.row_version.toString() }, occurred_at: now } });
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
}

/** Caller holds exact provider import lease → terminal run → runtime locks across this CAS. */
export async function activateCourtyardHandoffLast(input: Readonly<{ central: CentralPrismaClient;
  authority: CourtyardAuthority; receipt: CourtyardReceipt; checkpoint: CourtyardCheckpoint }>) {
  const { receipt, checkpoint } = input;
  const migrated = reEnvelopeCourtyardCursor({ cursor: checkpoint.run.finalCursor, cursorHash: checkpoint.run.finalCursorHash,
    providerId: receipt.providerId, nextConfigId: receipt.nextConfigId });
  if (checkpoint.runtimeState !== "paused" || checkpoint.generation !== "22" || checkpoint.cachedConfigId !== receipt.nextConfigId ||
    checkpoint.cachedConfigNumber !== "3" || checkpoint.cursorHash !== migrated.cursorHash || handoffDigest(checkpoint.cursor) !== handoffDigest(migrated.cursor) ||
    handoffDigest(retainedCourtyardCheckpoint(checkpoint)) !== receipt.checkpointDigest) refuse("COURTYARD_ACTIVATION_NOT_PREPARED");
  await input.central.$transaction(async (tx) => {
    await lockAuthority(tx, input.authority);
    const current = await readCourtyardHandoffAuthority(tx, receipt.operationId);
    if (current.authorityDigest !== receipt.authorityDigest || current.metadata?.receiptDigest !== handoffDigest(receipt) ||
      current.metadata?.nextCursorHash !== migrated.cursorHash || current.metadata?.checkpointDigest !== receipt.checkpointDigest) refuse("COURTYARD_STAGED_CHECKPOINT_CHANGED");
    if (current.active) return;
    if (current.provider.row_version.toString() !== current.metadata.originalProviderRowVersion) refuse("COURTYARD_CENTRAL_CAS_FAILED");
    const changed = await tx.providers.updateMany({ where: { id: receipt.providerId, row_version: current.provider.row_version,
      active_config_version_id: pins.previousConfigId }, data: { active_config_version_id: receipt.nextConfigId,
      row_version: { increment: 1n }, updated_at: new Date() } });
    if (changed.count !== 1) refuse("COURTYARD_CENTRAL_CAS_FAILED");
    await tx.audit_events.create({ data: { id: id(receipt.operationId, "activate-audit"), organization_id: pins.organizationId,
      actor_key: "system:local-courtyard-response-budget-handoff", action: `${pins.action}.activated`, subject_type: "provider",
      subject_id: receipt.providerId, outcome: "success", metadata_json: { operationId: receipt.operationId,
        receiptDigest: handoffDigest(receipt), checkpointDigest: receipt.checkpointDigest, nextCursorHash: migrated.cursorHash }, occurred_at: new Date() } });
    await tx.$executeRaw`select packscout_assert_provider_activation(${receipt.providerId}::uuid)`;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
}
