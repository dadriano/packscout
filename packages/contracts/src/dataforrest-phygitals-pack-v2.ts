import { phygitalsPackProviderFactsV1 } from
  "./dataforrest-phygitals-pack-v1.ts";
import type {
  NormalizedEvBucket,
  NormalizedPackProviderFacts,
} from "./provider-source-facts-v1.ts";

/*
 * Phygitals catalog-pack native reader, V2.
 *
 * Reads every fact exactly as V1 does (the V1 reader is called, never copied)
 * and binds one more: `evInput`, from `rarity_distribution`.
 *
 * V1 left `evInput` absent by contract decision because the importer's
 * canonical EV-input projection wants an integer per-tier quantity and
 * Phygitals publishes odds. The decision taken since is recorded here: a
 * tier's `weight` is a published probability in percent and its `lower` /
 * `upper` are the tier's USD value range, so the distribution is a complete
 * probability-only EV input whose pool size is unknown (`quantity` and
 * `totalQuantity` stay null). The PackScout EV calculator accepts exactly that
 * shape (a probability per outcome, a closed value range, member count not
 * published). The importer's canonical projection still insists on
 * quantities, so it reports `ev_input_unavailable` for these packs and the
 * evidence is retained on the pack row for promotion-time calculation.
 *
 * Evidence base: the same 144-row capture V1 documents. Every row carries a
 * non-empty `rarity_distribution` (615 entries, 1 to 6 per pack). On all 615
 * entries `id`, `name`, `lower`, `upper` and `weight` are present, `lower` and
 * `upper` are numbers with `lower <= upper` (min lower 0, max upper 2,000x the
 * pack price), and the weights of each pack total exactly 100 (103 of 615 are
 * fractional). Nothing else in the payload states a quantity or pool size.
 *
 * BOUND (per `rarity_distribution` entry)
 *   bucketId    <- `id`, in string form. Numeric on 615/615; a string id is
 *                  accepted too. Ids must be unique within one distribution.
 *   label       <- `name`. Blank resolves to null, like V1's optional text.
 *   probability <- `weight` / 100.
 *   lowerValue  <- `lower`, USD major units under V1's reviewed currency
 *   upperValue  <- `upper`  assertion (no payload names a currency).
 *   quantity    <- null: never published.
 * BOUND (per pack)
 *   totalQuantity <- null: never published.
 *   drawCount     <- 1, the same inference V1 makes for `drawCount`.
 *   unitBasis     <- "per_pack".
 *   currency      <- "USD" (V1's assertion).
 *   buybackPercent<- V1's `buybackPercent` value when present, else null.
 *   approved      <- true: the binding above is the reviewed contract.
 *
 * STATES
 *   absent    - `rarity_distribution` is missing or null.
 *   malformed - not a non-empty array; an entry that is not an object; a
 *               missing, blank or duplicate id; a non-finite or negative
 *               weight; a missing, non-finite, negative or inverted value
 *               range; weights not totalling 100 (tolerance 1e-6); or no tier
 *               with probability mass. A present-but-broken distribution is a
 *               defect in the EV input and must stay visible as one.
 *   present   - otherwise. Zero-weight tiers carry no probability mass and are
 *               dropped, as the ClutchPacks reader drops zero-count buckets.
 */

type NativeJsonObject = Readonly<Record<string, unknown>>;

const rarityWeightTotalPercent = 100;
const rarityWeightTotalTolerance = 0.000_001;
const maximumRarityEntries = 10_000;

function nativeObject(value: unknown): NativeJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeJsonObject
    : null;
}

function bucketIdText(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

/** null when unset or blank; undefined when present but not text. */
function labelText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  return normalized.length <= 500 ? normalized : undefined;
}

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function evInputFact(
  value: unknown,
  facts: NormalizedPackProviderFacts,
): NormalizedPackProviderFacts["evInput"] {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximumRarityEntries
  ) {
    return { state: "malformed" as const };
  }
  const buckets: NormalizedEvBucket[] = [];
  const bucketIds = new Set<string>();
  let totalWeight = 0;
  for (const candidate of value) {
    const entry = nativeObject(candidate);
    if (entry === null) return { state: "malformed" as const };
    const bucketId = bucketIdText(entry.id);
    const label = labelText(entry.name);
    const weight = nonNegativeFinite(entry.weight);
    const lowerValue = nonNegativeFinite(entry.lower);
    const upperValue = nonNegativeFinite(entry.upper);
    if (
      bucketId === null ||
      bucketIds.has(bucketId) ||
      label === undefined ||
      weight === null ||
      lowerValue === null ||
      upperValue === null ||
      lowerValue > upperValue
    ) {
      return { state: "malformed" as const };
    }
    bucketIds.add(bucketId);
    totalWeight += weight;
    if (weight === 0) continue;
    buckets.push({
      bucketId,
      label,
      probability: weight / rarityWeightTotalPercent,
      quantity: null,
      lowerValue,
      upperValue,
    });
  }
  if (
    Math.abs(totalWeight - rarityWeightTotalPercent) >
      rarityWeightTotalTolerance ||
    buckets.length === 0
  ) {
    return { state: "malformed" as const };
  }
  return {
    state: "present" as const,
    value: {
      approved: true,
      currency: "USD" as const,
      unitBasis: "per_pack" as const,
      drawCount: 1,
      buybackPercent: facts.buybackPercent.state === "present"
        ? facts.buybackPercent.value
        : null,
      totalQuantity: null,
      buckets,
    },
  };
}

/** V1's exact facts plus the probability-only `evInput` binding. */
export function phygitalsPackProviderFactsV2(
  nativeData: NativeJsonObject,
): NormalizedPackProviderFacts {
  const facts = phygitalsPackProviderFactsV1(nativeData);
  return {
    ...facts,
    evInput: evInputFact(nativeData.rarity_distribution, facts),
  };
}
