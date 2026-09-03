import { Router, type RequestHandler } from "express";
import {
  passwordResetCompletionRequestSchema,
  passwordResetRequestSchema,
} from "@packscout/contracts";

/**
 * The operator password-reset routes: a route into authentication, never
 * around it. Both endpoints are deliberately unauthenticated — the whole
 * point is an operator who cannot sign in — and both follow the sign-in
 * endpoint's own discipline for unauthenticated POSTs: a trusted Origin is
 * required before any work begins, inputs are schema-validated, and no
 * response ever distinguishes a known address from an unknown one or one
 * dead link from another.
 *
 * The request endpoint has exactly one post-validation response, whatever
 * happened: the flow's own issuance path (messaging/008) already makes
 * known, unknown, invalid, and rate-limited requests indistinguishable, and
 * this route keeps even an internal failure from becoming a distinguishing
 * oracle. The completion endpoint has exactly one response for every dead
 * link — unknown, expired, superseded, reused, or ineligible — and reports
 * password-rule violations with the same specific messages an
 * administrator-set password would receive.
 */

/** The one wording every dead, used, expired, or superseded link receives. */
export const PASSWORD_RESET_LINK_INVALID_MESSAGE =
  "This link is no longer valid. Request a new one.";

/** The one response body every accepted reset request receives. */
export const PASSWORD_RESET_ACCEPTED_BODY = Object.freeze({
  status: "accepted",
} as const);

export type PasswordResetCompletionOutcome =
  | { readonly status: "completed" }
  | { readonly status: "rejected" }
  | { readonly status: "unavailable" };

/**
 * The flow behind the routes (composed in `password-reset-runtime.ts`).
 * `requestReset` never throws in normal operation and resolves identically
 * for every requester-visible outcome; `completeReset` returns a closed
 * outcome so the route maps states, not exceptions.
 */
export interface OperatorPasswordResetFlow {
  requestReset(input: { email: string; source: string }): Promise<void>;
  completeReset(input: {
    token: string;
    password: string;
  }): Promise<PasswordResetCompletionOutcome>;
}

export interface PasswordResetRouterDependencies {
  flow: OperatorPasswordResetFlow;
  sameOrigin: RequestHandler;
}

export function createPasswordResetRouter({
  flow,
  sameOrigin,
}: PasswordResetRouterDependencies) {
  const router = Router();

  router.post("/request", sameOrigin, async (request, response) => {
    const parsed = passwordResetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({
        error: "Check the reset form and try again.",
        code: "VALIDATION_FAILED",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      await flow.requestReset({
        email: parsed.data.email,
        source: request.ip ?? request.socket.remoteAddress ?? "unknown",
      });
    } catch {
      // A flow failure must not become an oracle: the requester sees the
      // same acceptance as every other request. Content-free by design —
      // never the address, and never anything the flow was holding.
      console.error(
        JSON.stringify({
          level: "error",
          event: "admin_password_reset_request_failed",
        }),
      );
    }
    response.status(202).json(PASSWORD_RESET_ACCEPTED_BODY);
  });

  router.post("/complete", sameOrigin, async (request, response) => {
    const parsed = passwordResetCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const failedFields = Object.keys(fieldErrors);
      // A structurally unusable token is just another dead link: the same
      // plain screen as expiry or reuse, never a distinct validation shape.
      if (failedFields.length === 1 && failedFields[0] === "token") {
        response.status(410).json({
          error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
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
    let outcome: PasswordResetCompletionOutcome;
    try {
      outcome = await flow.completeReset({
        token: parsed.data.token,
        password: parsed.data.password,
      });
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          event: "admin_password_reset_completion_failed",
        }),
      );
      outcome = { status: "unavailable" };
    }
    if (outcome.status === "completed") {
      response.status(204).end();
      return;
    }
    if (outcome.status === "rejected") {
      response.status(410).json({
        error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
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
