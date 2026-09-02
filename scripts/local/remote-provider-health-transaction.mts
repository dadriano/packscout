/** Transaction timeout is not callback cancellation. Never close or reuse while it still runs. */
export async function runRemoteHealthTransaction<T, Transaction>(
  run: (callback: (transaction: Transaction) => Promise<T>) => Promise<T>,
  read: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  let pending: Promise<T> | undefined;
  try {
    return await run(transaction => {
      pending = Promise.resolve().then(() => read(transaction));
      return pending;
    });
  } finally {
    if (pending) await pending.catch(() => undefined);
  }
}
