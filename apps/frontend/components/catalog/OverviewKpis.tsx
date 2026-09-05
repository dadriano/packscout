import Link from "next/link";
import type { DashboardKpis, DisplayedEvMedianSource } from "@packscout/contracts";
import { presentDashboardKpis } from "./overview-presentation";
import styles from "./OverviewKpis.module.css";

const KPI_MARKS = Object.freeze({
  repacks: "#",
  medianEv: "%",
  highestChase: "◇",
});

type OverviewKpisProps = Readonly<{
  kpis: DashboardKpis;
  evMedianSource: DisplayedEvMedianSource | null;
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
    </>
  );
}

export function OverviewKpis({ kpis, evMedianSource, repacksHref }: OverviewKpisProps) {
  const presentations = presentDashboardKpis(kpis, evMedianSource);

  return (
    <section aria-label="Overview metrics">
      <ul className={styles.grid}>
        {presentations.map((kpi) => {
          const cardProps = {
            className: styles.card,
            "data-kind": kpi.id,
            "data-state": kpi.state,
            "data-tone": kpi.tone ?? "plain",
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
