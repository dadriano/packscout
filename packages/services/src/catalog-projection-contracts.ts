import type { ProviderDataQualityEvidence } from "./provider-adapter.ts";

export const CATALOG_PROJECTION_VERSION = "catalog-projection-v2" as const;
export const EV_INPUT_COVERAGE_TOLERANCE = 0.000_001;

export type CanonicalAvailability =
  | "active"
  | "disabled"
  | "sold_out"
  | "unknown";

export interface CanonicalDataQualityEvidence {
  readonly code: string;
  readonly severity: ProviderDataQualityEvidence["severity"];
  readonly fieldPath: string | null;
}

export interface CanonicalPackProjectionContent {
  readonly schemaVersion: typeof CATALOG_PROJECTION_VERSION;
  readonly entityType: "pack";
  readonly parentExternalId: string | null;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
  readonly availability: CanonicalAvailability;
  readonly sourceStatus: string | null;
  readonly priceValueMinor: number | null;
  readonly priceCurrency: string | null;
  readonly priceMinorUnitExponent: number | null;
  readonly providerReportedEvValueMinor: number | null;
  readonly providerReportedEvCurrency: string | null;
  readonly providerReportedEvMinorUnitExponent: number | null;
  readonly buybackPercent: number | null;
  readonly drawCount: number | null;
  readonly imageUrls: readonly string[];
  readonly dataQualityEvidence: readonly CanonicalDataQualityEvidence[];
}

export interface CanonicalCatalogAssetProjectionContent {
  readonly schemaVersion: typeof CATALOG_PROJECTION_VERSION;
  readonly entityType: "catalog_asset";
  readonly assetType: string | null;
  readonly relatedPackExternalId: string | null;
  readonly parentExternalId: string | null;
  readonly name: string | null;
  readonly category: string | null;
  readonly availability: CanonicalAvailability;
  readonly sourceStatus: string | null;
  readonly providerValueMinor: number | null;
  readonly providerValueCurrency: string | null;
  readonly providerValueMinorUnitExponent: number | null;
  readonly valueSource: string | null;
  readonly imageUrls: readonly string[];
  readonly dataQualityEvidence: readonly CanonicalDataQualityEvidence[];
}

export type CanonicalEvInputReadinessReason =
  | "declared_coverage_mismatch"
  | "incomplete_inventory"
  | "incomplete_probability_coverage"
  | "invalid_currency"
  | "invalid_draw_count"
  | "invalid_probability"
  | "invalid_value_bound"
  | "invalid_value_range"
  | "missing_probability"
  | "missing_probability_buckets"
  | "missing_unit_basis"
  | "missing_value_bound";

export interface CanonicalProbabilityBucketEvidence {
  readonly bucketId: string;
  readonly label: string | null;
  readonly probability: number | null;
  readonly lowerValueMinor: number | null;
  readonly upperValueMinor: number | null;
}

export interface CanonicalTopChaseEvidence {
  readonly bucketId: string;
  readonly label: string | null;
  readonly probability: number | null;
  readonly lowerValueMinor: number | null;
  readonly upperValueMinor: number | null;
}

export interface CanonicalEvCoverageEvidence {
  readonly declaredCoverage: number | null;
  readonly calculatedCoverage: number;
  readonly tolerance: typeof EV_INPUT_COVERAGE_TOLERANCE;
  readonly probabilityBucketCount: number;
  readonly topChaseCount: number;
}

export interface CanonicalEvInputReadiness {
  readonly status: "ready" | "unavailable";
  readonly reasons: readonly CanonicalEvInputReadinessReason[];
}

export interface CanonicalEvInputProjectionContent {
  readonly schemaVersion: typeof CATALOG_PROJECTION_VERSION;
  readonly entityType: "ev_input";
  readonly packExternalId: string;
  readonly currency: string | null;
  readonly minorUnitExponent: number | null;
  readonly unitBasis: "per_draw" | "per_pack" | null;
  readonly drawCount: number | null;
  readonly evidenceCompleteness: "complete" | "partial" | "unknown";
  readonly coverage: CanonicalEvCoverageEvidence;
  readonly probabilityBuckets: readonly CanonicalProbabilityBucketEvidence[];
  readonly topChases: readonly CanonicalTopChaseEvidence[];
  readonly readiness: CanonicalEvInputReadiness;
  readonly dataQualityEvidence: readonly CanonicalDataQualityEvidence[];
}

export interface CanonicalCatalogProjectionProvenance {
  readonly projectionVersion: typeof CATALOG_PROJECTION_VERSION;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly adapterKey: string;
  readonly sourceRecordKind: "catalog" | "pull" | "trade";
  readonly sourceRecordIndex: number;
  readonly sourceExternalId: string;
}
