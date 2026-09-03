import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import {
  PrismaProviderCommandRepository,
  type ProviderCommandOutcome,
} from "./provider-command-repository.ts";
import {
  appendProviderActivityOutbox,
  appendProviderLocalAudit,
} from "./provider-local-evidence.ts";
import { PrismaProviderRuntimeRepository } from "./provider-runtime-repository.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import type { ProviderRuntimeResumeGuard } from "./provider-runtime-resume-guard.ts";
import { lockProviderWorkerLease, providerWorkerLeaseIsLive } from "./provider-worker-lease-repository.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const COMMAND_GENERATION_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAXIMUM_DATABASE_BIGINT = 9_223_372_036_854_775_807n;

function requireCommandUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError("commandId must be a UUID.");
}

export type AdminLocalRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed";

export interface AdminLocalRunCursor {
  readonly requestedAt: Date;
  readonly runId: string;
}

export interface AdminLocalRunRecord {
  readonly id: string;
  readonly trigger: "scheduled" | "manual" | "recovery";
  readonly state: AdminLocalRunState;
  readonly requestedByOperatorId: string | null;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly workerFence: bigint;
  readonly attemptNumber: number;
  readonly recoveryOfRunId: string | null;
  readonly requestedCursorHash: string | null;
  readonly finalCursorHash: string | null;
  readonly reachedSourceHead: boolean;
  readonly pageCount: number;
  readonly catalogCount: number;
  readonly pullCount: number;
  readonly marketEventCount: number;
  readonly acceptedCount: number;
  readonly duplicateCount: number;
  readonly quarantinedCount: number;
  readonly materialChangeCount: number;
  readonly failureCode: string | null;
  readonly failureClass: string | null;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly lastProgressAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface AdminLocalRunPageRecord {
  readonly pageNumber: number;
  readonly continuation: "more" | "head";
  readonly committedAt: Date;
  readonly requestedCursorHash: string | null;
  readonly nextCursorHash: string | null;
  readonly responseDigest: string;
  readonly catalogCount: number;
  readonly pullCount: number;
  readonly marketEventCount: number;
  readonly acceptedCount: number;
  readonly duplicateCount: number;
  readonly quarantinedCount: number;
  readonly materialChangeCount: number;
}

export interface AdminLocalRunDetailRecord extends AdminLocalRunRecord {
  readonly pages: readonly AdminLocalRunPageRecord[];
  readonly relatedQuarantines: readonly {
    readonly id: string;
    readonly state: "open" | "resolved" | "expired";
    readonly recordKind: string;
    readonly recordIndex: number;
    readonly reasonCode: string;
  }[];
}

export interface AdminLocalProviderOverview {
  readonly runtimeState: "idle" | "running" | "paused" | "stopped" | "error";
  readonly runtimeReason: string | null;
  readonly runtimeGeneration: bigint;
  readonly nextDueAt: Date | null;
  readonly lastAttemptedAt: Date | null;
  readonly lastHeadReachedAt: Date | null;
  readonly lastRunnerHeartbeatAt: Date | null;
  readonly freshnessState: string;
  readonly qualityState: string;
  readonly consecutiveFailures: number;
  readonly latestFailureCode: string | null;
  readonly recoveredAt: Date | null;
  readonly activeRun: {
    readonly id: string;
    readonly state: "queued" | "running";
  } | null;
  readonly latestRun: Pick<AdminLocalRunRecord, "id" | "state" | "finishedAt"> | null;
  readonly openQuarantineCount: number;
  readonly latestQuarantineReasonCode: string | null;
  readonly latestRetention: {
    readonly state: "running" | "succeeded" | "failed";
    readonly startedAt: Date;
    readonly failureCode: string | null;
  } | null;
}

export interface AdminRuntimeCommandRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly commandType: "run" | "pause" | "resume" | "stop" | "retry_run" | "retry_quarantine";
  readonly state: "pending" | "accepted" | "rejected" | "completed" | "failed";
  readonly targetRunId: string | null;
  readonly targetQuarantineId: string | null;
  readonly expectedGeneration: bigint;
  readonly requestedByOperatorId: string;
  readonly correlationId: string;
  readonly reason: string | null;
  readonly result: Readonly<{ outcome: ProviderCommandOutcome; code: string; generation: string }> | null;
  readonly resultingRunId: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
}

