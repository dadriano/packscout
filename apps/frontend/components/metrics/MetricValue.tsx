import { GlossaryHint } from "./GlossaryHint.client";
import type { MetricValuePresentation } from "@/lib/metric-presentation";
import type { GlossaryDefinition } from "@/lib/metric-vocabulary";
import styles from "./MetricValue.module.css";

type MetricValueProps = Readonly<{
  metric: MetricValuePresentation;
  compact?: boolean;
  glossaryAlign?: "start" | "end";
  glossaryContent?: Pick<GlossaryDefinition, "label" | "definition" | "learnHref">;
  showGlossary?: boolean;
  showLabel?: boolean;
  showReason?: boolean;
  showSemanticState?: boolean;
}>;

export function MetricValue({
  metric,
  compact = false,
  glossaryAlign = "start",
  glossaryContent,
  showGlossary = true,
  showLabel = true,
  showReason = true,
  showSemanticState = true,
}: MetricValueProps) {
  const hasSignedState =
    metric.semanticState !== undefined &&
    metric.semanticState !== "unavailable";
  const showLabelRow = showLabel || showGlossary;

  return (
    <div
      className={styles.root}
      data-density={compact ? "compact" : "default"}
      data-state={metric.semanticState ?? "plain"}
    >
      {showLabelRow ? (
        <div className={styles.labelRow}>
          {showLabel ? <span className={styles.label}>{metric.label}</span> : null}
          {showGlossary ? (
            <GlossaryHint
              align={glossaryAlign}
              content={glossaryContent}
              field={metric.glossaryKey}
            />
          ) : null}
        </div>
      ) : null}

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
