import type { CSSProperties } from "react";
import type { RepackSummaryGroupV3 } from "@/lib/public-repacks-v3";
import { presentCatalogSummaries } from "./overview-presentation";
import styles from "./CatalogSummaries.module.css";

type CatalogSummariesProps = Readonly<{
  title: "By vendor" | "By category";
  summaries: readonly RepackSummaryGroupV3[];
}>;

type SummaryBarStyle = CSSProperties & { "--bar-ratio": number };

export function CatalogSummaries({
  title,
  summaries,
}: CatalogSummariesProps) {
  const rows = presentCatalogSummaries(summaries);
  const headingId =
    title === "By vendor" ? "catalog-by-vendor" : "catalog-by-category";

  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading} id={headingId}>
            {title}
          </h2>
          <p className={styles.context}>Current catalog</p>
        </div>
        <div aria-hidden="true" className={styles.columns}>
          <span>Repacks</span>
          <span>Median EV</span>
        </div>
      </div>

      <ol className={styles.list}>
        {rows.map((row) => (
          <li aria-label={row.accessibleLabel} className={styles.row} key={row.key}>
            <span className={styles.label}>{row.label}</span>
            <span
              aria-hidden="true"
              className={styles.track}
              style={{ "--bar-ratio": row.barRatio } as SummaryBarStyle}
            >
              <span className={styles.bar} />
            </span>
            <span aria-hidden="true" className={styles.count}>
              {row.repackCountLabel}
            </span>
            <span
              aria-hidden="true"
              className={styles.median}
              data-state={row.medianEvPercent.semanticState ?? "plain"}
            >
              <span>{row.medianEvPercent.displayValue}</span>
              <small>{row.medianEvPercent.semanticLabel}</small>
            </span>
          </li>
        ))}
      </ol>

      {rows.length === 0 ? (
        <p className={styles.empty}>No current catalog groups to summarize.</p>
      ) : null}
    </section>
  );
}
