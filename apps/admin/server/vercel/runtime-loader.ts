/**
 * Shares one initialization attempt between concurrent cold-start requests.
 * A failed attempt is forgotten so a transient database wake-up can recover on
 * the next request instead of poisoning the whole warm isolate.
 */
export function createRetryingSingleFlight<T>(
  initialize: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;

  return () => {
    pending ??= initialize().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
