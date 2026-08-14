export const TELEMETRY_SCHEMA_VERSION = "anonymous-product-event-v2" as const;
export const PUBLIC_READ_FAILURE_SCHEMA_VERSION =
  "public-read-failure-v1" as const;

export const TELEMETRY_REQUEST_MAX_BYTES = 4_096 as const;
export const TELEMETRY_MAX_AGE_MS = 5 * 60 * 1_000;
export const TELEMETRY_MAX_FUTURE_MS = 60 * 1_000;

export const TELEMETRY_RETENTION_POLICY = Object.freeze({
  receiptHours: 24,
  rawEventDays: 30,
  aggregateMonths: 13,
  aggregationBatchSize: 500,
  maximumAttempts: 10,
  globalWritesPerMinute: 5_000,
} as const);

export type AnonymousProductEvent =
  | Readonly<{
      schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
      eventId: string;
      publicReleaseId: string;
      occurredAt: string;
      name: "dashboard_view";
      surface: "overview" | "all_repacks";
      outcome: "rendered";
    }>
  | Readonly<{
      schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
      eventId: string;
      publicReleaseId: string;
      occurredAt: string;
      name: "repack_search";
      surface: "all_repacks";
      outcome: "results" | "no_matches" | "failed";
      queryLengthBucket: "1-20" | "21-60" | "61-120";
      resultCountBucket: "0" | "1-25" | "26-100" | "101+";
    }>
  | Readonly<{
      schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
      eventId: string;
      publicReleaseId: string;
      occurredAt: string;
      name: "filters_applied";
      surface: "overview" | "all_repacks";
      outcome: "results" | "no_matches" | "failed";
      activeFilterCount: 0 | 1 | 2 | 3 | 4;
      resultCountBucket: "0" | "1-25" | "26-100" | "101+";
    }>
  | Readonly<{
      schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
      eventId: string;
      publicReleaseId: string;
      occurredAt: string;
      name: "promo_copied";
      publicRepackId: string;
      vendorKey: string;
      outcome: "clipboard" | "manual_fallback" | "failed";
    }>
  | Readonly<{
      schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
      eventId: string;
      publicReleaseId: string;
      occurredAt: string;
      name: "repack_link_opened";
      publicRepackId: string;
      vendorKey: string;
      outcome: "opened" | "blocked";
    }>;

export type PublicReadQueryName =
  | "getPublicShellStatus"
  | "getDashboardBundle"
  | "listPublicRepacks"
  | "getPublicRepack"
  | "searchPublicCollectibles"
  | "findRepacksByDesiredCollectible";

export type PublicReadRouteSurface =
  | "overview"
  | "all_repacks"
  | "learn"
  | "article"
  | "not_found";

export type PublicReadFailureCode =
  | "INVALID_QUERY"
  | "CURSOR_EXPIRED"
  | "RELEASE_UNAVAILABLE"
  | "REPACK_NOT_FOUND"
  | "COLLECTIBLE_NOT_FOUND"
  | "TRANSPORT_UNAVAILABLE";

export type PublicReadFailureBeacon = Readonly<{
  schemaVersion: typeof PUBLIC_READ_FAILURE_SCHEMA_VERSION;
  eventId: string;
  queryName: PublicReadQueryName;
  routeSurface: PublicReadRouteSurface;
  errorCode: PublicReadFailureCode;
  publicReleaseId: string | null;
  retainedPreviousResult: boolean;
  occurredAt: string;
}>;

export type TelemetryErrorCode =
  | "ORIGIN_REJECTED"
  | "UNSUPPORTED_MEDIA"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_EVENT"
  | "INVALID_CONTEXT"
  | "RATE_LIMITED"
  | "EVENT_UNAVAILABLE";

export type TelemetryResponse =
  | Readonly<{ ok: true; status: "accepted" | "duplicate" }>
  | Readonly<{ ok: false; error: string; code: TelemetryErrorCode }>;

