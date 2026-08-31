import { PrismaProviderCommandRepository, PrismaProviderWorkerLeaseRepository, acquireProviderWorkerLease, lockProviderWorkerLease,
  providerWorkerLeaseIsLive, type CanonicalJsonValue, type ProviderPrismaClient, type ProviderQueryClient,
  type ProviderTransactionClient } from "@packscout/database";
import { runRemoteHealthTransaction } from "./remote-provider-health-transaction.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { pausedHeadAction as action, pausedHeadDigest as digest, pausedHeadIds, pausedHeadReceiptSchema,
  refusePausedHead as refuse, type PausedHeadReview, type PausedHeadReceipt } from "./provider-paused-head-policy.mts";
import { assertPausedHeadAuthority, assertPausedHeadBoundary, pausedHeadHistory,
  readPausedHeadSnapshot } from "./provider-paused-head-state.mts";

const txOptions = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 25_000 };
const transaction = <T>(db: ProviderPrismaClient, operation: (tx: ProviderTransactionClient) => Promise<T>) =>
  runRemoteHealthTransaction(callback => db.$transaction(callback, txOptions), operation);
export function createPausedHeadAdoption(review: PausedHeadReview) {
  const p = review.pins, ids = pausedHeadIds(review);
  async function readReceipt(db: ProviderQueryClient) {
    const rows = await db.local_audit_events.findMany({ where: { correlation_id: p.operationId }, take: 129 });
    const allowed = new Set([action, `${action}.lease_claimed`, `${action}.completed`, "provider.runtime.resume_guard",
      "provider.runtime.transition", "provider.command.terminal"]);
    if (rows.length > 128 || rows.some(row => !allowed.has(row.action))) refuse("PAUSED_HEAD_OPERATION_REUSED");
    const receipts = rows.filter(row => row.action === action);
    if (!receipts.length) { if (rows.length) refuse("PAUSED_HEAD_FOREIGN_RECEIPT"); return null; }
    const row = receipts[0]!, parsed = pausedHeadReceiptSchema.safeParse(row.details);
    if (receipts.length !== 1 || !parsed.success || row.actor_operator_id !== p.operatorId || row.target_id !== p.initialRunId ||
      row.target_type !== "provider_run" || row.outcome !== "success" || digest(parsed.data.review) !== digest(review)) {
      refuse("PAUSED_HEAD_RECEIPT_DRIFT");
    }
    return parsed.data;
  }
  async function resumeRecorded(db: ProviderQueryClient) {
    const row = await db.control_commands.findUnique({ where: { id: ids.resume } });
    const result = row?.result as { outcome?: unknown; generation?: unknown; code?: unknown } | null;
    if (row && (row.command_type !== "resume" || row.state !== "completed" || row.expected_generation !== BigInt(review.generation) ||
      row.idempotency_key !== ids.resumeKey || row.correlation_id !== p.operationId || row.requested_by_operator_id !== p.operatorId ||
      row.reason !== null || row.target_run_id !== null || row.target_quarantine_id !== null || row.resulting_run_id !== null ||
      result?.outcome !== "accepted" || result.generation !== (BigInt(review.generation) + 1n).toString() ||
      result.code !== "RUNTIME_TRANSITION_APPLIED")) refuse("PAUSED_HEAD_RESUME_DRIFT");
    return row !== null;
  }
  async function completed(db: ProviderQueryClient, receipt: PausedHeadReceipt) {
    const rows = await db.local_audit_events.findMany({ where: { correlation_id: p.operationId, action: `${action}.completed` }, take: 2 });
    if (rows.length > 1 || rows.some(row => row.actor_operator_id !== p.operatorId || row.target_id !== p.initialRunId ||
      row.outcome !== "success" || digest(row.details) !== digest({ receiptDigest: digest(receipt), resumeCommandId: ids.resume }))) {
      refuse("PAUSED_HEAD_COMPLETION_DRIFT");
    }
    return rows.length === 1;
  }
  async function releasedFence(db: ProviderQueryClient, receipt: PausedHeadReceipt | null) {
    let maximum = BigInt(review.importFence);
    if (!receipt) return maximum;
    const rows = await db.local_audit_events.findMany({ where: { correlation_id: p.operationId, action: `${action}.lease_claimed` }, take: 33 });
    if (rows.length > 32) refuse("PAUSED_HEAD_LEASE_ATTEMPT_BOUND");
    for (const row of rows) {
      const d = row.details as { owner?: string; fence?: string; receiptDigest?: string };
      if (row.actor_operator_id !== p.operatorId || row.target_id !== p.initialRunId || row.outcome !== "success" ||
        d.owner !== ids.owner || !/^[1-9][0-9]*$/u.test(d.fence ?? "") || d.receiptDigest !== digest(receipt) ||
        Object.keys(d).length !== 3) refuse("PAUSED_HEAD_LEASE_RECEIPT_DRIFT");
      const fence = BigInt(d.fence!);
      if (fence <= BigInt(review.importFence) || fence > BigInt(review.importFence) + 64n) refuse("PAUSED_HEAD_LEASE_RECEIPT_DRIFT");
      if (fence > maximum) maximum = fence;
    }
    return maximum;
  }
  async function inspect(db: ProviderQueryClient, authority: BackfillAuthority) {
    const receipt = await readReceipt(db), resumed = await resumeRecorded(db);
    if (resumed && !receipt) refuse("PAUSED_HEAD_FOREIGN_RESUME");
    const snapshot = await readPausedHeadSnapshot(db, review, authority);
    assertPausedHeadBoundary(snapshot, review, authority, { receipt: receipt ?? undefined, resumed,
      releasedFence: await releasedFence(db, receipt) });
    const result = receipt ?? pausedHeadReceiptSchema.parse({ version: 1, review, historyDigest: pausedHeadHistory(snapshot),
      sourceRequestsPerformed: false, queuesCreated: false });
    const done = receipt ? await completed(db, receipt) : false;
    if (done && !resumed) refuse("PAUSED_HEAD_COMPLETION_DRIFT");
    return { receipt: result, resumed, completed: done, snapshot };
  }
  async function lock(tx: ProviderTransactionClient) {
    const lease = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${p.initialRunId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    return lease;
  }
  async function apply(db: ProviderPrismaClient, receipt: PausedHeadReceipt, readAuthority: () => Promise<BackfillAuthority>,
    assertProcess: () => Promise<void>, active: () => void = () => {}, notAfter?: Date) {
    await assertProcess(); const authority = await readAuthority(); assertPausedHeadAuthority(review, authority); active();
    let entryFence: bigint | undefined;
    await transaction(db, async tx => {
      await lock(tx); const current = await inspect(tx, authority);
      if (digest(current.receipt) !== digest(receipt)) refuse("PAUSED_HEAD_REVIEW_STALE");
      if (current.completed && current.snapshot.snapshot.lease.owner === null) return;
      active();
      if (!await readReceipt(tx)) await tx.local_audit_events.create({ data: { correlation_id: p.operationId,
        actor_operator_id: p.operatorId, action, target_type: "provider_run", target_id: p.initialRunId,
        outcome: "success", details: receipt, occurred_at: current.snapshot.snapshot.now } });
      entryFence = current.snapshot.snapshot.lease.fence;
    });
    if (entryFence === undefined) return { phase: "already_adopted", resumeCommandId: ids.resume, pins: p };
    active(); const leases = new PrismaProviderWorkerLeaseRepository(db);
    const held = await transaction(db, async tx => {
      await lock(tx); const current = await inspect(tx, authority);
      if (digest(current.receipt) !== digest(receipt) || current.snapshot.snapshot.lease.fence !== entryFence) {
        refuse("PAUSED_HEAD_LEASE_RACE");
      }
      active(); const acquired = await acquireProviderWorkerLease(tx, { role: "import", owner: ids.owner, leaseMilliseconds: 120_000 });
      if (acquired.kind !== "acquired" || acquired.lease.fence !== entryFence! + 1n) refuse("PAUSED_HEAD_LEASE_UNAVAILABLE");
      const claim = { owner: ids.owner, fence: acquired.lease.fence };
      active(); await tx.local_audit_events.create({ data: { correlation_id: p.operationId, actor_operator_id: p.operatorId,
        action: `${action}.lease_claimed`, target_type: "provider_run", target_id: p.initialRunId, outcome: "success",
        details: { owner: ids.owner, fence: claim.fence.toString(), receiptDigest: digest(receipt) }, occurred_at: acquired.lease.heartbeatAt } });
      return claim;
    });
    try {
      const guard = async (resumed: boolean) => {
        await assertProcess(); const fresh = await readAuthority(); assertPausedHeadAuthority(review, fresh); active();
        return transaction(db, async tx => {
          const lease = await lock(tx);
          if (!providerWorkerLeaseIsLive(lease, held)) refuse("PAUSED_HEAD_LEASE_UNAVAILABLE");
          const state = await readPausedHeadSnapshot(tx, review, fresh);
          assertPausedHeadBoundary(state, review, fresh, { receipt, resumed, held });
          if (digest(await readReceipt(tx)) !== digest(receipt) || await resumeRecorded(tx) !== resumed) refuse("PAUSED_HEAD_RECEIPT_DRIFT");
          return state;
        });
      };
      const resumed = await resumeRecorded(db), before = await guard(resumed);
      if (!resumed) {
        active(); const result = await new PrismaProviderCommandRepository(db).submit({
          commandId: ids.resume, commandType: "resume", expectedGeneration: BigInt(review.generation),
          targetRunId: null, targetQuarantineId: null,
          idempotencyKey: ids.resumeKey, requestedByOperatorId: p.operatorId, correlationId: p.operationId, reason: null,
          requestedAt: before.snapshot.now, expectedRuntimeGuard: { providerId: p.providerId, configVersionId: p.configId,
            configVersionNumber: BigInt(review.configNumber), runtimeRowVersion: BigInt(review.runtimeRowVersion),
            checkpointHash: review.checkpointHash, checkpoint: before.runtime.source_cursor as CanonicalJsonValue,
            pauseCommandId: review.pauseCommandId, pauseCommandDigest: review.pauseCommandDigest,
            latestRunId: p.initialRunId, latestRunDigest: review.parentDigest, expectedImportLease: held, notAfter } });
        if (!["accepted", "deduplicated"].includes(result.outcome) ||
          result.generation !== BigInt(review.generation) + 1n) refuse("PAUSED_HEAD_RESUME_REFUSED");
      }
      await guard(true);
      await transaction(db, async tx => {
        const lease = await lock(tx);
        if (!providerWorkerLeaseIsLive(lease, held)) refuse("PAUSED_HEAD_LEASE_UNAVAILABLE");
        assertPausedHeadBoundary(await readPausedHeadSnapshot(tx, review, authority), review, authority, { receipt, resumed: true, held });
        active(); if (!await completed(tx, receipt)) await tx.local_audit_events.create({ data: {
          correlation_id: p.operationId, actor_operator_id: p.operatorId, action: `${action}.completed`, target_type: "provider_run",
          target_id: p.initialRunId, outcome: "success", details: { receiptDigest: digest(receipt), resumeCommandId: ids.resume },
          occurred_at: lease.database_now } });
      });
      return { phase: "adopted", resumeCommandId: ids.resume, pins: p };
    } finally { if (!await leases.release({ role: "import", ...held })) refuse("PAUSED_HEAD_LEASE_RELEASE_REFUSED"); }
  }
  return { inspect, apply, readReceipt, resumeRecorded };
}
