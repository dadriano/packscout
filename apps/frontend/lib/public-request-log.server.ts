export type PublicRequestLogEntry = Readonly<{
  pathname: string;
  source:
    | "server-preload"
    | "reactive-client"
    | "telemetry-route"
    | "public-read-failure-route";
  outcome:
    | "succeeded"
    | "accepted"
    | "duplicate"
    | "rejected"
    | "failed"
    | "unavailable";
  code:
    | "INVALID_QUERY"
    | "CURSOR_EXPIRED"
    | "RELEASE_UNAVAILABLE"
    | "REPACK_NOT_FOUND"
    | "COLLECTIBLE_NOT_FOUND"
    | "TRANSPORT_UNAVAILABLE"
    | "ORIGIN_REJECTED"
    | "UNSUPPORTED_MEDIA"
    | "PAYLOAD_TOO_LARGE"
    | "INVALID_EVENT"
    | "INVALID_CONTEXT"
    | "RATE_LIMITED"
    | "EVENT_UNAVAILABLE"
    | null;
  publicReleaseId: string | null;
  retainedPreviousResult: boolean;
}>;

type PublicRequestLogInput = PublicRequestLogEntry;

const PATHNAME_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/;
const PUBLIC_RELEASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = [
  "server-preload",
  "reactive-client",
  "telemetry-route",
  "public-read-failure-route",
] as const;
const OUTCOMES = [
  "succeeded",
  "accepted",
  "duplicate",
  "rejected",
  "failed",
  "unavailable",
] as const;
const CODES = [
  "INVALID_QUERY",
  "CURSOR_EXPIRED",
  "RELEASE_UNAVAILABLE",
  "REPACK_NOT_FOUND",
  "COLLECTIBLE_NOT_FOUND",
  "TRANSPORT_UNAVAILABLE",
  "ORIGIN_REJECTED",
  "UNSUPPORTED_MEDIA",
  "PAYLOAD_TOO_LARGE",
  "INVALID_EVENT",
  "INVALID_CONTEXT",
  "RATE_LIMITED",
  "EVENT_UNAVAILABLE",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPublicRequestLogEntry(
  input: unknown,
): PublicRequestLogEntry | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 6 ||
    keys.join("|") !==
      "code|outcome|pathname|publicReleaseId|retainedPreviousResult|source"
  ) {
    return null;
  }

  const pathname = input.pathname;
  const publicReleaseId = input.publicReleaseId;
  if (
    typeof pathname !== "string" ||
    pathname.length > 160 ||
    !PATHNAME_PATTERN.test(pathname) ||
    !SOURCES.includes(input.source as (typeof SOURCES)[number]) ||
    !OUTCOMES.includes(input.outcome as (typeof OUTCOMES)[number]) ||
    (input.code !== null &&
      !CODES.includes(input.code as (typeof CODES)[number])) ||
    (publicReleaseId !== null &&
      (typeof publicReleaseId !== "string" ||
        !PUBLIC_RELEASE_ID_PATTERN.test(publicReleaseId))) ||
    typeof input.retainedPreviousResult !== "boolean"
  ) {
    return null;
  }

  return Object.freeze({
    pathname,
    source: input.source,
    outcome: input.outcome,
    code: input.code,
    publicReleaseId,
    retainedPreviousResult: input.retainedPreviousResult,
  } as PublicRequestLogInput);
}
