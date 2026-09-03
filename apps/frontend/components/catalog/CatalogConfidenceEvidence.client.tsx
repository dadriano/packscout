"use client";

import type { PublicRepackViewSummaryV3 } from "@packscout/contracts";
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import type { PackScoutEvV3Presentation } from "@/lib/packscout-ev-presentation";
import {
  presentProviderHealthV3,
  type ProviderHealthPresentation,
} from "@/lib/provider-health-presentation";
import styles from "./CatalogConfidenceEvidence.module.css";

type CatalogConfidenceEvidenceProps = Readonly<{
  estimate: PackScoutEvV3Presentation;
  providerHealth: PublicRepackViewSummaryV3["providerHealth"];
  repackName: string;
  align?: "start" | "end";
}>;

type CatalogConfidenceEvidenceInput = Readonly<{
  estimate: PackScoutEvV3Presentation;
  providerHealth: ProviderHealthPresentation;
}>;

function uniqueDetails(details: readonly (string | null | undefined)[]) {
  return [...new Set(details.filter((detail): detail is string => Boolean(detail)))];
}

export function catalogConfidenceEvidenceDetails({
  estimate,
  providerHealth,
}: CatalogConfidenceEvidenceInput): readonly string[] {
  const showSourceEvidence =
    estimate.status !== "current" || estimate.freshness.delayed;

  return uniqueDetails([
    estimate.status === "current" ? null : estimate.statusLabel,
    estimate.status === "current" ? null : estimate.reasonCopy,
    showSourceEvidence ? estimate.freshness.sourceAgeLabel : null,
    showSourceEvidence && estimate.freshness.dataAsOf
      ? estimate.freshness.dataAsOfLabel
      : null,
    estimate.status === "current" ? null : estimate.calculationPriceNote,
    providerHealth.state === "healthy" ? null : providerHealth.statusCopy,
    providerHealth.state === "healthy" ? null : providerHealth.observedLabel,
  ]);
}

export function CatalogConfidenceEvidence({
  estimate,
  providerHealth: rawProviderHealth,
  repackName,
  align = "end",
}: CatalogConfidenceEvidenceProps) {
  const providerHealth = presentProviderHealthV3(rawProviderHealth);
  const details = catalogConfidenceEvidenceDetails({ estimate, providerHealth });
  const evidenceLabel = estimate.status !== "current"
    ? estimate.statusLabel
    : estimate.freshness.delayed
      ? "Delayed source evidence"
      : providerHealth.statusLabel;

  return (
    <span className={styles.root}>
      <span
        aria-label={estimate.confidence.accessibleLabel}
        className={styles.value}
        data-tone={estimate.confidence.tone}
      >
        {estimate.confidence.displayValue}
      </span>
      {details.length > 0 ? (
        <GlossaryHint
          align={align}
          details={details}
          detailsHeading="Evidence details"
          field="evConfidence"
          triggerAriaLabel={`View evidence for ${evidenceLabel}: ${repackName}`}
        />
      ) : null}
    </span>
  );
}
