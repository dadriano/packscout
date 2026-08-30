import {
  providerRuntimeStateRequiresReason,
  providerRuntimeTransitionAllowed,
  type ProviderRuntimeState,
  type ProviderRuntimeTransitionActorType,
} from "@packscout/contracts";
import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  normalizeJsonObject,
  type CanonicalJsonObject,
} from "./provider-canonical-contract.ts";
import {
  appendProviderActivityOutbox,
  appendProviderLocalAudit,
} from "./provider-local-evidence.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const providerKeyPattern = /^[a-z][a-z0-9_]{0,52}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeActorPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const protectedConfigurationKeyPattern = /(?:authorization|bearer|credential|database[_-]?url|password|secret|(?:api|access|refresh|auth|bearer)[_-]?token|api[_-]?key)/i;
const maximumDatabaseBigint = 9_223_372_036_854_775_807n;

export interface ProviderCachedConfigurationSnapshot {
  readonly id: string;
  readonly version: bigint;
  readonly configuration: CanonicalJsonObject;
  readonly expiresAt: Date | null;
  readonly synchronizedAt: Date;
  readonly scheduleSeconds: number;
  readonly nextDueAt: Date | null;
}

export interface ProviderRuntimeLeaseSnapshot {
  readonly role: "import";
  readonly status: "unowned" | "active" | "expired";
  readonly fence: bigint;
  readonly expiresAt: Date | null;
}

export interface ProviderRuntimeSnapshot {
  readonly providerId: string;
  readonly providerKey: string;
  readonly state: ProviderRuntimeState;
  readonly reason: string | null;
  readonly generation: bigint;
  readonly rowVersion: bigint;
  readonly cachedConfiguration: ProviderCachedConfigurationSnapshot | null;
  readonly cursorFingerprint: string | null;
  readonly activeRunId: string | null;
  readonly latestRunId: string | null;
  readonly lease: ProviderRuntimeLeaseSnapshot;
  readonly freshness: string;
  readonly quality: string;
  readonly consecutiveFailures: number;
  readonly latestFailureCode: string | null;
  readonly lastAttemptedAt: Date | null;
  readonly lastHeadReachedAt: Date | null;
  readonly lastRunnerHeartbeatAt: Date | null;
  readonly recoveredAt: Date | null;
  readonly observedAt: Date;
}

export type ProviderConfigurationSyncResult =
  | { readonly kind: "updated" | "unchanged"; readonly runtime: ProviderRuntimeSnapshot }
  | { readonly kind: "identity_mismatch" | "version_conflict"; readonly runtime: ProviderRuntimeSnapshot };

export type ProviderRuntimeTransitionResult =
  | { readonly kind: "transitioned" | "unchanged"; readonly runtime: ProviderRuntimeSnapshot }
  | { readonly kind: "generation_conflict" | "invalid_transition"; readonly runtime: ProviderRuntimeSnapshot };

interface LockedRuntimeRow {
  readonly singleton_key: boolean;
  readonly central_provider_id: string;
  readonly provider_key: string;
  readonly operating_state: ProviderRuntimeState;
  readonly state_reason: string | null;
  readonly state_generation: bigint;
  readonly cached_config_version_id: string | null;
  readonly cached_config_version_number: bigint | null;
  readonly cached_configuration: ProviderPrisma.JsonValue | null;
  readonly config_expires_at: Date | null;
  readonly last_control_sync_at: Date | null;
  readonly schedule_seconds: number | null;
  readonly next_due_at: Date | null;
  readonly source_cursor_hash: string | null;
  readonly freshness_state: string;
  readonly quality_state: string;
  readonly consecutive_failures: number;
  readonly latest_failure_code: string | null;
  readonly last_attempted_at: Date | null;
  readonly last_head_reached_at: Date | null;
  readonly last_runner_heartbeat_at: Date | null;
  readonly recovered_at: Date | null;
  readonly row_version: bigint;
}

function requireInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} must be a valid instant.`);
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${field} must be a UUID.`);
  return value;
}

function normalizedReason(
  state: ProviderRuntimeState,
  reason: string | null,
): string | null {
  if (!providerRuntimeStateRequiresReason(state)) {
    if (reason !== null) throw new TypeError("An operating runtime state cannot carry a reason.");
    return null;
  }
  const normalized = reason?.trim() ?? "";
  if (normalized.length < 1 || normalized.length > 512) {
    throw new TypeError("A bounded runtime state reason is required.");
  }
  return normalized;
}

