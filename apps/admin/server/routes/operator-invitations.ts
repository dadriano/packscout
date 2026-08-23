import { Router, type RequestHandler } from "express";
import { operatorInvitationAcceptanceRequestSchema } from "@packscout/contracts";
import type { OperatorInvitationFlow } from "./operators.ts";

/**
 * The invitation-acceptance route: deliberately unauthenticated, because the
 * whole point is someone who has no account to sign in with yet. It follows
 * the sign-in endpoint's discipline for unauthenticated POSTs — a trusted
 * Origin is required before any work begins, inputs are schema-validated,
 * and every dead link produces one indistinguishable outcome.
 *
 * Cancelled, superseded, expired, reused, malformed, and simply unknown
 * links all collapse into the same plain refusal, so nothing here reveals
 * whether an account exists, what state it is in, who invited it, or what
 * role it holds. Password-rule violations reuse the same messages an
 * administrator-set password would receive; the flow introduces no password
 * policy of its own.
 */

/** The one wording every dead, used, expired, cancelled, or superseded link receives. */
export const OPERATOR_INVITATION_LINK_INVALID_MESSAGE =
  "This invitation link is no longer valid. Ask an administrator to send a new one.";

export interface OperatorInvitationsRouterDependencies {
  flow: Pick<OperatorInvitationFlow, "acceptInvitation">;
  sameOrigin: RequestHandler;
}

export function createOperatorInvitationsRouter({
  flow,
  sameOrigin,
}: OperatorInvitationsRouterDependencies) {
  const router = Router();

  router.post("/accept", sameOrigin, async (request, response) => {
    const parsed = operatorInvitationAcceptanceRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const failedFields = Object.keys(fieldErrors);
      // A structurally unusable token is just another dead link: the same
      // plain screen as expiry or cancellation, never a distinct shape.
      if (failedFields.length === 1 && failedFields[0] === "token") {
        response.status(410).json({
          error: OPERATOR_INVITATION_LINK_INVALID_MESSAGE,
          code: "EMAIL_LINK_INVALID",
        });
        return;
      }
      response.status(422).json({
        error: "Check the new password and try again.",
        code: "VALIDATION_FAILED",
        details: fieldErrors,
      });
      return;
    }
    let outcome;
    try {
      outcome = await flow.acceptInvitation({
        token: parsed.data.token,
        password: parsed.data.password,
      });
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          event: "admin_operator_invitation_acceptance_failed",
        }),
      );
      outcome = { status: "unavailable" as const };
    }
    if (outcome.status === "activated") {
      response.status(204).end();
      return;
    }
    if (outcome.status === "rejected") {
      response.status(410).json({
        error: OPERATOR_INVITATION_LINK_INVALID_MESSAGE,
        code: "EMAIL_LINK_INVALID",
      });
      return;
    }
    response.status(503).json({
      error: "PackScout Admin is temporarily unavailable.",
      code: "SERVICE_UNAVAILABLE",
    });
  });

  return router;
}
