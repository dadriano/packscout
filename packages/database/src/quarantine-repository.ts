import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
} from "./database.ts";

type QuarantineState = "open" | "retrying" | "resolved" | "expired";
type StoredQuarantineState = "open" | "resolved" | "expired";
type RecordKind = "catalog" | "pull" | "sale";

export interface PersistedQuarantineEntry {
  readonly id: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly runId: string;
  readonly pageId: string;
  readonly sourceRecordId: string | null;
  readonly recordKind: RecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string;
  readonly state: QuarantineState;
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly lastRetryAt: Date | null;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionSummary: string | null;
}

export interface PersistedQuarantineAttempt {
  readonly id: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly failureCode: string | null;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string | null;
  readonly canonicalRevisionCount: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface PersistedQuarantinePageQuery {
  readonly providerId?: string;
  readonly runId?: string;
  readonly state?: QuarantineState;
  readonly recordKind?: RecordKind;
  readonly reasonCode?: string;
  readonly before?: {
    readonly createdAt: Date;
    readonly id: string;
  };
  readonly limit: number;
}

export interface PersistedQuarantinePage {
  readonly items: readonly PersistedQuarantineEntry[];
  readonly hasMore: boolean;
}

export interface PersistedProtectedQuarantineEvidence {
  readonly rawRecord: unknown;
  readonly organizationId: string;
  readonly sourceRecordId: string | null;
  readonly runId: string;
  readonly pageId: string;
  readonly recordKind: RecordKind;
  readonly recordIndex: number;
  readonly expiresAt: Date;
  readonly source: {
    readonly platform: string;
    readonly recordKind: RecordKind;
    readonly recordIndex: number;
    readonly externalId: string;
    readonly collectedAt: string;
    readonly sourceTimestamp: string;
  } | null;
  readonly configuration: {
    readonly providerId: string;
    readonly configurationRevisionId: string;
    readonly platform: string;
    readonly adapterKey: string;
  };
}

export type PersistedQuarantineClaimResult =
  | {
      readonly kind: "claimed";
      readonly attemptId: string;
      readonly entry: PersistedQuarantineEntry;
      readonly evidence: PersistedProtectedQuarantineEvidence;
    }
  | {
      readonly kind: "already_retrying" | "already_resolved" | "expired";
      readonly entry: PersistedQuarantineEntry;
    }
  | { readonly kind: "not_found" };

interface QuarantineRow {
  id: string;
  organizationId: string;
  providerId: string;
  configurationRevisionId: string;
  platformKey: string;
  adapterKey: string;
  runId: string;
  pageId: string;
  sourceRecordId: string | null;
  recordKind: RecordKind;
  recordIndex: number;
  externalId: string | null;
  reasonCode: string;
  fieldPath: string | null;
  sanitizedSummary: string;
  state: StoredQuarantineState;
  retryCount: number;
  createdAt: Date;
  lastRetryAt: Date | null;
  expiresAt: Date;
  resolvedAt: Date | null;
}

interface QuarantineCountRow {
  outstanding: number;
  retrying: number;
  resolved: number;
  expired: number;
}

interface ExpiryClaimRow {
  id: string;
  state: StoredQuarantineState;
  sourceRecordId: string | null;
  pageId: string;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export class PrismaQuarantineRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async listEntries(
    organizationId: string,
    query: {
      providerId?: string;
      state?: QuarantineState;
      reasonCode?: string;
      limit: number;
    },
    now: Date,
  ): Promise<readonly PersistedQuarantineEntry[]> {
    return (await this.listEntriesPage(organizationId, query, now)).items;
  }

