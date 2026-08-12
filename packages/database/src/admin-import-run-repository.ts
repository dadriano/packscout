import { Prisma } from "@prisma/client";
import type {
  AdminImportPageRecord,
  AdminImportRunPage,
  AdminImportRunRecord,
  AdminImportRunState,
  AdminImportTrigger,
  AdminRunOperationCursor,
} from "./admin-operation-read-model.ts";
import type { PackscoutPrismaClient } from "./database.ts";

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

interface RevisionAggregate {
  readonly run_id?: string;
  readonly page_id?: string;
  readonly total: bigint;
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
    .reduce((total, row) => total + row.total, 0);
}

function latestDate(values: readonly (Date | null | undefined)[]): Date {
  return values
    .filter((value): value is Date => value instanceof Date)
    .reduce((latest, value) => value > latest ? value : latest);
}

function uuidList(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}::uuid`));
}

export class DrizzleAdminImportRunRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

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
    const rows = await this.runQuery({
      organization_id: input.organizationId,
      ...(input.providerId ? { provider_id: input.providerId } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.after
        ? {
            OR: [
              { created_at: { lt: input.after.requestedAt } },
              {
                created_at: input.after.requestedAt,
                id: { lt: input.after.runId },
              },
            ],
          }
        : {}),
    }, input.limit + 1);
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
    const rows = await this.runQuery({
      organization_id: input.organizationId,
      id: input.runId,
    }, 1);
    const [summary] = await this.hydrateSummaries(input.organizationId, rows);
    if (!summary) return null;
    return { ...summary, pages: await this.loadPages(input.organizationId, summary.id) };
  }

  private async runQuery(
    where: Prisma.import_runsWhereInput,
    limit: number,
  ): Promise<readonly RunRow[]> {
    const rows = await this.database.import_runs.findMany({
      where,
      select: {
        id: true,
        provider_id: true,
        config_revision_id: true,
        trigger: true,
        state: true,
        created_at: true,
        started_at: true,
        finished_at: true,
        heartbeat_at: true,
        reached_provider_head: true,
        failure_code: true,
        requested_cursor: true,
        final_cursor: true,
        provider_sources_import_runs_provider_idToprovider_sources: {
          select: { display_name: true, platform_key: true },
        },
        provider_config_revisions_import_runs_config_revision_idToprovider_config_revisions: {
          select: { version: true },
        },
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      providerName:
        row.provider_sources_import_runs_provider_idToprovider_sources.display_name,
      platformKey:
        row.provider_sources_import_runs_provider_idToprovider_sources.platform_key,
      configurationRevisionId: row.config_revision_id,
      configurationVersion:
        row.provider_config_revisions_import_runs_config_revision_idToprovider_config_revisions.version,
      trigger: row.trigger,
      state: row.state,
      requestedAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      heartbeatAt: row.heartbeat_at,
      reachedProviderHead: row.reached_provider_head,
      failureCode: row.failure_code,
      requestedCursor: row.requested_cursor,
      finalCursor: row.final_cursor,
    }));
  }

  private async hydrateSummaries(
    organizationId: string,
    runs: readonly RunRow[],
  ): Promise<readonly AdminImportRunRecord[]> {
    if (runs.length === 0) return [];
    const runIds = runs.map(({ id }) => id);
    const [pageTotals, outcomeGroups, revisions, resolvedGroups] = await Promise.all([
      this.database.import_pages.groupBy({
        by: ["run_id"],
        where: { organization_id: organizationId, run_id: { in: runIds } },
        _count: { _all: true },
        _max: { committed_at: true },
      }),
      this.database.source_record_outcomes.groupBy({
        by: ["run_id", "record_kind", "outcome"],
        where: { organization_id: organizationId, run_id: { in: runIds } },
        _count: { _all: true },
      }),
      this.database.$queryRaw<RevisionAggregate[]>(Prisma.sql`
        select outcomes.run_id, count(distinct outcomes.source_record_id) as total
        from source_record_outcomes as outcomes
        inner join source_record_projection_revisions as projections
          on projections.source_record_id = outcomes.source_record_id
         and projections.organization_id = outcomes.organization_id
        inner join canonical_revisions as revisions
          on revisions.id = projections.canonical_revision_id
         and revisions.organization_id = projections.organization_id
        where outcomes.organization_id = ${organizationId}::uuid
          and outcomes.run_id in (${uuidList(runIds)})
          and outcomes.outcome = 'accepted'::source_record_outcome
          and revisions.revision_number > 1
        group by outcomes.run_id
      `),
      this.database.quarantine_records.groupBy({
        by: ["run_id"],
        where: {
          organization_id: organizationId,
          run_id: { in: runIds },
          state: "resolved",
        },
        _count: { _all: true },
      }),
    ]);
    const outcomes: OutcomeAggregate[] = outcomeGroups.map((row) => ({
      runId: row.run_id,
      pageId: row.run_id,
      recordKind: row.record_kind,
      outcome: row.outcome,
      total: row._count._all,
    }));
    return runs.map((run) => {
      const pageTotal = pageTotals.find(({ run_id }) => run_id === run.id);
      const revisedTotal = Number(
        revisions.find(({ run_id }) => run_id === run.id)?.total ?? 0,
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
          pageTotal?._max.committed_at,
        ]),
        counters: {
          pages: pageTotal?._count._all ?? 0,
          catalog: aggregateTotal(outcomes, { runId: run.id, recordKind: "catalog" }),
          pulls: aggregateTotal(outcomes, { runId: run.id, recordKind: "pull" }),
          sales: aggregateTotal(outcomes, { runId: run.id, recordKind: "sale" }),
          accepted: Math.max(0, acceptedTotal - revisedTotal),
          unchanged: aggregateTotal(outcomes, { runId: run.id, outcome: "duplicate" }),
          revised: revisedTotal,
          quarantined: aggregateTotal(outcomes, { runId: run.id, outcome: "quarantined" }),
          resolvedQuarantines:
            resolvedGroups.find(({ run_id }) => run_id === run.id)?._count._all ?? 0,
        },
        pages: [],
      };
    });
  }

  private async loadPages(
    organizationId: string,
    runId: string,
  ): Promise<readonly AdminImportPageRecord[]> {
    const pageRows = await this.database.import_pages.findMany({
      where: { organization_id: organizationId, run_id: runId },
      select: {
        id: true,
        run_id: true,
        page_number: true,
        requested_cursor: true,
        next_cursor: true,
        has_more: true,
        committed_at: true,
      },
      orderBy: { page_number: "asc" },
      take: 100,
    });
    const pages: PageRow[] = pageRows.map((page) => ({
      id: page.id,
      runId: page.run_id,
      pageNumber: page.page_number,
      requestedCursor: page.requested_cursor,
      nextCursor: page.next_cursor,
      hasMore: page.has_more,
      committedAt: page.committed_at,
    }));
    if (pages.length === 0) return [];
    const pageIds = pages.map(({ id }) => id);
    const [outcomeGroups, revisions] = await Promise.all([
      this.database.source_record_outcomes.groupBy({
        by: ["run_id", "page_id", "record_kind", "outcome"],
        where: {
          organization_id: organizationId,
          run_id: runId,
          page_id: { in: pageIds },
        },
        _count: { _all: true },
      }),
      this.database.$queryRaw<RevisionAggregate[]>(Prisma.sql`
        select outcomes.page_id, count(distinct outcomes.source_record_id) as total
        from source_record_outcomes as outcomes
        inner join source_record_projection_revisions as projections
          on projections.source_record_id = outcomes.source_record_id
         and projections.organization_id = outcomes.organization_id
        inner join canonical_revisions as revisions
          on revisions.id = projections.canonical_revision_id
         and revisions.organization_id = projections.organization_id
        where outcomes.organization_id = ${organizationId}::uuid
          and outcomes.run_id = ${runId}::uuid
          and outcomes.page_id in (${uuidList(pageIds)})
          and outcomes.outcome = 'accepted'::source_record_outcome
          and revisions.revision_number > 1
        group by outcomes.page_id
      `),
    ]);
    const outcomes: OutcomeAggregate[] = outcomeGroups.map((row) => ({
      runId: row.run_id,
      pageId: row.page_id,
      recordKind: row.record_kind,
      outcome: row.outcome,
      total: row._count._all,
    }));
    return pages.map((page) => {
      const acceptedTotal = aggregateTotal(outcomes, {
        runId,
        pageId: page.id,
        outcome: "accepted",
      });
      const revisedTotal = Number(
        revisions.find(({ page_id }) => page_id === page.id)?.total ?? 0,
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
