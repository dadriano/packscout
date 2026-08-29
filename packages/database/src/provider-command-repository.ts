import {
  providerRuntimeTransitionAllowed,
  type ProviderRuntimeState,
} from "@packscout/contracts";
import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  appendProviderActivityOutbox,
  appendProviderLocalAudit,
} from "./provider-local-evidence.ts";
import {
  lockProviderWorkerLease,
  providerWorkerLeaseDatabaseNow,
  providerWorkerLeaseIsLive,
  setProviderImportLeaseContext,
} from "./provider-worker-lease-repository.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const databaseBigintPattern = /^(?:0|[1-9][0-9]{0,18})$/;
const maximumDatabaseBigint = 9_223_372_036_854_775_807n;

export type ProviderControlCommandType =
  | "run"
  | "pause"
  | "resume"
  | "stop"
  | "retry_run"
  | "retry_quarantine";

export type ProviderCommandOutcome =
  | "accepted"
  | "deduplicated"
  | "conflict"
  | "forbidden"
  | "failed";

export interface ProviderControlCommandResult {
  readonly commandId: string;
  readonly outcome: ProviderCommandOutcome;
  readonly code: string;
  readonly generation: bigint;
}

interface RuntimeRow {
  readonly central_provider_id: string;
  readonly operating_state: ProviderRuntimeState;
  readonly state_reason: string | null;
  readonly state_generation: bigint;
  readonly row_version: bigint;
}

export interface ProviderAcceptedControlCommand {
  readonly id: string;
  readonly idempotency_key: string;
  readonly command_type: ProviderControlCommandType;
  readonly target_run_id: string | null;
  readonly target_quarantine_id: string | null;
  readonly expected_generation: bigint;
  readonly requested_by_operator_id: string;
  readonly correlation_id: string;
  readonly reason: string | null;
  readonly state: "accepted";
  readonly result: ProviderPrisma.JsonValue | null;
  readonly resulting_run_id: string | null;
  readonly requested_at: Date;
  readonly row_version: bigint;
}

type CommandRow = Omit<ProviderAcceptedControlCommand, "state"> & {
  readonly state: "pending" | "accepted" | "rejected" | "completed" | "failed";
};

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${field} must be a UUID.`);
  return value;
}

function requireInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} must be a valid instant.`);
  }
  return value;
}

function requireSafeKey(value: string, field: string): string {
  if (!safeKeyPattern.test(value)) throw new TypeError(`${field} is invalid.`);
  return value;
}

function commandResult(
  outcome: Exclude<ProviderCommandOutcome, "deduplicated">,
  code: string,
  generation: bigint,
): { outcome: Exclude<ProviderCommandOutcome, "deduplicated">; code: string; generation: string } {
  if (!safeCodePattern.test(code)) throw new TypeError("Provider command result code is invalid.");
  return { outcome, code, generation: generation.toString() };
}

function normalizedReason(commandType: ProviderControlCommandType, reason: string | null): string | null {
  if (commandType === "pause" || commandType === "stop") {
    const value = reason?.trim() ?? "";
    if (value.length < 1 || value.length > 512) {
      throw new TypeError("Pause and stop commands require a bounded reason.");
    }
    return value;
  }
  if (reason === null) return null;
  const value = reason.trim();
  if (value.length > 512) throw new TypeError("Provider command reason is too long.");
  return value.length === 0 ? null : value;
}

