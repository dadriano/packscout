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
  statusCopy: string;
  observedAt: string | null;
  observedLabel: string | null;
  accessibleLabel: string;
}>;

/**
 * Formats informational provider health without exposing its operational
 * cause vocabulary. Feed health never changes EV visibility or ranking;
 * source-evidence age is represented separately by confidence.
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
  const statusCopy = health.state === "healthy"
    ? "Displaying the latest available provider data."
    : health.state === "unavailable"
      ? "Provider feed status is unavailable; displaying the latest available data."
      : "Provider feed delayed; displaying the latest available data.";
  const observedLabel =
    health.observedAt === null
      ? null
      : `Provider health observed ${formatPublicTimestamp(health.observedAt)}`;

  return Object.freeze({
    state: health.state,
    statusLabel,
    statusCopy,
    observedAt: health.observedAt,
    observedLabel,
    accessibleLabel: [statusLabel + ".", statusCopy, observedLabel]
      .filter(Boolean)
      .join(" "),
  });
}
