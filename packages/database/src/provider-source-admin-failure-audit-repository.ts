import type {
  ProviderSourceAdminAuditReceipt,
  ProviderSourceAdminErrorCode,
} from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";

export interface ProviderSourceAdminFailureAuditInput {
  readonly organizationId: string;
  readonly actorKey: string;
  readonly action: ProviderSourceAdminAuditReceipt["action"];
  readonly subjectType: ProviderSourceAdminAuditReceipt["subjectType"];
  readonly subjectId: string | null;
  readonly revisionId: string | null;
  readonly safeCode: ProviderSourceAdminErrorCode;
}

/**
 * Records only failures reached after route authentication and strict parsing.
 * Auth, CSRF, permission, and malformed-boundary failures remain owned by the
 * central HTTP security layer and never receive a fabricated domain receipt.
 */
export class ProviderSourceAdminFailureAuditRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async recordFailure(
    input: ProviderSourceAdminFailureAuditInput,
  ): Promise<ProviderSourceAdminAuditReceipt> {
    return this.database.$transaction(async (transaction) => {
      const occurredAt = await providerSourceTransactionTime(transaction);
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: input.action,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          outcome: "failure",
          metadata_json: {
            revisionId: input.revisionId,
            safeCode: input.safeCode,
          },
          occurred_at: occurredAt,
        },
      });
      return Object.freeze({
        actor: "current_operator" as const,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        revisionId: input.revisionId,
        outcome: "failure" as const,
        safeCode: input.safeCode,
        occurredAt: occurredAt.toISOString(),
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
