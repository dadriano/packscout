import type { Pool } from "pg";

/**
 * Teardown helpers shared by the migration tests in this directory.
 *
 * These tests build databases from raw migration SQL rather than through the
 * migrated harness in `src/test-support.ts`, so they own their own PostgreSQL
 * pools and have to tear them down safely themselves.
 *
 * The hazard is specific. Each harness ends its pool and then issues
 * `drop database ... with (force)`. FORCE terminates any backend still attached
 * to that database. If the server has not finished closing a connection that
 * node-pg already considers released, it gets terminated instead, and node-pg
 * reports that on the pool's `error` event. An unhandled `error` on an
 * EventEmitter is an uncaught exception, which the test runner attributes to
 * whichever test happens to be running — producing a failure that looks nothing
 * like its cause and reproduces only under load.
 */

/**
 * Ends a pool and waits until every connection it owned has actually been
 * removed.
 *
 * `pool.end()` resolves once clients are released, which is not the same as the
 * server having torn the backends down. Waiting for the matching `remove`
 * events closes that window, so a subsequent `drop ... with (force)` has nothing
 * left to terminate.
 */
export async function endPoolFully(pool: Pool): Promise<void> {
  const expectedRemovals = pool.totalCount;
  if (expectedRemovals === 0) {
    await pool.end();
    return;
  }

  let removalCount = 0;
  let resolveRemovals: (() => void) | undefined;
  const removals = new Promise<void>((resolve) => {
    resolveRemovals = resolve;
  });
  const onRemove = () => {
    removalCount += 1;
    if (removalCount === expectedRemovals) resolveRemovals?.();
  };
  pool.on("remove", onRemove);
  try {
    await pool.end();
    await removals;
  } finally {
    pool.off("remove", onRemove);
  }
}

/**
 * Makes a pool's connection errors non-fatal to the test process.
 *
 * Ordering the teardown correctly is the real fix; this is the backstop for the
 * case where a connection is torn down from the server side anyway. Without a
 * listener the same event crashes the run, so this converts a mysterious
 * uncaught exception into a no-op on a pool that is being discarded regardless.
 */
export function guardPoolErrors(pool: Pool): Pool {
  pool.on("error", () => {
    // The pool is being torn down; a terminated backend is expected here and
    // must not fail the test that happens to be running.
  });
  return pool;
}
