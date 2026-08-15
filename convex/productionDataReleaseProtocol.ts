import {
  productionManifestFingerprintBody,
  recomputeProductionManifestFingerprint as recomputeSharedManifestFingerprint,
  type ProductionStartRequest,
} from "@packscout/contracts";

export * from "@packscout/contracts";

/** Compatibility wrapper retained for existing Convex lifecycle callers. */
export function manifestFingerprintBody(request: ProductionStartRequest): unknown {
  return productionManifestFingerprintBody(request.manifest);
}

/** Compatibility wrapper retained for existing Convex lifecycle callers. */
export function recomputeProductionManifestFingerprint(
  request: ProductionStartRequest,
): Promise<string> {
  return recomputeSharedManifestFingerprint(request.manifest);
}
