import { isDeepStrictEqual } from "node:util";
import { PrismaAdminProviderRuntimeRepository, PrismaProviderWorkerLeaseRepository, lockProviderWorkerLease,
  providerWorkerLeaseIsLive, type ProviderPrismaClient, type ProviderQueryClient, type ProviderTransactionClient } from "@packscout/database";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { continuationAction as action, continuationDigest as digest, continuationIds,
  continuationReceiptSchema, refuseContinuation as refuse, type ContinuationReview, type ContinuationReceipt } from "./provider-operator-continuation-policy.mts";
import { assertContinuationAuthority, assertContinuationBoundary, assertContinuationParent, continuationHistory,
  readContinuationSnapshot } from "./provider-operator-continuation-state.mts";

export function createOperatorContinuation(review: ContinuationReview) {
  const pins = review.pins, ids = continuationIds(review);
  const txOptions = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 25_000 };
  async function readReceipt(db: ProviderQueryClient): Promise<ContinuationReceipt | null> {
    const rows = await db.local_audit_events.findMany({ where: { correlation_id: pins.operationId, action }, take: 2 });
    if (!rows.length) return null;
    const row = rows[0]!, parsed = continuationReceiptSchema.safeParse(row.details);
    if (rows.length !== 1 || !parsed.success || row.actor_operator_id !== pins.operatorId || row.target_id !== pins.initialRunId ||
      row.target_type !== "provider_run" || row.outcome !== "success" || digest(parsed.data.review) !== digest(review)) refuse("CONTINUATION_RECEIPT_DRIFT");
    return parsed.data;
  }
  async function resumeRecorded(db: ProviderQueryClient) {
    const row = await db.control_commands.findUnique({ where: { id: ids.resume } });
    if (row && (row.command_type !== "resume" || row.state !== "completed" || row.expected_generation !== BigInt(review.expectedGeneration) ||
      row.requested_by_operator_id !== pins.operatorId || row.correlation_id !== pins.operationId || row.reason !== null ||
      row.idempotency_key !== ids.resumeKey || row.target_run_id !== null || row.target_quarantine_id !== null)) refuse("CONTINUATION_RESUME_DRIFT");
    return row !== null;
  }
  async function findQueued(db: ProviderQueryClient, receipt: ContinuationReceipt) {
    const [command, run, parent] = await Promise.all([
      db.control_commands.findUnique({ where: { id: ids.command } }), db.provider_runs.findUnique({ where: { id: ids.run } }),
      db.provider_runs.findUniqueOrThrow({ where: { id: pins.initialRunId } }),
    ]);
    if (!command && !run) return null;
    if (!command || !run || !await resumeRecorded(db) || run.control_command_id !== command.id ||
      run.config_version_id !== pins.configId || run.config_version_number !== parent.config_version_number ||
      run.requested_cursor_hash !== review.expectedCheckpointHash || !isDeepStrictEqual(run.requested_cursor, parent.final_cursor) ||
      digest(run.requested_cursor) !== review.expectedCheckpointHash || run.trigger !== "manual" || run.recovery_of_run_id !== null ||
      run.requested_by_operator_id !== pins.operatorId || run.idempotency_key !== `command/${ids.command}` ||
      command.command_type !== "run" || command.resulting_run_id !== run.id || command.expected_generation !== BigInt(review.expectedGeneration) + 1n ||
      command.requested_by_operator_id !== pins.operatorId || command.correlation_id !== pins.operationId || command.idempotency_key !== ids.runKey ||
      command.target_run_id !== null || command.target_quarantine_id !== null || !["accepted", "completed", "failed"].includes(command.state) ||
      digest(receipt.review) !== digest(review)) refuse("CONTINUATION_QUEUED_RUN_DRIFT");
    return run;
  }
  async function releasedFence(db: ProviderQueryClient, receipt: ContinuationReceipt | null) {
    let maximum = BigInt(review.expectedImportFence);
    if (!receipt) return maximum;
    const rows = await db.local_audit_events.findMany({ where: { correlation_id: pins.operationId, action: `${action}.lease_claimed` }, take: 33 });
    if (rows.length > 32) refuse("CONTINUATION_LEASE_ATTEMPT_BOUND");
    for (const row of rows) {
      const value = row.details as { owner?: string; fence?: string; receiptDigest?: string };
      if (row.actor_operator_id !== pins.operatorId || row.target_id !== pins.initialRunId || row.outcome !== "success" ||
        value.owner !== ids.owner || !/^[1-9][0-9]*$/u.test(value.fence ?? "") || value.receiptDigest !== digest(receipt) ||
        Object.keys(value).length !== 3) refuse("CONTINUATION_LEASE_RECEIPT_DRIFT");
      const fence = BigInt(value.fence!);
      if (fence <= BigInt(review.expectedImportFence) || fence > BigInt(review.expectedImportFence) + 64n) refuse("CONTINUATION_LEASE_RECEIPT_DRIFT");
      if (fence > maximum) maximum = fence;
    }
    return maximum;
  }
  async function inspect(db: ProviderQueryClient, authority: BackfillAuthority) {
    const receipt = await readReceipt(db);
    assertContinuationAuthority(review, authority, receipt?.authorityDigest);
    const snapshot = await readContinuationSnapshot(db, review, authority);
    assertContinuationParent(snapshot, review, authority);
    if (receipt && continuationHistory(snapshot) !== receipt.historyDigest) refuse("CONTINUATION_HISTORY_DRIFT");
    if (receipt && await findQueued(db, receipt)) return { receipt, queued: true, snapshot };
    const resumed = receipt ? await resumeRecorded(db) : false;
    assertContinuationBoundary(snapshot, review, authority, { receipt: receipt ?? undefined, resumed,
      releasedFence: await releasedFence(db, receipt) });
    return { queued: false, snapshot, receipt: receipt ?? continuationReceiptSchema.parse({ version: 1, review,
      authorityDigest: authority.digest, historyDigest: continuationHistory(snapshot), entryRowVersion: snapshot.runtime.row_version.toString(),
      ledgerSequence: snapshot.ledger.last_sequence.toString(), automaticFailureClassification: "unchanged",
      originalFailureCauseKnown: false, sourceRequestPerformed: false }) };
  }
  async function lockCheckpoint(tx: ProviderTransactionClient) {
    const lease = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${pins.initialRunId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    return lease;
  }
  async function apply(db: ProviderPrismaClient, receipt: ContinuationReceipt, readAuthority: () => Promise<BackfillAuthority>,
    assertProcess: () => Promise<void>, assertActive: () => void = () => {}) {
    await assertProcess(); const authority = await readAuthority();
    assertContinuationAuthority(review, authority, receipt.authorityDigest);
    assertActive();
    let entryFence: bigint | undefined;
    await db.$transaction(async tx => {
      await lockCheckpoint(tx); const current = await inspect(tx, authority);
      if (digest(current.receipt) !== digest(receipt)) refuse("CONTINUATION_REVIEW_STALE");
      if (current.queued) return;
      assertActive();
      if (!await readReceipt(tx)) await tx.local_audit_events.create({ data: { correlation_id: pins.operationId,
        actor_operator_id: pins.operatorId, action, target_type: "provider_run", target_id: pins.initialRunId,
        outcome: "success", details: receipt, occurred_at: current.snapshot.snapshot.now } });
      entryFence = current.snapshot.snapshot.lease.fence;
    }, txOptions);
    if (entryFence === undefined) return { phase: "already_queued", runId: ids.run, commandId: ids.command };
    assertActive();
    const leases = new PrismaProviderWorkerLeaseRepository(db);
    const acquired = await leases.acquire({ role: "import", owner: ids.owner, leaseMilliseconds: 120_000 });
    if (acquired.kind !== "acquired") refuse("CONTINUATION_LEASE_UNAVAILABLE");
    const held = { owner: ids.owner, fence: acquired.lease.fence };
    try {
      if (held.fence !== entryFence + 1n) refuse("CONTINUATION_LEASE_RACE");
      await db.$transaction(async tx => {
        const lease = await lockCheckpoint(tx);
        if (!providerWorkerLeaseIsLive(lease, held)) refuse("CONTINUATION_LEASE_UNAVAILABLE");
        assertActive(); await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: pins.operatorId,
          action: `${action}.lease_claimed`, target_type: "provider_run", target_id: pins.initialRunId, outcome: "success",
          details: { owner: ids.owner, fence: held.fence.toString(), receiptDigest: digest(receipt) }, occurred_at: lease.database_now } });
      }, txOptions);
      const commands = new PrismaAdminProviderRuntimeRepository(db);
      const guard = async (resumed: boolean) => {
        await assertProcess(); const fresh = await readAuthority();
        assertContinuationAuthority(review, fresh, receipt.authorityDigest);
        await db.$transaction(async tx => {
          const lease = await lockCheckpoint(tx);
          if (!providerWorkerLeaseIsLive(lease, held)) refuse("CONTINUATION_LEASE_UNAVAILABLE");
          assertContinuationBoundary(await readContinuationSnapshot(tx, review, fresh), review, fresh, { receipt, resumed, lease: held });
          if (digest(await readReceipt(tx)) !== digest(receipt) || await resumeRecorded(tx) !== resumed) refuse("CONTINUATION_RECEIPT_DRIFT");
        }, txOptions);
      };
      const resumed = await resumeRecorded(db); await guard(resumed); assertActive();
      if (!resumed) {
        const result = await commands.submitRuntimeCommand({ commandId: ids.resume, commandType: "resume",
          expectedGeneration: BigInt(review.expectedGeneration), idempotencyKey: ids.resumeKey,
          requestedByOperatorId: pins.operatorId, correlationId: pins.operationId, reason: null, requestedAt: new Date() });
        if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" ||
          result.generation !== BigInt(review.expectedGeneration) + 1n) refuse("CONTINUATION_RESUME_REFUSED");
      }
      await guard(true); assertActive();
      const result = await commands.requestRunNow({ providerId: pins.providerId, operatorId: pins.operatorId,
        expectedConfigVersionId: pins.configId, expectedConfigVersionNumber: authority.configNumber,
        expectedGeneration: BigInt(review.expectedGeneration) + 1n, expectedImportLease: held,
        expectedCursorFingerprint: review.expectedCheckpointHash, requireNoActiveRun: true,
        commandId: ids.command, runId: ids.run, correlationId: pins.operationId, idempotencyKey: ids.runKey });
      if ((result.kind !== "created" && result.kind !== "deduplicated") || result.run.id !== ids.run ||
        result.run.requestedCursorHash !== review.expectedCheckpointHash) refuse("CONTINUATION_QUEUE_REFUSED");
      if (!await findQueued(db, receipt)) refuse("CONTINUATION_POSTQUEUE_FAILED");
      const after = await readContinuationSnapshot(db, review, authority);
      if (continuationHistory(after) !== receipt.historyDigest || after.ledger.last_sequence.toString() !== receipt.ledgerSequence) refuse("CONTINUATION_HISTORY_DRIFT");
      return { phase: "queued", runId: ids.run, commandId: ids.command };
    } finally { if (!await leases.release({ role: "import", ...held })) refuse("CONTINUATION_OWN_LEASE_RELEASE_REFUSED"); }
  }
  return { inspect, apply, readReceipt, findQueued, resumeRecorded };
}
