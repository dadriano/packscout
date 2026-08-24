import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  requestPinnedProviderHttp,
  type PinnedProviderDestination,
  type PinnedProviderHttpClient,
} from "./pinned-provider-http-client.ts";

export type HardenedProviderRequestErrorCode =
  | "cancelled"
  | "destination_not_allowed"
  | "destination_resolution_failed"
  | "http_status"
  | "invalid_configuration"
  | "network_error"
  | "redirect_rejected"
  | "request_timeout"
  | "response_too_large"
  | "tls_failed";

export class HardenedProviderRequestError extends Error {
  readonly code: HardenedProviderRequestErrorCode;
  readonly safeStatus: number | undefined;
  readonly durationMilliseconds: number;
  readonly responseBytes: number;

  constructor(
    code: HardenedProviderRequestErrorCode,
    safeStatus?: number,
    durationMilliseconds = 0,
    responseBytes = 0,
  ) {
    super(`hardened_provider_request.${code}`);
    this.name = "HardenedProviderRequestError";
    this.code = code;
    this.safeStatus = safeStatus;
    this.durationMilliseconds = durationMilliseconds;
    this.responseBytes = responseBytes;
  }
}

export type ProviderDnsResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export interface HardenedProviderRequestInput {
  readonly url: URL;
  readonly allowedHosts: readonly string[];
  readonly headers?: RequestInit["headers"];
  readonly timeoutMilliseconds: number;
  readonly maximumResponseBytes: number;
  readonly signal: AbortSignal;
  readonly allowLocalHttp?: boolean;
}

export interface HardenedProviderRequestDependencies {
  readonly httpClient?: PinnedProviderHttpClient;
  readonly resolveHost?: ProviderDnsResolver;
  readonly now?: () => number;
}

export interface HardenedProviderResponseCapture {
  readonly status: number;
  readonly protectedBody: Uint8Array;
  readonly durationMilliseconds: number;
  readonly responseBytes: number;
}

interface RequestLifetime {
  readonly signal: AbortSignal;
  readonly didTimeOut: () => boolean;
  readonly parentWasAborted: () => boolean;
  readonly cleanup: () => void;
}

function fail(
  code: HardenedProviderRequestErrorCode,
  safeStatus?: number,
): never {
  throw new HardenedProviderRequestError(code, safeStatus);
}

function canonicalHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}

function canonicalAllowedHost(host: string): string {
  if (
    host.length === 0 ||
    host !== host.trim() ||
    /[\s/@?#*]/u.test(host) ||
    (host.includes(":") && !(host.startsWith("[") && host.endsWith("]")))
  ) {
    fail("invalid_configuration");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    fail("invalid_configuration");
  }
  if (parsed.pathname !== "/" || parsed.port.length > 0) {
    fail("invalid_configuration");
  }
  const normalized = canonicalHostname(parsed.hostname);
  if (normalized.length === 0) fail("invalid_configuration");
  return normalized;
}

function validateRequestDestination(
  input: HardenedProviderRequestInput,
): Readonly<{ url: URL; hostname: string; localHttp: boolean }> {
  const url = new URL(input.url.toString());
  const hostname = canonicalHostname(url.hostname);
  const localHttp =
    input.allowLocalHttp === true &&
    url.protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    (!localHttp && url.port.length > 0 && url.port !== "443")
  ) {
    fail("invalid_configuration");
  }
  const allowedHosts = new Set(input.allowedHosts.map(canonicalAllowedHost));
  if (!allowedHosts.has(hostname)) fail("destination_not_allowed");
  return { url, hostname, localHttp };
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
  return !(first === 203 && second === 0 && third === 113);
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

function createRequestLifetime(
  parentSignal: AbortSignal,
  timeoutMilliseconds: number,
): RequestLifetime {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 60_000
  ) {
    fail("invalid_configuration");
  }
  const controller = new AbortController();
  let timedOut = false;
  let parentAborted = parentSignal.aborted;
  const abortFromParent = () => {
    parentAborted = true;
    controller.abort();
  };
  if (parentAborted) controller.abort();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMilliseconds);
  timeout.unref();
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    parentWasAborted: () => parentAborted,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

