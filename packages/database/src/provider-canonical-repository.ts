import { randomUUID } from "node:crypto";
import { providerPackEvEvidenceV1Schema } from "@packscout/contracts";
import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderQueryClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  confidenceBand,
  normalizeEvidenceKinds,
  normalizeJsonObject,
  normalizeMoneyDecimal,
  normalizeRateDecimal,
  ProviderCanonicalImmutableFactConflictError,
  ProviderCanonicalInputError,
  ProviderCanonicalRetiredError,
  ProviderCanonicalWriteConflictError,
  requireAccountKey,
  requireCurrency,
  requireDate,
  requireDigest,
  requireNonEmptyText,
  requirePairedValues,
  type CanonicalJsonObject,
  type CanonicalWriteResult,
  type CategoryWriteInput,
  type CollectibleInstanceWriteInput,
  type CollectibleNameAliasWriteInput,
  type CollectibleWriteInput,
  type FactReferenceReconciliationResult,
  type ProviderFactReferenceScan,
  type MarketEventWriteInput,
  type PackContentWriteInput,
  type PackWriteInput,
  type PromotionSequenceRange,
  type ProviderAccountWriteInput,
  type ProviderCanonicalEntityType,
  type PullWriteInput,
  type PullWriteResult,
  type CanonicalFactWriteResult,
  type RetireCanonicalEntityInput,
} from "./provider-canonical-contract.ts";
import {
  lockProviderWorkerLease,
  providerWorkerLeaseIsLive,
  setProviderImportLeaseContext,
} from "./provider-worker-lease-repository.ts";
import {
  resolveProviderFactReferencesBatch,
  type ProviderResolvedFactRow,
} from "./provider-fact-reference-reconciliation.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.ReadCommitted,
});

interface PromotionChangeDraft {
  readonly entityType: ProviderCanonicalEntityType;
  readonly entityId: string;
  readonly entityVersion: bigint;
  readonly operation: "upsert" | "retire";
}

interface MutableRow {
  readonly id: string;
  readonly lifecycle: "active" | "retired";
  readonly row_version: bigint;
}

function nullableText(value: string | null, field: string): string | null {
  return value === null ? null : requireNonEmptyText(value, field);
}

function nullableMoney(value: string | null, field: string): string | null {
  return value === null ? null : normalizeMoneyDecimal(value, field);
}

function nullableRate(value: string | null, field: string): string | null {
  return value === null ? null : normalizeRateDecimal(value, field);
}

function nullableCurrency(value: string | null, field: string): string | null {
  return value === null ? null : requireCurrency(value, field);
}

function nullableDate(value: Date | null, field: string): Date | null {
  return value === null ? null : requireDate(value, field);
}

function nullableJson(
  value: CanonicalJsonObject | null,
  field: string,
): ProviderPrisma.InputJsonObject | typeof ProviderPrisma.DbNull {
  return value === null
    ? ProviderPrisma.DbNull
    : toPrismaJson(normalizeJsonObject(value, field));
}

function toPrismaJson(value: CanonicalJsonObject): ProviderPrisma.InputJsonObject {
  return value as unknown as ProviderPrisma.InputJsonObject;
}

function requireNonnegativeBigInt(value: bigint | null, field: string): bigint | null {
  if (value !== null && (typeof value !== "bigint" || value < 0n)) {
    throw new ProviderCanonicalInputError(`${field} must be a non-negative bigint or null.`);
  }
  return value;
}

function requirePositiveBigInt(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new ProviderCanonicalInputError(`${field} must be a positive bigint.`);
  }
  return value;
}

function requireNonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProviderCanonicalInputError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requireNullableYear(value: number | null): number | null {
  if (value !== null && (!Number.isInteger(value) || value < 1_000 || value > 9_999)) {
    throw new ProviderCanonicalInputError("year must be a four-digit integer or null.");
  }
  return value;
}

function assertExpectedVersion(expected: bigint | undefined, actual: bigint | null): void {
  if (expected === undefined) return;
  if (actual === null ? expected !== 0n : expected !== actual) {
    throw new ProviderCanonicalWriteConflictError();
  }
}

function comparable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value === ProviderPrisma.DbNull) return null;
  if (value instanceof Date) return ["date", value.toISOString()];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (ProviderPrisma.Decimal.isDecimal(value)) {
    return normalizeMoneyDecimal(value.toFixed());
  }
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, comparable(object[key])]),
    );
  }
  return value;
}

function hasSameMaterialFields(
  row: object,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const current = row as unknown as Record<string, unknown>;
  return Object.entries(next).every(([key, value]) => (
    JSON.stringify(comparable(current[key])) === JSON.stringify(comparable(value))
  ));
}

