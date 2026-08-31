import {
  providerSourceMeasurementsSchema,
  unavailableProviderSourceMeasurements,
  type ProviderSourceMeasurements,
} from "@packscout/contracts";
import {
  PrismaProviderPulseMetricsRepository,
  type ProviderPrismaClient,
  type ProviderPulseHistory,
  type ProviderPulseTotals,
} from "@packscout/database";

const HISTORY_CACHE_MS = 60_000;
type TotalsMeasurement = Pick<ProviderSourceMeasurements, "storage" | "records">;
type ActivityMeasurement = Extract<ProviderSourceMeasurements["activity"], { state: "available" }>;
type HistoryMeasurement = Pick<ActivityMeasurement, "historyMeasuredAt" | "lastCommittedPageAt" | "quarantine">;
type Repository = Pick<PrismaProviderPulseMetricsRepository, "readTotals" | "readHistory" | "readLeases">;

interface CachedMeasurement<T> {
  readonly scope: string;
  readonly expiresAt: number;
  readonly result: Promise<T>;
}

const historySchema = providerSourceMeasurementsSchema.shape.activity.options[0].pick({
  historyMeasuredAt: true, lastCommittedPageAt: true, quarantine: true,
});

function measuredHistory(history: ProviderPulseHistory): HistoryMeasurement {
  return historySchema.parse({ historyMeasuredAt: history.measuredAt,
    lastCommittedPageAt: history.lastCommittedPageAt, quarantine: history.quarantine });
}

function cachedMeasurement<T>(
  cache: WeakMap<ProviderPrismaClient, CachedMeasurement<T>>,
  database: ProviderPrismaClient,
  scope: string,
  checkedAt: number,
  read: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(database);
  if (cached?.scope === scope && cached.expiresAt > checkedAt) return cached.result;
  const result: Promise<T> = read().catch((error: unknown) => {
    // Failed or malformed snapshots retry on the next refresh. An older
    // failure cannot remove a replacement query for a newer route or scope.
    if (cache.get(database)?.result === result) cache.delete(database);
    throw error;
  });
  cache.set(database, { scope, expiresAt: checkedAt + HISTORY_CACHE_MS, result });
  return result;
}

function measuredTotals(totals: ProviderPulseTotals): TotalsMeasurement {
  const measured = providerSourceMeasurementsSchema.parse({
    storage: { state: "available", measuredAt: totals.measuredAt, counts: totals.counts },
    records: {
      state: "available", measuredAt: totals.measuredAt,
      processed: totals.processed, accepted: totals.accepted,
    },
    activity: { state: "unavailable", reason: "query_failed" },
  });
  return { storage: measured.storage, records: measured.records };
}

/** Call only inside the gateway's authorized callback, including cache hits. */
export class ProviderPulseMeasurementReader {
  // The gateway replaces its client on a route/credential change. A WeakMap
  // makes the client part of the cache identity without retaining credentials.
  readonly #totals = new WeakMap<ProviderPrismaClient, CachedMeasurement<TotalsMeasurement>>();
  readonly #history = new WeakMap<ProviderPrismaClient, CachedMeasurement<HistoryMeasurement>>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly repository: (database: ProviderPrismaClient) => Repository =
      (database) => new PrismaProviderPulseMetricsRepository(database),
  ) {}

  async read(database: ProviderPrismaClient, identity: Readonly<{
    organizationId: string;
    providerId: string;
    configurationId: string;
  }>): Promise<ProviderSourceMeasurements> {
    const scope = JSON.stringify([
      identity.organizationId, identity.providerId, identity.configurationId,
    ]);
    const repository = this.repository(database);
    const checkedAt = this.now().getTime();
    const totalsRead = cachedMeasurement(this.#totals, database, scope, checkedAt,
      () => repository.readTotals().then(measuredTotals));
    const historyRead = cachedMeasurement(this.#history, database, scope, checkedAt,
      () => repository.readHistory().then(measuredHistory));
    // All full-history scans are cached. Only the two worker lease records are
    // checked every refresh, with their own database observation time.
    const [totals, activity] = await Promise.all([
      totalsRead.catch(() => {
        const unavailable = unavailableProviderSourceMeasurements("query_failed");
        return { storage: unavailable.storage, records: unavailable.records };
      }),
      Promise.all([historyRead, repository.readLeases()])
        .then(([history, leases]) => providerSourceMeasurementsSchema.shape.activity.parse({
          state: "available", ...history, measuredAt: leases.measuredAt,
          importLease: leases.importLease, promotionLease: leases.promotionLease,
        }))
        .catch(() => ({ state: "unavailable" as const, reason: "query_failed" as const })),
    ]);
    return providerSourceMeasurementsSchema.parse({ ...totals, activity });
  }
}
