import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { buildProviderActivityOutboxRow } from "./provider-local-evidence.ts";
import { providerMixedRecordEntityKey } from "./provider-mixed-page-candidates.ts";
import {
  PROVIDER_MIXED_PAGE_MAX_QUARANTINES, PROVIDER_MIXED_PAGE_MAX_RECORDS,
  ProviderMixedPageContractError, type ProviderMixedPageRecord,
} from "./provider-mixed-page-contract.ts";

export const PROVIDER_QUARANTINE_INSERT_CHUNK_SIZE = 100;

export interface ProviderMixedPageQuarantineDraft {
  readonly id: string;
  readonly record: ProviderMixedPageRecord;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
}

export function sourceQuarantineDetails(record: ProviderMixedPageRecord) {
  if (record.sourceRecordKey === undefined || record.reasonCode === undefined
    || record.fieldPath === undefined || record.sanitizedSummary === undefined) {
    throw new ProviderMixedPageContractError("MIXED_PAGE_INVALID", "A source quarantine record is incomplete.");
  }
  return { sourceRecordKey: record.sourceRecordKey, reasonCode: record.reasonCode,
    fieldPath: record.fieldPath, sanitizedSummary: record.sanitizedSummary };
}

/** Called only inside the fenced page transaction, after provider/run/cursor checks. */
export async function readExistingSourceQuarantineKeys(
  transaction: ProviderTransactionClient, records: readonly ProviderMixedPageRecord[],
): Promise<Set<string>> {
  if (records.length > PROVIDER_MIXED_PAGE_MAX_RECORDS) {
    throw new ProviderMixedPageContractError("MIXED_PAGE_OVERSIZED", "The provider mixed page exceeds its record limit.");
  }
  const keys = [...new Set(records.filter(record => record.disposition === "quarantine")
    .map(record => sourceQuarantineDetails(record).sourceRecordKey))];
  if (keys.length === 0) return new Set();
  // The key is unique within this identity-checked provider database. Neither
  // earlier records nor retries can turn a duplicate into a new quarantine.
  const rows = await transaction.quarantine_records.findMany({
    where: { source_record_key: { in: keys } }, take: keys.length,
    select: { source_record_key: true },
  });
  return new Set(rows.flatMap(row => row.source_record_key === null ? [] : [row.source_record_key]));
}

function quarantineRows(draft: ProviderMixedPageQuarantineDraft,
  page: { runId: string; pageId: string; contractVersion: string }, committedAt: Date) {
  const source = draft.record.disposition === "quarantine" ? sourceQuarantineDetails(draft.record) : null;
  const row: Prisma.quarantine_recordsCreateManyInput = {
    id: draft.id, provider_run_id: page.runId, provider_run_page_id: page.pageId,
    record_index: draft.record.position, record_kind: draft.record.kind,
    entity_key: providerMixedRecordEntityKey(draft.record), source_record_key: source?.sourceRecordKey ?? null,
    external_id: null, reason_code: draft.reasonCode, field_path: draft.fieldPath,
    sanitized_summary: source?.sanitizedSummary
      ?? "The normalized candidate could not be committed to the provider catalog.",
    candidate_schema_version: page.contractVersion,
    normalized_candidate: source ? Prisma.DbNull : draft.record.candidate as Prisma.InputJsonObject,
    protected_evidence: Prisma.DbNull, created_at: committedAt, updated_at: committedAt,
    ...(source ? { evidence_expires_at: committedAt, evidence_expired_at: committedAt, state: "expired" as const } : {}),
  };
  const activity = buildProviderActivityOutboxRow({
    eventType: source ? "provider.quarantine.expired" : "provider.quarantine.opened", severity: "warning",
    dedupeKey: `quarantine:${draft.id}:${source ? "expired" : "open"}`, recoveryKey: `quarantine:${draft.id}`,
    localRunId: page.runId, localQuarantineId: draft.id,
    title: source ? "Provider source record rejected" : "Provider record quarantined",
    summary: source
      ? "A source record was rejected before canonical persistence and has no retained retry artifact."
      : "A normalized provider record requires operator review before retry.",
    evidence: { quarantineState: source ? "expired" : "open" }, eventAt: committedAt,
  });
  return { row, activity };
}

export async function persistProviderMixedPageQuarantines(transaction: ProviderTransactionClient,
  drafts: readonly ProviderMixedPageQuarantineDraft[],
  page: { runId: string; pageId: string; contractVersion: string }, committedAt: Date): Promise<void> {
  if (drafts.length > PROVIDER_MIXED_PAGE_MAX_QUARANTINES) {
    throw new ProviderMixedPageContractError("MIXED_PAGE_OVERSIZED", "The provider mixed page exceeds its quarantine limit.");
  }
  // Validate all evidence before inserting anything. UUIDs preserve the ordered
  // receipt mapping; each outbox batch follows its referenced quarantine rows.
  const rows = drafts.map(draft => quarantineRows(draft, page, committedAt));
  for (let offset = 0; offset < rows.length; offset += PROVIDER_QUARANTINE_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + PROVIDER_QUARANTINE_INSERT_CHUNK_SIZE);
    await transaction.quarantine_records.createMany({ data: chunk.map(entry => entry.row) });
    await transaction.provider_activity_outbox.createMany({ data: chunk.map(entry => entry.activity) });
  }
}
