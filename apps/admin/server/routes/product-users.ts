import { Router, type RequestHandler, type Response } from "express";
import {
  listProductUsersRequestSchema,
  productUserDetailRequestSchema,
  setProductUserStandingRequestSchema,
  PRODUCT_USER_MAX_AUTH_METHOD_LENGTH,
  PRODUCT_USER_MAX_CURSOR_LENGTH,
  PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH,
  PRODUCT_USER_MAX_PUBLIC_ID_LENGTH,
  PRODUCT_USER_MAX_SAVED_ITEM_COUNT,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  PRODUCT_USER_MAX_TEXT_LENGTH,
  PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
  type ProductUserDirectoryRow,
  type ProductUserRecord,
  type ProductUserSavedCollectible,
  type ProductUserSavedRepack,
  type ProductUserStanding,
  type ProductUserStandingChange,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession, getAuthenticatedActor } from "../auth/middleware.ts";
import {
  productUserAuditAction,
  type ProductUserAuditAction,
  type ProductUserAuditOutcome,
  type ProductUserAuditSink,
} from "../product-user-audit.ts";
import {
  ProductUserDirectoryError,
  type ProductUserDirectoryReader,
} from "../product-user-directory.ts";

/**
 * The admin's product-user directory surface.
 *
 * The browser talks only to this route; the server-to-server integration and
 * its credential stay behind it. Reads are guarded by `product_users:view` and
 * the one account control by `product_users:manage`, both of which only
 * administrators hold, and every listing is bounded and paginated.
 *
 * The listing is a POST because search terms and subject keys are personal
 * data: carrying them in a request body keeps them out of URLs, browser
 * history, referrers, and access logs. Reads perform no mutation, so the
 * same-origin guard — not a CSRF token — is what keeps them same-site; the
 * standing control is a state change and additionally requires the token.
 *
 * There is exactly one write here and it is a reversible standing flip. No
 * route on this surface deletes a product user or edits what they have saved.
 */

/**
 * A recording that did not happen. The standing change itself may already have
 * committed, so this can never alter what the browser is told; it names the
 * gap in the trail with non-personal values so an operator can find it.
 */
export interface ProductUserAuditFailure {
  readonly action: ProductUserAuditAction;
  readonly outcome: ProductUserAuditOutcome;
  /** True when the directory change had already committed upstream. */
  readonly afterCommit: boolean;
}

export interface ProductUsersRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly directory: ProductUserDirectoryReader;
  readonly audit: ProductUserAuditSink;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
  /** Where an unwritable audit record is reported. Defaults to the error log. */
  readonly onAuditFailure?: (failure: ProductUserAuditFailure) => void;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedOrNull(value: string | null, maximum: number): string | null {
  return value === null ? null : bounded(value, maximum);
}

/**
 * Explicit field-by-field projection. Nothing the browser has no business
 * seeing can ride along, whatever the upstream record happens to carry.
 */
function sanitizeRecord(record: ProductUserRecord): ProductUserRecord {
  return {
    subject: bounded(record.subject, PRODUCT_USER_MAX_SUBJECT_LENGTH),
    authMethod: bounded(record.authMethod, PRODUCT_USER_MAX_AUTH_METHOD_LENGTH),
    email: boundedOrNull(record.email, PRODUCT_USER_MAX_TEXT_LENGTH),
    walletAddress: boundedOrNull(
      record.walletAddress,
      PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
    ),
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    standing: record.standing,
  };
}

function sanitizeRow(row: ProductUserDirectoryRow): ProductUserDirectoryRow {
  return {
    ...sanitizeRecord(row),
    savedRepackCount: row.savedRepackCount,
    savedCollectibleCount: row.savedCollectibleCount,
  };
}

/**
 * Saved items are relayed, never restated: the browser receives the identifier,
 * the save time, and only the display fields the product backend resolved.
 */
function sanitizeSavedRepack(item: ProductUserSavedRepack): ProductUserSavedRepack {
  const publicRepackId = bounded(
    item.publicRepackId,
    PRODUCT_USER_MAX_PUBLIC_ID_LENGTH,
  );
  return item.resolution === "resolved"
    ? {
        resolution: "resolved",
        publicRepackId,
        savedAt: item.savedAt,
        name: bounded(item.name, PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH),
        vendorDisplayName: bounded(
          item.vendorDisplayName,
          PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH,
        ),
        availability: item.availability,
        estimatedEv:
          item.estimatedEv === null
            ? null
            : {
                evDollarsMinorUnits: item.estimatedEv.evDollarsMinorUnits,
                grossReturnBasisPoints:
                  item.estimatedEv.grossReturnBasisPoints,
                confidenceBand: item.estimatedEv.confidenceBand,
              },
      }
    : { resolution: "unresolved", publicRepackId, savedAt: item.savedAt };
}

