import { isDeepStrictEqual } from "node:util";
import type { ProviderTransactionClient } from "./provider-database.ts";
import type { CanonicalJsonValue } from "./provider-canonical-contract.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { providerInitialFailedHeadGuardMatches, providerResumeEvidenceDigest,
  type ProviderInitialFailedHeadEntry } from "./provider-runtime-failed-head-guard.ts";
import { readProviderFailedHeadChainProof, type ProviderFailedHeadChainEntry } from "./provider-failed-head-chain-proof.ts";
export { providerResumeEvidenceDigest } from "./provider-runtime-failed-head-guard.ts";
import { appendProviderLocalAudit } from "./provider-local-evidence.ts";
import { providerWorkerLeaseIsLive, type lockProviderWorkerLease } from "./provider-worker-lease-repository.ts";

/** Caller-requested security boundary; each entry requires its own immutable provenance. */
interface ProviderRuntimeResumeGuardBase {
  readonly providerId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly runtimeRowVersion: bigint;
  readonly latestRunId: string;
  readonly latestRunDigest: string;
  readonly expectedImportLease: { readonly owner: string; readonly fence: bigint };
  /** Ephemeral admission deadline, never part of immutable replay identity. */
  readonly notAfter?: Date;
}

export interface ProviderRuntimeResumeGuardCommon extends ProviderRuntimeResumeGuardBase {
  readonly checkpointHash: string;
  readonly checkpoint: CanonicalJsonValue;
}

/**
 * A catalog source revision intentionally starts without a cursor. Keep this
 * authority separate from checkpoint recovery so null cannot silently weaken
 * the ordinary paused/failed-head guards.
 */
export interface ProviderCatalogOriginResumeGuard extends ProviderRuntimeResumeGuardBase {
  readonly entry: "paused_catalog_origin";
  readonly checkpointHash: null;
  readonly checkpoint: null;
  /** Hash of the operation-owned catalog-activation journal receipt. */
  readonly originReceiptDigest: string;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
}

/**
 * A catalog bridge may durably queue its deterministic null-origin run before
 * the public admission receipt is committed. Safety recovery pauses that exact
 * offline prefix. Resuming it must keep the already-admitted run and command
 * intact, and must prove the original guarded resume in the same transaction.
 */
export interface ProviderCatalogQueuedResumeGuard extends ProviderRuntimeResumeGuardBase {
  readonly entry: "paused_catalog_queued";
  readonly checkpointHash: null;
  readonly checkpoint: null;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly runCommandId: string;
  readonly runCommandIdempotencyKey: string;
  readonly originResumeCommandId: string;
  readonly originResumeIdempotencyKey: string;
  readonly originResumeGuardDigest: string;
  readonly prequeueRecoveryChain: readonly Readonly<{
    pauseCommandId: string;
    pauseCommandDigest: string;
    resumeCommandId: string;
    resumeCommandDigest: string;
    resumeGuardDigest: string;
  }>[];
}

