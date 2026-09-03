import { useEffect, useState } from "react";

/**
 * The clock, as a subscription rather than a render-time read.
 *
 * Relative times and liveness are only true for an instant, so they advance on
 * their own schedule rather than whenever a component happens to re-render.
 * Reading `Date.now()` during render would make the same value show two
 * different ages depending on what else changed, which is exactly the kind of
 * inconsistency that makes a monitoring surface hard to trust.
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
