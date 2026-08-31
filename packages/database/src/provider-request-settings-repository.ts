import { randomUUID } from "node:crypto";
import { validateProviderSourceRecordsPerRequest } from "@packscout/contracts";
import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import { appendProviderLocalAudit } from "./provider-local-evidence.ts";
import { lockProviderWorkerLease } from "./provider-worker-lease-repository.ts";
import { requestSettingsInitializationAdmitted, validateRequestSettingsInitializationBoundary,
  assertRequestSettingsInitializationDeadline, ProviderRequestSettingsInitializationExpired,
  type ProviderRequestSettingsInitializationBoundary } from "./provider-request-settings-initialization.ts";
export type { ProviderRequestSettingsInitializationBoundary } from "./provider-request-settings-initialization.ts";
import { assertProviderRequestSettingsWriteDeadline, ProviderRequestSettingsWriteExpired } from "./provider-request-settings-deadline.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000, timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const adapterPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface ProviderRequestSettingsRevision {
  readonly id: string;
  readonly revisionNumber: bigint;
  readonly recordsPerRequest: number;
  readonly origin: "operator" | "adapter_default";
  /** Creation provenance only; a later source configuration does not reset this setting. */
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly adapterKey: string;
  readonly createdByOperatorId: string | null;
  readonly createdAt: Date;
}

export interface ProviderRequestSettingsDefault {
  readonly recordsPerRequest: number;
  readonly adapterKey: string;
}
export type ProviderRequestSettingsPolicy = "required" | "unmanaged";

export type ReviseProviderRequestSettingsResult = {
  readonly kind: "updated" | "unchanged";
  readonly revision: ProviderRequestSettingsRevision;
} | {
  readonly kind: "revision_conflict" | "configuration_conflict" | "identity_mismatch" | "configuration_expired" | "initialization_requires_handoff" | "write_deadline_expired";
};

interface RuntimeAuthority {
  readonly provider_id: string;
  readonly central_provider_id: string;
  readonly cached_config_version_id: string | null;
  readonly cached_config_version_number: bigint | null;
  readonly adapter_key: string | null;
  readonly config_expires_at: Date | null;
  readonly database_now: Date;
}

function requireUuid(value: string): void {
  if (!uuidPattern.test(value)) throw new TypeError("Provider request settings identity is invalid.");
}

function validateAuthorityInput(input: {
  providerId: string; configVersionId: string; configVersionNumber: bigint; adapterKey: string;
}): void {
  requireUuid(input.providerId); requireUuid(input.configVersionId);
  if (typeof input.configVersionNumber !== "bigint" || input.configVersionNumber < 1n
    || !adapterPattern.test(input.adapterKey)) {
    throw new TypeError("Provider request settings authority is invalid.");
  }
}

async function lockAuthority(transaction: ProviderTransactionClient): Promise<RuntimeAuthority> {
  const [row] = await transaction.$queryRaw<RuntimeAuthority[]>(ProviderPrisma.sql`
    select identity.provider_id, runtime.central_provider_id,
      runtime.cached_config_version_id, runtime.cached_config_version_number,
      runtime.cached_configuration->>'adapterKey' as adapter_key,
      runtime.config_expires_at, clock_timestamp() as database_now
    from provider_runtime runtime join database_identity identity on identity.singleton_key = runtime.singleton_key
    where runtime.singleton_key = true for update of runtime
  `);
  if (!row) throw new Error("Provider request settings runtime is unavailable.");
  // A SELECT target expression can be evaluated before its row-lock wait.
  // Refresh the clock after the lock is actually held for expiry admission.
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(ProviderPrisma.sql`select clock_timestamp() as now`);
  if (!clock) throw new Error("Provider request settings database clock is unavailable.");
  return { ...row, database_now: clock.now };
}

function authorityFailure(row: RuntimeAuthority, input: {
  providerId: string; configVersionId: string; configVersionNumber: bigint; adapterKey: string;
}): "identity_mismatch" | "configuration_conflict" | "configuration_expired" | null {
  if (row.provider_id !== input.providerId || row.central_provider_id !== input.providerId) return "identity_mismatch";
  if (row.cached_config_version_id !== input.configVersionId
    || row.cached_config_version_number !== input.configVersionNumber
    || row.adapter_key !== input.adapterKey) return "configuration_conflict";
  if (row.config_expires_at !== null && row.config_expires_at <= row.database_now) return "configuration_expired";
  return null;
}

type RevisionRow = ProviderPrisma.provider_request_settings_revisionsGetPayload<Record<string, never>>;