export type ProviderRuntimeResumeGuard = (ProviderRuntimeResumeGuardCommon & (
  | { readonly entry: "paused"; readonly pauseCommandId: string; readonly pauseCommandDigest: string }
  | ProviderInitialFailedHeadEntry
  | ProviderFailedHeadChainEntry
)) | ProviderCatalogOriginResumeGuard | ProviderCatalogQueuedResumeGuard;
async function matchesEntry(tx: ProviderTransactionClient, input: GuardCommand,
  latest: Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findFirst"]>>) {
  const g = input.expectedRuntimeGuard;
  if (g.entry === "paused" || g.entry === "paused_catalog_origin" ||
    g.entry === "paused_catalog_queued") {
    if (!/^[a-f0-9]{64}$/u.test(g.pauseCommandDigest)) return false;
    const pause = await tx.control_commands.findUnique({ where: { id: g.pauseCommandId } });
    const result = pause?.result as { outcome?: unknown; generation?: unknown } | null;
    const pauseMatches = !!pause && pause.command_type === "pause" && pause.state === "completed" &&
      !!pause.completed_at &&
      pause.requested_by_operator_id === input.requestedByOperatorId && pause.expected_generation + 1n === input.expectedGeneration &&
      (g.entry === "paused" || pause.correlation_id === input.correlationId) &&
      result?.outcome === "accepted" && result.generation === input.expectedGeneration.toString() &&
      (g.entry === "paused_catalog_origin" ? catalogOriginPauseCommandDigest(pause) : providerResumeEvidenceDigest(pause)) ===
        g.pauseCommandDigest;
    if (!pauseMatches || g.entry !== "paused_catalog_queued") return pauseMatches;
    if (!/^[a-f0-9]{64}$/u.test(g.originResumeGuardDigest) || !latest ||
      latest.state !== "queued" || latest.reached_source_head || latest.worker_fence !== 0n ||
      latest.control_command_id !== g.runCommandId || latest.requested_cursor !== null ||
      latest.requested_cursor_hash !== null || latest.config_version_id !== g.configVersionId ||
      latest.config_version_number !== g.configVersionNumber) return false;
    const [runCommand, originResume, originGuard] = await Promise.all([
      tx.control_commands.findUnique({ where: { id: g.runCommandId } }),
      tx.control_commands.findUnique({ where: { id: g.originResumeCommandId } }),
      tx.local_audit_events.findFirst({ where: {
        command_id: g.originResumeCommandId, action: "provider.runtime.resume_guard",
      } }),
    ]);
    const runResult = runCommand?.result as {
      outcome?: unknown; code?: unknown; generation?: unknown;
    } | null;
    const originResult = originResume?.result as {
      outcome?: unknown; code?: unknown; generation?: unknown;
    } | null;
    const originDetails = originGuard?.details as { guardDigest?: unknown } | null | undefined;
    if (!Array.isArray(g.prequeueRecoveryChain) || g.prequeueRecoveryChain.length > 1_024 ||
      typeof originResult?.generation !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(originResult.generation)) return false;
    let queuedGeneration = BigInt(originResult.generation);
    const chainCommandIds = new Set<string>();
    for (const entry of g.prequeueRecoveryChain) {
      if (![entry.pauseCommandDigest, entry.resumeCommandDigest, entry.resumeGuardDigest]
          .every(digest => /^[a-f0-9]{64}$/u.test(digest)) ||
        chainCommandIds.has(entry.pauseCommandId) || chainCommandIds.has(entry.resumeCommandId) ||
        entry.pauseCommandId === entry.resumeCommandId) return false;
      chainCommandIds.add(entry.pauseCommandId);
      chainCommandIds.add(entry.resumeCommandId);
      const [prequeuePause, prequeueResume, prequeueAudit] = await Promise.all([
        tx.control_commands.findUnique({ where: { id: entry.pauseCommandId } }),
        tx.control_commands.findUnique({ where: { id: entry.resumeCommandId } }),
        tx.local_audit_events.findFirst({ where: {
          command_id: entry.resumeCommandId, action: "provider.runtime.resume_guard",
        } }),
      ]);
      const prequeuePauseResult = prequeuePause?.result as {
        outcome?: unknown; code?: unknown; generation?: unknown;
      } | null;
      const prequeueResumeResult = prequeueResume?.result as {
        outcome?: unknown; code?: unknown; generation?: unknown;
      } | null;
      const prequeueDetails = prequeueAudit?.details as {
        guardDigest?: unknown;
      } | null | undefined;
      if (!prequeuePause || !prequeueResume ||
        prequeuePause.command_type !== "pause" || prequeuePause.state !== "completed" ||
        prequeuePause.completed_at === null ||
        prequeuePause.idempotency_key !==
          `catalog-bridge/${input.correlationId}/catalog-prequeue-recovery/${queuedGeneration}/pause` ||
        prequeuePause.expected_generation !== queuedGeneration ||
        prequeuePause.requested_by_operator_id !== input.requestedByOperatorId ||
        prequeuePause.correlation_id !== input.correlationId ||
        prequeuePauseResult?.outcome !== "accepted" ||
        prequeuePauseResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
        prequeuePauseResult.generation !== (queuedGeneration + 1n).toString() ||
        catalogOriginPauseCommandDigest(prequeuePause) !== entry.pauseCommandDigest ||
        prequeueResume.command_type !== "resume" || prequeueResume.state !== "completed" ||
        prequeueResume.completed_at === null ||
        prequeueResume.idempotency_key !==
          `catalog-bridge/${input.correlationId}/catalog-prequeue-recovery/${queuedGeneration + 1n}/resume` ||
        prequeueResume.expected_generation !== queuedGeneration + 1n ||
        prequeueResume.requested_by_operator_id !== input.requestedByOperatorId ||
        prequeueResume.correlation_id !== input.correlationId ||
        prequeueResumeResult?.outcome !== "accepted" ||
        prequeueResumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
        prequeueResumeResult.generation !== (queuedGeneration + 2n).toString() ||
        providerResumeEvidenceDigest(prequeueResume) !== entry.resumeCommandDigest ||
        prequeueAudit?.outcome !== "success" ||
        prequeueAudit.actor_operator_id !== input.requestedByOperatorId ||
        prequeueAudit.correlation_id !== input.correlationId ||
        prequeueAudit.target_type !== "control_command" ||
        prequeueAudit.target_id !== entry.resumeCommandId ||
        prequeueDetails?.guardDigest !== entry.resumeGuardDigest) return false;
      queuedGeneration += 2n;
    }
    return !!runCommand && !!originResume &&
      runCommand.command_type === "run" && runCommand.state === "accepted" &&
      runCommand.idempotency_key === g.runCommandIdempotencyKey &&
      runCommand.target_run_id === null && runCommand.target_quarantine_id === null &&
      runCommand.resulting_run_id === latest.id &&
      runCommand.expected_generation === queuedGeneration &&
      runCommand.requested_by_operator_id === input.requestedByOperatorId &&
      runCommand.correlation_id === input.correlationId && runCommand.reason === null &&
      runCommand.completed_at === null &&
      runResult?.outcome === "accepted" && runResult.code === "COMMAND_ACCEPTED" &&
      runResult.generation === runCommand.expected_generation.toString() &&
      originResume.command_type === "resume" && originResume.state === "completed" &&
      originResume.idempotency_key === g.originResumeIdempotencyKey &&
      originResume.target_run_id === null && originResume.target_quarantine_id === null &&
      originResume.resulting_run_id === null && originResume.completed_at !== null &&
      originResume.requested_by_operator_id === input.requestedByOperatorId &&
      originResume.correlation_id === input.correlationId && originResume.reason === null &&
      originResult?.outcome === "accepted" && originResult.code === "RUNTIME_TRANSITION_APPLIED" &&
      originResult.generation === (originResume.expected_generation + 1n).toString() &&
      originGuard?.outcome === "success" &&
      originGuard.actor_operator_id === input.requestedByOperatorId &&
      originGuard.correlation_id === input.correlationId &&
      originGuard.target_type === "control_command" &&
      originGuard.target_id === g.originResumeCommandId &&
      originDetails?.guardDigest === g.originResumeGuardDigest;
  }
  if (g.entry === "failed_zero_commit_from_head") return providerInitialFailedHeadGuardMatches(tx, g, latest);
  if (g.entry === "failed_zero_commit_chain_from_head") return !!await readProviderFailedHeadChainProof(tx, g,
    input.requestedByOperatorId, input.correlationId, input.expectedGeneration);
  return false;
}
const action = "provider.runtime.resume_guard";
interface GuardCommand {
  commandId: string; commandType: string; expectedGeneration: bigint;
  requestedByOperatorId: string; correlationId: string; requestedAt: Date;
  expectedRuntimeGuard: ProviderRuntimeResumeGuard;
}

