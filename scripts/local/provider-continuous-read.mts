import type { ProviderDatabaseOperationResult, ProviderPrismaClient } from "@packscout/database";
import { ProviderBackfillSupervisorError, refuseBackfill } from "./provider-backfill-supervisor-policy.mts";

/** Only a read-only boundary may issue this retry capability. It never grants a
 * transaction, queue, child execution, or source-error retry. */
export class ContinuousReadUnavailableError extends ProviderBackfillSupervisorError {
  constructor() { super("CONTINUOUS_READ_UNAVAILABLE"); }
}
function knownReadConnectionFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    const property = Object.getOwnPropertyDescriptor(error, "code");
    return property !== undefined && "value" in property &&
      ["P1001", "P1002", "P1017", "P2024", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(property.value);
  } catch { return false; }
}
type Observation<T> = { state: "pending" } | { state: "fulfilled"; value: T } | { state: "rejected"; error: unknown };

/** Gateway deadlines may return while their callback remains unsettled. Keep
 * that callback visible and refuse every new read until it has actually ended.
 * A late snapshot is discarded: the next usable view revalidates all authority. */
export function createContinuousProviderReader<A, T>(input: {
  authority(): Promise<A>;
  run(authority: A, read: (database: ProviderPrismaClient) => Promise<T>): Promise<ProviderDatabaseOperationResult<T>>;
  read(database: ProviderPrismaClient, authority: A): Promise<T>;
}): (() => Promise<T>) & { drain(): Promise<void> } {
  let pending: { observation: Observation<T>; settled: Promise<void> } | null = null;
  const reader = async () => {
    if (pending !== null) {
      const previous = pending.observation;
      if (previous.state === "pending") throw new ContinuousReadUnavailableError();
      pending = null;
      if (previous.state === "rejected" && !knownReadConnectionFailure(previous.error)) throw previous.error;
    }
    // Authority/configuration/credential failures are deliberately not converted
    // into connection retries; the caller must latch their existing failure.
    const authority = await input.authority();
    let attempt: { observation: Observation<T> } | null = null;
    const result = await input.run(authority, async database => {
      let finished!: () => void;
      const settled = new Promise<void>(resolve => { finished = resolve; });
      const current: { observation: Observation<T>; settled: Promise<void> } = { observation: { state: "pending" }, settled };
      attempt = current; pending = current;
      try {
        const value = await input.read(database, authority);
        current.observation = { state: "fulfilled", value }; return value;
      } catch (error) {
        current.observation = { state: "rejected", error }; throw error;
      } finally { finished(); }
    });
    if (result.state === "reachable") { pending = null; return result.value; }
    if (result.failureCode !== "database_unreachable") refuseBackfill("CONTINUOUS_PROVIDER_UNAVAILABLE");
    const observed = (attempt as { observation: Observation<T> } | null)?.observation;
    if (observed?.state === "rejected" && !knownReadConnectionFailure(observed.error)) {
      pending = null; throw observed.error;
    }
    throw new ContinuousReadUnavailableError();
  };
  reader.drain = async () => { if (pending) await pending.settled; };
  return reader;
}
