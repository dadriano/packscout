import type {
  CanonicalEntityDetail,
  CanonicalEntityPage,
  CanonicalProviderRow,
  CanonicalProviderSummary,
  ComparisonScope,
} from "@packscout/contracts";
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

export function listCanonicalProviders(
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  return requestJson<{ providers: CanonicalProviderRow[] }>(
    "/data-inspection/canonical/providers",
    { signal },
    fetcher,
  );
}

export function getCanonicalSummary(
  platformKey: string,
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  return requestJson<CanonicalProviderSummary>(
    `/data-inspection/canonical/providers/${encodeURIComponent(platformKey)}/summary`,
    { signal },
    fetcher,
  );
}

export function listCanonicalEntities(
  input: {
    platformKey: string;
    recordKind: string;
    search?: string;
    cursor?: string;
    limit?: number;
    direction?: string;
  },
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  const query = new URLSearchParams({ recordKind: input.recordKind });
  if (input.search) query.set("search", input.search);
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit) query.set("limit", String(input.limit));
  if (input.direction) query.set("direction", input.direction);
  return requestJson<CanonicalEntityPage>(
    `/data-inspection/canonical/providers/${encodeURIComponent(input.platformKey)}/entities?${query}`,
    { signal },
    fetcher,
  );
}

export function readCanonicalEntity(
  input: { platformKey: string; recordKind: string; externalId: string },
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  const path = [
    "/data-inspection/canonical/providers",
    encodeURIComponent(input.platformKey),
    "entities",
    encodeURIComponent(input.recordKind),
    encodeURIComponent(input.externalId),
  ].join("/");
  return requestJson<CanonicalEntityDetail>(path, { signal }, fetcher);
}
