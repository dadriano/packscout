"use client";

import type { PublicRepackViewSummary } from "@packscout/contracts";
import type { MetricValuePresentation } from "@/lib/metric-presentation";
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import { CatalogImage } from "./CatalogImage.client";
import {
  presentOpportunities,
  type DisplayField,
} from "./overview-presentation";
import { RepackHeatBadge } from "./RepackHeatBadge";
import styles from "./OpportunityTable.module.css";

export type OpportunitySelectionHandler = (
  publicRepackId: string,
  trigger: HTMLButtonElement,
) => void;

type OpportunityTableProps = Readonly<{
  opportunities: readonly PublicRepackViewSummary[];
  selectedPublicRepackId: string | null;
  onSelectOpportunity: OpportunitySelectionHandler;
}>;

function MetricCell({ metric }: { metric: MetricValuePresentation }) {
  return (
    <span className={styles.metric} data-state={metric.semanticState ?? "plain"}>
      <span aria-hidden="true" className={styles.metricValue}>
        {metric.displayValue}
      </span>
      <span className="sr-only">{metric.accessibleLabel}</span>
      {metric.semanticLabel && metric.availability === "available" ? (
        <span aria-hidden="true" className={styles.metricState}>
          {metric.semanticLabel}
        </span>
      ) : null}
      {metric.availability === "unavailable" ? (
        <span aria-hidden="true" className={styles.unavailableReason}>
          {metric.reasonCopy}
        </span>
      ) : null}
    </span>
  );
}

function PriceCell({ price }: { price: DisplayField }) {
  return (
    <span className={styles.metric} data-state={price.availability}>
      <span aria-hidden="true" className={styles.metricValue}>
        {price.displayValue}
      </span>
      <span className="sr-only">{price.accessibleLabel}</span>
      {price.reasonCopy ? (
        <span aria-hidden="true" className={styles.unavailableReason}>
          {price.reasonCopy}
        </span>
      ) : null}
    </span>
  );
}

function ColumnLabel({
  children,
  field,
  align,
}: Readonly<{
  children: string;
  field:
    | "repack"
    | "heat"
    | "vendor"
    | "category"
    | "repackPrice"
    | "evPercent"
    | "buybackPercent"
    | "topChaseValue";
  align?: "start" | "end";
}>) {
  return (
    <span className={styles.columnLabel}>
      {children}
      <GlossaryHint align={align} field={field} />
    </span>
  );
}

export function OpportunityTable({
  opportunities,
  selectedPublicRepackId,
  onSelectOpportunity,
}: OpportunityTableProps) {
  const rows = presentOpportunities(opportunities);

  return (
    <section aria-labelledby="top-opportunities-heading" className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Ranked by PackScout EV $</p>
          <h2 className={styles.heading} id="top-opportunities-heading">
            Top opportunities
          </h2>
        </div>
        <span className={styles.resultCount}>
          {rows.length} {rows.length === 1 ? "repack" : "repacks"}
        </span>
      </div>

      <div
        aria-label="Top opportunities comparison"
        className={styles.scrollRegion}
        role="region"
        tabIndex={0}
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">
                <ColumnLabel field="repack">Repack</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="heat">Heat</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="vendor">Vendor</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="category">Category</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="repackPrice">Repack price</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="evPercent">PackScout EV %</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="buybackPercent">Buyback %</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel align="end" field="topChaseValue">
                  Top chase value
                </ColumnLabel>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = row.publicRepackId === selectedPublicRepackId;
              return (
                <tr data-selected={selected ? "true" : "false"} key={row.publicRepackId}>
                  <td className={styles.rank}>{row.rank}</td>
                  <td className={styles.packCell}>
                    <button
                      aria-label={`Inspect ${row.name}${selected ? ", selected" : ""}`}
                      aria-pressed={selected}
                      className={styles.selectPack}
                      onClick={(event) =>
                        onSelectOpportunity(row.publicRepackId, event.currentTarget)
                      }
                      type="button"
                    >
                      <CatalogImage
                        fallbackAlt={row.name}
                        image={row.primaryImage}
                        variant="thumbnail"
                      />
                      <span className={styles.packName}>{row.name}</span>
                      {selected ? (
                        <span aria-hidden="true" className={styles.selectedLabel}>
                          Selected
                        </span>
                      ) : null}
                    </button>
                  </td>
                  <td>
                    <RepackHeatBadge heat={row.heat} variant="icon" />
                  </td>
                  <td>
                    <span className={styles.vendor}>
                      {row.vendorLogoUrl ? (
                        <CatalogImage
                          decorative
                          fallback="none"
                          fallbackAlt={`${row.vendorDisplayName} logo`}
                          image={{
                            url: row.vendorLogoUrl,
                            alt: `${row.vendorDisplayName} logo`,
                          }}
                          variant="vendor"
                        />
                      ) : null}
                      <span>{row.vendorDisplayName}</span>
                    </span>
                  </td>
                  <td>{row.category}</td>
                  <td>
                    <PriceCell price={row.repackPrice} />
                  </td>
                  <td>
                    <MetricCell metric={row.packScoutEvPercent} />
                    <span className={styles.unavailableReason}>
                      Confidence: {row.packScoutConfidence.displayValue}
                    </span>
                  </td>
                  <td>
                    <MetricCell metric={row.buyback} />
                  </td>
                  <td>
                    <MetricCell metric={row.topChaseValue} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? (
        <p className={styles.emptyState}>No estimated opportunities match these filters.</p>
      ) : null}
    </section>
  );
}
