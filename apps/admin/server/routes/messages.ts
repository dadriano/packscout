import { Router, type RequestHandler, type Response } from "express";
import {
  MESSAGE_DELIVERY_MAX_CURSOR_LENGTH,
  MESSAGE_DELIVERY_MAX_ERROR_CODE_LENGTH,
  MESSAGE_DELIVERY_MAX_ERROR_MESSAGE_LENGTH,
  MESSAGE_DELIVERY_MAX_KIND_LENGTH,
  MESSAGE_DELIVERY_MAX_PROVIDER_LENGTH,
  MESSAGE_DELIVERY_MAX_PROVIDER_MESSAGE_ID_LENGTH,
  MESSAGE_DELIVERY_MAX_RECIPIENT_LENGTH,
  MESSAGE_DELIVERY_MAX_SOURCE_LENGTH,
  listMessageDeliveriesRequestSchema,
  messageDeliveryCountsRequestSchema,
  messageDeliveryDetailRequestSchema,
  retryMessageDeliveryRequestSchema,
  type EmailMessageIntentState,
  type MessageDeliveryAttemptRow,
  type MessageDeliveryCounts,
  type MessageDeliveryIntentRow,
} from "@packscout/contracts";
import type {
  EmailMessageAttemptRecord,
  EmailMessageIntentCounts,
  EmailMessageIntentCursor,
  EmailMessageIntentPage,
  EmailMessageIntentRecord,
} from "@packscout/database";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession, getAuthenticatedActor } from "../auth/middleware.ts";
import type {
  MessageDeliveryAuditOutcome,
  MessageDeliveryAuditSink,
} from "../message-delivery-audit.ts";

/**
 * The admin's message-delivery surface: the searchable history of what the
 * durable outbox was asked to send, to whom, when, through which provider,
 * and what happened — plus the one operational affordance the queue cannot
 * decide for itself, retrying a terminally failed intent once a human has
 * fixed the cause.
 *
 * Reads are guarded by `message_delivery:view` and the retry by
 * `message_delivery:manage`, both administrator-only. Every operation is a
 * POST because recipient addresses are personal data: carrying them in
 * request bodies keeps them out of URLs, browser history, referrers, and
 * access logs. Reads perform no mutation, so the same-origin guard — not a
 * CSRF token — keeps them same-site; the retry is a state change and
 * additionally requires the token.
 *
 * Message bodies are unreachable by construction: the queue's read model
 * never exposes the stored rendering input, and every response here is an
 * explicit field-by-field projection with no field a body could ride in.
 */

/** The queue read model plus the requeue affordance, as the routes need it. */
export interface MessageDeliveryQueue {
  countIntents(input: { now: Date }): Promise<EmailMessageIntentCounts>;
  listIntents(input: {
    readonly limit: number;
    readonly state?: EmailMessageIntentState;
    readonly kind?: string;
    readonly recipient?: string;
    readonly before?: EmailMessageIntentCursor;
  }): Promise<EmailMessageIntentPage>;
  getIntent(intentId: string): Promise<EmailMessageIntentRecord | null>;
  listAttempts(intentId: string): Promise<readonly EmailMessageAttemptRecord[]>;
  requeueTerminalIntent(input: {
    intentId: string;
    now: Date;
  }): Promise<EmailMessageIntentRecord | null>;
}

/**
 * A retry recording that did not happen. The requeue itself may already have
 * committed, so this can never alter what the browser is told; it names the
 * gap in the trail with non-personal values so an operator can find it.
 */
export interface MessageDeliveryAuditFailure {
  readonly outcome: MessageDeliveryAuditOutcome;
  /** True when the requeue had already committed to the queue. */
  readonly afterCommit: boolean;
}

export interface MessagesRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly queue: MessageDeliveryQueue;
  readonly audit: MessageDeliveryAuditSink;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
  readonly clock?: { now(): Date };
  /** Where an unwritable audit record is reported. Defaults to the error log. */
  readonly onAuditFailure?: (failure: MessageDeliveryAuditFailure) => void;
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: "message_delivery";
  readonly value: string;
  readonly id: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class InvalidMessageDeliveryCursorError extends Error {}

function encodeCursor(record: EmailMessageIntentRecord): string {
  const payload: CursorPayload = {
    version: 1,
    kind: "message_delivery",
    value: record.createdAt.toISOString(),
    id: record.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
): EmailMessageIntentCursor | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > MESSAGE_DELIVERY_MAX_CURSOR_LENGTH) {
    throw new InvalidMessageDeliveryCursorError();
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== "message_delivery" ||
      typeof parsed.value !== "string" ||
      !Number.isFinite(Date.parse(parsed.value)) ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: new Date(parsed.value), id: parsed.id };
  } catch {
    throw new InvalidMessageDeliveryCursorError();
  }
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedOrNull(value: string | null, maximum: number): string | null {
  return value === null ? null : bounded(value, maximum);
}

