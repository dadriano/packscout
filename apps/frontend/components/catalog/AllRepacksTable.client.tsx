"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import type {
  PublicRepackChase,
  PublicRepackSort,
  PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import { MetricValue } from "@/components/metrics/MetricValue";
import {
  presentBuybackSummaryV3,
  presentPackScoutEvV3,
  presentRepackPrice,
  presentTopChaseValue,
  presentVendorReportedEvV3,
} from "@/lib/packscout-ev-presentation";
import { useClockBoundPackScoutEv } from "@/lib/packscout-ev-clock.client";
import { formatCollectibleIdentity } from "@/lib/collectible-identity";
import { presentPackAvailability } from "@/lib/pack-availability-presentation";
import {
  ALL_REPACKS_HEADERS,
  catalogHeaderAriaSort,
  nextCatalogSortDirection,
  publicRowActions,
  type CatalogSortDirection,
} from "@/lib/all-repacks-table";
import type { ListPublicRepacksPageV3 } from "@/lib/public-repacks-v3";
import { CatalogConfidenceEvidence } from "./CatalogConfidenceEvidence.client";
import { presentChaseMatchEvidence } from "./pack-inspector-presentation";
import styles from "./AllRepacksTable.module.css";

type AllRepacksTableProps = Readonly<{
  page: ListPublicRepacksPageV3;
  selectedPublicRepackId: string | null;
  onSelect: (publicRepackId: string, trigger: HTMLButtonElement) => void;
  onSort: (sort: PublicRepackSort, direction: CatalogSortDirection) => void;
  onCopyPromo: (publicRepackId: string) => void;
  onOpenRepack: (publicRepackId: string) => void;
  repackHrefById: ReadonlyMap<string, string>;
  controls?: ReactNode;
}>;

function RepackImage({ repack }: { readonly repack: PublicRepackViewSummaryV3 }) {
  return repack.primaryImage ? (
    <Image
      alt={repack.primaryImage.alt}
      className={styles.packImage}
      height={46}
      src={repack.primaryImage.url}
      unoptimized
      width={36}
    />
  ) : (
    <span aria-hidden="true" className={styles.imagePlaceholder}>R</span>
  );
}

function PlainUnavailable({ reason }: { readonly reason: string }) {
  return (
    <span className={styles.unavailable} title={reason}>
      Unavailable
    </span>
  );
}

function RepackRow({
  repack,
  selected,
  onSelect,
  onCopyPromo,
  onOpenRepack,
  repackHref,
  desiredChase,
  desiredSearchActive,
}: Readonly<{
  repack: PublicRepackViewSummaryV3;
  selected: boolean;
  onSelect: (publicRepackId: string, trigger: HTMLButtonElement) => void;
  onCopyPromo: (publicRepackId: string) => void;
  onOpenRepack: (publicRepackId: string) => void;
  repackHref: string | null;
  desiredChase: PublicRepackChase | null;
  desiredSearchActive: boolean;
}>) {
  const boundEstimate = useClockBoundPackScoutEv(repack.evEstimates.packScout, repack.price);
  const estimate = presentPackScoutEvV3({
    estimate: boundEstimate,
    price: repack.price,
    availability: repack.availability,
    repackName: repack.name,
  });
  const vendorEstimate = presentVendorReportedEvV3(
    repack.evEstimates.vendorReported,
  );
  const buyback = presentBuybackSummaryV3(repack.buyback);
  const packPrice = presentRepackPrice(repack.price);
  const displayedChase = desiredSearchActive ? desiredChase : repack.topChase;
  const displayedChaseValue = presentTopChaseValue(
    displayedChase,
    desiredSearchActive ? "Desired Chase Value" : "Top Chase Value",
  );
  const desiredEvidence = desiredChase
    ? presentChaseMatchEvidence(desiredChase)
    : null;
  const actions = publicRowActions(repack);
  const availability = presentPackAvailability(repack.availability);

  return (
    <tr className={styles.row} data-selected={selected ? "true" : "false"}>
      <td>{repack.vendorDisplayName}</td>
      <td>{repack.categories.map(({ label }) => label).join(" · ") || "Uncategorized"}</td>
      <td className={styles.packCell}>
        <button
          aria-pressed={selected}
          className={styles.packSelect}
          onClick={(event) => onSelect(repack.publicRepackId, event.currentTarget)}
          type="button"
        >
          <RepackImage repack={repack} />
          <span className={styles.packIdentity}>
            <span className={styles.packName}>{repack.name}</span>
            {estimate.simulatedLabel ? (
              <span className={styles.secondaryBadge}>{estimate.simulatedLabel}</span>
            ) : null}
            {repack.contentMode === "mixed" ? (
              <span className={styles.secondaryBadge}>Mixed content</span>
            ) : null}
            <span
              className={styles.availabilityBadge}
              data-state={repack.availability}
            >
              {availability.label}
              <span className="sr-only">. {availability.description}</span>
            </span>
          </span>
        </button>
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={packPrice} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.grossEvDollars} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.grossEvPercent} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.evDollars} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.evPercent} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <CatalogConfidenceEvidence
          estimate={estimate}
          providerHealth={repack.providerHealth}
          repackName={repack.name}
        />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={buyback} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={vendorEstimate.usdComparison} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
        <span className={styles.chaseEvidence}>{vendorEstimate.sourceNote}</span>
      </td>
      <td>
        {displayedChase ? (
          <span className={styles.chaseMatch}>
            <span className={styles.chaseName}>{displayedChase.collectible.name}</span>
            {desiredEvidence ? (
              <small className={styles.chaseEvidence}>
                {desiredEvidence.evidenceLabel} · {desiredEvidence.matchConfidenceLabel}
              </small>
            ) : null}
          </span>
        ) : (
          <PlainUnavailable reason={
            desiredSearchActive
              ? "Desired chase match is not available."
              : "Top chase is not available."
          } />
        )}
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={displayedChaseValue} showGlossary={false} showLabel={false} showReason={false} showSemanticState={false} />
      </td>
      <td>
        {actions.promo ? (
          <button className={styles.inlineAction} onClick={() => onCopyPromo(repack.publicRepackId)} type="button">
            Copy promo
          </button>
        ) : (
          <span className={styles.notAvailable}>Not available</span>
        )}
      </td>
      <td>
        {actions.repackLink && repackHref ? (
          <a
            className={styles.inlineAction}
            href={repackHref}
            onClick={() => onOpenRepack(repack.publicRepackId)}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open repack <span aria-hidden="true">↗</span>
          </a>
        ) : actions.repackLink ? (
          <button className={styles.inlineAction} onClick={() => onOpenRepack(repack.publicRepackId)} type="button">
            Open repack <span aria-hidden="true">↗</span>
          </button>
        ) : (
          <span className={styles.notAvailable}>Not available</span>
        )}
      </td>
    </tr>
  );
}

