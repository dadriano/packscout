import { collectorCryptPackProviderFactsV1 } from "./dataforrest-collector-crypt-pack-v1.ts";
import type { NormalizedEvBucket, NormalizedPackProviderFacts } from "./provider-source-facts-v1.ts";

/**
 * V2 retains the odds-only evidence described by V1's 73-machine native census:
 * `weightMultipliers` gives probabilities summing to one; `tierRanges` gives
 * USD `start`/`end` values for the same four tiers. `contains: 1` states one
 * draw. No bucket or pool quantities or collectible memberships are published.
 * Only distributed-v4 admits this additional interpretation; old identities
 * continue to call V1. Currency and instant-buyback semantics are V1's reviewed
 * bindings, never taken from advertised targetEV or topNfts samples.
 */
const tierKeys = ["common", "uncommon", "rare", "epic"] as const;

function nativeObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function evInputFact(
  nativeData: Readonly<Record<string, unknown>>,
  facts: NormalizedPackProviderFacts,
): NormalizedPackProviderFacts["evInput"] {
  const { weightMultipliers, tierRanges } = nativeData;
  if (weightMultipliers == null && tierRanges == null) return { state: "absent" };
  const weights = nativeObject(weightMultipliers), ranges = nativeObject(tierRanges);
  if (weights === null || ranges === null || Object.keys(weights).length !== tierKeys.length ||
      Object.keys(ranges).length !== tierKeys.length ||
      facts.drawCount.state !== "present" || facts.drawCount.value !== 1) {
    return { state: "malformed" };
  }
  const buckets: NormalizedEvBucket[] = [];
  let totalProbability = 0;
  for (const bucketId of tierKeys) {
    const probability = weights[bucketId], range = nativeObject(ranges[bucketId]);
    const lowerValue = range?.start, upperValue = range?.end;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1 ||
        typeof lowerValue !== "number" || !Number.isFinite(lowerValue) || lowerValue < 0 ||
        typeof upperValue !== "number" || !Number.isFinite(upperValue) || upperValue < lowerValue) {
      return { state: "malformed" };
    }
    totalProbability += probability;
    if (probability === 0) continue;
    buckets.push({ bucketId, label: null, probability, quantity: null, lowerValue, upperValue });
  }
  if (Math.abs(totalProbability - 1) > 0.000_000_01 || buckets.length === 0) {
    return { state: "malformed" };
  }
  return { state: "present", value: {
    approved: true, currency: "USD", unitBasis: "per_pack", drawCount: 1,
    buybackPercent: facts.buybackPercent.state === "present" ? facts.buybackPercent.value : null,
    totalQuantity: null, buckets,
  } };
}

export function collectorCryptPackProviderFactsV2(
  nativeData: Readonly<Record<string, unknown>>,
): NormalizedPackProviderFacts {
  const facts = collectorCryptPackProviderFactsV1(nativeData);
  return { ...facts, evInput: evInputFact(nativeData, facts) };
}