function normalizedConfiguration(input: CanonicalJsonObject): CanonicalJsonObject {
  const normalized = normalizeJsonObject(input, "configuration");
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (protectedConfigurationKeyPattern.test(key)) {
        throw new TypeError("Provider configuration cannot contain credentials.");
      }
      visit(child);
    }
  };
  visit(normalized);
  return normalized;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    const normalizedLeft = normalizeJsonObject(
      left as CanonicalJsonObject,
      "cachedConfiguration",
    );
    const normalizedRight = normalizeJsonObject(
      right as CanonicalJsonObject,
      "configuration",
    );
    return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
  } catch {
    return false;
  }
}

function cachedConfiguration(row: LockedRuntimeRow): ProviderCachedConfigurationSnapshot | null {
  if (
    row.cached_config_version_id === null
    || row.cached_config_version_number === null
    || row.cached_configuration === null
    || row.last_control_sync_at === null
    || row.schedule_seconds === null
  ) return null;
  return {
    id: row.cached_config_version_id,
    version: row.cached_config_version_number,
    configuration: row.cached_configuration as CanonicalJsonObject,
    expiresAt: row.config_expires_at,
    synchronizedAt: row.last_control_sync_at,
    scheduleSeconds: row.schedule_seconds,
    nextDueAt: row.next_due_at,
  };
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<LockedRuntimeRow> {
  const [row] = await transaction.$queryRaw<LockedRuntimeRow[]>(ProviderPrisma.sql`
    select singleton_key, central_provider_id, provider_key, operating_state,
           state_reason, state_generation, cached_config_version_id,
           cached_config_version_number, cached_configuration,
           config_expires_at, last_control_sync_at, schedule_seconds,
           next_due_at, source_cursor_hash, freshness_state, quality_state,
           consecutive_failures, latest_failure_code, last_attempted_at,
           last_head_reached_at, last_runner_heartbeat_at, recovered_at,
           row_version
    from provider_runtime
    where singleton_key = true
    for update
  `);
  if (!row) throw new Error("Provider runtime is not initialized.");
  return row;
}

async function projectSnapshot(
  transaction: ProviderTransactionClient,
  row: LockedRuntimeRow,
  observedAt: Date,
): Promise<ProviderRuntimeSnapshot> {
  const [lease, activeRun, latestRun] = await Promise.all([
    transaction.provider_worker_states.findUniqueOrThrow({
      where: { worker_role: "import" },
      select: { lease_owner: true, lease_fence: true, lease_expires_at: true },
    }),
    transaction.provider_runs.findFirst({
      where: { state: { in: ["queued", "running"] } },
      select: { id: true },
      orderBy: [{ requested_at: "asc" }, { id: "asc" }],
    }),
    transaction.provider_runs.findFirst({
      select: { id: true },
      orderBy: [{ requested_at: "desc" }, { id: "desc" }],
    }),
  ]);
  const leaseStatus = lease.lease_owner === null || lease.lease_expires_at === null
    ? "unowned"
    : lease.lease_expires_at <= observedAt
      ? "expired"
      : "active";
  return {
    providerId: row.central_provider_id,
    providerKey: row.provider_key,
    state: row.operating_state,
    reason: row.state_reason,
    generation: row.state_generation,
    rowVersion: row.row_version,
    cachedConfiguration: cachedConfiguration(row),
    cursorFingerprint: row.source_cursor_hash,
    activeRunId: activeRun?.id ?? null,
    latestRunId: latestRun?.id ?? null,
    lease: {
      role: "import",
      status: leaseStatus,
      fence: lease.lease_fence,
      expiresAt: lease.lease_expires_at,
    },
    freshness: row.freshness_state,
    quality: row.quality_state,
    consecutiveFailures: row.consecutive_failures,
    latestFailureCode: row.latest_failure_code,
    lastAttemptedAt: row.last_attempted_at,
    lastHeadReachedAt: row.last_head_reached_at,
    lastRunnerHeartbeatAt: row.last_runner_heartbeat_at,
    recoveredAt: row.recovered_at,
    observedAt,
  };
}

export class PrismaProviderRuntimeRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async snapshot(observedAt = new Date()): Promise<ProviderRuntimeSnapshot> {
    requireInstant(observedAt, "observedAt");
    return this.database.$transaction(async (transaction) => {
      const row = await lockRuntime(transaction);
      return projectSnapshot(transaction, row, observedAt);
    }, TRANSACTION_OPTIONS);
  }

  async synchronizeConfiguration(input: {
    readonly centralProviderId: string;
    readonly providerKey: string;
    readonly configVersionId: string;
    readonly configVersionNumber: bigint;
    readonly configuration: CanonicalJsonObject;
    readonly expiresAt: Date | null;
    readonly scheduleSeconds: number;
    readonly nextDueAt: Date | null;
    readonly synchronizedAt: Date;
  }): Promise<ProviderConfigurationSyncResult> {
    requireUuid(input.centralProviderId, "centralProviderId");
    requireUuid(input.configVersionId, "configVersionId");
    if (!providerKeyPattern.test(input.providerKey)) {
      throw new TypeError("providerKey is invalid.");
    }
    if (
      input.configVersionNumber < 1n
      || input.configVersionNumber > maximumDatabaseBigint
    ) {
      throw new TypeError("configVersionNumber must be positive.");
    }
    if (!Number.isInteger(input.scheduleSeconds) || input.scheduleSeconds < 60 || input.scheduleSeconds > 86_400) {
      throw new TypeError("scheduleSeconds is outside its safe bounds.");
    }
    requireInstant(input.synchronizedAt, "synchronizedAt");
    if (input.expiresAt !== null) requireInstant(input.expiresAt, "expiresAt");
    if (input.nextDueAt !== null) requireInstant(input.nextDueAt, "nextDueAt");
    const configuration = normalizedConfiguration(input.configuration);
    return this.database.$transaction(async (transaction) => {
      let row = await lockRuntime(transaction);
      if (
        row.central_provider_id !== input.centralProviderId
        || row.provider_key !== input.providerKey
      ) {
        return {
          kind: "identity_mismatch" as const,
          runtime: await projectSnapshot(transaction, row, input.synchronizedAt),
        };
      }
      if (row.cached_config_version_number !== null) {
        if (
          input.configVersionNumber !== row.cached_config_version_number
          && input.configVersionId === row.cached_config_version_id
        ) {
          return {
            kind: "version_conflict" as const,
            runtime: await projectSnapshot(transaction, row, input.synchronizedAt),
          };
        }
        if (input.configVersionNumber < row.cached_config_version_number) {
          return {
            kind: "version_conflict" as const,
            runtime: await projectSnapshot(transaction, row, input.synchronizedAt),
          };
        }
        if (input.configVersionNumber === row.cached_config_version_number) {
          // next_due_at is provider-local scheduling authority. A same-version
          // central refresh verifies immutable configuration identity without
          // trying to overwrite the locally advanced due time.
          const identical = row.cached_config_version_id === input.configVersionId
            && jsonEqual(row.cached_configuration, configuration)
            && row.config_expires_at?.getTime() === input.expiresAt?.getTime()
            && row.schedule_seconds === input.scheduleSeconds;
          return {
            kind: identical ? "unchanged" as const : "version_conflict" as const,
            runtime: await projectSnapshot(transaction, row, input.synchronizedAt),
          };
        }
      }
      const activeRun = await transaction.provider_runs.findFirst({
        where: { state: { in: ["queued", "running"] } },
        select: { id: true },
      });
      if (activeRun !== null) {
        return {
          kind: "version_conflict" as const,
          runtime: await projectSnapshot(transaction, row, input.synchronizedAt),
        };
      }
      const updated = await transaction.provider_runtime.updateMany({
        where: { singleton_key: true, row_version: row.row_version },
        data: {
          cached_config_version_id: input.configVersionId,
          cached_config_version_number: input.configVersionNumber,
          cached_configuration: configuration as ProviderPrisma.InputJsonValue,
          config_expires_at: input.expiresAt,
          last_control_sync_at: input.synchronizedAt,
          schedule_seconds: input.scheduleSeconds,
          next_due_at: input.nextDueAt,
          // Cursors are scoped to an immutable source configuration. Advancing
          // that authority always starts the new revision from its own head-
          // discovery boundary instead of reusing an incompatible checkpoint.
          source_cursor: ProviderPrisma.DbNull,
          source_cursor_hash: null,
          row_version: { increment: 1n },
          updated_at: input.synchronizedAt,
        },
      });
      if (updated.count !== 1) throw new Error("Provider runtime configuration changed concurrently.");
      row = await lockRuntime(transaction);
      return {
        kind: "updated" as const,
        runtime: await projectSnapshot(transaction, row, input.synchronizedAt),
      };
    }, TRANSACTION_OPTIONS);
  }

  async transition(input: {
    readonly expectedGeneration: bigint;
    readonly to: ProviderRuntimeState;
    readonly reason: string | null;
    readonly actorType: ProviderRuntimeTransitionActorType;
    readonly actorId: string;
    readonly actorOperatorId?: string | null;
    readonly correlationId: string;
    readonly occurredAt: Date;
  }): Promise<ProviderRuntimeTransitionResult> {
    if (input.actorType === "runner") {
      throw new TypeError(
        "Runner transitions require the fenced run start, finish, or recovery repository.",
      );
    }
    requireUuid(input.correlationId, "correlationId");
    requireInstant(input.occurredAt, "occurredAt");
    if (!safeActorPattern.test(input.actorId)) throw new TypeError("actorId is invalid.");
    if (input.actorOperatorId !== undefined && input.actorOperatorId !== null) {
      requireUuid(input.actorOperatorId, "actorOperatorId");
    }
    const reason = normalizedReason(input.to, input.reason);
    return this.database.$transaction(async (transaction) => {
      let row = await lockRuntime(transaction);
      if (row.state_generation !== input.expectedGeneration) {
        return {
          kind: "generation_conflict" as const,
          runtime: await projectSnapshot(transaction, row, input.occurredAt),
        };
      }
      if (row.operating_state === input.to) {
        return {
          kind: row.state_reason === reason ? "unchanged" as const : "invalid_transition" as const,
          runtime: await projectSnapshot(transaction, row, input.occurredAt),
        };
      }
      if (!providerRuntimeTransitionAllowed({
        from: row.operating_state,
        to: input.to,
        actorType: input.actorType,
      })) {
        return {
          kind: "invalid_transition" as const,
          runtime: await projectSnapshot(transaction, row, input.occurredAt),
        };
      }
      const nextGeneration = row.state_generation + 1n;
      await transaction.provider_state_events.create({
        data: {
          from_state: row.operating_state,
          to_state: input.to,
          state_generation: nextGeneration,
          reason,
          actor_type: input.actorType,
          actor_id: input.actorId,
          correlation_id: input.correlationId,
          occurred_at: input.occurredAt,
        },
      });
      const updated = await transaction.provider_runtime.updateMany({
        where: { singleton_key: true, row_version: row.row_version },
        data: {
          operating_state: input.to,
          state_reason: reason,
          state_generation: nextGeneration,
          row_version: { increment: 1n },
          updated_at: input.occurredAt,
        },
      });
      if (updated.count !== 1) throw new Error("Provider runtime changed concurrently.");
      await appendProviderLocalAudit(transaction, {
        actorOperatorId: input.actorOperatorId,
        correlationId: input.correlationId,
        action: "provider.runtime.transition",
        targetType: "provider_runtime",
        targetId: row.central_provider_id,
        outcome: "success",
        details: {
          fromState: row.operating_state,
          toState: input.to,
          stateGeneration: nextGeneration.toString(),
        },
        occurredAt: input.occurredAt,
      });
      await appendProviderActivityOutbox(transaction, {
        eventType: "provider.runtime.transitioned",
        severity: input.to === "error" || input.to === "stopped" ? "critical" : "info",
        dedupeKey: `runtime:${nextGeneration}`,
        recoveryKey: "provider-runtime-state",
        title: "Provider runtime state changed",
        summary: `Provider runtime entered ${input.to}.`,
        evidence: { state: input.to, generation: nextGeneration.toString() },
        eventAt: input.occurredAt,
      });
      row = await lockRuntime(transaction);
      return {
        kind: "transitioned" as const,
        runtime: await projectSnapshot(transaction, row, input.occurredAt),
      };
    }, TRANSACTION_OPTIONS);
  }
}