function revision(row: RevisionRow): ProviderRequestSettingsRevision {
  if (row.origin !== "operator" && row.origin !== "adapter_default") {
    throw new Error("Provider request settings origin is invalid.");
  }
  return {
    id: row.id, revisionNumber: row.revision_number, recordsPerRequest: row.records_per_request,
    origin: row.origin, configVersionId: row.config_version_id, configVersionNumber: row.config_version_number,
    adapterKey: row.adapter_key, createdByOperatorId: row.created_by_operator_id, createdAt: row.created_at,
  };
}

async function currentRevision(transaction: ProviderTransactionClient): Promise<ProviderRequestSettingsRevision | null> {
  const pointer = await transaction.provider_request_settings.findUnique({
    where: { singleton_key: true }, include: { active_revision: true },
  });
  return pointer === null ? null : revision(pointer.active_revision);
}

async function writeRevision(transaction: ProviderTransactionClient, input: {
  readonly prior: ProviderRequestSettingsRevision | null;
  readonly recordsPerRequest: number;
  readonly origin: "operator" | "adapter_default";
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly adapterKey: string;
  readonly actorOperatorId: string | null;
  readonly correlationId: string;
  readonly at: Date;
}): Promise<ProviderRequestSettingsRevision> {
  const next = await transaction.provider_request_settings_revisions.create({ data: {
    id: randomUUID(), revision_number: (input.prior?.revisionNumber ?? 0n) + 1n,
    records_per_request: input.recordsPerRequest, origin: input.origin,
    config_version_id: input.configVersionId, config_version_number: input.configVersionNumber,
    adapter_key: input.adapterKey, created_by_operator_id: input.actorOperatorId, created_at: input.at,
  } });
  if (input.prior === null) {
    await transaction.provider_request_settings.create({ data: { active_revision_id: next.id } });
  } else {
    await transaction.provider_request_settings.update({
      where: { singleton_key: true }, data: { active_revision_id: next.id },
    });
  }
  await appendProviderLocalAudit(transaction, {
    actorOperatorId: input.actorOperatorId, correlationId: input.correlationId,
    action: "provider.request_settings.revised", targetType: "provider_request_settings_revision",
    targetId: next.id, outcome: "success",
    details: { recordsPerRequest: input.recordsPerRequest, requestSettingsOrigin: input.origin,
      requestSettingsRevision: next.revision_number.toString() }, occurredAt: input.at,
  });
  return revision(next);
}

/** Called inside the queue/start transaction, after its runtime authority lock. */
export async function pinProviderRequestSettings(transaction: ProviderTransactionClient, input: {
  readonly providerId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly correlationId: string;
  readonly actorOperatorId: string | null;
  readonly requestSettingsDefault?: ProviderRequestSettingsDefault;
  readonly requestSettingsPolicy?: ProviderRequestSettingsPolicy;
}): Promise<ProviderRequestSettingsRevision | { readonly id: null; readonly recordsPerRequest: null } | null> {
  const current = await currentRevision(transaction);
  if (input.requestSettingsPolicy === "unmanaged") return current === null ? { id: null, recordsPerRequest: null } : null;
  if (current !== null) return current;
  if (input.requestSettingsDefault === undefined) return null;
  const authority = { ...input, adapterKey: input.requestSettingsDefault.adapterKey };
  validateAuthorityInput(authority);
  const count = validateProviderSourceRecordsPerRequest(input.requestSettingsDefault.recordsPerRequest);
  const runtime = await lockAuthority(transaction);
  if (authorityFailure(runtime, authority) !== null) return null;
  return writeRevision(transaction, {
    prior: null, recordsPerRequest: count, origin: "adapter_default", ...authority,
    at: runtime.database_now,
  });
}

export class PrismaProviderRequestSettingsRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async current(input: { readonly providerId: string }): Promise<ProviderRequestSettingsRevision | null> {
    requireUuid(input.providerId);
    return this.database.$transaction(async (transaction) => {
      const identity = await transaction.database_identity.findUnique({ where: { singleton_key: true } });
      const runtime = await transaction.provider_runtime.findUnique({
        where: { singleton_key: true }, select: { central_provider_id: true },
      });
      if (identity?.provider_id !== input.providerId || runtime?.central_provider_id !== input.providerId) {
        throw new Error("Provider request settings identity mismatch.");
      }
      return currentRevision(transaction);
    }, TRANSACTION_OPTIONS);
  }

  async revise(input: {
    readonly providerId: string;
    readonly expectedRevisionId: string | null;
    readonly recordsPerRequest: number;
    readonly actorOperatorId: string;
    readonly correlationId: string;
    readonly expectedConfigVersionId: string;
    readonly expectedConfigVersionNumber: bigint;
    readonly adapterKey: string;
    readonly initializationBoundary?: ProviderRequestSettingsInitializationBoundary;
    readonly writeDeadline?: Date;
  }): Promise<ReviseProviderRequestSettingsResult> {
    const authority = { providerId: input.providerId, configVersionId: input.expectedConfigVersionId,
      configVersionNumber: input.expectedConfigVersionNumber, adapterKey: input.adapterKey };
    validateAuthorityInput(authority);
    requireUuid(input.actorOperatorId); requireUuid(input.correlationId);
    if (input.expectedRevisionId !== null) requireUuid(input.expectedRevisionId);
    if (input.initializationBoundary !== undefined) {
      if (input.expectedRevisionId !== null) throw new TypeError("Initialization boundary requires absent settings.");
      validateRequestSettingsInitializationBoundary(input.initializationBoundary);
    }
    const count = validateProviderSourceRecordsPerRequest(input.recordsPerRequest);
    if (input.writeDeadline !== undefined && (!(input.writeDeadline instanceof Date) || !Number.isFinite(input.writeDeadline.getTime()))) {
      throw new TypeError("Provider request settings write deadline is invalid.");
    }
    const remaining = input.writeDeadline === undefined ? TRANSACTION_OPTIONS.timeout : Math.floor(input.writeDeadline.getTime() - Date.now());
    if (remaining <= 0) return { kind: "write_deadline_expired" };
    return this.database.$transaction<ReviseProviderRequestSettingsResult>(async (transaction) => {
      // Shared with queue/start: runtime first, settings second. Never write runtime.
      // First explicit initialization additionally locks the import lease first;
      // an old frozen writer must be drained before this one-time policy cutover.
      const lease = input.expectedRevisionId === null ? await lockProviderWorkerLease(transaction, "import") : null;
      const promotionLease = input.expectedRevisionId === null ? await lockProviderWorkerLease(transaction, "promotion") : null;
      const runtime = await lockAuthority(transaction);
      await assertProviderRequestSettingsWriteDeadline(transaction, input.writeDeadline);
      const failure = authorityFailure(runtime, authority);
      if (failure !== null) return { kind: failure };
      const prior = await currentRevision(transaction);
      if ((prior?.id ?? null) !== input.expectedRevisionId) return { kind: "revision_conflict" };
      if (prior === null && (lease?.lease_owner !== null || promotionLease?.lease_owner !== null || await transaction.provider_runs.count({
        where: { state: { in: ["queued", "running"] } },
      }) > 0)) return { kind: "initialization_requires_handoff" };
      if (input.initializationBoundary !== undefined && !await requestSettingsInitializationAdmitted(transaction, {
        configVersionId: input.expectedConfigVersionId, configVersionNumber: input.expectedConfigVersionNumber,
        boundary: input.initializationBoundary, importFence: lease!.lease_fence,
      })) return { kind: "initialization_requires_handoff" };
      if (prior?.recordsPerRequest === count) return { kind: "unchanged", revision: prior };
      await assertProviderRequestSettingsWriteDeadline(transaction, input.writeDeadline);
      const next = await writeRevision(transaction, {
        prior, recordsPerRequest: count, origin: "operator", ...authority,
        actorOperatorId: input.actorOperatorId, correlationId: input.correlationId, at: runtime.database_now,
      });
      if (input.initializationBoundary !== undefined) {
        await assertRequestSettingsInitializationDeadline(transaction, input.initializationBoundary.deadline);
      }
      await assertProviderRequestSettingsWriteDeadline(transaction, input.writeDeadline);
      return { kind: "updated", revision: next };
    }, { ...TRANSACTION_OPTIONS, maxWait: Math.min(TRANSACTION_OPTIONS.maxWait, remaining),
      timeout: Math.min(TRANSACTION_OPTIONS.timeout, remaining) }).catch((error: unknown): ReviseProviderRequestSettingsResult => {
      if (error instanceof ProviderRequestSettingsWriteExpired) return { kind: "write_deadline_expired" };
      if (input.writeDeadline !== undefined && Date.now() >= input.writeDeadline.getTime()
        && error instanceof ProviderPrisma.PrismaClientKnownRequestError && error.code === "P2028") {
        return { kind: "write_deadline_expired" };
      }
      if (error instanceof ProviderRequestSettingsInitializationExpired) return { kind: "initialization_requires_handoff" };
      // Concurrent snapshots may both read the prior revision after waiting
      // for the runtime lock. The losing transaction is wholly rolled back.
      if (error instanceof ProviderPrisma.PrismaClientKnownRequestError && (
        error.code === "P2034" || (error.code === "P2002"
          && Array.isArray(error.meta?.target) && error.meta.target.length === 1
          && error.meta.target[0] === "revision_number")
      )) return { kind: "revision_conflict" };
      throw error;
    });
  }
}
