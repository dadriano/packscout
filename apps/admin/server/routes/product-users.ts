import { Router, type RequestHandler, type Response } from "express";
import {
  listProductUsersRequestSchema,
  PRODUCT_USER_MAX_AUTH_METHOD_LENGTH,
  PRODUCT_USER_MAX_CURSOR_LENGTH,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  PRODUCT_USER_MAX_TEXT_LENGTH,
  PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
  type ProductUserDirectoryRow,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession } from "../auth/middleware.ts";
import {
  ProductUserDirectoryError,
  type ProductUserDirectoryReader,
} from "../product-user-directory.ts";

/**
 * The admin's product-user directory surface.
 *
 * The browser talks only to this route; the server-to-server integration and
 * its credential stay behind it. Reads are guarded by `product_users:view`,
 * which only administrators hold, and every listing is bounded and paginated.
 *
 * The listing is a POST because search terms and subject keys are personal
 * data: carrying them in a request body keeps them out of URLs, browser
 * history, referrers, and access logs. It performs no mutation, so the
 * same-origin guard — not a CSRF token — is what keeps it same-site.
 */

export interface ProductUsersRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly directory: ProductUserDirectoryReader;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedOrNull(value: string | null, maximum: number): string | null {
  return value === null ? null : bounded(value, maximum);
}

/**
 * Explicit field-by-field projection. Nothing the browser has no business
 * seeing can ride along, whatever the upstream row happens to carry.
 */
function sanitizeRow(row: ProductUserDirectoryRow): ProductUserDirectoryRow {
  return {
    subject: bounded(row.subject, PRODUCT_USER_MAX_SUBJECT_LENGTH),
    authMethod: bounded(row.authMethod, PRODUCT_USER_MAX_AUTH_METHOD_LENGTH),
    email: boundedOrNull(row.email, PRODUCT_USER_MAX_TEXT_LENGTH),
    walletAddress: boundedOrNull(
      row.walletAddress,
      PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
    ),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    standing: row.standing,
    savedRepackCount: row.savedRepackCount,
    savedCollectibleCount: row.savedCollectibleCount,
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the product-user request and try again.",
    code: "INVALID_PRODUCT_USER_REQUEST",
    details,
  });
}

/**
 * Every failure resolves to one of the directory's stable codes. No upstream
 * status text, body, or exception detail is ever restated to the browser.
 */
function failure(response: Response, error: unknown): void {
  if (error instanceof ProductUserDirectoryError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  response.status(503).json({
    error: "The product-user directory is temporarily unavailable.",
    code: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
  });
}

export function createProductUsersRouter(
  dependencies: ProductUsersRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "product_users:view",
  });

  router.post("/list", dependencies.sameOrigin, read, async (request, response) => {
    const body = listProductUsersRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    try {
      const page = await dependencies.directory.listProductUsers({
        ...(body.data.search === undefined ? {} : { search: body.data.search }),
        ...(body.data.cursor === undefined ? {} : { cursor: body.data.cursor }),
        limit: body.data.limit,
      });
      // Personal data must not be stored by any intermediary or the browser.
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: page.items.slice(0, body.data.limit).map(sanitizeRow),
        nextCursor:
          page.nextCursor === null
            ? null
            : bounded(page.nextCursor, PRODUCT_USER_MAX_CURSOR_LENGTH),
        searchTruncated: page.searchTruncated,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  return router;
}
