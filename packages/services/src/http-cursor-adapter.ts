import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  safeValidateProviderFeedPageV1,
  ProviderFeedValidationError,
} from "@packscout/contracts";
import {
  ProviderTransportRequestError,
  type NormalizedProviderTransportFailure,
  type ProviderConnectionTestResult,
  type ProviderTransportAdapter,
  type ProviderTransportConnectionInput,
  type ProviderTransportFailureCode,
  type ProviderTransportPageInput,
} from "./provider-adapter.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export type ProviderHttpClient = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderDnsResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export interface HttpCursorAdapterDependencies {
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
    "fieldPaths" | "httpStatus"
  > = {},
): NormalizedProviderTransportFailure {
  return Object.freeze({ code, retryable, ...details });
}

function requestError(
  code: ProviderTransportFailureCode,
  retryable: boolean,
  details?: Pick<
    NormalizedProviderTransportFailure,
    "fieldPaths" | "httpStatus"
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
  if (
    url.protocol !== "https:" ||
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
  url.searchParams.set("platform", input.platform);
  url.searchParams.delete("cursor");
  if (input.cursor !== null) url.searchParams.set("cursor", input.cursor);
  return url;
}

function buildRequestHeaders(input: ProviderTransportPageInput): Headers {
  const headers = new Headers({ Accept: "application/json" });
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
): Promise<void> {
  const hostname = canonicalHostname(url.hostname);
  if (isIP(hostname) !== 0) {
    if (!isPublicProviderAddress(hostname)) {
      throw requestError("destination_not_allowed", false);
    }
    return;
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

export class HttpCursorAdapter implements ProviderTransportAdapter {
  readonly key = "http-cursor-v1";
  readonly #httpClient: ProviderHttpClient;
  readonly #resolveHost: ProviderDnsResolver;
  readonly #now: () => number;

  constructor(dependencies: HttpCursorAdapterDependencies = {}) {
    this.#httpClient =
      dependencies.httpClient ?? globalThis.fetch.bind(globalThis);
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
      const result = await this.fetchPage({ ...input, cursor: null });
      return {
        ok: true,
        latencyMs: normalizedLatency(startedAt, this.#now()),
        recordCounts: {
          catalog: result.rawPage.catalog.length,
          pulls: result.rawPage.pulls.length,
          sales: result.rawPage.sales.length,
        },
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
      await validateResolvedDestination(
        url,
        this.#resolveHost,
        requestLifetime.signal,
      );
      const response = await this.#httpClient(url, {
        method: "GET",
        headers: buildRequestHeaders(input),
        redirect: "manual",
        signal: requestLifetime.signal,
      });
      if (!response.ok) {
        throw requestError(
          "http_error",
          isRetryableHttpStatus(response.status),
          { httpStatus: response.status },
        );
      }
      const responseText = await readBoundedResponse(response, maximumBytes);
      let responseValue: unknown;
      try {
        responseValue = JSON.parse(responseText) as unknown;
      } catch {
        throw requestError("invalid_json", false);
      }
      const validated = safeValidateProviderFeedPageV1(responseValue, {
        requestedPlatform: input.platform,
        requestedCursor: input.cursor,
        seenCursors: input.seenCursors,
      });
      if (!validated.success) {
        throw new ProviderFeedValidationError(validated.error.issues);
      }
      return validated.data;
    } catch (error) {
      if (requestLifetime.didTimeOut()) throw requestError("timeout", true);
      if (error instanceof ProviderTransportRequestError) throw error;
      if (error instanceof ProviderFeedValidationError) {
        throw requestError("invalid_response", false, {
          fieldPaths: error.issues.map((issue) => issue.path),
        });
      }
      throw requestError("network_error", true);
    } finally {
      requestLifetime.cleanup();
    }
  }
}
