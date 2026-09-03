import {
  emptyNormalizedProviderFacts,
  type NormalizedPackProviderFacts,
} from "./provider-source-facts-v1.ts";

/**
 * Courtyard `kind: "pack"` native reader.
 *
 * Grounded in 109 captured Courtyard catalog-pack payloads (every pack reachable
 * by walking the provider catalog stream to head). Coverage counts below are
 * observed over those 109 rows, not inferred from a single sample.
 *
 * Native key -> normalized fact
 * - `title` -> displayName. 109/109 non-empty strings, 9..38 chars. The generic
 *   envelope fallback reads Courtyard's provider-declared display-name field
 *   (`provider_label`), which appears on 0/109 rows; that miss is why every
 *   Courtyard pack was rejected for a missing display name.
 * - `description` -> description. 109/109 non-empty strings, 55..476 chars.
 * - `category.title` -> category. `category` is an OBJECT on 109/109 rows
 *   (`{id,title,color,displayOrder}`), so the leaf is bound, not the wrapper.
 *   16 distinct titles observed ("Pokemon", "Limited Drop", "Graded Coins"...).
 * - `saleDetails.salePriceUsd` -> price. 109/109 numbers, major USD units,
 *   whole dollars, 10..15000.
 * - `saleDetails.expectedValueUsd` -> providerReportedEv. 109/109 numbers,
 *   major USD units, 9.5..14250. 9/109 carry sub-cent noise from the provider's
 *   own ratio-times-price arithmetic (e.g. 2374.0499999999997, 987.8112), so
 *   both money facts are normalized to cent precision here.
 * - `buybackRatio` -> buybackPercent, SCALED x100. 109/109 numbers, and every
 *   observed value is a RATIO in 0..1 (0.846 on 103 rows, 0.896 on 5, 0.9 on 1).
 *   buybackPercent is validated 0..100 downstream, so binding the raw ratio
 *   would be a silent 100x understatement. A value above 1 is rejected as
 *   malformed rather than guessed at: a bare `1.05` cannot be told apart from
 *   an already-percent 1.05%.
 * - `odds.buckets[].oddsPercent` -> drawCount (value 1). `odds` is an object on
 *   90/109 rows and JSON null on 19/109. Where present it is a single closed
 *   probability distribution over the value of the ONE card the pack yields:
 *   4 or 5 buckets whose oddsPercent sums to 100 (observed spread 100 +/- 6e-15),
 *   alongside `odds.minCardValueUsd`. That closure is the structural admission of
 *   a one-draw pack, so drawCount is derived per row and stays absent on the 19
 *   rows that publish no odds. Deliberately NOT hardcoded to 1 the way the
 *   ClutchPacks reader does - Courtyard publishes no draw-count field, and a
 *   blanket 1 would assert more than any row shows.
 * - `sealedPackImage`, `sealedPackThumbnail` -> imageReferences. 109/109 each,
 *   all https, 85..159 chars, hosted on api.courtyard.io (98) and
 *   storage.googleapis.com (11). These two depict the pack product itself.
 *   Deliberately excluded: `vendingMachineImage`, `vendingMachineThumbnail`,
 *   `heroBackgroundImage` (108/109), `heroForegroundImage`, `socialSharingImage`
 *   are scene and marketing composites, and every `*Animation` key is an .mp4,
 *   not an image.
 * - `outOfStock` -> authoritativeAvailability. 109/109 booleans, true on 39 and
 *   false on 70. On all 39 sold-out rows the DataForrest envelope also reports
 *   availability false, so binding this does not trip the mapper's
 *   `availability_contradiction` quarantine on any captured row.
 *
 * Deliberately unbound:
 * - evInput. The mapper's `evInputFromFacts` requires an integer per-bucket
 *   quantity and a totalQuantity equal to their sum. Courtyard publishes
 *   `oddsPercent` plus `minValueUsd`/`maxValueUsd` per bucket and NO quantity
 *   anywhere in the payload, so binding the odds today would mark evInput
 *   malformed on every pack. Turning published odds into EV input is a separate
 *   contract decision and is intentionally out of scope for this reader.
 * - `status` ("ACTIVE" on 109/109) and `saleDetails.closed` (false on 109/109)
 *   carry no discriminating signal in the capture, so neither is read as an
 *   availability authority.
 * - `minTier` (3/109, "gold") and `tier` gate purchase eligibility rather than
 *   describing the pack, and `id` is native identity the envelope already owns.
 *
 * Currency: no Courtyard payload contains a currency field (0/109 rows mention
 * one). The unit is admitted by the key names themselves - salePriceUsd,
 * expectedValueUsd, minValueUsd, maxValueUsd, minCardValueUsd - so USD is bound
 * only for amounts read out of a `...Usd` key.
 */

type NativeJsonObject = Readonly<Record<string, unknown>>;

const maxTextLength = 10_000;
const maxImageUrlLength = 2_048;
const maxOddsBuckets = 1_000;
/** Allows 2-decimal rounding artifacts while still rejecting an unclosed set. */
const oddsClosureTolerancePercent = 0.01;
/** Pack-product art, most representative first. */
const packImageKeys = ["sealedPackImage", "sealedPackThumbnail"] as const;

