import { parseProviderHeadProgress } from "./provider-head-reconciliation-progress.ts";
import type { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderQueryClient } from "./provider-database.ts";
import type { CanonicalJsonValue } from "./provider-canonical-contract.ts";
import { providerMixedCursorFingerprint } from "./provider-mixed-page-contract.ts";

export const PROVIDER_HEAD_RECONCILIATION_ACTION = "provider.run.head_reconciliation";
export interface ProviderRunHeadProof {
  readonly runId: string; readonly sourceRunId: string; readonly headPageId: string; readonly pageNumber: number;
  readonly checkpointHash: string | null; readonly configVersionId: string; readonly configVersionNumber: bigint;
  readonly fullReplay: boolean; readonly reconciliationComplete: boolean;
  readonly receipt: Readonly<{ details: Prisma.JsonValue; outcome: string; targetType: string; workerFence: bigint }> | null;
}
const fingerprint = (value: Prisma.JsonValue) => providerMixedCursorFingerprint(value as CanonicalJsonValue);

/** Read-only proof through exact fenced recovery ancestry; never fabricates a child source page. */
export async function readProviderRunHeadProof(database: ProviderQueryClient, runId: string): Promise<ProviderRunHeadProof | null> {
  const runtime = await database.provider_runtime.findUnique({ where: { singleton_key: true } });
  if (!runtime || fingerprint(runtime.source_cursor) !== runtime.source_cursor_hash) return null;
  let id = runId; let receipt: ProviderRunHeadProof["receipt"] = null;
  for (let depth = 0; depth < 128; depth += 1) {
    const run = await database.provider_runs.findUnique({ where: { id } });
    if (!run || !run.reached_source_head || run.config_version_id !== runtime.cached_config_version_id
      || run.config_version_number !== runtime.cached_config_version_number) return null;
    if (depth === 0 ? !["running", "succeeded"].includes(run.state)
      : run.state !== "incomplete" || run.failure_code !== "PROVIDER_IMPORT_LEASE_EXPIRED"
        || run.final_cursor_hash !== runtime.source_cursor_hash || fingerprint(run.final_cursor) !== runtime.source_cursor_hash) return null;
    if (receipt === null) {
      const saved = await database.local_audit_events.findFirst({ where: { action: PROVIDER_HEAD_RECONCILIATION_ACTION,
        target_id: run.id }, orderBy: { sequence: "desc" } });
      if (saved) receipt = { details: saved.details, outcome: saved.outcome,
        targetType: saved.target_type, workerFence: run.worker_fence };
    }
    const page = await database.provider_run_pages.findFirst({ where: { provider_run_id: run.id }, orderBy: { page_number: "desc" } });
    if (page) {
      if (page.continuation !== "head" || page.page_number !== run.page_count
        || page.next_cursor_hash !== runtime.source_cursor_hash || fingerprint(page.next_cursor) !== runtime.source_cursor_hash) return null;
      let reconciliationComplete = false;
      if (receipt) {
        try {
          const progress = parseProviderHeadProgress(receipt.details);
          if (receipt.outcome !== "success" || receipt.targetType !== "provider_run"
            || progress.headPageId !== page.id || progress.configVersionId !== run.config_version_id
            || progress.checkpointHash !== runtime.source_cursor_hash
            || progress.leaseFence !== receipt.workerFence.toString()) return null;
          reconciliationComplete = progress.phase === "complete";
        } catch { return null; }
      }
      return { runId, sourceRunId: run.id, headPageId: page.id, pageNumber: page.page_number,
        checkpointHash: runtime.source_cursor_hash, configVersionId: run.config_version_id,
        configVersionNumber: run.config_version_number, fullReplay: run.requested_cursor === null && run.requested_cursor_hash === null, reconciliationComplete, receipt };
    }
    if (run.page_count !== 0 || run.trigger !== "recovery" || !run.recovery_of_run_id
      || run.requested_cursor_hash !== runtime.source_cursor_hash || fingerprint(run.requested_cursor) !== runtime.source_cursor_hash) return null;
    id = run.recovery_of_run_id;
  }
  return null;
}
