import { and, eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { auditEvents, importPages } from "./schema/index.ts";

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

export class ProtectedEvidenceRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async getRawPage(
    access: RawEvidenceAccessContext,
    pageId: string,
    accessedAt: Date,
  ): Promise<ProtectedRawPage | null> {
    return this.database.transaction(async (transaction) => {
      const [page] = await transaction
        .select({
          pageId: importPages.id,
          runId: importPages.runId,
          payload: importPages.payloadJson,
          payloadHash: importPages.payloadHash,
          expiresAt: importPages.expiresAt,
          payloadExpiredAt: importPages.payloadExpiredAt,
        })
        .from(importPages)
        .where(
          and(
            eq(importPages.id, pageId),
            eq(importPages.organizationId, access.organizationId),
          ),
        )
        .limit(1);
      if (!page) return null;
      await transaction.insert(auditEvents).values({
        organizationId: access.organizationId,
        actorKey: access.actorKey,
        action: "raw_evidence.read",
        subjectType: "import_page",
        subjectId: page.pageId,
        outcome: "success",
        metadataJson: { purpose: access.purpose },
        occurredAt: accessedAt,
      });
      return page;
    });
  }
}
