import { z } from "zod";
import { PrismaAdminProviderRuntimeRepository, lockProviderWorkerLease,
  type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { collectorHandoff as pins, assertCollectorHandoffCheckpoint, handoffDigest, handoffId, refuseHandoff,
  type CollectorHandoffCheckpoint, type CollectorHandoffDrainInput } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { readCollectorHandoffCheckpoint, retainedCollectorCheckpoint,
  type CollectorHandoffAuthority } from "./collector-crypt-checkpoint-handoff-state.mts";

/** One approved terminal checkpoint, not a general license to migrate arbitrary failures. */
export const collectorTimeoutFailurePins = Object.freeze({ runId: "fe6ea7ea-dce6-42ba-bba6-e493921f96b9",
  configId: "4abb1a00-570d-4c44-a75a-f3543fe5aa91", failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT",
  finishedAt: "2026-08-30T04:24:23.938Z", generation: "2", fence: "1", pageCount: 9273, accepted: 927300 });
export const collectorTimeoutPauseReason = "Collector Crypt terminal timeout checkpoint handoff; failure predates pause";
const timeoutReceiptSchema = z.object({ kind: z.literal("terminal_timeout"), operationId: z.string().uuid(),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), runId: z.literal(collectorTimeoutFailurePins.runId),
  runFence: z.literal("1"), generation: z.literal("2"), failureCode: z.literal(collectorTimeoutFailurePins.failureCode),
  finishedAt: z.literal(collectorTimeoutFailurePins.finishedAt), operatorId: z.string().uuid(),
  previousConfigId: z.literal(collectorTimeoutFailurePins.configId), nextConfigId: z.string().uuid(),
  entryRuntimeRowVersion: z.string().regex(/^[1-9][0-9]*$/u), checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  drainEvidence: z.literal("terminal_run_released_import_lease"),
}).strict();
export type CollectorTimeoutReceipt = z.infer<typeof timeoutReceiptSchema>;

function assertExactTimeoutRun(snapshot: CollectorHandoffCheckpoint) {
  const r = snapshot.run; const p = collectorTimeoutFailurePins;
  if (snapshot.runCount !== 1 || snapshot.otherOwnedWorkerLeaseCount !== 0 ||
    r.id !== p.runId || r.configId !== p.configId || r.configNumber !== "2" || r.state !== "failed" ||
    r.failureCode !== p.failureCode || r.finishedAt !== p.finishedAt || r.fence !== p.fence ||
    r.pageCount !== p.pageCount || r.accepted !== p.accepted || r.duplicates !== 0 || r.quarantines !== 0 || r.reachedHead) {
    refuseHandoff("HANDOFF_TIMEOUT_RUN_CHANGED");
  }
}
const retainedTimeoutDigest = (snapshot: CollectorHandoffCheckpoint) => handoffDigest(retainedCollectorCheckpoint({
  ...snapshot, generation: collectorTimeoutFailurePins.generation,
}));

export function assertCollectorTimeoutHandoffDrained(input: CollectorHandoffDrainInput) {
  assertExactTimeoutRun(input.snapshot);
  return assertCollectorHandoffCheckpoint({ ...input, expectedRuntimeState: "paused" });
}

export function collectorTimeoutReceipt(input: Readonly<{ authority: CollectorHandoffAuthority;
  snapshot: CollectorHandoffCheckpoint; operationId: string }>): CollectorTimeoutReceipt {
  const { snapshot, authority } = input;
  assertExactTimeoutRun(snapshot);
  if (snapshot.lease.fence !== collectorTimeoutFailurePins.fence) refuseHandoff("HANDOFF_TIMEOUT_LEASE_CHANGED");
  assertCollectorHandoffCheckpoint({ snapshot, previousConfigId: authority.previous.id, nextConfigId: authority.nextConfigId,
    expectedGeneration: collectorTimeoutFailurePins.generation, expectedRuntimeState: "error" });
  return timeoutReceiptSchema.parse({ kind: "terminal_timeout", operationId: input.operationId,
    authorityDigest: authority.authorityDigest, operatorId: authority.operatorId,
    runId: snapshot.run.id, runFence: snapshot.run.fence, generation: snapshot.generation,
    failureCode: snapshot.run.failureCode, finishedAt: snapshot.run.finishedAt,
    previousConfigId: authority.previous.id, nextConfigId: authority.nextConfigId,
    entryRuntimeRowVersion: snapshot.runtimeRowVersion, checkpointDigest: retainedTimeoutDigest(snapshot),
    drainEvidence: "terminal_run_released_import_lease" });
}

