import { PrismaAuthAuditSink } from "@packscout/database";
import type {
  ProductUserAccessAction,
  ProductUserAccessDecider,
  ProductUserAccessState,
  ProductUserStanding,
} from "@packscout/contracts";
import { createRecordReferencer } from "./auth/actor-key.ts";

/**
 * The audit trail for product-user account control.
 *
 * The administrator actions that change a product user's account — the
 * standing flip, and the three closed-beta access decisions — are each
 * recorded on the admin's existing `audit_events` trail, in the same shape its
 * operator actions use: the acting operator, the target, the action, the
 * outcome, and when. Access decisions additionally record the previous and
 * resulting decision with its provenance, so the trail shows what each
 * decision displaced, never just what it produced.
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
  | "product_user.reinstate"
  | "product_user.approve_access"
  | "product_user.decline_access"
  | "product_user.revoke_access";

export type ProductUserAuditOutcome = "success" | "failure" | "blocked";

/**
 * A decision as the trail records it: state and provenance kind, both from
 * closed non-personal vocabularies. The stored decision's operator and
 * allowlist references stay out — the acting operator is already the event's
 * actor, and a displaced decision's author is not this event's business.
 */
export interface ProductUserAuditDecision {
  readonly state: ProductUserAccessState;
  readonly decidedBy: ProductUserAccessDecider;
}

/** What an access decision displaced and produced, for the trail. */
export interface ProductUserAuditAccessChange {
  readonly previous: ProductUserAuditDecision;
  readonly resulting: ProductUserAuditDecision;
  /** False when the record already held the target decision. */
  readonly changed: boolean;
}

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
  /** The access decision movement, when the action was an access decision. */
  readonly accessChange?: ProductUserAuditAccessChange;
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

/** The trail's name for each access decision operation. */
export function productUserAccessAuditAction(
  action: ProductUserAccessAction,
): ProductUserAuditAction {
  switch (action) {
    case "approve":
      return "product_user.approve_access";
    case "decline":
      return "product_user.decline_access";
    case "revoke":
      return "product_user.revoke_access";
  }
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
            ...(event.accessChange === undefined
              ? {}
              : {
                  previousAccess: event.accessChange.previous.state,
                  previousDecidedBy: event.accessChange.previous.decidedBy,
                  resultingAccess: event.accessChange.resulting.state,
                  resultingDecidedBy: event.accessChange.resulting.decidedBy,
                  changed: event.accessChange.changed,
                }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          },
          occurred_at: event.occurredAt,
        },
      });
    },
  };
}
