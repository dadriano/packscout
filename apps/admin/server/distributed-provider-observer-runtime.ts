import {
  CentralMachineryAlertReadRepository,
  CentralWorkerPresenceRepository,
  PrismaAdminProviderRuntimeRepository,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type PrismaWorkerFleetReadRepository,
  type ProviderScheduleRecord,
  type RunningImportRunRecord,
  type WorkerFleetCursor,
} from "@packscout/database";
import {
  evaluateMachineryConditions,
  isScheduleWedged,
  WORKER_FLEET_SCAN_LIMIT,
  type MachineryRunStallFact,
  type MachineryScheduleFact,
} from "@packscout/contracts";
import type {
  MachineryAlertFactsSource,
  OperationalHealthRepository,
} from "@packscout/services";
import {
  evaluateFleetFrom,
  evaluateRunStallFor,
  readWorkerFleetSnapshot,
  toScheduleHealthView,
} from "./machinery-derivations.ts";

const PROVIDER_LIMIT = 50;

interface ProviderRoot {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
}

interface ProviderEvidence {
  readonly provider: ProviderRoot;
  readonly reachable: boolean;
  readonly runs: readonly RunningImportRunRecord[];
  readonly schedule: ProviderScheduleRecord | null;
}

function signal(run: RunningImportRunRecord): Date {
  return run.heartbeatAt ?? run.startedAt ?? new Date(0);
}

function afterCursor(
  at: Date,
  id: string,
  before: WorkerFleetCursor | undefined,
): boolean {
  if (!before) return true;
  return at.getTime() > before.at.getTime() ||
    (at.getTime() === before.at.getTime() && id > before.id);
}

function boundedPage<T>(
  items: readonly T[],
  limit: number,
): { readonly items: readonly T[]; readonly hasMore: boolean } {
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

async function mapBounded<T, U>(
  values: readonly T[],
  operation: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(4, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]!);
      }
    },
  ));
  return results;
}

/**
 * Bounded distributed evidence used by both the worker-fleet page and the
 * machinery alert cycle. Provider ownership always begins in central.
 */
export function createDistributedWorkerFleetEvidence(input: Readonly<{
  central: CentralPrismaClient;
  gateway: Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
}>): Pick<
  PrismaWorkerFleetReadRepository,
  "listRunningRuns" | "listSchedules"
> {
  async function roots(organizationId: string): Promise<readonly ProviderRoot[]> {
    const providers = await input.central.providers.findMany({
      where: {
        organization_id: organizationId,
        lifecycle: "active",
        active_config_version_id: { not: null },
      },
      orderBy: [{ provider_key: "asc" }, { id: "asc" }],
      take: PROVIDER_LIMIT,
      select: { id: true, provider_key: true, display_name: true },
    });
    return providers.map((provider) => ({
      id: provider.id,
      key: provider.provider_key,
      displayName: provider.display_name,
    }));
  }

  async function evidence(organizationId: string): Promise<readonly ProviderEvidence[]> {
    return mapBounded(await roots(organizationId), async (provider) => {
      const result = await input.gateway.runWithAdminProviderDatabase(
        { organizationId, providerId: provider.id },
        async (database) => {
          const repository = new PrismaAdminProviderRuntimeRepository(database);
          const [overview, page, lease] = await Promise.all([
            repository.overview(),
            repository.listRuns({
              snapshotAt: new Date(),
              limit: 50,
              state: "running",
            }),
            database.provider_worker_states.findUnique({
              where: { worker_role: "import" },
              select: {
                lease_owner: true,
                heartbeat_at: true,
                lease_expires_at: true,
              },
            }),
          ]);
          const runs: RunningImportRunRecord[] = page.items.map((run) => ({
            runId: run.id,
            providerId: provider.id,
            providerName: provider.displayName,
            platformKey: provider.key,
            trigger: run.trigger,
            state: "running",
            startedAt: run.startedAt,
            heartbeatAt: run.heartbeatAt,
            leaseOwner: lease?.lease_owner ?? null,
            leaseExpiresAt: lease?.lease_expires_at ?? null,
          }));
          const schedule: ProviderScheduleRecord | null = overview.nextDueAt === null
            ? null
            : {
                providerId: provider.id,
                providerName: provider.displayName,
                platformKey: provider.key,
                nextDueAt: overview.nextDueAt,
                claimOwner: overview.runtimeState === "running"
                  ? lease?.lease_owner ?? null
                  : null,
                claimExpiresAt: overview.runtimeState === "running"
                  ? lease?.lease_expires_at ?? null
                  : null,
                lastClaimedAt: lease?.heartbeat_at ?? null,
                lastOutcome: overview.latestRun?.state ?? null,
                lastRunId: overview.latestRun?.id ?? null,
              };
          return { runs, schedule };
        },
      );
      return result.state === "reachable"
        ? { provider, reachable: true, ...result.value }
        : { provider, reachable: false, runs: [], schedule: null };
    });
  }

  return {
    async listRunningRuns(request) {
      const records = (await evidence(request.organizationId))
        .flatMap((provider) => provider.runs)
        .filter((run) => afterCursor(signal(run), run.runId, request.before))
        .sort((left, right) =>
          signal(left).getTime() - signal(right).getTime() ||
          left.runId.localeCompare(right.runId)
        );
      return boundedPage(records, request.limit);
    },

    async listSchedules(request) {
      const records = (await evidence(request.organizationId))
        .flatMap((provider) => provider.schedule ? [provider.schedule] : [])
        .filter((schedule) =>
          afterCursor(schedule.nextDueAt, schedule.providerId, request.before)
        )
        .sort((left, right) =>
          left.nextDueAt.getTime() - right.nextDueAt.getTime() ||
          left.providerId.localeCompare(right.providerId)
        );
      return boundedPage(records, request.limit);
    },
  };
}

