import type {
  PackScoutBuybackEvEvidenceOutcomeV1,
  PackScoutBuybackEvInputV1,
} from "@packscout/contracts";
import type {
  PackScoutBuybackEvEvidenceContextV1,
  PackScoutBuybackEvStablecoinParityApprovalClaimV1,
} from "./buyback-ev-evidence.ts";

/**
 * Fixed, sanitized evidence-normalization context shared by the launch
 * provider fixtures. All timestamps are frozen so normalization output is
 * byte-for-byte deterministic in tests.
 */

export const BUYBACK_EV_FIXTURE_OBSERVED_AT =
  "2026-08-19T17:55:00.000Z" as const;
export const BUYBACK_EV_FIXTURE_EVALUATED_AT =
  "2026-08-19T18:00:00.000Z" as const;

export const BUYBACK_EV_FIXTURE_MANIFEST_SHA256 = "a1b2c3d4".repeat(8);
export const BUYBACK_EV_FIXTURE_GUARD_SHA256 = "e5f60718".repeat(8);
export const BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256 = "29384756".repeat(8);

export const BUYBACK_EV_FIXTURE_USDC_PARITY: PackScoutBuybackEvStablecoinParityApprovalClaimV1 =
  Object.freeze({
    currency: "USDC",
    parityNumerator: 1,
    parityDenominator: 1,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    configurationRevision: "usdc-parity-2026-08",
  });

/** A USDC parity approval whose window closed before the fixture observation. */
export const BUYBACK_EV_FIXTURE_EXPIRED_USDC_PARITY: PackScoutBuybackEvStablecoinParityApprovalClaimV1 =
  Object.freeze({
    currency: "USDC",
    parityNumerator: 1,
    parityDenominator: 1,
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    configurationRevision: "usdc-parity-2026-07",
  });

export function buildBuybackEvFixtureContext(
  overrides: Partial<PackScoutBuybackEvEvidenceContextV1> = {},
): PackScoutBuybackEvEvidenceContextV1 {
  return {
    evaluatedAt: BUYBACK_EV_FIXTURE_EVALUATED_AT,
    stablecoinParityApprovals: [BUYBACK_EV_FIXTURE_USDC_PARITY],
    ...overrides,
  };
}

/**
 * The provider-neutral economics of one complete calculator input: everything
 * except the provenance fields (`product`, `observation`). Equivalent evidence
 * from two providers must project deep-equal here.
 */
export interface BuybackEvEconomicProjectionV1 {
  readonly packPrice: PackScoutBuybackEvInputV1["packPrice"];
  readonly unitBasis: PackScoutBuybackEvInputV1["unitBasis"];
  readonly oddsEvidence: PackScoutBuybackEvInputV1["oddsEvidence"];
  readonly uniformBuybackRate: PackScoutBuybackEvInputV1["uniformBuybackRate"];
  readonly outcomes: PackScoutBuybackEvInputV1["outcomes"];
}

export function buybackEvEconomicProjectionV1(
  input: PackScoutBuybackEvInputV1,
): BuybackEvEconomicProjectionV1 {
  const { packPrice, unitBasis, oddsEvidence, uniformBuybackRate, outcomes } =
    input;
  return { packPrice, unitBasis, oddsEvidence, uniformBuybackRate, outcomes };
}

/** Narrow to the complete branch or fail with the unavailable reasons. */
export function expectBuybackEvCompleteV1(
  outcome: PackScoutBuybackEvEvidenceOutcomeV1,
): PackScoutBuybackEvInputV1 {
  if (outcome.status !== "complete") {
    throw new Error(
      `Expected complete EV evidence, got unavailable: ${outcome.internalReasons.join(", ")}`,
    );
  }
  return outcome.input;
}

/** Narrow to the unavailable branch or fail because evidence was complete. */
export function expectBuybackEvUnavailableV1(
  outcome: PackScoutBuybackEvEvidenceOutcomeV1,
): Extract<PackScoutBuybackEvEvidenceOutcomeV1, { status: "unavailable" }> {
  if (outcome.status !== "unavailable") {
    throw new Error("Expected unavailable EV evidence, got a complete input.");
  }
  return outcome;
}
