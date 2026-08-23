import {
  productUserAccessDeciders,
  productUserAccessStates,
  productUserCollectibleTypes,
  productUserRepackAvailabilities,
  productUserStandings,
  PRODUCT_USER_MAX_AUTH_METHOD_LENGTH,
  PRODUCT_USER_MAX_CURSOR_LENGTH,
  PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH,
  PRODUCT_USER_MAX_PUBLIC_ID_LENGTH,
  PRODUCT_USER_MAX_SAVED_ITEM_COUNT,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  PRODUCT_USER_MAX_TEXT_LENGTH,
  PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
  type ProductUserAccessAction,
  type ProductUserAccessDecider,
  type ProductUserAccessDecision,
  type ProductUserAccessQueueCount,
  type ProductUserAccessQueuePage,
  type ProductUserAccessState,
  type ProductUserCollectibleType,
  type ProductUserDetail,
  type ProductUserDirectoryErrorCode,
  type ProductUserDirectoryPage,
  type ProductUserDirectoryRow,
  type ProductUserEffectiveAccess,
  type ProductUserEstimatedEv,
  type ProductUserRecord,
  type ProductUserRepackAvailability,
  type ProductUserSavedCollectible,
  type ProductUserSavedRepack,
  type ProductUserStanding,
  type ProductUserStandingChange,
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
const RECORD_PATH = "/admin/product-users/record";
const SAVED_ITEMS_PATH = "/admin/product-users/saved-items";
const STANDING_PATH = "/admin/product-users/standing";
const ACCESS_QUEUE_PATH = "/admin/product-users/access/queue";
const ACCESS_QUEUE_COUNT_PATH = "/admin/product-users/access/queue-count";
/** One decision path per action: the operation is the endpoint, never a field. */
const ACCESS_DECISION_PATHS: Readonly<Record<ProductUserAccessAction, string>> = {
  approve: "/admin/product-users/access/approve",
  decline: "/admin/product-users/access/decline",
  revoke: "/admin/product-users/access/revoke",
};
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
const availabilities = new Set<string>(productUserRepackAvailabilities);
const collectibleTypes = new Set<string>(productUserCollectibleTypes);
const accessStates = new Set<string>(productUserAccessStates);
const accessDeciders = new Set<string>(productUserAccessDeciders);
const inadmissionReasons = new Set<string>([
  "awaiting_review",
  "declined",
  "suspended",
  "undetermined",
]);

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

function notFound(): ProductUserDirectoryError {
  return new ProductUserDirectoryError(
    "PRODUCT_USER_NOT_FOUND",
    "That product user is not in the directory.",
    404,
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

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable();
  }
  return value as Record<string, unknown>;
}

/**
 * One access decision, reduced to the three fields the admin displays. The
 * stored decision also references the matched allowlist entry or the acting
 * operator; those identifiers are dropped here, at the integration boundary,
 * so nothing downstream has to remember not to forward them.
 */
function readAccessDecision(value: unknown): ProductUserAccessDecision {
  const candidate = asObject(value);
  const state = boundedText(candidate.state, 32);
  const decidedBy = boundedText(candidate.decidedBy, 32);
  const decidedAt = timestamp(candidate.decidedAt);
  if (
    state === null ||
    decidedBy === null ||
    decidedAt === null ||
    !accessStates.has(state) ||
    !accessDeciders.has(decidedBy)
  ) {
    throw unavailable();
  }
  return {
    state: state as ProductUserAccessState,
    decidedBy: decidedBy as ProductUserAccessDecider,
    decidedAt,
  };
}

/**
 * The composed admission answer, accepted only when the verdict and reason
 * agree: `admitted` must be exactly the approved reason, so a broken upstream
 * can never make the admin claim someone is in when they are not.
 */
function readEffectiveAccess(value: unknown): ProductUserEffectiveAccess {
  const candidate = asObject(value);
  const reason = boundedText(candidate.reason, 32);
  if (candidate.admitted === true && reason === "approved") {
    return { admitted: true, reason: "approved" };
  }
  if (
    candidate.admitted === false &&
    reason !== null &&
    inadmissionReasons.has(reason)
  ) {
    return {
      admitted: false,
      reason: reason as Exclude<ProductUserEffectiveAccess["reason"], "approved">,
    };
  }
  throw unavailable();
}

/**
 * One upstream record, accepted only when its identity, timestamps, standing,
 * and access decision are present and well formed. A malformed record means
 * the integration contract is broken, which the caller surfaces as an
 * unavailable directory rather than rendering a half-identified person.
 */
function readRecord(value: unknown): ProductUserRecord {
  const candidate = asObject(value);
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
    access: readAccessDecision(candidate.access),
  };
}

function readRow(value: unknown): ProductUserDirectoryRow {
  const candidate = asObject(value);
  return {
    ...readRecord(candidate),
    savedRepackCount: savedCount(candidate.savedRepackCount),
    savedCollectibleCount: savedCount(candidate.savedCollectibleCount),
  };
}

