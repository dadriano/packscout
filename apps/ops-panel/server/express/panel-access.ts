import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuditOutcome, AuditTrail } from "../core/audit-trail.ts";
import {
  evaluatePanelAccess,
  outcomeForStatus,
  PANEL_REQUEST_HEADER,
  type PanelRequestClassification,
} from "../core/access.ts";

/**
 * Express adapter over the pure access model. Every request passes through it,
 * so admin-tools/011 through admin-tools/015 add routes without repeating — or
 * accidentally weakening — the guards.
 */

const CLASSIFICATION_KEY = "panelClassification";
const RECORDER_KEY = "recordPanelOutcome";

type OutcomeRecorder = (outcome: AuditOutcome, detail?: string) => void;

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The guard decision for the current request, for handlers that need it. */
export function panelClassificationOf(
  response: Response,
): PanelRequestClassification | undefined {
  return response.locals[CLASSIFICATION_KEY] as
    | PanelRequestClassification
    | undefined;
}

/**
 * Record a richer outcome than the status code alone conveys. Optional: the
 * middleware always records an outcome when the response completes.
 */
export function recordPanelOutcome(
  response: Response,
  outcome: AuditOutcome,
  detail?: string,
): void {
  const recorder = response.locals[RECORDER_KEY] as OutcomeRecorder | undefined;
  recorder?.(outcome, detail);
}

export interface PanelAccessOptions {
  audit: AuditTrail;
  onAuditError?: (error: unknown) => void;
}

export function createPanelAccessMiddleware({
  audit,
  onAuditError,
}: PanelAccessOptions): RequestHandler {
  function record(
    classification: PanelRequestClassification,
    method: string,
    outcome: AuditOutcome,
    extra: { reason?: string; detail?: string } = {},
  ): void {
    void audit
      .record({
        action: classification.action,
        method,
        route: classification.action.split(" ")[1] ?? "unknown",
        outcome,
        ...extra,
      })
      .catch((error) => onAuditError?.(error));
  }

  return function panelAccess(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    // originalUrl keeps the classification correct no matter where the guard is
    // mounted, so a nested router cannot silently narrow guard membership.
    const decision = evaluatePanelAccess({
      method: request.method,
      path: request.originalUrl || request.url,
      host: headerValue(request, "host"),
      origin: headerValue(request, "origin"),
      panelHeader: headerValue(request, PANEL_REQUEST_HEADER),
    });
    const { classification } = decision;
    const method = request.method.toUpperCase();
    response.locals[CLASSIFICATION_KEY] = classification;

    if (!decision.allowed) {
      if (classification.privileged) {
        record(classification, method, "rejected", { reason: decision.code });
      }
      response
        .status(decision.status)
        .json({ error: decision.message, code: decision.code });
      return;
    }

    if (classification.privileged) {
      let recorded = false;
      const finish: OutcomeRecorder = (outcome, detail) => {
        if (recorded) return;
        recorded = true;
        record(classification, method, outcome, detail ? { detail } : {});
      };
      response.locals[RECORDER_KEY] = finish;
      // Auditing is driven by the response, so a handler cannot forget it.
      response.once("finish", () => {
        finish(outcomeForStatus(response.statusCode));
      });
      response.once("close", () => {
        finish(
          response.writableEnded ? outcomeForStatus(response.statusCode) : "failed",
          response.writableEnded
            ? undefined
            : "the client disconnected before the response finished",
        );
      });
    }

    next();
  };
}
