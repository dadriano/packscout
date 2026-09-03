import {
  emptyNormalizedProviderFacts,
  type NormalizedPackProviderFacts,
} from "./provider-source-facts-v1.ts";

/*
 * Phygitals catalog-pack native reader, V1.
 *
 * Evidence base: 326-row DataForrest catalog capture walked to head, of which
 * 144 rows are `phygitals` / `catalog` / `pack`. Every coverage number below is
 * measured over all 144 rows, not a sample. Keys named here are top-level keys
 * of the native pack payload.
 *
 * BOUND FACTS
 *   displayName   <- `name`.  144/144 string, 0 blank, longest 36 chars.
 *   description   <- `description`.  Key on 144/144; JSON null on 60 and "" on
 *                    25 of the remaining 84, so 59/144 carry text (longest 195).
 *                    Phygitals uses null and "" interchangeably for "unset" on
 *                    this same field, so blank resolves to absent, not
 *                    malformed (a deliberate divergence from the ClutchPacks
 *                    reference, which has no observed blank-string convention).
 *   category      <- `category`, falling back to `categories[0]`.
 *                    `category` is a non-blank string on 104/144 and JSON null
 *                    on 40. `categories` is a non-empty string array on 144/144
 *                    (174 elements, 0 blank, all strings). Where both are
 *                    present they agree on 97/104; the 7 disagreements are
 *                    multi-sport packs whose `category` is "football" while
 *                    `categories` is ["basketball","baseball","football",
 *                    "soccer"], i.e. `categories` is NOT ordered by primacy.
 *                    The fallback is therefore taken only when `categories`
 *                    holds exactly one entry (37 of the 40 null-category rows);
 *                    the other 3 list 4 categories with no evidenced primary and
 *                    stay absent. Coverage: 141/144.
 *   imageReferences <- `claw_image_url`.  71/144 non-null, all 71 https, longest
 *                    154 chars; JSON null on 73.  Emitted as a single-entry
 *                    list. `creator_profile.profile_picture` and
 *                    `pack_managers[].profile_picture` are site-relative paths
 *                    ("/images/pfps/pfp-70.webp"), not resolvable references,
 *                    and are deliberately not read.
 *   buybackPercent <- `buyback_percent`.  144/144 number, and a RATIO on 0..1,
 *                    NOT a percent: the only observed values are 0 (1 row),
 *                    0.85 (many), 0.9, 0.92 and 1 (21 rows). Scaled x100 here.
 *                    Binding it unscaled would silently publish 0.85% where the
 *                    provider means 85%. Values outside 0..1 are rejected as
 *                    malformed rather than scaled, so a future switch to whole
 *                    percents surfaces loudly instead of publishing 8500%.
 *                    0 is bound as a real 0% rather than treated as a sentinel;
 *                    the field is a uniform ratio and 0 is in range.
 *   drawCount     <- inferred from `rarity_distribution`, value 1.
 *                    `rarity_distribution` is a non-empty array on 144/144 whose
 *                    `weight` values sum to exactly 100 on 144/144 (1 to 6
 *                    entries; 103 of 615 weights are fractional). A single set
 *                    of weights totalling 100, with `pulls_per_voucher` = 0 on
 *                    144/144 and no per-draw multiplier anywhere in the payload,
 *                    evidences one draw per pack. The inference is made per row,
 *                    so a payload that does not present that distribution yields
 *                    absent rather than an asserted 1. `max_per_mint` (1..10) is
 *                    a per-buyer purchase cap, not a draw count, and is not read.
 *   authoritativeAvailability <- `in_stock` === false.
 *                    Boolean on 144/144; 89 true, 55 false. Checked against the
 *                    contradiction the mapper quarantines on: 0 of the 144 rows
 *                    have an envelope availability of "available" together with
 *                    in_stock false, so this binding trips no
 *                    availability_contradiction on the captured corpus. The one
 *                    row where the two disagree ("watchking-pack-kewodc") is
 *                    envelope-unavailable with in_stock true, which is the
 *                    harmless direction: in_stock true stays absent and lets the
 *                    envelope decide.
 *
 * DELIBERATELY ABSENT
 *   price / providerReportedEv.  No phygitals pack payload states a currency
 *     anywhere: 0 of 144 rows contain any currency token (`currency`, `USD`,
 *     `USDC`, `SOL`), `rewards_symbols` is [] on 144/144, and the only other
 *     unit-bearing keys are `type` ("EBAY" on 144/144) and `platform`
 *     ("mainnet" on 144/144). A resolved amount with no currency is not a money
 *     fact, and NormalizedProviderMoney has no currency-less form, so neither is
 *     bound. This matches the reviewed precedent already shipped for this
 *     provider in dataforrest-phygitals-card-v1.ts, which records that phygitals
 *     "prices without a reviewed currency contract never become canonical
 *     facts". The amounts themselves are clean and would bind immediately if a
 *     currency contract is reviewed:
 *       `mint_price`  144/144, a plain integer-valued string ("50", "10000"),
 *                     major units, range 1..10000, no separators or symbols.
 *       `ev`          144/144 number and the correct source for
 *                     providerReportedEv, with 0 as an unset sentinel: it is 0
 *                     on 41/144 while `min_ev` is > 0 on all 41, so a true zero
 *                     EV is impossible and those 41 mean "not computed".
 *                     `max_ev` is NOT the right source despite being populated
 *                     on those rows - `min_ev`/`max_ev` are a configured
 *                     advertised band (98/144 sit at exactly 0.99x and 1.05x
 *                     `mint_price`), while `ev` is an independent point estimate
 *                     that falls below `min_ev` on 9 rows and above `max_ev` on
 *                     3, so the band cannot stand in for the point value.
 *     A `mint_price` or `ev` that does not parse as an amount at all is still
 *     reported malformed, so a genuine provider-side regression stays visible
 *     and is distinguishable from this contract gap.
 *   evInput.  Not populated, by contract decision. The mapper
 *     (provider-observation-mapper.ts, evInputFromFacts) requires an integer
 *     per-bucket `quantity` and a `totalQuantity` matching their sum. Phygitals
 *     publishes `rarity_distribution[].{weight,lower,upper}` where `weight` is a
 *     percentage summing to 100 - fractional on 103 of 615 observed entries -
 *     and no quantity or pool size appears anywhere in the payload. Binding odds
 *     as quantities would mark evInput malformed on every pack. Deriving EV
 *     inputs from odds is a separate contract decision, not part of this reader.
 *   packMembership.  No membership evidence: `chase` is [] on 144/144 and
 *     `variants` is [] on 130/144, so the key is omitted entirely and cannot
 *     clear a previously accepted snapshot.
 */

