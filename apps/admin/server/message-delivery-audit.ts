import { CentralAuthAuditSink } from "@packscout/database";
import { createRecordReferencer } from "./auth/actor-key.ts";

/**
 * The audit trail for message-delivery retries.
 *
 * Retrying a terminally failed message re-enters a real person's email into
 * the delivery queue, so every attempt at one — allowed or refused — is
 * recorded on the admin's existing `audit_events` trail in the same shape its
 * other operator actions use: the acting operator, the target intent, the
 * action, the outcome, and when.
 *
 * The recipient address is personal data and the audit trail is durable
 * operational history, so it is written as a pseudonymous reference keyed
 * through the workspace secret — the trail stays correlatable ("the same
 * recipient's messages were retried twice") without carrying the address.
 * The intent id is the queue's own opaque UUID and is the stable subject.
 */

/** The Prisma client shape this sink needs, taken from the existing sink. */
type MessageDeliveryAuditDatabase = ConstructorParameters<
  typeof CentralAuthAuditSink
>[0];

export type MessageDeliveryAuditAction = "message_delivery.retry";

export type MessageDeliveryAuditOutcome = "success" | "failure";

export interface MessageDeliveryAuditEvent {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: MessageDeliveryAuditAction;
  /** The queue intent acted on. An opaque queue UUID, never personal. */
  readonly intentId: string;
  /** The intent's recipient when known. Pseudonymized before storage. */
  readonly recipient: string | null;
  /** The intent's message kind when known. A catalogue identifier. */
  readonly kind: string | null;
  readonly outcome: MessageDeliveryAuditOutcome;
  readonly occurredAt: Date;
  /** A short, non-personal code describing why an attempt did not succeed. */
  readonly reason?: string;
}

export interface MessageDeliveryAuditSink {
  append(event: MessageDeliveryAuditEvent): Promise<void>;
}

/**
 * The durable sink. Metadata is assembled field by field from a closed set of
 * non-personal values, so no recipient address, message content, or backend
 * error detail can ride along into the trail.
 */
export function createMessageDeliveryAuditSink(input: {
  readonly database: MessageDeliveryAuditDatabase;
  readonly actorPseudonymKey: Uint8Array;
}): MessageDeliveryAuditSink {
  const reference = createRecordReferencer(
    input.actorPseudonymKey,
    "message-delivery",
  );
  return {
    async append(event) {
      await input.database.audit_events.create({
        data: {
          organization_id: event.organizationId,
          actor_key: event.actorId ?? "anonymous",
          action: event.action,
          subject_type: "email_message_intent",
          subject_id: event.intentId,
          outcome: event.outcome,
          metadata_json: {
            ...(event.recipient === null
              ? {}
              : { recipientReference: reference([event.recipient]) }),
            ...(event.kind === null ? {} : { kind: event.kind }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          },
          occurred_at: event.occurredAt,
        },
      });
    },
  };
}