interface PackEvidenceBinding {
  readonly attributes: ProviderPrisma.InputJsonObject;
  readonly source_updated_at: Date;
  readonly price_amount: string | null;
  readonly price_currency: string | null;
  readonly buyback_rate: string | null;
  readonly buyback_source_kind: string | null;
}

function normalizedNumberDecimal(value: number): string {
  const decimal = value.toString();
  return normalizeMoneyDecimal(/[eE]/u.test(decimal) ? value.toFixed(18) : decimal);
}

/** Validate retained facts against the provider database and the pack projection. */
async function validatePackEvEvidence(
  client: ProviderQueryClient,
  packKey: string,
  data: PackEvidenceBinding,
): Promise<void> {
  if (!Object.hasOwn(data.attributes, "evInputEvidence")) return;
  const parsed = providerPackEvEvidenceV1Schema.safeParse(data.attributes.evInputEvidence);
  if (!parsed.success) {
    throw new ProviderCanonicalInputError("attributes.evInputEvidence must be normalized pack evidence.");
  }
  const evidence = parsed.data;
  const identity = await client.database_identity.findUnique({
    where: { singleton_key: true },
    select: { provider_id: true, provider_key: true },
  });
  const price = evidence.price.state === "present" && evidence.price.value.amount >= 0
    ? evidence.price.value : null;
  const buyback = evidence.buybackPercent.state === "present"
    && evidence.buybackPercent.value >= 0 && evidence.buybackPercent.value <= 100
    ? evidence.buybackPercent.value : null;
  if (
    identity?.provider_id !== evidence.providerId || identity.provider_key !== evidence.providerKey
    || packKey !== `pack:${evidence.providerRecordId}`
    || data.source_updated_at.toISOString() !== evidence.effectiveAt
    || data.price_amount !== (price === null ? null : normalizedNumberDecimal(price.amount))
    || data.price_currency !== (price?.currency ?? null)
    || data.buyback_rate !== (buyback === null ? null : normalizedNumberDecimal(buyback / 100))
    || data.buyback_source_kind !== (buyback === null ? null : "provider_statement")
  ) {
    throw new ProviderCanonicalInputError("attributes.evInputEvidence does not match the canonical pack.");
  }
}

/**
 * Same-source writes may attach this one private fact set, never revise a pack.
 * A redelivery's collection clock cannot renew evidence already retained here.
 */
async function sameSourcePackEvidenceChange(
  client: ProviderQueryClient,
  packKey: string,
  current: { readonly attributes: ProviderPrisma.JsonValue },
  data: PackEvidenceBinding & Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const { attributes, ...fields } = data;
  if (current.attributes === null || typeof current.attributes !== "object"
    || Array.isArray(current.attributes)) throw new ProviderCanonicalWriteConflictError();
  const previous = current.attributes;
  const { evInputEvidence: previousEvidence, ...previousAttributes } = previous;
  const { evInputEvidence: incomingEvidence, ...incomingAttributes } = attributes;
  if (
    !Object.hasOwn(attributes, "evInputEvidence")
    || !hasSameMaterialFields(current, fields)
    || !hasSameMaterialFields({ attributes: previousAttributes }, { attributes: incomingAttributes })
  ) throw new ProviderCanonicalWriteConflictError();
  try {
    await validatePackEvEvidence(client, packKey, data);
  } catch (error) {
    if (error instanceof ProviderCanonicalInputError) throw new ProviderCanonicalWriteConflictError();
    throw error;
  }
  if (!Object.hasOwn(previous, "evInputEvidence")) return true;
  const parsed = providerPackEvEvidenceV1Schema.safeParse(previousEvidence);
  if (!parsed.success || !hasSameMaterialFields(
    { evidence: previousEvidence },
    { evidence: { ...(incomingEvidence as ProviderPrisma.InputJsonObject), collectedAt: parsed.data.collectedAt } },
  )) throw new ProviderCanonicalWriteConflictError();
  return false;
}

export async function appendPromotionRange(
  client: ProviderQueryClient,
  changes: readonly PromotionChangeDraft[],
  changedAt = new Date(),
): Promise<PromotionSequenceRange> {
  if (changes.length === 0) {
    throw new ProviderCanonicalInputError("A promotion range cannot be empty.");
  }
  const head = await client.promotion_ledger.update({
    where: { singleton_key: true },
    data: { last_sequence: { increment: BigInt(changes.length) } },
    select: { last_sequence: true },
  });
  const first = head.last_sequence - BigInt(changes.length) + 1n;
  await client.promotion_changes.createMany({
    data: changes.map((change, index) => ({
      sequence: first + BigInt(index),
      entity_type: change.entityType,
      entity_id: change.entityId,
      entity_version: change.entityVersion,
      operation: change.operation,
      changed_at: changedAt,
    })),
  });
  return { first, last: head.last_sequence };
}

