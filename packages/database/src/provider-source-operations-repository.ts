import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

export type ProviderSourceOperationsRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed";

export type ProviderSourceOperationsRunTrigger =
  | "scheduled"
  | "manual"
  | "continuation"
  | "recovery";

export interface ProviderSourceOperationsCountersRecord {
  readonly pages: number;
  readonly records: number;
  readonly catalog: number;
  readonly pulls: number;
  readonly trades: number;
  readonly inserted: number;
  readonly revised: number;
  readonly duplicate: number;
  readonly quarantined: number;
}

export interface ProviderSourceOperationsRunRecord {
  readonly id: string;
  readonly sourceInstanceId: string;
  readonly trigger: ProviderSourceOperationsRunTrigger;
  readonly state: ProviderSourceOperationsRunState;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly lastProgressAt: Date;
  readonly reachedHead: boolean;
  readonly failureCode: string | null;
  readonly counters: ProviderSourceOperationsCountersRecord;
}

export interface ProviderSourceOperationsSourceFacts {
  readonly sourceInstanceId: string;
  readonly health: Readonly<{
    lastAttemptedAt: Date | null;
    lastHeadReachedAt: Date | null;
    consecutiveFailures: number;
    latestFailureCode: string | null;
    recoveredAt: Date | null;
  }> | null;
  readonly activeRun: ProviderSourceOperationsRunRecord | null;
  readonly latestRun: ProviderSourceOperationsRunRecord | null;
  readonly openQuarantine: number;
}

export interface ProviderSourceOperationsOverviewRecord {
  readonly providers: readonly Readonly<{
    providerId: string;
    provider: string;
    displayName: string;
  }>[];
  readonly sources: readonly ProviderSourceOperationsSourceFacts[];
  readonly connectionEpisodes: readonly Readonly<{
    connectionProfileId: string;
    safeCode: string;
    openedAt: Date;
  }>[];
}

export interface ProviderSourceOperationsPageRecord {
  readonly runId: string;
  readonly pageNumber: number;
  readonly committedAt: Date;
  readonly records: ProviderSourceOperationsCountersRecord;
  readonly continuation: Readonly<{
    kind: "continue" | "poll_after";
    minimumDelaySeconds?: number;
  }> | null;
  readonly cursorFingerprint: string | null;
}

export interface ProviderSourceOperationsDetailRecord {
  readonly runs: readonly ProviderSourceOperationsRunRecord[];
  readonly pages: readonly ProviderSourceOperationsPageRecord[];
}

interface QuarantineCountRow {
  readonly sourceInstanceId: string;
  readonly total: bigint;
}

function boundedCounter(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : 0;
}

function counters(value: unknown): ProviderSourceOperationsCountersRecord {
  return {
    pages: boundedCounter(value, "pages"),
    records: boundedCounter(value, "records"),
    catalog: boundedCounter(value, "catalog"),
    pulls: boundedCounter(value, "pulls"),
    trades: boundedCounter(value, "trades"),
    inserted: boundedCounter(value, "inserted"),
    revised: boundedCounter(value, "revised"),
    duplicate: boundedCounter(value, "duplicate"),
    quarantined: boundedCounter(value, "quarantined"),
  };
}

function latestDate(values: readonly (Date | null)[]): Date {
  const dates = values.filter((value): value is Date => value instanceof Date);
  return dates.slice(1).reduce(
    (latest, value) => value > latest ? value : latest,
    dates[0]!,
  );
}

type RunRow = Awaited<ReturnType<
  PackscoutPrismaClient["import_runs"]["findFirst"]
>>;

function runRecord(row: NonNullable<RunRow>): ProviderSourceOperationsRunRecord {
  if (row.source_instance_id === null) {
    throw new TypeError("Source operation run is missing source ownership.");
  }
  return {
    id: row.id,
    sourceInstanceId: row.source_instance_id,
    trigger: row.trigger,
    state: row.state,
    requestedAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastProgressAt: latestDate([
      row.created_at,
      row.started_at,
      row.heartbeat_at,
      row.finished_at,
    ]),
    reachedHead: row.reached_provider_head,
    failureCode: row.failure_code,
    counters: counters(row.counters_json),
  };
}

