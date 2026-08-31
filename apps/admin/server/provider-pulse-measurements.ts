import {
  providerSourceMeasurementsSchema,
  unavailableProviderSourceMeasurements,
  type ProviderSourceMeasurements,
} from "@packscout/contracts";
import {
  PrismaProviderPulseMetricsRepository,
  type ProviderPrismaClient,
  type ProviderPulseTotals,
} from "@packscout/database";

const TOTALS_CACHE_MS = 60_000;
type TotalsMeasurement = Pick<ProviderSourceMeasurements, "storage" | "records">;
type Repository = Pick<PrismaProviderPulseMetricsRepository, "readTotals" | "readActivity">;

interface CachedTotals {
  readonly scope: string;
  readonly expiresAt: number;
  readonly result: Promise<TotalsMeasurement>;
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
  readonly #totals = new WeakMap<ProviderPrismaClient, CachedTotals>();

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
    let cached = this.#totals.get(database);
    const checkedAt = this.now().getTime();
    if (!cached || cached.scope !== scope || cached.expiresAt <= checkedAt) {
      const result = repository.readTotals().then(measuredTotals).catch(() => {
        const unavailable = unavailableProviderSourceMeasurements("query_failed");
        return { storage: unavailable.storage, records: unavailable.records };
      });
      cached = { scope, expiresAt: checkedAt + TOTALS_CACHE_MS, result };
      this.#totals.set(database, cached);
    }
    // Repository queries have database-side deadlines. Failure of the exact
    // scan never replaces the independently read runtime or lease evidence.
    const [totals, activity] = await Promise.all([
      cached.result,
      repository.readActivity()
        .then((value) => providerSourceMeasurementsSchema.shape.activity.parse({
          state: "available", ...value,
        }))
        .catch(() => ({ state: "unavailable" as const, reason: "query_failed" as const })),
    ]);
    return providerSourceMeasurementsSchema.parse({ ...totals, activity });
  }
}
