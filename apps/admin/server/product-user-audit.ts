import { PrismaAuthAuditSink } from "@packscout/database";
import type { ProductUserStanding } from "@packscout/contracts";
import { createRecordReferencer } from "./auth/actor-key.ts";

/**
 * The audit trail for product-user account control.
 *
 * Suspension and reinstatement are the only administrator actions that change
 * a product user's account, so every attempt at one is recorded on the admin's
 * existing `audit_events` trail, in the same shape its operator actions use:
 * the acting operator, the target, the action, the outcome, and when.
 *
 * The target is written as a pseudonymous reference rather than the subject
 * key itself. The subject key is issuer-qualified personal data, and the audit
 * trail is durable operational history — the same reasoning that keeps
 * operator identifiers out of durable pipeline history. Keying it through the
 * workspace secret keeps the trail correlatable without carrying the identity.
 */

/** The Prisma client shape this sink needs, taken from the existing sink. */
type ProductUserAuditDatabase = ConstructorParameters<
  typeof PrismaAuthAuditSink
>[0];

export type ProductUserAuditAction =
  | "product_user.suspend"
  | "product_user.reinstate";

export type ProductUserAuditOutcome = "success" | "failure" | "blocked";

export interface ProductUserAuditEvent {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: ProductUserAuditAction;
  /** The target's directory subject key. Pseudonymized before it is stored. */
  readonly subject: string;
  readonly outcome: ProductUserAuditOutcome;
  readonly occurredAt: Date;
  /** The standing the directory reports afterwards, when it is known. */
  readonly standing?: ProductUserStanding;
  /** A short, non-personal code describing why an attempt did not succeed. */
  readonly reason?: string;
}

export interface ProductUserAuditSink {
  append(event: ProductUserAuditEvent): Promise<void>;
}

/**
 * The action a target standing represents. The request names a standing rather
 * than an operation, so the audit trail names the operation instead: an
 * operator reading history should see "suspend", not "set standing".
 */
export function productUserAuditAction(
  standing: ProductUserStanding,
): ProductUserAuditAction {
  return standing === "suspended"
    ? "product_user.suspend"
    : "product_user.reinstate";
}

/**
 * The durable sink. Metadata is assembled field by field from a closed set of
 * non-personal values, so nothing an upstream response happens to carry can
 * ride along into the trail.
 */
export function createProductUserAuditSink(input: {
  readonly database: ProductUserAuditDatabase;
  readonly actorPseudonymKey: Uint8Array;
}): ProductUserAuditSink {
  const reference = createRecordReferencer(
    input.actorPseudonymKey,
    "product-user",
  );
  return {
    async append(event) {
      await input.database.audit_events.create({
        data: {
          organization_id: event.organizationId,
          actor_key: event.actorId ?? "anonymous",
          action: event.action,
          subject_type: "product_user",
          // The column holds workspace UUIDs; a hosted-provider subject key is
          // not one, so the pseudonymous reference travels in metadata.
          subject_id: null,
          outcome: event.outcome,
          metadata_json: {
            reference: reference([event.subject]),
            ...(event.standing === undefined ? {} : { standing: event.standing }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          },
          occurred_at: event.occurredAt,
        },
      });
    },
  };
}