/** The fields every saved item carries, whatever the catalog can resolve. */
function readSavedItemBase(value: unknown): {
  readonly candidate: Record<string, unknown>;
  readonly savedAt: string;
  readonly resolved: boolean;
} {
  const candidate = asObject(value);
  const savedAt = timestamp(candidate.savedAt);
  if (savedAt === null) throw unavailable();
  return { candidate, savedAt, resolved: candidate.resolution === "resolved" };
}

function readPublicId(value: unknown): string {
  const publicId = boundedText(value, PRODUCT_USER_MAX_PUBLIC_ID_LENGTH);
  // Without a stable identifier the row could not be investigated at all.
  if (publicId === null) throw unavailable();
  return publicId;
}

function readEstimatedEv(value: unknown): ProductUserEstimatedEv | null {
  if (value === null || value === undefined) return null;
  const candidate = asObject(value);
  const band = boundedText(candidate.confidenceBand, 16);
  if (
    typeof candidate.evDollarsMinorUnits !== "number" ||
    !Number.isFinite(candidate.evDollarsMinorUnits) ||
    typeof candidate.grossReturnBasisPoints !== "number" ||
    !Number.isFinite(candidate.grossReturnBasisPoints) ||
    (band !== "low" && band !== "medium" && band !== "high")
  ) {
    throw unavailable();
  }
  return {
    evDollarsMinorUnits: Math.trunc(candidate.evDollarsMinorUnits),
    grossReturnBasisPoints: Math.trunc(candidate.grossReturnBasisPoints),
    confidenceBand: band,
  };
}

function readSavedRepack(value: unknown): ProductUserSavedRepack {
  const { candidate, savedAt, resolved } = readSavedItemBase(value);
  const publicRepackId = readPublicId(candidate.publicRepackId);
  if (!resolved) return { resolution: "unresolved", publicRepackId, savedAt };
  const repack = asObject(candidate.repack);
  const name = boundedText(repack.name, PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH);
  const vendorDisplayName = boundedText(
    repack.vendorDisplayName,
    PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH,
  );
  const availability = boundedText(repack.availability, 32);
  if (
    name === null ||
    vendorDisplayName === null ||
    availability === null ||
    !availabilities.has(availability)
  ) {
    throw unavailable();
  }
  return {
    resolution: "resolved",
    publicRepackId,
    savedAt,
    name,
    vendorDisplayName,
    availability: availability as ProductUserRepackAvailability,
    estimatedEv: readEstimatedEv(repack.estimatedEv),
  };
}

function readSavedCollectible(value: unknown): ProductUserSavedCollectible {
  const { candidate, savedAt, resolved } = readSavedItemBase(value);
  const publicCollectibleId = readPublicId(candidate.publicCollectibleId);
  if (!resolved) {
    return { resolution: "unresolved", publicCollectibleId, savedAt };
  }
  const collectible = asObject(candidate.collectible);
  const name = boundedText(
    collectible.name,
    PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH,
  );
  const collectibleType = boundedText(collectible.collectibleType, 32);
  if (
    name === null ||
    collectibleType === null ||
    !collectibleTypes.has(collectibleType)
  ) {
    throw unavailable();
  }
  return {
    resolution: "resolved",
    publicCollectibleId,
    savedAt,
    name,
    collectibleType: collectibleType as ProductUserCollectibleType,
  };
}

/**
 * One saved-item collection, bounded at the product backend's per-kind save
 * cap so a broken or hostile upstream cannot flood the browser.
 */
function readSavedCollection<TItem>(
  value: unknown,
  readItem: (item: unknown) => TItem,
): TItem[] {
  if (!Array.isArray(value)) throw unavailable();
  return value.slice(0, PRODUCT_USER_MAX_SAVED_ITEM_COUNT).map(readItem);
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

function readQueuePage(payload: unknown): ProductUserAccessQueuePage {
  const candidate = asObject(payload);
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
    queueTruncated: candidate.queueTruncated === true,
  };
}

function readQueueCount(payload: unknown): ProductUserAccessQueueCount {
  const candidate = asObject(payload);
  if (typeof candidate.count !== "number" || !Number.isFinite(candidate.count)) {
    throw unavailable();
  }
  return {
    count: Math.max(0, Math.trunc(candidate.count)),
    truncated: candidate.truncated === true,
  };
}

/**
 * What one decision operation reported: the authoritative previous and
 * resulting decisions, or that the subject has no record to decide about.
 * The upstream echo of the subject and operator is deliberately not relayed —
 * the caller already knows both, and nothing personal should ride back.
 */
export type ProductUserAccessDecisionOutcome =
  | {
      readonly outcome: "decided";
      readonly changed: boolean;
      readonly previous: ProductUserAccessDecision;
      readonly resulting: ProductUserAccessDecision;
      readonly effectiveAccess: ProductUserEffectiveAccess;
    }
  | { readonly outcome: "nothing_to_decide" };

