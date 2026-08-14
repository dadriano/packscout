import {
  TELEMETRY_REQUEST_MAX_BYTES,
  type ParseTelemetryResult,
  type TelemetryErrorCode,
  type TelemetryResponse,
} from "./telemetry-contract";

export type ContextValidationResult = "valid" | "invalid" | "unavailable";
export type IngressCapacityResult = "allowed" | "rate_limited" | "unavailable";
export type TelemetryWriteResult =
  | "accepted"
  | "duplicate"
  | "rate_limited"
  | "unavailable";

export type TelemetryIngressDependencies<TEvent> = Readonly<{
  publicOrigin: string | null;
  now?: () => number;
  parse: (input: unknown, now: number) => ParseTelemetryResult<TEvent>;
  validateContext: (event: TEvent) => Promise<ContextValidationResult>;
  claimCapacity: () => Promise<IngressCapacityResult>;
  write: (event: TEvent) => Promise<TelemetryWriteResult>;
}>;

const ERROR_COPY: Readonly<Record<TelemetryErrorCode, string>> = Object.freeze({
  ORIGIN_REJECTED: "Request origin is not allowed.",
  UNSUPPORTED_MEDIA: "Request media type is not supported.",
  PAYLOAD_TOO_LARGE: "Request payload is too large.",
  INVALID_EVENT: "Telemetry event is invalid.",
  INVALID_CONTEXT: "Telemetry event context is invalid.",
  RATE_LIMITED: "Too many telemetry requests.",
  EVENT_UNAVAILABLE: "Telemetry is temporarily unavailable.",
});

const ERROR_STATUS: Readonly<Record<TelemetryErrorCode, number>> = Object.freeze({
  ORIGIN_REJECTED: 403,
  UNSUPPORTED_MEDIA: 415,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_EVENT: 400,
  INVALID_CONTEXT: 400,
  RATE_LIMITED: 429,
  EVENT_UNAVAILABLE: 503,
});

function jsonResponse(body: TelemetryResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function failure(code: TelemetryErrorCode): Response {
  return jsonResponse(
    { ok: false, error: ERROR_COPY[code], code },
    ERROR_STATUS[code],
  );
}

export function configuredPublicOrigin(
  value: string | undefined = process.env.PACKSCOUT_PUBLIC_ORIGIN,
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.username ||
      parsed.password ||
      candidate !== parsed.origin ||
      (parsed.protocol !== "https:" &&
        !(
          nodeEnvironment !== "production" &&
          parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
        ))
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function exactJsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  return value
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "application/json";
}

function validOriginAndFetchMetadata(
  request: Request,
  publicOrigin: string | null,
): boolean {
  return (
    publicOrigin !== null &&
    request.headers.get("origin") === publicOrigin &&
    request.headers.get("sec-fetch-site") === "same-origin"
  );
}

function declaredBodySize(request: Request): number | null | "invalid" {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return "invalid";
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : "invalid";
}

async function parseRequestBody<TEvent>(
  request: Request,
  parse: TelemetryIngressDependencies<TEvent>["parse"],
  now: number,
): Promise<ParseTelemetryResult<TEvent> | "too_large"> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > TELEMETRY_REQUEST_MAX_BYTES) return "too_large";

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }

  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  return parse(input, now);
}

export function createTelemetryIngressHandler<TEvent>(
  dependencies: TelemetryIngressDependencies<TEvent>,
): (request: Request) => Promise<Response> {
  return async function telemetryIngress(request: Request): Promise<Response> {
    if (!validOriginAndFetchMetadata(request, dependencies.publicOrigin)) {
      return failure("ORIGIN_REJECTED");
    }

    const contentEncoding = request.headers.get("content-encoding");
    if (
      (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") ||
      !exactJsonMediaType(request.headers.get("content-type"))
    ) {
      return failure("UNSUPPORTED_MEDIA");
    }

    const declaredSize = declaredBodySize(request);
    if (declaredSize === "invalid") return failure("INVALID_EVENT");
    if (
      declaredSize !== null &&
      declaredSize > TELEMETRY_REQUEST_MAX_BYTES
    ) {
      return failure("PAYLOAD_TOO_LARGE");
    }

    let parsed: ParseTelemetryResult<TEvent> | "too_large";
    try {
      parsed = await parseRequestBody(
        request,
        dependencies.parse,
        (dependencies.now ?? Date.now)(),
      );
    } catch {
      return failure("INVALID_EVENT");
    }
    if (parsed === "too_large") return failure("PAYLOAD_TOO_LARGE");
    if (!parsed.ok) return failure("INVALID_EVENT");

    let context: ContextValidationResult;
    try {
      context = await dependencies.validateContext(parsed.value);
    } catch {
      return failure("EVENT_UNAVAILABLE");
    }
    if (context === "invalid") return failure("INVALID_CONTEXT");
    if (context === "unavailable") return failure("EVENT_UNAVAILABLE");

    let capacity: IngressCapacityResult;
    try {
      capacity = await dependencies.claimCapacity();
    } catch {
      return failure("EVENT_UNAVAILABLE");
    }
    if (capacity === "rate_limited") return failure("RATE_LIMITED");
    if (capacity === "unavailable") return failure("EVENT_UNAVAILABLE");

    let write: TelemetryWriteResult;
    try {
      write = await dependencies.write(parsed.value);
    } catch {
      return failure("EVENT_UNAVAILABLE");
    }
    if (write === "rate_limited") return failure("RATE_LIMITED");
    if (write === "unavailable") return failure("EVENT_UNAVAILABLE");
    return jsonResponse(
      { ok: true, status: write },
      write === "accepted" ? 202 : 200,
    );
  };
}

export function unavailableTelemetryDependencies<TEvent>(
  publicOrigin: string | null,
  parse: TelemetryIngressDependencies<TEvent>["parse"],
): TelemetryIngressDependencies<TEvent> {
  return {
    publicOrigin,
    parse,
    claimCapacity: async () => "unavailable",
    validateContext: async () => "unavailable",
    write: async () => "unavailable",
  };
}
