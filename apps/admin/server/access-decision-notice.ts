import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProductUserAccessDecision } from "@packscout/contracts";
import type {
  AccessApprovedMessageInput,
  AccessDeclinedMessageInput,
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "@packscout/services";
import {
  ProductUserDirectoryError,
  type ProductUserDirectoryReader,
} from "./product-user-directory.ts";

/**
 * The beta access-decision notice (messaging/006): once an administrator's
 * approve or decline has committed, the matching catalogue message is
 * enqueued through the durable outbox (messaging/004) so the person finds
 * out they are in — or that access is not available — without keeping the
 * waiting page open. The outbox stores the kind and its rendering input;
 * the drain renders (messaging/003) and delivers.
 *
 * The decision is authoritative and this notice never is: every outcome
 * here — enqueued, skipped, failed — is an explicit result the decision
 * route records and reports, never an exception that could fail a committed
 * decision. Three decision shapes deliberately message nothing:
 *
 * - A revoke. That is an enforcement action, not an announcement.
 * - A repeat or concurrent decision that changed nothing. The person was
 *   told when the decision genuinely moved; convergence is silence.
 * - An allowlist admission. It happens at sign-in inside the product
 *   backend and never passes through the admin's decision path at all;
 *   its greeting is the welcome (messaging/007).
 *
 * The recipient is the verified address on the directory record, read
 * through the single-record integration read after the decision commits.
 * A wallet-only identity exposing no address is a normal, recorded skip —
 * never a failure of the administrator's decision. The address travels
 * only into the delivery queue, which needs it; nothing here logs it,
 * returns it, or lets it into an idempotency key or audit record.
 */

/** The outbox source these enqueues count against, for the volume bound. */
export const ACCESS_DECISION_MESSAGE_SOURCE = "beta_access_decision";

/**
 * The catalogue kind for each resulting state that announces itself. The
 * kind follows the state the backend now authoritatively holds — not the
 * operator's request — so the message can never disagree with the record.
 * A revoke results in awaiting review, which has no kind and sends nothing.
 */
export const ACCESS_DECISION_MESSAGE_KINDS = Object.freeze({
  approved: "access_approved",
  declined: "access_declined",
} as const);

type NoticeableAccessState = keyof typeof ACCESS_DECISION_MESSAGE_KINDS;

function noticeableState(state: string): NoticeableAccessState | null {
  return state === "approved" || state === "declined" ? state : null;
}

/**
 * The idempotency key for one genuine decision transition: subject digest,
 * resulting state, and the decision instant of this transition. Repeats and
 * concurrent arrivals of the same transition converge on one intent, while
 * a genuine re-transition (approve, revoke, approve again) carries a fresh
 * `decidedAt` and therefore earns its own message. The subject is hashed
 * because raw subjects carry characters and lengths the outbox key alphabet
 * excludes, and because the key travels into delivery records and logs the
 * identity should not.
 */
export function accessDecisionNoticeIdempotencyKey(
  subject: string,
  resultingState: NoticeableAccessState,
  decidedAtEpochMilliseconds: number,
): string {
  const digest = createHash("sha256").update(subject, "utf8").digest("hex");
  return `accessdecision:${digest}:${resultingState}:${decidedAtEpochMilliseconds}`;
}

/**
 * Mirrors the outbox recipient bound exactly, so an address this validation
 * accepts never bounces off enqueue validation as a surprise, and one it
 * refuses is the recorded no-address skip rather than a failure that would
 * be retried against a validation that will never change its mind.
 */
const usableRecipientSchema = z.string().trim().max(320).email();

/** The single-record integration read, taken after the decision commits. */
export type AccessDecisionNoticeDirectoryPort = Pick<
  ProductUserDirectoryReader,
  "getProductUserRecord"
>;

/** Structural subset of `EmailMessageOutboxService` the notice uses. */
export interface AccessDecisionNoticeOutboxPort {
  enqueueEmailMessage(
    command: EnqueueEmailMessageCommand,
  ): Promise<EnqueueEmailMessageResult>;
}

/** A committed decision, as the decision route learned it. */
export interface AccessDecisionNoticeInput {
  readonly subject: string;
  /** False when the record already held the target decision. */
  readonly changed: boolean;
  /** The decision the backend now authoritatively holds. */
  readonly resulting: ProductUserAccessDecision;
}

export type AccessDecisionNoticeResult =
  /** Nothing to announce: a revoke, or a decision that changed nothing. */
  | { readonly outcome: "not_applicable" }
  | {
      readonly outcome: "enqueued";
      /** True when this transition's intent already existed. */
      readonly deduplicated: boolean;
    }
  /** No verified address on the record: a normal, permanent skip. */
  | { readonly outcome: "skipped_no_verified_email" }
  | {
      readonly outcome: "failed";
      /** A short, stable, non-personal code naming what failed. */
      readonly reason: string;
    };

export interface AccessDecisionNotifier {
  /**
   * Enqueues the message a committed decision earns, if any. Resolves to an
   * explicit result and never rejects: the decision this reports on has
   * already committed, so nothing here may look like a decision failure.
   */
  notifyAccessDecision(
    input: AccessDecisionNoticeInput,
  ): Promise<AccessDecisionNoticeResult>;
}

export interface AccessDecisionNotifierDependencies {
  readonly directory: AccessDecisionNoticeDirectoryPort;
  readonly outbox: AccessDecisionNoticeOutboxPort;
}

export function createAccessDecisionNotifier(
  dependencies: AccessDecisionNotifierDependencies,
): AccessDecisionNotifier {
  return {
    async notifyAccessDecision(input) {
      // Convergence is silence: a repeat or concurrent decision that moved
      // nothing announces nothing, and no directory read happens for it.
      if (!input.changed) return { outcome: "not_applicable" };
      const state = noticeableState(input.resulting.state);
      if (state === null) return { outcome: "not_applicable" };
      const decidedAtEpochMilliseconds = Date.parse(input.resulting.decidedAt);
      if (!Number.isFinite(decidedAtEpochMilliseconds)) {
        // The integration boundary validates decision instants, so this is
        // a caller bug; named without inventing a transition to key on.
        return { outcome: "failed", reason: "ACCESS_DECISION_TRANSITION_INVALID" };
      }

      // The verified address lives on the directory record, read only after
      // the decision has committed; the read is the established privileged
      // single-record integration read.
      let email: string | null;
      try {
        const record = await dependencies.directory.getProductUserRecord({
          subject: input.subject,
        });
        email = record.email;
      } catch (error) {
        return {
          outcome: "failed",
          reason:
            error instanceof ProductUserDirectoryError
              ? error.code
              : "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
        };
      }
      const recipient = usableRecipientSchema.safeParse(email ?? "");
      if (email === null || !recipient.success) {
        // A wallet-only identity has nowhere to be reached. Normal here,
        // recorded by the caller, and never an error: the person discovers
        // their new access the next time they visit.
        return { outcome: "skipped_no_verified_email" };
      }

      // The rendering input the drain will render; both access kinds take
      // exactly the recipient address (messaging/003).
      const renderingInput: AccessApprovedMessageInput | AccessDeclinedMessageInput =
        { toEmail: recipient.data };
      let result: EnqueueEmailMessageResult;
      try {
        result = await dependencies.outbox.enqueueEmailMessage({
          kind: ACCESS_DECISION_MESSAGE_KINDS[state],
          input: renderingInput,
          recipient: recipient.data,
          idempotencyKey: accessDecisionNoticeIdempotencyKey(
            input.subject,
            state,
            decidedAtEpochMilliseconds,
          ),
          source: ACCESS_DECISION_MESSAGE_SOURCE,
        });
      } catch {
        // The outbox service reports refusals as results rather than
        // throwing; anything thrown anyway is one bounded failure code.
        return { outcome: "failed", reason: "EMAIL_OUTBOX_UNAVAILABLE" };
      }
      if (result.status !== "enqueued") {
        // A backlog rejection or a validation refusal: the stable code is
        // the whole story the trail needs — no address, no upstream text.
        return { outcome: "failed", reason: result.errorCode };
      }
      return { outcome: "enqueued", deduplicated: result.deduplicated };
    },
  };
}
