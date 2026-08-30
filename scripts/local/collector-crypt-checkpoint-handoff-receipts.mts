import { z } from "zod";
import { PrismaAdminProviderRuntimeRepository, lockProviderWorkerLease,
  providerWorkerLeaseIsLive, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { collectorHandoff as pins, handoffDigest, handoffId, refuseHandoff,
  type CollectorHandoffCheckpoint } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { readCollectorHandoffCheckpoint, type CollectorHandoffAuthority } from "./collector-crypt-checkpoint-handoff-state.mts";

const receiptSchema = z.object({ operationId: z.string().uuid(), authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  runId: z.string().uuid(), runFence: z.string().regex(/^[1-9][0-9]*$/u),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/u), owner: z.string().min(1).max(256),
  oldWorkerPid: z.number().int().positive(), processIdentityAttestedByOperator: z.literal(true),
  operatorId: z.string().uuid(), previousConfigId: z.string().uuid(), nextConfigId: z.string().uuid(),
}).strict();
export type CollectorPauseReceipt = z.infer<typeof receiptSchema>;
export type CollectorResumeReceipt = Pick<CollectorPauseReceipt,
  "operationId" | "generation" | "operatorId" | "nextConfigId">;

export function pauseReceipt(input: Readonly<{ authority: CollectorHandoffAuthority;
  snapshot: CollectorHandoffCheckpoint; operationId: string; oldWorkerPid: number; expectedOwner: string }>): CollectorPauseReceipt {
  const s = input.snapshot;
  if (s.providerId !== pins.providerId || s.providerKey !== pins.providerKey ||
    s.runtimeState !== "running" || s.run.state !== "running" || s.run.reachedHead ||
    s.cachedConfigId !== input.authority.previous.id || s.cachedConfigNumber !== "2" ||
    s.run.configId !== input.authority.previous.id || s.run.configNumber !== "2" ||
    s.activeRunCount !== 1 || s.lease.owner !== input.expectedOwner || s.run.fence !== s.lease.fence ||
    !s.oldProcessAlive || s.lease.expiresAt === null || Date.parse(s.lease.expiresAt) <= Date.parse(s.databaseNow)) {
    refuseHandoff("HANDOFF_PAUSE_TARGET_CHANGED");
  }
  return receiptSchema.parse({ operationId: input.operationId, authorityDigest: input.authority.authorityDigest,
    runId: s.run.id, runFence: s.run.fence, generation: s.generation, owner: input.expectedOwner,
    oldWorkerPid: input.oldWorkerPid, processIdentityAttestedByOperator: true,
    operatorId: input.authority.operatorId, previousConfigId: input.authority.previous.id, nextConfigId: input.authority.nextConfigId });
}

export async function readPauseReceipt(database: ProviderPrismaClient | ProviderTransactionClient, operationId: string) {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: operationId,
    action: `${pins.action}.pause_intent` } });
  if (!rows.length) return null;
  const parsed = receiptSchema.safeParse(rows[0]?.details);
  if (rows.length !== 1 || !parsed.success || rows[0]?.target_id !== parsed.data.runId ||
    rows[0]?.outcome !== "success" || parsed.data.operationId !== operationId) refuseHandoff("HANDOFF_PAUSE_RECEIPT_INVALID");
  return parsed.data;
}

export async function submitCollectorPause(database: ProviderPrismaClient, receipt: CollectorPauseReceipt) {
  await database.$transaction(async (tx) => {
    const lease = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${receipt.runId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const existing = await readPauseReceipt(tx, receipt.operationId);
    if (existing) {
      if (handoffDigest(existing) !== handoffDigest(receipt)) refuseHandoff("HANDOFF_PAUSE_RECEIPT_CHANGED");
      const command = await tx.control_commands.findUnique({ where: { id: handoffId(receipt.operationId, "pause-command") } });
      if (command?.state === "completed") return;
    }
    const current = await readCollectorHandoffCheckpoint(tx, { oldProcessAlive: true, runId: receipt.runId });
    if (!providerWorkerLeaseIsLive(lease, { owner: receipt.owner, fence: BigInt(receipt.runFence) }) ||
      current.generation !== receipt.generation || current.runtimeState !== "running" ||
      current.run.state !== "running" || current.run.fence !== receipt.runFence ||
      current.run.configId !== receipt.previousConfigId || current.cachedConfigId !== receipt.previousConfigId ||
      current.activeRunCount !== 1) refuseHandoff("HANDOFF_PAUSE_TARGET_CHANGED");
    if (!existing) await tx.local_audit_events.create({ data: { correlation_id: receipt.operationId,
      actor_operator_id: receipt.operatorId, action: `${pins.action}.pause_intent`, target_type: "provider_run",
      target_id: receipt.runId, outcome: "success", details: receipt, occurred_at: lease.database_now } });
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15_000 });
  const result = await new PrismaAdminProviderRuntimeRepository(database).submitRuntimeCommand({
    commandId: handoffId(receipt.operationId, "pause-command"), idempotencyKey: `collector-handoff/${receipt.operationId}/pause`,
    commandType: "pause", expectedGeneration: BigInt(receipt.generation), requestedByOperatorId: receipt.operatorId,
    correlationId: receipt.operationId, reason: pins.reason, requestedAt: new Date(),
  });
  if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "paused" ||
    result.generation !== BigInt(receipt.generation) + 1n) refuseHandoff("HANDOFF_PAUSE_REFUSED");
  return { outcome: "paused", generation: result.generation.toString(), commandId: result.commandId, runId: receipt.runId };
}