function desiredRuntimeState(type: ProviderControlCommandType): ProviderRuntimeState | null {
  if (type === "pause") return "paused";
  if (type === "stop") return "stopped";
  if (type === "resume") return "idle";
  return null;
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<RuntimeRow> {
  const [row] = await transaction.$queryRaw<RuntimeRow[]>(ProviderPrisma.sql`
    select central_provider_id, operating_state, state_reason,
           state_generation, row_version
    from provider_runtime where singleton_key = true for update
  `);
  if (!row) throw new Error("Provider runtime is not initialized.");
  return row;
}

function requestMatches(row: CommandRow, input: {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandType: ProviderControlCommandType;
  readonly targetRunId: string | null;
  readonly targetQuarantineId: string | null;
  readonly expectedGeneration: bigint;
  readonly requestedByOperatorId: string;
  readonly correlationId: string;
  readonly reason: string | null;
  readonly requestedAt: Date;
}): boolean {
  return row.idempotency_key === input.idempotencyKey
    && row.command_type === input.commandType
    && row.target_run_id === input.targetRunId
    && row.target_quarantine_id === input.targetQuarantineId
    && row.expected_generation === input.expectedGeneration
    && row.requested_by_operator_id === input.requestedByOperatorId
    && row.reason === input.reason;
}

function outcomeFromStored(row: CommandRow, generation: bigint): ProviderControlCommandResult {
  const result = typeof row.result === "object" && row.result !== null && !Array.isArray(row.result)
    ? row.result as Record<string, unknown>
    : {};
  const code = typeof result.code === "string" && safeCodePattern.test(result.code)
    ? result.code
    : "COMMAND_OUTCOME_UNAVAILABLE";
  const storedGeneration = typeof result.generation === "string"
    && databaseBigintPattern.test(result.generation)
    && BigInt(result.generation) <= maximumDatabaseBigint
    ? BigInt(result.generation)
    : generation;
  return {
    commandId: row.id,
    outcome: "deduplicated",
    code,
    generation: storedGeneration,
  };
}

function validateCommandTargets(input: {
  readonly commandType: ProviderControlCommandType;
  readonly targetRunId: string | null;
  readonly targetQuarantineId: string | null;
}): void {
  const valid = input.commandType === "retry_run"
    ? input.targetRunId !== null && input.targetQuarantineId === null
    : input.commandType === "retry_quarantine"
      ? input.targetRunId === null && input.targetQuarantineId !== null
      : input.targetRunId === null && input.targetQuarantineId === null;
  if (!valid) throw new TypeError("Provider command target does not match its type.");
}

async function appendCommandTerminalEvidence(
  transaction: ProviderTransactionClient,
  input: {
    readonly commandId: string;
    readonly operatorId: string;
    readonly correlationId: string;
    readonly commandType: ProviderControlCommandType;
    readonly outcome: Exclude<ProviderCommandOutcome, "deduplicated">;
    readonly code: string;
    readonly generation: bigint;
    readonly at: Date;
  },
): Promise<void> {
  await appendProviderLocalAudit(transaction, {
    commandId: input.commandId,
    actorOperatorId: input.operatorId,
    correlationId: input.correlationId,
    action: "provider.command.terminal",
    targetType: "control_command",
    targetId: input.commandId,
    outcome: input.outcome === "accepted" ? "success" : input.outcome === "failed" ? "failure" : "blocked",
    details: {
      commandType: input.commandType,
      resultCode: input.code,
      stateGeneration: input.generation.toString(),
    },
    occurredAt: input.at,
  });
  await appendProviderActivityOutbox(transaction, {
    eventType: "provider.command.terminal",
    severity: input.outcome === "failed" ? "critical" : input.outcome === "accepted" ? "info" : "warning",
    dedupeKey: `command:${input.commandId}:terminal`,
    recoveryKey: `command:${input.commandId}`,
    title: "Provider command decided",
    summary: `Provider command finished with ${input.outcome}.`,
    evidence: { state: input.outcome, generation: input.generation.toString() },
    eventAt: input.at,
  });
}

export class PrismaProviderCommandRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async submit(input: {
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly commandType: ProviderControlCommandType;
    readonly targetRunId: string | null;
    readonly targetQuarantineId: string | null;
    readonly expectedGeneration: bigint;
    readonly requestedByOperatorId: string;
    readonly correlationId: string;
    readonly reason: string | null;
    readonly requestedAt: Date;
  }): Promise<ProviderControlCommandResult> {
    requireUuid(input.commandId, "commandId");
    requireUuid(input.requestedByOperatorId, "requestedByOperatorId");
    requireUuid(input.correlationId, "correlationId");
    if (input.targetRunId !== null) requireUuid(input.targetRunId, "targetRunId");
    if (input.targetQuarantineId !== null) requireUuid(input.targetQuarantineId, "targetQuarantineId");
    validateCommandTargets(input);
    requireSafeKey(input.idempotencyKey, "idempotencyKey");
    requireInstant(input.requestedAt, "requestedAt");
    if (input.expectedGeneration < 0n) throw new TypeError("expectedGeneration is invalid.");
    const reason = normalizedReason(input.commandType, input.reason);
    const normalized = { ...input, reason };
    return this.database.$transaction(async (transaction) => {
      const runtime = await lockRuntime(transaction);
      const existing = await transaction.control_commands.findUnique({
        where: { idempotency_key: input.idempotencyKey },
      }) as CommandRow | null;
      if (existing) {
        if (!requestMatches(existing, normalized)) {
          return {
            commandId: existing.id,
            outcome: "conflict" as const,
            code: "COMMAND_IDEMPOTENCY_CONFLICT",
            generation: runtime.state_generation,
          };
        }
        return outcomeFromStored(existing, runtime.state_generation);
      }
      await transaction.control_commands.create({
        data: {
          id: input.commandId,
          idempotency_key: input.idempotencyKey,
          command_type: input.commandType,
          target_run_id: input.targetRunId,
          target_quarantine_id: input.targetQuarantineId,
          expected_generation: input.expectedGeneration,
          requested_by_operator_id: input.requestedByOperatorId,
          correlation_id: input.correlationId,
          reason,
          requested_at: input.requestedAt,
        },
      });
      if (runtime.state_generation !== input.expectedGeneration) {
        const code = "RUNTIME_GENERATION_CONFLICT";
        await transaction.control_commands.update({
          where: { id: input.commandId },
          data: {
            state: "rejected",
            result: commandResult("conflict", code, runtime.state_generation),
            acknowledged_at: input.requestedAt,
            completed_at: input.requestedAt,
            row_version: { increment: 1n },
          },
        });
        await appendCommandTerminalEvidence(transaction, {
          commandId: input.commandId,
          operatorId: input.requestedByOperatorId,
          correlationId: input.correlationId,
          commandType: input.commandType,
          outcome: "conflict",
          code,
          generation: runtime.state_generation,
          at: input.requestedAt,
        });
        return { commandId: input.commandId, outcome: "conflict", code, generation: runtime.state_generation };
      }
      const target = desiredRuntimeState(input.commandType);
      if (target === null) {
        await transaction.control_commands.update({
          where: { id: input.commandId },
          data: {
            state: "accepted",
            result: commandResult("accepted", "COMMAND_ACCEPTED", runtime.state_generation),
            acknowledged_at: input.requestedAt,
            row_version: { increment: 1n },
          },
        });
        return {
          commandId: input.commandId,
          outcome: "accepted",
          code: "COMMAND_ACCEPTED",
          generation: runtime.state_generation,
        };
      }
      const targetReason = target === "paused" || target === "stopped" ? reason : null;
      if (runtime.operating_state === target) {
        const sameReason = runtime.state_reason === targetReason;
        const outcome = sameReason ? "accepted" as const : "conflict" as const;
        const code = sameReason ? "RUNTIME_ALREADY_IN_STATE" : "RUNTIME_REASON_CONFLICT";
        await transaction.control_commands.update({
          where: { id: input.commandId },
          data: {
            state: sameReason ? "accepted" : "rejected",
            result: commandResult(outcome, code, runtime.state_generation),
            acknowledged_at: input.requestedAt,
            ...(sameReason ? {} : { completed_at: input.requestedAt }),
            row_version: { increment: 1n },
          },
        });
        if (sameReason) {
          await transaction.control_commands.update({
            where: { id: input.commandId },
            data: {
              state: "completed",
              completed_at: input.requestedAt,
              row_version: { increment: 1n },
            },
          });
        }
        await appendCommandTerminalEvidence(transaction, {
          commandId: input.commandId,
          operatorId: input.requestedByOperatorId,
          correlationId: input.correlationId,
          commandType: input.commandType,
          outcome,
          code,
          generation: runtime.state_generation,
          at: input.requestedAt,
        });
        return { commandId: input.commandId, outcome, code, generation: runtime.state_generation };
      }
      if (!providerRuntimeTransitionAllowed({
        from: runtime.operating_state,
        to: target,
        actorType: "operator",
      })) {
        const code = "RUNTIME_TRANSITION_FORBIDDEN";
        await transaction.control_commands.update({
          where: { id: input.commandId },
          data: {
            state: "rejected",
            result: commandResult("forbidden", code, runtime.state_generation),
            acknowledged_at: input.requestedAt,
            completed_at: input.requestedAt,
            row_version: { increment: 1n },
          },
        });
        await appendCommandTerminalEvidence(transaction, {
          commandId: input.commandId,
          operatorId: input.requestedByOperatorId,
          correlationId: input.correlationId,
          commandType: input.commandType,
          outcome: "forbidden",
          code,
          generation: runtime.state_generation,
          at: input.requestedAt,
        });
        return { commandId: input.commandId, outcome: "forbidden", code, generation: runtime.state_generation };
      }
      const generation = runtime.state_generation + 1n;
      await transaction.control_commands.update({
        where: { id: input.commandId },
        data: {
          state: "accepted",
          result: commandResult("accepted", "COMMAND_ACCEPTED", generation),
          acknowledged_at: input.requestedAt,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_state_events.create({
        data: {
          from_state: runtime.operating_state,
          to_state: target,
          state_generation: generation,
          reason: targetReason,
          actor_type: "operator",
          actor_id: input.requestedByOperatorId,
          correlation_id: input.correlationId,
          occurred_at: input.requestedAt,
        },
      });
      await transaction.provider_runtime.update({
        where: { singleton_key: true },
        data: {
          operating_state: target,
          state_reason: targetReason,
          state_generation: generation,
          row_version: { increment: 1n },
        },
      });
      const code = "RUNTIME_TRANSITION_APPLIED";
      await transaction.control_commands.update({
        where: { id: input.commandId },
        data: {
          state: "completed",
          result: commandResult("accepted", code, generation),
          completed_at: input.requestedAt,
          row_version: { increment: 1n },
        },
      });
      await appendProviderLocalAudit(transaction, {
        commandId: input.commandId,
        actorOperatorId: input.requestedByOperatorId,
        correlationId: input.correlationId,
        action: "provider.runtime.transition",
        targetType: "provider_runtime",
        targetId: runtime.central_provider_id,
        outcome: "success",
        details: {
          fromState: runtime.operating_state,
          toState: target,
          stateGeneration: generation.toString(),
        },
        occurredAt: input.requestedAt,
      });
      await appendProviderActivityOutbox(transaction, {
        eventType: "provider.runtime.transitioned",
        severity: target === "stopped" ? "critical" : "info",
        dedupeKey: `runtime:${generation}`,
        recoveryKey: "provider-runtime-state",
        title: "Provider runtime state changed",
        summary: `Provider runtime entered ${target}.`,
        evidence: { state: target, generation: generation.toString() },
        eventAt: input.requestedAt,
      });
      await appendCommandTerminalEvidence(transaction, {
        commandId: input.commandId,
        operatorId: input.requestedByOperatorId,
        correlationId: input.correlationId,
        commandType: input.commandType,
        outcome: "accepted",
        code,
        generation,
        at: input.requestedAt,
      });
      return { commandId: input.commandId, outcome: "accepted", code, generation };
    }, TRANSACTION_OPTIONS);
  }

  async nextAccepted(): Promise<ProviderAcceptedControlCommand | null> {
    return this.database.control_commands.findFirst({
      where: { state: "accepted" },
      orderBy: [{ requested_at: "asc" }, { id: "asc" }],
    }) as Promise<ProviderAcceptedControlCommand | null>;
  }

  async terminalizeAccepted(input: {
    readonly commandId: string;
    readonly workerId: string;
    readonly workerFence: bigint;
    readonly outcome: "accepted" | "failed";
    readonly code: string;
    readonly completedAt: Date;
  }): Promise<boolean> {
    requireUuid(input.commandId, "commandId");
    requireSafeKey(input.workerId, "workerId");
    requireInstant(input.completedAt, "completedAt");
    if (!safeCodePattern.test(input.code)) throw new TypeError("Provider command result code is invalid.");
    return this.database.$transaction(async (transaction) => {
      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: input.workerId,
        fence: input.workerFence
      })) return false;
      await setProviderImportLeaseContext(transaction, {
        owner: input.workerId,
        fence: input.workerFence,
      });
      const completedAt = providerWorkerLeaseDatabaseNow(lease);
      const command = await transaction.control_commands.findUnique({
        where: { id: input.commandId },
      }) as CommandRow | null;
      if (!command || command.state !== "accepted") return false;
      const runtime = await lockRuntime(transaction);
      await transaction.control_commands.update({
        where: { id: command.id },
        data: {
          state: input.outcome === "accepted" ? "completed" : "failed",
          result: commandResult(input.outcome, input.code, runtime.state_generation),
          completed_at: completedAt,
          row_version: { increment: 1n },
        },
      });
      await appendCommandTerminalEvidence(transaction, {
        commandId: command.id,
        operatorId: command.requested_by_operator_id,
        correlationId: command.correlation_id,
        commandType: command.command_type,
        outcome: input.outcome,
        code: input.code,
        generation: runtime.state_generation,
        at: completedAt,
      });
      return true;
    }, TRANSACTION_OPTIONS);
  }
}
