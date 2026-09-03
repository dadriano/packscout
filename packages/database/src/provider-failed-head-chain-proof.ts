import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProviderQueryClient } from "./provider-database.ts";
import type { ProviderRuntimeResumeGuardCommon } from "./provider-runtime-resume-guard.ts";
import { providerInitialFailedHeadGuardMatches, providerResumeEvidenceDigest as digest,
  type ProviderInitialFailedHeadEntry } from "./provider-runtime-failed-head-guard.ts";
import { providerFailedHeadLifecycleMatches } from "./provider-failed-head-lifecycle-proof.ts";
interface AuditPin { readonly sequence: string; readonly digest: string }
export interface ProviderFailedHeadChainEntry extends Omit<ProviderInitialFailedHeadEntry, "entry"> {
  readonly entry: "failed_zero_commit_chain_from_head";
  readonly chain: {
    readonly organizationId: string; readonly providerKey: string; readonly authorityDigest: string;
    readonly migrationProofDigest: string; readonly rootOperationId: string; readonly releasedFence: string;
    readonly previous: { readonly operationId: string; readonly runId: string; readonly runDigest: string;
      readonly commandDigest: string; readonly failureCode: string; readonly finishedAt: string;
      readonly generation: string; readonly runtimeRowVersion: string; readonly importFence: string; readonly reviewDigest: string };
    readonly receipt: AuditPin; readonly completed: AuditPin; readonly leaseClaim: AuditPin;
    readonly resumeGuard: AuditPin; readonly requested: AuditPin; readonly resume: { readonly id: string; readonly digest: string };
  };
}
export function providerFailedHeadOperationIds(operationId: string) {
  const id = (label: string) => {
    const hex = createHash("sha256").update(`${operationId}/failed-head/${label}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { resume: id("resume"), command: id("command"), run: id("run"), owner: `local:failed-head:${operationId}`,
    resumeKey: `failed-head/${operationId}/resume`, runKey: `failed-head/${operationId}/run` };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const action = "provider.failed_head.continuation";
const zero = ["page_count", "catalog_record_count", "pull_record_count", "market_event_record_count",
  "accepted_count", "duplicate_count", "quarantined_count", "material_change_count"] as const;
const integer = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/u.test(v) && BigInt(v) < 9_223_372_036_854_775_807n;
/** Explicit depth-two proof. Reads only; the caller must own its transaction and admission lease. */
export async function readProviderFailedHeadChainProof(db: ProviderQueryClient,
  g: ProviderRuntimeResumeGuardCommon & ProviderFailedHeadChainEntry, operatorId: string, operationId: string,
  generation: bigint): Promise<string | null> {
  const c = g.chain, p = c?.previous;
  if (!p || !c.resume || !Array.isArray(g.provenance) || g.provenance.length !== 4 ||
    g.provenance.some(row => !integer(row.sequence) || !/^[a-f0-9]{64}$/u.test(row.digest)) || !integer(c.releasedFence) || !integer(p.generation) || !integer(p.runtimeRowVersion) || !integer(p.importFence) ||
    new Set([operationId, p.operationId, c.rootOperationId]).size !== 3 ||
    new Set([g.latestRunId, p.runId, g.priorHeadRunId]).size !== 3 || generation !== BigInt(p.generation) + 3n ||
    g.runtimeRowVersion !== BigInt(p.runtimeRowVersion) + 3n) return null;
  const ids = providerFailedHeadOperationIds(p.operationId), nextIds = providerFailedHeadOperationIds(operationId);
  if (ids.run !== g.latestRunId || ids.resume !== c.resume.id) return null;
  const auditPins = [{ ...c.receipt, action }, { ...c.completed, action: `${action}.completed` },
    { ...c.leaseClaim, action: `${action}.lease_claimed` }, { ...c.resumeGuard, action: "provider.runtime.resume_guard" },
    { ...c.requested, action: "provider.run.requested" }];
  if (auditPins.some(row => !integer(row.sequence) || !/^[a-f0-9]{64}$/u.test(row.digest)) ||
    new Set([...auditPins, ...g.provenance].map(row => row.sequence)).size !== 9) return null;
  const [root, leaf, audits, commands, pages, runs, continuations, rootAudits] = await Promise.all([
    db.provider_runs.findUnique({ where: { id: p.runId } }), db.provider_runs.findUnique({ where: { id: g.latestRunId } }),
    db.local_audit_events.findMany({ where: { correlation_id: p.operationId }, orderBy: { sequence: "asc" }, take: 129 }),
    db.control_commands.findMany({ where: { correlation_id: p.operationId }, take: 3 }),
    db.provider_run_pages.count({ where: { provider_run_id: { in: [p.runId, g.latestRunId] } } }),
    db.provider_runs.findMany({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], take: 1025 }),
    db.local_audit_events.findMany({ where: { action, target_id: { in: [p.runId, g.latestRunId] } }, take: 4 }),
    db.local_audit_events.findMany({ where: { sequence: { in: g.provenance.map(row => BigInt(row.sequence)) } }, take: 5 }),
  ]);
  if (!root || !leaf || audits.length > 128 || commands.length !== 2 || runs.length > 1024 || pages !== 0 ||
    runs.some(row => row.requested_at >= root.requested_at && ![root.id, leaf.id, g.priorHeadRunId, nextIds.run].includes(row.id)) ||
    continuations.length > 2 || continuations.filter(row => row.correlation_id === p.operationId).length !== 1 ||
    continuations.some(row => ![p.operationId, operationId].includes(row.correlation_id))) return null;
  const rows = auditPins.map(pin => audits.find(row => row.sequence.toString() === pin.sequence));
  if (rows.some((row, i) => !row || row.action !== auditPins[i]!.action || digest(row) !== auditPins[i]!.digest) ||
    auditPins.filter(pin => pin.action !== `${action}.lease_claimed`).some(pin => audits.filter(row => row.action === pin.action).length !== 1)) return null;
  const [receiptRow, completed, claim, resumeGuard, requested] = rows;
  if (!receiptRow || !completed || !claim || !resumeGuard || !requested) return null;
  const receipt = object(receiptRow.details), review = object(receipt.review), pins = object(review.pins);
  if (receipt.version !== 1 || receipt.sourceRequestsPerformed !== false || receipt.automaticRetryPolicyChanged !== false ||
    Object.keys(receipt).sort().join() !== "automaticRetryPolicyChanged,historyDigest,review,sourceRequestsPerformed,version" ||
    review.version !== 1 || review.authorization !== "operator_requested_zero_commit_head_continuation" || digest(review) !== p.reviewDigest ||
    !/^[a-f0-9]{64}$/u.test(String(receipt.historyDigest)) || pins.operationId !== p.operationId || pins.initialRunId !== root.id ||
    pins.organizationId !== c.organizationId || pins.providerId !== g.providerId || pins.providerKey !== c.providerKey ||
    pins.configId !== g.configVersionId || pins.operatorId !== operatorId || review.authorityDigest !== c.authorityDigest ||
    review.migrationProofDigest !== c.migrationProofDigest || review.configNumber !== g.configVersionNumber.toString() ||
    review.generation !== p.generation || review.runtimeRowVersion !== p.runtimeRowVersion || review.importFence !== p.importFence ||
    review.parentDigest !== p.runDigest || review.parentCommandDigest !== p.commandDigest || review.failureCode !== p.failureCode ||
    review.finishedAt !== p.finishedAt || review.checkpointHash !== g.checkpointHash || review.priorOperationId !== c.rootOperationId ||
    review.priorHeadRunId !== g.priorHeadRunId || review.priorHeadRunDigest !== g.priorHeadRunDigest ||
    review.priorHeadProofDigest !== g.priorHeadProofDigest) return null;
  const rootGuard = { ...g, entry: "failed_zero_commit_from_head" as const, latestRunId: root.id, latestRunDigest: p.runDigest,
    runtimeRowVersion: BigInt(p.runtimeRowVersion), parentCommandDigest: p.commandDigest, failureCode: p.failureCode, finishedAt: p.finishedAt };
  if (root.trigger !== "manual" || root.recovery_of_run_id !== null || root.requested_by_operator_id !== operatorId || digest(root) !== p.runDigest || !await providerInitialFailedHeadGuardMatches(db, rootGuard, root) ||
    rootAudits.length !== 4 || rootAudits.some(row => row.actor_operator_id !== operatorId || row.outcome !== "success" ||
      row.correlation_id !== c.rootOperationId || row.target_type !== "provider_run" || row.target_id !== g.priorHeadRunId) ||
    object(rootAudits.find(row => row.action === "local.provider_continuous.cycle")?.details).runId !== root.id) return null;
  const provenance = object(review.provenance);
  const names = ["adoption", "adoptionCompleted", "operation", "cycle"];
  const actions = ["provider.paused_head.adoption", "provider.paused_head.adoption.completed", "local.provider_continuous.operation", "local.provider_continuous.cycle"];
  if (names.some((name, i) => { const expected = g.provenance.find(row => row.action === actions[i]);
    return !expected || !isDeepStrictEqual(provenance[name], { sequence: expected.sequence, digest: expected.digest }); }) ||
    !isDeepStrictEqual(provenance.adoptionResume, { id: g.adoptionResumeId, digest: g.adoptionResumeDigest })) return null;
  const resume = commands.find(row => row.id === ids.resume), command = commands.find(row => row.id === ids.command);
  const resumeResult = object(resume?.result), result = object(command?.result), oldGeneration = BigInt(p.generation);
  if (!resume || !command || digest(resume) !== c.resume.digest || digest(command) !== g.parentCommandDigest ||
    resume.command_type !== "resume" || resume.state !== "completed" || !resume.completed_at || resume.expected_generation !== oldGeneration ||
    resume.idempotency_key !== ids.resumeKey || resume.requested_by_operator_id !== operatorId ||
    resume.resulting_run_id !== null || resume.target_run_id !== null || resume.target_quarantine_id !== null || resume.reason !== null ||
    resumeResult.outcome !== "accepted" || resumeResult.code !== "RUNTIME_TRANSITION_APPLIED" || resumeResult.generation !== (oldGeneration + 1n).toString() ||
    command.command_type !== "run" || command.state !== "completed" || !command.completed_at || command.expected_generation !== oldGeneration + 1n ||
    command.idempotency_key !== ids.runKey || command.requested_by_operator_id !== operatorId || command.resulting_run_id !== leaf.id ||
    command.target_run_id !== null || command.target_quarantine_id !== null || command.reason !== null ||
    result.outcome !== "accepted" || result.code !== "RUN_STARTED" || result.generation !== (oldGeneration + 2n).toString()) return null;
  if (leaf.worker_fence !== BigInt(c.releasedFence) || leaf.state !== "failed" || leaf.reached_source_head || leaf.failure_code !== g.failureCode || leaf.finished_at?.toISOString() !== g.finishedAt ||
    digest(leaf) !== g.latestRunDigest || zero.some(column => leaf[column] !== 0) || leaf.control_command_id !== command.id ||
    leaf.trigger !== "manual" || leaf.requested_by_operator_id !== operatorId || leaf.recovery_of_run_id !== null ||
    leaf.config_version_id !== g.configVersionId || leaf.config_version_number !== g.configVersionNumber ||
    leaf.requested_cursor_hash !== g.checkpointHash || leaf.final_cursor_hash !== g.checkpointHash ||
    !isDeepStrictEqual(leaf.requested_cursor, g.checkpoint) || !isDeepStrictEqual(leaf.final_cursor, g.checkpoint) ||
    !root.finished_at || !leaf.started_at || leaf.requested_at < root.finished_at || leaf.started_at < leaf.requested_at ||
    leaf.finished_at <= root.finished_at || leaf.finished_at < leaf.started_at) return null;
  const receiptDigest = digest(receipt);
  for (const row of [receiptRow, completed, claim]) if (row.target_type !== "provider_run" || row.target_id !== root.id) return null;
  if (!isDeepStrictEqual(completed.details, { receiptDigest, resumeCommandId: ids.resume, runId: ids.run, commandId: ids.command }) ||
    resumeGuard.command_id !== ids.resume || resumeGuard.target_type !== "control_command" || resumeGuard.target_id !== ids.resume ||
    requested.command_id !== ids.command || requested.target_type !== "provider_run" || requested.target_id !== leaf.id ||
    !isDeepStrictEqual(requested.details, { commandType: "run", resultCode: "RUN_QUEUED", runId: leaf.id, stateGeneration: (oldGeneration + 1n).toString() })) return null;
  const { chain: _chain, expectedImportLease: _lease, notAfter: _deadline, ...semanticRootGuard } = rootGuard;
  void _chain; void _lease; void _deadline;
  if (!isDeepStrictEqual(resumeGuard.details, { guardDigest: digest(semanticRootGuard) })) return null;
  const claims = audits.filter(row => row.action === `${action}.lease_claimed`);
  if (!claims.length || claims.length > 32 || claims.some(row => {
    const d = object(row.details);
    return row.target_type !== "provider_run" || row.target_id !== root.id || d.owner !== ids.owner ||
      d.receiptDigest !== receiptDigest || !integer(d.fence) || BigInt(d.fence) <= BigInt(p.importFence) ||
      BigInt(d.fence) > BigInt(p.importFence) + 64n || Object.keys(d).length !== 3;
  })) return null;
  const lastFence = claims.reduce((value, row) => BigInt(object(row.details).fence as string) > value ? BigInt(object(row.details).fence as string) : value, 0n);
  if (object(claim.details).fence !== lastFence.toString() || leaf.worker_fence !== lastFence + 1n ||
    receiptRow.sequence >= claim.sequence || claim.sequence >= completed.sequence || receiptRow.sequence >= resumeGuard.sequence || resumeGuard.sequence >= requested.sequence ||
    requested.sequence >= completed.sequence) return null;
  if (!providerFailedHeadLifecycleMatches({ audits, providerId: g.providerId, operatorId, operationId: p.operationId,
    resume, command, leaf, generation: oldGeneration, completed, resumeGuard, requested })) return null;
  return digest({ root, leaf, audits, commands });
}
