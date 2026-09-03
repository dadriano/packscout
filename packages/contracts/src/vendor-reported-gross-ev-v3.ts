import type { PublicRepackSummaryDisplayedV3 } from "./data-release-v3-entities.ts";
import { PROVIDER_REPORTED_EV_BASIS_V1 } from "./provider-reported-ev-basis-v1.ts";

export type VendorReportedGrossEvV3Input = Pick<PublicRepackSummaryDisplayedV3,
  "vendorKey" | "price" | "buyback" | "evEstimates">;

export type VendorReportedGrossEvV3 = Readonly<{
  grossEvMoney: Readonly<{ minorUnits: number; currency: "USD" }>;
  grossReturnBasisPoints: number;
  evDollarsMoney: Readonly<{ minorUnits: number; currency: "USD" }>;
  evPercentBasisPoints: number;
  observedAt: string;
}>;

export type VendorReportedGrossEvCalculationV3Input = Readonly<{
  vendorKey: string;
  priceUsdMinor: number | null;
  vendorReportedEvUsdMinor: number | null;
  buybackRateBasisPoints: number | null;
}>;

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function roundHalfUp(numerator: bigint, denominator: bigint): number {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/**
 * Gross EV from a reviewed platform's reported underlying value and uniform
 * buyback. This is a platform-derived metric, never a PackScout calculation
 * or confidence claim. Round dollars to cents, then divide those dollars by
 * the current price, so displayed money and return agree at every price.
 */
export function calculateVendorReportedGrossEvV3(
  input: VendorReportedGrossEvCalculationV3Input,
): Omit<VendorReportedGrossEvV3, "observedAt"> | null {
  const underlyingMinor = input.vendorReportedEvUsdMinor;
  const priceMinor = input.priceUsdMinor;
  const rate = input.buybackRateBasisPoints;
  if (PROVIDER_REPORTED_EV_BASIS_V1[input.vendorKey] !== "underlying_outcome_value" ||
      underlyingMinor === null || priceMinor === null || rate === null) return null;
  if (!nonNegativeSafeInteger(underlyingMinor) || !nonNegativeSafeInteger(priceMinor) ||
      priceMinor === 0 || !nonNegativeSafeInteger(rate) || rate > 10_000) return null;

  const grossMinor = roundHalfUp(BigInt(underlyingMinor) * BigInt(rate), 10_000n);
  const grossReturnBasisPoints = roundHalfUp(BigInt(grossMinor) * 10_000n, BigInt(priceMinor));
  if (!nonNegativeSafeInteger(grossReturnBasisPoints)) return null;
  return {
    grossEvMoney: { minorUnits: grossMinor, currency: "USD" },
    grossReturnBasisPoints,
    evDollarsMoney: { minorUnits: grossMinor - priceMinor, currency: "USD" },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

export function vendorReportedGrossEvV3(
  input: VendorReportedGrossEvV3Input,
): VendorReportedGrossEvV3 | null {
  const reported = input.evEstimates.vendorReported;
  const price = input.price.usdComparison;
  if (reported.status !== "available" || reported.usdComparison.status !== "available" ||
      input.buyback.kind !== "uniform_rate" || price.status !== "available") return null;
  const metrics = calculateVendorReportedGrossEvV3({
    vendorKey: input.vendorKey,
    priceUsdMinor: price.value.minorUnits,
    vendorReportedEvUsdMinor: reported.usdComparison.value.minorUnits,
    buybackRateBasisPoints: input.buyback.rateBasisPoints,
  });
  return metrics === null ? null : { ...metrics, observedAt: reported.observedAt };
}
