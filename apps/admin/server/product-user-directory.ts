import {
  productUserStandings,
  PRODUCT_USER_MAX_AUTH_METHOD_LENGTH,
  PRODUCT_USER_MAX_CURSOR_LENGTH,
  PRODUCT_USER_MAX_SAVED_ITEM_COUNT,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  PRODUCT_USER_MAX_TEXT_LENGTH,
  PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
  type ProductUserDirectoryErrorCode,
  type ProductUserDirectoryPage,
  type ProductUserDirectoryRow,
  type ProductUserStanding,
} from "@packscout/contracts";
import type { ProductUserDirectoryConfig } from "./runtime-config.ts";

/**
 * The admin's server-to-server reader for the product-user directory.
 *
 * The privileged directory reads live with the product backend and are only
 * reachable through its POST-only admin surface, authenticated with a
 * deployment secret. That secret is read from server configuration, held in
 * this module, and sent as a request header — it never reaches a browser
 * bundle, a response body, or a log line. Upstream failures are collapsed into
 * a small set of stable codes here, so no upstream body ever propagates.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const LIST_PATH = "/admin/product-users/list";
const UNKNOWN_AUTH_METHOD = "unknown";

/** Upstream refusals the admin can restate as an operator-facing request problem. */
const UPSTREAM_CURSOR_CODES = new Set([
  "PRODUCT_USER_PAGE_CURSOR_INVALID",
]);
const UPSTREAM_REQUEST_CODES = new Set([
  "PRODUCT_USER_SEARCH_INVALID",
  "PRODUCT_USER_PAGE_SIZE_INVALID",
  "PRODUCT_USER_SUBJECT_INVALID",
  "ADMIN_DIRECTORY_REQUEST_INVALID",
]);

const standings = new Set<string>(productUserStandings);

export class ProductUserDirectoryError extends Error {
  readonly code: ProductUserDirectoryErrorCode;
  readonly status: number;

  constructor(code: ProductUserDirectoryErrorCode, message: string, status: number) {
    super(message);
    this.name = "ProductUserDirectoryError";
    this.code = code;
    this.status = status;
  }
}

function unavailable(): ProductUserDirectoryError {
  return new ProductUserDirectoryError(
    "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
    "The product-user directory is temporarily unavailable.",
    503,
  );
}

function unconfigured(): ProductUserDirectoryError {
  return new ProductUserDirectoryError(
    "PRODUCT_USER_DIRECTORY_UNCONFIGURED",
    "The product-user directory integration is not configured.",
    503,
  );
}

function invalidRequest(cursor: boolean): ProductUserDirectoryError {
  return cursor
    ? new ProductUserDirectoryError(
        "INVALID_PRODUCT_USER_CURSOR",
        "The product-user page cursor is invalid.",
        422,
      )
    : new ProductUserDirectoryError(
        "INVALID_PRODUCT_USER_REQUEST",
        "Check the product-user request and try again.",
        422,
      );
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) return null;
  return trimmed;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function savedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.trunc(value), PRODUCT_USER_MAX_SAVED_ITEM_COUNT));
}

/**
 * One upstream row, accepted only when its identity, timestamps, and standing
 * are present and well formed. A malformed row means the integration contract
 * is broken, which the caller surfaces as an unavailable directory rather than
 * rendering a half-identified person.
 */
function readRow(value: unknown): ProductUserDirectoryRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable();
  }
  const candidate = value as Record<string, unknown>;
  const subject = boundedText(candidate.subject, PRODUCT_USER_MAX_SUBJECT_LENGTH);
  const firstSeenAt = timestamp(candidate.firstSeenAt);
  const lastSeenAt = timestamp(candidate.lastSeenAt);
  const standing = boundedText(candidate.standing, 32);
  if (
    subject === null ||
    firstSeenAt === null ||
    lastSeenAt === null ||
    standing === null ||
    !standings.has(standing)
  ) {
    throw unavailable();
  }
  return {
    subject,
    authMethod:
      boundedText(candidate.authMethod, PRODUCT_USER_MAX_AUTH_METHOD_LENGTH) ??
      UNKNOWN_AUTH_METHOD,
    email: boundedText(candidate.email, PRODUCT_USER_MAX_TEXT_LENGTH),
    walletAddress: boundedText(
      candidate.walletAddress,
      PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
    ),
    firstSeenAt,
    lastSeenAt,
    standing: standing as ProductUserStanding,
    savedRepackCount: savedCount(candidate.savedRepackCount),
    savedCollectibleCount: savedCount(candidate.savedCollectibleCount),
  };
}

function readPage(payload: unknown): ProductUserDirectoryPage {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw unavailable();
  }
  const candidate = payload as Record<string, unknown>;
  if (!Array.isArray(candidate.page) || typeof candidate.isDone !== "boolean") {
    throw unavailable();
  }
  const continueCursor = boundedText(
    candidate.continueCursor,
    PRODUCT_USER_MAX_CURSOR_LENGTH,
  );
  return {
    items: candidate.page.map(readRow),
    nextCursor: candidate.isDone ? null : continueCursor,
    searchTruncated: candidate.searchTruncated === true,
  };
}

/**
 * The upstream refusal code, when it is one the admin recognizes. The body is
 * read only for that field; nothing else from it is retained or reported.
 */
async function refusalCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const code = (body as { code?: unknown }).code;
    return typeof code === "string" && code.length <= 128 ? code : null;
  } catch {
    return null;
  }
}

export interface ProductUserDirectoryReader {
  listProductUsers(input: {
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<ProductUserDirectoryPage>;
}

export interface ProductUserDirectoryReaderInput {
  /** Null when the integration is not configured; requests then fail closed. */
  readonly config: ProductUserDirectoryConfig | null;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createProductUserDirectoryReader(
  input: ProductUserDirectoryReaderInput,
): ProductUserDirectoryReader {
  const { config } = input;
  const call = input.fetchImplementation ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listProductUsers(request) {
      if (config === null) throw unconfigured();
      // One deadline covers the request and the body read, and is always
      // cleared so a completed read leaves no pending timer behind.
      const deadline = new AbortController();
      const expiry = setTimeout(() => deadline.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await call(`${config.baseUrl}${LIST_PATH}`, {
            method: "POST",
            headers: {
              // The only place the integration secret is ever used.
              authorization: `Bearer ${config.token}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              search: request.search ?? null,
              paginationOpts: {
                numItems: request.limit,
                cursor: request.cursor ?? null,
              },
            }),
            signal: deadline.signal,
          });
        } catch {
          // Network failures, timeouts, and DNS problems are all one bounded
          // outcome; the underlying reason never reaches the caller.
          throw unavailable();
        }

        if (!response.ok) {
          if (response.status === 400) {
            const code = await refusalCode(response);
            if (code !== null && UPSTREAM_CURSOR_CODES.has(code)) {
              throw invalidRequest(true);
            }
            if (code !== null && UPSTREAM_REQUEST_CODES.has(code)) {
              throw invalidRequest(false);
            }
          }
          // Everything else — including a rejected integration secret — is an
          // operational failure of the integration, described in one bounded way.
          throw unavailable();
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw unavailable();
        }
        return readPage(payload);
      } finally {
        clearTimeout(expiry);
      }
    },
  };
}
