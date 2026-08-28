import type { PublicRepackViewSummaryV3 } from "@packscout/contracts";
import { formatPublicTimestamp } from "./packscout-ev-presentation";

export type PublicProviderHealthV3 =
  PublicRepackViewSummaryV3["providerHealth"];

export type ProviderHealthPresentation = Readonly<{
  state: PublicProviderHealthV3["state"];
  statusLabel:
    | "Provider feed healthy"
    | "Provider feed delayed"
    | "Provider feed unavailable";
  rankingEligible: boolean;
  rankingLabel: string;
  observedAt: string | null;
  observedLabel: string | null;
  accessibleLabel: string;
}>;

/**
 * Formats the bounded public provider-health decision without exposing its
 * operational cause vocabulary. Health controls Top Opportunities only; it
 * never changes whether the already-calculated EV metrics are presentable.
 */
export function presentProviderHealthV3(
  health: PublicProviderHealthV3,
): ProviderHealthPresentation {
  const statusLabel =
    health.state === "healthy"
      ? "Provider feed healthy"
      : health.state === "delayed"
        ? "Provider feed delayed"
        : "Provider feed unavailable";
  const rankingLabel = health.rankingEligible
    ? "Eligible for Top Opportunities."
    : health.state === "unavailable"
      ? "Provider feed unavailable; excluded from Top Opportunities."
      : "Provider feed delayed; excluded from Top Opportunities.";
  const observedLabel =
    health.observedAt === null
      ? null
      : `Provider health observed ${formatPublicTimestamp(health.observedAt)}`;

  return Object.freeze({
    state: health.state,
    statusLabel,
    rankingEligible: health.rankingEligible,
    rankingLabel,
    observedAt: health.observedAt,
    observedLabel,
    accessibleLabel: [statusLabel + ".", rankingLabel, observedLabel]
      .filter(Boolean)
      .join(" "),
  });
}
