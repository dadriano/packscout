import {
  confidenceBand, normalizeEvidenceKinds, normalizeRateDecimal,
  ProviderCanonicalInputError, requireDate, requirePairedValues, type PackContentWriteInput,
} from "./provider-canonical-contract.ts";
import { requireNonnegativeBigInt, requireNonnegativeInteger, nullableMoney, nullableCurrency }
  from "./provider-canonical-mutable-helpers.ts";

/** Shared by the single-row API and authoritative snapshot batches. */
export function normalizeProviderPackContentWrite(input: PackContentWriteInput) {
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
  return data;
}
