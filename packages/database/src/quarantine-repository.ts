import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { quarantineAttempts } from "./schema/quarantine-retry.ts";
import {
  auditEvents,
  importPages,
  importRuns,
  providerConfigRevisions,
  providerSources,
  quarantineRecords,
  sourceRecords,
} from "./schema/index.ts";

type QuarantineState = "open" | "retrying" | "resolved" | "expired";
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
  state: "open" | "resolved" | "expired";
  retryCount: number;
  createdAt: Date;
  lastRetryAt: Date | null;
  expiresAt: Date;
  resolvedAt: Date | null;
}

export class DrizzleQuarantineRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

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
    const filters = [eq(quarantineRecords.organizationId, organizationId)];
    if (query.providerId) filters.push(eq(quarantineRecords.providerId, query.providerId));
    if (query.runId) filters.push(eq(quarantineRecords.runId, query.runId));
    if (query.recordKind) filters.push(eq(quarantineRecords.recordKind, query.recordKind));
    if (query.reasonCode) filters.push(eq(quarantineRecords.reasonCode, query.reasonCode));
    const runningAttempt = sql`exists (
      select 1
      from ${quarantineAttempts}
      where ${quarantineAttempts.organizationId} = ${quarantineRecords.organizationId}
        and ${quarantineAttempts.quarantineId} = ${quarantineRecords.id}
        and ${quarantineAttempts.state} = 'running'
    )`;
    if (query.state === "resolved") filters.push(eq(quarantineRecords.state, "resolved"));
    if (query.state === "expired") {
      filters.push(sql`(${quarantineRecords.state} = 'expired' or (${quarantineRecords.state} = 'open' and ${quarantineRecords.expiresAt} <= ${now}))`);
    }
    if (query.state === "open") {
      filters.push(eq(quarantineRecords.state, "open"));
      filters.push(sql`${quarantineRecords.expiresAt} > ${now}`);
      filters.push(sql`not (${runningAttempt})`);
    }
    if (query.state === "retrying") {
      filters.push(eq(quarantineRecords.state, "open"));
      filters.push(sql`${quarantineRecords.expiresAt} > ${now}`);
      filters.push(runningAttempt);
    }
    if (query.before) {
      filters.push(
        or(
          lt(quarantineRecords.createdAt, query.before.createdAt),
          and(
            eq(quarantineRecords.createdAt, query.before.createdAt),
            lt(quarantineRecords.id, query.before.id),
          ),
        )!,
      );
    }
    const rows = await this.database
      .select(this.selection())
      .from(quarantineRecords)
      .innerJoin(
        importRuns,
        and(
          eq(importRuns.id, quarantineRecords.runId),
          eq(importRuns.organizationId, quarantineRecords.organizationId),
        ),
      )
      .innerJoin(
        providerSources,
        and(
          eq(providerSources.id, quarantineRecords.providerId),
          eq(providerSources.organizationId, quarantineRecords.organizationId),
        ),
      )
      .innerJoin(
        providerConfigRevisions,
        and(
          eq(providerConfigRevisions.id, importRuns.configRevisionId),
          eq(providerConfigRevisions.organizationId, importRuns.organizationId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(quarantineRecords.createdAt), desc(quarantineRecords.id))
      .limit(query.limit + 1);
    const entries: PersistedQuarantineEntry[] = [];
    for (const row of rows.slice(0, query.limit)) {
      const entry = await this.toEntry(this.database, row, now);
      entries.push(entry);
    }
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
    return this.database
      .select({
        id: quarantineAttempts.id,
        state: quarantineAttempts.state,
        failureCode: quarantineAttempts.failureCode,
        fieldPath: quarantineAttempts.fieldPath,
        sanitizedSummary: quarantineAttempts.sanitizedSummary,
        canonicalRevisionCount: quarantineAttempts.canonicalRevisionCount,
        startedAt: quarantineAttempts.startedAt,
        finishedAt: quarantineAttempts.finishedAt,
      })
      .from(quarantineAttempts)
      .where(
        and(
          eq(quarantineAttempts.organizationId, organizationId),
          eq(quarantineAttempts.quarantineId, quarantineId),
        ),
      )
      .orderBy(desc(quarantineAttempts.startedAt), desc(quarantineAttempts.id))
      .limit(100);
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
    const runningAttempt = sql`exists (
      select 1
      from ${quarantineAttempts}
      where ${quarantineAttempts.organizationId} = ${quarantineRecords.organizationId}
        and ${quarantineAttempts.quarantineId} = ${quarantineRecords.id}
        and ${quarantineAttempts.state} = 'running'
    )`;
    const [counts] = await this.database
      .select({
        outstanding: sql<number>`cast(count(*) filter (
          where ${quarantineRecords.state} = 'open'
            and ${quarantineRecords.expiresAt} > ${now}
            and not (${runningAttempt})
        ) as integer)`,
        retrying: sql<number>`cast(count(*) filter (
          where ${quarantineRecords.state} = 'open'
            and ${quarantineRecords.expiresAt} > ${now}
            and ${runningAttempt}
        ) as integer)`,
        resolved: sql<number>`cast(count(*) filter (
          where ${quarantineRecords.state} = 'resolved'
        ) as integer)`,
        expired: sql<number>`cast(count(*) filter (
          where ${quarantineRecords.state} = 'expired'
            or (${quarantineRecords.state} = 'open' and ${quarantineRecords.expiresAt} <= ${now})
        ) as integer)`,
      })
      .from(quarantineRecords)
      .where(eq(quarantineRecords.organizationId, organizationId));
    return counts ?? { outstanding: 0, retrying: 0, resolved: 0, expired: 0 };
  }

  async claimRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    claimedAt: Date;
  }): Promise<PersistedQuarantineClaimResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${quarantineRecords} where ${quarantineRecords.id} = ${input.quarantineId} and ${quarantineRecords.organizationId} = ${input.organizationId} for update`,
      );
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
      await transaction.insert(quarantineAttempts).values({
        id: input.attemptId,
        organizationId: input.organizationId,
        quarantineId: input.quarantineId,
        sourceRecordId: row.sourceRecordId,
        state: "running",
        requestedByActorKey: input.actorKey,
        startedAt: input.claimedAt,
      });
      await transaction
        .update(quarantineRecords)
        .set({
          retryCount: sql`${quarantineRecords.retryCount} + 1`,
          lastRetryAt: input.claimedAt,
        })
        .where(
          and(
            eq(quarantineRecords.organizationId, input.organizationId),
            eq(quarantineRecords.id, input.quarantineId),
          ),
        );
      const claimed = await this.getEntryFrom(
        transaction,
        input.organizationId,
        input.quarantineId,
        input.claimedAt,
      );
      if (!claimed) throw new Error("Claimed quarantine entry could not be loaded.");
      return { kind: "claimed", attemptId: input.attemptId, entry: claimed, evidence };
    });
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
    if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 10_000) {
      throw new RangeError("Quarantine expiry batch size is invalid.");
    }
    return this.database.transaction(async (transaction) => {
      const records = await transaction
        .select({
          id: quarantineRecords.id,
          state: quarantineRecords.state,
          sourceRecordId: quarantineRecords.sourceRecordId,
          pageId: quarantineRecords.pageId,
        })
        .from(quarantineRecords)
        .where(
          and(
            eq(quarantineRecords.organizationId, input.organizationId),
            ne(quarantineRecords.state, "expired"),
            lte(quarantineRecords.expiresAt, input.before),
            notExists(
              transaction
                .select({ id: quarantineAttempts.id })
                .from(quarantineAttempts)
                .where(
                  and(
                    eq(quarantineAttempts.quarantineId, quarantineRecords.id),
                    eq(quarantineAttempts.state, "running"),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(quarantineRecords.expiresAt), asc(quarantineRecords.id))
        .limit(input.batchSize)
        .for("update", { skipLocked: true });
      if (records.length === 0) return 0;
      const quarantineIds = records.map(({ id }) => id);
      await transaction
        .update(quarantineRecords)
        .set({ payloadJson: null, payloadExpiredAt: input.expiredAt })
        .where(inArray(quarantineRecords.id, quarantineIds));
      const unresolvedIds = records
        .filter(({ state }) => state === "open")
        .map(({ id }) => id);
      if (unresolvedIds.length > 0) {
        await transaction
          .update(quarantineRecords)
          .set({ state: "expired" })
          .where(inArray(quarantineRecords.id, unresolvedIds));
      }
      const sourceIds = records
        .flatMap(({ sourceRecordId }) => sourceRecordId ? [sourceRecordId] : []);
      if (sourceIds.length > 0) {
        await transaction
          .update(sourceRecords)
          .set({ payloadJson: null, payloadExpiredAt: input.expiredAt })
          .where(
            and(
              eq(sourceRecords.organizationId, input.organizationId),
              inArray(sourceRecords.id, sourceIds),
            ),
          );
      }
      await transaction
        .update(importPages)
        .set({ payloadJson: null, payloadExpiredAt: input.expiredAt })
        .where(
          and(
            eq(importPages.organizationId, input.organizationId),
            inArray(importPages.id, records.map(({ pageId }) => pageId)),
          ),
        );
      return records.length;
    });
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
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${quarantineRecords} where ${quarantineRecords.id} = ${input.quarantineId} and ${quarantineRecords.organizationId} = ${input.organizationId} for update`,
      );
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
      const [attempt] = await transaction
        .update(quarantineAttempts)
        .set({
          sourceRecordId: row.sourceRecordId,
          state: effectiveState,
          failureCode: evidenceExpired ? "EVIDENCE_EXPIRED" : input.failureCode,
          fieldPath: evidenceExpired ? null : input.fieldPath,
          sanitizedSummary: evidenceExpired
            ? "Retained source evidence expired before retry completion."
            : input.sanitizedSummary,
          canonicalRevisionCount: evidenceExpired ? 0 : input.canonicalRevisionCount,
          finishedAt: input.completedAt,
        })
        .where(
          and(
            eq(quarantineAttempts.id, input.attemptId),
            eq(quarantineAttempts.organizationId, input.organizationId),
            eq(quarantineAttempts.quarantineId, input.quarantineId),
            eq(quarantineAttempts.state, "running"),
          ),
        )
        .returning({ id: quarantineAttempts.id });
      if (!attempt) {
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
        await transaction
          .update(quarantineRecords)
          .set({ state: "resolved", resolvedAt: input.completedAt })
          .where(
            and(
              eq(quarantineRecords.organizationId, input.organizationId),
              eq(quarantineRecords.id, input.quarantineId),
              eq(quarantineRecords.state, "open"),
            ),
          );
      }
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "provider.quarantine.retry",
        subjectType: "quarantine_record",
        subjectId: input.quarantineId,
        outcome: effectiveState === "succeeded" ? "success" : "failure",
        metadataJson: {
          attemptId: input.attemptId,
          result: effectiveState,
          failureCode: evidenceExpired ? "EVIDENCE_EXPIRED" : input.failureCode,
          canonicalRevisionCount: evidenceExpired ? 0 : input.canonicalRevisionCount,
        },
        occurredAt: input.completedAt,
      });
      return this.getEntryFrom(
        transaction,
        input.organizationId,
        input.quarantineId,
        input.completedAt,
      );
    });
  }

  private async loadEvidence(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    row: QuarantineRow,
    now: Date,
  ): Promise<PersistedProtectedQuarantineEvidence | null> {
    if (row.sourceRecordId) {
      const [source] = await database
        .select({
          payload: sourceRecords.payloadJson,
          recordKind: sourceRecords.recordKind,
          externalId: sourceRecords.externalId,
          sourceTime: sourceRecords.sourceTime,
          collectedAt: sourceRecords.collectedAt,
          expiresAt: sourceRecords.expiresAt,
        })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, organizationId),
            eq(sourceRecords.providerId, row.providerId),
            eq(sourceRecords.id, row.sourceRecordId),
          ),
        )
        .limit(1);
      if (!source?.payload || source.expiresAt <= now) return null;
      return {
        rawRecord: source.payload,
        organizationId,
        sourceRecordId: row.sourceRecordId,
        runId: row.runId,
        pageId: row.pageId,
        recordKind: row.recordKind,
        recordIndex: row.recordIndex,
        expiresAt: row.expiresAt,
        source: {
          platform: row.platformKey,
          recordKind: source.recordKind,
          recordIndex: row.recordIndex,
          externalId: source.externalId,
          collectedAt: source.collectedAt.toISOString(),
          sourceTimestamp: source.sourceTime.toISOString(),
        },
        configuration: {
          providerId: row.providerId,
          configurationRevisionId: row.configurationRevisionId,
          platform: row.platformKey,
          adapterKey: row.adapterKey,
        },
      };
    }
    const [page] = await database
      .select({ payload: importPages.payloadJson, expiresAt: importPages.expiresAt })
      .from(importPages)
      .where(
        and(
          eq(importPages.organizationId, organizationId),
          eq(importPages.id, row.pageId),
        ),
      )
      .limit(1);
    if (!page?.payload || page.expiresAt <= now) return null;
    const rawRecord = this.recordFromPage(
      page.payload,
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
    database: PackscoutDatabase<TQueryResult>,
    quarantineId: string,
    organizationId: string,
    expiredAt: Date,
  ): Promise<void> {
    const [record] = await database
      .select({
        pageId: quarantineRecords.pageId,
        sourceRecordId: quarantineRecords.sourceRecordId,
      })
      .from(quarantineRecords)
      .where(
        and(
          eq(quarantineRecords.organizationId, organizationId),
          eq(quarantineRecords.id, quarantineId),
        ),
      )
      .limit(1);
    if (!record) return;
    await database
      .update(quarantineRecords)
      .set({ state: "expired", payloadJson: null, payloadExpiredAt: expiredAt })
      .where(
        and(
          eq(quarantineRecords.organizationId, organizationId),
          eq(quarantineRecords.id, quarantineId),
          eq(quarantineRecords.state, "open"),
        ),
      );
    await database
      .update(importPages)
      .set({ payloadJson: null, payloadExpiredAt: expiredAt })
      .where(
        and(
          eq(importPages.organizationId, organizationId),
          eq(importPages.id, record.pageId),
          lte(importPages.expiresAt, expiredAt),
        ),
      );
    if (record.sourceRecordId) {
      await database
        .update(sourceRecords)
        .set({ payloadJson: null, payloadExpiredAt: expiredAt })
        .where(
          and(
            eq(sourceRecords.organizationId, organizationId),
            eq(sourceRecords.id, record.sourceRecordId),
            lte(sourceRecords.expiresAt, expiredAt),
          ),
        );
    }
  }

  private async getEntryFrom(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<PersistedQuarantineEntry | null> {
    const row = await this.loadRow(database, organizationId, quarantineId);
    return row ? this.toEntry(database, row, now) : null;
  }

  private async loadRow(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    quarantineId: string,
  ): Promise<QuarantineRow | null> {
    const [row] = await database
      .select(this.selection())
      .from(quarantineRecords)
      .innerJoin(
        importRuns,
        and(
          eq(importRuns.id, quarantineRecords.runId),
          eq(importRuns.organizationId, quarantineRecords.organizationId),
        ),
      )
      .innerJoin(
        providerSources,
        and(
          eq(providerSources.id, quarantineRecords.providerId),
          eq(providerSources.organizationId, quarantineRecords.organizationId),
        ),
      )
      .innerJoin(
        providerConfigRevisions,
        and(
          eq(providerConfigRevisions.id, importRuns.configRevisionId),
          eq(providerConfigRevisions.organizationId, importRuns.organizationId),
        ),
      )
      .where(
        and(
          eq(quarantineRecords.organizationId, organizationId),
          eq(quarantineRecords.id, quarantineId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async toEntry(
    database: PackscoutDatabase<TQueryResult>,
    row: QuarantineRow,
    now: Date,
  ): Promise<PersistedQuarantineEntry> {
    const [running] = await database
      .select({ id: quarantineAttempts.id })
      .from(quarantineAttempts)
      .where(
        and(
          eq(quarantineAttempts.organizationId, row.organizationId),
          eq(quarantineAttempts.quarantineId, row.id),
          eq(quarantineAttempts.state, "running"),
        ),
      )
      .limit(1);
    const [resolved] = await database
      .select({ summary: quarantineAttempts.sanitizedSummary })
      .from(quarantineAttempts)
      .where(
        and(
          eq(quarantineAttempts.quarantineId, row.id),
          eq(quarantineAttempts.state, "succeeded"),
        ),
      )
      .orderBy(desc(quarantineAttempts.finishedAt))
      .limit(1);
    const state: QuarantineState =
      row.state === "resolved"
        ? "resolved"
        : row.state === "expired" || row.expiresAt <= now
          ? "expired"
          : running
            ? "retrying"
            : "open";
    return { ...row, state, resolutionSummary: resolved?.summary ?? null };
  }

  private selection() {
    return {
      id: quarantineRecords.id,
      organizationId: quarantineRecords.organizationId,
      providerId: quarantineRecords.providerId,
      configurationRevisionId: importRuns.configRevisionId,
      platformKey: providerSources.platformKey,
      adapterKey: providerConfigRevisions.adapterKey,
      runId: quarantineRecords.runId,
      pageId: quarantineRecords.pageId,
      sourceRecordId: quarantineRecords.sourceRecordId,
      recordKind: quarantineRecords.recordKind,
      recordIndex: quarantineRecords.recordIndex,
      externalId: quarantineRecords.externalId,
      reasonCode: quarantineRecords.reasonCode,
      fieldPath: quarantineRecords.fieldPath,
      sanitizedSummary: quarantineRecords.sanitizedSummary,
      state: quarantineRecords.state,
      retryCount: quarantineRecords.retryCount,
      createdAt: quarantineRecords.createdAt,
      lastRetryAt: quarantineRecords.lastRetryAt,
      expiresAt: quarantineRecords.expiresAt,
      resolvedAt: quarantineRecords.resolvedAt,
    };
  }
}
