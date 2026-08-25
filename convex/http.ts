import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import {
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  PRODUCTION_CATALOG_RETENTION_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  PRODUCTION_REPACK_HEAT_PATHS,
} from "@packscout/contracts";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import {
  handleAuthenticatedCatalogManifestRequest,
  handleAuthenticatedCatalogRetentionRequest,
  handleAuthenticatedHeatPublicationRequest,
  handleAuthenticatedProviderReleaseRequest,
} from "./productionDataReleaseAuth";
import {
  PRODUCT_USER_WELCOME_CLAIM_MAX_BATCH,
  PRODUCT_USER_WELCOME_CLAIM_MAX_LEASE_MILLISECONDS,
  PRODUCT_USER_WELCOME_CLAIM_MIN_LEASE_MILLISECONDS,
} from "./productUserWelcome";


/**
 * Server-to-server surface for the admin integration.
 *
 * The privileged product-user reads are Convex internal functions, so no
 * browser or product client can call them. This router is the only external
 * entry point, and it authenticates the caller server-side against a
 * deployment secret before running any of them. There is no client-supplied
 * claim, no committed token, and no browser-facing (CORS) access.
 */

/** Shortest accepted integration secret. Anything shorter fails closed. */
const MINIMUM_TOKEN_LENGTH = 32;
const BEARER_TOKEN = /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/u;
const MAX_SEARCH_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 1_024;

const REQUEST_ERROR_CODES = new Set([
  "PRODUCT_USER_SEARCH_INVALID",
  "PRODUCT_USER_PAGE_SIZE_INVALID",
  "PRODUCT_USER_PAGE_CURSOR_INVALID",
  "PRODUCT_USER_SUBJECT_INVALID",
  "PRODUCT_USER_OPERATOR_INVALID",
  "PRODUCT_USER_WELCOME_REQUEST_INVALID",
]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(status: number, code: string, error: string): Response {
  return jsonResponse(status, { error, code });
}

function unauthorized(): Response {
  return errorResponse(
    401,
    "ADMIN_DIRECTORY_UNAUTHORIZED",
    "The product-user directory integration is not authorized.",
  );
}

function badRequest(code: string): Response {
  return errorResponse(
    400,
    code,
    "The product-user directory request was rejected.",
  );
}

function unavailable(): Response {
  return errorResponse(
    500,
    "ADMIN_DIRECTORY_UNAVAILABLE",
    "The product-user directory is unavailable.",
  );
}

/**
 * Length-checked, difference-accumulating comparison. Matches the admin's
 * existing secret-comparison shape: the length is compared first, then every
 * remaining character contributes to one constant result.
 */
function secretsMatch(presented: string, configured: string): boolean {
  if (presented.length !== configured.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ configured.charCodeAt(index);
  }
  return difference === 0;
}

function isAuthorized(request: Request): boolean {
  // The token is deliberately absent from `convex.config.ts`-typed reads at
  // author time; it is deployment configuration, never repository content.
  const configuredEnvironment = env as typeof env & {
    readonly PACKSCOUT_ADMIN_DIRECTORY_TOKEN?: string;
  };
  const configured =
    configuredEnvironment.PACKSCOUT_ADMIN_DIRECTORY_TOKEN?.trim() ?? "";
  if (configured.length < MINIMUM_TOKEN_LENGTH) return false;
  const presented = BEARER_TOKEN.exec(
    request.headers.get("authorization") ?? "",
  );
  return presented === null ? false : secretsMatch(presented[1]!, configured);
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function readSearch(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_SEARCH_LENGTH) {
    return undefined;
  }
  return value;
}

/**
 * Only the two pagination fields the directory contract needs cross the
 * boundary; scan-budget and split fields stay under backend control.
 */
function readPaginationOpts(
  value: unknown,
): { numItems: number; cursor: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const numItems = candidate.numItems;
  const cursor = candidate.cursor ?? null;
  if (typeof numItems !== "number" || !Number.isInteger(numItems)) return null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 4_096)) {
    return null;
  }
  return { numItems, cursor };
}

function refusalResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown } | null;
    const code = typeof data?.code === "string" ? data.code : null;
    if (code !== null && REQUEST_ERROR_CODES.has(code)) return badRequest(code);
  }
  // Anything else is an internal failure; the raw error never leaves Convex.
  return unavailable();
}

const listProductUsers = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const search = readSearch(body.search);
  const paginationOpts = readPaginationOpts(body.paginationOpts);
  if (search === undefined || paginationOpts === null) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.productUserDirectory.listDirectoryPage, {
        search,
        paginationOpts,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

function readSubject(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_SUBJECT_LENGTH
    ? value
    : null;
}

const getProductUser = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const subject = readSubject(body.subject);
  if (subject === null) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    return jsonResponse(200, {
      record: await ctx.runQuery(
        internal.productUserDirectory.getDirectoryRecord,
        { subject },
      ),
    });
  } catch (error) {
    return refusalResponse(error);
  }
});

function readStanding(value: unknown): "active" | "suspended" | null {
  return value === "active" || value === "suspended" ? value : null;
}

/**
 * The one privileged write on this surface: a reversible standing flip.
 *
 * It reports the authoritative resulting record, so a repeated or concurrent
 * administrator action converges on the truth rather than failing. A subject
 * the directory has never recorded returns a null record, which the admin
 * restates as "not found" — never as a silent success.
 */
const setProductUserStanding = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const subject = readSubject(body.subject);
  const standing = readStanding(body.standing);
  if (subject === null || standing === null) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runMutation(internal.productUserDirectory.setDirectoryStanding, {
        subject,
        standing,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

/**
 * One product user's saved repacks and saved collectibles, already resolved
 * against the active catalog. Each kind runs as its own query transaction, so
 * an owner at the per-kind save cap stays comfortably inside one transaction's
 * read budget.
 */
const getProductUserSavedItems = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const subject = readSubject(body.subject);
  if (subject === null) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    const [repacks, collectibles] = await Promise.all([
      ctx.runQuery(internal.productUserSavedItems.listSavedRepacksForSubject, {
        subject,
      }),
      ctx.runQuery(
        internal.productUserSavedItems.listSavedCollectiblesForSubject,
        { subject },
      ),
    ]);
    return jsonResponse(200, {
      // Both kinds resolve against the same active release; a gap in either
      // read is reported as no catalog rather than as removed references.
      catalogAvailable:
        repacks.catalogAvailable && collectibles.catalogAvailable,
      savedRepacks: repacks.items,
      savedCollectibles: collectibles.items,
    });
  } catch (error) {
    return refusalResponse(error);
  }
});

/**
 * The beta-allowlist management surface (closed-beta-access/002), reached
 * through the same admin integration and deployment secret as the directory
 * reads above. Entries carry email and wallet addresses of real people, so
 * every operation is POST with a JSON body — an identifier never appears in
 * a URL, a query string, or an error payload — and every refusal below is a
 * fixed string.
 */

const ALLOWLIST_BAD_REQUEST_CODES = new Set([
  "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
  "BETA_ALLOWLIST_EMAIL_INVALID",
  "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID",
  "BETA_ALLOWLIST_LABEL_INVALID",
  "BETA_ALLOWLIST_OPERATOR_INVALID",
  "BETA_ALLOWLIST_ENTRY_INVALID",
  "BETA_ALLOWLIST_SEARCH_INVALID",
  "BETA_ALLOWLIST_PAGE_SIZE_INVALID",
  "BETA_ALLOWLIST_PAGE_CURSOR_INVALID",
]);

/** A duplicate identifier is a conflict with an existing entry, not a 400. */
const ALLOWLIST_CONFLICT_CODES = new Set([
  "BETA_ALLOWLIST_DUPLICATE_EMAIL",
  "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS",
]);

/** Transport-level bound; the allowlist module enforces the semantic ones. */
const MAX_ALLOWLIST_FIELD_LENGTH = 1_024;
const MAX_ALLOWLIST_ENTRY_ID_LENGTH = 128;

function allowlistBadRequest(code: string): Response {
  return errorResponse(400, code, "The beta-allowlist request was rejected.");
}

function allowlistRefusalResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown } | null;
    const code = typeof data?.code === "string" ? data.code : null;
    if (code !== null && ALLOWLIST_CONFLICT_CODES.has(code)) {
      return errorResponse(
        409,
        code,
        "The beta-allowlist entry conflicts with an existing entry.",
      );
    }
    if (code !== null && ALLOWLIST_BAD_REQUEST_CODES.has(code)) {
      return allowlistBadRequest(code);
    }
  }
  // Anything else is an internal failure; the raw error never leaves Convex.
  return errorResponse(
    500,
    "ADMIN_ALLOWLIST_UNAVAILABLE",
    "The beta allowlist is unavailable.",
  );
}

/**
 * Absent and null both read as "no value"; anything else must be a bounded
 * string. `undefined` marks a malformed field, mirroring `readSearch`.
 */
function readAllowlistOptionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_ALLOWLIST_FIELD_LENGTH
  ) {
    return undefined;
  }
  return value;
}

function readAllowlistEntryId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ALLOWLIST_ENTRY_ID_LENGTH
    ? value
    : null;
}

const listBetaAllowlistEntries = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  const search = readSearch(body.search);
  const paginationOpts = readPaginationOpts(body.paginationOpts);
  if (search === undefined || paginationOpts === null) {
    return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.betaAllowlist.listEntriesPage, {
        search,
        paginationOpts,
      }),
    );
  } catch (error) {
    return allowlistRefusalResponse(error);
  }
});

/**
 * Creates an entry and reports how many waiting accounts it admitted, so the
 * operator gets confirmation that the invited person is no longer stuck.
 */
const createBetaAllowlistEntry = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  const email = readAllowlistOptionalText(body.email);
  const walletAddress = readAllowlistOptionalText(body.walletAddress);
  const label = readAllowlistOptionalText(body.label);
  const operatorId = body.operatorId;
  if (
    email === undefined ||
    walletAddress === undefined ||
    label === undefined ||
    typeof operatorId !== "string" ||
    operatorId.length === 0 ||
    operatorId.length > MAX_ALLOWLIST_FIELD_LENGTH
  ) {
    return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runMutation(internal.betaAllowlist.createEntry, {
        email,
        walletAddress,
        label,
        operatorId,
      }),
    );
  } catch (error) {
    return allowlistRefusalResponse(error);
  }
});

/**
 * Edits an entry: an omitted field keeps its stored value, an explicit null
 * clears it. Reports the admissions the edited identifiers produced. A null
 * entry in the response means the entry no longer exists, which the admin
 * restates as "not found" — never as a silent success.
 */
const updateBetaAllowlistEntry = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  const entryId = readAllowlistEntryId(body.entryId);
  if (entryId === null) {
    return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  }
  const updateArgs: {
    entryId: string;
    email?: string | null;
    walletAddress?: string | null;
    label?: string | null;
  } = { entryId };
  for (const field of ["email", "walletAddress", "label"] as const) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) {
      updateArgs[field] = null;
      continue;
    }
    if (typeof value !== "string" || value.length > MAX_ALLOWLIST_FIELD_LENGTH) {
      return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
    }
    updateArgs[field] = value;
  }
  try {
    return jsonResponse(
      200,
      await ctx.runMutation(internal.betaAllowlist.updateEntry, updateArgs),
    );
  } catch (error) {
    return allowlistRefusalResponse(error);
  }
});

/**
 * Removes an entry. Removal stops future automatic admission and never
 * changes any existing access decision; `removed: false` means the entry was
 * already gone, so repeated operator actions converge.
 */
const removeBetaAllowlistEntry = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  const entryId = readAllowlistEntryId(body.entryId);
  if (entryId === null) {
    return allowlistBadRequest("ADMIN_ALLOWLIST_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runMutation(internal.betaAllowlist.removeEntry, { entryId }),
    );
  } catch (error) {
    return allowlistRefusalResponse(error);
  }
});

/**
 * The closed-beta review surface (closed-beta-access/003), reached through
 * the same admin integration and deployment secret as the directory reads:
 * operator decisions about an identity's admission — approve, decline,
 * revoke — plus the queue of identities awaiting one and its bounded count.
 * Subjects and operator references are audit-relevant identifiers, so every
 * operation is POST with a JSON body and every refusal is a fixed string.
 */

