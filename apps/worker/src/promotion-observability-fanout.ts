/**
 * Runs durable promotion observability and best-effort logging independently.
 * The durable error wins when both fail so callers never mistake logging drift
 * for the reason an operational event was not persisted.
 */
export async function runPromotionObservabilityFanout(
  durable: () => void | Promise<void>,
  log: () => void | Promise<void>,
): Promise<void> {
  const [durableResult, logResult] = await Promise.allSettled([
    Promise.resolve().then(durable),
    Promise.resolve().then(log),
  ]);
  if (durableResult.status === "rejected") throw durableResult.reason;
  if (logResult.status === "rejected") throw logResult.reason;
}
