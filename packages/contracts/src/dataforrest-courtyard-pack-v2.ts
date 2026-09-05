import { courtyardPackProviderFactsV1 } from "./dataforrest-courtyard-pack-v1.ts";
import type { NormalizedEvBucket, NormalizedPackProviderFacts } from "./provider-source-facts-v1.ts";

/**
 * V2 retains the odds-only evidence described by V1's 109-pack native census:
 * `odds.buckets[].{oddsPercent,minValueUsd,maxValueUsd}` states one card's
 * probability and closed USD value range. It never states inventory counts.
 * The new distributed-v4 admission deliberately retains this evidence for EV
 * promotion; V1 and every previous adapter interpretation remain unchanged.
 * Bucket keys are local positions within this source revision, not collectible
 * identities. Native tier labels and pack membership are not inferred.
 */
function evInputFact(
  value: unknown,
  facts: NormalizedPackProviderFacts,
): NormalizedPackProviderFacts["evInput"] {
  if (value === undefined || value === null) return { state: "absent" };
  const odds = typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  const entries = odds?.buckets;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1_000) {
    return { state: "malformed" };
  }
  const buckets: NormalizedEvBucket[] = [];
  let totalPercent = 0;
  for (const [index, value] of entries.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { state: "malformed" };
    }
    const entry = value as Readonly<Record<string, unknown>>;
    const { oddsPercent, minValueUsd, maxValueUsd } = entry;
    if (
      typeof oddsPercent !== "number" || !Number.isFinite(oddsPercent) ||
      oddsPercent < 0 || oddsPercent > 100 ||
      typeof minValueUsd !== "number" || !Number.isFinite(minValueUsd) || minValueUsd < 0 ||
      typeof maxValueUsd !== "number" || !Number.isFinite(maxValueUsd) || maxValueUsd < minValueUsd
    ) return { state: "malformed" };
    totalPercent += oddsPercent;
    if (oddsPercent === 0) continue;
    buckets.push({ bucketId: `bucket-${index + 1}`, label: null,
      probability: oddsPercent / 100, quantity: null,
      lowerValue: minValueUsd, upperValue: maxValueUsd });
  }
  if (Math.abs(totalPercent - 100) > 0.000_001 || buckets.length === 0 ||
      facts.drawCount.state !== "present" || facts.drawCount.value !== 1) {
    return { state: "malformed" };
  }
  return { state: "present", value: {
    approved: true, currency: "USD", unitBasis: "per_pack", drawCount: 1,
    buybackPercent: facts.buybackPercent.state === "present" ? facts.buybackPercent.value : null,
    totalQuantity: null, buckets,
  } };
}

export function courtyardPackProviderFactsV2(
  nativeData: Readonly<Record<string, unknown>>,
): NormalizedPackProviderFacts {
  const facts = courtyardPackProviderFactsV1(nativeData);
  return { ...facts, evInput: evInputFact(nativeData.odds, facts) };
}