/**
 * Explicit field-by-field projection of one intent. There is deliberately no
 * spread here: nothing the queue row happens to carry — above all the stored
 * rendering input — can ride along to the browser.
 */
function toIntentRow(record: EmailMessageIntentRecord): MessageDeliveryIntentRow {
  return {
    intentId: record.id,
    kind: bounded(record.kind, MESSAGE_DELIVERY_MAX_KIND_LENGTH),
    recipient: bounded(record.recipient, MESSAGE_DELIVERY_MAX_RECIPIENT_LENGTH),
    source: bounded(record.source, MESSAGE_DELIVERY_MAX_SOURCE_LENGTH),
    state: record.state,
    attemptCount: record.attemptCount,
    createdAt: record.createdAt.toISOString(),
    dueAt: record.dueAt.toISOString(),
    lastAttemptedAt: record.lastAttemptedAt?.toISOString() ?? null,
    lastProvider: boundedOrNull(
      record.lastProvider,
      MESSAGE_DELIVERY_MAX_PROVIDER_LENGTH,
    ),
    lastErrorCode: boundedOrNull(
      record.lastErrorCode,
      MESSAGE_DELIVERY_MAX_ERROR_CODE_LENGTH,
    ),
    lastSkipReason: record.lastSkipReason,
    finalizedAt: record.finalizedAt?.toISOString() ?? null,
  };
}

/** The same explicit projection for one attempt. */
function toAttemptRow(record: EmailMessageAttemptRecord): MessageDeliveryAttemptRow {
  return {
    attemptNumber: record.attemptNumber,
    attemptedAt: record.attemptedAt.toISOString(),
    outcome: record.outcome,
    provider: boundedOrNull(record.provider, MESSAGE_DELIVERY_MAX_PROVIDER_LENGTH),
    providerMessageId: boundedOrNull(
      record.providerMessageId,
      MESSAGE_DELIVERY_MAX_PROVIDER_MESSAGE_ID_LENGTH,
    ),
    errorCode: boundedOrNull(
      record.errorCode,
      MESSAGE_DELIVERY_MAX_ERROR_CODE_LENGTH,
    ),
    errorMessage: boundedOrNull(
      record.errorMessage,
      MESSAGE_DELIVERY_MAX_ERROR_MESSAGE_LENGTH,
    ),
    skipReason: record.skipReason,
  };
}

function toCounts(counts: EmailMessageIntentCounts): MessageDeliveryCounts {
  return {
    pending: counts.pending,
    retrying: counts.retrying,
    due: counts.due,
    claimed: counts.claimed,
    failed: counts.failed,
    sent: counts.sent,
    skipped: counts.skipped,
    oldestDueAt: counts.oldestDueAt?.toISOString() ?? null,
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the message-delivery request and try again.",
    code: "INVALID_MESSAGE_DELIVERY_REQUEST",
    details,
  });
}

/**
 * Every failure resolves to a stable code with fixed copy. No database error,
 * connection string, or backend exception detail is ever restated to the
 * browser, and no failure path names a recipient.
 */
function failure(response: Response, error: unknown): void {
  if (error instanceof InvalidMessageDeliveryCursorError) {
    response.status(422).json({
      error: "This listing position is no longer valid. Return to the first page.",
      code: "INVALID_MESSAGE_DELIVERY_CURSOR",
    });
    return;
  }
  response.status(503).json({
    error: "The message delivery records are temporarily unavailable.",
    code: "MESSAGE_DELIVERY_UNAVAILABLE",
  });
}

function notFound(response: Response): void {
  response.status(404).json({
    error: "This delivery record no longer exists.",
    code: "MESSAGE_DELIVERY_INTENT_NOT_FOUND",
  });
}

/**
 * Fixed, state-specific copy for a refused retry. The state vocabulary is
 * closed, so restating the word is safe; nothing else about the intent is.
 */
const retryRefusals: Record<Exclude<EmailMessageIntentState, "failed">, string> = {
  pending:
    "This message is already queued for delivery, so there is nothing to retry.",
  retrying:
    "This message is already being retried by the queue, so there is nothing to retry.",
  sent: "This message was already delivered, so it cannot be retried.",
  skipped:
    "This message was skipped rather than failed, so there is nothing to retry.",
};

/**
 * The default report for an audit write that failed: one bounded line naming
 * the gap, and nothing about the message or the person it concerned.
 */
function logAuditFailure(auditFailure: MessageDeliveryAuditFailure): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "message_delivery_audit_write_failed",
      outcome: auditFailure.outcome,
      afterCommit: auditFailure.afterCommit,
    }),
  );
}

