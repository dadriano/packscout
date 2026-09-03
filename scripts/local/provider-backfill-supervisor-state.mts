import { opaqueCursorEnvelopeSchema } from "@packscout/contracts";
import { providerMixedPageDigest, readProviderRunHeadProof, type ProviderQueryClient } from "@packscout/database";
import { backfillDigest, backfillId, backfillIntentSchema, refuseBackfill,
  type BackfillIntent, type BackfillPins, type BackfillSnapshot } from "./provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";

export const backfillAuditAction = "local.provider_backfill.retry_intent";
const fingerprint = (value: unknown) => value === null ? null : providerMixedPageDigest(value);
export async function readBackfillIntent(database: ProviderQueryClient, pins: BackfillPins): Promise<BackfillIntent | null> {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: pins.operationId,
    action: backfillAuditAction }, orderBy: { sequence: "desc" }, take: 1 });
  if (rows.length === 0) return null;
  const parsed = backfillIntentSchema.safeParse(rows[0]!.details);
  if (!parsed.success || backfillDigest(parsed.data.pins) !== backfillDigest(pins) || rows[0]!.outcome !== "success" ||
    rows[0]!.target_id !== parsed.data.parentRunId || parsed.data.runId !== backfillId(pins.operationId, `run/${parsed.data.parentRunId}`)) {
    refuseBackfill("BACKFILL_INTENT_INVALID");
  }
  return parsed.data;
}

export async function readBackfillSnapshot(database: ProviderQueryClient, pins: BackfillPins,
  authority: BackfillAuthority, runId: string): Promise<BackfillSnapshot> {
  const [identity, runtime, lease, run, active, commands, [clock]] = await Promise.all([
    database.database_identity.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } }),
    database.provider_runs.findUnique({ where: { id: runId } }),
    database.provider_runs.findMany({ where: { state: { in: ["queued", "running"] } }, select: { id: true }, take: 2 }),
    database.control_commands.findMany({ where: { state: { in: ["pending", "accepted"] } },
      select: { id: true, resulting_run_id: true }, take: 2 }),
    database.$queryRaw<Array<{ now: Date }>>`select clock_timestamp() as now`,
  ]);
  if (!run || !clock || identity.database_role !== "provider" || identity.provider_id !== pins.providerId ||
    identity.provider_key !== pins.providerKey) refuseBackfill("BACKFILL_PROVIDER_IDENTITY_CONFLICT");
  const last = await database.provider_run_pages.findFirst({ where: { provider_run_id: runId }, orderBy: { page_number: "desc" } });
  const head = run.reached_source_head && (run.state === "running" || (run.state === "succeeded" && run.page_count === 0))
    ? await readProviderRunHeadProof(database, runId) : null;
  const headProof = head && head.runId === run.id && head.configVersionId === run.config_version_id &&
    head.configVersionNumber === run.config_version_number && head.checkpointHash === runtime.source_cursor_hash
    ? { runId: head.runId, sourceRunId: head.sourceRunId, checkpointHash: head.checkpointHash,
      reconciliationComplete: head.reconciliationComplete } : null;
  const committedPageCount = run.page_count === 50_000
    ? await database.provider_run_pages.count({ where: { provider_run_id: runId } }) : run.page_count;
  const cursor = opaqueCursorEnvelopeSchema.safeParse(runtime.source_cursor);
  const manifest = authority.integration.manifest;
  const checkpointValid = cursor.success && cursor.data.sourceInstanceId === pins.providerId &&
    cursor.data.sourceRevisionId === pins.configId && cursor.data.sourceTypeKey === manifest.sourceTypeKey &&
    cursor.data.adapterVersion === manifest.adapterVersion && cursor.data.cursorCodecKey === manifest.cursorCodecKey &&
    cursor.data.cursorGeneration === 1 && cursor.data.value !== null &&
    fingerprint(runtime.source_cursor) === runtime.source_cursor_hash;
  return { now: clock.now, providerId: runtime.central_provider_id, providerKey: runtime.provider_key,
    configId: runtime.cached_config_version_id, configNumber: runtime.cached_config_version_number,
    configurationMatches: providerMixedPageDigest(runtime.cached_configuration) === providerMixedPageDigest(authority.cachedConfiguration) &&
      runtime.config_expires_at?.getTime() === authority.expiresAt?.getTime() &&
      (!runtime.config_expires_at || runtime.config_expires_at > clock.now) && runtime.schedule_seconds === authority.scheduleSeconds,
    state: runtime.operating_state, generation: runtime.state_generation, runtimeRowVersion: runtime.row_version,
    checkpointHash: runtime.source_cursor_hash,
    checkpointValid: checkpointValid || (run.state === "succeeded" && run.reached_source_head && runtime.source_cursor === null && runtime.source_cursor_hash === null),
    activeRunIds: active.map((item) => item.id),
    actionableCommands: commands.map((item) => ({ id: item.id, runId: item.resulting_run_id })),
    lease: { owner: lease.lease_owner, fence: lease.lease_fence, expiresAt: lease.lease_expires_at },
    run: { id: run.id, configId: run.config_version_id, configNumber: run.config_version_number,
      state: run.state, fence: run.worker_fence, requestedHash: run.requested_cursor_hash,
      requestedMatches: fingerprint(run.requested_cursor) === run.requested_cursor_hash,
      finalHash: run.final_cursor_hash, finalMatches: fingerprint(run.final_cursor) === run.final_cursor_hash,
      reachedHead: run.reached_source_head, pageCount: run.page_count, accepted: run.accepted_count,
      failureCode: run.failure_code, finishedAt: run.finished_at, committedPageCount },
    headProof,
    lastPage: last ? { number: last.page_number, continuation: last.continuation, hash: last.next_cursor_hash,
      matches: fingerprint(last.next_cursor) === last.next_cursor_hash } : null };
}

/** Only follow persisted recoverActive lineage, never a latest/global run scan. */
export async function currentBackfillRunId(database: ProviderQueryClient, initialRunId: string): Promise<string> {
  let id = initialRunId;
  for (let depth = 0; depth < 128; depth += 1) {
    const children = await database.provider_runs.findMany({ where: { recovery_of_run_id: id },
      select: { id: true, trigger: true }, take: 2 });
    if (children.length === 0) return id;
    if (children.length !== 1 || children[0]!.trigger !== "recovery") refuseBackfill("BACKFILL_RECOVERY_LINEAGE_CONFLICT");
    id = children[0]!.id;
  }
  return refuseBackfill("BACKFILL_RECOVERY_LINEAGE_BOUND");
}
