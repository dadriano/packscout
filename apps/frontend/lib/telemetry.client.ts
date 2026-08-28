"use client";

import {
  PUBLIC_READ_FAILURE_SCHEMA_VERSION,
  TELEMETRY_REQUEST_MAX_BYTES,
  TELEMETRY_SCHEMA_VERSION,
  type AnonymousProductEvent,
  type PublicReadFailureBeacon,
} from "./telemetry-contract";

type EventNamed<TName extends AnonymousProductEvent["name"]> = Extract<
  AnonymousProductEvent,
  { readonly name: TName }
>;

export type TelemetryTransport = Readonly<{
  fetch?: typeof fetch;
}>;

function eventBase(publicReleaseId: string) {
  try {
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: globalThis.crypto.randomUUID(),
      publicReleaseId,
      occurredAt: new Date().toISOString(),
    } as const;
  } catch {
    return null;
  }
}

export function queryLengthBucket(
  length: number,
): EventNamed<"repack_search">["queryLengthBucket"] | null {
  if (!Number.isSafeInteger(length) || length < 1 || length > 120) return null;
  if (length <= 20) return "1-20";
  if (length <= 60) return "21-60";
  return "61-120";
}

export function resultCountBucket(
  count: number,
): EventNamed<"repack_search">["resultCountBucket"] | null {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (count === 0) return "0";
  if (count <= 25) return "1-25";
  if (count <= 100) return "26-100";
  return "101+";
}

export function createDashboardViewEvent(input: Readonly<{
  publicReleaseId: string;
  surface: EventNamed<"dashboard_view">["surface"];
}>): EventNamed<"dashboard_view"> | null {
  const base = eventBase(input.publicReleaseId);
  return base
    ? { ...base, name: "dashboard_view", surface: input.surface, outcome: "rendered" }
    : null;
}

export function createRepackSearchEvent(input: Readonly<{
  publicReleaseId: string;
  queryLength: number;
  resultCount: number;
  outcome: EventNamed<"repack_search">["outcome"];
}>): EventNamed<"repack_search"> | null {
  const base = eventBase(input.publicReleaseId);
  const queryBucket = queryLengthBucket(input.queryLength);
  const resultBucket = resultCountBucket(input.resultCount);
  return base && queryBucket && resultBucket
    ? {
        ...base,
        name: "repack_search",
        surface: "all_repacks",
        outcome: input.outcome,
        queryLengthBucket: queryBucket,
        resultCountBucket: resultBucket,
      }
    : null;
}

export function createFiltersAppliedEvent(input: Readonly<{
  publicReleaseId: string;
  surface: EventNamed<"filters_applied">["surface"];
  outcome: EventNamed<"filters_applied">["outcome"];
  activeFilterCount: number;
  resultCount: number;
}>): EventNamed<"filters_applied"> | null {
  const base = eventBase(input.publicReleaseId);
  const resultBucket = resultCountBucket(input.resultCount);
  if (
    !base ||
    !resultBucket ||
    ![0, 1, 2, 3, 4, 5].includes(input.activeFilterCount)
  ) {
    return null;
  }
  return {
    ...base,
    name: "filters_applied",
    surface: input.surface,
    outcome: input.outcome,
    activeFilterCount: input.activeFilterCount as 0 | 1 | 2 | 3 | 4 | 5,
    resultCountBucket: resultBucket,
  };
}

export function createPromoCopiedEvent(input: Readonly<{
  publicReleaseId: string;
  publicRepackId: string;
  vendorKey: string;
  outcome: EventNamed<"promo_copied">["outcome"];
}>): EventNamed<"promo_copied"> | null {
  const base = eventBase(input.publicReleaseId);
  return base ? { ...base, name: "promo_copied", ...input } : null;
}

export function createRepackLinkOpenedEvent(input: Readonly<{
  publicReleaseId: string;
  publicRepackId: string;
  vendorKey: string;
  outcome: EventNamed<"repack_link_opened">["outcome"];
}>): EventNamed<"repack_link_opened"> | null {
  const base = eventBase(input.publicReleaseId);
  return base ? { ...base, name: "repack_link_opened", ...input } : null;
}

export function createPublicReadFailureBeacon(
  input: Omit<
    PublicReadFailureBeacon,
    "schemaVersion" | "eventId" | "occurredAt"
  >,
): PublicReadFailureBeacon | null {
  try {
    return {
      schemaVersion: PUBLIC_READ_FAILURE_SCHEMA_VERSION,
      eventId: globalThis.crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      ...input,
    };
  } catch {
    return null;
  }
}

function defaultTransport(): TelemetryTransport {
  return {
    fetch: typeof fetch === "function" ? fetch : undefined,
  };
}

function queue(
  endpoint: "/api/telemetry" | "/api/public-read-failure",
  event: AnonymousProductEvent | PublicReadFailureBeacon | null,
  transport: TelemetryTransport = defaultTransport(),
): void {
  if (event === null) return;

  let body: string;
  try {
    body = JSON.stringify(event);
  } catch {
    return;
  }
  if (new TextEncoder().encode(body).byteLength > TELEMETRY_REQUEST_MAX_BYTES) {
    return;
  }

  if (!transport.fetch) return;
  try {
    // sendBeacon has no credential mode and can attach ambient auth cookies.
    // This anonymous channel always uses an explicitly credential-free request.
    void transport
      .fetch(endpoint, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      })
      .catch(() => undefined);
  } catch {
    // Telemetry never changes or delays the completed product action.
  }
}

export function queueProductTelemetry(
  event: AnonymousProductEvent | null,
  transport?: TelemetryTransport,
): void {
  queue("/api/telemetry", event, transport);
}

export function queuePublicReadFailure(
  event: PublicReadFailureBeacon | null,
  transport?: TelemetryTransport,
): void {
  queue("/api/public-read-failure", event, transport);
}
