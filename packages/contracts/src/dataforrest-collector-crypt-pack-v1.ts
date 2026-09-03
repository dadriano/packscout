import {
  emptyNormalizedProviderFacts,
  type NormalizedPackProviderFacts,
} from "./provider-source-facts-v1.ts";

type NativeJsonObject = Readonly<Record<string, unknown>>;

const maxTextLength = 10_000;
const maxImageReferenceLength = 2_048;

/**
 * Native key -> fact map for the Collector Crypt catalog-pack ("machine")
 * shape, with coverage measured over all 73 captured collector_crypt
 * catalog/pack payloads.
 *
 * - `name` -> displayName. 73/73 non-empty strings. `shortName` is byte-equal
 *   to `name` on 32/73 and never carries more, so it is not read.
 * - (no native key) -> description. No observed payload has a `description`
 *   key (0/73), so the fact is unconditionally absent.
 * - `menuCategory` -> category. 51/73 strings (Pokemon 27, Sports 14,
 *   Others 7, One Piece 3; none blank), 22/73 explicit null -> absent.
 * - `thumbnailUrl` -> imageReferences. 18/73 https vercel-blob URLs, 55/73
 *   null. `imageNobgUrl` is null on 73/73 and `image` is the empty string on
 *   73/73; both are read so a later population is picked up, and both of
 *   those "unset" encodings are treated as no-reference rather than
 *   malformed. Treating `image: ""` as malformed would raise
 *   malformed_image_references on 73/73 rows and discard the thumbnail.
 * - `price.amount` -> price. 73/73 numbers, whole USD major units
 *   (25 .. 5000, decimal scale 0). No `currency` key exists anywhere in any
 *   observed payload; USD is bound on the provider's own evidence: on the
 *   14/73 rows whose `name` embeds a dollar figure ("eo Poke $5000",
 *   "Riftbound $100", "Exclusive Fire $420") that figure equals
 *   `price.amount` exactly on 14/14, and the vaulted-asset traits inside
 *   `topNfts` state insured values against a US (Delaware) vault address.
 * - `targetEV` -> providerReportedEv. 73/73 positive numbers in the same
 *   major units as price (decimal scale <= 2; price 5000 -> targetEV 5100).
 *   `maxEV`, `targetEvMin` and `targetEvMax` are the machine's upper bound
 *   and tolerance band around `targetEV`, not the reported value, so they
 *   are not read.
 * - `instantBuyback.percentageOfValue` -> buybackPercent. 73/73 numbers
 *   already on a 0..100 percent scale (85 x16, 90 x37, 93 x13, 94 x7). It is
 *   NOT a 0..1 ratio, so it is bound unscaled; scaling it would be a 100x
 *   error in the opposite direction.
 * - `contains` -> drawCount. 73/73 the integer 1.
 * - `archived` -> authoritativeAvailability. 73/73 booleans, true on 10/73.
 *   The capture envelope's `available` is false on 10/10 of those rows (in
 *   fact `available` == (!archived && public) holds on 73/73), so binding it
 *   cannot trip the mapper's availability_contradiction quarantine on any
 *   evidenced row. `public` is deliberately NOT bound: false on 37/73 rows
 *   means unlisted, not sold out.
 *
 * evInput stays absent on purpose. `weightMultipliers` (per-tier weights that
 * sum to exactly 1 on 73/73) and `tierRanges` (per-tier start/end values,
 * same four tier keys on 73/73) give probabilities and value ranges but no
 * per-bucket item counts, and the mapper's evInputFromFacts requires a safe
 * integer quantity > 0 on every bucket plus a matching totalQuantity > 0.
 * Binding odds without quantities would yield evInput: malformed on every
 * pack. Admitting an odds-only EV input is a separate contract decision.
 */

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

/** Non-negative USD major units, normalized to cent precision. */
function usdAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) ? minor / 100 : null;
}

function usdMoneyFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const amount = usdAmount(value);
  return amount === null
    ? { state: "malformed" as const }
    : {
        state: "present" as const,
        value: { amount, currency: "USD" as const },
      };
}

function priceFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const price = nativeObject(value);
  if (price === null || price.amount === undefined || price.amount === null) {
    return { state: "malformed" as const };
  }
  return usdMoneyFact(price.amount);
}

function buybackPercentFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const instantBuyback = nativeObject(value);
  if (instantBuyback === null) {
    return { state: "malformed" as const };
  }
  const percent = instantBuyback.percentageOfValue;
  if (percent === undefined || percent === null) {
    return { state: "absent" as const };
  }
  return typeof percent === "number" && Number.isFinite(percent) &&
      percent >= 0 && percent <= 100
    ? { state: "present" as const, value: percent }
    : { state: "malformed" as const };
}

function drawCountFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  return Number.isSafeInteger(value) && (value as number) > 0
    ? { state: "present" as const, value: value as number }
    : { state: "malformed" as const };
}

/** `null` means no reference here; `false` means an unusable value. */
function imageReference(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maxImageReferenceLength) return false;
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" || url.username.length > 0 ||
      url.password.length > 0 || url.hash.length > 0
    ) {
      return false;
    }
    const resolved = url.toString();
    return resolved.length <= maxImageReferenceLength ? resolved : false;
  } catch {
    return false;
  }
}

function imageReferencesFact(nativeData: NativeJsonObject) {
  const references: string[] = [];
  for (const key of ["thumbnailUrl", "imageNobgUrl", "image"] as const) {
    const reference = imageReference(nativeData[key]);
    if (reference === false) return { state: "malformed" as const };
    if (reference !== null && !references.includes(reference)) {
      references.push(reference);
    }
  }
  return references.length === 0
    ? { state: "absent" as const }
    : { state: "present" as const, value: references };
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

/** Exact allowlist for the evidenced Collector Crypt V1 catalog-pack shape. */
export function collectorCryptPackProviderFactsV1(
  nativeData: NativeJsonObject,
): NormalizedPackProviderFacts {
  const empty = emptyNormalizedProviderFacts(
    "pack",
  ) as NormalizedPackProviderFacts;
  return {
    ...empty,
    displayName: normalizedTextFact(nativeData.name),
    // No observed payload carries a description key (0/73).
    description: { state: "absent" },
    category: normalizedTextFact(nativeData.menuCategory),
    imageReferences: imageReferencesFact(nativeData),
    price: priceFact(nativeData.price),
    providerReportedEv: usdMoneyFact(nativeData.targetEV),
    buybackPercent: buybackPercentFact(nativeData.instantBuyback),
    drawCount: drawCountFact(nativeData.contains),
    // Odds-only: weightMultipliers/tierRanges carry no per-bucket quantity,
    // which evInputFromFacts requires. Left absent by design.
    evInput: { state: "absent" },
    authoritativeAvailability: authoritativeAvailabilityFact(
      nativeData.archived,
    ),
  };
}
