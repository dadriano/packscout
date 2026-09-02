import type { Pool } from "pg";

/** pg's `pool.end()` resolves once Terminate is written, not once the client
 * sockets close, so a force drop issued straight afterwards can still terminate
 * a live backend. The pool emits "remove" from `client.end()`'s callback, which
 * fires on real socket close, so awaiting one per pooled client closes that gap.
 * The wait is bounded: a helper that guards a test lane must never hang it. */
export async function endPoolFully(pool: Pool, timeoutMilliseconds = 10_000): Promise<void> {
  const expectedRemovals = pool.totalCount;
  if (expectedRemovals === 0) {
    await pool.end();
    return;
  }

  let removalCount = 0;
  let settle: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onRemove = () => {
    removalCount += 1;
    if (removalCount >= expectedRemovals) settle?.();
  };
  pool.on("remove", onRemove);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await pool.end();
    await Promise.race([closed, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMilliseconds);
      timer.unref?.();
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    pool.off("remove", onRemove);
  }
}
