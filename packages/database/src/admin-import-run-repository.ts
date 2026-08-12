import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  lt,
  max,
  or,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type {
  AdminImportPageRecord,
  AdminImportRunPage,
  AdminImportRunRecord,
  AdminImportRunState,
  AdminImportTrigger,
  AdminRunOperationCursor,
} from "./admin-operation-read-model.ts";
import type { PackscoutDatabase } from "./database.ts";
import {
  canonicalRevisions,
  importPages,
  importRuns,
  providerConfigRevisions,
  providerSources,
  quarantineRecords,
  sourceRecordOutcomes,
  sourceRecordProjectionRevisions,
} from "./schema/index.ts";

interface RunRow {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly configurationRevisionId: string;
  readonly configurationVersion: number;
  readonly trigger: AdminImportTrigger;
  readonly state: AdminImportRunState;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly reachedProviderHead: boolean;
  readonly failureCode: string | null;
  readonly requestedCursor: string | null;
  readonly finalCursor: string | null;
}

interface PageRow {
  readonly id: string;
  readonly runId: string;
  readonly pageNumber: number;
  readonly requestedCursor: string | null;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly committedAt: Date;
}

interface OutcomeAggregate {
  readonly runId: string;
  readonly pageId: string;
  readonly recordKind: "catalog" | "pull" | "sale";
  readonly outcome: "accepted" | "duplicate" | "quarantined";
  readonly total: number;
}

function aggregateTotal(
  rows: readonly OutcomeAggregate[],
  input: {
    readonly runId: string;
    readonly pageId?: string;
    readonly recordKind?: OutcomeAggregate["recordKind"];
    readonly outcome?: OutcomeAggregate["outcome"];
  },
): number {
  return rows
    .filter((row) =>
      row.runId === input.runId &&
      (input.pageId === undefined || row.pageId === input.pageId) &&
      (input.recordKind === undefined || row.recordKind === input.recordKind) &&
      (input.outcome === undefined || row.outcome === input.outcome),
    )
    .reduce((total, row) => total + Number(row.total), 0);
}

function latestDate(values: readonly (Date | null | undefined)[]): Date {
  return values
    .filter((value): value is Date => value instanceof Date)
    .reduce((latest, value) => value > latest ? value : latest);
}

export class DrizzleAdminImportRunRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async listPage(input: {
    readonly organizationId: string;
    readonly after?: AdminRunOperationCursor;
    readonly limit: number;
    readonly providerId?: string;
    readonly state?: AdminImportRunState;
    readonly trigger?: AdminImportTrigger;
  }): Promise<AdminImportRunPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new RangeError("Import run page limit is invalid.");
    }
    const filters = [eq(importRuns.organizationId, input.organizationId)];
    if (input.providerId) filters.push(eq(importRuns.providerId, input.providerId));
    if (input.state) filters.push(eq(importRuns.state, input.state));
    if (input.trigger) filters.push(eq(importRuns.trigger, input.trigger));
    if (input.after) {
      filters.push(
        or(
          lt(importRuns.createdAt, input.after.requestedAt),
          and(
            eq(importRuns.createdAt, input.after.requestedAt),
            lt(importRuns.id, input.after.runId),
          ),
        )!,
      );
    }
    const rows = await this.runQuery(filters, input.limit + 1);
    return {
      items: await this.hydrateSummaries(
        input.organizationId,
        rows.slice(0, input.limit),
      ),
      hasMore: rows.length > input.limit,
    };
  }

  async get(input: {
    readonly organizationId: string;
    readonly runId: string;
  }): Promise<AdminImportRunRecord | null> {
    const rows = await this.runQuery([
      eq(importRuns.organizationId, input.organizationId),
      eq(importRuns.id, input.runId),
    ], 1);
    const [summary] = await this.hydrateSummaries(input.organizationId, rows);
    if (!summary) return null;
    return { ...summary, pages: await this.loadPages(input.organizationId, summary.id) };
  }

  private runQuery(filters: Parameters<typeof and>, limit: number) {
    return this.database
      .select({
        id: importRuns.id,
        providerId: importRuns.providerId,
        providerName: providerSources.displayName,
        platformKey: providerSources.platformKey,
        configurationRevisionId: importRuns.configRevisionId,
        configurationVersion: providerConfigRevisions.version,
        trigger: importRuns.trigger,
        state: importRuns.state,
        requestedAt: importRuns.createdAt,
        startedAt: importRuns.startedAt,
        finishedAt: importRuns.finishedAt,
        heartbeatAt: importRuns.heartbeatAt,
        reachedProviderHead: importRuns.reachedProviderHead,
        failureCode: importRuns.failureCode,
        requestedCursor: importRuns.requestedCursor,
        finalCursor: importRuns.finalCursor,
      })
      .from(importRuns)
      .innerJoin(
        providerSources,
        and(
          eq(providerSources.id, importRuns.providerId),
          eq(providerSources.organizationId, importRuns.organizationId),
        ),
      )
      .innerJoin(
        providerConfigRevisions,
        and(
          eq(providerConfigRevisions.id, importRuns.configRevisionId),
          eq(providerConfigRevisions.providerId, importRuns.providerId),
          eq(providerConfigRevisions.organizationId, importRuns.organizationId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
      .limit(limit);
  }

  private async hydrateSummaries(
    organizationId: string,
    runs: readonly RunRow[],
  ): Promise<readonly AdminImportRunRecord[]> {
    if (runs.length === 0) return [];
    const runIds = runs.map(({ id }) => id);
    const [pageTotals, outcomes, revisions, resolved] = await Promise.all([
      this.database
        .select({
          runId: importPages.runId,
          total: count(),
          lastCommittedAt: max(importPages.committedAt),
        })
        .from(importPages)
        .where(
          and(
            eq(importPages.organizationId, organizationId),
            inArray(importPages.runId, runIds),
          ),
        )
        .groupBy(importPages.runId),
      this.database
        .select({
          runId: sourceRecordOutcomes.runId,
          pageId: sourceRecordOutcomes.runId,
          recordKind: sourceRecordOutcomes.recordKind,
          outcome: sourceRecordOutcomes.outcome,
          total: count(),
        })
        .from(sourceRecordOutcomes)
        .where(
          and(
            eq(sourceRecordOutcomes.organizationId, organizationId),
            inArray(sourceRecordOutcomes.runId, runIds),
          ),
        )
        .groupBy(
          sourceRecordOutcomes.runId,
          sourceRecordOutcomes.recordKind,
          sourceRecordOutcomes.outcome,
        ),
      this.database
        .select({
          runId: sourceRecordOutcomes.runId,
          total: countDistinct(sourceRecordOutcomes.sourceRecordId),
        })
        .from(sourceRecordOutcomes)
        .innerJoin(
          sourceRecordProjectionRevisions,
          and(
            eq(
              sourceRecordProjectionRevisions.sourceRecordId,
              sourceRecordOutcomes.sourceRecordId,
            ),
            eq(
              sourceRecordProjectionRevisions.organizationId,
              sourceRecordOutcomes.organizationId,
            ),
          ),
        )
        .innerJoin(
          canonicalRevisions,
          and(
            eq(
              canonicalRevisions.id,
              sourceRecordProjectionRevisions.canonicalRevisionId,
            ),
            eq(
              canonicalRevisions.organizationId,
              sourceRecordProjectionRevisions.organizationId,
            ),
          ),
        )
        .where(
          and(
            eq(sourceRecordOutcomes.organizationId, organizationId),
            inArray(sourceRecordOutcomes.runId, runIds),
            eq(sourceRecordOutcomes.outcome, "accepted"),
            gt(canonicalRevisions.revisionNumber, 1),
          ),
        )
        .groupBy(sourceRecordOutcomes.runId),
      this.database
        .select({ runId: quarantineRecords.runId, total: count() })
        .from(quarantineRecords)
        .where(
          and(
            eq(quarantineRecords.organizationId, organizationId),
            inArray(quarantineRecords.runId, runIds),
            eq(quarantineRecords.state, "resolved"),
          ),
        )
        .groupBy(quarantineRecords.runId),
    ]);
    return runs.map((run) => {
      const pageTotal = pageTotals.find(({ runId }) => runId === run.id);
      const revisedTotal = Number(
        revisions.find(({ runId }) => runId === run.id)?.total ?? 0,
      );
      const acceptedTotal = aggregateTotal(outcomes, {
        runId: run.id,
        outcome: "accepted",
      });
      return {
        ...run,
        lastProgressAt: latestDate([
          run.requestedAt,
          run.startedAt,
          run.heartbeatAt,
          pageTotal?.lastCommittedAt,
        ]),
        counters: {
          pages: Number(pageTotal?.total ?? 0),
          catalog: aggregateTotal(outcomes, { runId: run.id, recordKind: "catalog" }),
          pulls: aggregateTotal(outcomes, { runId: run.id, recordKind: "pull" }),
          sales: aggregateTotal(outcomes, { runId: run.id, recordKind: "sale" }),
          accepted: Math.max(0, acceptedTotal - revisedTotal),
          unchanged: aggregateTotal(outcomes, {
            runId: run.id,
            outcome: "duplicate",
          }),
          revised: revisedTotal,
          quarantined: aggregateTotal(outcomes, {
            runId: run.id,
            outcome: "quarantined",
          }),
          resolvedQuarantines: Number(
            resolved.find(({ runId }) => runId === run.id)?.total ?? 0,
          ),
        },
        pages: [],
      };
    });
  }

  private async loadPages(
    organizationId: string,
    runId: string,
  ): Promise<readonly AdminImportPageRecord[]> {
    const pages = await this.database
      .select({
        id: importPages.id,
        runId: importPages.runId,
        pageNumber: importPages.pageNumber,
        requestedCursor: importPages.requestedCursor,
        nextCursor: importPages.nextCursor,
        hasMore: importPages.hasMore,
        committedAt: importPages.committedAt,
      })
      .from(importPages)
      .where(
        and(
          eq(importPages.organizationId, organizationId),
          eq(importPages.runId, runId),
        ),
      )
      .orderBy(importPages.pageNumber)
      .limit(100);
    if (pages.length === 0) return [];
    const pageIds = pages.map(({ id }) => id);
    const [outcomes, revisions] = await Promise.all([
      this.database
        .select({
          runId: sourceRecordOutcomes.runId,
          pageId: sourceRecordOutcomes.pageId,
          recordKind: sourceRecordOutcomes.recordKind,
          outcome: sourceRecordOutcomes.outcome,
          total: count(),
        })
        .from(sourceRecordOutcomes)
        .where(
          and(
            eq(sourceRecordOutcomes.organizationId, organizationId),
            eq(sourceRecordOutcomes.runId, runId),
            inArray(sourceRecordOutcomes.pageId, pageIds),
          ),
        )
        .groupBy(
          sourceRecordOutcomes.runId,
          sourceRecordOutcomes.pageId,
          sourceRecordOutcomes.recordKind,
          sourceRecordOutcomes.outcome,
        ),
      this.database
        .select({
          pageId: sourceRecordOutcomes.pageId,
          total: countDistinct(sourceRecordOutcomes.sourceRecordId),
        })
        .from(sourceRecordOutcomes)
        .innerJoin(
          sourceRecordProjectionRevisions,
          and(
            eq(
              sourceRecordProjectionRevisions.sourceRecordId,
              sourceRecordOutcomes.sourceRecordId,
            ),
            eq(
              sourceRecordProjectionRevisions.organizationId,
              sourceRecordOutcomes.organizationId,
            ),
          ),
        )
        .innerJoin(
          canonicalRevisions,
          and(
            eq(
              canonicalRevisions.id,
              sourceRecordProjectionRevisions.canonicalRevisionId,
            ),
            eq(
              canonicalRevisions.organizationId,
              sourceRecordProjectionRevisions.organizationId,
            ),
          ),
        )
        .where(
          and(
            eq(sourceRecordOutcomes.organizationId, organizationId),
            eq(sourceRecordOutcomes.runId, runId),
            inArray(sourceRecordOutcomes.pageId, pageIds),
            eq(sourceRecordOutcomes.outcome, "accepted"),
            gt(canonicalRevisions.revisionNumber, 1),
          ),
        )
        .groupBy(sourceRecordOutcomes.pageId),
    ]);
    return pages.map((page: PageRow) => {
      const acceptedTotal = aggregateTotal(outcomes, {
        runId,
        pageId: page.id,
        outcome: "accepted",
      });
      const revisedTotal = Number(
        revisions.find(({ pageId }) => pageId === page.id)?.total ?? 0,
      );
      return {
        pageNumber: page.pageNumber,
        requestedCursor: page.requestedCursor,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        committedAt: page.committedAt,
        catalog: aggregateTotal(outcomes, { runId, pageId: page.id, recordKind: "catalog" }),
        pulls: aggregateTotal(outcomes, { runId, pageId: page.id, recordKind: "pull" }),
        sales: aggregateTotal(outcomes, { runId, pageId: page.id, recordKind: "sale" }),
        accepted: Math.max(0, acceptedTotal - revisedTotal),
        unchanged: aggregateTotal(outcomes, { runId, pageId: page.id, outcome: "duplicate" }),
        revised: revisedTotal,
        quarantined: aggregateTotal(outcomes, { runId, pageId: page.id, outcome: "quarantined" }),
      };
    });
  }
}