export function createMessagesRouter(dependencies: MessagesRouterDependencies) {
  const router = Router();
  const clock = dependencies.clock ?? { now: () => new Date() };
  const reportAuditFailure = dependencies.onAuditFailure ?? logAuditFailure;
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "message_delivery:view",
  });
  const manage = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { csrf: true, permission: "message_delivery:manage" },
  );

  /**
   * Records one retry attempt on the trail without letting the recording
   * decide the outcome: a requeue that committed is reported to the browser
   * as committed whatever the trail manages to write.
   */
  async function record(
    response: Response,
    intent: { intentId: string; recipient: string | null; kind: string | null },
    outcome: MessageDeliveryAuditOutcome,
    afterCommit: boolean,
    reason?: string,
  ): Promise<void> {
    const actor = getAuthenticatedActor(response);
    try {
      await dependencies.audit.append({
        organizationId: actor.organizationId,
        actorId: actor.operatorId,
        action: "message_delivery.retry",
        intentId: intent.intentId,
        recipient: intent.recipient,
        kind: intent.kind,
        outcome,
        occurredAt: clock.now(),
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      try {
        reportAuditFailure({ outcome, afterCommit });
      } catch {
        // Reporting the gap must not become a third failure domain.
      }
    }
  }

  router.post("/list", dependencies.sameOrigin, read, async (request, response) => {
    const body = listMessageDeliveriesRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    try {
      const before = decodeCursor(body.data.cursor);
      const page = await dependencies.queue.listIntents({
        limit: body.data.limit,
        ...(body.data.state ? { state: body.data.state } : {}),
        ...(body.data.kind ? { kind: body.data.kind } : {}),
        ...(body.data.recipient ? { recipient: body.data.recipient } : {}),
        ...(before ? { before } : {}),
      });
      const last = page.items.at(-1);
      // Recipient addresses must not be stored by any intermediary or cache.
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: page.items.slice(0, body.data.limit).map(toIntentRow),
        nextCursor: page.hasMore && last ? encodeCursor(last) : null,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.post("/counts", dependencies.sameOrigin, read, async (request, response) => {
    const body = messageDeliveryCountsRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    try {
      const counts = await dependencies.queue.countIntents({ now: clock.now() });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json(toCounts(counts));
    } catch (error) {
      failure(response, error);
    }
  });

  router.post("/detail", dependencies.sameOrigin, read, async (request, response) => {
    const body = messageDeliveryDetailRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    try {
      const intent = await dependencies.queue.getIntent(body.data.intentId);
      if (intent === null) return notFound(response);
      const attempts = await dependencies.queue.listAttempts(body.data.intentId);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        intent: toIntentRow(intent),
        attempts: attempts.map(toAttemptRow),
      });
    } catch (error) {
      failure(response, error);
    }
  });

  /**
   * Retries one terminally failed intent by re-entering it into the normal
   * queue — the background drain delivers it; nothing is sent inline. The
   * transition is the queue's guarded single UPDATE, so concurrent retries
   * converge on one and any non-terminal-failed state is refused.
   */
  router.post("/retry", dependencies.sameOrigin, manage, async (request, response) => {
    const body = retryMessageDeliveryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    const intentId = body.data.intentId;

    let requeued: EmailMessageIntentRecord | null;
    try {
      requeued = await dependencies.queue.requeueTerminalIntent({
        intentId,
        now: clock.now(),
      });
    } catch (error) {
      // Nothing committed: the attempt to re-mail a person is still recorded
      // before the failure is reported.
      await record(
        response,
        { intentId, recipient: null, kind: null },
        "failure",
        false,
        "MESSAGE_DELIVERY_UNAVAILABLE",
      );
      failure(response, error);
      return;
    }

    if (requeued !== null) {
      await record(
        response,
        { intentId, recipient: requeued.recipient, kind: requeued.kind },
        "success",
        true,
      );
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({ intent: toIntentRow(requeued) });
      return;
    }

    // The queue refused: the intent is gone, or it is not terminally failed —
    // possibly because a concurrent retry just requeued it. Either way the
    // refusal is explicit, recorded, and changes nothing.
    let current: EmailMessageIntentRecord | null;
    try {
      current = await dependencies.queue.getIntent(intentId);
    } catch (error) {
      await record(
        response,
        { intentId, recipient: null, kind: null },
        "failure",
        false,
        "MESSAGE_DELIVERY_UNAVAILABLE",
      );
      failure(response, error);
      return;
    }
    if (current === null) {
      await record(
        response,
        { intentId, recipient: null, kind: null },
        "failure",
        false,
        "MESSAGE_DELIVERY_INTENT_NOT_FOUND",
      );
      notFound(response);
      return;
    }
    await record(
      response,
      { intentId, recipient: current.recipient, kind: current.kind },
      "failure",
      false,
      "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL",
    );
    response.status(409).json({
      error:
        current.state === "failed"
          ? "This message could not be retried. Reload and try again."
          : retryRefusals[current.state],
      code: "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL",
      state: current.state,
    });
  });

  return router;
}
