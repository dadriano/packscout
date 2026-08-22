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
import {
  captureHardenedProviderResponse,
  HardenedProviderRequestError,
  type ProviderDnsResolver,
} from "./hardened-provider-request.ts";
import {
  type PinnedProviderHttpClient,
} from "./pinned-provider-http-client.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export type ProviderHttpClient = PinnedProviderHttpClient;
export type { ProviderDnsResolver } from "./hardened-provider-request.ts";

export interface HttpCursorAdapterDependencies {
  readonly httpClient?: ProviderHttpClient;
  readonly resolveHost?: ProviderDnsResolver;
  readonly now?: () => number;
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

function buildRequestUrl(input: ProviderTransportPageInput): URL {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw requestError("invalid_configuration", false);
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

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function mapHardenedRequestError(
  error: HardenedProviderRequestError,
): ProviderTransportRequestError {
  if (error.code === "request_timeout") return requestError("timeout", true);
  if (error.code === "response_too_large") {
    return requestError("response_too_large", false);
  }
  if (error.code === "destination_not_allowed") {
    return requestError("destination_not_allowed", false);
  }
  if (error.code === "destination_resolution_failed") {
    return requestError("destination_resolution_failed", true);
  }
  if (error.code === "invalid_configuration") {
    return requestError("invalid_configuration", false);
  }
  if (error.code === "http_status" || error.code === "redirect_rejected") {
    const status = error.safeStatus;
    return requestError("http_error", status !== undefined && isRetryableHttpStatus(status), {
      ...(status === undefined ? {} : { httpStatus: status }),
    });
  }
  return requestError("network_error", true);
}

function normalizedLatency(startedAt: number, finishedAt: number): number {
  const elapsed = finishedAt - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

export class HttpCursorAdapter implements ProviderTransportAdapter {
  readonly key = "http-cursor-v1";
  readonly #httpClient: ProviderHttpClient | undefined;
  readonly #resolveHost: ProviderDnsResolver | undefined;
  readonly #now: () => number;

  constructor(dependencies: HttpCursorAdapterDependencies = {}) {
    this.#httpClient = dependencies.httpClient;
    this.#resolveHost = dependencies.resolveHost;
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
          catalog: page.rawPage.catalog.length,
          pulls: page.rawPage.pulls.length,
          trades: page.rawPage.trades.length,
        },
        hasMore: page.rawPage.has_more,
        nextCursorPresent: page.rawPage.next_cursor.length > 0,
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
    try {
      const response = await captureHardenedProviderResponse({
        url,
        allowedHosts: input.allowedHosts,
        headers: buildRequestHeaders(input),
        timeoutMilliseconds: timeoutMs,
        maximumResponseBytes: maximumBytes,
        signal: input.signal ?? new AbortController().signal,
        allowLocalHttp: input.allowLocalHttp,
      }, {
        httpClient: this.#httpClient,
        resolveHost: this.#resolveHost,
      });
      let responseValue: unknown;
      try {
        const responseText = new TextDecoder("utf-8", { fatal: true }).decode(
          response.protectedBody,
        );
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
      return { page: validated.data, responseStatus: response.status };
    } catch (error) {
      if (error instanceof ProviderTransportRequestError) throw error;
      if (error instanceof HardenedProviderRequestError) {
        throw mapHardenedRequestError(error);
      }
      if (error instanceof ProviderFeedValidationError) {
        throw requestError("invalid_response", false, {
          fieldPaths: error.issues.map((issue) => issue.path),
          issueCodes: error.issues.map((issue) => issue.code),
        });
      }
      throw requestError("network_error", true);
    }
  }
}