export type ParseTelemetryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false }>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_REPACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VENDOR_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validBase(
  record: Record<string, unknown>,
  now: number,
): boolean {
  return (
    record.schemaVersion === TELEMETRY_SCHEMA_VERSION &&
    typeof record.eventId === "string" &&
    UUID_PATTERN.test(record.eventId) &&
    typeof record.publicReleaseId === "string" &&
    UUID_PATTERN.test(record.publicReleaseId) &&
    validOccurredAt(record.occurredAt, now)
  );
}

export function validOccurredAt(value: unknown, now: number): value is string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const occurredAt = Date.parse(value);
  const canonical = Number.isFinite(occurredAt)
    ? new Date(occurredAt).toISOString()
    : null;
  const expectedCanonical = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_, fraction: string) =>
        `.${fraction.padEnd(3, "0")}Z`,
      )
    : value.replace(/Z$/, ".000Z");
  return (
    Number.isFinite(occurredAt) &&
    canonical === expectedCanonical &&
    occurredAt >= now - TELEMETRY_MAX_AGE_MS &&
    occurredAt <= now + TELEMETRY_MAX_FUTURE_MS
  );
}

export function parseAnonymousProductEvent(
  input: unknown,
  now: number = Date.now(),
): ParseTelemetryResult<AnonymousProductEvent> {
  if (!isRecord(input) || !validBase(input, now)) return { ok: false };

  const common = [
    "schemaVersion",
    "eventId",
    "publicReleaseId",
    "occurredAt",
    "name",
    "outcome",
  ] as const;

  if (input.name === "dashboard_view") {
    if (
      !hasExactKeys(input, [...common, "surface"]) ||
      !isOneOf(input.surface, ["overview", "all_repacks"]) ||
      input.outcome !== "rendered"
    ) {
      return { ok: false };
    }
  } else if (input.name === "repack_search") {
    if (
      !hasExactKeys(input, [
        ...common,
        "surface",
        "queryLengthBucket",
        "resultCountBucket",
      ]) ||
      input.surface !== "all_repacks" ||
      !isOneOf(input.outcome, ["results", "no_matches", "failed"]) ||
      !isOneOf(input.queryLengthBucket, ["1-20", "21-60", "61-120"]) ||
      !isOneOf(input.resultCountBucket, ["0", "1-25", "26-100", "101+"])
    ) {
      return { ok: false };
    }
  } else if (input.name === "filters_applied") {
    if (
      !hasExactKeys(input, [
        ...common,
        "surface",
        "activeFilterCount",
        "resultCountBucket",
      ]) ||
      !isOneOf(input.surface, ["overview", "all_repacks"]) ||
      !isOneOf(input.outcome, ["results", "no_matches", "failed"]) ||
      !isOneOf(input.resultCountBucket, ["0", "1-25", "26-100", "101+"]) ||
      ![0, 1, 2, 3, 4].includes(input.activeFilterCount as number)
    ) {
      return { ok: false };
    }
  } else if (input.name === "promo_copied") {
    if (
      !hasExactKeys(input, [...common, "publicRepackId", "vendorKey"]) ||
      typeof input.publicRepackId !== "string" ||
      !PUBLIC_REPACK_ID_PATTERN.test(input.publicRepackId) ||
      typeof input.vendorKey !== "string" ||
      !VENDOR_KEY_PATTERN.test(input.vendorKey) ||
      !isOneOf(input.outcome, ["clipboard", "manual_fallback", "failed"])
    ) {
      return { ok: false };
    }
  } else if (input.name === "repack_link_opened") {
    if (
      !hasExactKeys(input, [...common, "publicRepackId", "vendorKey"]) ||
      typeof input.publicRepackId !== "string" ||
      !PUBLIC_REPACK_ID_PATTERN.test(input.publicRepackId) ||
      typeof input.vendorKey !== "string" ||
      !VENDOR_KEY_PATTERN.test(input.vendorKey) ||
      !isOneOf(input.outcome, ["opened", "blocked"])
    ) {
      return { ok: false };
    }
  } else {
    return { ok: false };
  }

  return { ok: true, value: input as AnonymousProductEvent };
}

