import type { PackScoutEvPresentation } from "@/lib/metric-presentation";
import {
  EXPECTED_VALUE_ARTICLE_HREF,
  METRIC_TRUST_COPY,
  type GlossaryDefinition,
} from "@/lib/metric-vocabulary";
import { GlossaryHint } from "./GlossaryHint.client";
import { MetricValue } from "./MetricValue";
import styles from "./EstimatedEvMetrics.module.css";

type EstimatedEvMetricsProps = Readonly<{
  presentation: PackScoutEvPresentation;
  compact?: boolean;
  showFinancialDisclaimer?: boolean;
  showRepackPrice?: boolean;
  headingHint?: Pick<GlossaryDefinition, "label" | "definition" | "learnHref">;
}>;

export function EstimatedEvMetrics({
  presentation,
  compact = false,
  showFinancialDisclaimer = true,
  showRepackPrice = true,
  headingHint = {
    label: METRIC_TRUST_COPY.estimateLabel,
    definition: METRIC_TRUST_COPY.longRunExplanation,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
}: EstimatedEvMetricsProps) {
  return (
    <section
      className={styles.root}
      data-density={compact ? "compact" : "default"}
      data-state={presentation.semanticState}
    >
      <div className={styles.header}>
        <h3 className={styles.heading}>
          {METRIC_TRUST_COPY.estimateLabel}
          <GlossaryHint content={headingHint} field="evPercent" />
        </h3>
        {showFinancialDisclaimer ? (
          <span className={styles.disclaimer}>
            {METRIC_TRUST_COPY.financialDisclaimer}
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
          metric={presentation.evPercent}
          showReason={false}
        />
        <MetricValue
          compact={compact}
          metric={presentation.evDollars}
          showReason={false}
          showSemanticState={false}
        />
        <MetricValue
          compact={compact}
          metric={presentation.grossEv}
          showReason={false}
          showSemanticState={false}
        />
        {showRepackPrice ? (
          <MetricValue
            compact={compact}
            metric={presentation.repackPrice}
            showReason={false}
            showSemanticState={false}
          />
        ) : null}
      </div>

      {presentation.reasonCopy ? (
        <p className={styles.reason}>{presentation.reasonCopy}</p>
      ) : null}
    </section>
  );
}