function nativeObject(value: unknown): NativeJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeJsonObject
    : null;
}

function normalizedTextFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxTextLength
    ? { state: "present" as const, value: normalized }
    : { state: "malformed" as const };
}

/** `category` is a wrapper object on every observed row; bind its leaf title. */
function categoryFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const category = nativeObject(value);
  return category === null || category.title === undefined ||
      category.title === null
    ? { state: "malformed" as const }
    : normalizedTextFact(category.title);
}

/** Major-unit USD number normalized to cent precision. */
function usdMajorAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) ? minor / 100 : null;
}

function saleDetailsUsdFact(saleDetailsValue: unknown, key: string) {
  if (saleDetailsValue === undefined || saleDetailsValue === null) {
    return { state: "absent" as const };
  }
  const saleDetails = nativeObject(saleDetailsValue);
  if (saleDetails === null) {
    return { state: "malformed" as const };
  }
  const amount = usdMajorAmount(saleDetails[key]);
  return amount === null
    ? { state: "malformed" as const }
    : {
        state: "present" as const,
        value: { amount, currency: "USD" as const },
      };
}

/**
 * `buybackRatio` is a 0..1 ratio on every observed row, so it is scaled to the
 * 0..100 percent the normalized fact is validated against. Anything outside
 * 0..1 is ambiguous between a ratio and an already-scaled percent and is
 * refused rather than mis-scaled by a factor of 100.
 */
function buybackPercentFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > 1
  ) {
    return { state: "malformed" as const };
  }
  return { state: "present" as const, value: Math.round(value * 10_000) / 100 };
}

/**
 * Courtyard states no draw count. A closed `odds.buckets` distribution over the
 * value of the card the pack yields is the only structural evidence of a
 * one-draw pack, so the fact is derived from that closure and left absent when
 * the pack publishes no odds at all.
 */
function drawCountFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const odds = nativeObject(value);
  const buckets = odds?.buckets;
  if (
    odds === null || !Array.isArray(buckets) || buckets.length === 0 ||
    buckets.length > maxOddsBuckets
  ) {
    return { state: "malformed" as const };
  }
  let totalPercent = 0;
  for (const candidate of buckets) {
    const bucket = nativeObject(candidate);
    const oddsPercent = bucket?.oddsPercent;
    if (
      bucket === null || typeof oddsPercent !== "number" ||
      !Number.isFinite(oddsPercent) || oddsPercent < 0 || oddsPercent > 100
    ) {
      return { state: "malformed" as const };
    }
    totalPercent += oddsPercent;
  }
  return Math.abs(totalPercent - 100) <= oddsClosureTolerancePercent
    ? { state: "present" as const, value: 1 }
    : { state: "malformed" as const };
}

function httpsImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxImageUrlLength) {
    return null;
  }
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return normalized;
}

/** Absent only when the pack publishes none of the product-art keys. */
function imageReferencesFact(nativeData: NativeJsonObject) {
  const references: string[] = [];
  let published = false;
  for (const key of packImageKeys) {
    const raw = nativeData[key];
    if (raw === undefined || raw === null) continue;
    published = true;
    const url = httpsImageUrl(raw);
    if (url === null) return { state: "malformed" as const };
    if (!references.includes(url)) references.push(url);
  }
  return published
    ? { state: "present" as const, value: references }
    : { state: "absent" as const };
}

function authoritativeAvailabilityFact(value: unknown) {
  if (value === undefined || value === null || value === false) {
    return { state: "absent" as const };
  }
  if (value !== true) return { state: "malformed" as const };
  return {
    state: "present" as const,
    value: {
      state: "sold_out" as const,
      authority: "provider_explicit_sold_out" as const,
    },
  };
}

/** Exact allowlist for the evidenced Courtyard V1 catalog-pack shape. */
export function courtyardPackProviderFactsV1(
  nativeData: NativeJsonObject,
): NormalizedPackProviderFacts {
  const empty = emptyNormalizedProviderFacts(
    "pack",
  ) as NormalizedPackProviderFacts;
  return {
    ...empty,
    displayName: normalizedTextFact(nativeData.title),
    description: normalizedTextFact(nativeData.description),
    category: categoryFact(nativeData.category),
    imageReferences: imageReferencesFact(nativeData),
    price: saleDetailsUsdFact(nativeData.saleDetails, "salePriceUsd"),
    // The provider's own checkout labels this raw field as `Expected Value`.
    providerReportedEv: saleDetailsUsdFact(
      nativeData.saleDetails,
      "expectedValueUsd",
    ),
    buybackPercent: buybackPercentFact(nativeData.buybackRatio),
    drawCount: drawCountFact(nativeData.odds),
    // evInput stays absent: Courtyard publishes odds percentages and value
    // ranges but no per-bucket quantity, and the mapper requires an integer
    // quantity per bucket plus a matching totalQuantity. Binding the odds here
    // would mark evInput malformed on every pack. Converting published odds
    // into EV input is a separate contract decision.
    authoritativeAvailability: authoritativeAvailabilityFact(
      nativeData.outOfStock,
    ),
  };
}
