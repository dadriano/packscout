import { PrismaAdminProviderRuntimeRepository, PrismaProviderWorkerLeaseRepository, lockProviderWorkerLease,
  providerWorkerLeaseIsLive, setProviderImportLeaseContext, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import type { CourtyardAuthority } from "./courtyard-checkpoint-handoff-central.mts";
import { courtyardParserRetry as pins, parserRetryId as id, parserRetryReceiptSchema, parserRetryReceipt, parserRetryRetained,
  readParserRetryCheckpoint, assertParserRetryCheckpoint, assertParserRetryAuthority, refuseParserRetry as refuse,
  type ParserRetryReceipt } from "./courtyard-parser-checkpoint-retry-plan.mts";

export async function readParserRetryReceipt(database: ProviderPrismaClient | ProviderTransactionClient) {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: pins.operationId, action: pins.action } });
  if (!rows.length) return null;
  const parsed = parserRetryReceiptSchema.safeParse(rows[0]?.details);
  if (rows.length !== 1 || !parsed.success || rows[0]?.target_id !== pins.runId || rows[0]?.outcome !== "success" ||
    parsed.data.runId !== id("run")) refuse("PARSER_RETRY_RECEIPT_CHANGED");
  return parsed.data;
}
export function assertParserRetryReceiptAuthority(receipt: ParserRetryReceipt, authority: CourtyardAuthority) {
  assertParserRetryAuthority(authority);
  if (receipt.providerId !== authority.provider.id || receipt.operatorId !== authority.operatorId ||
    receipt.authorityDigest !== authority.authorityDigest) refuse("PARSER_RETRY_AUTHORITY_CHANGED");
}
export async function findParserRetryQueuedRun(database: ProviderPrismaClient, receipt: ParserRetryReceipt) {
  const command = await database.control_commands.findUnique({ where: { id: id("command") } });
  if (!command) return null;
  const run = await database.provider_runs.findUnique({ where: { id: id("run") } });
  if (!run || run.id !== receipt.runId || run.control_command_id !== command.id || run.config_version_id !== pins.configId ||
    run.config_version_number !== 2n || run.requested_cursor_hash !== pins.cursorHash || command.command_type !== "run" ||
    command.resulting_run_id !== run.id || command.expected_generation !== 7n || command.requested_by_operator_id !== receipt.operatorId ||
    command.correlation_id !== pins.operationId || command.idempotency_key !== `courtyard-parser-repair/${pins.operationId}/run` ||
    !["accepted", "completed", "failed"].includes(command.state)) refuse("PARSER_RETRY_QUEUED_RUN_CHANGED");
  return run.id;
}
async function resumeRecorded(database: ProviderPrismaClient, receipt: ParserRetryReceipt) {
  const command = await database.control_commands.findUnique({ where: { id: id("resume") } });
  if (command && (command.command_type !== "resume" || command.state !== "completed" || command.expected_generation !== 6n ||
    command.requested_by_operator_id !== receipt.operatorId || command.correlation_id !== pins.operationId || command.reason !== null ||
    command.idempotency_key !== `courtyard-parser-repair/${pins.operationId}/resume`)) refuse("PARSER_RETRY_RECEIPT_CHANGED");
  return command !== null;
}
export async function queueParserRetry(input: Readonly<{ database: ProviderPrismaClient; receipt: ParserRetryReceipt;
  assertPinned: (resumed: boolean) => Promise<void>;
  commands?: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand" | "requestRunNow"> }>) {
  const { database, receipt } = input;
  const existing = await findParserRetryQueuedRun(database, receipt);
  if (existing) return { phase: "already_queued", runId: existing, commandId: id("command") };
  const commands = input.commands ?? new PrismaAdminProviderRuntimeRepository(database);
  const resumed = await resumeRecorded(database, receipt);
  await input.assertPinned(resumed);
  if (!resumed) {
    const result = await commands.submitRuntimeCommand({ commandId: id("resume"), commandType: "resume", expectedGeneration: 6n,
      idempotencyKey: `courtyard-parser-repair/${pins.operationId}/resume`, requestedByOperatorId: receipt.operatorId,
      correlationId: pins.operationId, reason: null, requestedAt: new Date() });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" || result.generation !== 7n) refuse("PARSER_RETRY_RESUME_REFUSED");
  }
  await input.assertPinned(true);
  const result = await commands.requestRunNow({ providerId: receipt.providerId, operatorId: receipt.operatorId,
    expectedConfigVersionId: pins.configId, expectedConfigVersionNumber: 2n, expectedGeneration: 7n,
    expectedCursorFingerprint: pins.cursorHash, requireNoActiveRun: true, commandId: id("command"), runId: id("run"),
    correlationId: pins.operationId, idempotencyKey: `courtyard-parser-repair/${pins.operationId}/run` });
  if (!["created", "deduplicated"].includes(result.kind) || !("run" in result) || result.run.id !== receipt.runId ||
    result.run.requestedCursorHash !== pins.cursorHash) refuse("PARSER_RETRY_QUEUE_REFUSED");
  return { phase: "queued", runId: result.run.id, commandId: id("command") };
}
const transactionOptions = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 15000 };
async function lockCheckpoint(tx: ProviderTransactionClient) {
  const lease = await lockProviderWorkerLease(tx, "import");
  await tx.$queryRaw`select id from provider_runs where id=${pins.runId}::uuid for update`;
  await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
  return lease;
}
async function assertCachedConfiguration(database: ProviderPrismaClient | ProviderTransactionClient, authority: CourtyardAuthority) {
  const runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  if (handoffDigest(runtime.cached_configuration) !== handoffDigest({ adapterKey: authority.next!.adapter_key, settings: { platform: "courtyard" } }) ||
    runtime.config_expires_at !== null || runtime.schedule_seconds !== authority.next!.schedule_seconds) refuse("PARSER_RETRY_AUTHORITY_CHANGED");
}
export async function inspectParserRetry(database: ProviderPrismaClient, authority: CourtyardAuthority) {
  assertParserRetryAuthority(authority);
  await assertCachedConfiguration(database, authority);
  const existing = await readParserRetryReceipt(database);
  if (existing) assertParserRetryReceiptAuthority(existing, authority);
  if (existing && await findParserRetryQueuedRun(database, existing)) return { receipt: existing, queued: true };
  const snapshot = await readParserRetryCheckpoint(database);
  const resumed = existing ? await resumeRecorded(database, existing) : false;
  assertParserRetryCheckpoint({ snapshot, providerId: authority.provider.id, resumed, receiptExists: Boolean(existing) });
  if (existing && handoffDigest(parserRetryRetained(snapshot)) !== existing.checkpointDigest) refuse("PARSER_RETRY_CHECKPOINT_CHANGED");
  return { receipt: existing ?? parserRetryReceipt(authority, snapshot), queued: false };
}
export async function executeParserRetry(input: Readonly<{ database: ProviderPrismaClient; authority: CourtyardAuthority;
  receipt: ParserRetryReceipt; readAuthority: () => Promise<CourtyardAuthority> }>) {
  const { database, receipt } = input;
  assertParserRetryReceiptAuthority(receipt, await input.readAuthority());
  const oldReceipt = await readParserRetryReceipt(database);
  if (oldReceipt && handoffDigest(oldReceipt) !== handoffDigest(receipt)) refuse("PARSER_RETRY_RECEIPT_CHANGED");
  if (oldReceipt && await findParserRetryQueuedRun(database, receipt)) return { phase: "already_queued", runId: receipt.runId, commandId: id("command") };
  if (!oldReceipt) await database.$transaction(async (tx) => {
    await lockCheckpoint(tx);
    if (await readParserRetryReceipt(tx)) refuse("PARSER_RETRY_RECEIPT_CHANGED");
    const current = await readParserRetryCheckpoint(tx);
    await assertCachedConfiguration(tx, input.authority);
    if (handoffDigest(parserRetryReceipt(input.authority, current)) !== handoffDigest(receipt)) refuse("PARSER_RETRY_CHECKPOINT_CHANGED");
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: receipt.operatorId,
      action: pins.action, target_type: "provider_run", target_id: pins.runId, outcome: "success", details: receipt, occurred_at: new Date(current.databaseNow) } });
  }, transactionOptions);
  const before = await readParserRetryCheckpoint(database);
  assertParserRetryCheckpoint({ snapshot: before, providerId: receipt.providerId, resumed: await resumeRecorded(database, receipt), receiptExists: true });
  if (handoffDigest(parserRetryRetained(before)) !== receipt.checkpointDigest) refuse("PARSER_RETRY_CHECKPOINT_CHANGED");
  const leases = new PrismaProviderWorkerLeaseRepository(database);
  const acquired = await leases.acquire({ role: "import", owner: pins.owner, leaseMilliseconds: 120000 });
  if (acquired.kind === "held") refuse("PARSER_RETRY_LEASE_UNAVAILABLE");
  try {
    if (acquired.lease.fence !== BigInt(before.lease.fence) + 1n) refuse("PARSER_RETRY_LEASE_UNAVAILABLE");
    return await queueParserRetry({ database, receipt, assertPinned: async (resumed) => {
      const freshAuthority = await input.readAuthority(); assertParserRetryReceiptAuthority(receipt, freshAuthority);
      await database.$transaction(async (tx) => {
        const lease = await lockCheckpoint(tx);
        if (!providerWorkerLeaseIsLive(lease, { owner: pins.owner, fence: acquired.lease.fence })) refuse("PARSER_RETRY_LEASE_UNAVAILABLE");
        await setProviderImportLeaseContext(tx, { owner: pins.owner, fence: acquired.lease.fence });
        const snapshot = await readParserRetryCheckpoint(tx);
        assertParserRetryCheckpoint({ snapshot, providerId: receipt.providerId, resumed, receiptExists: true,
          utilityLease: { owner: pins.owner, fence: acquired.lease.fence.toString() } });
        if (handoffDigest(parserRetryRetained(snapshot)) !== receipt.checkpointDigest ||
          handoffDigest(await readParserRetryReceipt(tx)) !== handoffDigest(receipt)) refuse("PARSER_RETRY_RECEIPT_CHANGED");
        await assertCachedConfiguration(tx, freshAuthority);
      }, transactionOptions);
    } });
  } finally { await leases.release({ role: "import", owner: pins.owner, fence: acquired.lease.fence }); }
}
