import type { EstimatedEvPresentation } from "@/lib/metric-presentation";
import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import { MetricValue } from "./MetricValue";
import styles from "./EstimatedEvMetrics.module.css";

type EstimatedEvMetricsProps = Readonly<{
  presentation: EstimatedEvPresentation;
  compact?: boolean;
  showLongRunExplanation?: boolean;
}>;

export function EstimatedEvMetrics({
  presentation,
  compact = false,
  showLongRunExplanation = true,
}: EstimatedEvMetricsProps) {
  return (
    <section
      className={styles.root}
      data-density={compact ? "compact" : "default"}
      data-state={presentation.semanticState}
    >
      <div className={styles.header}>
        <h3 className={styles.heading}>{METRIC_TRUST_COPY.estimateLabel}</h3>
        <span className={styles.disclaimer}>
          {METRIC_TRUST_COPY.financialDisclaimer}
        </span>
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
        <MetricValue
          compact={compact}
          metric={presentation.packPrice}
          showReason={false}
          showSemanticState={false}
        />
      </div>

      {presentation.reasonCopy ? (
        <p className={styles.reason}>{presentation.reasonCopy}</p>
      ) : null}
      {showLongRunExplanation ? (
        <p className={styles.explanation}>
          {METRIC_TRUST_COPY.longRunExplanation}
        </p>
      ) : null}
    </section>
  );
}