export function AllRepacksTable({
  page,
  selectedPublicRepackId,
  onSelect,
  onSort,
  onCopyPromo,
  onOpenRepack,
  repackHrefById,
  controls,
}: AllRepacksTableProps) {
  const { activeQuery } = page;
  const desiredChaseByRepackId = new Map(
    page.desiredChaseMatches.map((match) => [match.publicRepackId, match.chase]),
  );
  const desiredCollectibleIdentity = page.desiredCollectible === null
    ? null
    : formatCollectibleIdentity(page.desiredCollectible);
  const contextId = "all-repacks-table-context";

  function headerLabel(key: (typeof ALL_REPACKS_HEADERS)[number]["key"], label: string) {
    if (!page.desiredCollectible) return label;
    if (key === "topChase") return "Desired Chase Match";
    if (key === "topChaseValue") return "Desired Chase Value";
    return label;
  }

  return (
    <section
      aria-labelledby={`all-repacks-table-title${desiredCollectibleIdentity ? ` ${contextId}` : ""}`}
      className={styles.region}
    >
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow} id={contextId}>
            {desiredCollectibleIdentity
              ? `Exact chase matches · ${desiredCollectibleIdentity}`
              : "Published repack data"}
          </p>
          <h2 className={styles.title} id="all-repacks-table-title">All repacks</h2>
        </div>
        <div className={styles.headingActions}>{controls}</div>
      </div>

      {controls ? null : (
        <p aria-live="polite" className={styles.orderStatus}>
          {activeQuery.search
            ? "Ordered by relevance"
            : `Sorted by ${ALL_REPACKS_HEADERS.find(({ sort }) => sort === activeQuery.sort)?.label ?? "EV $"}, ${activeQuery.direction === "asc" ? "ascending" : "descending"}`}
        </p>
      )}
      <div
        aria-label="All Repacks comparison table. Scroll horizontally for all fields."
        className={styles.scroller}
        role="region"
        tabIndex={0}
      >
        <table className={styles.table}>
          <caption className="sr-only">
            {desiredCollectibleIdentity
              ? `All repacks matching desired chase ${desiredCollectibleIdentity}`
              : "All repacks comparison"}
          </caption>
          <thead>
            <tr>
              {ALL_REPACKS_HEADERS.map((header) => (
                <th
                  aria-sort={catalogHeaderAriaSort(header, activeQuery.sort, activeQuery.direction, activeQuery.search)}
                  key={header.key}
                  scope="col"
                >
                  <span className={styles.headerLabel}>
                    {header.sort &&
                    !activeQuery.search &&
                    !(page.desiredCollectible && header.key === "topChaseValue") ? (
                      <button
                        className={styles.sortButton}
                        onClick={() => onSort(header.sort!, nextCatalogSortDirection(activeQuery.sort, activeQuery.direction, header.sort!))}
                        type="button"
                      >
                        {headerLabel(header.key, header.label)}
                        <span aria-hidden="true" className={styles.sortIcon}>
                          {header.sort === activeQuery.sort ? (activeQuery.direction === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    ) : (
                      <span>
                        {headerLabel(header.key, header.label)}
                        {desiredCollectibleIdentity &&
                        (header.key === "topChase" ||
                          header.key === "topChaseValue") ? (
                          <span className="sr-only">
                            {` for ${desiredCollectibleIdentity}`}
                          </span>
                        ) : null}
                      </span>
                    )}
                    {page.desiredCollectible &&
                    (header.key === "topChase" || header.key === "topChaseValue") ? null : (
                      <GlossaryHint align="start" field={header.key} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((repack) => (
              <RepackRow
                key={repack.publicRepackId}
                desiredChase={desiredChaseByRepackId.get(repack.publicRepackId) ?? null}
                desiredSearchActive={page.desiredCollectible !== null}
                onCopyPromo={onCopyPromo}
                onOpenRepack={onOpenRepack}
                onSelect={onSelect}
                repack={repack}
                repackHref={repackHrefById.get(repack.publicRepackId) ?? null}
                selected={repack.publicRepackId === selectedPublicRepackId}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
