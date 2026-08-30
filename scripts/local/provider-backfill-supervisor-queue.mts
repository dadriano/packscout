import { PrismaAdminProviderRuntimeRepository, type ProviderPrismaClient } from "@packscout/database";
import { backfillId, refuseBackfill, type BackfillIntent } from "./provider-backfill-supervisor-policy.mts";

/** Resume and enqueue through authoritative repositories; receipts make both crash gaps replayable. */
export async function queueBackfillRetry(input: {
  database: ProviderPrismaClient; intent: BackfillIntent;
  assertPinned: (resumed: boolean) => Promise<void>;
  commands?: Pick<PrismaAdminProviderRuntimeRepository, "submitRuntimeCommand" | "requestRunNow">;
}): Promise<string> {
  const { database, intent } = input;
  const commands = input.commands ?? new PrismaAdminProviderRuntimeRepository(database);
  const generation = BigInt(intent.generation);
  const resumeId = backfillId(intent.pins.operationId, `resume/${intent.parentRunId}`);
  const commandId = backfillId(intent.pins.operationId, `command/${intent.parentRunId}`);
  const runKey = `backfill/${intent.pins.operationId}/${intent.parentRunId}/run`;
  const existing = await database.control_commands.findUnique({ where: { id: commandId } });
  if (existing) {
    const run = await database.provider_runs.findUnique({ where: { id: intent.runId } });
    if (!run || run.control_command_id !== commandId || run.requested_cursor_hash !== intent.checkpointHash ||
      run.config_version_id !== intent.pins.configId || run.config_version_number !== BigInt(intent.configNumber) ||
      existing.command_type !== "run" || existing.resulting_run_id !== run.id || existing.idempotency_key !== runKey ||
      existing.expected_generation !== generation + 1n || existing.requested_by_operator_id !== intent.pins.operatorId ||
      existing.correlation_id !== intent.pins.operationId || !["accepted", "completed", "failed"].includes(existing.state)) {
      refuseBackfill("BACKFILL_QUEUED_RUN_CONFLICT");
    }
    return run.id;
  }
  const resumed = await database.control_commands.findUnique({ where: { id: resumeId } });
  if (resumed && (resumed.command_type !== "resume" || resumed.state !== "completed" ||
    resumed.expected_generation !== generation || resumed.requested_by_operator_id !== intent.pins.operatorId ||
    resumed.correlation_id !== intent.pins.operationId || resumed.reason !== null ||
    resumed.idempotency_key !== `backfill/${intent.pins.operationId}/${intent.parentRunId}/resume`)) {
    refuseBackfill("BACKFILL_RESUME_RECEIPT_CONFLICT");
  }
  await input.assertPinned(resumed !== null);
  if (!resumed) {
    const result = await commands.submitRuntimeCommand({ commandId: resumeId,
      idempotencyKey: `backfill/${intent.pins.operationId}/${intent.parentRunId}/resume`,
      commandType: "resume", expectedGeneration: generation, requestedByOperatorId: intent.pins.operatorId,
      correlationId: intent.pins.operationId, reason: null, requestedAt: new Date(intent.createdAt) });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" || result.generation !== generation + 1n) {
      refuseBackfill("BACKFILL_RESUME_REFUSED");
    }
  }
  await input.assertPinned(true);
  const result = await commands.requestRunNow({ providerId: intent.pins.providerId, operatorId: intent.pins.operatorId,
    expectedConfigVersionId: intent.pins.configId, expectedConfigVersionNumber: BigInt(intent.configNumber),
    expectedGeneration: generation + 1n, expectedCursorFingerprint: intent.checkpointHash, requireNoActiveRun: true,
    idempotencyKey: runKey, commandId, runId: intent.runId, correlationId: intent.pins.operationId });
  if ((result.kind !== "created" && result.kind !== "deduplicated") || result.run.id !== intent.runId ||
    result.run.requestedCursorHash !== intent.checkpointHash) refuseBackfill("BACKFILL_QUEUE_REFUSED");
  return result.run.id;
}
