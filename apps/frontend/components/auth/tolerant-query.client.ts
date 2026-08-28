"use client";

import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import {
  getFunctionName,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";

/**
 * A reactive Convex read whose failure is a value, not a render crash.
 *
 * The stock `useQuery` throws a refused query's error during render, which
 * climbs past the provider tree — there is no boundary above it — and takes
 * the whole application down. During the closed beta that is not an edge
 * case: the capability gate (closed-beta-access/004) refuses authenticated
 * reads for held accounts as a matter of course, and the holding surface
 * (closed-beta-access/008) exists precisely for signed-in visitors in that
 * state. A refusal is ordinary data about the session — the caller reads it
 * or ignores it, and the subscription stays live, so the same read simply
 * starts answering once the account is admitted.
 *
 * Deliberately limited to zero-argument queries: every self-scoped session
 * read this tree makes takes no arguments, and the restriction is what keeps
 * the subscription's memoization honest without re-serializing arguments on
 * every render.
 */

export type TolerantQueryResult<Value> = Readonly<{
  /** The query's latest value, or undefined while loading, skipped, or failed. */
  data: Value | undefined;
  /** The query's latest failure, or undefined while it has none. */
  error: Error | undefined;
}>;

/**
 * Splits a raw query result into the value-or-error shape. Exported for its
 * tests; the hook below is the consumer.
 */
export function tolerantQueryOutcome<Value>(
  result: unknown,
): TolerantQueryResult<Value> {
  if (result instanceof Error) return { data: undefined, error: result };
  return { data: result as Value | undefined, error: undefined };
}

export function useTolerantQuery<
  Query extends FunctionReference<"query", "public", Record<string, never>>,
>(
  query: Query,
  args: Record<string, never> | "skip",
): TolerantQueryResult<FunctionReturnType<Query>> {
  const skipped = args === "skip";
  const queryName = getFunctionName(query);
  const queries = useMemo(
    (): RequestForQueries => {
      if (skipped) return {};
      return { tolerant: { query, args: {} } };
    },
    // Any reference to a named function is interchangeable with any other
    // reference to the same name, so the name is the stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryName, skipped],
  );
  return tolerantQueryOutcome(useQueries(queries)["tolerant"]);
}
