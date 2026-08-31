import { isDeepStrictEqual } from "node:util";
import type { ProviderTransactionClient } from "./provider-database.ts";
import type { CanonicalJsonValue } from "./provider-canonical-contract.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { readProviderRunHeadProof } from "./provider-run-head-proof.ts";
import { appendProviderLocalAudit } from "./provider-local-evidence.ts";
import { providerWorkerLeaseIsLive, type lockProviderWorkerLease } from "./provider-worker-lease-repository.ts";

/** Caller-requested security boundary; each entry requires its own immutable provenance. */
interface ProviderRuntimeResumeGuardCommon {
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
  | { readonly entry: "failed_zero_commit_from_head"; readonly failureCode: string; readonly finishedAt: string;
      readonly priorHeadRunId: string; readonly priorHeadRunDigest: string; readonly priorHeadProofDigest: string;
      readonly parentCommandDigest: string;
      readonly provenance: readonly { readonly sequence: string; readonly action: string; readonly digest: string }[];
      readonly adoptionResumeId: string; readonly adoptionResumeDigest: string }
);
const failedHeadProvenanceActions = ["provider.paused_head.adoption", "provider.paused_head.adoption.completed",
  "local.provider_continuous.operation", "local.provider_continuous.cycle"] as const;
const zeroCounterColumns = ["page_count", "catalog_record_count", "pull_record_count", "market_event_record_count",
  "accepted_count", "duplicate_count", "quarantined_count", "material_change_count"] as const;
async function matchesEntry(tx: ProviderTransactionClient, input: GuardCommand, latest: Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findFirst"]>>) {
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
  if (g.entry !== "failed_zero_commit_from_head" || !latest || latest.state !== "failed" || latest.reached_source_head ||
    latest.failure_code !== g.failureCode || latest.finished_at?.toISOString() !== g.finishedAt ||
    zeroCounterColumns.some(column => latest[column] !== 0) ||
    latest.requested_cursor_hash !== g.checkpointHash || latest.final_cursor_hash !== g.checkpointHash ||
    !isDeepStrictEqual(latest.requested_cursor, g.checkpoint) || !isDeepStrictEqual(latest.final_cursor, g.checkpoint) ||
    !Array.isArray(g.provenance) || g.provenance.length !== 4 ||
    failedHeadProvenanceActions.some(action => g.provenance.filter(row => row.action === action).length !== 1) ||
    g.provenance.some(row => !/^[1-9][0-9]{0,18}$/u.test(row.sequence) || BigInt(row.sequence) > 9_223_372_036_854_775_807n ||
      !/^[a-f0-9]{64}$/u.test(row.digest)) || new Set(g.provenance.map(row => row.sequence)).size !== 4) return false;
  const [prior, proof, pages, audits, resume, parentCommand] = await Promise.all([
    tx.provider_runs.findUnique({ where: { id: g.priorHeadRunId } }), readProviderRunHeadProof(tx, g.priorHeadRunId),
    tx.provider_run_pages.count({ where: { provider_run_id: g.latestRunId } }),
    tx.local_audit_events.findMany({ where: { sequence: { in: g.provenance.map(row => BigInt(row.sequence)) } }, take: 5 }),
    tx.control_commands.findUnique({ where: { id: g.adoptionResumeId } }),
    latest.control_command_id ? tx.control_commands.findUnique({ where: { id: latest.control_command_id } }) : null,
  ]);
  return !!prior && prior.state === "succeeded" && prior.reached_source_head && prior.failure_code === null &&
    prior.config_version_id === g.configVersionId && prior.config_version_number === g.configVersionNumber &&
    prior.final_cursor_hash === g.checkpointHash && isDeepStrictEqual(prior.final_cursor, g.checkpoint) &&
    providerResumeEvidenceDigest(prior) === g.priorHeadRunDigest && !!proof && proof.reconciliationComplete &&
    proof.checkpointHash === g.checkpointHash && providerResumeEvidenceDigest(proof) === g.priorHeadProofDigest &&
    latest.config_version_id === g.configVersionId && latest.config_version_number === g.configVersionNumber &&
    !!parentCommand && parentCommand.state === "completed" && parentCommand.command_type === "run" &&
    parentCommand.resulting_run_id === latest.id && providerResumeEvidenceDigest(parentCommand) === g.parentCommandDigest &&
    pages === 0 && audits.length === 4 && g.provenance.every(expected => audits.some(row => row.sequence.toString() === expected.sequence &&
      row.action === expected.action && providerResumeEvidenceDigest(row) === expected.digest)) &&
    !!resume && resume.state === "completed" && resume.command_type === "resume" &&
    providerResumeEvidenceDigest(resume) === g.adoptionResumeDigest;
}
export function providerResumeEvidenceDigest(value: unknown): string {
  return providerMixedPageDigest(JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item)));
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
