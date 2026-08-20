import type { PackScoutEvV3Presentation } from "@/lib/packscout-ev-presentation";
import { MetricValue } from "./MetricValue";
import styles from "./PackScoutEvMetrics.module.css";

type PackScoutEvMetricsProps = Readonly<{
  presentation: PackScoutEvV3Presentation;
  compact?: boolean;
  showFreshness?: boolean;
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
        <h3 className={styles.heading}>PackScout Gross EV</h3>
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
        <span>EV confidence</span>
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
        <MetricValue
          compact={compact}
          metric={presentation.packPrice}
          showReason={false}
          showSemanticState={false}
        />
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

      <div className={styles.provenance}>
        <p>{presentation.sourceLine}</p>
        <p>{presentation.adviceLine}</p>
      </div>
    </section>
  );
}
