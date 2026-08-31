import { PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION } from "@packscout/contracts";

export function dataReleaseV3PresentationContext(evaluationTime: number) {
  return {
    publicFreshnessPolicyVersion: PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
    confidenceEvaluatedAt: new Date(evaluationTime).toISOString(),
  } as const;
}

export function dataReleaseV3ProviderHealthContext(evaluationTime: number) {
  return { providerHealthEvaluatedAt: new Date(evaluationTime).toISOString() } as const;
}