function readDecisionOutcome(payload: unknown): ProductUserAccessDecisionOutcome {
  const candidate = asObject(payload);
  if (candidate.outcome === "nothing_to_decide") {
    return { outcome: "nothing_to_decide" };
  }
  if (candidate.outcome !== "decided" || typeof candidate.changed !== "boolean") {
    throw unavailable();
  }
  return {
    outcome: "decided",
    changed: candidate.changed,
    previous: readAccessDecision(candidate.previous),
    resulting: readAccessDecision(candidate.resulting),
    effectiveAccess: readEffectiveAccess(candidate.effectiveAccess),
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
  /**
   * One user's record and both saved-item collections, already resolved
   * against the active catalog by the product backend.
   */
  getProductUserDetail(input: { subject: string }): Promise<ProductUserDetail>;
  /**
   * Sets one user's standing to exactly the requested value and reports the
   * authoritative result. The product backend owns the flip, so a repeated or
   * concurrent action converges there rather than being guessed at here. This
   * is the only write on the integration; nothing can delete a user or touch
   * what they have saved.
   */
  setProductUserStanding(input: {
    subject: string;
    standing: ProductUserStanding;
  }): Promise<ProductUserStandingChange>;
  /**
   * One bounded page of the review queue: identities in one decision state,
   * oldest request first so nobody is buried, as full directory rows.
   */
  listProductUserAccessQueue(input: {
    accessState: ProductUserAccessState;
    cursor?: string;
    limit: number;
  }): Promise<ProductUserAccessQueuePage>;
  /** The bounded count of identities awaiting review. */
  countAwaitingReview(): Promise<ProductUserAccessQueueCount>;
  /**
   * One operator decision — approve, decline, or revoke — keyed by subject
   * and stamped with the acting operator. The product backend owns the flip:
   * repeats and concurrent operators converge on the authoritative decision
   * there, and an unknown subject reports that there is nothing to decide
   * rather than inventing a record. These are the only other writes on the
   * integration, and every one is a reversible flip; nothing can delete a
   * user or touch what they have saved.
   */
  decideProductUserAccess(input: {
    action: ProductUserAccessAction;
    subject: string;
    operatorId: string;
  }): Promise<ProductUserAccessDecisionOutcome>;
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

  /**
   * One authenticated server-to-server read. Every failure mode — an
   * unconfigured integration, a network problem, a timeout, a rejected
   * secret, an unreadable body — collapses here into a stable code, so no
   * upstream status text or exception detail can travel further.
   */
  async function post(path: string, body: unknown): Promise<unknown> {
    if (config === null) throw unconfigured();
    // One deadline covers the request and the body read, and is always
    // cleared so a completed read leaves no pending timer behind.
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
    async listProductUsers(request) {
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

    async getProductUserDetail(request) {
      // The record lookup and the saved-item read are independent privileged
      // reads on the same subject, so they run together.
      const [recordPayload, savedItemsPayload] = await Promise.all([
        post(RECORD_PATH, { subject: request.subject }),
        post(SAVED_ITEMS_PATH, { subject: request.subject }),
      ]);
      const record = asObject(recordPayload).record;
      // A subject the directory has never recorded is not an error state.
      if (record === null || record === undefined) throw notFound();
      const savedItems = asObject(savedItemsPayload);
      return {
        user: readRecord(record),
        catalogAvailable: savedItems.catalogAvailable === true,
        savedRepacks: readSavedCollection(
          savedItems.savedRepacks,
          readSavedRepack,
        ),
        savedCollectibles: readSavedCollection(
          savedItems.savedCollectibles,
          readSavedCollectible,
        ),
      };
    },

    async setProductUserStanding(request) {
      const payload = asObject(
        await post(STANDING_PATH, {
          subject: request.subject,
          standing: request.standing,
        }),
      );
      // A subject the directory has never recorded cannot have a standing, and
      // must not be reported as a change that happened.
      if (payload.record === null || payload.record === undefined) {
        throw notFound();
      }
      return {
        // The standing is whatever the backend now holds, not what was asked
        // for, so a concurrent change by another administrator is told truly.
        user: readRecord(payload.record),
        changed: payload.changed === true,
      };
    },

    async listProductUserAccessQueue(request) {
      return readQueuePage(
        await post(ACCESS_QUEUE_PATH, {
          accessState: request.accessState,
          paginationOpts: {
            numItems: request.limit,
            cursor: request.cursor ?? null,
          },
        }),
      );
    },

    async countAwaitingReview() {
      return readQueueCount(await post(ACCESS_QUEUE_COUNT_PATH, {}));
    },

    async decideProductUserAccess(request) {
      return readDecisionOutcome(
        await post(ACCESS_DECISION_PATHS[request.action], {
          subject: request.subject,
          operatorId: request.operatorId,
        }),
      );
    },
  };
}