/** Central observer health: no provider connection string is selected here. */
export function createCentralObservedOperationalHealthRepository(
  central: CentralPrismaClient,
): OperationalHealthRepository {
  return {
    async loadSnapshot({ organizationId, checkedAt }) {
      const [providers, activeAlertCount] = await Promise.all([
        central.providers.findMany({
          where: {
            organization_id: organizationId,
            lifecycle: { not: "archived" },
            active_config_version_id: { not: null },
          },
          take: PROVIDER_LIMIT,
          select: {
            active_config_version: { select: { stale_after_seconds: true } },
            health: {
              where: { organization_id: organizationId },
              take: 1,
              select: {
                observed_state: true,
                quality_state: true,
                consecutive_failures: true,
                open_quarantine_count: true,
                latest_failure_code: true,
                mapping_warning_active: true,
                calculation_warning_active: true,
                observed_at: true,
              },
            },
          },
        }),
        central.admin_alerts.count({
          where: {
            organization_id: organizationId,
            state: { not: "resolved" },
          },
        }),
      ]);
      let staleProviderCount = 0;
      let degradedProviderCount = 0;
      let failedProviderCount = 0;
      for (const provider of providers) {
        const health = provider.health[0];
        const staleAfter = provider.active_config_version?.stale_after_seconds;
        if (
          health === undefined ||
          staleAfter === undefined ||
          checkedAt.getTime() - health.observed_at.getTime() > staleAfter * 1_000
        ) {
          staleProviderCount += 1;
        }
        if (health?.observed_state === "error") {
          failedProviderCount += 1;
        } else if (
          health !== undefined &&
          (health.quality_state === "degraded" ||
            health.quality_state === "warning" ||
            health.consecutive_failures > 0 ||
            health.open_quarantine_count > 0 ||
            health.latest_failure_code !== null ||
            health.mapping_warning_active ||
            health.calculation_warning_active)
        ) {
          degradedProviderCount += 1;
        }
      }
      return {
        configuredProviderCount: providers.length,
        staleProviderCount,
        degradedProviderCount,
        failedProviderCount,
        activeAlertCount,
        latestRetentionState: "never_run",
        latestRetentionAt: null,
        latestRetentionFailureCode: null,
      };
    },
  };
}

/**
 * Machinery facts combine central fleet/open-alert evidence with the same
 * distributed run and schedule reads used by the admin page. Background-work
 * facts stay explicitly unknown until that non-checkpoint surface is routed.
 */
export function createDistributedMachineryAlertFactsSource(input: Readonly<{
  central: CentralPrismaClient;
  evidence: Pick<
    PrismaWorkerFleetReadRepository,
    "listRunningRuns" | "listSchedules"
  >;
  organizationLimit?: number;
  now?: () => Date;
}>): MachineryAlertFactsSource {
  const organizations = new CentralMachineryAlertReadRepository(input.central);
  const presence = new CentralWorkerPresenceRepository(input.central);
  const now = input.now ?? (() => new Date());
  return {
    listOrganizations() {
      return organizations.listOrganizations({
        limit: input.organizationLimit ?? 50,
      });
    },
    async readFacts(organizationId) {
      const observedAt = now();
      const [open, snapshot, runs, schedules] = await Promise.all([
        organizations.readOpenAlerts({
          organizationId,
          limit: WORKER_FLEET_SCAN_LIMIT,
        }),
        readWorkerFleetSnapshot(presence, WORKER_FLEET_SCAN_LIMIT),
        input.evidence.listRunningRuns({
          organizationId,
          limit: WORKER_FLEET_SCAN_LIMIT,
        }),
        input.evidence.listSchedules({
          organizationId,
          limit: WORKER_FLEET_SCAN_LIMIT,
        }),
      ]);
      const published = snapshot.settings.settings;
      const stalledRuns: MachineryRunStallFact[] = [];
      for (const run of runs.items) {
        const stall = evaluateRunStallFor(
          run,
          published?.runHeartbeatStaleAfterMs ?? null,
          observedAt,
        );
        if (stall !== null) {
          stalledRuns.push({
            runId: run.runId,
            providerId: run.providerId,
            stall,
          });
        }
      }
      const scheduleFacts: MachineryScheduleFact[] = schedules.items.map(
        (schedule) => ({
          providerId: schedule.providerId,
          health: toScheduleHealthView(
            schedule,
            published?.presenceStaleAfterMs ?? null,
            observedAt,
            snapshot.identities,
          ).health,
        }),
      );
      const facts = {
        fleet: evaluateFleetFrom({
          records: snapshot.records,
          now: observedAt,
          stalledRuns: stalledRuns.length,
          wedgedSchedules: scheduleFacts.filter((schedule) =>
            isScheduleWedged(schedule.health)
          ).length,
        }),
        fleetStaleAfterMs: published?.presenceStaleAfterMs ?? null,
        stalledRuns,
        schedules: scheduleFacts,
        backlog: {
          state: "unknown" as const,
          depth: 0,
          pending: 0,
          readyPending: 0,
          claimed: 0,
          expiredClaims: 0,
          failed: 0,
          oldestPendingAgeMs: null,
          timelyAfterMs: null,
          depthLimit: null,
        },
        retention: {
          state: "unknown" as const,
          expectedIntervalMs: null,
          sinceLastStartMs: null,
          overdueByMs: null,
          lastOutcome: null,
          knownRemaining: null,
        },
        retentionFailureActive: open.retentionFailureActive,
      };
      return {
        conditions: evaluateMachineryConditions(facts),
        openAlerts: open.alerts,
      };
    },
  };
}
