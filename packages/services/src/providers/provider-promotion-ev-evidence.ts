import { providerPackEvEvidenceV1Schema, type PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import { normalizeClutchpacksPromotionEvEvidenceV1 } from "./clutchpacks/promotion-ev-evidence.ts";
import { normalizePhygitalsPromotionEvEvidenceV1 } from "./phygitals/promotion-ev-evidence.ts";

export class ProviderPromotionEvEvidenceError extends Error {
  constructor(readonly code: "EVIDENCE_INVALID") {
    super("Provider promotion EV evidence is invalid.");
    this.name = "ProviderPromotionEvEvidenceError";
  }
}

/**
 * Provider boundary for promotion-time EV. Unsupported or incomplete retained
 * evidence returns null and remains publicly unavailable; provider rules never
 * leak into the generic release script.
 */
export async function normalizeProviderPromotionEvEvidenceV1(input: Readonly<{
  organizationId: string;
  providerId: string;
  packId: string;
  packKey: string;
  rowVersion: string;
  priceUsdMinor: number;
  buybackRateBasisPoints: number | null;
  sourceUpdatedAt: string;
  snapshotAt: string;
  readAt: string;
  evidence: unknown;
}>): Promise<PackScoutBuybackEvEvidenceOutcomeV1 | null> {
  if (input.evidence === undefined) return null;
  const parsed = providerPackEvEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success) throw new ProviderPromotionEvEvidenceError("EVIDENCE_INVALID");
  if (
    parsed.data.evInput.state !== "present" ||
    parsed.data.evInput.value.approved !== true
  ) {
    return null;
  }
  if (parsed.data.providerKey === "clutchpacks") {
    return normalizeClutchpacksPromotionEvEvidenceV1(input);
  }
  if (parsed.data.providerKey === "phygitals") {
    return normalizePhygitalsPromotionEvEvidenceV1(input);
  }
  return null;
}
