import { GlossaryHint } from "./GlossaryHint.client";
import type { MetricValuePresentation } from "@/lib/metric-presentation";
import styles from "./MetricValue.module.css";

type MetricValueProps = Readonly<{
  metric: MetricValuePresentation;
  compact?: boolean;
  glossaryAlign?: "start" | "end";
  showGlossary?: boolean;
  showReason?: boolean;
  showSemanticState?: boolean;
}>;

export function MetricValue({
  metric,
  compact = false,
  glossaryAlign = "start",
  showGlossary = true,
  showReason = true,
  showSemanticState = true,
}: MetricValueProps) {
  const hasSignedState =
    metric.semanticState !== undefined &&
    metric.semanticState !== "unavailable";

  return (
    <div
      className={styles.root}
      data-density={compact ? "compact" : "default"}
      data-state={metric.semanticState ?? "plain"}
    >
      <div className={styles.labelRow}>
        <span className={styles.label}>{metric.label}</span>
        {showGlossary ? (
          <GlossaryHint align={glossaryAlign} field={metric.glossaryKey} />
        ) : null}
      </div>

      <div className={styles.valueRow}>
        <span aria-hidden="true" className={styles.value}>
          {metric.displayValue}
        </span>
        <span className="sr-only">{metric.accessibleLabel}</span>
        {showSemanticState && hasSignedState ? (
          <span aria-hidden="true" className={styles.stateLabel}>
            {metric.semanticLabel}
          </span>
        ) : null}
      </div>

      {showReason && metric.availability === "unavailable" ? (
        <span aria-hidden="true" className={styles.reason}>
          {metric.reasonCopy}
        </span>
      ) : null}
    </div>
  );
}