/** Transport-level bound; the review module enforces the semantic one. */
const MAX_OPERATOR_ID_LENGTH = 1_024;

function readOperatorId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPERATOR_ID_LENGTH
    ? value
    : null;
}

/**
 * Absent and null read as the default queue (awaiting review); anything else
 * must be one of the three decision states. `undefined` marks a malformed
 * field, mirroring `readSearch`.
 */
function readAccessState(
  value: unknown,
): "awaiting_review" | "approved" | "declined" | null | undefined {
  if (value === undefined || value === null) return null;
  return value === "awaiting_review" ||
    value === "approved" ||
    value === "declined"
    ? value
    : undefined;
}

/**
 * One reversible decision operation: keyed by subject, stamped with the
 * acting operator, reporting the previous and resulting decisions plus the
 * resulting effective access. A subject the directory has never recorded
 * reports `nothing_to_decide` rather than inventing a record, and repeating
 * a decision converges on the authoritative one rather than failing.
 */
function decideProductUserAccessRoute(
  operation:
    | typeof internal.productUserAccessReview.approveAccess
    | typeof internal.productUserAccessReview.declineAccess
    | typeof internal.productUserAccessReview.revokeAccess,
) {
  return httpAction(async (ctx, request) => {
    if (!isAuthorized(request)) return unauthorized();
    const body = await readJsonObject(request);
    if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
    const subject = readSubject(body.subject);
    const operatorId = readOperatorId(body.operatorId);
    if (subject === null || operatorId === null) {
      return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
    }
    try {
      return jsonResponse(
        200,
        await ctx.runMutation(operation, { subject, operatorId }),
      );
    } catch (error) {
      return refusalResponse(error);
    }
  });
}

const approveProductUserAccess = decideProductUserAccessRoute(
  internal.productUserAccessReview.approveAccess,
);
const declineProductUserAccess = decideProductUserAccessRoute(
  internal.productUserAccessReview.declineAccess,
);
const revokeProductUserAccess = decideProductUserAccessRoute(
  internal.productUserAccessReview.revokeAccess,
);

/**
 * One bounded page of the review queue: identities in a decision state
 * (awaiting review when the caller names none), oldest-request-first, as
 * full directory rows. The pagination contract matches the directory
 * listing's; cursors are passed back unchanged.
 */