async function appendResolvedFactChanges(
  client: ProviderQueryClient,
  rows: readonly (ProviderResolvedFactRow & {
    readonly entityType: "pull" | "pull_item" | "market_event";
  })[],
): Promise<PromotionSequenceRange | null> {
  return rows.length === 0 ? null : appendPromotionRange(
    client,
    rows.map((row) => ({
      entityType: row.entityType,
      entityId: row.id,
      entityVersion: row.row_version,
      operation: "upsert",
    })),
  );
}

export async function reconcileProviderFactReferencesTransaction(
  client: ProviderQueryClient, scan: ProviderFactReferenceScan,
): Promise<FactReferenceReconciliationResult> {
  const { pulls, pullItems, marketEventPacks, marketEventCollectibles, nextScanCursor } =
    await resolveProviderFactReferencesBatch(client, scan);
  const promotionRange = await appendResolvedFactChanges(client, [
    ...pulls.map((row) => ({ ...row, entityType: "pull" as const })),
    ...pullItems.map((row) => ({ ...row, entityType: "pull_item" as const })),
    ...marketEventPacks.map((row) => ({ ...row, entityType: "market_event" as const })),
    ...marketEventCollectibles.map((row) => ({
      ...row,
      entityType: "market_event" as const,
    })),
  ]);
  const materialChangeCount = pulls.length + pullItems.length
    + marketEventPacks.length + marketEventCollectibles.length;
  return {
    pullPackCount: pulls.length,
    pullItemCollectibleCount: pullItems.length,
    marketEventPackCount: marketEventPacks.length,
    marketEventCollectibleCount: marketEventCollectibles.length,
    materialChangeCount,
    promotionRange, nextScanCursor,
  };
}

function mutableResult(
  row: Pick<MutableRow, "id" | "row_version">,
  range: PromotionSequenceRange | null,
): CanonicalWriteResult {
  return {
    id: row.id,
    rowVersion: row.row_version,
    materialChange: range !== null,
    promotionSequence: range?.first ?? null,
  };
}

async function retireMutableEntity(input: {
  readonly client: ProviderQueryClient;
  readonly entityType: Exclude<ProviderCanonicalEntityType, "pull" | "pull_item" | "market_event">;
  readonly request: RetireCanonicalEntityInput;
  readonly find: () => Promise<MutableRow | null>;
  readonly update: (nextVersion: bigint, retiredAt: Date) => Promise<{ count: number }>;
}): Promise<CanonicalWriteResult> {
  const current = await input.find();
  if (!current) {
    throw new ProviderCanonicalInputError("The provider canonical entity does not exist.");
  }
  assertExpectedVersion(input.request.expectedRowVersion, current.row_version);
  if (current.lifecycle === "retired") return mutableResult(current, null);

  const nextVersion = current.row_version + 1n;
  const retiredAt = requireDate(input.request.retiredAt ?? new Date(), "retiredAt");
  const update = await input.update(nextVersion, retiredAt);
  if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
  const range = await appendPromotionRange(input.client, [{
    entityType: input.entityType,
    entityId: current.id,
    entityVersion: nextVersion,
    operation: "retire",
  }], retiredAt);
  return {
    id: current.id,
    rowVersion: nextVersion,
    materialChange: true,
    promotionSequence: range.first,
  };
}

/**
 * Canonical writes bound to one already-open provider transaction. This type
 * deliberately has no central client, provider locator, or provider ID input:
 * a callback can only mutate the one provider database that opened it.
 */
export class ProviderCanonicalTransaction {
  readonly #client: ProviderQueryClient;

  constructor(client: ProviderTransactionClient) {
    this.#client = client;
  }