  async listEntriesPage(
    organizationId: string,
    query: PersistedQuarantinePageQuery,
    now: Date,
  ): Promise<PersistedQuarantinePage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new RangeError("Quarantine page limit is invalid.");
    }
    const filters: Prisma.Sql[] = [
      Prisma.sql`quarantine.organization_id = ${uuid(organizationId)}`,
    ];
    if (query.providerId) {
      filters.push(Prisma.sql`quarantine.provider_id = ${uuid(query.providerId)}`);
    }
    if (query.runId) {
      filters.push(Prisma.sql`quarantine.run_id = ${uuid(query.runId)}`);
    }
    if (query.recordKind) {
      filters.push(
        Prisma.sql`quarantine.record_kind = cast(${query.recordKind} as public.source_record_kind)`,
      );
    }
    if (query.reasonCode) {
      filters.push(Prisma.sql`quarantine.reason_code = ${query.reasonCode}`);
    }
    const runningAttempt = Prisma.sql`exists (
      select 1
      from public.quarantine_attempts as attempt
      where attempt.organization_id = quarantine.organization_id
        and attempt.quarantine_id = quarantine.id
        and attempt.state = 'running'
    )`;
    if (query.state === "resolved") {
      filters.push(Prisma.sql`quarantine.state = 'resolved'`);
    }
    if (query.state === "expired") {
      filters.push(
        Prisma.sql`(
          quarantine.state = 'expired'
          or (quarantine.state = 'open' and quarantine.expires_at <= ${now})
        )`,
      );
    }
    if (query.state === "open") {
      filters.push(Prisma.sql`quarantine.state = 'open'`);
      filters.push(Prisma.sql`quarantine.expires_at > ${now}`);
      filters.push(Prisma.sql`not (${runningAttempt})`);
    }
    if (query.state === "retrying") {
      filters.push(Prisma.sql`quarantine.state = 'open'`);
      filters.push(Prisma.sql`quarantine.expires_at > ${now}`);
      filters.push(runningAttempt);
    }
    if (query.before) {
      filters.push(Prisma.sql`(
        quarantine.created_at < ${query.before.createdAt}
        or (
          quarantine.created_at = ${query.before.createdAt}
          and quarantine.id < ${uuid(query.before.id)}
        )
      )`);
    }

