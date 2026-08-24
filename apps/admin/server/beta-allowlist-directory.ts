import {
  BETA_ALLOWLIST_MAX_CURSOR_LENGTH,
  BETA_ALLOWLIST_MAX_EMAIL_LENGTH,
  BETA_ALLOWLIST_MAX_ENTRY_ID_LENGTH,
  BETA_ALLOWLIST_MAX_LABEL_LENGTH,
  BETA_ALLOWLIST_MAX_OPERATOR_ID_LENGTH,
  BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH,
  type BetaAllowlistAdminErrorCode,
  type BetaAllowlistEntry,
  type BetaAllowlistEntryChange,
  type BetaAllowlistRemoval,
} from "@packscout/contracts";
import type { ProductUserDirectoryConfig } from "./runtime-config.ts";

/**
 * The admin's server-to-server client for the beta allowlist.
 *
 * The allowlist lives with the product backend so sign-in can consult it, and
 * is reachable only through the same POST-only admin surface — and the same
 * deployment secret — as the product-user directory reads. The secret is read
 * from server configuration, held here, and sent as a request header; it never
 * reaches a browser bundle, a response body, or a log line. Upstream failures
 * collapse into the small set of stable codes in the contracts vocabulary, so
 * no upstream body, status text, or identifier ever propagates.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const LIST_PATH = "/admin/beta-allowlist/list";
const CREATE_PATH = "/admin/beta-allowlist/create";
const UPDATE_PATH = "/admin/beta-allowlist/update";
const REMOVE_PATH = "/admin/beta-allowlist/remove";

/** Retroactive admission is bounded upstream; a larger count is a broken feed. */
const MAX_ADMITTED_COUNT = 100_000;

/**
 * Upstream refusals the admin restates as operator-facing problems. The
 * message is always the admin's own fixed copy — an upstream refusal never
 * echoes an identifier, and neither does anything here.
 */
const UPSTREAM_VALIDATION_CODES: Readonly<
  Partial<Record<string, { code: BetaAllowlistAdminErrorCode; message: string }>>
> = {
  BETA_ALLOWLIST_EMAIL_INVALID: {
    code: "BETA_ALLOWLIST_EMAIL_INVALID",
    message: "Enter a valid email address.",
  },
  BETA_ALLOWLIST_WALLET_ADDRESS_INVALID: {
    code: "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID",
    message: "Enter a valid wallet address.",
  },
  BETA_ALLOWLIST_LABEL_INVALID: {
    code: "BETA_ALLOWLIST_LABEL_INVALID",
    message: `Labels must be ${BETA_ALLOWLIST_MAX_LABEL_LENGTH} characters or fewer.`,
  },
  BETA_ALLOWLIST_IDENTIFIER_REQUIRED: {
    code: "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
    message: "An allowlist entry needs an email address or a wallet address.",
  },
  BETA_ALLOWLIST_DUPLICATE_EMAIL: {
    code: "BETA_ALLOWLIST_DUPLICATE_EMAIL",
    message: "Another allowlist entry already covers this email address.",
  },
  BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS: {
    code: "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS",
    message: "Another allowlist entry already covers this wallet address.",
  },
  BETA_ALLOWLIST_PAGE_CURSOR_INVALID: {
    code: "INVALID_BETA_ALLOWLIST_CURSOR",
    message: "The allowlist page cursor is invalid.",
  },
};

/** Every duplicate is a conflict with an existing entry, not a bad request. */
const CONFLICT_CODES = new Set<BetaAllowlistAdminErrorCode>([
  "BETA_ALLOWLIST_DUPLICATE_EMAIL",
  "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS",
]);

/** Remaining 400s mean this client sent something malformed. */
const UPSTREAM_REQUEST_CODES = new Set([
  "ADMIN_ALLOWLIST_REQUEST_INVALID",
  "BETA_ALLOWLIST_SEARCH_INVALID",
  "BETA_ALLOWLIST_PAGE_SIZE_INVALID",
  "BETA_ALLOWLIST_ENTRY_INVALID",
  "BETA_ALLOWLIST_OPERATOR_INVALID",
]);