  async upsertCategory(input: CategoryWriteInput): Promise<CanonicalWriteResult> {
    const categoryKey = requireNonEmptyText(input.categoryKey, "categoryKey");
    const data = {
      parent_category_id: input.parentCategoryId,
      display_name: requireNonEmptyText(input.displayName, "displayName"),
    };
    const current = await this.#client.categories.findUnique({ where: { category_key: categoryKey } });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      const id = randomUUID();
      const row = await this.#client.categories.create({
        data: { id, category_key: categoryKey, ...data },
      });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "category",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (current.lifecycle === "retired") throw new ProviderCanonicalRetiredError();
    if (hasSameMaterialFields(current, data)) return mutableResult(current, null);
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.categories.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...data, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "category",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async upsertPack(input: PackWriteInput): Promise<CanonicalWriteResult> {
    const packKey = requireNonEmptyText(input.packKey, "packKey");
    requirePairedValues(input.priceAmount, input.priceCurrency, "price");
    requirePairedValues(input.buybackRate, input.buybackSourceKind, "buyback");
    requirePairedValues(input.vendorEvAmount, input.vendorEvCurrency, "vendorEv");
    requirePairedValues(input.packscoutEvAmount, input.packscoutEvCurrency, "packscoutEv");
    requirePairedValues(input.primaryImageUrl, input.primaryImageAlt, "primaryImage");
    const totalInventory = requireNonnegativeBigInt(input.totalInventory, "totalInventory");
    const remainingInventory = requireNonnegativeBigInt(input.remainingInventory, "remainingInventory");
    if (totalInventory !== null && remainingInventory !== null && remainingInventory > totalInventory) {
      throw new ProviderCanonicalInputError("remainingInventory cannot exceed totalInventory.");
    }
    const data = {
      category_id: input.categoryId,
      family_key: nullableText(input.familyKey, "familyKey"),
      display_name: requireNonEmptyText(input.displayName, "displayName"),
      description: nullableText(input.description, "description"),
      pack_format: input.packFormat,
      availability: input.availability,
      content_evidence: input.contentEvidence,
      total_inventory: totalInventory,
      remaining_inventory: remainingInventory,
      price_amount: nullableMoney(input.priceAmount, "priceAmount"),
      price_currency: nullableCurrency(input.priceCurrency, "priceCurrency"),
      price_usd_amount: nullableMoney(input.priceUsdAmount, "priceUsdAmount"),
      price_unavailable_reason: nullableText(input.priceUnavailableReason, "priceUnavailableReason"),
      buyback_rate: nullableRate(input.buybackRate, "buybackRate"),
      buyback_source_kind: nullableText(input.buybackSourceKind, "buybackSourceKind"),
      vendor_ev_amount: nullableMoney(input.vendorEvAmount, "vendorEvAmount"),
      vendor_ev_currency: nullableCurrency(input.vendorEvCurrency, "vendorEvCurrency"),
      vendor_ev_observed_at: nullableDate(input.vendorEvObservedAt, "vendorEvObservedAt"),
      vendor_ev_unavailable_reason: nullableText(
        input.vendorEvUnavailableReason,
        "vendorEvUnavailableReason",
      ),
      packscout_ev_amount: nullableMoney(input.packscoutEvAmount, "packscoutEvAmount"),
      packscout_ev_currency: nullableCurrency(input.packscoutEvCurrency, "packscoutEvCurrency"),
      packscout_ev_model_version: requireNonEmptyText(
        input.packscoutEvModelVersion,
        "packscoutEvModelVersion",
      ),
      packscout_ev_confidence_policy_version: requireNonEmptyText(
        input.packscoutEvConfidencePolicyVersion,
        "packscoutEvConfidencePolicyVersion",
      ),
      packscout_ev_confidence: nullableJson(input.packscoutEvConfidence, "packscoutEvConfidence"),
      packscout_ev_data_as_of: nullableDate(input.packscoutEvDataAsOf, "packscoutEvDataAsOf"),
      packscout_ev_calculated_at: nullableDate(
        input.packscoutEvCalculatedAt,
        "packscoutEvCalculatedAt",
      ),
      packscout_ev_unavailable_reason: nullableText(
        input.packscoutEvUnavailableReason,
        "packscoutEvUnavailableReason",
      ),
      primary_image_url: nullableText(input.primaryImageUrl, "primaryImageUrl"),
      primary_image_alt: nullableText(input.primaryImageAlt, "primaryImageAlt"),
      listing_url: nullableText(input.listingUrl, "listingUrl"),
      attributes: toPrismaJson(normalizeJsonObject(input.attributes, "attributes")),
      source_updated_at: requireDate(input.sourceUpdatedAt, "sourceUpdatedAt"),
    };
    const current = await this.#client.packs.findUnique({ where: { pack_key: packKey } });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      await validatePackEvEvidence(this.#client, packKey, data);
      const row = await this.#client.packs.create({ data: { id: randomUUID(), pack_key: packKey, ...data } });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "pack",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (current.lifecycle === "retired") throw new ProviderCanonicalRetiredError();
    const sameMaterial = hasSameMaterialFields(current, data);
    const sourceOrder = data.source_updated_at.getTime()
      - current.source_updated_at.getTime();
    if (sourceOrder < 0 || sameMaterial) return mutableResult(current, null);
    let changedData: Partial<typeof data> = data;
    if (sourceOrder === 0) {
      if (!await sameSourcePackEvidenceChange(this.#client, packKey, current, data)) {
        return mutableResult(current, null);
      }
      changedData = { attributes: data.attributes };
    } else {
      await validatePackEvEvidence(this.#client, packKey, data);
    }
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.packs.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...changedData, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "pack",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async upsertCollectible(input: CollectibleWriteInput): Promise<CanonicalWriteResult> {
    const collectibleKey = requireNonEmptyText(input.collectibleKey, "collectibleKey");
    requirePairedValues(input.valuationAmount, input.valuationCurrency, "valuation");
    requirePairedValues(input.primaryImageUrl, input.primaryImageAlt, "primaryImage");
    const data = {
      category_id: input.categoryId,
      collectible_type: input.collectibleType,
      display_name: requireNonEmptyText(input.displayName, "displayName"),
      normalized_name: requireNonEmptyText(input.normalizedName, "normalizedName"),
      year: requireNullableYear(input.year),
      brand: nullableText(input.brand, "brand"),
      set_or_series: nullableText(input.setOrSeries, "setOrSeries"),
      card_number: nullableText(input.cardNumber, "cardNumber"),
      reference_number: nullableText(input.referenceNumber, "referenceNumber"),
      subject: nullableText(input.subject, "subject"),
      grade: nullableText(input.grade, "grade"),
      grader: nullableText(input.grader, "grader"),
      primary_image_url: nullableText(input.primaryImageUrl, "primaryImageUrl"),
      primary_image_alt: nullableText(input.primaryImageAlt, "primaryImageAlt"),
      valuation_amount: nullableMoney(input.valuationAmount, "valuationAmount"),
      valuation_currency: nullableCurrency(input.valuationCurrency, "valuationCurrency"),
      valuation_usd_amount: nullableMoney(input.valuationUsdAmount, "valuationUsdAmount"),
      valuation_unavailable_reason: nullableText(
        input.valuationUnavailableReason,
        "valuationUnavailableReason",
      ),
      valuation_type: nullableText(input.valuationType, "valuationType"),
      valuation_observed_at: nullableDate(input.valuationObservedAt, "valuationObservedAt"),
      data_as_of: requireDate(input.dataAsOf, "dataAsOf"),
      attributes: toPrismaJson(normalizeJsonObject(input.attributes, "attributes")),
    };
    const current = await this.#client.collectibles.findUnique({
      where: { collectible_key: collectibleKey },
    });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      const row = await this.#client.collectibles.create({
        data: { id: randomUUID(), collectible_key: collectibleKey, ...data },
      });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "collectible",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (current.lifecycle === "retired") throw new ProviderCanonicalRetiredError();
    const sameMaterial = hasSameMaterialFields(current, data);
    const sourceOrder = data.data_as_of.getTime() - current.data_as_of.getTime();
    if (sourceOrder < 0 || sameMaterial) return mutableResult(current, null);
    if (sourceOrder === 0) {
      throw new ProviderCanonicalWriteConflictError();
    }
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.collectibles.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...data, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "collectible",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async upsertCollectibleNameAlias(
    input: CollectibleNameAliasWriteInput,
  ): Promise<CanonicalWriteResult> {
    const normalizedName = requireNonEmptyText(input.normalizedName, "normalizedName");
    const data = {
      collectible_id: input.collectibleId,
      display_name: requireNonEmptyText(input.displayName, "displayName"),
      normalized_name: normalizedName,
    };
    const current = await this.#client.collectible_name_aliases.findFirst({
      where: {
        collectible_id: input.collectibleId,
        normalized_name: normalizedName,
        lifecycle: "active",
      },
    });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      const row = await this.#client.collectible_name_aliases.create({
        data: { id: randomUUID(), ...data },
      });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "collectible_name_alias",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (hasSameMaterialFields(current, data)) return mutableResult(current, null);
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.collectible_name_aliases.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...data, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "collectible_name_alias",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async upsertCollectibleInstance(
    input: CollectibleInstanceWriteInput,
  ): Promise<CanonicalWriteResult> {
    const instanceKey = requireNonEmptyText(input.instanceKey, "instanceKey");
    requirePairedValues(input.certifier, input.certificationNumber, "certification");
    const data = {
      collectible_id: input.collectibleId,
      certifier: nullableText(input.certifier, "certifier"),
      certification_number: nullableText(input.certificationNumber, "certificationNumber"),
      attributes: toPrismaJson(normalizeJsonObject(input.attributes, "attributes")),
    };
    const current = await this.#client.collectible_instances.findUnique({
      where: { instance_key: instanceKey },
    });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      const row = await this.#client.collectible_instances.create({
        data: { id: randomUUID(), instance_key: instanceKey, ...data },
      });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "collectible_instance",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (current.lifecycle === "retired") throw new ProviderCanonicalRetiredError();
    if (hasSameMaterialFields(current, data)) return mutableResult(current, null);
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.collectible_instances.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...data, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "collectible_instance",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async upsertPackContent(input: PackContentWriteInput): Promise<CanonicalWriteResult> {
    requirePairedValues(input.statedValueAmount, input.statedValueCurrency, "statedValue");
    const totalQuantity = requireNonnegativeBigInt(input.totalQuantity, "totalQuantity");
    const availableQuantity = requireNonnegativeBigInt(input.availableQuantity, "availableQuantity");
    if (totalQuantity !== null && availableQuantity !== null && availableQuantity > totalQuantity) {
      throw new ProviderCanonicalInputError("availableQuantity cannot exceed totalQuantity.");
    }
    const evidenceKinds = [...normalizeEvidenceKinds(input.evidenceKinds)];
    const data = {
      source_snapshot_id: input.sourceSnapshotId ?? null,
      pack_id: input.packId,
      collectible_id: input.collectibleId,
      collectible_instance_id: input.collectibleInstanceId,
      total_quantity: totalQuantity,
      available_quantity: availableQuantity,
      content_role: input.contentRole,
      probability: input.probability === null
        ? null
        : normalizeRateDecimal(input.probability, "probability"),
      stated_value_amount: nullableMoney(input.statedValueAmount, "statedValueAmount"),
      stated_value_currency: nullableCurrency(input.statedValueCurrency, "statedValueCurrency"),
      evidence_kinds: evidenceKinds,
      match_confidence_basis_points: input.matchConfidenceBasisPoints,
      match_confidence_band: confidenceBand(input.matchConfidenceBasisPoints),
      observed_at: requireDate(input.observedAt, "observedAt"),
      display_order: requireNonnegativeInteger(input.displayOrder, "displayOrder"),
    };
    const current = await this.#client.pack_contents.findFirst({
      where: {
        pack_id: input.packId,
        collectible_id: input.collectibleId,
        collectible_instance_id: input.collectibleInstanceId,
        lifecycle: "active",
      },
    });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      const row = await this.#client.pack_contents.create({ data: { id: randomUUID(), ...data } });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "pack_content",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (hasSameMaterialFields(current, data)) return mutableResult(current, null);
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.pack_contents.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...data, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "pack_content",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async upsertProviderAccount(input: ProviderAccountWriteInput): Promise<CanonicalWriteResult> {
    const accountKey = requireAccountKey(input.accountKey);
    const data = {
      display_name: nullableText(input.displayName, "displayName"),
      attributes: toPrismaJson(normalizeJsonObject(input.attributes, "attributes")),
    };
    const current = await this.#client.provider_accounts.findUnique({ where: { account_key: accountKey } });
    assertExpectedVersion(input.expectedRowVersion, current?.row_version ?? null);
    if (!current) {
      const row = await this.#client.provider_accounts.create({
        data: { id: randomUUID(), account_key: accountKey, ...data },
      });
      const range = await appendPromotionRange(this.#client, [{
        entityType: "provider_account",
        entityId: row.id,
        entityVersion: row.row_version,
        operation: "upsert",
      }]);
      return mutableResult(row, range);
    }
    if (current.lifecycle === "retired") throw new ProviderCanonicalRetiredError();
    if (hasSameMaterialFields(current, data)) return mutableResult(current, null);
    const nextVersion = current.row_version + 1n;
    const update = await this.#client.provider_accounts.updateMany({
      where: { id: current.id, row_version: current.row_version, lifecycle: "active" },
      data: { ...data, row_version: nextVersion },
    });
    if (update.count !== 1) throw new ProviderCanonicalWriteConflictError();
    const range = await appendPromotionRange(this.#client, [{
      entityType: "provider_account",
      entityId: current.id,
      entityVersion: nextVersion,
      operation: "upsert",
    }]);
    return {
      id: current.id,
      rowVersion: nextVersion,
      materialChange: true,
      promotionSequence: range.first,
    };
  }

  async insertPull(input: PullWriteInput): Promise<PullWriteResult> {
    const pullKey = requireNonEmptyText(input.pullKey, "pullKey");
    const factDigest = requireDigest(input.factDigest);
    const packKey = nullableText(input.packKey, "packKey");
    requirePairedValues(input.paidAmount, input.paidCurrency, "paid");
    if (input.items.length === 0) {
      throw new ProviderCanonicalInputError("A completed pull must contain at least one item.");
    }
    const items = input.items.map((item) => {
      const collectibleKey = nullableText(item.collectibleKey, "collectibleKey");
      if (item.collectibleId !== null && collectibleKey === null) {
        throw new ProviderCanonicalInputError(
          "A resolved pull item collectible requires its immutable source key.",
        );
      }
      if (item.collectibleInstanceId !== null && item.collectibleId === null) {
        throw new ProviderCanonicalInputError(
          "A collectible instance subject requires its collectible.",
        );
      }
      requirePairedValues(item.statedValueAmount, item.statedValueCurrency, "statedValue");
      return {
        ...item,
        collectibleKey,
        quantity: requirePositiveBigInt(item.quantity, "quantity"),
        statedValueAmount: nullableMoney(item.statedValueAmount, "statedValueAmount"),
        statedValueCurrency: nullableCurrency(item.statedValueCurrency, "statedValueCurrency"),
      };
    });
    if (packKey === null && items.every((item) => item.collectibleKey === null)) {
      throw new ProviderCanonicalInputError(
        "A completed pull requires at least one source pack or collectible relationship.",
      );
    }
    if (input.packId !== null && packKey === null) {
      throw new ProviderCanonicalInputError(
        "A resolved pull pack requires its immutable source key.",
      );
    }
    const current = await this.#client.pulls.findUnique({
      where: { pull_key: pullKey },
      include: { items: { orderBy: { ordinal: "asc" }, select: { id: true } } },
    });
    if (current) {
      if (current.fact_digest !== factDigest) {
        throw new ProviderCanonicalImmutableFactConflictError({
          factType: "pull",
          stableKey: pullKey,
        });
      }
      return {
        id: current.id,
        itemIds: current.items.map((item) => item.id),
        replayed: true,
        promotionRange: null,
      };
    }

    const pullId = randomUUID();
    const itemIds = input.items.map(() => randomUUID());
    await this.#client.pulls.create({
      data: {
        id: pullId,
        pull_key: pullKey,
        fact_digest: factDigest,
        pack_key: packKey,
        pack_id: input.packId,
        provider_account_id: input.providerAccountId,
        item_count: items.length,
        occurred_at: requireDate(input.occurredAt, "occurredAt"),
        paid_amount: nullableMoney(input.paidAmount, "paidAmount"),
        paid_currency: nullableCurrency(input.paidCurrency, "paidCurrency"),
      },
    });
    await this.#client.pull_items.createMany({
      data: items.map((item, index) => ({
          id: itemIds[index] ?? randomUUID(),
          pull_id: pullId,
          ordinal: index + 1,
          collectible_key: item.collectibleKey,
          collectible_id: item.collectibleId,
          collectible_instance_id: item.collectibleInstanceId,
          quantity: item.quantity,
          stated_value_amount: item.statedValueAmount,
          stated_value_currency: item.statedValueCurrency,
        })),
    });
    const range = await appendPromotionRange(this.#client, [
      { entityType: "pull", entityId: pullId, entityVersion: 1n, operation: "upsert" },
      ...itemIds.map((id) => ({
        entityType: "pull_item" as const,
        entityId: id,
        entityVersion: 1n,
        operation: "upsert" as const,
      })),
    ]);
    return { id: pullId, itemIds, replayed: false, promotionRange: range };
  }

  async insertMarketEvent(input: MarketEventWriteInput): Promise<CanonicalFactWriteResult> {
    const eventKey = requireNonEmptyText(input.eventKey, "eventKey");
    const factDigest = requireDigest(input.factDigest);
    const packKey = nullableText(input.packKey, "packKey");
    const collectibleKey = nullableText(input.collectibleKey, "collectibleKey");
    requirePairedValues(input.amount, input.currency, "amount");
    if (packKey === null && collectibleKey === null) {
      throw new ProviderCanonicalInputError("A market event requires at least one source subject.");
    }
    if (input.packId !== null && packKey === null) {
      throw new ProviderCanonicalInputError(
        "A resolved market-event pack requires its immutable source key.",
      );
    }
    if (input.collectibleId !== null && collectibleKey === null) {
      throw new ProviderCanonicalInputError(
        "A resolved market-event collectible requires its immutable source key.",
      );
    }
    if (input.collectibleInstanceId !== null && input.collectibleId === null) {
      throw new ProviderCanonicalInputError("A collectible instance subject requires its collectible.");
    }
    const current = await this.#client.market_events.findUnique({ where: { event_key: eventKey } });
    if (current) {
      if (current.fact_digest !== factDigest) {
        throw new ProviderCanonicalImmutableFactConflictError({
          factType: "market_event",
          stableKey: eventKey,
        });
      }
      return { id: current.id, replayed: true, promotionRange: null };
    }
    const id = randomUUID();
    await this.#client.market_events.create({
      data: {
        id,
        event_key: eventKey,
        fact_digest: factDigest,
        event_group_id: input.eventGroupId,
        event_type: input.eventType,
        pack_key: packKey,
        pack_id: input.packId,
        collectible_key: collectibleKey,
        collectible_id: input.collectibleId,
        collectible_instance_id: input.collectibleInstanceId,
        from_provider_account_id: input.fromProviderAccountId,
        to_provider_account_id: input.toProviderAccountId,
        quantity: input.quantity === null ? null : requirePositiveBigInt(input.quantity, "quantity"),
        occurred_at: requireDate(input.occurredAt, "occurredAt"),
        amount: nullableMoney(input.amount, "amount"),
        currency: nullableCurrency(input.currency, "currency"),
        details: toPrismaJson(normalizeJsonObject(input.details, "details")),
      },
    });
    const range = await appendPromotionRange(this.#client, [{
      entityType: "market_event",
      entityId: id,
      entityVersion: 1n,
      operation: "upsert",
    }]);
    return { id, replayed: false, promotionRange: range };
  }

  retireCategory(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("category", input, this.#client.categories);
  }

  retirePack(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("pack", input, this.#client.packs);
  }

  retireCollectible(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("collectible", input, this.#client.collectibles);
  }

  retireCollectibleNameAlias(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("collectible_name_alias", input, this.#client.collectible_name_aliases);
  }

  retireCollectibleInstance(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("collectible_instance", input, this.#client.collectible_instances);
  }

  retirePackContent(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("pack_content", input, this.#client.pack_contents);
  }

  retireProviderAccount(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.#retire("provider_account", input, this.#client.provider_accounts);
  }

  async #retire(
    entityType: Exclude<ProviderCanonicalEntityType, "pull" | "pull_item" | "market_event">,
    input: RetireCanonicalEntityInput,
    delegate: {
      findUnique(args: {
        where: { id: string };
        select: { id: true; lifecycle: true; row_version: true };
      }): Promise<MutableRow | null>;
      updateMany(args: {
        where: { id: string; row_version: bigint; lifecycle: "active" };
        data: { lifecycle: "retired"; retired_at: Date; row_version: bigint };
      }): Promise<{ count: number }>;
    },
  ): Promise<CanonicalWriteResult> {
    return retireMutableEntity({
      client: this.#client,
      entityType,
      request: input,
      find: () => delegate.findUnique({
        where: { id: input.id },
        select: { id: true, lifecycle: true, row_version: true },
      }),
      update: (nextVersion, retiredAt) => delegate.updateMany({
        where: { id: input.id, row_version: nextVersion - 1n, lifecycle: "active" },
        data: { lifecycle: "retired", retired_at: retiredAt, row_version: nextVersion },
      }),
    });
  }
}

export function createProviderCanonicalTransaction(
  client: ProviderTransactionClient,
): ProviderCanonicalTransaction {
  return new ProviderCanonicalTransaction(client);
}

/**
 * Entry point for atomic provider-canonical writes. Each convenience method
 * opens exactly one local provider transaction; transaction() lets a page or
 * quarantine retry compose several writes and roll them back as one unit.
 */
export class ProviderCanonicalRepository {
  readonly #client: ProviderPrismaClient;

  constructor(client: ProviderPrismaClient) {
    this.#client = client;
  }

  transaction<T>(
    callback: (canonical: ProviderCanonicalTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#client.$transaction(
      (client) => callback(new ProviderCanonicalTransaction(client)),
      TRANSACTION_OPTIONS,
    );
  }

  upsertCategory(input: CategoryWriteInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertCategory(input));
  }

  upsertPack(input: PackWriteInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertPack(input));
  }

  upsertCollectible(input: CollectibleWriteInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertCollectible(input));
  }

  upsertCollectibleNameAlias(
    input: CollectibleNameAliasWriteInput,
  ): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertCollectibleNameAlias(input));
  }

  upsertCollectibleInstance(
    input: CollectibleInstanceWriteInput,
  ): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertCollectibleInstance(input));
  }

  upsertPackContent(input: PackContentWriteInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertPackContent(input));
  }

  upsertProviderAccount(input: ProviderAccountWriteInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.upsertProviderAccount(input));
  }

  insertPull(input: PullWriteInput): Promise<PullWriteResult> {
    return this.transaction((canonical) => canonical.insertPull(input));
  }

  insertMarketEvent(input: MarketEventWriteInput): Promise<CanonicalFactWriteResult> {
    return this.transaction((canonical) => canonical.insertMarketEvent(input));
  }

  /**
   * Resolve one bounded batch under the current import fence. Callers renew
   * before this transaction and drain by repeating until the count is zero.
   * A null result means the supplied worker no longer owns a live lease.
   */
  reconcileFactReferences(input: ProviderFactReferenceScan & Readonly<{
    workerId: string;
    workerFence: bigint;
  }>): Promise<FactReferenceReconciliationResult | null> {
    return this.#client.$transaction(async (client) => {
      const lease = await lockProviderWorkerLease(client, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: input.workerId,
        fence: input.workerFence,
      })) {
        return null;
      }
      await setProviderImportLeaseContext(client, {
        owner: input.workerId,
        fence: input.workerFence,
      });
      return reconcileProviderFactReferencesTransaction(client, input);
    }, TRANSACTION_OPTIONS);
  }

  retireCategory(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retireCategory(input));
  }

  retirePack(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retirePack(input));
  }

  retireCollectible(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retireCollectible(input));
  }

  retireCollectibleNameAlias(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retireCollectibleNameAlias(input));
  }

  retireCollectibleInstance(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retireCollectibleInstance(input));
  }

  retirePackContent(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retirePackContent(input));
  }

  retireProviderAccount(input: RetireCanonicalEntityInput): Promise<CanonicalWriteResult> {
    return this.transaction((canonical) => canonical.retireProviderAccount(input));
  }
}
