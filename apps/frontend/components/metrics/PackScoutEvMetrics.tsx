import type { PackScoutEvV3Presentation } from "@/lib/packscout-ev-presentation";
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
  compact?: boolean;
  showFreshness?: boolean;
  showRepackPrice?: boolean;
  showProvenance?: boolean;
  headingHint?: Pick<GlossaryDefinition, "label" | "definition" | "learnHref">;
}>;

/**
 * The shared four-metric PackScout block: Gross EV $, Gross EV %, EV $, and
 * EV % beside Pack Price, with confidence, status, freshness, and the
 * required source and advice lines. Every value arrives pre-formatted from
 * the presentation boundary; this component renders and never calculates.
 */
export function PackScoutEvMetrics({
  presentation,
  compact = false,
  showFreshness = true,
  showRepackPrice = true,
  showProvenance = true,
  headingHint = {
    label: METRIC_TRUST_COPY.estimateLabel,
    definition: METRIC_TRUST_COPY.longRunExplanation,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
}: PackScoutEvMetricsProps) {
  const { freshness } = presentation;
  return (
    <section
      className={styles.root}
      data-density={compact ? "compact" : "default"}
      data-state={presentation.semanticState}
      data-status={presentation.status}
    >
      <div className={styles.header}>
        <h3 className={styles.heading}>
          {METRIC_TRUST_COPY.estimateLabel}
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
        data-band={presentation.confidence.band ?? "unavailable"}
      >
        <span className={styles.confidenceLabel}>
          EV confidence
          <GlossaryHint
            content={{
              label: "EV confidence",
              definition: METRIC_TRUST_COPY.confidenceExplanation,
              learnHref: EXPECTED_VALUE_ARTICLE_HREF,
            }}
            field="evConfidence"
          />
        </span>
        <strong>{presentation.confidence.displayValue}</strong>
      </div>

      <div className={styles.metrics}>
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
        />
        <MetricValue
          compact={compact}
          metric={presentation.evPercent}
          showReason={false}
          showSemanticState={false}
        />
        {showRepackPrice ? (
          <MetricValue
            compact={compact}
            metric={presentation.packPrice}
            showReason={false}
            showSemanticState={false}
          />
        ) : null}
      </div>

      {presentation.zeroPayoutNote ? (
        <p className={styles.note}>{presentation.zeroPayoutNote}</p>
      ) : null}
      {presentation.reasonCopy ? (
        <p className={styles.reason}>{presentation.reasonCopy}</p>
      ) : null}

      {showFreshness ? (
        <div className={styles.freshness}>
          <p>
            <time dateTime={freshness.calculatedAt}>
              {freshness.calculatedLabel}
            </time>
          </p>
          <p>
            {freshness.dataAsOf ? (
              <time dateTime={freshness.dataAsOf}>{freshness.dataAsOfLabel}</time>
            ) : (
              freshness.dataAsOfLabel
            )}
          </p>
          {freshness.sourceAgeLabel ? (
            <p data-delayed={freshness.delayed}>{freshness.sourceAgeLabel}</p>
          ) : null}
          {freshness.soldOutLabel && freshness.soldOutAt ? (
            <p>
              <time dateTime={freshness.soldOutAt}>{freshness.soldOutLabel}</time>
            </p>
          ) : null}
        </div>
      ) : null}

      {showProvenance ? (
        <div className={styles.provenance}>
          <p>{presentation.sourceLine}</p>
          <p>{presentation.adviceLine}</p>
        </div>
      ) : null}
    </section>
  );
}
