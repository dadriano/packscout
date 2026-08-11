import type { DashboardKpis } from "@packscout/contracts";
import { presentDashboardKpis } from "./overview-presentation";
import styles from "./OverviewKpis.module.css";

const KPI_MARKS = Object.freeze({
  packs: "#",
  positiveEv: "+",
  medianEv: "%",
  highestChase: "◇",
});

export function OverviewKpis({ kpis }: { kpis: DashboardKpis }) {
  const presentations = presentDashboardKpis(kpis);

  return (
    <section aria-label="Overview metrics">
      <ul className={styles.grid}>
        {presentations.map((kpi) => (
          <li
            className={styles.card}
            data-kind={kpi.id}
            data-state={kpi.state}
            key={kpi.id}
          >
            <span className="sr-only">{kpi.accessibleLabel}</span>
            <span aria-hidden="true" className={styles.mark}>
              {KPI_MARKS[kpi.id]}
            </span>
            <div aria-hidden="true" className={styles.content}>
              <span className={styles.label}>{kpi.label}</span>
              <span className={styles.value}>{kpi.value}</span>
              <span className={styles.helper}>
                {kpi.reasonCopy ?? kpi.helper}
              </span>
            </div>
            {kpi.stateLabel && kpi.state !== "unavailable" ? (
              <span aria-hidden="true" className={styles.stateLabel}>
                {kpi.stateLabel}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
