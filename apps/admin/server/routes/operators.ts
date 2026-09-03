import { Router } from "express";
import {
  directProvisionOperatorRequestSchema,
  inviteOperatorRequestSchema,
  listOperatorsQuerySchema,
  operatorIdSchema,
  updateOperatorRequestSchema,
  type OperatorAccountCreatedNotificationOutcome,
  type OperatorInvitationStatus,
  type OperatorSummary,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { RequestHandler } from "express";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
  sendAuthServiceError,
} from "../auth/middleware.ts";
import type { OperatorAccountCreatedNotifier } from "../operator-account-created-notice.ts";

/**
 * Operator management offers two explicit creation boundaries: invitation,
 * where the recipient chooses a password through a single-use link, and
 * direct provisioning, where an administrator sets an initial password and
 * shares it through a separate secure channel. Both sit behind the same
 * `operators:manage`, trusted-Origin, CSRF, and authoritative-session checks.
 * No response, notification input, or log ever carries credential material.
 */

export type IssueOperatorInvitationOutcome =
  | { readonly status: "issued"; readonly sentAt: string; readonly expiresAt: string }
  /** Within the mechanism's per-address or per-source issuance bound. */
  | { readonly status: "rate_limited" };

export type OperatorInvitationAcceptanceOutcome =
  | { readonly status: "activated" }
  | { readonly status: "rejected" }
  | { readonly status: "unavailable" };

/**
 * The invitation flow behind the routes (composed in
 * `operator-invitation-runtime.ts`).
 */
export interface OperatorInvitationFlow {
  issueInvitation(input: {
    operatorId: string;
    email: string;
    invitedByDisplayName: string;
    source: string;
    actorKey?: string;
  }): Promise<IssueOperatorInvitationOutcome>;
  /** Supersedes every outstanding invitation for the account. */
  revokeInvitations(operatorId: string): Promise<void>;
  /** Ledger-safe status per account: no token, no selector, no link. */
  describeInvitations(
    operatorIds: readonly string[],
  ): Promise<Map<string, OperatorInvitationStatus>>;
  acceptInvitation(input: {
    token: string;
    password: string;
  }): Promise<OperatorInvitationAcceptanceOutcome>;
}

export interface OperatorInvitationRuntime {
  flow: OperatorInvitationFlow;
}

export interface OperatorsRouterDependencies {
  service: Pick<
    AuthService,
    | "resolveSession"
    | "requirePermission"
    | "listOperators"
    | "provisionOperator"
    | "inviteOperator"
    | "updateOperator"
    | "cancelInvitedOperator"
    | "resolvePendingOperatorForReissue"
    | "recordInvitationReissue"
  >;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
  invitations?: OperatorInvitationRuntime;
  accountCreatedNotifier?: OperatorAccountCreatedNotifier;
}

function sendValidationError(
  response: import("express").Response,
  fieldErrors: Record<string, string[] | undefined>,
): void {
  response.status(422).json({
    error: "Check the operator details and try again.",
    code: "VALIDATION_FAILED",
    details: fieldErrors,
  });
}

/** The wording a refused invitation issuance receives. */
const INVITATION_UNAVAILABLE =
  "The invitation could not be sent. Try again shortly.";

/**
 * Creation is the one case where the account outlives the refusal: it rests
 * pending with no live link, so the answer says where to pick it up rather
 * than implying nothing happened.
 */
const INVITATION_UNAVAILABLE_ACCOUNT_WAITING =
  "The invitation could not be sent. The account is waiting in the operators list — resend its invitation from there.";

const ACCOUNT_CREATED_EMAIL_UNCONFIGURED =
  "OPERATOR_ACCOUNT_CREATED_EMAIL_UNCONFIGURED";
const ACCOUNT_CREATED_EMAIL_UNAVAILABLE = "EMAIL_OUTBOX_UNAVAILABLE";

function sendInvitationUnavailable(
  response: import("express").Response,
  error: string = INVITATION_UNAVAILABLE,
): void {
  response.status(503).json({
    error,
    code: "SERVICE_UNAVAILABLE",
  });
}

