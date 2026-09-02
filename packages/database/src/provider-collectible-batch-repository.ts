import { randomUUID } from "node:crypto";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { ProviderCanonicalInputError, ProviderCanonicalWriteConflictError } from "./provider-canonical-contract.ts";
import { normalizeProviderCollectibleWrite, planProviderCollectibleWrite } from "./provider-canonical-collectible-write.ts";
import { appendPromotionRange } from "./provider-canonical-repository.ts";
import { collectibleCandidate, ProviderMixedCandidateError } from "./provider-mixed-page-candidates.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";

export const PROVIDER_COLLECTIBLE_BATCH_SIZE = 100;

export function isProviderCollectibleUpsert(record: ProviderMixedPageRecord): boolean {
  return record.kind === "catalog" && record.entityType === "collectible"
    && record.operation === "upsert" && record.disposition === undefined;
}

type CollectibleData = ReturnType<typeof normalizeProviderCollectibleWrite>["data"];
interface ChangedCollectible {
  readonly id: string;
  readonly key: string;
  readonly version: bigint;
  readonly data: CollectibleData;
  readonly create: boolean;
}

async function updateCollectibles(transaction: ProviderTransactionClient, rows: readonly ChangedCollectible[]) {
  if (rows.length === 0) return;
  const payload = JSON.stringify(rows.map(row => ({ ...row.data, id: row.id, row_version: row.version.toString() })));
  // Static identifiers and a bound JSON value retain PostgreSQL's native column
  // types and triggers. Every row must match the prefetched active version.
  const updated = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE collectibles AS current SET
      category_id = incoming.category_id, collectible_type = incoming.collectible_type,
      display_name = incoming.display_name, normalized_name = incoming.normalized_name,
      year = incoming.year, brand = incoming.brand, set_or_series = incoming.set_or_series,
      card_number = incoming.card_number, reference_number = incoming.reference_number,
      subject = incoming.subject, grade = incoming.grade, grader = incoming.grader,
      primary_image_url = incoming.primary_image_url, primary_image_alt = incoming.primary_image_alt,
      valuation_amount = incoming.valuation_amount, valuation_currency = incoming.valuation_currency,
      valuation_usd_amount = incoming.valuation_usd_amount,
      valuation_unavailable_reason = incoming.valuation_unavailable_reason,
      valuation_type = incoming.valuation_type, valuation_observed_at = incoming.valuation_observed_at,
      data_as_of = incoming.data_as_of, attributes = incoming.attributes, row_version = incoming.row_version
    FROM jsonb_populate_recordset(NULL::collectibles, CAST(${payload} AS jsonb)) AS incoming
    WHERE current.id = incoming.id AND current.lifecycle = 'active'
      AND current.row_version = incoming.row_version - 1
    RETURNING current.id
  `);
  const ids = new Set(updated.map(row => row.id));
  if (updated.length !== rows.length || ids.size !== rows.length || rows.some(row => !ids.has(row.id))) {
    throw new ProviderCanonicalWriteConflictError();
  }
}

/** Existing fenced mixed-page transaction + caller-owned chunk savepoint only. */
export async function applyProviderCollectibleBatch(transaction: ProviderTransactionClient,
  records: readonly ProviderMixedPageRecord[]): Promise<readonly boolean[] | null> {
  if (records.length === 0 || records.length > PROVIDER_COLLECTIBLE_BATCH_SIZE
    || records.some(record => !isProviderCollectibleUpsert(record))) {
    throw new ProviderCanonicalInputError("The collectible batch is outside its bounded contract.");
  }
  const prepared = records.map(record => {
    const categoryKey = record.candidate.categoryKey;
    if (categoryKey !== null && typeof categoryKey !== "string") throw new ProviderMixedCandidateError("categoryKey");
    const input = collectibleCandidate(record.candidate, null);
    return { input, categoryKey, ...normalizeProviderCollectibleWrite(input) };
  });
  const keys = prepared.map(row => row.collectibleKey);
  // Repeated keys can depend on preceding writes, versions and failures. Keep
  // their original record-by-record behavior instead of caching an overlay.
  if (new Set(keys).size !== keys.length) return null;
  const categoryKeys = [...new Set(prepared.flatMap(row => row.categoryKey === null ? [] : [row.categoryKey]))];
  const categories = categoryKeys.length === 0 ? [] : await transaction.categories.findMany({
    where: { category_key: { in: categoryKeys } }, select: { id: true, category_key: true, lifecycle: true }, take: categoryKeys.length,
  });
  const byCategory = new Map(categories.map(row => [row.category_key, row]));
  const existing = await transaction.collectibles.findMany({ where: { collectible_key: { in: keys } }, take: keys.length });
  const byKey = new Map(existing.map(row => [row.collectible_key, row]));
  const changes: ChangedCollectible[] = [];
  const outcomes = prepared.map(row => {
    const category = row.categoryKey === null ? null : byCategory.get(row.categoryKey);
    if (row.categoryKey !== null && category?.lifecycle !== "active") throw new ProviderMixedCandidateError("categoryKey");
    const data = { ...row.data, category_id: category?.id ?? null };
    const decision = planProviderCollectibleWrite(row.input.expectedRowVersion, byKey.get(row.collectibleKey) ?? null, data);
    if (decision.kind === "unchanged") return false;
    changes.push({ id: decision.kind === "create" ? randomUUID() : decision.current.id,
      key: row.collectibleKey, version: decision.kind === "create" ? 1n : decision.current.row_version + 1n,
      data, create: decision.kind === "create" });
    return true;
  });
  const creates = changes.filter(row => row.create);
  if (creates.length > 0) await transaction.collectibles.createMany({
    data: creates.map(row => ({ id: row.id, collectible_key: row.key, ...row.data })),
  });
  await updateCollectibles(transaction, changes.filter(row => !row.create));
  if (changes.length > 0) await appendPromotionRange(transaction, changes.map(row => ({
    entityType: "collectible", entityId: row.id, entityVersion: row.version, operation: "upsert",
  })));
  return outcomes;
}
