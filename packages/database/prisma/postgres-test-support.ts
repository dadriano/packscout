import type { Pool } from "pg";

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