function requestSource(request: import("express").Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

export function createOperatorsRouter({
  service,
  cookiePolicy,
  sameOrigin,
  invitations,
  accountCreatedNotifier,
}: OperatorsRouterDependencies) {
  const router = Router();
  const requireAdmin = createRequireSession(service, cookiePolicy, {
    permission: "operators:manage",
  });
  const requireAdminMutation = createRequireSession(service, cookiePolicy, {
    csrf: true,
    permission: "operators:manage",
  });

  /**
   * Decorates pending accounts with their invitation status so the ledger can
   * tell pending, invitation-expired, active, disabled, and cancelled apart at
   * a glance. Only accounts still awaiting activation are looked up, and only
   * timestamps come back.
   */
  async function withInvitationStatus(
    items: OperatorSummary[],
  ): Promise<OperatorSummary[]> {
    const pending = items.filter((item) => item.state === "pending");
    if (!invitations || pending.length === 0) return items;
    const statuses = await invitations.flow.describeInvitations(
      pending.map((item) => item.id),
    );
    return items.map((item) =>
      item.state === "pending"
        ? { ...item, invitation: statuses.get(item.id) ?? null }
        : item,
    );
  }

  router.get("/", requireAdmin, async (request, response) => {
    const parsed = listOperatorsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendValidationError(response, parsed.error.flatten().fieldErrors);
      return;
    }
    try {
      const result = await service.listOperators(
        getAuthenticatedActor(response),
        parsed.data,
      );
      response.status(200).json({
        ...result,
        items: await withInvitationStatus(result.items),
      });
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
    }
  });

  router.post("/", sameOrigin, requireAdminMutation, async (request, response) => {
    const parsed = inviteOperatorRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error.flatten().fieldErrors);
      return;
    }
    if (!invitations) {
      sendInvitationUnavailable(response);
      return;
    }
    const actor = getAuthenticatedActor(response);
    let created;
    try {
      created = await service.inviteOperator(actor, parsed.data);
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
      return;
    }
    try {
      const issued = await invitations.flow.issueInvitation({
        operatorId: created.operator.id,
        email: created.operator.email,
        invitedByDisplayName: actor.displayName,
        source: requestSource(request),
        actorKey: actor.operatorId,
      });
      if (issued.status !== "issued") throw new Error("invitation refused");
      response.status(201).json({
        operator: {
          ...created.operator,
          invitation: {
            sentAt: issued.sentAt,
            expiresAt: issued.expiresAt,
            expired: false,
          },
        },
      });
    } catch {
      // Compensation is not cancellation. Cancelling here would spend the
      // administrator's deliberate terminal action on a delivery hiccup, and
      // because the address stays unique across every state, that row would
      // reserve the address with no route back — the 503 below would be
      // telling them to retry something the API cannot do.
      //
      // Instead the account rests pending with no live link: the state the
      // ledger already shows as an invitation needing to be resent, and the
      // one the existing permission-guarded Resend control recovers from.
      // It still cannot authenticate, so nothing is usable in the meantime.
      try {
        await invitations.flow.revokeInvitations(created.operator.id);
      } catch {
        // Content-free by design: never the address or anything held.
        console.error(
          JSON.stringify({
            level: "error",
            event: "admin_operator_invitation_rollback_failed",
          }),
        );
      }
      sendInvitationUnavailable(response, INVITATION_UNAVAILABLE_ACCOUNT_WAITING);
    }
  });

  router.post(
    "/direct",
    sameOrigin,
    requireAdminMutation,
    async (request, response) => {
      const parsed = directProvisionOperatorRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendValidationError(response, parsed.error.flatten().fieldErrors);
        return;
      }
      const actor = getAuthenticatedActor(response);
      let created;
      try {
        created = await service.provisionOperator(actor, parsed.data);
      } catch (error) {
        sendAuthServiceError(response, error, cookiePolicy);
        return;
      }

      // The account is active and committed. Notification is a separate
      // failure domain, so every refusal or unexpected notifier exception is
      // represented inside the 201 response instead of inviting a duplicate
      // provisioning retry that can only conflict on the email address.
      let notification: OperatorAccountCreatedNotificationOutcome;
      if (!accountCreatedNotifier) {
        notification = {
          status: "failed",
          reason: ACCOUNT_CREATED_EMAIL_UNCONFIGURED,
        };
      } else {
        try {
          notification =
            await accountCreatedNotifier.notifyOperatorAccountCreated({
              operatorId: created.operator.id,
              toEmail: created.operator.email,
            });
        } catch {
          notification = {
            status: "failed",
            reason: ACCOUNT_CREATED_EMAIL_UNAVAILABLE,
          };
        }
      }
      response.status(201).json({
        operator: created.operator,
        notification,
      });
    },
  );

  router.post(
    "/:operatorId/invitation",
    sameOrigin,
    requireAdminMutation,
    async (request, response) => {
      const operatorId = operatorIdSchema.safeParse(request.params.operatorId);
      if (!operatorId.success) {
        sendValidationError(response, {
          operatorId: operatorId.error.issues.map((issue) => issue.message),
        });
        return;
      }
      if (!invitations) {
        sendInvitationUnavailable(response);
        return;
      }
      const actor = getAuthenticatedActor(response);
      let target;
      try {
        target = await service.resolvePendingOperatorForReissue(
          actor,
          operatorId.data,
        );
      } catch (error) {
        sendAuthServiceError(response, error, cookiePolicy);
        return;
      }
      try {
        // Issuing supersedes the account's outstanding invitations inside the
        // same write, so the older link stops working the moment this one is
        // recorded.
        const issued = await invitations.flow.issueInvitation({
          operatorId: target.operatorId,
          email: target.email,
          invitedByDisplayName: actor.displayName,
          source: requestSource(request),
          actorKey: actor.operatorId,
        });
        if (issued.status !== "issued") {
          await service.recordInvitationReissue(actor, target.operatorId, "blocked");
          sendInvitationUnavailable(response);
          return;
        }
        // The invitation and its message are committed. An audit sink that
        // fails now must not report the issuance as failed: an administrator
        // who retries on that answer issues a second invitation, which
        // supersedes the link already in the recipient's inbox and hands them
        // one that is dead on arrival. Audit failure is its own domain.
        try {
          await service.recordInvitationReissue(actor, target.operatorId, "success");
        } catch {
          console.error(
            JSON.stringify({
              level: "error",
              event: "admin_operator_invitation_reissue_audit_failed",
            }),
          );
        }
        response.status(200).json({
          invitation: {
            sentAt: issued.sentAt,
            expiresAt: issued.expiresAt,
            expired: false,
          },
        });
      } catch {
        try {
          await service.recordInvitationReissue(actor, target.operatorId, "failure");
        } catch {
          // Ignored: the response must not depend on the audit sink.
        }
        console.error(
          JSON.stringify({
            level: "error",
            event: "admin_operator_invitation_reissue_failed",
          }),
        );
        sendInvitationUnavailable(response);
      }
    },
  );

  router.delete(
    "/:operatorId/invitation",
    sameOrigin,
    requireAdminMutation,
    async (request, response) => {
      const operatorId = operatorIdSchema.safeParse(request.params.operatorId);
      if (!operatorId.success) {
        sendValidationError(response, {
          operatorId: operatorId.error.issues.map((issue) => issue.message),
        });
        return;
      }
      const actor = getAuthenticatedActor(response);
      let cancelled: Awaited<ReturnType<typeof service.cancelInvitedOperator>>;
      try {
        // The account moves out of `pending` first, so redemption's own
        // eligibility recheck already refuses; superseding the outstanding
        // links then removes the row's liveness too.
        cancelled = await service.cancelInvitedOperator(actor, operatorId.data);
      } catch (error) {
        // Nothing committed: the account is untouched and the refusal stands.
        sendAuthServiceError(response, error, cookiePolicy);
        return;
      }
      // The terminal `cancelled` state has committed and cannot be taken back
      // from here. Supersession is its own failure domain: answering with an
      // error because it failed sends the administrator to retry a
      // cancellation that already took effect, and the retry answers "not
      // pending" — the operator and the account then describe different
      // outcomes. The outstanding token is already inert, because redemption
      // rechecks account eligibility and a cancelled account is refused, so
      // the gap is operational and is reported on its own.
      if (invitations) {
        try {
          await invitations.flow.revokeInvitations(operatorId.data);
        } catch {
          // Content-free by design: never the address or anything held.
          console.error(
            JSON.stringify({
              level: "error",
              event: "admin_operator_invitation_supersession_failed",
            }),
          );
        }
      }
      response.status(200).json(cancelled);
    },
  );

  router.patch(
    "/:operatorId",
    sameOrigin,
    requireAdminMutation,
    async (request, response) => {
      const operatorId = operatorIdSchema.safeParse(request.params.operatorId);
      const body = updateOperatorRequestSchema.safeParse(request.body);
      if (!operatorId.success || !body.success) {
        sendValidationError(response, {
          ...(operatorId.success
            ? {}
            : { operatorId: operatorId.error.issues.map((issue) => issue.message) }),
          ...(body.success ? {} : body.error.flatten().fieldErrors),
        });
        return;
      }
      try {
        const result = await service.updateOperator(
          getAuthenticatedActor(response),
          operatorId.data,
          body.data,
        );
        response.status(200).json(result);
      } catch (error) {
        sendAuthServiceError(response, error, cookiePolicy);
      }
    },
  );

  return router;
}
