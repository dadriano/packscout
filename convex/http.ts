import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";

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

const getProductUser = httpAction(async (ctx, request) => {
  if (!isAuthorized(request)) return unauthorized();
  const body = await readJsonObject(request);
  if (body === null) return badRequest("ADMIN_DIRECTORY_REQUEST_INVALID");
  const subject = body.subject;
  if (typeof subject !== "string" || subject.length > MAX_SUBJECT_LENGTH) {
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

const http = httpRouter();

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

export default http;
