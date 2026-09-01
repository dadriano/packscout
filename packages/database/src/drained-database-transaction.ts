/**
 * An interactive transaction's rejection does not cancel its JavaScript
 * callback. Preserve its original result/error, but drain that callback before
 * allowing the caller to close resources or start its next operation.
 */
export async function runDrainedDatabaseTransaction<T, Transaction, Result = T>(
  run: (callback: (transaction: Transaction) => Promise<T>) => Promise<Result>,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<Result> {
  let pending: Promise<T> | undefined;
  try {
    return await run(transaction => {
      pending = Promise.resolve().then(() => operation(transaction));
      return pending;
    });
  } finally {
    if (pending) await pending.catch(() => undefined);
  }
}
