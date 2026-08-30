import { PrismaAdminProviderRuntimeRepository, PrismaProviderWorkerLeaseRepository, lockProviderWorkerLease,
  providerWorkerLeaseIsLive, setProviderImportLeaseContext, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { backfillDigest } from "./provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { collectorRepair as pins, collectorRepairId as id, collectorRepairReceiptSchema,
  readCollectorRepairCheckpoint, assertCollectorRepairCheckpoint, retainedCollectorRepair, makeCollectorRepairReceipt,
  refuseCollectorRepair as refuse, type CollectorRepairReceipt } from "./collector-reconciliation-retry-plan.mts";

export type CollectorRepairAuthority = BackfillAuthority & { operatorId: string };
type Database = ProviderPrismaClient | ProviderTransactionClient;
export function assertCollectorRepairAuthority(receipt: CollectorRepairReceipt, authority: CollectorRepairAuthority) {
  if (authority.digest !== receipt.authorityDigest || authority.operatorId !== receipt.operatorId ||
    authority.configNumber !== 3n || authority.route.configVersionId !== pins.configId ||
    authority.route.target.providerId !== pins.providerId || authority.route.target.providerKey !== pins.providerKey) {
    refuse("COLLECTOR_REPAIR_AUTHORITY_CHANGED");
  }
}
export async function readCollectorRepairReceipt(database: Database) {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: pins.operationId, action: pins.action }, take: 2 });
  if (!rows.length) return null;
  const parsed = collectorRepairReceiptSchema.safeParse(rows[0]?.details);
  if (rows.length !== 1 || !parsed.success || rows[0]?.target_id !== pins.parentRunId || rows[0]?.outcome !== "success" ||
    parsed.data.runId !== id("run")) refuse("COLLECTOR_REPAIR_RECEIPT_CHANGED");
  return parsed.data;
}
export async function findCollectorRepairQueuedRun(database: Database, receipt: CollectorRepairReceipt) {
  const command = await database.control_commands.findUnique({ where: { id: id("command") } });
  if (!command) return null;
  const run = await database.provider_runs.findUnique({ where: { id: id("run") } });
  const parent = await database.provider_runs.findUnique({ where: { id: pins.parentRunId }, select: { final_cursor: true } });
  if (!run || !parent || run.id !== receipt.runId || run.control_command_id !== command.id ||
    run.config_version_id !== pins.configId || run.config_version_number !== 3n || run.requested_cursor_hash !== pins.cursorHash ||
    backfillDigest(run.requested_cursor) !== pins.cursorHash || backfillDigest(run.requested_cursor) !== backfillDigest(parent.final_cursor) ||
    run.trigger !== "manual" || run.requested_by_operator_id !== receipt.operatorId || run.recovery_of_run_id !== null ||
    run.idempotency_key !== `command/${id("command")}` || command.id !== id("command") || command.command_type !== "run" ||
    command.resulting_run_id !== run.id || command.expected_generation !== 25n || command.requested_by_operator_id !== receipt.operatorId ||
    command.correlation_id !== pins.operationId || command.idempotency_key !== `collector-reconciliation-repair/${pins.operationId}/run` ||
    !["accepted", "completed", "failed"].includes(command.state)) refuse("COLLECTOR_REPAIR_QUEUED_RUN_CHANGED");
  return run.id;
}
export async function collectorRepairResumeRecorded(database: Database, receipt: CollectorRepairReceipt) {
  const command = await database.control_commands.findUnique({ where: { id: id("resume") } });
  if (command && (command.command_type !== "resume" || command.state !== "completed" || command.expected_generation !== 24n ||
    command.requested_by_operator_id !== receipt.operatorId || command.correlation_id !== pins.operationId || command.reason !== null ||
    command.idempotency_key !== `collector-reconciliation-repair/${pins.operationId}/resume`)) refuse("COLLECTOR_REPAIR_RECEIPT_CHANGED");
  return command !== null;
}
async function assertCachedConfiguration(database: Database, authority: CollectorRepairAuthority) {
  const runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  if (backfillDigest(runtime.cached_configuration) !== backfillDigest(authority.cachedConfiguration) ||
    runtime.config_expires_at?.toISOString() !== authority.expiresAt?.toISOString() ||
    runtime.schedule_seconds !== authority.scheduleSeconds) refuse("COLLECTOR_REPAIR_AUTHORITY_CHANGED");
}
export async function inspectCollectorRepair(database: Database, authority: CollectorRepairAuthority) {
  await assertCachedConfiguration(database, authority);
  const existing = await readCollectorRepairReceipt(database);
  if (existing) assertCollectorRepairAuthority(existing, authority);
  if (existing && await findCollectorRepairQueuedRun(database, existing)) return { receipt: existing, queued: true };
  const snapshot = await readCollectorRepairCheckpoint(database);
  const resumed = existing ? await collectorRepairResumeRecorded(database, existing) : false;
  assertCollectorRepairCheckpoint({ snapshot, resumed, receiptExists: Boolean(existing) });
  if (existing && backfillDigest(retainedCollectorRepair(snapshot)) !== existing.checkpointDigest) refuse("COLLECTOR_REPAIR_CHECKPOINT_CHANGED");
  return { receipt: existing ?? makeCollectorRepairReceipt(authority, snapshot), queued: false };
}
export async function queueCollectorRepair(input: Readonly<{ database: ProviderPrismaClient; receipt: CollectorRepairReceipt;
  utilityLease: { owner: string; fence: bigint };
  assertPinned: (resumed: boolean) => Promise<void>;
  commands?: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand" | "requestRunNow"> }>) {
  const { database, receipt } = input;
  const existing = await findCollectorRepairQueuedRun(database, receipt);
  if (existing) return { phase: "already_queued", runId: existing, commandId: id("command") };
  const commands = input.commands ?? new PrismaAdminProviderRuntimeRepository(database);
  const resumed = await collectorRepairResumeRecorded(database, receipt);
  await input.assertPinned(resumed);
  if (!resumed) {
    const result = await commands.submitRuntimeCommand({ commandId: id("resume"), commandType: "resume", expectedGeneration: 24n,
      idempotencyKey: `collector-reconciliation-repair/${pins.operationId}/resume`, requestedByOperatorId: receipt.operatorId,
      correlationId: pins.operationId, reason: null, requestedAt: new Date() });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" || result.generation !== 25n) refuse("COLLECTOR_REPAIR_RESUME_REFUSED");
  }
  await input.assertPinned(true);
  const result = await commands.requestRunNow({ providerId: receipt.providerId, operatorId: receipt.operatorId,
    expectedConfigVersionId: pins.configId, expectedConfigVersionNumber: 3n, expectedGeneration: 25n,
    expectedImportLease: input.utilityLease,
    expectedCursorFingerprint: pins.cursorHash, requireNoActiveRun: true, commandId: id("command"), runId: id("run"),
    correlationId: pins.operationId, idempotencyKey: `collector-reconciliation-repair/${pins.operationId}/run` });
  if (!["created", "deduplicated"].includes(result.kind) || !("run" in result) || result.run.id !== receipt.runId ||
    result.run.requestedCursorHash !== pins.cursorHash) refuse("COLLECTOR_REPAIR_QUEUE_REFUSED");
  return { phase: "queued", runId: result.run.id, commandId: id("command") };
}
const transactionOptions = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 15000 };
async function lockCheckpoint(tx: ProviderTransactionClient) {
  const lease = await lockProviderWorkerLease(tx, "import");
  await tx.$queryRaw`select id from provider_runs where id=${pins.parentRunId}::uuid for update`;
  await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
  return lease;
}
export async function executeCollectorRepair(input: Readonly<{ database: ProviderPrismaClient; authority: CollectorRepairAuthority;
  receipt: CollectorRepairReceipt; readAuthority: () => Promise<CollectorRepairAuthority> }>) {
  const { database, receipt } = input;
  assertCollectorRepairAuthority(receipt, await input.readAuthority());
  const oldReceipt = await readCollectorRepairReceipt(database);
  if (oldReceipt && backfillDigest(oldReceipt) !== backfillDigest(receipt)) refuse("COLLECTOR_REPAIR_RECEIPT_CHANGED");
  if (oldReceipt && await findCollectorRepairQueuedRun(database, receipt)) return { phase: "already_queued", runId: receipt.runId, commandId: id("command") };
  if (!oldReceipt) await database.$transaction(async (tx) => {
    await lockCheckpoint(tx);
    if (await readCollectorRepairReceipt(tx)) refuse("COLLECTOR_REPAIR_RECEIPT_CHANGED");
    const current = await readCollectorRepairCheckpoint(tx);
    await assertCachedConfiguration(tx, input.authority);
    if (backfillDigest(makeCollectorRepairReceipt(input.authority, current)) !== backfillDigest(receipt)) refuse("COLLECTOR_REPAIR_CHECKPOINT_CHANGED");
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: receipt.operatorId,
      action: pins.action, target_type: "provider_run", target_id: pins.parentRunId, outcome: "success", details: receipt, occurred_at: new Date(current.databaseNow) } });
  }, transactionOptions);
  const before = await readCollectorRepairCheckpoint(database);
  assertCollectorRepairCheckpoint({ snapshot: before, resumed: await collectorRepairResumeRecorded(database, receipt), receiptExists: true });
  if (backfillDigest(retainedCollectorRepair(before)) !== receipt.checkpointDigest) refuse("COLLECTOR_REPAIR_CHECKPOINT_CHANGED");
  const leases = new PrismaProviderWorkerLeaseRepository(database);
  const acquired = await leases.acquire({ role: "import", owner: pins.owner, leaseMilliseconds: 120000 });
  if (acquired.kind === "held") refuse("COLLECTOR_REPAIR_LEASE_UNAVAILABLE");
  try {
    if (acquired.lease.fence !== BigInt(before.lease.fence) + 1n) refuse("COLLECTOR_REPAIR_LEASE_UNAVAILABLE");
    return await queueCollectorRepair({ database, receipt, utilityLease: acquired.lease, assertPinned: async (resumed) => {
      const authority = await input.readAuthority(); assertCollectorRepairAuthority(receipt, authority);
      await database.$transaction(async (tx) => {
        const lease = await lockCheckpoint(tx);
        if (!providerWorkerLeaseIsLive(lease, { owner: pins.owner, fence: acquired.lease.fence })) refuse("COLLECTOR_REPAIR_LEASE_UNAVAILABLE");
        await setProviderImportLeaseContext(tx, { owner: pins.owner, fence: acquired.lease.fence });
        const snapshot = await readCollectorRepairCheckpoint(tx);
        assertCollectorRepairCheckpoint({ snapshot, resumed, receiptExists: true, utilityLease: { owner: pins.owner, fence: acquired.lease.fence.toString() } });
        if (backfillDigest(retainedCollectorRepair(snapshot)) !== receipt.checkpointDigest ||
          backfillDigest(await readCollectorRepairReceipt(tx)) !== backfillDigest(receipt)) refuse("COLLECTOR_REPAIR_RECEIPT_CHANGED");
        await assertCachedConfiguration(tx, authority);
      }, transactionOptions);
    } });
  } finally { await leases.release({ role: "import", owner: pins.owner, fence: acquired.lease.fence }); }
}
