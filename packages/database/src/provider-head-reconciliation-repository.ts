import { randomUUID } from "node:crypto";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import type { ProviderFactReferenceScanCursor } from "./provider-canonical-contract.ts";
import { reconcileProviderFactReferencesTransaction } from "./provider-canonical-repository.ts";
import { reconcileProviderFactQuarantineTransaction } from "./provider-fact-quarantine-reconciliation-repository.ts";
import { appendProviderLocalAudit } from "./provider-local-evidence.ts";
import { readProviderRunHeadProof, PROVIDER_HEAD_RECONCILIATION_ACTION } from "./provider-run-head-proof.ts";
import { lockProviderWorkerLease, providerWorkerLeaseIsLive, setProviderImportLeaseContext } from "./provider-worker-lease-repository.ts";

import { providerHeadUuidPattern as uuid, invalidProviderHeadProof as invalid,
  parseProviderHeadProgress as parseProgress, type ProviderHeadProgress as Progress } from "./provider-head-reconciliation-progress.ts";
async function scanPosition(tx: ProviderTransactionClient, state: Progress): Promise<ProviderFactReferenceScanCursor> {
  const pack = state.packAfterId === null ? null
    : await tx.packs.findUnique({ where: { id: state.packAfterId }, select: { pack_key: true } });
  const collectible = state.collectibleAfterId === null ? null
    : await tx.collectibles.findUnique({ where: { id: state.collectibleAfterId }, select: { collectible_key: true } });
  if ((state.packAfterId !== null && pack === null) || (state.collectibleAfterId !== null && collectible === null)) return invalid();
  return { packs: { afterKey: pack?.pack_key ?? null, done: state.packScanDone },
    collectibles: { afterKey: collectible?.collectible_key ?? null, done: state.collectibleScanDone } };
}
async function retainPosition(tx: ProviderTransactionClient, state: Progress, scan: ProviderFactReferenceScanCursor): Promise<void> {
  const pack = scan.packs.afterKey === null ? null
    : await tx.packs.findUnique({ where: { pack_key: scan.packs.afterKey }, select: { id: true } });
  const collectible = scan.collectibles.afterKey === null ? null
    : await tx.collectibles.findUnique({ where: { collectible_key: scan.collectibles.afterKey }, select: { id: true } });
  if ((scan.packs.afterKey !== null && pack === null) || (scan.collectibles.afterKey !== null && collectible === null)) return invalid();
  state.packAfterId = pack?.id ?? null; state.collectibleAfterId = collectible?.id ?? null;
  state.packScanDone = scan.packs.done; state.collectibleScanDone = scan.collectibles.done;
}

/** One bounded head batch per transaction, with its continuation committed alongside fact promotions. */
export class PrismaProviderHeadReconciliationRepository {
  constructor(private readonly database: ProviderPrismaClient) {}
  async step(input: { runId: string; workerId: string; workerFence: bigint }): Promise<"progress" | "complete" | "lease_lost" | "run_not_ready"> {
    if (!uuid.test(input.runId)) return invalid();
    return this.database.$transaction(async tx => {
      const lease = await lockProviderWorkerLease(tx, "import");
      if (!providerWorkerLeaseIsLive(lease, { owner: input.workerId, fence: input.workerFence })) return "lease_lost";
      await setProviderImportLeaseContext(tx, { owner: input.workerId, fence: input.workerFence });
      const [run] = await tx.$queryRaw<Array<{ config_id: string; ready: boolean; full_replay: boolean; pages: number;
        checkpoint: Prisma.JsonValue; checkpoint_hash: string | null }>>(Prisma.sql`
        SELECT run.config_version_id AS config_id, run.page_count AS pages,
          (run.state = 'running' AND run.worker_fence = ${input.workerFence} AND run.reached_source_head
           AND runtime.operating_state = 'running' AND runtime.cached_config_version_id = run.config_version_id
           AND runtime.cached_config_version_number = run.config_version_number) AS ready,
          (run.requested_cursor IS NULL AND run.requested_cursor_hash IS NULL) AS full_replay,
          runtime.source_cursor AS checkpoint, runtime.source_cursor_hash AS checkpoint_hash
        FROM provider_runs AS run CROSS JOIN provider_runtime AS runtime
        WHERE run.id = ${input.runId}::uuid AND runtime.singleton_key = TRUE
        FOR UPDATE OF run, runtime
      `);
      if (!run?.ready) return "run_not_ready";
      const proof = await readProviderRunHeadProof(tx, input.runId);
      if (!proof) return invalid();
      const receipt = proof.receipt;
      const state: Progress = receipt ? parseProgress(receipt.details) : {
        schemaVersion: 1, headPageId: proof.headPageId, configVersionId: run.config_id, checkpointHash: run.checkpoint_hash,
        leaseFence: input.workerFence.toString(), batchNumber: 0, phase: "facts", packAfterId: null,
        collectibleAfterId: null, packScanDone: false, collectibleScanDone: false,
        quarantineAfterId: null, quarantineAfterAt: null,
      };
      if ((receipt && (receipt.outcome !== "success" || receipt.targetType !== "provider_run"))
        || state.headPageId !== proof.headPageId || state.configVersionId !== run.config_id
        || state.checkpointHash !== run.checkpoint_hash || state.leaseFence !== (receipt?.workerFence ?? input.workerFence).toString()) return invalid();
      // Recovery inherits the scan position, but its audit batches belong to the new fenced run.
      if (receipt && receipt.workerFence !== input.workerFence) state.batchNumber = 0;
      if (state.phase === "complete") return "complete";
      state.leaseFence = input.workerFence.toString();
      if (state.phase === "facts") {
        const result = await reconcileProviderFactReferencesTransaction(tx, { after: await scanPosition(tx, state) });
        if (result.nextScanCursor) await retainPosition(tx, state, result.nextScanCursor);
        else { state.packScanDone = true; state.collectibleScanDone = true; state.phase = proof.fullReplay ? "quarantines" : "complete"; }
      }
      if (state.phase === "quarantines") {
        const result = await reconcileProviderFactQuarantineTransaction(tx, { ...input, limit: 100,
          ...(state.quarantineAfterId === null ? {} : { after: { quarantineId: state.quarantineAfterId,
            createdAt: new Date(state.quarantineAfterAt!) } }) });
        if (result.kind !== "reconciled") return invalid();
        if (result.nextScanCursor) {
          state.quarantineAfterId = result.nextScanCursor.quarantineId;
          state.quarantineAfterAt = result.nextScanCursor.createdAt.toISOString();
        } else state.phase = "complete";
      }
      state.batchNumber += 1;
      await tx.provider_runs.update({ where: { id: input.runId }, data: {
        heartbeat_at: lease.database_now, last_progress_at: lease.database_now, row_version: { increment: 1n },
      } });
      await tx.provider_runtime.update({ where: { singleton_key: true }, data: {
        last_runner_heartbeat_at: lease.database_now, row_version: { increment: 1n },
      } });
      await appendProviderLocalAudit(tx, { correlationId: randomUUID(), action: PROVIDER_HEAD_RECONCILIATION_ACTION,
        targetType: "provider_run", targetId: input.runId, outcome: "success", details: { ...state }, occurredAt: new Date() });
      return state.phase === "complete" ? "complete" : "progress";
    }, { maxWait: 5_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