type NativeJsonObject = Readonly<Record<string, unknown>>;

/** Observed `rarity_distribution` weight total, in percent. */
const rarityWeightTotalPercent = 100;
const rarityWeightTotalTolerance = 0.000_001;
const percentScaleEpsilon = 1_000_000;
const plainAmountPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

function nativeObject(value: unknown): NativeJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeJsonObject
    : null;
}

/** Blank resolves to absent: phygitals uses "" and null for the same "unset". */
function optionalTextFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return { state: "absent" as const };
  }
  return normalized.length <= 10_000
    ? { state: "present" as const, value: normalized }
    : { state: "malformed" as const };
}

/** A pack that arrives without a usable label is a defect, not an omission. */
function displayNameFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 10_000
    ? { state: "present" as const, value: normalized }
    : { state: "malformed" as const };
}

function categoryFact(categoryValue: unknown, categoriesValue: unknown) {
  const primary = optionalTextFact(categoryValue);
  if (primary.state !== "absent") return primary;
  if (categoriesValue === undefined || categoriesValue === null) {
    return { state: "absent" as const };
  }
  if (!Array.isArray(categoriesValue)) {
    return { state: "malformed" as const };
  }
  // `categories` is unordered, so only a single entry names the pack's
  // category without guessing which of several listed labels is primary.
  return categoriesValue.length === 1
    ? optionalTextFact(categoriesValue[0])
    : { state: "absent" as const };
}

function imageReferencesFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return { state: "absent" as const };
  }
  if (normalized.length > 2_048) {
    return { state: "malformed" as const };
  }
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      return { state: "malformed" as const };
    }
  } catch {
    return { state: "malformed" as const };
  }
  return { state: "present" as const, value: [normalized] };
}

function majorUnitAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!plainAmountPattern.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * Phygitals names no currency anywhere in the payload, so USD is a reviewed
 * decision recorded here rather than a value read from the record. The basis is
 * in the header under `price` / `providerReportedEv`. Every amount this reader
 * emits therefore carries the same asserted ticker, and a change of that
 * decision is a one-line change in this function.
 */
function usdMoneyFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const amount = majorUnitAmount(value);
  return amount === null
    ? { state: "malformed" as const }
    : {
        state: "present" as const,
        value: { amount, currency: "USD" as const },
      };
}

/**
 * `ev` uses 0 as an unset sentinel on 41/144 rows, where `min_ev` is above zero
 * and a true zero expected value is therefore impossible. Those rows mean "not
 * computed" and must stay absent: storing 0 would present an unknown EV as a
 * worthless pack. A non-numeric `ev` is still malformed, so a provider-side
 * regression stays distinguishable from the sentinel.
 */
function providerReportedEvFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  // `ev` is published as a number, unlike the string-valued `mint_price`.
  const amount = typeof value === "number"
    ? (Number.isFinite(value) && value >= 0 ? value : null)
    : majorUnitAmount(value);
  if (amount === null) return { state: "malformed" as const };
  if (amount === 0) return { state: "absent" as const };
  return {
    state: "present" as const,
    value: { amount, currency: "USD" as const },
  };
}

/** `buyback_percent` is a 0..1 ratio on every observed row, never a percent. */
function buybackPercentFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { state: "malformed" as const };
  }
  if (value < 0 || value > 1) {
    return { state: "malformed" as const };
  }
  const percent = Math.round(value * 100 * percentScaleEpsilon) /
    percentScaleEpsilon;
  return { state: "present" as const, value: percent };
}

/**
 * One draw per pack, evidenced per row by a single `rarity_distribution` whose
 * weights total 100 percent. Anything else is an unproven inference, so it is
 * reported absent rather than malformed - the payload defect, if any, is in
 * `rarity_distribution`, not in a draw count phygitals never publishes.
 */
function drawCountFact(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    return { state: "absent" as const };
  }
  let totalWeight = 0;
  for (const candidate of value) {
    const entry = nativeObject(candidate);
    const weight = entry?.weight;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      return { state: "absent" as const };
    }
    totalWeight += weight;
  }
  return Math.abs(totalWeight - rarityWeightTotalPercent) <=
      rarityWeightTotalTolerance
    ? { state: "present" as const, value: 1 }
    : { state: "absent" as const };
}

/**
 * Only an explicit `in_stock: false` is authoritative. `in_stock: true` stays
 * absent so the envelope decides availability and no observation contradicts it.
 */
function authoritativeAvailabilityFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "boolean") {
    return { state: "malformed" as const };
  }
  return value
    ? { state: "absent" as const }
    : {
      state: "present" as const,
      value: {
        state: "sold_out" as const,
        authority: "provider_explicit_sold_out" as const,
      },
    };
}

/** Exact allowlist for the evidenced Phygitals V1 catalog-pack shape. */
export function phygitalsPackProviderFactsV1(
  nativeData: NativeJsonObject,
): NormalizedPackProviderFacts {
  const empty = emptyNormalizedProviderFacts(
    "pack",
  ) as NormalizedPackProviderFacts;
  return {
    ...empty,
    displayName: displayNameFact(nativeData.name),
    description: optionalTextFact(nativeData.description),
    category: categoryFact(nativeData.category, nativeData.categories),
    imageReferences: imageReferencesFact(nativeData.claw_image_url),
    // Currency is asserted, not read; see the money note in the file header.
    price: usdMoneyFact(nativeData.mint_price),
    providerReportedEv: providerReportedEvFact(nativeData.ev),
    buybackPercent: buybackPercentFact(nativeData.buyback_percent),
    drawCount: drawCountFact(nativeData.rarity_distribution),
    // evInput stays absent: phygitals publishes odds, never quantities.
    authoritativeAvailability: authoritativeAvailabilityFact(
      nativeData.in_stock,
    ),
  };
}
