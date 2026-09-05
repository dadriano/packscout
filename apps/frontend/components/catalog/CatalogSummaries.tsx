import Link from "next/link";
import type { CSSProperties } from "react";
import type { DisplayedEvMedianSourcesV3, PublicRepackFilters } from "@packscout/contracts";
import { catalogHrefForSummary } from "@/lib/catalog-query-state.client";
import type { RepackSummaryGroupV3 } from "@/lib/public-repacks-v3";
import { presentCatalogSummaries } from "./overview-presentation";
import { VendorIdentity } from "./VendorIdentity";
import styles from "./CatalogSummaries.module.css";

type CatalogSummariesProps = Readonly<{
  title: "By vendor" | "By category";
  summaries: readonly RepackSummaryGroupV3[];
  evMedianSources: DisplayedEvMedianSourcesV3["vendors"];
  activeFilters: PublicRepackFilters;
}>;

type SummaryBarStyle = CSSProperties & { "--bar-ratio": number };

export function CatalogSummaries({
  title,
  summaries,
  evMedianSources,
  activeFilters,
}: CatalogSummariesProps) {
  const rows = presentCatalogSummaries(summaries, evMedianSources);
  const headingId =
    title === "By vendor" ? "catalog-by-vendor" : "catalog-by-category";

  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading} id={headingId}>
            {title}
          </h2>
          <p className={styles.context}>Published catalog</p>
        </div>
        <div aria-hidden="true" className={styles.columns}>
          <span>Repacks</span>
          <span>Median EV</span>
        </div>
      </div>

      <ol className={styles.list}>
        {rows.map((row) => {
          const href = catalogHrefForSummary(activeFilters, {
            type: title === "By vendor" ? "vendor" : "category",
            key: row.key,
          });
          return (
            <li key={row.key}>
              <Link aria-label={row.accessibleLabel} className={styles.row} href={href} title={`${row.medianEvPercent.accessibleLabel} ${row.sourceLabel}.`}>
                <span className={styles.label}>
                  {title === "By vendor" ? (
                    <VendorIdentity name={row.label} vendorKey={row.key} />
                  ) : row.label}
                </span>
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
                  data-tone={row.medianEvPercent.tone ?? "plain"}
                >
                  <span>{row.medianEvPercent.displayValue}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      {rows.length === 0 ? (
        <p className={styles.empty}>No current catalog groups to summarize.</p>
      ) : null}
    </section>
  );
}
