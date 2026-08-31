import { isDeepStrictEqual } from "node:util";
import type { ProviderQueryClient } from "./provider-database.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { readProviderRunHeadProof } from "./provider-run-head-proof.ts";
import type { ProviderRuntimeResumeGuardCommon } from "./provider-runtime-resume-guard.ts";
export interface ProviderInitialFailedHeadEntry {
  readonly entry: "failed_zero_commit_from_head";
  readonly failureCode: string; readonly finishedAt: string;
  readonly priorHeadRunId: string; readonly priorHeadRunDigest: string; readonly priorHeadProofDigest: string;
  readonly parentCommandDigest: string;
  readonly provenance: readonly { readonly sequence: string; readonly action: string; readonly digest: string }[];
  readonly adoptionResumeId: string; readonly adoptionResumeDigest: string;
}
const failedHeadProvenanceActions = ["provider.paused_head.adoption", "provider.paused_head.adoption.completed",
  "local.provider_continuous.operation", "local.provider_continuous.cycle"] as const;
const zeroCounterColumns = ["page_count", "catalog_record_count", "pull_record_count", "market_event_record_count",
  "accepted_count", "duplicate_count", "quarantined_count", "material_change_count"] as const;
export async function providerInitialFailedHeadGuardMatches(tx: ProviderQueryClient,
  g: ProviderRuntimeResumeGuardCommon & Omit<ProviderInitialFailedHeadEntry, "entry">,
  latest: Awaited<ReturnType<ProviderQueryClient["provider_runs"]["findUnique"]>>) {
  if (!latest || latest.state !== "failed" || latest.reached_source_head ||
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