async function beforeAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function resolveDestination(
  hostname: string,
  localHttp: boolean,
  resolveHost: ProviderDnsResolver,
  signal: AbortSignal,
): Promise<PinnedProviderDestination> {
  if (localHttp && (hostname === "127.0.0.1" || hostname === "::1")) {
    return { hostname, addresses: [hostname] };
  }
  if (localHttp && hostname === "localhost") {
    let addresses: readonly string[];
    try {
      addresses = await beforeAbort(resolveHost(hostname, signal), signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      fail("destination_resolution_failed");
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => address !== "127.0.0.1" && address !== "::1")
    ) {
      fail("destination_not_allowed");
    }
    return { hostname, addresses };
  }
  if (isIP(hostname) !== 0) {
    if (!isPublicProviderAddress(hostname)) fail("destination_not_allowed");
    return { hostname, addresses: [hostname] };
  }
  let addresses: readonly string[];
  try {
    addresses = await beforeAbort(resolveHost(hostname, signal), signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    fail("destination_resolution_failed");
  }
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    fail("destination_resolution_failed");
  }
  if (addresses.some((address) => !isPublicProviderAddress(address))) {
    fail("destination_not_allowed");
  }
  return { hostname, addresses };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("invalid_configuration");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      await cancelBody(response);
      fail("response_too_large");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await beforeAbort(reader.read(), signal);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail("response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isTlsFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { code?: unknown }).code ?? "");
  return /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/u.test(code);
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  const elapsed = finishedAt - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0;
}

export async function captureHardenedProviderResponse(
  input: HardenedProviderRequestInput,
  dependencies: HardenedProviderRequestDependencies = {},
): Promise<HardenedProviderResponseCapture> {
  const { url, hostname, localHttp } = validateRequestDestination(input);
  const lifetime = createRequestLifetime(input.signal, input.timeoutMilliseconds);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  try {
    const destination = await resolveDestination(
      hostname,
      localHttp,
      dependencies.resolveHost ?? defaultDnsResolver,
      lifetime.signal,
    );
    const response = await beforeAbort(
      (dependencies.httpClient ?? requestPinnedProviderHttp)(
        url,
        {
          method: "GET",
          headers: input.headers,
          redirect: "manual",
          signal: lifetime.signal,
        },
        destination,
      ),
      lifetime.signal,
    );
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      fail("redirect_rejected", response.status);
    }
    if (!response.ok) {
      await cancelBody(response);
      fail("http_status", response.status);
    }
    const protectedBody = await readBoundedBody(
      response,
      input.maximumResponseBytes,
      lifetime.signal,
    );
    return Object.freeze({
      status: response.status,
      protectedBody,
      durationMilliseconds: elapsedMilliseconds(startedAt, now()),
      responseBytes: protectedBody.byteLength,
    });
  } catch (error) {
    const durationMilliseconds = elapsedMilliseconds(startedAt, now());
    if (lifetime.parentWasAborted()) {
      throw new HardenedProviderRequestError(
        "cancelled",
        undefined,
        durationMilliseconds,
      );
    }
    if (lifetime.didTimeOut()) {
      throw new HardenedProviderRequestError(
        "request_timeout",
        undefined,
        durationMilliseconds,
      );
    }
    if (error instanceof HardenedProviderRequestError) {
      throw new HardenedProviderRequestError(
        error.code,
        error.safeStatus,
        durationMilliseconds,
        error.responseBytes,
      );
    }
    if (isTlsFailure(error)) {
      throw new HardenedProviderRequestError(
        "tls_failed",
        undefined,
        durationMilliseconds,
      );
    }
    throw new HardenedProviderRequestError(
      "network_error",
      undefined,
      durationMilliseconds,
    );
  } finally {
    lifetime.cleanup();
  }
}