    const rows = await this.database.$queryRaw<QuarantineRow[]>(Prisma.sql`
      ${this.quarantineSelection()}
      where ${Prisma.join(filters, " and ")}
      order by quarantine.created_at desc, quarantine.id desc
      limit ${query.limit + 1}
    `);
    const entries = await Promise.all(
      rows
        .slice(0, query.limit)
        .map((row) => this.toEntry(this.database, row, now)),
    );
    return { items: entries, hasMore: rows.length > query.limit };
  }

  async getEntry(
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<PersistedQuarantineEntry | null> {
    const row = await this.loadRow(this.database, organizationId, quarantineId);
    return row ? this.toEntry(this.database, row, now) : null;
  }

  async listAttempts(
    organizationId: string,
    quarantineId: string,
  ): Promise<readonly PersistedQuarantineAttempt[]> {
    const attempts = await this.database.quarantine_attempts.findMany({
      where: {
        organization_id: organizationId,
        quarantine_id: quarantineId,
      },
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      take: 100,
      select: {
        id: true,
        state: true,
        failure_code: true,
        field_path: true,
        sanitized_summary: true,
        canonical_revision_count: true,
        started_at: true,
        finished_at: true,
      },
    });
    return attempts.map((attempt) => ({
      id: attempt.id,
      state: attempt.state,
      failureCode: attempt.failure_code,
      fieldPath: attempt.field_path,
      sanitizedSummary: attempt.sanitized_summary,
      canonicalRevisionCount: attempt.canonical_revision_count,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
    }));
  }

  async countEntries(
    organizationId: string,
    now: Date,
  ): Promise<{
    outstanding: number;
    retrying: number;
    resolved: number;
    expired: number;
  }> {
    const rows = await this.database.$queryRaw<QuarantineCountRow[]>(Prisma.sql`
      select
        cast(count(*) filter (
          where quarantine.state = 'open'
            and quarantine.expires_at > ${now}
            and not exists (
              select 1
              from public.quarantine_attempts as attempt
              where attempt.organization_id = quarantine.organization_id
                and attempt.quarantine_id = quarantine.id
                and attempt.state = 'running'
            )
        ) as integer) as outstanding,
        cast(count(*) filter (
          where quarantine.state = 'open'
            and quarantine.expires_at > ${now}
            and exists (
              select 1
              from public.quarantine_attempts as attempt
              where attempt.organization_id = quarantine.organization_id
                and attempt.quarantine_id = quarantine.id
                and attempt.state = 'running'
            )
        ) as integer) as retrying,
        cast(count(*) filter (
          where quarantine.state = 'resolved'
        ) as integer) as resolved,
        cast(count(*) filter (
          where quarantine.state = 'expired'
             or (quarantine.state = 'open' and quarantine.expires_at <= ${now})
        ) as integer) as expired
      from public.quarantine_records as quarantine
      where quarantine.organization_id = ${uuid(organizationId)}
    `);
    return rows[0] ?? { outstanding: 0, retrying: 0, resolved: 0, expired: 0 };
  }

  async claimRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    claimedAt: Date;
  }): Promise<PersistedQuarantineClaimResult> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        select id
        from public.quarantine_records
        where id = ${uuid(input.quarantineId)}
          and organization_id = ${uuid(input.organizationId)}
        for update
      `);
      const row = await this.loadRow(
        transaction,
        input.organizationId,
        input.quarantineId,
      );
      if (!row) return { kind: "not_found" };
      const current = await this.toEntry(transaction, row, input.claimedAt);
      if (current.state === "resolved") {
        return { kind: "already_resolved", entry: current };
      }
      if (current.state === "expired") {
        await this.markExpired(
          transaction,
          row.id,
          input.organizationId,
          input.claimedAt,
        );
        return {
          kind: "expired",
          entry: { ...current, state: "expired" },
        };
      }
      if (current.state === "retrying") {
        return { kind: "already_retrying", entry: current };
      }
      const evidence = await this.loadEvidence(
        transaction,
        input.organizationId,
        row,
        input.claimedAt,
      );
      if (!evidence) {
        await this.markExpired(
          transaction,
          row.id,
          input.organizationId,
          input.claimedAt,
        );
        return {
          kind: "expired",
          entry: { ...current, state: "expired" },
        };
      }
      await transaction.quarantine_attempts.create({
        data: {
          id: input.attemptId,
          organization_id: input.organizationId,
          quarantine_id: input.quarantineId,
          source_record_id: row.sourceRecordId,
          state: "running",
          requested_by_actor_key: input.actorKey,
          started_at: input.claimedAt,
        },
      });
      await transaction.quarantine_records.updateMany({
        where: {
          organization_id: input.organizationId,
          id: input.quarantineId,
        },
        data: {
          retry_count: { increment: 1 },
          last_retry_at: input.claimedAt,
        },
      });
      const claimed = await this.getEntryFrom(
        transaction,
        input.organizationId,
        input.quarantineId,
        input.claimedAt,
      );
      if (!claimed) throw new Error("Claimed quarantine entry could not be loaded.");
      return {
        kind: "claimed",
        attemptId: input.attemptId,
        entry: claimed,
        evidence,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async completeRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    completedAt: Date;
    canonicalRevisionCount: number;
  }): Promise<PersistedQuarantineEntry | null> {
    return this.finishAttempt({
      ...input,
      state: "succeeded",
      failureCode: null,
      fieldPath: null,
      sanitizedSummary: "Quarantine retry resolved the source record.",
    });
  }

  async failRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    failedAt: Date;
    failureCode: string;
    fieldPath: string | null;
    sanitizedSummary: string;
  }): Promise<PersistedQuarantineEntry | null> {
    return this.finishAttempt({
      organizationId: input.organizationId,
      quarantineId: input.quarantineId,
      attemptId: input.attemptId,
      actorKey: input.actorKey,
      completedAt: input.failedAt,
      state: "failed",
      failureCode: input.failureCode,
      fieldPath: input.fieldPath,
      sanitizedSummary: input.sanitizedSummary,
      canonicalRevisionCount: 0,
    });
  }

  async expireEvidence(input: {
    organizationId: string;
    before: Date;
    expiredAt: Date;
    batchSize: number;
  }): Promise<number> {
    if (
      !Number.isInteger(input.batchSize) ||
      input.batchSize < 1 ||
      input.batchSize > 10_000
    ) {
      throw new RangeError("Quarantine expiry batch size is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const records = await transaction.$queryRaw<ExpiryClaimRow[]>(Prisma.sql`
        select
          quarantine.id,
          quarantine.state,
          quarantine.source_record_id as "sourceRecordId",
          quarantine.page_id as "pageId"
        from public.quarantine_records as quarantine
        where quarantine.organization_id = ${uuid(input.organizationId)}
          and quarantine.state <> 'expired'
          and quarantine.expires_at <= ${input.before}
          and not exists (
            select 1
            from public.quarantine_attempts as attempt
            where attempt.quarantine_id = quarantine.id
              and attempt.state = 'running'
          )
        order by quarantine.expires_at, quarantine.id
        for update of quarantine skip locked
        limit ${input.batchSize}
      `);
      if (records.length === 0) return 0;
      const quarantineIds = records.map(({ id }) => id);
      await transaction.quarantine_records.updateMany({
        where: {
          organization_id: input.organizationId,
          id: { in: quarantineIds },
        },
        data: {
          payload_json: Prisma.DbNull,
          payload_expired_at: input.expiredAt,
        },
      });
      const unresolvedIds = records
        .filter(({ state }) => state === "open")
        .map(({ id }) => id);
      if (unresolvedIds.length > 0) {
        await transaction.quarantine_records.updateMany({
          where: {
            organization_id: input.organizationId,
            id: { in: unresolvedIds },
          },
          data: { state: "expired" },
        });
      }
      const sourceIds = [
        ...new Set(
          records.flatMap(({ sourceRecordId }) =>
            sourceRecordId ? [sourceRecordId] : [],
          ),
        ),
      ];
      if (sourceIds.length > 0) {
        await transaction.source_records.updateMany({
          where: {
            organization_id: input.organizationId,
            id: { in: sourceIds },
          },
          data: {
            payload_json: Prisma.DbNull,
            payload_expired_at: input.expiredAt,
          },
        });
      }
      await transaction.import_pages.updateMany({
        where: {
          organization_id: input.organizationId,
          id: { in: [...new Set(records.map(({ pageId }) => pageId))] },
        },
        data: {
          payload_json: Prisma.DbNull,
          payload_expired_at: input.expiredAt,
        },
      });
      return records.length;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private async finishAttempt(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    completedAt: Date;
    state: "succeeded" | "failed";
    failureCode: string | null;
    fieldPath: string | null;
    sanitizedSummary: string;
    canonicalRevisionCount: number;
  }): Promise<PersistedQuarantineEntry | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        select id
        from public.quarantine_records
        where id = ${uuid(input.quarantineId)}
          and organization_id = ${uuid(input.organizationId)}
        for update
      `);
      const row = await this.loadRow(
        transaction,
        input.organizationId,
        input.quarantineId,
      );
      if (!row) return null;
      const evidenceExpired =
        row.state === "expired" ||
        (row.state === "open" && row.expiresAt <= input.completedAt);
      const effectiveState = evidenceExpired ? "failed" : input.state;
      const updated = await transaction.quarantine_attempts.updateMany({
        where: {
          id: input.attemptId,
          organization_id: input.organizationId,
          quarantine_id: input.quarantineId,
          state: "running",
        },
        data: {
          source_record_id: row.sourceRecordId,
          state: effectiveState,
          failure_code: evidenceExpired ? "EVIDENCE_EXPIRED" : input.failureCode,
          field_path: evidenceExpired ? null : input.fieldPath,
          sanitized_summary: evidenceExpired
            ? "Retained source evidence expired before retry completion."
            : input.sanitizedSummary,
          canonical_revision_count: evidenceExpired
            ? 0
            : input.canonicalRevisionCount,
          finished_at: input.completedAt,
        },
      });
      if (updated.count === 0) {
        return this.getEntryFrom(
          transaction,
          input.organizationId,
          input.quarantineId,
          input.completedAt,
        );
      }
      if (evidenceExpired) {
        await this.markExpired(
          transaction,
          input.quarantineId,
          input.organizationId,
          input.completedAt,
        );
      } else if (input.state === "succeeded") {
        await transaction.quarantine_records.updateMany({
          where: {
            organization_id: input.organizationId,
            id: input.quarantineId,
            state: "open",
          },
          data: {
            state: "resolved",
            resolved_at: input.completedAt,
          },
        });
      }
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider.quarantine.retry",
          subject_type: "quarantine_record",
          subject_id: input.quarantineId,
          outcome: effectiveState === "succeeded" ? "success" : "failure",
          metadata_json: {
            attemptId: input.attemptId,
            result: effectiveState,
            failureCode: evidenceExpired
              ? "EVIDENCE_EXPIRED"
              : input.failureCode,
            canonicalRevisionCount: evidenceExpired
              ? 0
              : input.canonicalRevisionCount,
          },
          occurred_at: input.completedAt,
        },
      });
      return this.getEntryFrom(
        transaction,
        input.organizationId,
        input.quarantineId,
        input.completedAt,
      );
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private async loadEvidence(
    database: PackscoutQueryClient,
    organizationId: string,
    row: QuarantineRow,
    now: Date,
  ): Promise<PersistedProtectedQuarantineEvidence | null> {
    if (row.sourceRecordId) {
      const source = await database.source_records.findFirst({
        where: {
          organization_id: organizationId,
          provider_id: row.providerId,
          id: row.sourceRecordId,
        },
        select: {
          payload_json: true,
          record_kind: true,
          external_id: true,
          source_time: true,
          collected_at: true,
          expires_at: true,
        },
      });
      if (!source?.payload_json || source.expires_at <= now) return null;
      return {
        rawRecord: source.payload_json,
        organizationId,
        sourceRecordId: row.sourceRecordId,
        runId: row.runId,
        pageId: row.pageId,
        recordKind: row.recordKind,
        recordIndex: row.recordIndex,
        expiresAt: row.expiresAt,
        source: {
          platform: row.platformKey,
          recordKind: source.record_kind,
          recordIndex: row.recordIndex,
          externalId: source.external_id,
          collectedAt: source.collected_at.toISOString(),
          sourceTimestamp: source.source_time.toISOString(),
        },
        configuration: {
          providerId: row.providerId,
          configurationRevisionId: row.configurationRevisionId,
          platform: row.platformKey,
          adapterKey: row.adapterKey,
        },
      };
    }
    const page = await database.import_pages.findFirst({
      where: {
        organization_id: organizationId,
        id: row.pageId,
      },
      select: { payload_json: true, expires_at: true },
    });
    if (!page?.payload_json || page.expires_at <= now) return null;
    const rawRecord = this.recordFromPage(
      page.payload_json,
      row.recordKind,
      row.recordIndex,
    );
    if (rawRecord === undefined) return null;
    return {
      rawRecord,
      organizationId,
      sourceRecordId: null,
      runId: row.runId,
      pageId: row.pageId,
      recordKind: row.recordKind,
      recordIndex: row.recordIndex,
      expiresAt: row.expiresAt,
      source: null,
      configuration: {
        providerId: row.providerId,
        configurationRevisionId: row.configurationRevisionId,
        platform: row.platformKey,
        adapterKey: row.adapterKey,
      },
    };
  }

  private recordFromPage(payload: unknown, kind: RecordKind, index: number): unknown {
    if (typeof payload !== "object" || payload === null) return undefined;
    const key = kind === "catalog" ? "catalog" : kind === "pull" ? "pulls" : "sales";
    const group = key in payload ? payload[key as keyof typeof payload] : undefined;
    return Array.isArray(group) ? group[index] : undefined;
  }

  private async markExpired(
    database: PackscoutQueryClient,
    quarantineId: string,
    organizationId: string,
    expiredAt: Date,
  ): Promise<void> {
    const record = await database.quarantine_records.findFirst({
      where: { organization_id: organizationId, id: quarantineId },
      select: { page_id: true, source_record_id: true },
    });
    if (!record) return;
    await database.quarantine_records.updateMany({
      where: {
        organization_id: organizationId,
        id: quarantineId,
        state: "open",
      },
      data: {
        state: "expired",
        payload_json: Prisma.DbNull,
        payload_expired_at: expiredAt,
      },
    });
    await database.import_pages.updateMany({
      where: {
        organization_id: organizationId,
        id: record.page_id,
        expires_at: { lte: expiredAt },
      },
      data: {
        payload_json: Prisma.DbNull,
        payload_expired_at: expiredAt,
      },
    });
    if (record.source_record_id) {
      await database.source_records.updateMany({
        where: {
          organization_id: organizationId,
          id: record.source_record_id,
          expires_at: { lte: expiredAt },
        },
        data: {
          payload_json: Prisma.DbNull,
          payload_expired_at: expiredAt,
        },
      });
    }
  }

  private async getEntryFrom(
    database: PackscoutQueryClient,
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<PersistedQuarantineEntry | null> {
    const row = await this.loadRow(database, organizationId, quarantineId);
    return row ? this.toEntry(database, row, now) : null;
  }

  private async loadRow(
    database: PackscoutQueryClient,
    organizationId: string,
    quarantineId: string,
  ): Promise<QuarantineRow | null> {
    const rows = await database.$queryRaw<QuarantineRow[]>(Prisma.sql`
      ${this.quarantineSelection()}
      where quarantine.organization_id = ${uuid(organizationId)}
        and quarantine.id = ${uuid(quarantineId)}
      limit 1
    `);
    return rows[0] ?? null;
  }

  private async toEntry(
    database: PackscoutQueryClient,
    row: QuarantineRow,
    now: Date,
  ): Promise<PersistedQuarantineEntry> {
    const [running, resolved] = await Promise.all([
      database.quarantine_attempts.findFirst({
        where: {
          organization_id: row.organizationId,
          quarantine_id: row.id,
          state: "running",
        },
        select: { id: true },
      }),
      database.quarantine_attempts.findFirst({
        where: {
          organization_id: row.organizationId,
          quarantine_id: row.id,
          state: "succeeded",
        },
        orderBy: [{ finished_at: "desc" }, { id: "desc" }],
        select: { sanitized_summary: true },
      }),
    ]);
    const state: QuarantineState =
      row.state === "resolved"
        ? "resolved"
        : row.state === "expired" || row.expiresAt <= now
          ? "expired"
          : running
            ? "retrying"
            : "open";
    return {
      ...row,
      state,
      resolutionSummary: resolved?.sanitized_summary ?? null,
    };
  }

  private quarantineSelection(): Prisma.Sql {
    return Prisma.sql`
      select
        quarantine.id,
        quarantine.organization_id as "organizationId",
        quarantine.provider_id as "providerId",
        run.config_revision_id as "configurationRevisionId",
        provider.platform_key as "platformKey",
        revision.adapter_key as "adapterKey",
        quarantine.run_id as "runId",
        quarantine.page_id as "pageId",
        quarantine.source_record_id as "sourceRecordId",
        quarantine.record_kind as "recordKind",
        quarantine.record_index as "recordIndex",
        quarantine.external_id as "externalId",
        quarantine.reason_code as "reasonCode",
        quarantine.field_path as "fieldPath",
        quarantine.sanitized_summary as "sanitizedSummary",
        quarantine.state,
        quarantine.retry_count as "retryCount",
        quarantine.created_at as "createdAt",
        quarantine.last_retry_at as "lastRetryAt",
        quarantine.expires_at as "expiresAt",
        quarantine.resolved_at as "resolvedAt"
      from public.quarantine_records as quarantine
      join public.import_runs as run
        on run.id = quarantine.run_id
       and run.organization_id = quarantine.organization_id
      join public.provider_sources as provider
        on provider.id = quarantine.provider_id
       and provider.organization_id = quarantine.organization_id
      join public.provider_config_revisions as revision
        on revision.id = run.config_revision_id
       and revision.organization_id = run.organization_id
    `;
  }
}
