import { Router } from "express";
import {
  inviteOperatorRequestSchema,
  listOperatorsQuerySchema,
  operatorIdSchema,
  updateOperatorRequestSchema,
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

/**
 * Operator management. Creating an account is an invitation now: an address,
 * a name, and a role, and a single-use link mailed to the address — so a
 * working password is never chosen by one person and communicated to
 * another. Reissue and cancel sit behind the same `operators:manage`
 * permission, the same trusted-Origin and CSRF discipline, and the same
 * audit trail as every other operator mutation. Nothing here ever sees or
 * returns a token, a link, or a password.
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
    | "inviteOperator"
    | "updateOperator"
    | "cancelInvitedOperator"
    | "resolvePendingOperatorForReissue"
    | "recordInvitationReissue"
  >;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
  invitations?: OperatorInvitationRuntime;
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

/** The one wording every refused invitation issuance receives. */
const INVITATION_UNAVAILABLE =
  "The invitation could not be sent. Try again shortly.";

function sendInvitationUnavailable(
  response: import("express").Response,
): void {
  response.status(503).json({
    error: INVITATION_UNAVAILABLE,
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
      // An account nobody can be told about is not a provisioned account.
      // Withdraw it and its links so the tree is left in one of two honest
      // states — pending with an outstanding invitation, or cancelled.
      try {
        await service.cancelInvitedOperator(actor, created.operator.id);
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
      sendInvitationUnavailable(response);
    }
  });

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
        await service.recordInvitationReissue(actor, target.operatorId, "success");
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
      try {
        // The account moves out of `pending` first, so redemption's own
        // eligibility recheck already refuses; superseding the outstanding
        // links then removes the row's liveness too.
        const cancelled = await service.cancelInvitedOperator(
          actor,
          operatorId.data,
        );
        if (invitations) {
          await invitations.flow.revokeInvitations(operatorId.data);
        }
        response.status(200).json(cancelled);
      } catch (error) {
        sendAuthServiceError(response, error, cookiePolicy);
      }
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