export class BetaAllowlistDirectoryError extends Error {
  readonly code: BetaAllowlistAdminErrorCode;
  readonly status: number;

  constructor(
    code: BetaAllowlistAdminErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "BetaAllowlistDirectoryError";
    this.code = code;
    this.status = status;
  }
}

function unavailable(): BetaAllowlistDirectoryError {
  return new BetaAllowlistDirectoryError(
    "BETA_ALLOWLIST_UNAVAILABLE",
    "The beta allowlist is temporarily unavailable.",
    503,
  );
}

function unconfigured(): BetaAllowlistDirectoryError {
  return new BetaAllowlistDirectoryError(
    "BETA_ALLOWLIST_UNCONFIGURED",
    "The beta-allowlist integration is not configured.",
    503,
  );
}

function entryNotFound(): BetaAllowlistDirectoryError {
  return new BetaAllowlistDirectoryError(
    "BETA_ALLOWLIST_ENTRY_NOT_FOUND",
    "That allowlist entry no longer exists.",
    404,
  );
}

function invalidRequest(): BetaAllowlistDirectoryError {
  return new BetaAllowlistDirectoryError(
    "INVALID_BETA_ALLOWLIST_REQUEST",
    "Check the allowlist request and try again.",
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

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable();
  }
  return value as Record<string, unknown>;
}

/**
 * One upstream entry, accepted only when its identity fields are well formed
 * and at least one identifier is present. A malformed entry means the
 * integration contract is broken, which the caller surfaces as an unavailable
 * allowlist rather than rendering a half-identified invitation.
 */
function readEntry(value: unknown): BetaAllowlistEntry {
  const candidate = asObject(value);
  const entryId = boundedText(
    candidate.entryId,
    BETA_ALLOWLIST_MAX_ENTRY_ID_LENGTH,
  );
  const createdAt = timestamp(candidate.createdAt);
  const updatedAt = timestamp(candidate.updatedAt);
  const createdByOperatorId = boundedText(
    candidate.createdByOperatorId,
    BETA_ALLOWLIST_MAX_OPERATOR_ID_LENGTH,
  );
  const email = boundedText(candidate.email, BETA_ALLOWLIST_MAX_EMAIL_LENGTH);
  const walletAddress = boundedText(
    candidate.walletAddress,
    BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH,
  );
  if (
    entryId === null ||
    createdAt === null ||
    updatedAt === null ||
    createdByOperatorId === null ||
    (email === null && walletAddress === null)
  ) {
    throw unavailable();
  }
  return {
    entryId,
    email,
    walletAddress,
    label: boundedText(candidate.label, BETA_ALLOWLIST_MAX_LABEL_LENGTH),
    createdAt,
    updatedAt,
    createdByOperatorId,
  };
}

function readAdmittedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw unavailable();
  }
  return Math.min(Math.trunc(value), MAX_ADMITTED_COUNT);
}

export interface BetaAllowlistEntryPage {
  readonly items: readonly BetaAllowlistEntry[];
  readonly nextCursor: string | null;
  readonly searchTruncated: boolean;
}

