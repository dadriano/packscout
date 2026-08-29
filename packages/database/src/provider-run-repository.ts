import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import type { CanonicalJsonValue } from "./provider-canonical-contract.ts";
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
  timeout: 30_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const safeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const safeFailurePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

export type ProviderRunTrigger = "scheduled" | "manual" | "recovery";
export type ProviderRunState = "queued" | "running" | "succeeded" | "incomplete" | "failed";

export interface ProviderRunCounters {
  readonly pages: number;
  readonly catalog: number;
  readonly pulls: number;
  readonly marketEvents: number;
  readonly accepted: number;
  readonly duplicate: number;
  readonly quarantined: number;
  readonly materialChanges: number;
}

export interface ProviderRunSummary {
  readonly id: string;
  readonly state: ProviderRunState;
  readonly trigger: ProviderRunTrigger;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly workerFence: bigint;
  readonly attemptNumber: number;
  readonly recoveryOfRunId: string | null;
  readonly cursorFingerprint: string | null;
  readonly reachedSourceHead: boolean;
  readonly counters: ProviderRunCounters;
  readonly failureCode: string | null;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export type StartProviderRunResult =
  | { readonly kind: "started"; readonly run: ProviderRunSummary }
  | { readonly kind: "deduplicated" | "active"; readonly run: ProviderRunSummary }
  | { readonly kind: "idempotency_conflict" | "lease_lost" | "runtime_unavailable" | "config_expired" | "config_mismatch" };

export type CommitProviderRunPageResult =
  | { readonly kind: "committed" | "replayed"; readonly run: ProviderRunSummary; readonly pageId: string }
  | { readonly kind: "immutable_conflict" | "cursor_conflict" | "lease_lost" | "run_not_running" | "runtime_not_running" };

export type FinishProviderRunResult =
  | { readonly kind: "finished" | "already_terminal"; readonly run: ProviderRunSummary }
  | { readonly kind: "head_not_reached" | "lease_lost" | "not_found" };

interface RuntimeRow {
  readonly central_provider_id: string;
  readonly operating_state: "idle" | "running" | "paused" | "stopped" | "error";
  readonly state_reason: string | null;
  readonly state_generation: bigint;
  readonly cached_config_version_id: string | null;
  readonly cached_config_version_number: bigint | null;
  readonly config_expires_at: Date | null;
  readonly schedule_seconds: number | null;
  readonly source_cursor: ProviderPrisma.JsonValue | null;
  readonly source_cursor_hash: string | null;
  readonly consecutive_failures: number;
  readonly recovered_at: Date | null;
  readonly row_version: bigint;
}

interface RunRow {
  readonly id: string;
  readonly control_command_id: string | null;
  readonly recovery_of_run_id: string | null;
  readonly idempotency_key: string;
  readonly trigger: ProviderRunTrigger;
  readonly state: ProviderRunState;
  readonly requested_by_operator_id: string | null;
  readonly config_version_id: string;
  readonly config_version_number: bigint;
  readonly worker_fence: bigint;
  readonly attempt_number: number;
  readonly final_cursor_hash: string | null;
  readonly reached_source_head: boolean;
  readonly page_count: number;
  readonly catalog_record_count: number;
  readonly pull_record_count: number;
  readonly market_event_record_count: number;
  readonly accepted_count: number;
  readonly duplicate_count: number;
  readonly quarantined_count: number;
  readonly material_change_count: number;
  readonly failure_code: string | null;
  readonly requested_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly row_version: bigint;
}

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

function jsonInput(value: CanonicalJsonValue | null): ProviderPrisma.InputJsonValue | typeof ProviderPrisma.DbNull {
  return value === null
    ? ProviderPrisma.DbNull
    : value as ProviderPrisma.InputJsonValue;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateCounts(input: Omit<ProviderRunCounters, "pages"> & { readonly records: number }): void {
  const values = Object.values(input);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Provider page counts must be nonnegative safe integers.");
  }
  if (
    input.catalog + input.pulls + input.marketEvents !== input.records
    || input.accepted + input.duplicate + input.quarantined !== input.records
    || input.materialChanges > input.accepted
  ) throw new TypeError("Provider page counts do not reconcile.");
}

function toSummary(row: RunRow): ProviderRunSummary {
  return {
    id: row.id,
    state: row.state,
    trigger: row.trigger,
    configVersionId: row.config_version_id,
    configVersionNumber: row.config_version_number,
    workerFence: row.worker_fence,
    attemptNumber: row.attempt_number,
    recoveryOfRunId: row.recovery_of_run_id,
    cursorFingerprint: row.final_cursor_hash,
    reachedSourceHead: row.reached_source_head,
    counters: {
      pages: row.page_count,
      catalog: row.catalog_record_count,
      pulls: row.pull_record_count,
      marketEvents: row.market_event_record_count,
      accepted: row.accepted_count,
      duplicate: row.duplicate_count,
      quarantined: row.quarantined_count,
      materialChanges: row.material_change_count,
    },
    failureCode: row.failure_code,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<RuntimeRow> {
  const [row] = await transaction.$queryRaw<RuntimeRow[]>(ProviderPrisma.sql`
    select central_provider_id, operating_state, state_reason, state_generation,
           cached_config_version_id, cached_config_version_number,
           config_expires_at, schedule_seconds, source_cursor, source_cursor_hash,
           consecutive_failures, recovered_at, row_version
    from provider_runtime where singleton_key = true for update
  `);
  if (!row) throw new Error("Provider runtime is not initialized.");
  return row;
}

async function lockRun(
  transaction: ProviderTransactionClient,
  runId: string,
): Promise<RunRow | null> {
  const [row] = await transaction.$queryRaw<RunRow[]>(ProviderPrisma.sql`
    select id, control_command_id, recovery_of_run_id, idempotency_key,
           trigger, state, requested_by_operator_id, config_version_id,
           config_version_number, worker_fence, attempt_number,
           final_cursor_hash, reached_source_head, page_count,
           catalog_record_count, pull_record_count, market_event_record_count,
           accepted_count, duplicate_count, quarantined_count,
           material_change_count, failure_code, requested_at, started_at,
           finished_at, row_version
    from provider_runs where id = cast(${runId} as uuid) for update
  `);
  return row ?? null;
}

async function activeRun(transaction: ProviderTransactionClient): Promise<RunRow | null> {
  const [row] = await transaction.$queryRaw<RunRow[]>(ProviderPrisma.sql`
    select id, control_command_id, recovery_of_run_id, idempotency_key,
           trigger, state, requested_by_operator_id, config_version_id,
           config_version_number, worker_fence, attempt_number,
           final_cursor_hash, reached_source_head, page_count,
           catalog_record_count, pull_record_count, market_event_record_count,
           accepted_count, duplicate_count, quarantined_count,
           material_change_count, failure_code, requested_at, started_at,
           finished_at, row_version
    from provider_runs
    where state in ('queued', 'running')
    order by requested_at, id
    for update
    limit 1
  `);
  return row ?? null;
}

async function transitionRuntimeToRunning(
  transaction: ProviderTransactionClient,
  runtime: RuntimeRow,
  input: { readonly workerId: string; readonly correlationId: string; readonly at: Date },
): Promise<void> {
  const generation = runtime.state_generation + 1n;
  await transaction.provider_state_events.create({
    data: {
      from_state: runtime.operating_state,
      to_state: "running",
      state_generation: generation,
      reason: null,
      actor_type: "runner",
      actor_id: input.workerId,
      correlation_id: input.correlationId,
      occurred_at: input.at,
    },
  });
  await transaction.provider_runtime.update({
    where: { singleton_key: true },
    data: {
      operating_state: "running",
      state_reason: null,
      state_generation: generation,
      last_runner_heartbeat_at: input.at,
      last_attempted_at: input.at,
      row_version: { increment: 1n },
    },
  });
  await appendProviderLocalAudit(transaction, {
    correlationId: input.correlationId,
    action: "provider.runtime.transition",
    targetType: "provider_runtime",
    targetId: runtime.central_provider_id,
    outcome: "success",
    details: {
      fromState: runtime.operating_state,
      toState: "running",
      stateGeneration: generation.toString(),
    },
    occurredAt: input.at,
  });
  await appendProviderActivityOutbox(transaction, {
    eventType: "provider.runtime.transitioned",
    severity: "info",
    dedupeKey: `runtime:${generation}`,
    recoveryKey: "provider-runtime-state",
    title: "Provider runtime started",
    summary: "Provider runtime entered running.",
    evidence: { state: "running", generation: generation.toString() },
    eventAt: input.at,
  });
}

async function completeRunCommandAgainstPriorRun(
  transaction: ProviderTransactionClient,
  input: {
    readonly commandId: string;
    readonly operatorId: string;
    readonly correlationId: string;
    readonly runId: string;
    readonly generation: bigint;
    readonly completedAt: Date;
  },
): Promise<void> {
  await transaction.control_commands.update({
    where: { id: input.commandId },
    data: {
      state: "completed",
      result: {
        outcome: "accepted",
        code: "RUN_ALREADY_ACTIVE",
        generation: input.generation.toString(),
      },
      resulting_run_id: input.runId,
      completed_at: input.completedAt,
      row_version: { increment: 1n },
    },
  });
  await appendProviderLocalAudit(transaction, {
    commandId: input.commandId,
    actorOperatorId: input.operatorId,
    correlationId: input.correlationId,
    action: "provider.command.terminal",
    targetType: "control_command",
    targetId: input.commandId,
    outcome: "success",
    details: {
      commandType: "run",
      resultCode: "RUN_ALREADY_ACTIVE",
      stateGeneration: input.generation.toString(),
    },
    occurredAt: input.completedAt,
  });
  await appendProviderActivityOutbox(transaction, {
    eventType: "provider.command.terminal",
    severity: "info",
    dedupeKey: `command:${input.commandId}:terminal`,
    recoveryKey: `command:${input.commandId}`,
    title: "Provider run command joined prior work",
    summary: "Provider run command retained its original mixed run.",
    evidence: {
      state: "accepted",
      generation: input.generation.toString(),
    },
    eventAt: input.completedAt,
  });
}

export class PrismaProviderRunRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async active(): Promise<ProviderRunSummary | null> {
    const row = await this.database.provider_runs.findFirst({
      where: { state: { in: ["queued", "running"] } },
      orderBy: [{ requested_at: "asc" }, { id: "asc" }],
    });
    return row === null ? null : toSummary(row as RunRow);
  }

  async start(input: {
    readonly runId: string;
    readonly idempotencyKey: string;
    readonly trigger: Exclude<ProviderRunTrigger, "recovery">;
    readonly requestedByOperatorId: string | null;
    readonly configVersionId: string;
    readonly configVersionNumber: bigint;
    readonly workerId: string;
    readonly workerFence: bigint;
    readonly correlationId: string;
    readonly requestedAt: Date;
    readonly controlCommandId?: string | null;
  }): Promise<StartProviderRunResult> {
    requireUuid(input.runId, "runId");
    requireUuid(input.configVersionId, "configVersionId");
    requireUuid(input.correlationId, "correlationId");
    if (input.requestedByOperatorId !== null) requireUuid(input.requestedByOperatorId, "requestedByOperatorId");
    if (input.controlCommandId) requireUuid(input.controlCommandId, "controlCommandId");
    requireSafeKey(input.idempotencyKey, "idempotencyKey");
    requireSafeKey(input.workerId, "workerId");
    requireInstant(input.requestedAt, "requestedAt");
    return this.database.$transaction(async (transaction) => {
      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: input.workerId,
        fence: input.workerFence
      })) return { kind: "lease_lost" as const };
      await setProviderImportLeaseContext(transaction, {
        owner: input.workerId,
        fence: input.workerFence,
      });
      const startedAt = providerWorkerLeaseDatabaseNow(lease);
      const existing = await transaction.provider_runs.findUnique({
        where: { idempotency_key: input.idempotencyKey },
      });
      if (existing) {
        const commandReplay = input.controlCommandId !== undefined
          && input.controlCommandId !== null
          && existing.control_command_id === (input.controlCommandId ?? null)
          && existing.recovery_of_run_id === null
          && existing.trigger === input.trigger
          && existing.requested_by_operator_id === input.requestedByOperatorId
          && existing.config_version_id === input.configVersionId
          && existing.config_version_number === input.configVersionNumber
          && existing.requested_at.getTime() === input.requestedAt.getTime();
        const exactReplay = commandReplay || (
          existing.id === input.runId
          && existing.control_command_id === (input.controlCommandId ?? null)
          && existing.recovery_of_run_id === null
          && existing.trigger === input.trigger
          && existing.requested_by_operator_id === input.requestedByOperatorId
          && existing.config_version_id === input.configVersionId
          && existing.config_version_number === input.configVersionNumber
          && existing.requested_at.getTime() === input.requestedAt.getTime()
        );
        if (!exactReplay) return { kind: "idempotency_conflict" as const };
        if (existing.state !== "queued") {
          return { kind: "deduplicated" as const, run: toSummary(existing as RunRow) };
        }
        const runtime = await lockRuntime(transaction);
        if (runtime.operating_state !== "idle") {
          return { kind: "runtime_unavailable" as const };
        }
        if (
          runtime.cached_config_version_id !== input.configVersionId
          || runtime.cached_config_version_number !== input.configVersionNumber
        ) return { kind: "config_mismatch" as const };
        if (runtime.config_expires_at !== null && runtime.config_expires_at <= startedAt) {
          return { kind: "config_expired" as const };
        }
        const command = input.controlCommandId
          ? await transaction.control_commands.findUnique({
              where: { id: input.controlCommandId },
              select: {
                state: true,
                command_type: true,
                requested_by_operator_id: true,
                correlation_id: true,
                resulting_run_id: true,
              },
            })
          : null;
        if (
          command?.state !== "accepted"
          || command.command_type !== "run"
          || command.requested_by_operator_id !== input.requestedByOperatorId
          || command.correlation_id !== input.correlationId
          || command.resulting_run_id !== existing.id
        ) throw new Error("Accepted queued run command is unavailable.");
        await transaction.provider_runs.update({
          where: { id: existing.id },
          data: {
            state: "running",
            worker_fence: input.workerFence,
            started_at: startedAt,
            heartbeat_at: startedAt,
            last_progress_at: startedAt,
            row_version: { increment: 1n },
          },
        });
        const generation = runtime.state_generation + 1n;
        await transaction.control_commands.update({
          where: { id: input.controlCommandId! },
          data: {
            state: "completed",
            result: {
              outcome: "accepted",
              code: "RUN_STARTED",
              generation: generation.toString(),
            },
            completed_at: startedAt,
            row_version: { increment: 1n },
          },
        });
        await transitionRuntimeToRunning(transaction, runtime, {
          workerId: input.workerId,
          correlationId: input.correlationId,
          at: startedAt,
        });
        await appendProviderLocalAudit(transaction, {
          commandId: input.controlCommandId,
          actorOperatorId: input.requestedByOperatorId,
          correlationId: input.correlationId,
          action: "provider.run.started",
          targetType: "provider_run",
          targetId: existing.id,
          outcome: "success",
          details: { runId: existing.id, leaseFence: input.workerFence.toString() },
          occurredAt: startedAt,
        });
        await appendProviderLocalAudit(transaction, {
          commandId: input.controlCommandId,
          actorOperatorId: input.requestedByOperatorId,
          correlationId: input.correlationId,
          action: "provider.command.terminal",
          targetType: "control_command",
          targetId: input.controlCommandId!,
          outcome: "success",
          details: {
            commandType: "run",
            resultCode: "RUN_STARTED",
            stateGeneration: generation.toString(),
          },
          occurredAt: startedAt,
        });
        await appendProviderActivityOutbox(transaction, {
          eventType: "provider.command.terminal",
          severity: "info",
          dedupeKey: `command:${input.controlCommandId}:terminal`,
          recoveryKey: `command:${input.controlCommandId}`,
          title: "Provider command decided",
          summary: "Provider run command finished with accepted.",
          evidence: { state: "accepted", generation: generation.toString() },
          eventAt: startedAt,
        });
        const claimed = await lockRun(transaction, existing.id);
        if (!claimed) throw new Error("Claimed provider run is unavailable.");
        return { kind: "started" as const, run: toSummary(claimed) };
      }
      if (input.controlCommandId !== undefined && input.controlCommandId !== null) {
        const linkedCommand = await transaction.control_commands.findUnique({
          where: { id: input.controlCommandId },
          select: {
            state: true,
            command_type: true,
            requested_by_operator_id: true,
            correlation_id: true,
            resulting_run_id: true,
          },
        });
        if (linkedCommand?.state === "accepted" && linkedCommand.resulting_run_id !== null) {
          if (
            linkedCommand.command_type !== "run"
            || linkedCommand.requested_by_operator_id !== input.requestedByOperatorId
            || linkedCommand.correlation_id !== input.correlationId
          ) throw new Error("Accepted run command identity is invalid.");
          const priorRun = await lockRun(transaction, linkedCommand.resulting_run_id);
          if (!priorRun) throw new Error("Accepted run command target is unavailable.");
          const runtime = await lockRuntime(transaction);
          await completeRunCommandAgainstPriorRun(transaction, {
            commandId: input.controlCommandId,
            operatorId: linkedCommand.requested_by_operator_id,
            correlationId: linkedCommand.correlation_id,
            runId: priorRun.id,
            generation: runtime.state_generation,
            completedAt: startedAt,
          });
          return { kind: "deduplicated" as const, run: toSummary(priorRun) };
        }
      }
      const currentActive = await activeRun(transaction);
      if (currentActive) {
        if (input.controlCommandId !== undefined && input.controlCommandId !== null) {
          const runtime = await lockRuntime(transaction);
          const command = await transaction.control_commands.findUnique({
            where: { id: input.controlCommandId },
            select: {
              state: true,
              command_type: true,
              requested_by_operator_id: true,
              correlation_id: true,
            },
          });
          if (
            command?.state !== "accepted"
            || command.command_type !== "run"
            || command.requested_by_operator_id !== input.requestedByOperatorId
            || command.correlation_id !== input.correlationId
          ) throw new Error("Accepted run command is unavailable.");
          await completeRunCommandAgainstPriorRun(transaction, {
            commandId: input.controlCommandId,
            operatorId: command.requested_by_operator_id,
            correlationId: command.correlation_id,
            runId: currentActive.id,
            generation: runtime.state_generation,
            completedAt: startedAt,
          });
        }
        return { kind: "active" as const, run: toSummary(currentActive) };
      }
      const runtime = await lockRuntime(transaction);
      if (runtime.operating_state !== "idle") return { kind: "runtime_unavailable" as const };
      if (
        runtime.cached_config_version_id !== input.configVersionId
        || runtime.cached_config_version_number !== input.configVersionNumber
      ) return { kind: "config_mismatch" as const };
      if (runtime.config_expires_at !== null && runtime.config_expires_at <= startedAt) {
        return { kind: "config_expired" as const };
      }
      await transaction.provider_runs.create({
        data: {
          id: input.runId,
          control_command_id: input.controlCommandId ?? null,
          idempotency_key: input.idempotencyKey,
          trigger: input.trigger,
          state: "running",
          requested_by_operator_id: input.requestedByOperatorId,
          config_version_id: input.configVersionId,
          config_version_number: input.configVersionNumber,
          worker_fence: input.workerFence,
          requested_cursor: jsonInput(runtime.source_cursor as CanonicalJsonValue | null),
          requested_cursor_hash: runtime.source_cursor_hash,
          requested_at: input.requestedAt,
          started_at: startedAt,
          heartbeat_at: startedAt,
          last_progress_at: startedAt,
        },
      });
      let completedCommand: {
        readonly requestedByOperatorId: string;
        readonly correlationId: string;
        readonly commandType: "run" | "retry_run";
      } | null = null;
      if (input.controlCommandId) {
        const command = await transaction.control_commands.findUnique({
          where: { id: input.controlCommandId },
          select: {
            state: true,
            command_type: true,
            requested_by_operator_id: true,
            correlation_id: true,
          },
        });
        if (
          command?.state !== "accepted"
          || (command.command_type !== "run" && command.command_type !== "retry_run")
          || command.requested_by_operator_id !== input.requestedByOperatorId
          || command.correlation_id !== input.correlationId
        ) throw new Error("Accepted run command is unavailable.");
        await transaction.control_commands.update({
          where: { id: input.controlCommandId },
          data: {
            state: "completed",
            result: {
              outcome: "accepted",
              code: "RUN_STARTED",
              generation: (runtime.state_generation + 1n).toString(),
            },
            resulting_run_id: input.runId,
            completed_at: startedAt,
            row_version: { increment: 1n },
          },
        });
        completedCommand = {
          requestedByOperatorId: command.requested_by_operator_id,
          correlationId: command.correlation_id,
          commandType: command.command_type,
        };
      }
      await transitionRuntimeToRunning(transaction, runtime, {
        workerId: input.workerId,
        correlationId: input.correlationId,
        at: startedAt,
      });
      await appendProviderLocalAudit(transaction, {
        commandId: input.controlCommandId,
        actorOperatorId: input.requestedByOperatorId,
        correlationId: input.correlationId,
        action: "provider.run.started",
        targetType: "provider_run",
        targetId: input.runId,
        outcome: "success",
        details: { runId: input.runId, leaseFence: input.workerFence.toString() },
        occurredAt: startedAt,
      });
      if (completedCommand !== null && input.controlCommandId) {
        const generation = runtime.state_generation + 1n;
        await appendProviderLocalAudit(transaction, {
          commandId: input.controlCommandId,
          actorOperatorId: completedCommand.requestedByOperatorId,
          correlationId: completedCommand.correlationId,
          action: "provider.command.terminal",
          targetType: "control_command",
          targetId: input.controlCommandId,
          outcome: "success",
          details: {
            commandType: completedCommand.commandType,
            resultCode: "RUN_STARTED",
            stateGeneration: generation.toString(),
          },
          occurredAt: startedAt,
        });
        await appendProviderActivityOutbox(transaction, {
          eventType: "provider.command.terminal",
          severity: "info",
          dedupeKey: `command:${input.controlCommandId}:terminal`,
          recoveryKey: `command:${input.controlCommandId}`,
          title: "Provider command decided",
          summary: "Provider run command finished with accepted.",
          evidence: { state: "accepted", generation: generation.toString() },
          eventAt: startedAt,
        });
      }
      const run = await lockRun(transaction, input.runId);
      if (!run) throw new Error("Started provider run is unavailable.");
      return { kind: "started" as const, run: toSummary(run) };
    }, TRANSACTION_OPTIONS);
  }

  async commitPage(input: {
    readonly pageId: string;
    readonly runId: string;
    readonly workerId: string;
    readonly workerFence: bigint;
    readonly contractVersion: string;
    readonly requestedCursor: CanonicalJsonValue | null;
    readonly requestedCursorHash: string | null;
    readonly nextCursor: CanonicalJsonValue | null;
    readonly nextCursorHash: string | null;
    readonly continuation: "more" | "head";
    readonly responseDigest: string;
    readonly counts: Omit<ProviderRunCounters, "pages"> & { readonly records: number };
    readonly committedAt: Date;
    readonly applyCanonicalWrites?: (transaction: ProviderTransactionClient) => Promise<void>;
  }): Promise<CommitProviderRunPageResult> {
    requireUuid(input.pageId, "pageId");
    requireUuid(input.runId, "runId");
    requireSafeKey(input.workerId, "workerId");
    requireSafeKey(input.contractVersion, "contractVersion");
    requireInstant(input.committedAt, "committedAt");
    validateCounts(input.counts);
    if (!digestPattern.test(input.responseDigest)) throw new TypeError("responseDigest is invalid.");
    if ((input.requestedCursor === null) !== (input.requestedCursorHash === null)) {
      throw new TypeError("Requested cursor and fingerprint must be paired.");
    }
    if ((input.nextCursor === null) !== (input.nextCursorHash === null)) {
      throw new TypeError("Next cursor and fingerprint must be paired.");
    }
    if (input.requestedCursorHash !== null && !digestPattern.test(input.requestedCursorHash)) {
      throw new TypeError("requestedCursorHash is invalid.");
    }
    if (input.nextCursorHash !== null && !digestPattern.test(input.nextCursorHash)) {
      throw new TypeError("nextCursorHash is invalid.");
    }
    if ((input.continuation === "head") !== (input.nextCursor === null)) {
      throw new TypeError("Provider page continuation and next cursor disagree.");
    }
    return this.database.$transaction(async (transaction) => {
      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: input.workerId,
        fence: input.workerFence
      })) return { kind: "lease_lost" as const };
      await setProviderImportLeaseContext(transaction, {
        owner: input.workerId,
        fence: input.workerFence,
      });
      const committedAt = providerWorkerLeaseDatabaseNow(lease);
      const run = await lockRun(transaction, input.runId);
      if (!run || run.worker_fence !== input.workerFence) {
        return { kind: "run_not_running" as const };
      }
      const prior = await transaction.provider_run_pages.findFirst({
        where: {
          provider_run_id: input.runId,
          requested_cursor_hash: input.requestedCursorHash,
        },
        select: {
          id: true,
          contract_version: true,
          requested_cursor: true,
          requested_cursor_hash: true,
          next_cursor: true,
          next_cursor_hash: true,
          continuation: true,
          response_digest: true,
          record_count: true,
          catalog_record_count: true,
          pull_record_count: true,
          market_event_record_count: true,
          accepted_count: true,
          duplicate_count: true,
          quarantined_count: true,
          material_change_count: true,
        },
      });
      if (prior) {
        const exactReplay = prior.id === input.pageId
          && prior.contract_version === input.contractVersion
          && jsonEqual(prior.requested_cursor, input.requestedCursor)
          && prior.requested_cursor_hash === input.requestedCursorHash
          && jsonEqual(prior.next_cursor, input.nextCursor)
          && prior.next_cursor_hash === input.nextCursorHash
          && prior.continuation === input.continuation
          && prior.response_digest === input.responseDigest
          && prior.record_count === input.counts.records
          && prior.catalog_record_count === input.counts.catalog
          && prior.pull_record_count === input.counts.pulls
          && prior.market_event_record_count === input.counts.marketEvents
          && prior.accepted_count === input.counts.accepted
          && prior.duplicate_count === input.counts.duplicate
          && prior.quarantined_count === input.counts.quarantined
          && prior.material_change_count === input.counts.materialChanges;
        return exactReplay
          ? { kind: "replayed" as const, run: toSummary(run), pageId: prior.id }
          : { kind: "immutable_conflict" as const };
      }
      if (run.state !== "running") return { kind: "run_not_running" as const };
      const runtime = await lockRuntime(transaction);
      if (runtime.operating_state !== "running") {
        return { kind: "runtime_not_running" as const };
      }
      if (runtime.source_cursor_hash !== input.requestedCursorHash) {
        return { kind: "cursor_conflict" as const };
      }
      await input.applyCanonicalWrites?.(transaction);
      await transaction.provider_runtime.update({
        where: { singleton_key: true },
        data: {
          source_cursor: jsonInput(input.nextCursor),
          source_cursor_hash: input.nextCursorHash,
          last_attempted_at: committedAt,
          last_runner_heartbeat_at: committedAt,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_runs.update({
        where: { id: input.runId },
        data: {
          page_count: { increment: 1 },
          catalog_record_count: { increment: input.counts.catalog },
          pull_record_count: { increment: input.counts.pulls },
          market_event_record_count: { increment: input.counts.marketEvents },
          accepted_count: { increment: input.counts.accepted },
          duplicate_count: { increment: input.counts.duplicate },
          quarantined_count: { increment: input.counts.quarantined },
          material_change_count: { increment: input.counts.materialChanges },
          reached_source_head: input.continuation === "head" || run.reached_source_head,
          heartbeat_at: committedAt,
          last_progress_at: committedAt,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_run_pages.create({
        data: {
          id: input.pageId,
          provider_run_id: input.runId,
          page_number: run.page_count + 1,
          contract_version: input.contractVersion,
          requested_cursor: jsonInput(input.requestedCursor),
          requested_cursor_hash: input.requestedCursorHash,
          next_cursor: jsonInput(input.nextCursor),
          next_cursor_hash: input.nextCursorHash,
          continuation: input.continuation,
          response_digest: input.responseDigest,
          record_count: input.counts.records,
          catalog_record_count: input.counts.catalog,
          pull_record_count: input.counts.pulls,
          market_event_record_count: input.counts.marketEvents,
          accepted_count: input.counts.accepted,
          duplicate_count: input.counts.duplicate,
          quarantined_count: input.counts.quarantined,
          material_change_count: input.counts.materialChanges,
          committed_at: committedAt,
        },
      });
      const updated = await lockRun(transaction, input.runId);
      if (!updated) throw new Error("Committed provider run is unavailable.");
      return { kind: "committed" as const, run: toSummary(updated), pageId: input.pageId };
    }, TRANSACTION_OPTIONS);
  }

  async finish(input: {
    readonly runId: string;
    readonly workerId: string;
    readonly workerFence: bigint;
    readonly state: "succeeded" | "incomplete" | "failed";
    readonly failureCode: string | null;
    readonly failureClass: string | null;
    readonly failureSummary: string | null;
    readonly correlationId: string;
    readonly finishedAt: Date;
  }): Promise<FinishProviderRunResult> {
    requireUuid(input.runId, "runId");
    requireUuid(input.correlationId, "correlationId");
    requireSafeKey(input.workerId, "workerId");
    requireInstant(input.finishedAt, "finishedAt");
    if (input.state === "succeeded") {
      if (input.failureCode !== null || input.failureClass !== null || input.failureSummary !== null) {
        throw new TypeError("A successful provider run cannot carry failure evidence.");
      }
    } else if (
      input.failureCode === null
      || !safeFailurePattern.test(input.failureCode)
      || input.failureClass === null
      || !safeKeyPattern.test(input.failureClass)
      || input.failureSummary === null
      || input.failureSummary.trim().length < 1
      || input.failureSummary.length > 500
    ) throw new TypeError("Provider run failure evidence is invalid.");
    return this.database.$transaction(async (transaction) => {
      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: input.workerId,
        fence: input.workerFence
      })) return { kind: "lease_lost" as const };
      await setProviderImportLeaseContext(transaction, {
        owner: input.workerId,
        fence: input.workerFence,
      });
      const finishedAt = providerWorkerLeaseDatabaseNow(lease);
      const run = await lockRun(transaction, input.runId);
      if (!run) return { kind: "not_found" as const };
      if (["succeeded", "incomplete", "failed"].includes(run.state)) {
        return { kind: "already_terminal" as const, run: toSummary(run) };
      }
      if (run.worker_fence !== input.workerFence) return { kind: "lease_lost" as const };
      if (input.state === "succeeded" && !run.reached_source_head) {
        return { kind: "head_not_reached" as const };
      }
      const runtime = await lockRuntime(transaction);
      const targetState = input.state === "failed" ? "error" : "idle";
      const shouldTransition = runtime.operating_state === "running";
      const generation = runtime.state_generation + (shouldTransition ? 1n : 0n);
      if (shouldTransition) {
        await transaction.provider_state_events.create({
          data: {
            from_state: "running",
            to_state: targetState,
            state_generation: generation,
            reason: targetState === "error" ? input.failureCode : null,
            actor_type: "runner",
            actor_id: input.workerId,
            correlation_id: input.correlationId,
            occurred_at: finishedAt,
          },
        });
      }
      await transaction.provider_runs.update({
        where: { id: input.runId },
        data: {
          state: input.state,
          final_cursor: jsonInput(runtime.source_cursor as CanonicalJsonValue | null),
          final_cursor_hash: runtime.source_cursor_hash,
          failure_code: input.failureCode,
          failure_class: input.failureClass,
          failure_summary: input.failureSummary,
          heartbeat_at: finishedAt,
          last_progress_at: finishedAt,
          finished_at: finishedAt,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_runtime.update({
        where: { singleton_key: true },
        data: {
          ...(shouldTransition ? {
            operating_state: targetState,
            state_reason: targetState === "error" ? input.failureCode : null,
            state_generation: generation,
          } : {}),
          consecutive_failures: input.state === "succeeded"
            ? 0
            : runtime.consecutive_failures + 1,
          latest_failure_code: input.failureCode,
          last_attempted_at: finishedAt,
          next_due_at: runtime.schedule_seconds === null
            ? undefined
            : new Date(finishedAt.getTime() + runtime.schedule_seconds * 1_000),
          last_head_reached_at: input.state === "succeeded" && run.reached_source_head
            ? finishedAt
            : undefined,
          recovered_at: input.state === "succeeded" && runtime.consecutive_failures > 0
            ? finishedAt
            : runtime.recovered_at,
          last_runner_heartbeat_at: finishedAt,
          row_version: { increment: 1n },
        },
      });
      if (shouldTransition) {
        await appendProviderLocalAudit(transaction, {
          correlationId: input.correlationId,
          action: "provider.runtime.transition",
          targetType: "provider_runtime",
          targetId: runtime.central_provider_id,
          outcome: "success",
          details: {
            fromState: "running",
            toState: targetState,
            stateGeneration: generation.toString(),
          },
          occurredAt: finishedAt,
        });
        await appendProviderActivityOutbox(transaction, {
          eventType: "provider.runtime.transitioned",
          severity: targetState === "error" ? "critical" : "info",
          dedupeKey: `runtime:${generation}`,
          recoveryKey: "provider-runtime-state",
          title: "Provider runtime state changed",
          summary: `Provider runtime entered ${targetState}.`,
          evidence: { state: targetState, generation: generation.toString() },
          eventAt: finishedAt,
        });
      }
      await appendProviderLocalAudit(transaction, {
        correlationId: input.correlationId,
        action: "provider.run.terminal",
        targetType: "provider_run",
        targetId: input.runId,
        outcome: input.state === "succeeded" ? "success" : "failure",
        details: {
          runId: input.runId,
          resultCode: input.failureCode ?? "RUN_SUCCEEDED",
        },
        occurredAt: finishedAt,
      });
      await appendProviderActivityOutbox(transaction, {
        eventType: "provider.run.terminal",
        severity: input.state === "failed" ? "critical" : input.state === "incomplete" ? "warning" : "info",
        dedupeKey: `run:${input.runId}:terminal`,
        recoveryKey: `run:${input.runId}`,
        localRunId: input.runId,
        title: "Provider run finished",
        summary: `Provider run finished with ${input.state}.`,
        evidence: {
          runState: input.state,
          failureCode: input.failureCode,
        },
        eventAt: finishedAt,
      });
      const updated = await lockRun(transaction, input.runId);
      if (!updated) throw new Error("Finished provider run is unavailable.");
      return { kind: "finished" as const, run: toSummary(updated) };
    }, TRANSACTION_OPTIONS);
  }
}
