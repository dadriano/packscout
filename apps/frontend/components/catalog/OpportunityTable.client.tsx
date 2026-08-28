"use client";

import Link from "next/link";
import type { PublicRepackViewSummaryV3 } from "@packscout/contracts";
import type { MetricValuePresentation } from "@/lib/packscout-ev-presentation";
import type { DashboardBundleV3 } from "@/lib/public-repacks-v3";
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import { CatalogImage } from "./CatalogImage.client";
import { presentOpportunityRow } from "./overview-presentation";
import styles from "./OpportunityTable.module.css";

export type OpportunitySelectionHandler = (
  publicRepackId: string,
  trigger: HTMLButtonElement,
) => void;

type OpportunityTableProps = Readonly<{
  opportunities: readonly PublicRepackViewSummaryV3[];
  opportunityEligibility: DashboardBundleV3["opportunityEligibility"];
  repacksHref: string;
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

function ColumnLabel({
  children,
  field,
  align,
}: Readonly<{
  children: string;
  field:
    | "repack"
    | "vendor"
    | "category"
    | "repackPrice"
    | "evDollars"
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

function OpportunityRow({
  repack,
  rank,
  selected,
  onSelectOpportunity,
}: Readonly<{
  repack: PublicRepackViewSummaryV3;
  rank: number;
  selected: boolean;
  onSelectOpportunity: OpportunitySelectionHandler;
}>) {
  const row = presentOpportunityRow(repack, rank);

  return (
    <tr data-selected={selected ? "true" : "false"}>
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
        <MetricCell metric={row.packPrice} />
      </td>
      <td>
        <MetricCell metric={row.packScoutEv.evDollars} />
      </td>
      <td>
        <MetricCell metric={row.packScoutEv.evPercent} />
        <span
          aria-label={row.packScoutEv.confidence.accessibleLabel}
          className={styles.unavailableReason}
        >
          Confidence: {row.packScoutEv.confidence.displayValue}
        </span>
        {row.packScoutEv.status === "last_known" ? (
          <span className={styles.estimateEvidence}>
            {row.packScoutEv.statusLabel}
            {row.packScoutEv.freshness.sourceAgeLabel ? (
              <span>{row.packScoutEv.freshness.sourceAgeLabel}</span>
            ) : null}
            {row.packScoutEv.freshness.dataAsOf ? (
              <time dateTime={row.packScoutEv.freshness.dataAsOf}>
                {row.packScoutEv.freshness.dataAsOfLabel}
              </time>
            ) : null}
          </span>
        ) : null}
      </td>
      <td>
        <MetricCell metric={row.buyback} />
      </td>
      <td>
        <MetricCell metric={row.topChaseValue} />
      </td>
    </tr>
  );
}

export function OpportunityTable({
  opportunities,
  opportunityEligibility,
  repacksHref,
  selectedPublicRepackId,
  onSelectOpportunity,
}: OpportunityTableProps) {
  const hasProviderExclusions =
    opportunityEligibility.providerIneligibleRepackCount > 0;

  return (
    <section aria-labelledby="top-opportunities-heading" className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Ranked by EV $</p>
          <h2 className={styles.heading} id="top-opportunities-heading">
            Top opportunities
          </h2>
        </div>
        <span className={styles.resultCount}>
          {opportunities.length}{" "}
          {opportunities.length === 1 ? "repack" : "repacks"}
        </span>
      </div>

      {hasProviderExclusions ? (
        <p className={styles.eligibilityNotice}>
          Provider feed delayed; excluded from Top Opportunities. Last-known EV
          remains available in All Repacks for {opportunityEligibility.providerIneligibleRepackCount}{" "}
          {opportunityEligibility.providerIneligibleRepackCount === 1
            ? "repack"
            : "repacks"}.
        </p>
      ) : null}

      {opportunities.length > 0 ? (
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
                <ColumnLabel field="vendor">Vendor</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="category">Category</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="repackPrice">Pack price</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="evDollars">EV $</ColumnLabel>
              </th>
              <th scope="col">
                <ColumnLabel field="evPercent">EV %</ColumnLabel>
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
            {opportunities.map((repack, index) => (
              <OpportunityRow
                key={repack.publicRepackId}
                onSelectOpportunity={onSelectOpportunity}
                rank={index + 1}
                repack={repack}
                selected={repack.publicRepackId === selectedPublicRepackId}
              />
            ))}
          </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.emptyState}>
          <p role="status">
            {hasProviderExclusions
              ? "No repacks are currently eligible for Top Opportunities because provider data is delayed."
              : "No estimated opportunities match these filters."}
          </p>
          <Link className={styles.emptyAction} href={repacksHref}>
            View matching repacks
          </Link>
        </div>
      )}
    </section>
  );
}