function uuidList(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}::uuid`));
}

/** Source-neutral reads for the Task008 monitoring service. */
export class ProviderSourceOperationsRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async readOverview(input: Readonly<{
    organizationId: string;
    providerIds: readonly string[];
    sourceInstanceIds: readonly string[];
    connectionProfileIds: readonly string[];
  }>): Promise<ProviderSourceOperationsOverviewRecord> {
    const uniqueProviders = [...new Set(input.providerIds)];
    const uniqueSources = [...new Set(input.sourceInstanceIds)];
    const uniqueProfiles = [...new Set(input.connectionProfileIds)];
    const [providers, health, activeRuns, latestRuns, quarantines, episodes] =
      await Promise.all([
        this.database.provider_sources.findMany({
          where: {
            organization_id: input.organizationId,
            id: { in: uniqueProviders },
          },
          orderBy: [{ platform_key: "asc" }, { id: "asc" }],
          select: { id: true, platform_key: true, display_name: true },
        }),
        uniqueSources.length === 0
          ? Promise.resolve([])
          : this.database.provider_source_health_states.findMany({
              where: {
                organization_id: input.organizationId,
                source_instance_id: { in: uniqueSources },
              },
            }),
        Promise.all(uniqueSources.map((sourceInstanceId) =>
          this.database.import_runs.findFirst({
            where: {
              organization_id: input.organizationId,
              source_instance_id: sourceInstanceId,
              state: { in: ["queued", "running"] },
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        )),
        Promise.all(uniqueSources.map((sourceInstanceId) =>
          this.database.import_runs.findFirst({
            where: {
              organization_id: input.organizationId,
              source_instance_id: sourceInstanceId,
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        )),
        uniqueSources.length === 0
          ? Promise.resolve([])
          : this.database.$queryRaw<QuarantineCountRow[]>(Prisma.sql`
              select runs.source_instance_id as "sourceInstanceId",
                     count(*) as total
              from public.quarantine_records as quarantine
              join public.import_runs as runs
                on runs.id = quarantine.run_id
               and runs.organization_id = quarantine.organization_id
              where quarantine.organization_id = ${input.organizationId}::uuid
                and runs.source_instance_id in (${uuidList(uniqueSources)})
                and quarantine.state = 'open'::public.quarantine_state
              group by runs.source_instance_id
            `),
        uniqueProfiles.length === 0
          ? Promise.resolve([])
          : this.database.source_connection_health_episodes.findMany({
              where: {
                organization_id: input.organizationId,
                connection_profile_id: { in: uniqueProfiles },
                closed_at: null,
              },
              orderBy: [{ opened_at: "desc" }, { id: "desc" }],
              select: {
                connection_profile_id: true,
                safe_code: true,
                opened_at: true,
              },
            }),
      ]);

    return {
      providers: providers.map((provider) => ({
        providerId: provider.id,
        provider: provider.platform_key,
        displayName: provider.display_name,
      })),
      sources: uniqueSources.map((sourceInstanceId, index) => {
        const sourceHealth = health.find(
          (candidate) => candidate.source_instance_id === sourceInstanceId,
        );
        const active = activeRuns[index];
        const latest = latestRuns[index];
        return {
          sourceInstanceId,
          health: sourceHealth
            ? {
                lastAttemptedAt: sourceHealth.last_attempted_at,
                lastHeadReachedAt: sourceHealth.last_head_reached_at,
                consecutiveFailures: sourceHealth.consecutive_failures,
                latestFailureCode: sourceHealth.latest_failure_code,
                recoveredAt: sourceHealth.recovered_at,
              }
            : null,
          activeRun: active ? runRecord(active) : null,
          latestRun: latest ? runRecord(latest) : null,
          openQuarantine: Number(
            quarantines.find(
              (candidate) => candidate.sourceInstanceId === sourceInstanceId,
            )?.total ?? 0n,
          ),
        };
      }),
      connectionEpisodes: episodes.map((episode) => ({
        connectionProfileId: episode.connection_profile_id,
        safeCode: episode.safe_code,
        openedAt: episode.opened_at,
      })),
    };
  }

  async readDetail(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
  }>): Promise<ProviderSourceOperationsDetailRecord | null> {
    const source = await this.database.provider_source_instances.findFirst({
      where: {
        id: input.sourceInstanceId,
        organization_id: input.organizationId,
        provider_id: input.providerId,
      },
      select: { id: true },
    });
    if (!source) return null;
    const [runs, pages] = await Promise.all([
      this.database.import_runs.findMany({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: input.sourceInstanceId,
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: 25,
      }),
      this.database.import_pages.findMany({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: input.sourceInstanceId,
        },
        orderBy: [{ committed_at: "desc" }, { id: "desc" }],
        take: 50,
        select: {
          run_id: true,
          page_number: true,
          committed_at: true,
          record_counts_json: true,
          continuation_kind: true,
          minimum_delay_seconds: true,
          next_cursor_fingerprint: true,
        },
      }),
    ]);
    return {
      runs: runs.map(runRecord),
      pages: pages.map((page) => ({
        runId: page.run_id,
        pageNumber: page.page_number,
        committedAt: page.committed_at,
        records: counters(page.record_counts_json),
        continuation: page.continuation_kind === null
          ? null
          : page.continuation_kind === "continue"
            ? { kind: "continue" as const }
            : {
                kind: "poll_after" as const,
                minimumDelaySeconds: page.minimum_delay_seconds ?? 0,
              },
        cursorFingerprint: page.next_cursor_fingerprint,
      })),
    };
  }
}
