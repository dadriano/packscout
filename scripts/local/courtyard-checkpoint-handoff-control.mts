import { PrismaAdminProviderRuntimeRepository, lockProviderWorkerLease,
  type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { courtyardHandoff as pins, courtyardHandoffId as id, refuseCourtyardHandoff as refuse,
  courtyardReceiptSchema, assertCourtyardCheckpoint, readCourtyardHandoffCheckpoint, retainedCourtyardCheckpoint,
  type CourtyardCheckpoint, type CourtyardReceipt } from "./courtyard-checkpoint-handoff-plan.mts";
import type { CourtyardAuthority } from "./courtyard-checkpoint-handoff-central.mts";

export function courtyardTerminalReceipt(authority: CourtyardAuthority, snapshot: CourtyardCheckpoint, operationId: string) {
  assertCourtyardCheckpoint({ snapshot, providerId: authority.provider.id, nextConfigId: authority.nextConfigId, phase: "terminal" });
  return courtyardReceiptSchema.parse({ kind: "courtyard_terminal_native_profile", operationId, providerId: authority.provider.id,
    operatorId: authority.operatorId, nextConfigId: authority.nextConfigId, authorityDigest: authority.authorityDigest,
    checkpointDigest: handoffDigest(retainedCourtyardCheckpoint(snapshot)), entryRowVersion: snapshot.runtimeRowVersion,
    failureCode: pins.failureCode, finishedAt: pins.finishedAt, previousCursorHash: pins.cursorHash });
}
export async function readCourtyardReceipt(database: ProviderPrismaClient | ProviderTransactionClient, operationId: string) {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: operationId, action: `${pins.action}.terminal_intent` } });
  if (!rows.length) return null;
  const receipt = courtyardReceiptSchema.safeParse(rows[0]?.details);
  if (rows.length !== 1 || !receipt.success || rows[0]?.target_id !== pins.runId || rows[0]?.outcome !== "success" ||
    receipt.data.operationId !== operationId) refuse("COURTYARD_RECEIPT_INVALID");
  return receipt.data;
}
export async function pauseCourtyardTerminal(database: ProviderPrismaClient, authority: CourtyardAuthority, receipt: CourtyardReceipt,
  commands: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand"> = new PrismaAdminProviderRuntimeRepository(database)) {
  await database.$transaction(async (tx) => {
    const lease = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${pins.runId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const existing = await readCourtyardReceipt(tx, receipt.operationId);
    if (existing && handoffDigest(existing) !== handoffDigest(receipt)) refuse("COURTYARD_RECEIPT_CHANGED");
    const command = await tx.control_commands.findUnique({ where: { id: id(receipt.operationId, "pause-command") } });
    if (existing && command?.state === "completed") return;
    if (lease.lease_owner !== null || lease.lease_expires_at !== null || lease.lease_fence !== 74n) refuse("COURTYARD_TERMINAL_LEASE_CHANGED");
    const expected = courtyardTerminalReceipt(authority, await readCourtyardHandoffCheckpoint(tx), receipt.operationId);
    if (handoffDigest(expected) !== handoffDigest(receipt)) refuse("COURTYARD_TERMINAL_CAS_FAILED");
    if (!existing) await tx.local_audit_events.create({ data: { correlation_id: receipt.operationId, actor_operator_id: receipt.operatorId,
      action: `${pins.action}.terminal_intent`, target_type: "provider_run", target_id: pins.runId,
      outcome: "success", details: receipt, occurred_at: lease.database_now } });
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
  const result = await commands.submitRuntimeCommand({ commandId: id(receipt.operationId, "pause-command"),
    idempotencyKey: `courtyard-handoff/${receipt.operationId}/pause`, commandType: "pause", expectedGeneration: 2n,
    requestedByOperatorId: receipt.operatorId, correlationId: receipt.operationId, reason: pins.reason, requestedAt: new Date() });
  if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "paused" || result.generation !== 3n) refuse("COURTYARD_PAUSE_REFUSED");
  return { phase: "terminal_failure_paused", operationId: receipt.operationId, commandId: result.commandId, generation: "3", runId: pins.runId };
}
export async function assertCourtyardPauseProvenance(database: ProviderPrismaClient | ProviderTransactionClient,
  receipt: CourtyardReceipt, snapshot: CourtyardCheckpoint) {
  const command = await database.control_commands.findUnique({ where: { id: id(receipt.operationId, "pause-command") } });
  if (!command || command.command_type !== "pause" || command.state !== "completed" || command.expected_generation !== 2n ||
    command.reason !== pins.reason || command.requested_by_operator_id !== receipt.operatorId || command.correlation_id !== receipt.operationId ||
    command.idempotency_key !== `courtyard-handoff/${receipt.operationId}/pause` || !command.completed_at ||
    command.completed_at <= new Date(pins.finishedAt) || snapshot.generation !== "3" ||
    handoffDigest(retainedCourtyardCheckpoint(snapshot)) !== receipt.checkpointDigest) refuse("COURTYARD_PAUSE_PROVENANCE_INVALID");
}

/** Recognize operation-owned queued/running/terminal lineage before paused-state guards. */
export async function resumeCourtyardHandoff(input: Readonly<{ database: ProviderPrismaClient; receipt: CourtyardReceipt;
  cursorHash: string; assertPrepared: (resumed: boolean) => Promise<void>;
  commands?: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand" | "requestRunNow"> }>) {
  const { database, receipt } = input; const commands = input.commands ?? new PrismaAdminProviderRuntimeRepository(database);
  const commandId = id(receipt.operationId, "run-command"); const runId = id(receipt.operationId, "run");
  const command = await database.control_commands.findUnique({ where: { id: commandId } });
  if (command) {
    const run = await database.provider_runs.findUnique({ where: { id: runId } });
    if (command.command_type !== "run" || command.resulting_run_id !== runId || command.expected_generation !== 4n ||
      command.requested_by_operator_id !== receipt.operatorId || command.correlation_id !== receipt.operationId ||
      command.idempotency_key !== `courtyard-handoff/${receipt.operationId}/run` || !run || run.control_command_id !== commandId ||
      run.config_version_id !== receipt.nextConfigId || run.config_version_number !== 2n || run.requested_cursor_hash !== input.cursorHash) refuse("COURTYARD_QUEUED_RUN_CHANGED");
    return { phase: "already_queued", commandId, runId };
  }
  const resumeId = id(receipt.operationId, "resume-command");
  const resumed = await database.control_commands.findUnique({ where: { id: resumeId } });
  if (resumed && (resumed.command_type !== "resume" || resumed.state !== "completed" || resumed.expected_generation !== 3n ||
    resumed.requested_by_operator_id !== receipt.operatorId || resumed.correlation_id !== receipt.operationId ||
    resumed.idempotency_key !== `courtyard-handoff/${receipt.operationId}/resume`)) refuse("COURTYARD_RESUME_RECEIPT_CHANGED");
  await input.assertPrepared(resumed !== null);
  if (!resumed) {
    const result = await commands.submitRuntimeCommand({ commandId: resumeId, idempotencyKey: `courtyard-handoff/${receipt.operationId}/resume`,
      commandType: "resume", expectedGeneration: 3n, requestedByOperatorId: receipt.operatorId, correlationId: receipt.operationId,
      reason: null, requestedAt: new Date() });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" || result.generation !== 4n) refuse("COURTYARD_RESUME_REFUSED");
  }
  const queued = await commands.requestRunNow({ providerId: receipt.providerId, operatorId: receipt.operatorId,
    expectedConfigVersionId: receipt.nextConfigId, expectedConfigVersionNumber: 2n, expectedGeneration: 4n,
    expectedCursorFingerprint: input.cursorHash, requireNoActiveRun: true, commandId, runId,
    correlationId: receipt.operationId, idempotencyKey: `courtyard-handoff/${receipt.operationId}/run` });
  if (!["created", "deduplicated"].includes(queued.kind) || !("run" in queued) || queued.run.id !== runId) refuse("COURTYARD_QUEUE_REFUSED_RESUME_RETAINED");
  return { phase: "queued", commandId, runId };
}
