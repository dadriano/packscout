import { refuseBackfill } from "./provider-backfill-supervisor-policy.mts";

/** A gateway deadline does not cancel its callback. Hold ownership until that
 * callback settles, and refuse every later write phase after timeout/abort. */
export async function withResidentOperation<D, T, R>(
  operation: (database: D, active: () => void) => Promise<T>,
  run: (callback: (database: D) => Promise<T>) => Promise<R>,
  signal: AbortSignal, milliseconds = 55_000): Promise<R> {
  let pending: Promise<T> | null = null;
  let gatewayActive = true;
  const deadline = Date.now() + milliseconds;
  const active = () => {
    if (!gatewayActive || signal.aborted || Date.now() >= deadline) refuseBackfill("CONTINUOUS_OPERATION_DEADLINE");
  };
  try {
    return await run(database => {
      if (pending) refuseBackfill("CONTINUOUS_OPERATION_OVERLAP");
      const attempt = Promise.resolve().then(() => { active(); return operation(database, active); });
      pending = attempt;
      return attempt;
    });
  } finally {
    gatewayActive = false;
    if (pending) await (pending as Promise<T>).catch(() => undefined);
  }
}