export type AdminRunNowPersistenceResult =
  | {
      readonly kind: "created" | "deduplicated";
      readonly run: AdminLocalRunRecord;
      readonly commandId: string;
      readonly correlationId: string;
    }
  | {
      readonly kind:
        | "idempotency_conflict"
        | "generation_conflict"
        | "configuration_conflict"
        | "configuration_expired"
        | "cursor_conflict"
        | "active_run_conflict"
        | "runtime_unavailable";
      readonly generation: bigint;
      readonly runtimeState: "idle" | "running" | "paused" | "stopped" | "error";
      readonly correlationId: string;
    };

interface LockedRuntime {
  readonly central_provider_id: string;
  readonly operating_state: "idle" | "running" | "paused" | "stopped" | "error";
  readonly state_generation: bigint;
  readonly cached_config_version_id: string | null;
  readonly cached_config_version_number: bigint | null;
  readonly config_expires_at: Date | null;
  readonly source_cursor: ProviderPrisma.JsonValue | null;
  readonly source_cursor_hash: string | null;
}

const runSelection = ProviderPrisma.validator<ProviderPrisma.provider_runsSelect>()({
  id: true,
  trigger: true,
  state: true,
  requested_by_operator_id: true,
  config_version_id: true,
  config_version_number: true,
  worker_fence: true,
  attempt_number: true,
  recovery_of_run_id: true,
  requested_cursor_hash: true,
  final_cursor_hash: true,
  reached_source_head: true,
  page_count: true,
  catalog_record_count: true,
  pull_record_count: true,
  market_event_record_count: true,
  accepted_count: true,
  duplicate_count: true,
  quarantined_count: true,
  material_change_count: true,
  failure_code: true,
  failure_class: true,
  requested_at: true,
  started_at: true,
  last_progress_at: true,
  heartbeat_at: true,
  finished_at: true,
});

type RunRow = ProviderPrisma.provider_runsGetPayload<{ select: typeof runSelection }>;

