import type {
  PackScoutEstimatedEvCurrencyTreatment,
  PackScoutEstimatedEvEvidence,
  PackScoutEstimatedEvLimitation,
  PackScoutEstimatedEvUnavailableReason,
  PackScoutEstimatedEvUnitBasis,
} from "./estimated-ev-calculator.ts";

export const ESTIMATED_EV_PROJECTION_SCHEMA_VERSION =
  "packscout-estimated-ev-projection-v2" as const;

export interface EstimatedEvInputManifestBucket {
  readonly bucketId: string;
  readonly probability: number | null;
  readonly lowerValueMinor: number | null;
  readonly upperValueMinor: number | null;
  readonly sourceRevisionId: string;
}

export interface EstimatedEvInputManifest {
  readonly packRevisionId: string | null;
  readonly evInputRevisionId: string | null;
  readonly packPriceValueMinor: number | null;
  readonly packPriceCurrency: string | null;
  readonly packPriceMinorUnitExponent: number | null;
  readonly distributionCurrency: string | null;
  readonly distributionMinorUnitExponent: number | null;
  readonly unitBasis: PackScoutEstimatedEvUnitBasis | null;
  readonly drawCount: number | null;
  readonly declaredCoverage: number | null;
  readonly evidenceCompleteness: "complete" | "partial" | "unknown";
  readonly buckets: readonly EstimatedEvInputManifestBucket[];
  readonly sourceAt: string | null;
  readonly verifiedUsdStablecoins: readonly string[];
}

export interface CanonicalEstimatedEvProjectionContent {
  readonly schemaVersion: typeof ESTIMATED_EV_PROJECTION_SCHEMA_VERSION;
  readonly label: "PackScout Estimated EV";
  readonly calculationFingerprint: string;
  readonly status: "estimated" | "unavailable";
  readonly grossValueMinor: number | null;
  readonly minorUnitExponent: 2 | null;
  readonly evPercent: number | null;
  readonly currency: "USD" | null;
  readonly method: string;
  readonly methodVersion: string;
  readonly coveragePercent: number;
  readonly inputCount: number;
  readonly sourceAt: string | null;
  readonly calculatedAt: string;
  readonly reasonCodes: readonly PackScoutEstimatedEvUnavailableReason[];
  readonly evidence: PackScoutEstimatedEvEvidence;
  readonly inputManifest: EstimatedEvInputManifest;
}

export interface PackScoutProviderReportedEvExplanation {
  readonly status: "reported";
  readonly valueMinor: number;
  readonly currency: string;
  readonly minorUnitExponent: number;
  readonly sourceAt: string;
  readonly sourceRevisionId: string;
}

export interface PackScoutEstimatedEvExplanation {
  readonly label: "PackScout Estimated EV";
  readonly status: "estimated" | "unavailable";
  readonly grossValueMinor: number | null;
  readonly minorUnitExponent: 2 | null;
  readonly evPercent: number | null;
  readonly currency: "USD" | null;
  readonly unitBasis: PackScoutEstimatedEvUnitBasis | null;
  readonly unitLabel: "per draw" | "per pack" | null;
  readonly method: string;
  readonly methodVersion: string;
  readonly coveragePercent: number;
  readonly inputCount: number;
  readonly sourceAt: string | null;
  readonly calculatedAt: string;
  readonly reasonCodes: readonly PackScoutEstimatedEvUnavailableReason[];
  readonly limitations: readonly PackScoutEstimatedEvLimitation[];
  readonly sourceRevisionIds: readonly string[];
  readonly currencyTreatment: Readonly<{
    price: PackScoutEstimatedEvCurrencyTreatment;
    distribution: PackScoutEstimatedEvCurrencyTreatment;
    policy: "usd_and_explicit_verified_usd_stablecoins_v1";
  }>;
  readonly providerReportedEv: PackScoutProviderReportedEvExplanation | null;
}

export interface RecalculatePackScoutEstimatedEvCommand {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly evInputExternalId: string;
  readonly calculatedAt: string;
  readonly currencyPolicy: Readonly<{
    verifiedUsdStablecoins: readonly string[];
  }>;
}

export interface ExplainPackScoutEstimatedEvQuery {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
}

export type RecalculatePackScoutEstimatedEvResult = Readonly<{
  persistenceStatus: "revised" | "unchanged";
  calculationRevisionId: string;
  calculationRevisionNumber: number;
  explanation: PackScoutEstimatedEvExplanation;
}>;
