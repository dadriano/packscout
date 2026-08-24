import type { ComparisonScope } from "@packscout/contracts";
import { requestJson, type Fetcher } from "./client";

/**
 * Browser access to the admin's read-only data-inspection routes.
 *
 * Every call here reads. The browser never reaches the product backend
 * directly — the admin server holds that integration secret — so published
 * data arrives through these routes like canonical data does.
 */

export function getComparisonScope(signal?: AbortSignal, fetcher?: Fetcher) {
  return requestJson<ComparisonScope>(
    "/data-inspection/scope",
    { signal },
    fetcher,
  );
}