export async function assertCollectorPauseProvenance(database: ProviderPrismaClient | ProviderTransactionClient,
  receipt: CollectorPauseReceipt, snapshot: CollectorHandoffCheckpoint) {
  const command = await database.control_commands.findUnique({ where: { id: handoffId(receipt.operationId, "pause-command") } });
  if (!command || command.command_type !== "pause" || command.state !== "completed" ||
    command.expected_generation.toString() !== receipt.generation || command.reason !== pins.reason ||
    command.requested_by_operator_id !== receipt.operatorId || command.correlation_id !== receipt.operationId ||
    command.idempotency_key !== `collector-handoff/${receipt.operationId}/pause` || !command.completed_at ||
    snapshot.run.id !== receipt.runId || snapshot.run.fence !== receipt.runFence ||
    snapshot.run.finishedAt === null || command.completed_at > new Date(snapshot.run.finishedAt) ||
    snapshot.generation !== (BigInt(receipt.generation) + 1n).toString()) refuseHandoff("HANDOFF_PAUSE_PROVENANCE_INVALID");
}

/** Durable resume/queue recognition precedes paused guards, including after the new worker starts. */
export async function resumeCollectorHandoff(input: Readonly<{ database: ProviderPrismaClient;
  receipt: CollectorResumeReceipt; cursorHash: string; assertPrepared: (resumed: boolean) => Promise<void>;
  commands?: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand" | "requestRunNow"> }>) {
  const { database, receipt } = input;
  const commands = input.commands ?? new PrismaAdminProviderRuntimeRepository(database);
  const commandId = handoffId(receipt.operationId, "run-command");
  const runId = handoffId(receipt.operationId, "run");
  const generation = BigInt(receipt.generation) + 2n;
  const command = await database.control_commands.findUnique({ where: { id: commandId } });
  if (command) {
    const run = await database.provider_runs.findUnique({ where: { id: runId } });
    if (command.command_type !== "run" || command.resulting_run_id !== runId ||
      command.expected_generation !== generation || command.requested_by_operator_id !== receipt.operatorId ||
      command.idempotency_key !== `collector-handoff/${receipt.operationId}/run` || command.correlation_id !== receipt.operationId ||
      !run || run.control_command_id !== commandId || run.config_version_id !== receipt.nextConfigId ||
      run.config_version_number !== 3n || run.requested_cursor_hash !== input.cursorHash) refuseHandoff("HANDOFF_QUEUED_RUN_CHANGED");
    return { outcome: "already_queued", commandId, runId };
  }
  const resumeId = handoffId(receipt.operationId, "resume-command");
  const resumed = await database.control_commands.findUnique({ where: { id: resumeId } });
  if (resumed && (resumed.command_type !== "resume" || resumed.state !== "completed" ||
    resumed.expected_generation !== generation - 1n || resumed.requested_by_operator_id !== receipt.operatorId ||
    resumed.idempotency_key !== `collector-handoff/${receipt.operationId}/resume` || resumed.correlation_id !== receipt.operationId)) {
    refuseHandoff("HANDOFF_RESUME_RECEIPT_CHANGED");
  }
  await input.assertPrepared(resumed !== null);
  if (!resumed) {
    const result = await commands.submitRuntimeCommand({ commandId: resumeId,
      idempotencyKey: `collector-handoff/${receipt.operationId}/resume`, commandType: "resume",
      expectedGeneration: generation - 1n, requestedByOperatorId: receipt.operatorId,
      correlationId: receipt.operationId, reason: null, requestedAt: new Date() });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" || result.generation !== generation) {
      refuseHandoff("HANDOFF_RESUME_REFUSED");
    }
  }
  // No new worker is started by this utility. A queue failure leaves idle, with the durable
  // resume receipt; repeat this exact operation to queue once, never issue another resume.
  const queued = await commands.requestRunNow({ providerId: pins.providerId,
    operatorId: receipt.operatorId, expectedConfigVersionId: receipt.nextConfigId, expectedConfigVersionNumber: 3n,
    expectedCursorFingerprint: input.cursorHash, requireNoActiveRun: true,
    expectedGeneration: generation, commandId, runId, correlationId: receipt.operationId,
    idempotencyKey: `collector-handoff/${receipt.operationId}/run` });
  if (!["created", "deduplicated"].includes(queued.kind) || !("run" in queued) || queued.run.id !== runId) {
    refuseHandoff("HANDOFF_QUEUE_REFUSED_RESUME_RECEIPT_RETAINED");
  }
  return { outcome: "queued", commandId, runId };
}
