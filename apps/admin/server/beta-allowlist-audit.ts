import { CentralAuthAuditSink } from "@packscout/database";
import { createRecordReferencer } from "./auth/actor-key.ts";

/**
 * The audit trail for beta-allowlist management.
 *
 * Adding, editing, and removing allowlist entries decide who enters the
 * closed beta, so every attempt at one is recorded on the admin's existing
 * `audit_events` trail, in the same shape its operator actions use: the
 * acting operator, the target, the action, the outcome, and when.
 *
 * The target identifiers — an email address, a wallet address — are personal
 * data, and the audit trail is durable operational history, so they are
 * written as a pseudonymous reference rather than verbatim: keyed through the
 * workspace secret, the trail stays correlatable ("the same identifier was
 * added, then removed") without carrying the identity. The entry id is an
 * opaque backend value, not personal data, and is recorded as the stable
 * target reference alongside it.
 */

/** The Prisma client shape this sink needs, taken from the existing sink. */
type BetaAllowlistAuditDatabase = ConstructorParameters<
  typeof CentralAuthAuditSink
>[0];

export type BetaAllowlistAuditAction =
  | "beta_allowlist.add"
  | "beta_allowlist.edit"
  | "beta_allowlist.remove";

export type BetaAllowlistAuditOutcome = "success" | "failure";

export interface BetaAllowlistAuditEvent {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: BetaAllowlistAuditAction;
  /** The entry acted on, when known. An opaque backend id, never personal. */
  readonly entryId: string | null;
  /** Identifiers the action concerned. Pseudonymized before storage. */
  readonly email: string | null;
  readonly walletAddress: string | null;
  readonly outcome: BetaAllowlistAuditOutcome;
  readonly occurredAt: Date;
  /** Waiting accounts the change admitted, when the backend reported it. */
  readonly admittedCount?: number;
  /** Whether a removal found an entry to remove, when it is known. */
  readonly removed?: boolean;
  /** A short, non-personal code describing why an attempt did not succeed. */
  readonly reason?: string;
}

export interface BetaAllowlistAuditSink {
  append(event: BetaAllowlistAuditEvent): Promise<void>;
}

/**
 * The durable sink. Metadata is assembled field by field from a closed set of
 * non-personal values, so nothing an upstream response happens to carry can
 * ride along into the trail.
 */
export function createBetaAllowlistAuditSink(input: {
  readonly database: BetaAllowlistAuditDatabase;
  readonly actorPseudonymKey: Uint8Array;
}): BetaAllowlistAuditSink {
  const reference = createRecordReferencer(
    input.actorPseudonymKey,
    "beta-allowlist",
  );
  return {
    async append(event) {
      const identified = event.email !== null || event.walletAddress !== null;
      await input.database.audit_events.create({
        data: {
          organization_id: event.organizationId,
          actor_key: event.actorId ?? "anonymous",
          action: event.action,
          subject_type: "beta_allowlist_entry",
          // The column holds workspace UUIDs; a product-backend entry id is
          // not one, so the entry reference travels in metadata.
          subject_id: null,
          outcome: event.outcome,
          metadata_json: {
            ...(identified
              ? {
                  reference: reference([
                    event.email ?? "",
                    event.walletAddress ?? "",
                  ]),
                }
              : {}),
            ...(event.entryId === null ? {} : { entryId: event.entryId }),
            ...(event.admittedCount === undefined
              ? {}
              : { admittedCount: event.admittedCount }),
            ...(event.removed === undefined ? {} : { removed: event.removed }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          },
          occurred_at: event.occurredAt,
        },
      });
    },
  };
}