function sanitizeSavedCollectible(
  item: ProductUserSavedCollectible,
): ProductUserSavedCollectible {
  const publicCollectibleId = bounded(
    item.publicCollectibleId,
    PRODUCT_USER_MAX_PUBLIC_ID_LENGTH,
  );
  return item.resolution === "resolved"
    ? {
        resolution: "resolved",
        publicCollectibleId,
        savedAt: item.savedAt,
        name: bounded(item.name, PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH),
        collectibleType: item.collectibleType,
      }
    : { resolution: "unresolved", publicCollectibleId, savedAt: item.savedAt };
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

/**
 * A short, non-personal description of why an attempt did not succeed. It is
 * the directory's own stable code, never an upstream message.
 */
function failureReason(error: unknown): string {
  return error instanceof ProductUserDirectoryError
    ? error.code
    : "PRODUCT_USER_DIRECTORY_UNAVAILABLE";
}

/**
 * The default report for an audit write that failed: one bounded line naming
 * the action and where it failed, and nothing about the person it concerned.
 */
function logAuditFailure(failure: ProductUserAuditFailure): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "product_user_audit_write_failed",
      action: failure.action,
      outcome: failure.outcome,
      afterCommit: failure.afterCommit,
    }),
  );
}

export function createProductUsersRouter(
  dependencies: ProductUsersRouterDependencies,
) {
  const router = Router();
  const reportAuditFailure = dependencies.onAuditFailure ?? logAuditFailure;
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "product_users:view",
  });
  const manage = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { csrf: true, permission: "product_users:manage" },
  );

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

  /**
   * One user's detail: their directory record and both saved-item collections,
   * already resolved against the active catalog by the product backend. The
   * browser never reaches that backend; this is the only route to it, and it is
   * a read — no path here adds, removes, or edits a user's saved items.
   */
  router.post("/detail", dependencies.sameOrigin, read, async (request, response) => {
    const body = productUserDetailRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    try {
      const detail = await dependencies.directory.getProductUserDetail({
        subject: body.data.subject,
      });
      // Personal data must not be stored by any intermediary or the browser.
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        user: sanitizeRecord(detail.user),
        catalogAvailable: detail.catalogAvailable,
        savedRepacks: detail.savedRepacks
          .slice(0, PRODUCT_USER_MAX_SAVED_ITEM_COUNT)
          .map(sanitizeSavedRepack),
        savedCollectibles: detail.savedCollectibles
          .slice(0, PRODUCT_USER_MAX_SAVED_ITEM_COUNT)
          .map(sanitizeSavedCollectible),
      });
    } catch (error) {
      failure(response, error);
    }
  });

  /**
   * The one account control: a reversible standing flip, guarded by
   * `product_users:manage` and a CSRF token, and audited whichever way it goes.
   *
   * The request names the standing it wants rather than an operation, so the
   * administrator who acts on a stale row and the administrator who acts twice
   * both converge on the same authoritative result instead of toggling or
   * failing. The response restates the standing the product backend now holds.
   *
   * The directory change and its audit record are separate failure domains and
   * are kept that way. The change commits remotely and cannot be rolled back
   * from here, so once it has committed the response reports it — a refused
   * audit write is reported as an audit failure, never as a directory failure
   * that would leave the operator and the trail both describing the wrong
   * outcome.
   */
  router.post("/standing", dependencies.sameOrigin, manage, async (request, response) => {
    const body = setProductUserStandingRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    const actor = getAuthenticatedActor(response);
    const { subject, standing } = body.data;
    const action = productUserAuditAction(standing);
    const event = {
      organizationId: actor.organizationId,
      actorId: actor.operatorId,
      action,
      subject,
      occurredAt: new Date(),
    } as const;
    /** Records the attempt without letting the recording decide the outcome. */
    async function record(
      outcome: ProductUserAuditOutcome,
      detail: { standing?: ProductUserStanding; reason?: string },
      afterCommit: boolean,
    ): Promise<void> {
      try {
        await dependencies.audit.append({ ...event, outcome, ...detail });
      } catch {
        try {
          reportAuditFailure({ action, outcome, afterCommit });
        } catch {
          // Reporting the gap must not become a third failure domain.
        }
      }
    }

    let change: ProductUserStandingChange;
    try {
      change = await dependencies.directory.setProductUserStanding({
        subject,
        standing,
      });
    } catch (error) {
      // Nothing committed: this attempt on someone's account is still recorded
      // before the refusal is reported.
      await record("failure", { reason: failureReason(error) }, false);
      failure(response, error);
      return;
    }

    // Past this point the standing has changed upstream, so the response says
    // so whatever the trail manages to record.
    await record("success", { standing: change.user.standing }, true);
    // Personal data must not be stored by any intermediary or the browser.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      user: sanitizeRecord(change.user),
      changed: change.changed,
    });
  });

  return router;
}
