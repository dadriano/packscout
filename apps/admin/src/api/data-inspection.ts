import type {
  CanonicalEntityDetail,
  CanonicalEntityPage,
  CanonicalProviderRow,
  CanonicalProviderSummary,
  ComparisonScope,
  PublishedActiveRelease,
  PublishedInspectableEntityKind,
  PublishedProviderChaseReconciliation,
  PublishedProviderDocument,
  PublishedProviderEntityPage,
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
    page?: number;
    limit?: number;
    direction?: string;
  },
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  const query = new URLSearchParams({ recordKind: input.recordKind });
  if (input.search) query.set("search", input.search);
  if (input.page && input.page > 1) query.set("page", String(input.page));
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

export function getPublishedActiveRelease(
  platformKey: string,
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  return requestJson<PublishedActiveRelease>(
    `/data-inspection/published/providers/${encodeURIComponent(platformKey)}/active-release`,
    { signal },
    fetcher,
  );
}

export function listPublishedEntities(
  input: {
    platformKey: string;
    publicProviderReleaseId: string;
    entityKind: PublishedInspectableEntityKind;
    limit?: number;
    cursor?: string | null;
  },
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  const query = new URLSearchParams({
    entityKind: input.entityKind,
    expectedPublicProviderReleaseId: input.publicProviderReleaseId,
  });
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.cursor) query.set("cursor", input.cursor);
  return requestJson<PublishedProviderEntityPage>(
    `/data-inspection/published/providers/${encodeURIComponent(input.platformKey)}/entities?${query}`,
    { signal },
    fetcher,
  );
}

export function readPublishedDocument(
  input: {
    platformKey: string;
    publicProviderReleaseId: string;
    entityKind: PublishedInspectableEntityKind;
    publicEntityId: string;
  },
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  const path = [
    "/data-inspection/published/providers",
    encodeURIComponent(input.platformKey),
    "entities",
    encodeURIComponent(input.entityKind),
    encodeURIComponent(input.publicEntityId),
  ].join("/");
  const query = new URLSearchParams({
    expectedPublicProviderReleaseId: input.publicProviderReleaseId,
  });
  return requestJson<PublishedProviderDocument>(
    `${path}?${query}`,
    { signal },
    fetcher,
  );
}

export function readPublishedChaseReconciliation(
  input: {
    platformKey: string;
    publicProviderReleaseId: string;
    publicRepackId: string;
  },
  signal?: AbortSignal,
  fetcher?: Fetcher,
) {
  const path = [
    "/data-inspection/published/providers",
    encodeURIComponent(input.platformKey),
    "repacks",
    encodeURIComponent(input.publicRepackId),
    "chase-reconciliation",
  ].join("/");
  const query = new URLSearchParams({
    expectedPublicProviderReleaseId: input.publicProviderReleaseId,
  });
  return requestJson<PublishedProviderChaseReconciliation>(
    `${path}?${query}`,
    { signal },
    fetcher,
  );
}
