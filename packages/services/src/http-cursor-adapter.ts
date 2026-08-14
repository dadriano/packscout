import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  safeValidateProviderStreamPageV2,
  ProviderStreamValidationError,
} from "@packscout/contracts";
import {
  ProviderTransportRequestError,
  type ProviderHttpResponseDecoderV2,
  type ProviderHttpResponseDecodeResultV2,
  type NormalizedProviderTransportFailure,
  type ProviderConnectionTestResult,
  type ProviderTransportAdapter,
  type ProviderTransportConnectionInput,
  type ProviderTransportFailureCode,
  type ProviderTransportPageInput,
} from "./provider-adapter.ts";
import {
  requestPinnedProviderHttp,
  type PinnedProviderDestination,
  type PinnedProviderHttpClient,
} from "./pinned-provider-http-client.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export type ProviderHttpClient = PinnedProviderHttpClient;

export type ProviderDnsResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export interface HttpCursorAdapterDependencies {
  readonly decoder: ProviderHttpResponseDecoderV2;
  readonly httpClient?: ProviderHttpClient;
  readonly resolveHost?: ProviderDnsResolver;
  readonly now?: () => number;
}

interface RequestLifetime {
  readonly signal: AbortSignal;
  readonly didTimeOut: () => boolean;
  readonly cleanup: () => void;
}

function failure(
  code: ProviderTransportFailureCode,
  retryable: boolean,
  details: Pick<
    NormalizedProviderTransportFailure,
    "fieldPaths" | "httpStatus" | "issueCodes"
  > = {},
): NormalizedProviderTransportFailure {
  return Object.freeze({ code, retryable, ...details });
}

function requestError(
  code: ProviderTransportFailureCode,
  retryable: boolean,
  details?: Pick<
    NormalizedProviderTransportFailure,
    "fieldPaths" | "httpStatus" | "issueCodes"
  >,
): ProviderTransportRequestError {
  return new ProviderTransportRequestError(failure(code, retryable, details));
}

function requireBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw requestError("invalid_configuration", false);
  }
  return resolved;
}

function validateRequestInput(input: ProviderTransportPageInput): void {
  if (
    input.platform.trim().length === 0 ||
    input.cursor === "" ||
    (input.cursor !== null && input.cursor.length > 2_048) ||
    input.allowedHosts.length === 0
  ) {
    throw requestError("invalid_configuration", false);
  }
  if (
    input.auth.mode === "bearer" &&
    (input.auth.token.length === 0 || /[\r\n]/.test(input.auth.token))
  ) {
    throw requestError("invalid_configuration", false);
  }
}

function canonicalHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function canonicalAllowedHost(host: string): string {
  if (
    host.length === 0 ||
    host !== host.trim() ||
    /[\s/@?#*]/.test(host) ||
    (host.includes(":") && !(host.startsWith("[") && host.endsWith("]")))
  ) {
    throw requestError("invalid_configuration", false);
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw requestError("invalid_configuration", false);
  }
  if (parsed.pathname !== "/" || parsed.port.length > 0) {
    throw requestError("invalid_configuration", false);
  }
  const normalized = canonicalHostname(parsed.hostname);
  if (normalized.length === 0) {
    throw requestError("invalid_configuration", false);
  }
  return normalized;
}

function buildRequestUrl(input: ProviderTransportPageInput): URL {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw requestError("invalid_configuration", false);
  }
  const hostname = canonicalHostname(url.hostname);
  const localHttp =
    input.allowLocalHttp === true &&
    url.protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw requestError("invalid_configuration", false);
  }
  const allowedHosts = new Set(input.allowedHosts.map(canonicalAllowedHost));
  if (!allowedHosts.has(canonicalHostname(url.hostname))) {
    throw requestError("destination_not_allowed", false);
  }
  url.hash = "";
  url.search = "";
  url.searchParams.set("platform", input.platform);
  if (input.cursor !== null) url.searchParams.set("cursor", input.cursor);
  return url;
}

function buildRequestHeaders(input: ProviderTransportPageInput): Headers {
  const headers = new Headers({
    Accept: "application/json, application/x-ndjson",
  });
  if (input.auth.mode === "bearer") {
    headers.set("Authorization", `Bearer ${input.auth.token}`);
  }
  return headers;
}