const listProductUserAccessQueue = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const accessState = readAccessState(body.accessState);
  const paginationOpts = readPaginationOpts(body.paginationOpts);
  if (accessState === undefined || paginationOpts === null) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.productUserAccessReview.listAccessQueuePage, {
        accessState: accessState ?? "awaiting_review",
        paginationOpts,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

/**
 * The bounded awaiting-review count, so the admin can show that work is
 * waiting without paging the whole queue.
 */
const countProductUserAccessQueue = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(
        internal.productUserAccessReview.countAwaitingReview,
        {},
      ),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

/**
 * The welcome-dispatch surface (messaging/007), reached through the same
 * admin integration and deployment secret as the directory reads. The
 * dispatcher discovers and claims identities whose first admitted session
 * armed a welcome, and settles each once the message is durably enqueued.
 * Subjects and addresses are personal data, so both operations are POST
 * with JSON bodies — neither ever appears in a URL — and every refusal is
 * a fixed string.
 */

function readWelcomeClaimLimit(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PRODUCT_USER_WELCOME_CLAIM_MAX_BATCH
    ? value
    : null;
}

/** Absent means the backend default; anything present must be in bounds. */
function readWelcomeClaimLease(value: unknown): number | null | undefined {
  if (value === undefined) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PRODUCT_USER_WELCOME_CLAIM_MIN_LEASE_MILLISECONDS &&
    value <= PRODUCT_USER_WELCOME_CLAIM_MAX_LEASE_MILLISECONDS
    ? value
    : undefined;
}

function readWelcomeSettleOutcome(
  value: unknown,
): "sent" | "no_verified_email" | null {
  return value === "sent" || value === "no_verified_email" ? value : null;
}

const claimProductUserWelcomes = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const limit = readWelcomeClaimLimit(body.limit);
  const leaseMilliseconds = readWelcomeClaimLease(body.leaseMilliseconds);
  if (limit === null || leaseMilliseconds === undefined) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runMutation(internal.productUserWelcome.claimDueWelcomes, {
        limit,
        ...(leaseMilliseconds === null ? {} : { leaseMilliseconds }),
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

const settleProductUserWelcome = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const subject = readSubject(body.subject);
  const outcome = readWelcomeSettleOutcome(body.outcome);
  if (subject === null || outcome === null) {
    return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  }
  try {
    return jsonResponse(
      200,
      await ctx.runMutation(internal.productUserWelcome.settleWelcome, {
        subject,
        outcome,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

const http = httpRouter();



http.route({
  path: PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogRetentionRequest(
      ctx,
      request,
      internal.catalogRetention.retainManifests,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_RETENTION_PATHS.retainProviderReleases,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogRetentionRequest(
      ctx,
      request,
      internal.catalogRetention.retainProviderReleases,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_RETENTION_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogRetentionRequest(
      ctx,
      request,
      internal.catalogRetentionRead.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRead.activeState,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestActivate.activateManifest,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRead.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRefresh.refreshActiveState,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.rollback,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRollback.rollback,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.block,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestBlock.block,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseRead.completedHead,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.start,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseStart.start,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseBatch.applyBatch,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseFinalize.finalize,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseRead.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseFinalize.confirmReuse,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.block,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseBlock.block,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseCleanup.cleanup,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.activeState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatActiveState.activeState,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.start,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.start,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.applyBatch,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatBatch.applyBatch,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.finalize,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.finalize,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.refreshFrame,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.refreshFrame,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.retain,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedHeatPublicationRequest(
      ctx,
      request,
      internal.productionHeatRetention.retain,
    ),
  ),
});

// POST rather than GET: search terms and subject keys are personal data and
// must not travel in a URL or query string.
http.route({
  path: "/admin/product-users/list",
  method: "POST",
  handler: listProductUsers,
});
http.route({
  path: "/admin/product-users/record",
  method: "POST",
  handler: getProductUser,
});
http.route({
  path: "/admin/product-users/saved-items",
  method: "POST",
  handler: getProductUserSavedItems,
});
http.route({
  path: "/admin/product-users/standing",
  method: "POST",
  handler: setProductUserStanding,
});

// The closed-beta review surface: POST for the same reason as above — the
// subject keys and operator references in these bodies are identifiers that
// must not travel in a URL or query string.
http.route({
  path: "/admin/product-users/access/approve",
  method: "POST",
  handler: approveProductUserAccess,
});
http.route({
  path: "/admin/product-users/access/decline",
  method: "POST",
  handler: declineProductUserAccess,
});
http.route({
  path: "/admin/product-users/access/revoke",
  method: "POST",
  handler: revokeProductUserAccess,
});
http.route({
  path: "/admin/product-users/access/queue",
  method: "POST",
  handler: listProductUserAccessQueue,
});
http.route({
  path: "/admin/product-users/access/queue-count",
  method: "POST",
  handler: countProductUserAccessQueue,
});

// The welcome-dispatch surface: POST for the same reason — subjects and
// verified addresses travel only in JSON bodies, never in a URL.
http.route({
  path: "/admin/product-users/welcome/claim",
  method: "POST",
  handler: claimProductUserWelcomes,
});
http.route({
  path: "/admin/product-users/welcome/settle",
  method: "POST",
  handler: settleProductUserWelcome,
});

// POST rather than GET, like the directory routes: allowlist identifiers are
// personal data and must not travel in a URL or query string.
http.route({
  path: "/admin/beta-allowlist/list",
  method: "POST",
  handler: listBetaAllowlistEntries,
});
http.route({
  path: "/admin/beta-allowlist/create",
  method: "POST",
  handler: createBetaAllowlistEntry,
});
http.route({
  path: "/admin/beta-allowlist/update",
  method: "POST",
  handler: updateBetaAllowlistEntry,
});
http.route({
  path: "/admin/beta-allowlist/remove",
  method: "POST",
  handler: removeBetaAllowlistEntry,
});

/**
 * Provider catalog inspection: the admin's read-only window onto what the
 * product actually serves per provider.
 *
 * Same guard as the rest of this router — the deployment secret, checked before
 * any work — and the same refusal discipline: a failure becomes a stable code,
 * never an upstream body or a document. Every one of these runs a query, so no
 * path here can write.
 */
const PROVIDER_CATALOG_REQUEST_INVALID = "PROVIDER_CATALOG_REQUEST_INVALID";

const IDENTIFIED_ENTITY_KINDS = new Set([
  "vendors",
  "categories",
  "repacks",
  "collectibles",
]);

function readPlatformKey(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SUBJECT_LENGTH
    ? value
    : null;
}

function readEntityKind(
  value: unknown,
): "vendors" | "categories" | "repacks" | "collectibles" | null {
  return typeof value === "string" && IDENTIFIED_ENTITY_KINDS.has(value)
    ? (value as "vendors" | "categories" | "repacks" | "collectibles")
    : null;
}

const readProviderCatalogActiveRelease = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  const platformKey = readPlatformKey(body.platformKey);
  if (platformKey === null) {
    return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.providerCatalogInspection.activeRelease, {
        platformKey,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

const listProviderCatalogEntities = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  const publicProviderReleaseId = readPlatformKey(body.publicProviderReleaseId);
  const entityKind = readEntityKind(body.entityKind);
  const paginationOpts = readPaginationOpts(body.paginationOpts);
  if (
    publicProviderReleaseId === null ||
    entityKind === null ||
    paginationOpts === null
  ) {
    return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.providerCatalogInspection.listEntities, {
        publicProviderReleaseId,
        entityKind,
        paginationOpts,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

const listProviderCatalogEntityIds = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  const publicProviderReleaseId = readPlatformKey(body.publicProviderReleaseId);
  const entityKind = readEntityKind(body.entityKind);
  const paginationOpts = readPaginationOpts(body.paginationOpts);
  if (
    publicProviderReleaseId === null ||
    entityKind === null ||
    paginationOpts === null
  ) {
    return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.providerCatalogInspection.listEntityIds, {
        publicProviderReleaseId,
        entityKind,
        paginationOpts,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

const readProviderCatalogDocument = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  const publicProviderReleaseId = readPlatformKey(body.publicProviderReleaseId);
  const entityKind = readEntityKind(body.entityKind);
  const publicEntityId = readPlatformKey(body.publicEntityId);
  if (
    publicProviderReleaseId === null ||
    entityKind === null ||
    publicEntityId === null
  ) {
    return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
  }
  try {
    return jsonResponse(
      200,
      await ctx.runQuery(internal.providerCatalogInspection.readDocument, {
        publicProviderReleaseId,
        entityKind,
        publicEntityId,
      }),
    );
  } catch (error) {
    return refusalResponse(error);
  }
});

const readProviderCatalogChaseReconciliation = httpAction(
  async (ctx, request) => {
    if (!isAuthorized(request)) return unauthorized();
    const body = await readJsonObject(request);
    if (body === null) return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
    const publicProviderReleaseId = readPlatformKey(
      body.publicProviderReleaseId,
    );
    const publicRepackId = readPlatformKey(body.publicRepackId);
    if (publicProviderReleaseId === null || publicRepackId === null) {
      return badRequest(PROVIDER_CATALOG_REQUEST_INVALID);
    }
    try {
      return jsonResponse(
        200,
        await ctx.runQuery(
          internal.providerCatalogInspection.readRepackChaseReconciliation,
          { publicProviderReleaseId, publicRepackId },
        ),
      );
    } catch (error) {
      return refusalResponse(error);
    }
  },
);

http.route({
  path: "/admin/provider-catalog/active-release",
  method: "POST",
  handler: readProviderCatalogActiveRelease,
});
http.route({
  path: "/admin/provider-catalog/entities",
  method: "POST",
  handler: listProviderCatalogEntities,
});
http.route({
  path: "/admin/provider-catalog/entity-ids",
  method: "POST",
  handler: listProviderCatalogEntityIds,
});
http.route({
  path: "/admin/provider-catalog/document",
  method: "POST",
  handler: readProviderCatalogDocument,
});
http.route({
  path: "/admin/provider-catalog/chase-reconciliation",
  method: "POST",
  handler: readProviderCatalogChaseReconciliation,
});

export default http;
