import {
  assertPublicPackCatalogBytes, deriveProviderPackInputDigests, deriveProviderPackProfilePrerequisites,
  deriveProviderPackReadinessDecision, normalizeProviderPackBuildInputs, packCatalogCanonicalByteCount, packPublicationLimits,
  type ProviderPackBuildInputs, type ProviderPackReadiness, type PublicPackSnapshot,
} from "@packscout/contracts";

/** No clock, network, or EV calculation: evaluate only the captured identities. */
export class ProviderPackReadinessEvaluator {
  async evaluate(input: {
    candidate: ProviderPackBuildInputs;
    evaluatedAt: string;
    previousSnapshot?: PublicPackSnapshot | null;
    representedDigest?: string | null;
  }): Promise<{ inputs: ProviderPackBuildInputs; readiness: ProviderPackReadiness }> {
    const inputs = normalizeProviderPackBuildInputs(input.candidate, input.previousSnapshot);
    assertPublicPackCatalogBytes(inputs);
    if (packCatalogCanonicalByteCount(inputs) > packPublicationLimits.maximumInputBytes) {
      throw new TypeError("pack.inputs_too_large");
    }
    const readiness: ProviderPackReadiness = {
      outcome: "ready", reasonCode: null,
      ...await deriveProviderPackInputDigests(inputs),
      requiredProfileSnapshotIds: deriveProviderPackProfilePrerequisites(inputs),
    };
    Object.assign(readiness, await deriveProviderPackReadinessDecision(inputs, readiness.evInputsSha256, input.evaluatedAt));
    if (readiness.outcome === "ready" && input.representedDigest === readiness.desiredStateSha256) readiness.outcome = "no_change";
    return { inputs, readiness };
  }
}