function readPage(payload: unknown): BetaAllowlistEntryPage {
  const candidate = asObject(payload);
  if (!Array.isArray(candidate.page) || typeof candidate.isDone !== "boolean") {
    throw unavailable();
  }
  const continueCursor = boundedText(
    candidate.continueCursor,
    BETA_ALLOWLIST_MAX_CURSOR_LENGTH,
  );
  return {
    items: candidate.page.map(readEntry),
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

export interface BetaAllowlistDirectoryClient {
  listEntries(input: {
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<BetaAllowlistEntryPage>;
  /**
   * Creates an entry and reports how many waiting accounts it admitted. The
   * acting operator's reference is recorded on the entry by the backend.
   */
  createEntry(input: {
    email: string | null;
    walletAddress: string | null;
    label: string | null;
    operatorId: string;
  }): Promise<BetaAllowlistEntryChange>;
  /**
   * Edits an entry: an omitted field keeps its stored value, an explicit null
   * clears it. An entry that no longer exists refuses as not found rather
   * than pretending an edit happened.
   */
  updateEntry(input: {
    entryId: string;
    email?: string | null;
    walletAddress?: string | null;
    label?: string | null;
  }): Promise<BetaAllowlistEntryChange>;
  /**
   * Removes an entry. Removal stops future automatic admission and never
   * changes any existing access decision; `removed: false` means the entry
   * was already gone, so repeated operator actions converge.
   */
  removeEntry(input: { entryId: string }): Promise<BetaAllowlistRemoval>;
}

export interface BetaAllowlistDirectoryClientInput {
  /** Null when the integration is not configured; requests then fail closed. */
  readonly config: ProductUserDirectoryConfig | null;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createBetaAllowlistDirectoryClient(
  input: BetaAllowlistDirectoryClientInput,
): BetaAllowlistDirectoryClient {
  const { config } = input;
  const call = input.fetchImplementation ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * One authenticated server-to-server call. Every failure mode — an
   * unconfigured integration, a network problem, a timeout, a rejected
   * secret, an unreadable body — collapses here into a stable code, so no
   * upstream status text or exception detail can travel further.
   */
  async function post(path: string, body: unknown): Promise<unknown> {
    if (config === null) throw unconfigured();
    const deadline = new AbortController();
    const expiry = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await call(`${config.baseUrl}${path}`, {
          method: "POST",
          headers: {
            // The only place the integration secret is ever used.
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        });
      } catch {
        // Network failures, timeouts, and DNS problems are all one bounded
        // outcome; the underlying reason never reaches the caller.
        throw unavailable();
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 409) {
          const code = await refusalCode(response);
          const restated = code === null ? undefined : UPSTREAM_VALIDATION_CODES[code];
          if (restated !== undefined) {
            throw new BetaAllowlistDirectoryError(
              restated.code,
              restated.message,
              CONFLICT_CODES.has(restated.code) ? 409 : 422,
            );
          }
          if (code !== null && UPSTREAM_REQUEST_CODES.has(code)) {
            throw invalidRequest();
          }
        }
        // Everything else — including a rejected integration secret — is an
        // operational failure of the integration, described in one bounded way.
        throw unavailable();
      }

      try {
        return await response.json();
      } catch {
        throw unavailable();
      }
    } finally {
      clearTimeout(expiry);
    }
  }

  return {
    async listEntries(request) {
      return readPage(
        await post(LIST_PATH, {
          search: request.search ?? null,
          paginationOpts: {
            numItems: request.limit,
            cursor: request.cursor ?? null,
          },
        }),
      );
    },

    async createEntry(request) {
      const payload = asObject(
        await post(CREATE_PATH, {
          email: request.email,
          walletAddress: request.walletAddress,
          label: request.label,
          operatorId: request.operatorId,
        }),
      );
      return {
        entry: readEntry(payload.entry),
        admittedCount: readAdmittedCount(payload.admittedCount),
      };
    },

    async updateEntry(request) {
      const body: Record<string, unknown> = { entryId: request.entryId };
      // Only the fields the caller stated cross the integration: an absent
      // field keeps its stored value upstream, an explicit null clears it.
      for (const field of ["email", "walletAddress", "label"] as const) {
        if (field in request && request[field] !== undefined) {
          body[field] = request[field];
        }
      }
      const payload = asObject(await post(UPDATE_PATH, body));
      // A vanished entry is a normal upstream outcome, restated here as "not
      // found" so the operator learns the entry is gone — never as a silent
      // success that claims an edit happened.
      if (payload.entry === null || payload.entry === undefined) {
        throw entryNotFound();
      }
      return {
        entry: readEntry(payload.entry),
        admittedCount: readAdmittedCount(payload.admittedCount),
      };
    },

    async removeEntry(request) {
      const payload = asObject(
        await post(REMOVE_PATH, { entryId: request.entryId }),
      );
      if (typeof payload.removed !== "boolean") throw unavailable();
      return { removed: payload.removed };
    },
  };
}
