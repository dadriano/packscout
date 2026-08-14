import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
import type { PackscoutPrismaClient } from "./database.ts";
import { decodeDatabaseSafeProtectedJsonEvidence } from "./protected-json-evidence.ts";

export interface RawEvidenceAccessContext {
  organizationId: string;
  actorKey: string;
  purpose: "quarantine_review" | "provider_debug" | "replay";
}

export interface ProtectedRawPage {
  pageId: string;
  runId: string;
  payload: unknown | null;
  payloadHash: string;
  expiresAt: Date;
  payloadExpiredAt: Date | null;
}

export class ProtectedEvidenceRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async getRawPage(
    access: RawEvidenceAccessContext,
    pageId: string,
    accessedAt: Date,
  ): Promise<ProtectedRawPage | null> {
    return this.database.$transaction(async (transaction) => {
      const page = await transaction.import_pages.findFirst({
        where: { id: pageId, organization_id: access.organizationId },
        select: {
          id: true,
          run_id: true,
          payload_json: true,
          payload_hash: true,
          expires_at: true,
          payload_expired_at: true,
        },
      });
      if (!page) return null;
      await transaction.audit_events.create({
        data: {
          organization_id: access.organizationId,
          actor_key: access.actorKey,
          action: "raw_evidence.read",
          subject_type: "import_page",
          subject_id: page.id,
          outcome: "success",
          metadata_json: { purpose: access.purpose },
          occurred_at: accessedAt,
        },
      });
      return {
        pageId: page.id,
        runId: page.run_id,
        payload: decodeDatabaseSafeProtectedJsonEvidence(page.payload_json),
        payloadHash: page.payload_hash,
        expiresAt: page.expires_at,
        payloadExpiredAt: page.payload_expired_at,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