function createRequestLifetime(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestLifetime {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return false;
  const [first = -1, second = -1, third = -1] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (
    first === 192 &&
    ((second === 31 && third === 196) ||
      (second === 52 && third === 193) ||
      (second === 88 && third === 99) ||
      (second === 175 && third === 48))
  ) {
    return false;
  }
  if (
    first === 198 &&
    (second === 18 || second === 19 || (second === 51 && third === 100))
  ) {
    return false;
  }
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function ipv6Segments(address: string): readonly number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes("%")) return null;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    normalized = `${normalized.slice(0, lastColon)}:${(
      ((octets[0] ?? 0) << 8) |
      (octets[1] ?? 0)
    ).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0]?.length ? halves[0].split(":") : [];
  const right = halves[1]?.length ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  const values = parts.map((part) => Number.parseInt(part, 16));
  return values.length === 8 && values.every(Number.isFinite) ? values : null;
}

function isPublicIpv6(address: string): boolean {
  const segments = ipv6Segments(address);
  if (!segments) return false;
  const first = segments[0] ?? 0;
  const second = segments[1] ?? 0;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  return true;
}

function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? isPublicIpv4(address)
    : family === 6 && isPublicIpv6(address);
}

const defaultDnsResolver: ProviderDnsResolver = async (hostname) => {
  if (isIP(hostname) !== 0) return [hostname];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
};

async function resolveBeforeAbort(
  resolveHost: ProviderDnsResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void resolveHost(hostname, signal).then(
      (addresses) => {
        signal.removeEventListener("abort", abort);
        resolve(addresses);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function validateResolvedDestination(
  url: URL,
  resolveHost: ProviderDnsResolver,
  signal: AbortSignal,
  allowLocalHttp: boolean,
): Promise<PinnedProviderDestination> {
  const hostname = canonicalHostname(url.hostname);
  if (
    allowLocalHttp &&
    url.protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
  ) {
    if (hostname === "localhost") {
      let addresses: readonly string[];
      try {
        addresses = await resolveBeforeAbort(resolveHost, hostname, signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw requestError("destination_resolution_failed", true);
      }
      if (
        addresses.length === 0 ||
        addresses.some(
          (address) => address !== "127.0.0.1" && address !== "::1",
        )
      ) {
        throw requestError("destination_not_allowed", false);
      }
      return { hostname, addresses };
    }
    return { hostname, addresses: [hostname] };
  }
  if (isIP(hostname) !== 0) {
    if (!isPublicProviderAddress(hostname)) {
      throw requestError("destination_not_allowed", false);
    }
    return { hostname, addresses: [hostname] };
  }
  let addresses: readonly string[];
  try {
    addresses = await resolveBeforeAbort(resolveHost, hostname, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw requestError("destination_resolution_failed", true);
  }
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    throw requestError("destination_resolution_failed", true);
  }
  if (addresses.some((address) => !isPublicProviderAddress(address))) {
    throw requestError("destination_not_allowed", false);
  }
  return { hostname, addresses };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw requestError("response_too_large", false);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw requestError("response_too_large", false);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function normalizedLatency(startedAt: number, finishedAt: number): number {
  const elapsed = finishedAt - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

function responseHeaders(response: Response): Readonly<Record<string, string>> {
  const headers = Object.create(null) as Record<string, string>;
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return Object.freeze(headers);
}

function decoderFailure(
  result: Extract<ProviderHttpResponseDecodeResultV2, { readonly ok: false }>,
): ProviderTransportRequestError {
  const safeFieldPath = /^(?:\$|records(?:\[[0-9]+\])?(?:\.[A-Za-z0-9_$-]+)*|nextCursor|hasMore)$/;
  const safeIssueCode = /^[a-z0-9_]{1,128}$/;
  const fieldPaths = result.fieldPaths
    ?.filter((value) => safeFieldPath.test(value))
    .slice(0, 100);
  const issueCodes = result.issueCodes
    ?.filter((value) => safeIssueCode.test(value))
    .slice(0, 100);
  return requestError(result.code, false, {
    ...(fieldPaths && fieldPaths.length > 0 ? { fieldPaths } : {}),
    ...(issueCodes && issueCodes.length > 0 ? { issueCodes } : {}),
  });
}

export class HttpCursorAdapter implements ProviderTransportAdapter {
  readonly key = "http-cursor-v2";
  readonly #decoder: ProviderHttpResponseDecoderV2;
  readonly #httpClient: ProviderHttpClient;
  readonly #resolveHost: ProviderDnsResolver;
  readonly #now: () => number;

  constructor(dependencies: HttpCursorAdapterDependencies) {
    if (typeof dependencies.decoder?.decode !== "function") {
      throw new TypeError("A provider response decoder is required.");
    }
    this.#decoder = dependencies.decoder;
    this.#httpClient =
      dependencies.httpClient ?? requestPinnedProviderHttp;
    this.#resolveHost = dependencies.resolveHost ?? defaultDnsResolver;
    this.#now = dependencies.now ?? Date.now;
  }

  supportsPlatform(platform: string): boolean {
    return platform.trim().length > 0;
  }

  async testConnection(
    input: ProviderTransportConnectionInput,
  ): Promise<ProviderConnectionTestResult> {
    const startedAt = this.#now();
    try {
      const { page, responseStatus } = await this.#fetchPageWithMetadata({
        ...input,
        cursor: null,
      });
      if (page.invalidRecords.length > 0) {
        return {
          ok: false,
          latencyMs: normalizedLatency(startedAt, this.#now()),
          failure: failure("invalid_response", false, {
            fieldPaths: page.invalidRecords.flatMap((record) =>
              record.issues.map((issue) => issue.path),
            ),
          }),
        };
      }
      return {
        ok: true,
        latencyMs: normalizedLatency(startedAt, this.#now()),
        responseStatus,
        recordCounts: {
          catalog: page.page.records.filter(({ stream }) => stream === "catalog")
            .length,
          pulls: page.page.records.filter(({ stream }) => stream === "pulls")
            .length,
          trades: page.page.records.filter(({ stream }) => stream === "trades")
            .length,
        },
        hasMore: page.page.hasMore,
        nextCursorPresent: page.page.nextCursor.length > 0,
      };
    } catch (error) {
      const normalized =
        error instanceof ProviderTransportRequestError
          ? error.failure
          : failure("network_error", true);
      return {
        ok: false,
        latencyMs: normalizedLatency(startedAt, this.#now()),
        failure: normalized,
      };
    }
  }

  async fetchPage(input: ProviderTransportPageInput) {
    return (await this.#fetchPageWithMetadata(input)).page;
  }

  async #fetchPageWithMetadata(input: ProviderTransportPageInput) {
    validateRequestInput(input);
    const timeoutMs = requireBoundedInteger(
      input.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const maximumBytes = requireBoundedInteger(
      input.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
    const url = buildRequestUrl(input);
    const requestLifetime = createRequestLifetime(input.signal, timeoutMs);
    try {
      const destination = await validateResolvedDestination(
        url,
        this.#resolveHost,
        requestLifetime.signal,
        input.allowLocalHttp === true,
      );
      const response = await this.#httpClient(
        url,
        {
          method: "GET",
          headers: buildRequestHeaders(input),
          redirect: "manual",
          signal: requestLifetime.signal,
        },
        destination,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw requestError(
          "http_error",
          isRetryableHttpStatus(response.status),
          { httpStatus: response.status },
        );
      }
      const responseText = await readBoundedResponse(response, maximumBytes);
      let decoded: ProviderHttpResponseDecodeResultV2;
      try {
        decoded = await this.#decoder.decode({
          bodyText: responseText,
          contentType: response.headers.get("content-type"),
          headers: responseHeaders(response),
          requestedPlatform: input.platform,
          requestedCursor: input.cursor,
        });
      } catch {
        throw requestError("invalid_response", false);
      }
      if (!decoded.ok) throw decoderFailure(decoded);
      const validated = safeValidateProviderStreamPageV2({
        rawPage: decoded.page.rawPage,
        normalizedPage: {
          requestedCursor: input.cursor,
          nextCursor: decoded.page.nextCursor,
          hasMore: decoded.page.hasMore,
          records: decoded.page.records,
        },
        context: {
          requestedPlatform: input.platform,
          requestedCursor: input.cursor,
          seenCursors: input.seenCursors,
        },
      });
      if (!validated.success) {
        throw new ProviderStreamValidationError(validated.error.issues);
      }
      return { page: validated.data, responseStatus: response.status };
    } catch (error) {
      if (requestLifetime.didTimeOut()) throw requestError("timeout", true);
      if (error instanceof ProviderTransportRequestError) throw error;
      if (error instanceof ProviderStreamValidationError) {
        throw requestError("invalid_response", false, {
          fieldPaths: error.issues.map((issue) => issue.path),
          issueCodes: error.issues.map((issue) => issue.code),
        });
      }
      throw requestError("network_error", true);
    } finally {
      requestLifetime.cleanup();
    }
  }
}
