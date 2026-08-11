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
  sendBeacon?: (url: string, data: Blob) => boolean;
  fetch?: typeof fetch;
}>;

function eventBase(snapshotVersion: string) {
  try {
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: globalThis.crypto.randomUUID(),
      snapshotVersion,
      occurredAt: new Date().toISOString(),
    } as const;
  } catch {
    return null;
  }
}

export function queryLengthBucket(
  length: number,
): EventNamed<"catalog_search">["queryLengthBucket"] | null {
  if (!Number.isSafeInteger(length) || length < 1 || length > 120) return null;
  if (length <= 20) return "1-20";
  if (length <= 60) return "21-60";
  return "61-120";
}

export function resultCountBucket(
  count: number,
): EventNamed<"catalog_search">["resultCountBucket"] | null {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (count === 0) return "0";
  if (count <= 25) return "1-25";
  if (count <= 100) return "26-100";
  return "101+";
}

export function createDashboardViewEvent(input: Readonly<{
  snapshotVersion: string;
  surface: EventNamed<"dashboard_view">["surface"];
}>): EventNamed<"dashboard_view"> | null {
  const base = eventBase(input.snapshotVersion);
  return base
    ? { ...base, name: "dashboard_view", surface: input.surface, outcome: "rendered" }
    : null;
}

export function createCatalogSearchEvent(input: Readonly<{
  snapshotVersion: string;
  queryLength: number;
  resultCount: number;
  outcome: EventNamed<"catalog_search">["outcome"];
}>): EventNamed<"catalog_search"> | null {
  const base = eventBase(input.snapshotVersion);
  const queryBucket = queryLengthBucket(input.queryLength);
  const resultBucket = resultCountBucket(input.resultCount);
  return base && queryBucket && resultBucket
    ? {
        ...base,
        name: "catalog_search",
        surface: "all_packs",
        outcome: input.outcome,
        queryLengthBucket: queryBucket,
        resultCountBucket: resultBucket,
      }
    : null;
}

export function createFiltersAppliedEvent(input: Readonly<{
  snapshotVersion: string;
  surface: EventNamed<"filters_applied">["surface"];
  outcome: EventNamed<"filters_applied">["outcome"];
  activeFilterCount: number;
  resultCount: number;
}>): EventNamed<"filters_applied"> | null {
  const base = eventBase(input.snapshotVersion);
  const resultBucket = resultCountBucket(input.resultCount);
  if (
    !base ||
    !resultBucket ||
    ![0, 1, 2, 3].includes(input.activeFilterCount)
  ) {
    return null;
  }
  return {
    ...base,
    name: "filters_applied",
    surface: input.surface,
    outcome: input.outcome,
    activeFilterCount: input.activeFilterCount as 0 | 1 | 2 | 3,
    resultCountBucket: resultBucket,
  };
}

export function createPromoCopiedEvent(input: Readonly<{
  snapshotVersion: string;
  publicPackId: string;
  platformKey: string;
  outcome: EventNamed<"promo_copied">["outcome"];
}>): EventNamed<"promo_copied"> | null {
  const base = eventBase(input.snapshotVersion);
  return base ? { ...base, name: "promo_copied", ...input } : null;
}

export function createPackLinkOpenedEvent(input: Readonly<{
  snapshotVersion: string;
  publicPackId: string;
  platformKey: string;
  outcome: EventNamed<"pack_link_opened">["outcome"];
}>): EventNamed<"pack_link_opened"> | null {
  const base = eventBase(input.snapshotVersion);
  return base ? { ...base, name: "pack_link_opened", ...input } : null;
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
    sendBeacon:
      typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? navigator.sendBeacon.bind(navigator)
        : undefined,
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

  if (transport.sendBeacon) {
    try {
      if (
        transport.sendBeacon(
          endpoint,
          new Blob([body], { type: "application/json" }),
        )
      ) {
        return;
      }
    } catch {
      // Fall through to nonblocking fetch without surfacing transport failure.
    }
  }

  if (!transport.fetch) return;
  try {
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