const ALLOWED_FAILURES: Readonly<
  Record<PublicReadQueryName, readonly PublicReadFailureCode[]>
> = Object.freeze({
  getPublicShellStatus: ["RELEASE_UNAVAILABLE", "TRANSPORT_UNAVAILABLE"],
  getDashboardBundle: [
    "INVALID_QUERY",
    "RELEASE_UNAVAILABLE",
    "TRANSPORT_UNAVAILABLE",
  ],
  listPublicRepacks: [
    "INVALID_QUERY",
    "CURSOR_EXPIRED",
    "RELEASE_UNAVAILABLE",
    "TRANSPORT_UNAVAILABLE",
  ],
  getPublicRepack: [
    "INVALID_QUERY",
    "RELEASE_UNAVAILABLE",
    "REPACK_NOT_FOUND",
    "TRANSPORT_UNAVAILABLE",
  ],
  searchPublicCollectibles: [
    "INVALID_QUERY",
    "RELEASE_UNAVAILABLE",
    "TRANSPORT_UNAVAILABLE",
  ],
  findRepacksByDesiredCollectible: [
    "INVALID_QUERY",
    "RELEASE_UNAVAILABLE",
    "COLLECTIBLE_NOT_FOUND",
    "TRANSPORT_UNAVAILABLE",
  ],
});

export function parsePublicReadFailureBeacon(
  input: unknown,
  now: number = Date.now(),
): ParseTelemetryResult<PublicReadFailureBeacon> {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "eventId",
      "queryName",
      "routeSurface",
      "errorCode",
      "publicReleaseId",
      "retainedPreviousResult",
      "occurredAt",
    ]) ||
    input.schemaVersion !== PUBLIC_READ_FAILURE_SCHEMA_VERSION ||
    typeof input.eventId !== "string" ||
    !UUID_PATTERN.test(input.eventId) ||
    !isOneOf(input.queryName, [
      "getPublicShellStatus",
      "getDashboardBundle",
      "listPublicRepacks",
      "getPublicRepack",
      "searchPublicCollectibles",
      "findRepacksByDesiredCollectible",
    ]) ||
    !isOneOf(input.routeSurface, [
      "overview",
      "all_repacks",
      "learn",
      "article",
      "not_found",
    ]) ||
    !isOneOf(input.errorCode, [
      "INVALID_QUERY",
      "CURSOR_EXPIRED",
      "RELEASE_UNAVAILABLE",
      "REPACK_NOT_FOUND",
      "COLLECTIBLE_NOT_FOUND",
      "TRANSPORT_UNAVAILABLE",
    ]) ||
    (input.publicReleaseId !== null &&
      (typeof input.publicReleaseId !== "string" ||
        !UUID_PATTERN.test(input.publicReleaseId))) ||
    typeof input.retainedPreviousResult !== "boolean" ||
    (input.retainedPreviousResult === true && input.publicReleaseId === null) ||
    !validOccurredAt(input.occurredAt, now) ||
    !ALLOWED_FAILURES[input.queryName].includes(input.errorCode)
  ) {
    return { ok: false };
  }

  return { ok: true, value: input as PublicReadFailureBeacon };
}

export function telemetryContext(
  event: AnonymousProductEvent | PublicReadFailureBeacon,
): Readonly<{
  publicReleaseId: string | null;
  publicRepackId: string | null;
  vendorKey: string | null;
}> {
  return {
    publicReleaseId: event.publicReleaseId,
    publicRepackId: "publicRepackId" in event ? event.publicRepackId : null,
    vendorKey: "vendorKey" in event ? event.vendorKey : null,
  };
}
