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
export interface ProviderRuntimeResumeGuardCommon {
  readonly providerId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly runtimeRowVersion: bigint;
  readonly checkpointHash: string;
  readonly checkpoint: CanonicalJsonValue;
  readonly latestRunId: string;
  readonly latestRunDigest: string;
  readonly expectedImportLease: { readonly owner: string; readonly fence: bigint };
  /** Ephemeral admission deadline, never part of immutable replay identity. */
  readonly notAfter?: Date;
}
export type ProviderRuntimeResumeGuard = ProviderRuntimeResumeGuardCommon & (
  | { readonly entry: "paused"; readonly pauseCommandId: string; readonly pauseCommandDigest: string }
  | ProviderInitialFailedHeadEntry
  | ProviderFailedHeadChainEntry
);
async function matchesEntry(tx: ProviderTransactionClient, input: GuardCommand,
  latest: Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findFirst"]>>) {
  const g = input.expectedRuntimeGuard;
  if (g.entry === "paused") {
    if (!/^[a-f0-9]{64}$/u.test(g.pauseCommandDigest)) return false;
    const pause = await tx.control_commands.findUnique({ where: { id: g.pauseCommandId } });
    const result = pause?.result as { outcome?: unknown; generation?: unknown } | null;
    return !!pause && pause.command_type === "pause" && pause.state === "completed" && !!pause.completed_at &&
      pause.requested_by_operator_id === input.requestedByOperatorId && pause.expected_generation + 1n === input.expectedGeneration &&
      result?.outcome === "accepted" && result.generation === input.expectedGeneration.toString() &&
      providerResumeEvidenceDigest(pause) === g.pauseCommandDigest;
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
function semanticDigest(guard: ProviderRuntimeResumeGuard) {
  // A replay may hold a newly fenced lease; the reviewed state must be identical.
  const { expectedImportLease, notAfter, ...state } = guard;
  void expectedImportLease; void notAfter;
  return providerResumeEvidenceDigest(state);
}
export async function providerRuntimeResumeGuardMatches(transaction: ProviderTransactionClient,
  input: GuardCommand, lease: Awaited<ReturnType<typeof lockProviderWorkerLease>>, replay: boolean): Promise<boolean> {
  const g = input.expectedRuntimeGuard;
  if (input.commandType !== "resume" || !g || typeof g !== "object" ||
    (g.notAfter !== undefined && (!(g.notAfter instanceof Date) || !Number.isFinite(g.notAfter.getTime()))) ||
    !/^[a-f0-9]{64}$/u.test(g.checkpointHash) ||
    !/^[a-f0-9]{64}$/u.test(g.latestRunDigest) || g.configVersionNumber < 1n || g.runtimeRowVersion < 1n ||
    providerMixedPageDigest(g.checkpoint) !== g.checkpointHash || !providerWorkerLeaseIsLive(lease, g.expectedImportLease) ||
    lease.lease_expires_at === null || lease.lease_expires_at.getTime() - lease.database_now.getTime() < 15_000) return false;
  const [runtime, latest, active, commands, evidence] = await Promise.all([
    transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
    transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    transaction.local_audit_events.findMany({ where: { command_id: input.commandId, action }, take: 2 }),
  ]);
  const offset = replay ? 1n : 0n;
  if (runtime.central_provider_id !== g.providerId || runtime.operating_state !== (replay ? "idle" : g.entry === "paused" ? "paused" : "error") ||
    runtime.state_generation !== input.expectedGeneration + offset || runtime.row_version !== g.runtimeRowVersion + offset ||
    runtime.cached_config_version_id !== g.configVersionId || runtime.cached_config_version_number !== g.configVersionNumber ||
    (runtime.config_expires_at !== null && runtime.config_expires_at <= lease.database_now) ||
    runtime.source_cursor_hash !== g.checkpointHash || !isDeepStrictEqual(runtime.source_cursor, g.checkpoint) ||
    providerMixedPageDigest(runtime.source_cursor) !== g.checkpointHash || active !== 0 || commands !== 0 ||
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
