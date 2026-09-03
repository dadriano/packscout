import type { collectibles } from "../prisma/generated/provider/index.js";
import {
  normalizeJsonObject, ProviderCanonicalRetiredError, ProviderCanonicalWriteConflictError,
  requireDate, requireNonEmptyText, requirePairedValues, type CollectibleWriteInput,
} from "./provider-canonical-contract.ts";
import {
  nullableText, nullableMoney, nullableCurrency, nullableDate, toPrismaJson,
  requireNullableYear, assertExpectedVersion, hasSameMaterialFields,
} from "./provider-canonical-mutable-helpers.ts";

export function normalizeProviderCollectibleWrite(input: CollectibleWriteInput) {
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
  return { collectibleKey, data };
}

/** Exact source-clock, row-version and retirement decisions for both writers. */
export function planProviderCollectibleWrite(expectedRowVersion: bigint | undefined,
  current: collectibles | null, data: ReturnType<typeof normalizeProviderCollectibleWrite>["data"]) {
  assertExpectedVersion(expectedRowVersion, current?.row_version ?? null);
  if (current === null) return { kind: "create" as const };
  if (current.lifecycle === "retired") throw new ProviderCanonicalRetiredError();
  const sameMaterial = hasSameMaterialFields(current, data);
  const sourceOrder = data.data_as_of.getTime() - current.data_as_of.getTime();
  if (sourceOrder < 0 || sameMaterial) return { kind: "unchanged" as const, current };
  if (sourceOrder === 0) throw new ProviderCanonicalWriteConflictError();
  return { kind: "update" as const, current };
}