function catalogOriginPauseCommandDigest(value: Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>): string | null {
  if (!value || !value.completed_at) return null;
  const result = value.result as { outcome?: unknown; code?: unknown; generation?: unknown } | null;
  return providerResumeEvidenceDigest({
    id: value.id,
    idempotencyKey: value.idempotency_key,
    commandType: value.command_type,
    state: value.state,
    targetRunId: value.target_run_id,
    targetQuarantineId: value.target_quarantine_id,
    expectedGeneration: value.expected_generation.toString(),
    requestedByOperatorId: value.requested_by_operator_id,
    correlationId: value.correlation_id,
    reason: value.reason,
    resultOutcome: result?.outcome,
    resultCode: result?.code,
    resultGeneration: result?.generation,
    resultingRunId: value.resulting_run_id,
    requestedAt: value.requested_at.toISOString(),
    completedAt: value.completed_at.toISOString(),
  });
}

function semanticDigest(guard: ProviderRuntimeResumeGuard) {
  // A replay may hold a newly fenced lease; the reviewed state must be identical.
  const { expectedImportLease, notAfter, ...state } = guard;
  void expectedImportLease; void notAfter;
  return providerResumeEvidenceDigest(state);
}
export async function providerRuntimeResumeGuardMatches(transaction: ProviderTransactionClient,
  input: GuardCommand, lease: Awaited<ReturnType<typeof lockProviderWorkerLease>>, replay: boolean): Promise<boolean> {
  const g = input.expectedRuntimeGuard;
  const catalogOrigin = g.entry === "paused_catalog_origin";
  const catalogQueued = g.entry === "paused_catalog_queued";
  const checkpointValid = catalogOrigin
    ? g.checkpointHash === null && g.checkpoint === null && /^[a-f0-9]{64}$/u.test(g.originReceiptDigest)
    : catalogQueued
      ? g.checkpointHash === null && g.checkpoint === null
      : /^[a-f0-9]{64}$/u.test(g.checkpointHash) && providerMixedPageDigest(g.checkpoint) === g.checkpointHash;
  if (input.commandType !== "resume" || !g || typeof g !== "object" ||
    (g.notAfter !== undefined && (!(g.notAfter instanceof Date) || !Number.isFinite(g.notAfter.getTime()))) ||
    !/^[a-f0-9]{64}$/u.test(g.latestRunDigest) || g.configVersionNumber < 1n || g.runtimeRowVersion < 1n ||
    !checkpointValid || !providerWorkerLeaseIsLive(lease, g.expectedImportLease) ||
    lease.lease_expires_at === null || lease.lease_expires_at.getTime() - lease.database_now.getTime() < 15_000) return false;
  const [runtime, latest, active, commands, evidence] = await Promise.all([
    transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
    transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    transaction.local_audit_events.findMany({ where: { command_id: input.commandId, action }, take: 2 }),
  ]);
  const offset = replay ? 1n : 0n;
  const expectedActiveWork = catalogQueued ? 1 : 0;
  if (runtime.central_provider_id !== g.providerId || runtime.operating_state !== (replay ? "idle" :
    g.entry === "paused" || catalogOrigin || catalogQueued ? "paused" : "error") ||
    runtime.state_generation !== input.expectedGeneration + offset || runtime.row_version !== g.runtimeRowVersion + offset ||
    runtime.cached_config_version_id !== g.configVersionId || runtime.cached_config_version_number !== g.configVersionNumber ||
    (runtime.config_expires_at !== null && runtime.config_expires_at <= lease.database_now) ||
    runtime.source_cursor_hash !== g.checkpointHash || !isDeepStrictEqual(runtime.source_cursor, g.checkpoint) ||
    (!catalogOrigin && !catalogQueued && providerMixedPageDigest(runtime.source_cursor) !== g.checkpointHash) ||
    active !== expectedActiveWork || commands !== expectedActiveWork ||
    latest?.id !== g.latestRunId || providerResumeEvidenceDigest(latest) !== g.latestRunDigest ||
    !await matchesEntry(transaction, input, latest)) return false;
  // Use a fresh database clock after reads: lock waits or evidence queries can age the lease snapshot.
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`select clock_timestamp() as now`;
  if (!clock || lease.lease_expires_at.getTime() - clock.now.getTime() < 15_000 ||
    (g.notAfter !== undefined && g.notAfter.getTime() - clock.now.getTime() < 15_000)) return false;
  if (!replay) return evidence.length === 0;
  return evidence.length === 1 && evidence[0]!.outcome === "success" &&
    evidence[0]!.actor_operator_id === input.requestedByOperatorId && evidence[0]!.correlation_id === input.correlationId &&
    evidence[0]!.target_type === "control_command" && evidence[0]!.target_id === input.commandId &&
    isDeepStrictEqual(evidence[0]!.details, { guardDigest: semanticDigest(g) });
}
export async function appendProviderRuntimeResumeGuard(transaction: ProviderTransactionClient, input: GuardCommand) {
  await appendProviderLocalAudit(transaction, { commandId: input.commandId, actorOperatorId: input.requestedByOperatorId,
    correlationId: input.correlationId, action, targetType: "control_command", targetId: input.commandId,
    outcome: "success", details: { guardDigest: semanticDigest(input.expectedRuntimeGuard) }, occurredAt: input.requestedAt });
}
