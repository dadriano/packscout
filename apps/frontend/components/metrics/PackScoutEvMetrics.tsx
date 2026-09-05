import type { GrossEvV3Presentation, PackScoutEvV3Presentation } from "@/lib/packscout-ev-presentation";
import {
  EXPECTED_VALUE_ARTICLE_HREF,
  METRIC_TRUST_COPY,
  type GlossaryDefinition,
} from "@/lib/metric-vocabulary";
import { GlossaryHint } from "./GlossaryHint.client";
import { MetricValue } from "./MetricValue";
import styles from "./PackScoutEvMetrics.module.css";

type PackScoutEvMetricsProps = Readonly<{
  presentation: PackScoutEvV3Presentation;
  grossEvPresentation?: GrossEvV3Presentation;
  compact?: boolean;
  showFreshness?: boolean;
  showRepackPrice?: boolean;
  showProvenance?: boolean;
  confidenceDetails?: readonly string[];
  headingHint?: Pick<GlossaryDefinition, "label" | "definition" | "learnHref">;
}>;

/** Evidence stays available from the confidence value without filling the panel. */
export function confidenceEvidenceDetails(
  presentation: PackScoutEvV3Presentation,
  showFreshness = true,
): readonly string[] {
  const { freshness } = presentation;
  return [...new Set([
    ...presentation.confidence.limitations,
    presentation.reasonCopy,
    presentation.zeroPayoutNote,
    presentation.calculationPriceNote,
    ...(showFreshness ? [
      freshness.sourceAgeLabel,
      freshness.calculatedLabel,
      freshness.dataAsOfLabel,
      freshness.confidenceEvaluatedLabel,
      freshness.soldOutLabel,
    ] : []),
  ].filter((detail): detail is string => Boolean(detail)))];
}

/** Values and accessible signs come from the shared presentation boundary. */
export function PackScoutEvMetrics({
  presentation,
  grossEvPresentation,
  compact = false,
  showFreshness = true,
  showRepackPrice = true,
  showProvenance = true,
  confidenceDetails = [],
  headingHint = {
    label: METRIC_TRUST_COPY.estimateLabel,
    definition: METRIC_TRUST_COPY.longRunExplanation,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
}: PackScoutEvMetricsProps) {
  const platformDetails = [
    grossEvPresentation?.sourceNote,
    grossEvPresentation?.observedLabel,
  ].filter((detail): detail is string => Boolean(detail));
  const evidenceDetails = [...new Set([
    ...confidenceEvidenceDetails(presentation, showFreshness),
    ...(grossEvPresentation?.source === "vendor_reported"
      ? ["Platform-reported EV does not establish an independent confidence score."]
      : []),
    ...confidenceDetails,
  ])];
  return (
    <section
      className={styles.root}
      data-density={compact ? "compact" : "default"}
      data-state={presentation.semanticState}
      data-status={presentation.status}
    >
      {grossEvPresentation?.source === "vendor_reported" ? (
        <section aria-label="EV from platform data" className={styles.root}>
          <h3 className={styles.heading}>Expected value</h3>
          <div className={styles.metrics}>
            <MetricValue compact={compact} glossaryDetails={platformDetails} glossaryDetailsHeading="Source" metric={grossEvPresentation.grossEvDollars} showReason={false} />
            <MetricValue compact={compact} glossaryDetails={platformDetails} glossaryDetailsHeading="Source" metric={grossEvPresentation.grossEvPercent} showReason={false} />
            <MetricValue compact={compact} glossaryDetails={platformDetails} glossaryDetailsHeading="Source" metric={grossEvPresentation.evDollars} showSemanticState={false} />
            <MetricValue compact={compact} glossaryDetails={platformDetails} glossaryDetailsHeading="Source" metric={grossEvPresentation.evPercent} showSemanticState={false} />
          </div>
        </section>
      ) : null}
      <div className={styles.header}>
        <h3 className={styles.heading}>
          {grossEvPresentation?.source === "vendor_reported"
            ? "Independent PackScout estimate"
            : METRIC_TRUST_COPY.estimateLabel}
          <GlossaryHint content={headingHint} field="evPercent" />
        </h3>
        <span className={styles.statusChip} data-status={presentation.status}>
          {presentation.statusLabel}
        </span>
        {presentation.simulatedLabel ? (
          <span className={styles.simulatedChip}>
            {presentation.simulatedLabel}
          </span>
        ) : null}
      </div>

      <div
        aria-label={presentation.confidence.accessibleLabel}
        className={styles.confidence}
        data-tone={presentation.confidence.tone}
      >
        <span>EV confidence</span>
        <GlossaryHint
          align="end"
          details={evidenceDetails}
          detailsHeading="Confidence evidence"
          field="evConfidence"
          trigger={
            <>
              <strong>{presentation.confidence.displayValue}</strong>
              <span aria-hidden="true" className={styles.hintMark}>i</span>
            </>
          }
          triggerAriaLabel={`${presentation.confidence.accessibleLabel} View confidence evidence.`}
          triggerClassName={styles.confidenceTrigger}
        />
      </div>

      <div className={styles.metrics}>
        {grossEvPresentation?.source !== "vendor_reported" ? (
          <>
            <MetricValue
              compact={compact}
              metric={presentation.grossEvDollars}
              showReason={false}
              showSemanticState={false}
            />
            <MetricValue
              compact={compact}
              metric={presentation.grossEvPercent}
              showReason={false}
              showSemanticState={false}
            />
            <MetricValue
              compact={compact}
              metric={presentation.evDollars}
              showReason={false}
              showSemanticState={false}
            />
            <MetricValue
              compact={compact}
              metric={presentation.evPercent}
              showReason={false}
              showSemanticState={false}
            />
          </>
        ) : null}
        {showRepackPrice ? (
          <MetricValue
            compact={compact}
            metric={presentation.packPrice}
            showReason={false}
            showSemanticState={false}
          />
        ) : null}
      </div>

      {showProvenance ? (
        <div className={styles.provenance}>
          <p>{presentation.sourceLine}</p>
          <p>{presentation.adviceLine}</p>
        </div>
      ) : null}
    </section>
  );
}
