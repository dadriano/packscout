"use client";

import Image from "next/image";
import type { ListPublicPacksPage, PublicCatalogSort, PublicPackSummary } from "@packscout/contracts";
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import { MetricValue } from "@/components/metrics/MetricValue";
import {
  formatMoneyMinorUnits,
  presentBuyback,
  presentEstimatedEv,
  presentTopChaseValue,
} from "@/lib/metric-presentation";
import {
  ALL_PACKS_HEADERS,
  catalogHeaderAriaSort,
  nextCatalogSortDirection,
  publicRowActions,
  type CatalogSortDirection,
} from "@/lib/all-packs-table";
import styles from "./AllPacksTable.module.css";

type AllPacksTableProps = Readonly<{
  page: ListPublicPacksPage;
  selectedPublicPackId: string | null;
  onSelect: (publicPackId: string, trigger: HTMLButtonElement) => void;
  onSort: (sort: PublicCatalogSort, direction: CatalogSortDirection) => void;
  onCopyPromo: (publicPackId: string) => void;
  onOpenPack: (publicPackId: string) => void;
}>;

function PackImage({ pack }: { readonly pack: PublicPackSummary }) {
  return pack.primaryImage ? (
    <Image
      alt={pack.primaryImage.alt}
      className={styles.packImage}
      height={46}
      src={pack.primaryImage.url}
      unoptimized
      width={36}
    />
  ) : (
    <span aria-hidden="true" className={styles.imagePlaceholder}>P</span>
  );
}

function PlainUnavailable({ reason }: { readonly reason: string }) {
  return (
    <span className={styles.unavailable} title={reason}>
      Unavailable
    </span>
  );
}

function CatalogRow({
  pack,
  selected,
  onSelect,
  onCopyPromo,
  onOpenPack,
}: Readonly<{
  pack: PublicPackSummary;
  selected: boolean;
  onSelect: (publicPackId: string, trigger: HTMLButtonElement) => void;
  onCopyPromo: (publicPackId: string) => void;
  onOpenPack: (publicPackId: string) => void;
}>) {
  const estimate = presentEstimatedEv({
    packPrice: pack.price.usdComparison,
    estimatedEv: pack.estimatedEv,
  });
  const buyback = presentBuyback(pack.buyback);
  const topChaseValue = presentTopChaseValue(pack.topChase);
  const actions = publicRowActions(pack);

  return (
    <tr className={styles.row} data-selected={selected ? "true" : "false"}>
      <td>{pack.platformDisplayName}</td>
      <td>{pack.category || "Uncategorized"}</td>
      <td className={styles.packCell}>
        <button
          aria-pressed={selected}
          className={styles.packSelect}
          onClick={(event) => onSelect(pack.publicPackId, event.currentTarget)}
          type="button"
        >
          <PackImage pack={pack} />
          <span className={styles.packIdentity}>
            <span className={styles.packName}>{pack.name}</span>
            {pack.availability === "sold_out" ? (
              <span className={styles.soldOut}>Sold out</span>
            ) : null}
          </span>
        </button>
      </td>
      <td className={styles.numeric}>
        {pack.price.displayMoney ? (
          formatMoneyMinorUnits(pack.price.displayMoney)
        ) : (
          <PlainUnavailable reason="Pack price is not available." />
        )}
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.evDollars} showGlossary={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.evPercent} showGlossary={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={buyback} showGlossary={false} showReason={false} showSemanticState={false} />
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={estimate.grossEv} showGlossary={false} showReason={false} showSemanticState={false} />
      </td>
      <td>
        {pack.topChase.status === "available" ? (
          <span className={styles.chaseName}>{pack.topChase.value.name}</span>
        ) : (
          <PlainUnavailable reason="Top chase is not available." />
        )}
      </td>
      <td className={styles.numeric}>
        <MetricValue compact metric={topChaseValue} showGlossary={false} showReason={false} showSemanticState={false} />
      </td>
      <td>
        {actions.promo ? (
          <button className={styles.inlineAction} onClick={() => onCopyPromo(pack.publicPackId)} type="button">
            Copy promo
          </button>
        ) : (
          <span className={styles.notAvailable}>Not available</span>
        )}
      </td>
      <td>
        {actions.packLink ? (
          <button className={styles.inlineAction} onClick={() => onOpenPack(pack.publicPackId)} type="button">
            Open pack <span aria-hidden="true">↗</span>
          </button>
        ) : (
          <span className={styles.notAvailable}>Not available</span>
        )}
      </td>
    </tr>
  );
}

export function AllPacksTable({
  page,
  selectedPublicPackId,
  onSelect,
  onSort,
  onCopyPromo,
  onOpenPack,
}: AllPacksTableProps) {
  const { activeQuery } = page;

  return (
    <section aria-labelledby="all-packs-table-title" className={styles.region}>
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>Current catalog</p>
          <h2 className={styles.title} id="all-packs-table-title">All packs</h2>
        </div>
        <p aria-live="polite" className={styles.orderStatus}>
          {activeQuery.search
            ? "Ordered by relevance"
            : `Sorted by ${ALL_PACKS_HEADERS.find(({ sort }) => sort === activeQuery.sort)?.label ?? "EV $"}, ${activeQuery.direction === "asc" ? "ascending" : "descending"}`}
        </p>
      </div>

      <div aria-label="All Packs comparison table. Scroll horizontally for all twelve fields." className={styles.scroller} tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              {ALL_PACKS_HEADERS.map((header) => (
                <th
                  aria-sort={catalogHeaderAriaSort(header, activeQuery.sort, activeQuery.direction, activeQuery.search)}
                  key={header.key}
                  scope="col"
                >
                  <span className={styles.headerLabel}>
                    {header.sort && !activeQuery.search ? (
                      <button
                        className={styles.sortButton}
                        onClick={() => onSort(header.sort!, nextCatalogSortDirection(activeQuery.sort, activeQuery.direction, header.sort!))}
                        type="button"
                      >
                        {header.label}
                        <span aria-hidden="true" className={styles.sortIcon}>
                          {header.sort === activeQuery.sort ? (activeQuery.direction === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    ) : (
                      <span>{header.label}</span>
                    )}
                    <GlossaryHint align="start" field={header.key} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((pack) => (
              <CatalogRow
                key={pack.publicPackId}
                onCopyPromo={onCopyPromo}
                onOpenPack={onOpenPack}
                onSelect={onSelect}
                pack={pack}
                selected={pack.publicPackId === selectedPublicPackId}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
