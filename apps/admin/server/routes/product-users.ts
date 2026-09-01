import { Router, type RequestHandler, type Response } from "express";
import {
  decideProductUserAccessRequestSchema,
  listProductUserAccessQueueRequestSchema,
  listProductUsersRequestSchema,
  productUserAccessActions,
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
  type ProductUserAccessDecision,
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
  productUserAccessAuditAction,
  productUserAuditAction,
  type ProductUserAuditAction,
  type ProductUserAuditNotice,
  type ProductUserAuditOutcome,
  type ProductUserAuditSink,
} from "../product-user-audit.ts";
import type {
  AccessDecisionNoticeResult,
  AccessDecisionNotifier,
} from "../access-decision-notice.ts";
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
 * standing control and the access decisions are state changes and additionally
 * require the token.
 *
 * Every write here is a reversible flip — the standing control, and the three
 * closed-beta access decisions (approve, decline, revoke). No route on this
 * surface deletes a product user or edits what they have saved.
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

/**
 * A decision notice that did not get enqueued. The decision itself has
 * already committed, so this can never alter what the browser is told; it
 * names the failed messaging attempt with non-personal values — the audit
 * trail carries the same fact durably on the decision's own event.
 */
export interface ProductUserNoticeFailure {
  readonly action: ProductUserAuditAction;
  /** The notice's stable failure code; never an address or upstream text. */
  readonly reason: string;
}

export interface ProductUsersRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly directory: ProductUserDirectoryReader;
  readonly audit: ProductUserAuditSink;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
  /**
   * Enqueues the message a committed access decision earns (messaging/006).
   * Its results are recorded and reported; they never fail the decision.
   */
  readonly decisionNotice: AccessDecisionNotifier;
  /** Where an unwritable audit record is reported. Defaults to the error log. */
  readonly onAuditFailure?: (failure: ProductUserAuditFailure) => void;
  /** Where a failed decision-notice enqueue is reported. Defaults to the error log. */
  readonly onNoticeFailure?: (failure: ProductUserNoticeFailure) => void;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedOrNull(value: string | null, maximum: number): string | null {
  return value === null ? null : bounded(value, maximum);
}

/**
 * The access decision is relayed as exactly its three display fields. The
 * integration already dropped the stored decision's operator and allowlist
 * references; this projection makes sure nothing new can ever ride along.
 */
function sanitizeDecision(
  decision: ProductUserAccessDecision,
): ProductUserAccessDecision {
  return {
    state: decision.state,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
  };
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
    ...(record.profile === undefined
      ? {}
      : {
          profile: record.profile === null
            ? null
            : {
                name: boundedOrNull(record.profile.name, PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH),
                email: boundedOrNull(record.profile.email, PRODUCT_USER_MAX_TEXT_LENGTH),
              },
        }),
    walletAddress: boundedOrNull(
      record.walletAddress,
      PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH,
    ),
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    standing: record.standing,
    access: sanitizeDecision(record.access),
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

/**
 * The default report for a decision notice that failed to enqueue: one
 * bounded line naming the decision and the stable failure code, and nothing
 * about the person it concerned. The committed decision already stands.
 */
function logNoticeFailure(failure: ProductUserNoticeFailure): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "product_user_decision_notice_failed",
      action: failure.action,
      reason: failure.reason,
    }),
  );
}

/**
 * The notice result as the audit trail records it, on the decision's own
 * success event. A revoke or a converged repeat attempts no notice and
 * records none, so the trail never claims silence was tried.
 */
function auditNotice(
  notice: AccessDecisionNoticeResult,
): ProductUserAuditNotice | undefined {
  switch (notice.outcome) {
    case "not_applicable":
      return undefined;
    case "enqueued":
      return { outcome: "enqueued" };
    case "skipped_no_verified_email":
      return { outcome: "skipped_no_verified_email" };
    case "failed":
      return { outcome: "failed", reason: notice.reason };
  }
}

