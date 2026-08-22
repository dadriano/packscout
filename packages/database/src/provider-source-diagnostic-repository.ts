import { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import {
  providerSourceDiagnosticCheckpointFingerprintSchema,
  providerSourceDiagnosticCommandCorrelationKeySchema,
  providerSourceDiagnosticCorrelationKindSchema,
  providerSourceDiagnosticEventKindByCorrelationKind,
  type ProviderSourceDiagnosticSeverity,
} from "@packscout/contracts";
import type {
  PackscoutPrismaClient,
  PackscoutQueryClient,
  PackscoutTransactionClient,
} from "./database.ts";
import {
  PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION,
  PROVIDER_SOURCE_DIAGNOSTIC_RETENTION_DAYS,
  type DiagnosticEventInput,
} from "./provider-source-persistence-types.ts";
import { providerSourceTransactionTime } from
  "./provider-source-database-clock.ts";

const SAFE_DIAGNOSTIC_REFERENCE = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_DIAGNOSTIC_CODE = /^(?:[A-Z][A-Z0-9_]{0,127}|[a-z][a-z0-9_-]{0,127})$/u;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const SAFE_DIAGNOSTIC_EVIDENCE_KEYS = new Set([
  "attempt_state",
  "continuation_kind",
  "failure_class",
  "health_state",
  "lifecycle_state",
  "operation_kind",
  "outcome_class",
  "reason_code",
  "recovery_state",
  "request_class",
  "source_state",
  "status",
]);
const SAFE_DIAGNOSTIC_EVIDENCE_VALUES = new Set([
  "active",
  "blocked",
  "cancelled",
  "candidate",
  "captured",
  "connection_action_required",
  "connection_outcome_uncertain",
  "continue",
  "disabled",
  "draft",
  "failed",
  "failure",
  "fenced",
  "head_reached",
  "in_flight",
  "paused",
  "poll_after",
  "queued",
  "replaced",
  "retired",
  "retryable",
  "revoked",
  "running",
  "source_action_required",
  "succeeded",
  "success",
  "waiting",
]);

function assertSafeReference(label: string, value: string): void {
  if (!SAFE_DIAGNOSTIC_REFERENCE.test(value)) {
    throw new TypeError(`${label} must be a bounded registration key.`);
  }
}

function assertSafeCode(label: string, value: string): void {
  if (!SAFE_DIAGNOSTIC_CODE.test(value)) {
    throw new TypeError(`${label} must be a bounded safe code.`);
  }
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function safeOptionalCounter(label: string, value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSTGRES_INTEGER) {
    throw new TypeError(`${label} must be a nonnegative 32-bit integer.`);
  }
  return value;
}

function safeJson(
  value: Readonly<Record<string, string | number | boolean | null>> | undefined,
): Prisma.InputJsonValue {
  const normalized = value ?? {};
  for (const [key, evidenceValue] of Object.entries(normalized)) {
    if (!SAFE_DIAGNOSTIC_EVIDENCE_KEYS.has(key)) {
      throw new TypeError(`Diagnostic evidence key ${key} is not allowed.`);
    }
    if (typeof evidenceValue === "string") {
      if (key.endsWith("_code")) assertSafeCode(`Diagnostic evidence ${key}`, evidenceValue);
      else if (!SAFE_DIAGNOSTIC_EVIDENCE_VALUES.has(evidenceValue)) {
        throw new TypeError(`Diagnostic evidence ${key} has an unsupported safe value.`);
      }
    }
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new TypeError("Diagnostic evidence exceeds 4096 bytes.");
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function safeCounters(
  value: Readonly<Record<string, number>> | undefined,
): Prisma.InputJsonValue {
  const normalized = value ?? {};
  const entries = Object.entries(normalized);
  if (entries.length > 64) throw new TypeError("Diagnostic counters exceed 64 entries.");
  for (const [key, counter] of entries) {
    assertSafeReference("Diagnostic counter key", key);
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new TypeError("Diagnostic counters must be nonnegative safe integers.");
    }
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new TypeError("Diagnostic counters exceed 4096 bytes.");
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function assertCorrelation(input: DiagnosticEventInput): void {
  const parsedCorrelationKind = providerSourceDiagnosticCorrelationKindSchema.safeParse(
    input.correlationKind,
  );
  if (!parsedCorrelationKind.success) {
    throw new TypeError("Diagnostic correlation kind is invalid.");
  }
  const correlationKind = parsedCorrelationKind.data;
  if (input.eventKind !== providerSourceDiagnosticEventKindByCorrelationKind[correlationKind]) {
    throw new TypeError("Diagnostic event kind does not match its correlation kind.");
  }

  const hasSourceIdentity = isPresent(input.providerId)
    && isPresent(input.sourceInstanceId)
    && isPresent(input.sourceRevisionId)
    && isPresent(input.normalizedContractVersion);
  const hasNoSourceIdentity = !isPresent(input.providerId)
    && !isPresent(input.sourceInstanceId)
    && !isPresent(input.sourceRevisionId)
    && !isPresent(input.normalizedContractVersion);

  if (correlationKind === "connection_test" || correlationKind === "connection_episode") {
    const commonConnectionShape = input.scope === "connection"
      && hasNoSourceIdentity
      && !isPresent(input.sourceTestJobId)
      && !isPresent(input.runId)
      && !isPresent(input.pageId)
      && !isPresent(input.runTrigger)
      && !isPresent(input.commandCorrelationKey)
      && !isPresent(input.auditEventId);
    const operationShape = correlationKind === "connection_test"
      ? isPresent(input.connectionTestJobId)
      : isPresent(input.blockingEpisodeId) && !isPresent(input.connectionTestJobId);
    if (!commonConnectionShape || !operationShape) {
      throw new TypeError("Connection diagnostic correlation does not match its category.");
    }
    return;
  }

  if (
    input.scope !== "source"
    || !hasSourceIdentity
    || isPresent(input.blockingEpisodeId)
    || isPresent(input.connectionTestJobId)
  ) {
    throw new TypeError("Source diagnostics require exact source revision correlation.");
  }

  const lifecycle = correlationKind === "lifecycle"
    && Number(isPresent(input.commandCorrelationKey))
      + Number(isPresent(input.auditEventId)) === 1
    && !isPresent(input.sourceTestJobId)
    && !isPresent(input.runId)
    && !isPresent(input.pageId)
    && !isPresent(input.requestAttemptId)
    && !isPresent(input.runTrigger);
  const sourceTest = correlationKind === "source_test"
    && isPresent(input.sourceTestJobId)
    && !isPresent(input.commandCorrelationKey)
    && !isPresent(input.auditEventId)
    && !isPresent(input.runId)
    && !isPresent(input.pageId)
    && !isPresent(input.runTrigger);
  const run = correlationKind === "run"
    && isPresent(input.runId)
    && isPresent(input.runTrigger)
    && !isPresent(input.sourceTestJobId)
    && !isPresent(input.commandCorrelationKey)
    && !isPresent(input.auditEventId)
    && !isPresent(input.pageId)
    && !isPresent(input.requestAttemptId);
  const page = correlationKind === "page"
    && isPresent(input.runId)
    && isPresent(input.runTrigger)
    && (isPresent(input.pageId) || isPresent(input.requestAttemptId))
    && !isPresent(input.sourceTestJobId)
    && !isPresent(input.commandCorrelationKey)
    && !isPresent(input.auditEventId);
  if (!lifecycle && !sourceTest && !run && !page) {
    throw new TypeError("Source diagnostic correlation does not match its category.");
  }
}

export interface StoredProviderSourceDiagnostic {
  readonly id: string;
  readonly scope: "source" | "connection";
  readonly eventKind: string;
  readonly severity: ProviderSourceDiagnosticSeverity;
  readonly phase: string;
  readonly safeCode: string;
  readonly occurredAt: Date;
}

export interface ProviderSourceDiagnosticKeyset {
  readonly occurredAt: Date;
  readonly id: string;
}

export interface ProviderSourceDiagnosticHistoryEvent {
  readonly id: string;
  readonly scope: "source" | "connection";
  readonly correlationKind:
    | "lifecycle"
    | "connection_test"
    | "source_test"
    | "run"
    | "page"
    | "connection_episode";
  readonly eventKind: string;
  readonly severity: ProviderSourceDiagnosticSeverity;
  readonly phase: string;
  readonly safeCode: string;
  readonly occurredAt: Date;
  readonly durationMilliseconds: number | null;
  readonly responseBytes: number | null;
  readonly retryDelayMilliseconds: number | null;
  readonly continuation: Readonly<{
    kind: "continue" | "poll_after";
    minimumDelaySeconds?: number;
  }> | null;
  readonly checkpointFingerprint: string | null;
  readonly counters: Readonly<Record<string, number>>;
  readonly runId: string | null;
  readonly hasTestReference: boolean;
  readonly hasCommandReference: boolean;
  readonly quarantineId: string | null;
}

export interface ProviderSourceDiagnosticHistoryPage {
  readonly state: "current" | "expired";
  readonly events: readonly ProviderSourceDiagnosticHistoryEvent[];
  readonly next: ProviderSourceDiagnosticKeyset | null;
  readonly availablePhases: readonly string[];
}

export class ProviderSourceDiagnosticRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async append(input: DiagnosticEventInput): Promise<string> {
    return this.appendUsing(this.database, input);
  }

  /** Supervisor transitions use DB time for occurrence and retention. */
  async appendAtDatabaseTime(input: DiagnosticEventInput): Promise<string> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await providerSourceTransactionTime(transaction);
      return this.appendUsing(transaction, {
        ...input,
        occurredAt: databaseNow,
      });
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  /**
   * Backfills the logical request-start transition only after its compact
   * terminal proof exists, using the durable attempt start timestamp.
   */
  async appendTerminalRequestStart(
    input: DiagnosticEventInput,
  ): Promise<string> {
    const requestAttemptId = input.requestAttemptId;
    if (!requestAttemptId) {
      throw new TypeError("Request-start diagnostic requires an attempt.");
    }
    return this.database.$transaction(async (transaction) => {
      const proof = await transaction.compact_source_request_attempts.findFirst({
        where: {
          request_attempt_id: requestAttemptId,
          organization_id: input.organizationId,
        },
        select: { started_at: true },
      });
      if (!proof) {
        throw new TypeError("Request-start diagnostic lacks terminal proof.");
      }
      return this.appendUsing(transaction, {
        ...input,
        occurredAt: proof.started_at,
      });
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  /** Appends inside task 006's caller-owned atomic page transaction. */
  async appendInTransaction(
    transaction: PackscoutTransactionClient,
    input: DiagnosticEventInput,
  ): Promise<string> {
    return this.appendUsing(transaction, input);
  }

  private async appendUsing(
    database: PackscoutQueryClient,
    input: DiagnosticEventInput,
  ): Promise<string> {
    assertSafeReference("Diagnostic event kind", input.eventKind);
    assertSafeReference("Diagnostic phase", input.phase);
    assertSafeCode("Diagnostic code", input.safeCode);
    assertSafeReference("Diagnostic source type", input.sourceTypeKey);
    assertSafeReference("Diagnostic adapter version", input.sourceAdapterVersion);
    if (input.normalizedContractVersion) {
      assertSafeReference("Diagnostic contract version", input.normalizedContractVersion);
    }
    if (
      input.checkpointFingerprint !== undefined
      && input.checkpointFingerprint !== null
      && !providerSourceDiagnosticCheckpointFingerprintSchema.safeParse(
        input.checkpointFingerprint,
      ).success
    ) {
      throw new TypeError(
        "Diagnostic checkpoint fingerprint must be a lowercase 64-character keyed digest.",
      );
    }
    if (
      input.commandCorrelationKey !== undefined
      && input.commandCorrelationKey !== null
      && !providerSourceDiagnosticCommandCorrelationKeySchema.safeParse(
        input.commandCorrelationKey,
      ).success
    ) {
      throw new TypeError("Diagnostic command correlation key is invalid or too long.");
    }
    assertCorrelation(input);
    const continuation = input.continuation ?? null;
    const durationMs = safeOptionalCounter("Diagnostic duration", input.durationMs);
    const responseBytes = safeOptionalCounter("Diagnostic response bytes", input.responseBytes);
    const retryDelayMs = safeOptionalCounter("Diagnostic retry delay", input.retryDelayMs);
    const counters = safeCounters(input.counters);
    const evidence = safeJson(input.evidence);
    const blockingEpisode = input.blockingEpisodeId
      ? await database.source_connection_health_episodes.findFirst({
        where: {
          id: input.blockingEpisodeId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
        },
        select: { connection_revision_id: true },
      })
      : null;
    if (input.blockingEpisodeId && !blockingEpisode) {
      throw new TypeError("Diagnostic blocking episode is outside connection scope.");
    }
    if (input.id) {
      const existing = await database.source_processor_diagnostic_events.findUnique({
        where: { id: input.id },
      });
      if (existing) {
        if (
          existing.organization_id !== input.organizationId ||
          existing.scope !== input.scope ||
          existing.correlation_kind !== input.correlationKind ||
          existing.event_kind !== input.eventKind ||
          existing.severity !== input.severity ||
          existing.phase !== input.phase ||
          existing.safe_code !== input.safeCode ||
          existing.source_type_key !== input.sourceTypeKey ||
          existing.source_adapter_version !== input.sourceAdapterVersion ||
          existing.normalized_contract_version !==
            (input.normalizedContractVersion ?? null) ||
          existing.provider_id !== (input.providerId ?? null) ||
          existing.source_instance_id !== (input.sourceInstanceId ?? null) ||
          existing.source_revision_id !== (input.sourceRevisionId ?? null) ||
          existing.connection_profile_id !== input.connectionProfileId ||
          existing.connection_revision_id !== input.connectionRevisionId ||
          existing.blocking_episode_id !== (input.blockingEpisodeId ?? null) ||
          existing.connection_test_job_id !==
            (input.connectionTestJobId ?? null) ||
          existing.source_test_job_id !== (input.sourceTestJobId ?? null) ||
          existing.run_id !== (input.runId ?? null) ||
          existing.page_id !== (input.pageId ?? null) ||
          existing.request_attempt_id !== (input.requestAttemptId ?? null) ||
          existing.run_trigger !== (input.runTrigger ?? null) ||
          existing.command_correlation_key !==
            (input.commandCorrelationKey ?? null) ||
          existing.audit_event_id !== (input.auditEventId ?? null) ||
          existing.continuation_kind !== (continuation?.kind ?? null) ||
          existing.minimum_delay_seconds !==
            (continuation?.kind === "poll_after"
              ? continuation.minimumDelaySeconds
              : null) ||
          existing.retry_delay_ms !== retryDelayMs ||
          existing.duration_ms !== durationMs ||
          existing.response_bytes !== responseBytes ||
          !isDeepStrictEqual(existing.counters_json, counters) ||
          !isDeepStrictEqual(existing.evidence_json, evidence) ||
          existing.checkpoint_fingerprint !==
            (input.checkpointFingerprint ?? null)
        ) {
          throw new TypeError(
            "Diagnostic idempotency key has different immutable content.",
          );
        }
        return existing.id;
      }
    }
    const created = await database.source_processor_diagnostic_events.create({
      data: {
        id: input.id,
        organization_id: input.organizationId,
        scope: input.scope,
        correlation_kind: input.correlationKind,
        event_kind: input.eventKind,
        severity: input.severity,
        phase: input.phase,
        safe_code: input.safeCode,
        occurred_at: input.occurredAt,
        duration_ms: durationMs,
        response_bytes: responseBytes,
        counters_json: counters,
        evidence_json: evidence,
        continuation_kind: continuation?.kind,
        minimum_delay_seconds: continuation?.kind === "poll_after"
          ? continuation.minimumDelaySeconds
          : null,
        retry_delay_ms: retryDelayMs,
        checkpoint_fingerprint: input.checkpointFingerprint,
        source_type_key: input.sourceTypeKey,
        source_adapter_version: input.sourceAdapterVersion,
        normalized_contract_version: input.normalizedContractVersion,
        provider_id: input.providerId,
        source_instance_id: input.sourceInstanceId,
        source_revision_id: input.sourceRevisionId,
        connection_profile_id: input.connectionProfileId,
        connection_revision_id: input.connectionRevisionId,
        blocking_episode_id: input.blockingEpisodeId,
        blocking_episode_connection_revision_id: blockingEpisode?.connection_revision_id,
        connection_test_job_id: input.connectionTestJobId,
        source_test_job_id: input.sourceTestJobId,
        run_id: input.runId,
        page_id: input.pageId,
        request_attempt_id: input.requestAttemptId,
        run_trigger: input.runTrigger,
        command_correlation_key: input.commandCorrelationKey,
        audit_event_id: input.auditEventId,
        expires_at: new Date(
          input.occurredAt.getTime()
          + PROVIDER_SOURCE_DIAGNOSTIC_RETENTION_DAYS * 86_400_000,
        ),
      },
      select: { id: true },
    });
    return created.id;
  }

  async listForSource(input: Readonly<{
    organizationId: string;
    sourceInstanceId: string;
    limit: number;
    asOf?: Date;
  }>): Promise<StoredProviderSourceDiagnostic[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new TypeError("Diagnostic limit must be an integer from 1 through 500.");
    }
    const source = await this.database.provider_source_instances.findFirst({
      where: { id: input.sourceInstanceId, organization_id: input.organizationId },
      select: { connection_profile_id: true, created_at: true, replaced_at: true },
    });
    if (!source) return [];
    const asOf = input.asOf ?? new Date();
    const rows = await this.database.source_processor_diagnostic_events.findMany({
      where: {
        organization_id: input.organizationId,
        expires_at: { gt: asOf },
        OR: [
          { scope: "source", source_instance_id: input.sourceInstanceId },
          {
            scope: "connection",
            connection_profile_id: source.connection_profile_id,
            occurred_at: {
              gte: source.created_at,
              ...(source.replaced_at ? { lt: source.replaced_at } : {}),
            },
          },
        ],
      },
      orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        scope: true,
        event_kind: true,
        severity: true,
        phase: true,
        safe_code: true,
        occurred_at: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      eventKind: row.event_kind,
      severity: row.severity,
      phase: row.phase,
      safeCode: row.safe_code,
      occurredAt: row.occurred_at,
    }));
  }

  async readHistoryPage(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    limit: number;
    severity?: ProviderSourceDiagnosticSeverity;
    phase?: string;
    runId?: string;
    before?: ProviderSourceDiagnosticKeyset;
    asOf?: Date;
  }>): Promise<ProviderSourceDiagnosticHistoryPage | null> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new TypeError("Diagnostic page limit must be an integer from 1 through 50.");
    }
    if (input.phase !== undefined) {
      assertSafeReference("Diagnostic phase filter", input.phase);
    }
    const source = await this.database.provider_source_instances.findFirst({
      where: {
        id: input.sourceInstanceId,
        organization_id: input.organizationId,
        provider_id: input.providerId,
      },
      select: {
        connection_profile_id: true,
        source_type_key: true,
        created_at: true,
        replaced_at: true,
      },
    });
    if (!source) return null;
    const asOf = input.asOf ?? new Date();
    const runInScope = input.runId === undefined
      ? true
      : await this.database.import_runs.findFirst({
          where: {
            id: input.runId,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_instance_id: input.sourceInstanceId,
          },
          select: { id: true },
        }) !== null;
    const scope: Prisma.source_processor_diagnostic_eventsWhereInput =
      input.runId !== undefined
      ? {
          scope: "source" as const,
          source_instance_id: input.sourceInstanceId,
          run_id: input.runId,
          correlation_kind: { in: ["run", "page"] },
        }
      : {
          OR: [
            { scope: "source" as const, source_instance_id: input.sourceInstanceId },
            {
              scope: "connection" as const,
              connection_profile_id: source.connection_profile_id,
              source_type_key: source.source_type_key,
              occurred_at: {
                gte: source.created_at,
                ...(source.replaced_at ? { lt: source.replaced_at } : {}),
              },
            },
          ],
        };
    const baseWhere: Prisma.source_processor_diagnostic_eventsWhereInput = {
      organization_id: input.organizationId,
      expires_at: { gt: asOf },
      ...scope,
    };
    const cursorCurrent = input.before === undefined ||
      await this.database.source_processor_diagnostic_events.findFirst({
        where: {
          ...baseWhere,
          id: input.before.id,
          occurred_at: input.before.occurredAt,
        },
        select: { id: true },
      }) !== null;
    const phaseRows = await this.database.source_processor_diagnostic_events.findMany({
      where: baseWhere,
      distinct: ["phase"],
      orderBy: { phase: "asc" },
      take: 64,
      select: { phase: true },
    });
    if (!cursorCurrent) {
      return {
        state: "expired",
        events: [],
        next: null,
        availablePhases: phaseRows.map(({ phase }) => phase),
      };
    }
    if (!runInScope) {
      return {
        state: "current",
        events: [],
        next: null,
        availablePhases: phaseRows.map(({ phase }) => phase),
      };
    }
    const rows = await this.database.source_processor_diagnostic_events.findMany({
      where: {
        ...baseWhere,
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.before
          ? {
              OR: [
                { occurred_at: { lt: input.before.occurredAt } },
                {
                  occurred_at: input.before.occurredAt,
                  id: { lt: input.before.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: {
        id: true,
        scope: true,
        correlation_kind: true,
        event_kind: true,
        severity: true,
        phase: true,
        safe_code: true,
        occurred_at: true,
        duration_ms: true,
        response_bytes: true,
        retry_delay_ms: true,
        continuation_kind: true,
        minimum_delay_seconds: true,
        checkpoint_fingerprint: true,
        counters_json: true,
        run_id: true,
        connection_test_job_id: true,
        source_test_job_id: true,
        command_correlation_key: true,
        audit_event_id: true,
        page_id: true,
      },
    });
    const visible = rows.slice(0, input.limit);
    const pageIds = visible.flatMap(({ page_id }) => page_id ? [page_id] : []);
    const quarantines = pageIds.length === 0
      ? []
      : await this.database.quarantine_records.findMany({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            page_id: { in: pageIds },
          },
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
          distinct: ["page_id"],
          select: { id: true, page_id: true },
        });
    const mapped = visible.map((row) => {
      const rawCounters = typeof row.counters_json === "object" &&
          row.counters_json !== null && !Array.isArray(row.counters_json)
        ? row.counters_json as Record<string, unknown>
        : {};
      const counters = Object.fromEntries(
        Object.entries(rawCounters).flatMap(([key, value]) =>
          Number.isSafeInteger(value) && Number(value) >= 0
            ? [[key, Number(value)]]
            : []
        ),
      );
      return {
        id: row.id,
        scope: row.scope,
        correlationKind: row.correlation_kind,
        eventKind: row.event_kind,
        severity: row.severity,
        phase: row.phase,
        safeCode: row.safe_code,
        occurredAt: row.occurred_at,
        durationMilliseconds: row.duration_ms,
        responseBytes: row.response_bytes,
        retryDelayMilliseconds: row.retry_delay_ms,
        continuation: row.continuation_kind === null
          ? null
          : row.continuation_kind === "continue"
            ? { kind: "continue" as const }
            : {
                kind: "poll_after" as const,
                minimumDelaySeconds: row.minimum_delay_seconds ?? 0,
              },
        checkpointFingerprint: row.checkpoint_fingerprint,
        counters,
        runId: row.run_id,
        hasTestReference: row.connection_test_job_id !== null ||
          row.source_test_job_id !== null,
        hasCommandReference: row.command_correlation_key !== null ||
          row.audit_event_id !== null,
        quarantineId: quarantines.find(
          ({ page_id }) => page_id === row.page_id,
        )?.id ?? null,
      };
    });
    const last = mapped.at(-1);
    return {
      state: "current",
      events: mapped,
      next: rows.length > input.limit && last
        ? { occurredAt: last.occurredAt, id: last.id }
        : null,
      availablePhases: phaseRows.map(({ phase }) => phase),
    };
  }
}