function runRecord(row: RunRow): AdminLocalRunRecord {
  return {
    id: row.id,
    trigger: row.trigger,
    state: row.state,
    requestedByOperatorId: row.requested_by_operator_id,
    configVersionId: row.config_version_id,
    configVersionNumber: row.config_version_number,
    workerFence: row.worker_fence,
    attemptNumber: row.attempt_number,
    recoveryOfRunId: row.recovery_of_run_id,
    requestedCursorHash: row.requested_cursor_hash,
    finalCursorHash: row.final_cursor_hash,
    reachedSourceHead: row.reached_source_head,
    pageCount: row.page_count,
    catalogCount: row.catalog_record_count,
    pullCount: row.pull_record_count,
    marketEventCount: row.market_event_record_count,
    acceptedCount: row.accepted_count,
    duplicateCount: row.duplicate_count,
    quarantinedCount: row.quarantined_count,
    materialChangeCount: row.material_change_count,
    failureCode: row.failure_code,
    failureClass: row.failure_class,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    lastProgressAt: row.last_progress_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
  };
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<LockedRuntime> {
  const [runtime] = await transaction.$queryRaw<LockedRuntime[]>(ProviderPrisma.sql`
    select central_provider_id, operating_state, state_generation,
           cached_config_version_id, cached_config_version_number,
           config_expires_at, source_cursor, source_cursor_hash
    from provider_runtime where singleton_key = true for update
  `);
  if (!runtime) throw new Error("Provider runtime is not initialized.");
  return runtime;
}

function inputJson(value: ProviderPrisma.JsonValue | null) {
  return value === null
    ? ProviderPrisma.DbNull
    : value as ProviderPrisma.InputJsonValue;
}

function safeRunRequestMatches(input: {
  readonly command: {
    readonly command_type: string;
    readonly expected_generation: bigint;
    readonly requested_by_operator_id: string;
    readonly reason: string | null;
    readonly resulting_run_id: string | null;
  };
  readonly run: RunRow | null;
  readonly operatorId: string;
  readonly expectedGeneration: bigint;
  readonly expectedConfigVersionId: string;
  readonly expectedConfigVersionNumber: bigint;
}): input is typeof input & { readonly run: RunRow } {
  return input.command.command_type === "run"
    && input.command.expected_generation === input.expectedGeneration
    && input.command.requested_by_operator_id === input.operatorId
    && input.command.reason === null
    && input.command.resulting_run_id !== null
    && input.run !== null
    && input.run.id === input.command.resulting_run_id
    && input.run.config_version_id === input.expectedConfigVersionId
    && input.run.config_version_number === input.expectedConfigVersionNumber;
}

export class PrismaAdminProviderRuntimeRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async overview(): Promise<AdminLocalProviderOverview> {
    const [runtime, activeRun, latestRun, openCount, latestQuarantine, retention] =
      await Promise.all([
        new PrismaProviderRuntimeRepository(this.database).snapshot(),
        this.database.provider_runs.findFirst({
          where: { state: { in: ["queued", "running"] } },
          select: runSelection,
          orderBy: [{ requested_at: "asc" }, { id: "asc" }],
        }),
        this.database.provider_runs.findFirst({
          select: runSelection,
          orderBy: [{ requested_at: "desc" }, { id: "desc" }],
        }),
        this.database.quarantine_records.count({ where: { state: "open" } }),
        this.database.quarantine_records.findFirst({
          where: { state: "open" },
          select: { reason_code: true },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        }),
        this.database.retention_executions.findFirst({
          select: { state: true, started_at: true, failure_code: true },
          orderBy: [{ started_at: "desc" }, { id: "desc" }],
        }),
      ]);
    return {
      runtimeState: runtime.state,
      runtimeReason: runtime.reason,
      runtimeGeneration: runtime.generation,
      nextDueAt: runtime.cachedConfiguration?.nextDueAt ?? null,
      lastAttemptedAt: runtime.lastAttemptedAt,
      lastHeadReachedAt: runtime.lastHeadReachedAt,
      lastRunnerHeartbeatAt: runtime.lastRunnerHeartbeatAt,
      freshnessState: runtime.freshness,
      qualityState: runtime.quality,
      consecutiveFailures: runtime.consecutiveFailures,
      latestFailureCode: runtime.latestFailureCode,
      recoveredAt: runtime.recoveredAt,
      activeRun: activeRun
        ? { id: activeRun.id, state: activeRun.state as "queued" | "running" }
        : null,
      latestRun: latestRun
        ? {
            id: latestRun.id,
            state: latestRun.state,
            finishedAt: latestRun.finished_at,
          }
        : null,
      openQuarantineCount: openCount,
      latestQuarantineReasonCode: latestQuarantine?.reason_code ?? null,
      latestRetention: retention
        ? {
            state: retention.state,
            startedAt: retention.started_at,
            failureCode: retention.failure_code,
          }
        : null,
    };
  }

  async listRuns(input: {
    readonly snapshotAt: Date;
    readonly before?: AdminLocalRunCursor;
    readonly limit: number;
    readonly state?: AdminLocalRunState;
    readonly trigger?: "scheduled" | "manual" | "recovery";
  }): Promise<{ readonly items: readonly AdminLocalRunRecord[]; readonly hasMore: boolean }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new RangeError("Provider run page limit is invalid.");
    }
    const rows = await this.database.provider_runs.findMany({
      where: {
        requested_at: { lte: input.snapshotAt },
        ...(input.state ? { state: input.state } : {}),
        ...(input.trigger ? { trigger: input.trigger } : {}),
        ...(input.before
          ? {
              OR: [
                { requested_at: { lt: input.before.requestedAt } },
                {
                  requested_at: input.before.requestedAt,
                  id: { gt: input.before.runId },
                },
              ],
            }
          : {}),
      },
      select: runSelection,
      orderBy: [{ requested_at: "desc" }, { id: "asc" }],
      take: input.limit + 1,
    });
    return {
      items: rows.slice(0, input.limit).map(runRecord),
      hasMore: rows.length > input.limit,
    };
  }

  async getRun(runId: string): Promise<AdminLocalRunDetailRecord | null> {
    const run = await this.database.provider_runs.findUnique({
      where: { id: runId },
      select: runSelection,
    });
    if (!run) return null;
    const [pages, quarantines] = await Promise.all([
      this.database.provider_run_pages.findMany({
        where: { provider_run_id: runId },
        select: {
          page_number: true,
          continuation: true,
          committed_at: true,
          requested_cursor_hash: true,
          next_cursor_hash: true,
          response_digest: true,
          catalog_record_count: true,
          pull_record_count: true,
          market_event_record_count: true,
          accepted_count: true,
          duplicate_count: true,
          quarantined_count: true,
          material_change_count: true,
        },
        orderBy: { page_number: "asc" },
        take: 100,
      }),
      this.database.quarantine_records.findMany({
        where: { provider_run_id: runId },
        select: {
          id: true,
          state: true,
          record_kind: true,
          record_index: true,
          reason_code: true,
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: 100,
      }),
    ]);
    return {
      ...runRecord(run),
      pages: pages.map((page) => ({
        pageNumber: page.page_number,
        continuation: page.continuation,
        committedAt: page.committed_at,
        requestedCursorHash: page.requested_cursor_hash,
        nextCursorHash: page.next_cursor_hash,
        responseDigest: page.response_digest,
        catalogCount: page.catalog_record_count,
        pullCount: page.pull_record_count,
        marketEventCount: page.market_event_record_count,
        acceptedCount: page.accepted_count,
        duplicateCount: page.duplicate_count,
        quarantinedCount: page.quarantined_count,
        materialChangeCount: page.material_change_count,
      })),
      relatedQuarantines: quarantines.map((entry) => ({
        id: entry.id,
        state: entry.state,
        recordKind: entry.record_kind,
        recordIndex: entry.record_index,
        reasonCode: entry.reason_code,
      })),
    };
  }

  async getRuntimeCommand(commandId: string): Promise<AdminRuntimeCommandRecord | null> {
    requireCommandUuid(commandId);
    const row = await this.database.control_commands.findUnique({ where: { id: commandId } });
    if (!row) return null;
    const stored = typeof row.result === "object" && row.result !== null && !Array.isArray(row.result)
      ? row.result as Record<string, unknown> : null;
    const outcome = stored?.outcome;
    const code = stored?.code;
    const generation = stored?.generation;
    const result = typeof outcome === "string" &&
      ["accepted", "deduplicated", "conflict", "forbidden", "failed"].includes(outcome) &&
      typeof code === "string" && COMMAND_CODE_PATTERN.test(code) &&
      typeof generation === "string" && COMMAND_GENERATION_PATTERN.test(generation) &&
      BigInt(generation) <= MAXIMUM_DATABASE_BIGINT
      ? Object.freeze({ outcome: outcome as ProviderCommandOutcome, code, generation }) : null;
    return Object.freeze({ id: row.id, idempotencyKey: row.idempotency_key, commandType: row.command_type,
      state: row.state, targetRunId: row.target_run_id, targetQuarantineId: row.target_quarantine_id,
      expectedGeneration: row.expected_generation, requestedByOperatorId: row.requested_by_operator_id,
      correlationId: row.correlation_id, reason: row.reason, result, resultingRunId: row.resulting_run_id,
      requestedAt: row.requested_at, completedAt: row.completed_at });
  }

  async requestRunNow(input: {
    readonly providerId: string;
    readonly operatorId: string;
    readonly expectedConfigVersionId: string;
    readonly expectedConfigVersionNumber: bigint;
    readonly expectedGeneration: bigint;
    readonly idempotencyKey: string;
    readonly commandId: string;
    readonly runId: string;
    readonly correlationId: string;
    /** Recovery callers pin the saved checkpoint; ordinary UI callers may omit it. */
    readonly expectedCursorFingerprint?: string | null;
    readonly requireNoActiveRun?: boolean;
    /** Optional recovery authority, checked atomically with a new queue write. */
    readonly expectedImportLease?: { readonly owner: string; readonly fence: bigint };
    /** Optional caller admission bound; requires a fenced lease and a full transaction budget. */
    readonly notAfter?: Date;
  }): Promise<AdminRunNowPersistenceResult> {
    return this.database.$transaction(async (transaction) => {
      // Match worker lock ordering. The lease lock spans the runtime checks
      // and queue write, closing expiry/foreign-owner gaps after preflight.
      const importLease = input.expectedImportLease === undefined ? null
        : await lockProviderWorkerLease(transaction, "import");
      const runtime = await lockRuntime(transaction);
      const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
        select clock_timestamp() as now
      `;
      if (!clock) throw new Error("Provider database clock is unavailable.");
      const conflict = (
        kind: Extract<AdminRunNowPersistenceResult, { generation: bigint }>["kind"],
      ): AdminRunNowPersistenceResult => ({
        kind,
        generation: runtime.state_generation,
        runtimeState: runtime.operating_state,
        correlationId: input.correlationId,
      });
      if (runtime.central_provider_id !== input.providerId) {
        return conflict("configuration_conflict");
      }
      const existingCommand = await transaction.control_commands.findUnique({
        where: { idempotency_key: input.idempotencyKey },
        select: {
          id: true,
          command_type: true,
          expected_generation: true,
          requested_by_operator_id: true,
          reason: true,
          resulting_run_id: true,
          correlation_id: true,
        },
      });
      if (existingCommand) {
        const existingRun = existingCommand.resulting_run_id
          ? await transaction.provider_runs.findUnique({
              where: { id: existingCommand.resulting_run_id },
              select: runSelection,
            })
          : null;
        const replay = {
          command: existingCommand,
          run: existingRun,
          operatorId: input.operatorId,
          expectedGeneration: input.expectedGeneration,
          expectedConfigVersionId: input.expectedConfigVersionId,
          expectedConfigVersionNumber: input.expectedConfigVersionNumber,
        };
        if (!safeRunRequestMatches(replay)) return conflict("idempotency_conflict");
        if (input.expectedCursorFingerprint !== undefined
          && replay.run.requested_cursor_hash !== input.expectedCursorFingerprint) {
          return conflict("cursor_conflict");
        }
        return {
          kind: "deduplicated",
          run: runRecord(replay.run),
          commandId: existingCommand.id,
          correlationId: existingCommand.correlation_id,
        };
      }
      if (input.expectedImportLease !== undefined && (importLease === null
        || !providerWorkerLeaseIsLive({ ...importLease, database_now: clock.now }, input.expectedImportLease))) {
        return conflict("runtime_unavailable");
      }
      if (runtime.state_generation !== input.expectedGeneration) {
        return conflict("generation_conflict");
      }
      if (
        runtime.cached_config_version_id !== input.expectedConfigVersionId
        || runtime.cached_config_version_number !== input.expectedConfigVersionNumber
      ) return conflict("configuration_conflict");
      if (runtime.config_expires_at !== null && runtime.config_expires_at <= clock.now) {
        return conflict("configuration_expired");
      }
      if (input.expectedCursorFingerprint !== undefined && (
        runtime.source_cursor_hash !== input.expectedCursorFingerprint
        || (runtime.source_cursor === null ? null : providerMixedPageDigest(runtime.source_cursor)) !== input.expectedCursorFingerprint
      )) return conflict("cursor_conflict");
      if (runtime.operating_state !== "idle" && runtime.operating_state !== "running") {
        return conflict("runtime_unavailable");
      }
      const [active] = await transaction.$queryRaw<Array<{ id: string }>>(ProviderPrisma.sql`
        select id from provider_runs
        where state in ('queued', 'running')
        order by requested_at, id
        for update
        limit 1
      `);
      if (active && input.requireNoActiveRun) return conflict("active_run_conflict");
      if (input.notAfter !== undefined) {
        const [admission] = await transaction.$queryRaw<Array<{ now: Date }>>`select clock_timestamp() as now`;
        if (!(input.notAfter instanceof Date) || !Number.isFinite(input.notAfter.getTime()) || !admission ||
          input.notAfter.getTime() - admission.now.getTime() < TRANSACTION_OPTIONS.timeout ||
          !importLease?.lease_expires_at || importLease.lease_expires_at.getTime() - admission.now.getTime() < TRANSACTION_OPTIONS.timeout) {
          return conflict("runtime_unavailable");
        }
      }
      await transaction.control_commands.create({
        data: {
          id: input.commandId,
          idempotency_key: input.idempotencyKey,
          command_type: "run",
          expected_generation: input.expectedGeneration,
          requested_by_operator_id: input.operatorId,
          correlation_id: input.correlationId,
          requested_at: clock.now,
        },
      });
      let run: RunRow;
      if (active) {
        const existingRun = await transaction.provider_runs.findUniqueOrThrow({
          where: { id: active.id },
          select: runSelection,
        });
        await transaction.control_commands.update({
          where: { id: input.commandId },
          data: {
            state: "completed",
            result: {
              outcome: "accepted",
              code: "RUN_ALREADY_ACTIVE",
              generation: runtime.state_generation.toString(),
            },
            resulting_run_id: active.id,
            acknowledged_at: clock.now,
            completed_at: clock.now,
            row_version: { increment: 1n },
          },
        });
        run = existingRun;
      } else {
        await transaction.provider_runs.create({
          data: {
            id: input.runId,
            control_command_id: input.commandId,
            idempotency_key: `command/${input.commandId}`,
            trigger: "manual",
            state: "queued",
            requested_by_operator_id: input.operatorId,
            config_version_id: input.expectedConfigVersionId,
            config_version_number: input.expectedConfigVersionNumber,
            worker_fence: 0n,
            requested_cursor: inputJson(runtime.source_cursor),
            requested_cursor_hash: runtime.source_cursor_hash,
            requested_at: clock.now,
          },
        });
        await transaction.control_commands.update({
          where: { id: input.commandId },
          data: {
            state: "accepted",
            result: {
              outcome: "accepted",
              code: "COMMAND_ACCEPTED",
              generation: runtime.state_generation.toString(),
            },
            resulting_run_id: input.runId,
            acknowledged_at: clock.now,
            row_version: { increment: 1n },
          },
        });
        run = await transaction.provider_runs.findUniqueOrThrow({
          where: { id: input.runId },
          select: runSelection,
        });
      }
      await appendProviderLocalAudit(transaction, {
        commandId: input.commandId,
        actorOperatorId: input.operatorId,
        correlationId: input.correlationId,
        action: "provider.run.requested",
        targetType: "provider_run",
        targetId: run.id,
        outcome: "success",
        details: {
          commandType: "run",
          resultCode: active ? "RUN_ALREADY_ACTIVE" : "RUN_QUEUED",
          runId: run.id,
          stateGeneration: runtime.state_generation.toString(),
        },
        occurredAt: clock.now,
      });
      await appendProviderActivityOutbox(transaction, {
        eventType: "provider.run.requested",
        severity: "info",
        dedupeKey: `command:${input.commandId}:requested`,
        recoveryKey: `run:${run.id}`,
        localRunId: run.id,
        title: "Provider run requested",
        summary: active
          ? "Provider run request joined active work."
          : "Provider mixed run is queued.",
        evidence: { runState: run.state },
        eventAt: clock.now,
      });
      return {
        kind: active ? "deduplicated" : "created",
        run: runRecord(run),
        commandId: input.commandId,
        correlationId: input.correlationId,
      };
    }, TRANSACTION_OPTIONS);
  }

  async submitRuntimeCommand(input: {
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly commandType: "pause" | "resume" | "stop";
    readonly expectedGeneration: bigint;
    readonly requestedByOperatorId: string;
    readonly correlationId: string;
    readonly reason: string | null;
    readonly requestedAt: Date;
    readonly expectedRuntimeGuard?: ProviderRuntimeResumeGuard;
  }): Promise<{
    readonly commandId: string;
    readonly outcome: ProviderCommandOutcome;
    readonly code: string;
    readonly state: "idle" | "running" | "paused" | "stopped" | "error";
    readonly reason: string | null;
    readonly generation: bigint;
  }> {
    const result = await new PrismaProviderCommandRepository(this.database).submit({
      ...input,
      targetRunId: null,
      targetQuarantineId: null,
    });
    const runtime = await new PrismaProviderRuntimeRepository(this.database).snapshot();
    return {
      commandId: result.commandId,
      outcome: result.outcome,
      code: result.code,
      state: runtime.state,
      reason: runtime.reason,
      generation: runtime.generation,
    };
  }
}