export function createProductUsersRouter(
  dependencies: ProductUsersRouterDependencies,
) {
  const router = Router();
  const reportAuditFailure = dependencies.onAuditFailure ?? logAuditFailure;
  const reportNoticeFailure = dependencies.onNoticeFailure ?? logNoticeFailure;
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

  /**
   * The review queue: identities in one decision state — awaiting review by
   * default — oldest request first with the directory's bounded pagination.
   * It is a read guarded like the listing, and its rows are the same bounded
   * projection, so the queue can never show more about a person than the
   * ledger does.
   */
  router.post(
    "/access/queue",
    dependencies.sameOrigin,
    read,
    async (request, response) => {
      const body = listProductUserAccessQueueRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
      try {
        const page = await dependencies.directory.listProductUserAccessQueue({
          accessState: body.data.accessState,
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
          queueTruncated: page.queueTruncated,
        });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  /**
   * The bounded awaiting-review count for the page header, so operators see
   * that work is waiting without paging the queue. It consumes nothing from
   * the request — there is no parameter to validate — and it carries no
   * personal data, only a number and whether the counting bound was hit.
   */
  router.post(
    "/access/queue-count",
    dependencies.sameOrigin,
    read,
    async (_request, response) => {
      try {
        const count = await dependencies.directory.countAwaitingReview();
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({
          count: count.count,
          truncated: count.truncated,
        });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  /**
   * The three closed-beta access decisions: approve admits, decline refuses,
   * revoke returns the person to awaiting review. Each is a reversible flip
   * guarded by `product_users:manage` and a CSRF token, keyed by the subject
   * in the body, stamped with the session's own operator — no request shape
   * can act as someone else — and audited whichever way it goes, with the
   * previous and resulting decision recorded alongside the outcome.
   *
   * The product backend owns the flip, so repeated or concurrent decisions
   * converge there: an operation whose target state already holds reports
   * `changed: false` with the authoritative decision, which the response
   * restates rather than failing. A subject with no directory record is
   * "nothing to decide" upstream and is restated here as the same not-found
   * outcome an unknown subject gets everywhere else on this surface.
   */
  for (const accessAction of productUserAccessActions) {
    router.post(
      `/access/${accessAction}`,
      dependencies.sameOrigin,
      manage,
      async (request, response) => {
        const body = decideProductUserAccessRequestSchema.safeParse(
          request.body ?? {},
        );
        if (!body.success) {
          return invalid(response, body.error.flatten().fieldErrors);
        }
        const actor = getAuthenticatedActor(response);
        const { subject } = body.data;
        const action = productUserAccessAuditAction(accessAction);
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
          detail: {
            accessChange?: {
              previous: ProductUserAccessDecision;
              resulting: ProductUserAccessDecision;
              changed: boolean;
            };
            notice?: ProductUserAuditNotice;
            reason?: string;
          },
          afterCommit: boolean,
        ): Promise<void> {
          try {
            await dependencies.audit.append({
              ...event,
              outcome,
              ...(detail.reason === undefined ? {} : { reason: detail.reason }),
              ...(detail.accessChange === undefined
                ? {}
                : {
                    accessChange: {
                      previous: {
                        state: detail.accessChange.previous.state,
                        decidedBy: detail.accessChange.previous.decidedBy,
                      },
                      resulting: {
                        state: detail.accessChange.resulting.state,
                        decidedBy: detail.accessChange.resulting.decidedBy,
                      },
                      changed: detail.accessChange.changed,
                    },
                  }),
              ...(detail.notice === undefined ? {} : { notice: detail.notice }),
            });
          } catch {
            try {
              reportAuditFailure({ action, outcome, afterCommit });
            } catch {
              // Reporting the gap must not become a third failure domain.
            }
          }
        }

        let decided: Awaited<
          ReturnType<ProductUserDirectoryReader["decideProductUserAccess"]>
        >;
        try {
          decided = await dependencies.directory.decideProductUserAccess({
            action: accessAction,
            subject,
            operatorId: actor.operatorId,
          });
        } catch (error) {
          // Nothing committed: this attempt on someone's account is still
          // recorded before the refusal is reported.
          await record("failure", { reason: failureReason(error) }, false);
          failure(response, error);
          return;
        }

        if (decided.outcome === "nothing_to_decide") {
          // Deciding about an identity with no record is reported, never
          // invented; pre-admitting someone is the allowlist's job.
          await record("failure", { reason: "PRODUCT_USER_NOT_FOUND" }, false);
          response.status(404).json({
            error:
              "That product user is not in the directory, so there is nothing to decide.",
            code: "PRODUCT_USER_NOT_FOUND",
          });
          return;
        }

        // Past this point the decision is committed and authoritative; the
        // notice can no longer change it. A genuine approve or decline
        // transition enqueues the person's message through the durable
        // outbox, a revoke or a converged repeat attempts nothing, and
        // whatever happens is recorded on the decision's own audit event
        // and reported — never turned into a failure of the decision.
        let notice: AccessDecisionNoticeResult;
        try {
          notice = await dependencies.decisionNotice.notifyAccessDecision({
            subject,
            changed: decided.changed,
            resulting: decided.resulting,
          });
        } catch {
          // The notifier's contract is to resolve; a throw anyway must not
          // unseat the committed decision.
          notice = {
            outcome: "failed",
            reason: "ACCESS_DECISION_NOTICE_FAILED",
          };
        }
        if (notice.outcome === "failed") {
          try {
            reportNoticeFailure({ action, reason: notice.reason });
          } catch {
            // Reporting the gap must not become another failure domain.
          }
        }
        const recordedNotice = auditNotice(notice);

        // The response says what the backend now holds, whatever the trail
        // manages to record.
        await record(
          "success",
          {
            accessChange: {
              previous: decided.previous,
              resulting: decided.resulting,
              changed: decided.changed,
            },
            ...(recordedNotice === undefined ? {} : { notice: recordedNotice }),
          },
          true,
        );
        // Personal data must not be stored by any intermediary or the browser.
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({
          action: accessAction,
          changed: decided.changed,
          access: sanitizeDecision(decided.resulting),
          effectiveAccess: decided.effectiveAccess.admitted
            ? { admitted: true, reason: "approved" }
            : { admitted: false, reason: decided.effectiveAccess.reason },
        });
      },
    );
  }

  return router;
}