export async function readCollectorTimeoutReceipt(database: ProviderPrismaClient | ProviderTransactionClient, operationId: string) {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: operationId,
    action: `${pins.action}.terminal_timeout_intent` } });
  if (!rows.length) return null;
  const parsed = timeoutReceiptSchema.safeParse(rows[0]?.details);
  if (rows.length !== 1 || !parsed.success || rows[0]?.target_id !== parsed.data.runId ||
    rows[0]?.outcome !== "success" || parsed.data.operationId !== operationId) refuseHandoff("HANDOFF_TIMEOUT_RECEIPT_INVALID");
  return parsed.data;
}

export async function submitCollectorTimeoutPause(database: ProviderPrismaClient, receipt: CollectorTimeoutReceipt,
  authority: CollectorHandoffAuthority,
  commands: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand"> = new PrismaAdminProviderRuntimeRepository(database)) {
  await database.$transaction(async (tx) => {
    const lease = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${receipt.runId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const existing = await readCollectorTimeoutReceipt(tx, receipt.operationId);
    if (existing && handoffDigest(existing) !== handoffDigest(receipt)) refuseHandoff("HANDOFF_TIMEOUT_RECEIPT_CHANGED");
    const command = await tx.control_commands.findUnique({ where: { id: handoffId(receipt.operationId, "terminal-timeout-pause-command") } });
    if (existing && command?.state === "completed") return;
    if (lease.lease_owner !== null || lease.lease_expires_at !== null || lease.lease_fence.toString() !== receipt.runFence) {
      refuseHandoff("HANDOFF_TIMEOUT_LEASE_CHANGED");
    }
    const current = await readCollectorHandoffCheckpoint(tx, { oldProcessAlive: false, runId: receipt.runId });
    const expected = collectorTimeoutReceipt({ authority, snapshot: current, operationId: receipt.operationId });
    if (handoffDigest(expected) !== handoffDigest(receipt)) refuseHandoff("HANDOFF_TIMEOUT_CHECKPOINT_CHANGED");
    if (!existing) await tx.local_audit_events.create({ data: { correlation_id: receipt.operationId,
      actor_operator_id: receipt.operatorId, action: `${pins.action}.terminal_timeout_intent`, target_type: "provider_run",
      target_id: receipt.runId, outcome: "success", details: receipt, occurred_at: lease.database_now } });
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15_000 });
  const result = await commands.submitRuntimeCommand({ commandId: handoffId(receipt.operationId, "terminal-timeout-pause-command"),
    idempotencyKey: `collector-handoff/${receipt.operationId}/terminal-timeout-pause`, commandType: "pause",
    expectedGeneration: BigInt(receipt.generation), requestedByOperatorId: receipt.operatorId,
    correlationId: receipt.operationId, reason: collectorTimeoutPauseReason, requestedAt: new Date() });
  if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "paused" || result.generation !== 3n) {
    refuseHandoff("HANDOFF_TIMEOUT_PAUSE_REFUSED");
  }
  return { outcome: "terminal_timeout_paused", generation: "3", commandId: result.commandId, runId: receipt.runId };
}

export async function assertCollectorTimeoutProvenance(database: ProviderPrismaClient | ProviderTransactionClient,
  receipt: CollectorTimeoutReceipt, snapshot: CollectorHandoffCheckpoint) {
  assertExactTimeoutRun(snapshot);
  const command = await database.control_commands.findUnique({ where: { id: handoffId(receipt.operationId, "terminal-timeout-pause-command") } });
  if (!command || command.command_type !== "pause" || command.state !== "completed" ||
    command.expected_generation.toString() !== receipt.generation || command.reason !== collectorTimeoutPauseReason ||
    command.requested_by_operator_id !== receipt.operatorId || command.correlation_id !== receipt.operationId ||
    command.idempotency_key !== `collector-handoff/${receipt.operationId}/terminal-timeout-pause` || !command.completed_at ||
    command.completed_at <= new Date(receipt.finishedAt) || snapshot.generation !== "3" ||
    retainedTimeoutDigest(snapshot) !== receipt.checkpointDigest) refuseHandoff("HANDOFF_TIMEOUT_PROVENANCE_INVALID");
}
