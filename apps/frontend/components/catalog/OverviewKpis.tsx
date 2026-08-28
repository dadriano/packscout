import Link from "next/link";
import type { DashboardKpis } from "@packscout/contracts";
import { presentDashboardKpis } from "./overview-presentation";
import styles from "./OverviewKpis.module.css";

const KPI_MARKS = Object.freeze({
  repacks: "#",
  medianEv: "%",
  highestChase: "◇",
});

type OverviewKpisProps = Readonly<{
  kpis: DashboardKpis;
  repacksHref?: string;
}>;

function KpiCard({
  kpi,
}: {
  kpi: ReturnType<typeof presentDashboardKpis>[number];
}) {
  return (
    <>
      <span aria-hidden="true" className={styles.mark}>
        {KPI_MARKS[kpi.id]}
      </span>
      <div aria-hidden="true" className={styles.content}>
        <span className={styles.value}>{kpi.value}</span>
        <span className={styles.label}>{kpi.label}</span>
        {kpi.helper ? (
          <span className={styles.helper}>
            {kpi.reasonCopy ?? kpi.helper}
          </span>
        ) : null}
      </div>
      {kpi.stateLabel && kpi.state !== "unavailable" ? (
        <span aria-hidden="true" className={styles.stateLabel}>
          {kpi.stateLabel}
        </span>
      ) : null}
    </>
  );
}

export function OverviewKpis({ kpis, repacksHref }: OverviewKpisProps) {
  const presentations = presentDashboardKpis(kpis);

  return (
    <section aria-label="Overview metrics">
      <ul className={styles.grid}>
        {presentations.map((kpi) => {
          const cardProps = {
            className: styles.card,
            "data-kind": kpi.id,
            "data-state": kpi.state,
          } as const;

          if (kpi.id === "repacks" && repacksHref) {
            return (
              <li key={kpi.id}>
                <Link
                  aria-label={kpi.accessibleLabel}
                  className={styles.cardLink}
                  href={repacksHref}
                >
                  <div {...cardProps}>
                    <KpiCard kpi={kpi} />
                  </div>
                </Link>
              </li>
            );
          }

          return (
            <li key={kpi.id}>
              <div {...cardProps}>
                <span className="sr-only">{kpi.accessibleLabel}</span>
                <KpiCard kpi={kpi} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
