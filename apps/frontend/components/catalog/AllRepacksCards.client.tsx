"use client";

import type { ReactNode } from "react";
import type {
  PublicRepackChase,
  PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import { CatalogImage } from "@/components/catalog/CatalogImage.client";
import { MetricValue } from "@/components/metrics/MetricValue";
import {
  presentBuybackSummaryV3,
  presentGrossEvV3,
  presentPackScoutEvV3,
  presentRepackPrice,
  presentTopChaseValue,
} from "@/lib/packscout-ev-presentation";
import { useClockBoundPackScoutEv } from "@/lib/packscout-ev-clock.client";
import { formatCollectibleIdentity } from "@/lib/collectible-identity";
import { presentPackAvailability } from "@/lib/pack-availability-presentation";
import type { ListPublicRepacksPageV3 } from "@/lib/public-repacks-v3";
import { CatalogConfidenceEvidence } from "./CatalogConfidenceEvidence.client";
import { VendorIdentity } from "./VendorIdentity";
import styles from "./AllRepacksCards.module.css";

type AllRepacksCardsProps = Readonly<{
  page: ListPublicRepacksPageV3;
  selectedPublicRepackId: string | null;
  controls: ReactNode;
  onSelect: (publicRepackId: string, trigger: HTMLButtonElement) => void;
  onInspectChase?: (publicCollectibleId: string, trigger: HTMLButtonElement) => void;
}>;

function RepackCard({
  repack,
  selected,
  desiredChase,
  desiredSearchActive,
  onSelect,
  onInspectChase,
}: Readonly<{
  repack: PublicRepackViewSummaryV3;
  selected: boolean;
  desiredChase: PublicRepackChase | null;
  desiredSearchActive: boolean;
  onSelect: (publicRepackId: string, trigger: HTMLButtonElement) => void;
  onInspectChase?: (publicCollectibleId: string, trigger: HTMLButtonElement) => void;
}>) {
  const boundEstimate = useClockBoundPackScoutEv(repack.evEstimates.packScout, repack.price);
  const estimate = presentPackScoutEvV3({
    estimate: boundEstimate,
    price: repack.price,
    availability: repack.availability,
    repackName: repack.name,
  });
  const buyback = presentBuybackSummaryV3(repack.buyback);
  const grossEv = presentGrossEvV3(repack, estimate);
  const price = presentRepackPrice(repack.price);
  const displayedChase = desiredSearchActive ? desiredChase : repack.topChase;
  const displayedChaseValue = presentTopChaseValue(
    displayedChase,
    desiredSearchActive ? "Desired Chase Value" : "Top Chase Value",
  );
  const availability = presentPackAvailability(repack.availability);

  return (
    <article className={styles.card} data-selected={selected ? "true" : "false"}>
      <button
        aria-pressed={selected}
        className={styles.cardSelect}
        onClick={(event) => onSelect(repack.publicRepackId, event.currentTarget)}
        type="button"
      >
        <span className={styles.vendorRow}>
          <span className={styles.vendor}>
            <VendorIdentity name={repack.vendorDisplayName} vendorKey={repack.vendorKey} />
          </span>
          <span
            className={styles.availability}
            data-state={repack.availability}
          >
            {availability.label}
            <span className="sr-only">. {availability.description}</span>
          </span>
        </span>
        <span className={styles.packRow}>
          <CatalogImage
            decorative
            fallbackAlt={repack.name}
            image={repack.primaryImage}
            variant="thumbnail"
          />
          <span className={styles.identity}>
            <span className={styles.name}>{repack.name}</span>
            <span className={styles.category}>
              {repack.categories.map(({ label }) => label).join(" · ") || "Uncategorized"}
            </span>
          </span>
          <span className={styles.price}>
            <span aria-hidden="true" className={styles.priceLabel}>Pack price</span>
            <span aria-hidden="true">{price.displayValue}</span>
            <span className="sr-only">{price.accessibleLabel}</span>
          </span>
        </span>
      </button>

      <div className={styles.metrics}>
        <MetricValue compact metric={grossEv.grossEvDollars} showReason={false} />
        <MetricValue compact metric={grossEv.grossEvPercent} showReason={false} />
        <MetricValue compact metric={grossEv.evDollars} showReason={false} />
        <MetricValue compact metric={grossEv.evPercent} showReason={false} />
        <MetricValue compact metric={buyback} showReason={false} />
      </div>
      {grossEv.sourceNote ? <p className={styles.sourceNote} title={grossEv.sourceNote}>{grossEv.sourceLabel}</p> : null}

      <dl className={styles.details}>
        <div>
          <dt>EV confidence</dt>
          <dd>
            <CatalogConfidenceEvidence
              estimate={estimate}
              providerHealth={repack.providerHealth}
              repackName={repack.name}
            />
          </dd>
        </div>
        <div>
          <dt>{desiredSearchActive ? "Desired chase" : "Top chase"}</dt>
          <dd>
            {displayedChase && desiredSearchActive && onInspectChase ? (
              <button
                aria-label={`View chase ${displayedChase.collectible.name}`}
                className={styles.chaseSelect}
                onClick={(event) =>
                  onInspectChase(
                    displayedChase.collectible.publicCollectibleId,
                    event.currentTarget,
                  )
                }
                type="button"
              >
                {displayedChase.collectible.name}
              </button>
            ) : (
              displayedChase?.collectible.name ?? "Unavailable"
            )}
          </dd>
        </div>
        <div>
          <dt>{desiredSearchActive ? "Desired chase value" : "Top chase value"}</dt>
          <dd>{displayedChaseValue.displayValue}</dd>
        </div>
      </dl>
    </article>
  );
}

export function AllRepacksCards({
  page,
  selectedPublicRepackId,
  controls,
  onSelect,
  onInspectChase,
}: AllRepacksCardsProps) {
  const desiredChaseByRepackId = new Map(
    page.desiredChaseMatches.map((match) => [match.publicRepackId, match.chase]),
  );
  const desiredCollectibleIdentity = page.desiredCollectible === null
    ? null
    : formatCollectibleIdentity(page.desiredCollectible);

  return (
    <section aria-labelledby="all-repacks-cards-title" className={styles.region}>
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>
            {desiredCollectibleIdentity
              ? `Exact chase matches · ${desiredCollectibleIdentity}`
              : "Published repack data"}
          </p>
          <h2 className={styles.title} id="all-repacks-cards-title">All repacks</h2>
        </div>
        <div className={styles.headingActions}>{controls}</div>
      </div>
      <div className={styles.grid}>
        {page.rows.map((repack) => (
          <RepackCard
            desiredChase={desiredChaseByRepackId.get(repack.publicRepackId) ?? null}
            desiredSearchActive={page.desiredCollectible !== null}
            key={repack.publicRepackId}
            onInspectChase={onInspectChase}
            onSelect={onSelect}
            repack={repack}
            selected={repack.publicRepackId === selectedPublicRepackId}
          />
        ))}
      </div>
    </section>
  );
}
