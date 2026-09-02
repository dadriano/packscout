import {
  providerSourceMeasurementsSchema,
  unavailableProviderSourceMeasurements,
  type ProviderSourceMeasurements,
} from "@packscout/contracts";
import {
  PrismaProviderPulseMetricsRepository,
  type ProviderPrismaClient,
  type ProviderPulseHistory,
  type ProviderPulseRecordTotals,
  type ProviderPulseStorageCounts,
} from "@packscout/database";

const HISTORY_CACHE_MS = 60_000;
type StorageMeasurement = ProviderSourceMeasurements["storage"];
type RecordsMeasurement = ProviderSourceMeasurements["records"];
type ActivityMeasurement = Extract<ProviderSourceMeasurements["activity"], { state: "available" }>;
type HistoryMeasurement = Pick<ActivityMeasurement, "historyMeasuredAt" | "lastCommittedPageAt" | "quarantine">;
type Repository = Pick<PrismaProviderPulseMetricsRepository,
  "readStorageCounts" | "readRecordTotals" | "readHistory" | "readLeases">;

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

const storageSchema = providerSourceMeasurementsSchema.shape.storage;
const recordsSchema = providerSourceMeasurementsSchema.shape.records;

function measuredStorage(storage: ProviderPulseStorageCounts): StorageMeasurement {
  return storageSchema.parse({
    state: "available", measuredAt: storage.measuredAt,
    precision: storage.precision, counts: storage.counts,
  });
}

function measuredRecords(records: ProviderPulseRecordTotals): RecordsMeasurement {
  return recordsSchema.parse({
    state: "available", measuredAt: records.measuredAt,
    processed: records.processed, accepted: records.accepted,
  });
}

const queryFailed = unavailableProviderSourceMeasurements("query_failed");

/** Call only inside the gateway's authorized callback, including cache hits. */
export class ProviderPulseMeasurementReader {
  // The gateway replaces its client on a route/credential change. A WeakMap
  // makes the client part of the cache identity without retaining credentials.
  readonly #storage = new WeakMap<ProviderPrismaClient, CachedMeasurement<StorageMeasurement>>();
  readonly #records = new WeakMap<ProviderPrismaClient, CachedMeasurement<RecordsMeasurement>>();
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
    // Storage counts and retained-run totals are cached and recovered
    // separately. Counting stored rows costs time proportional to those rows,
    // so its failure must not withhold the small retained-run aggregate.
    const storageRead = cachedMeasurement(this.#storage, database, scope, checkedAt,
      () => repository.readStorageCounts().then(measuredStorage));
    const recordsRead = cachedMeasurement(this.#records, database, scope, checkedAt,
      () => repository.readRecordTotals().then(measuredRecords));
    const historyRead = cachedMeasurement(this.#history, database, scope, checkedAt,
      () => repository.readHistory().then(measuredHistory));
    // All full-history scans are cached. Only the two worker lease records are
    // checked every refresh, with their own database observation time.
    const [storage, records, activity] = await Promise.all([
      storageRead.catch(() => queryFailed.storage),
      recordsRead.catch(() => queryFailed.records),
      Promise.all([historyRead, repository.readLeases()])
        .then(([history, leases]) => providerSourceMeasurementsSchema.shape.activity.parse({
          state: "available", ...history, measuredAt: leases.measuredAt,
          importLease: leases.importLease, promotionLease: leases.promotionLease,
        }))
        .catch(() => ({ state: "unavailable" as const, reason: "query_failed" as const })),
    ]);
    return providerSourceMeasurementsSchema.parse({ storage, records, activity });
  }
}
