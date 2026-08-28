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
  presentPackScoutEvV3,
  presentRepackPrice,
  presentTopChaseValue,
} from "@/lib/packscout-ev-presentation";
import { formatCollectibleIdentity } from "@/lib/collectible-identity";
import { presentPackAvailability } from "@/lib/pack-availability-presentation";
import { presentProviderHealthV3 } from "@/lib/provider-health-presentation";
import type { ListPublicRepacksPageV3 } from "@/lib/public-repacks-v3";
import styles from "./AllRepacksCards.module.css";

type AllRepacksCardsProps = Readonly<{
  page: ListPublicRepacksPageV3;
  selectedPublicRepackId: string | null;
  controls: ReactNode;
  onSelect: (publicRepackId: string, trigger: HTMLButtonElement) => void;
}>;

function RepackCard({
  repack,
  selected,
  desiredChase,
  desiredSearchActive,
  onSelect,
}: Readonly<{
  repack: PublicRepackViewSummaryV3;
  selected: boolean;
  desiredChase: PublicRepackChase | null;
  desiredSearchActive: boolean;
  onSelect: (publicRepackId: string, trigger: HTMLButtonElement) => void;
}>) {
  const estimate = presentPackScoutEvV3({
    estimate: repack.packScoutEvPresentation,
    price: repack.price,
    availability: repack.availability,
    repackName: repack.name,
  });
  const buyback = presentBuybackSummaryV3(repack.buyback);
  const price = presentRepackPrice(repack.price);
  const displayedChase = desiredSearchActive ? desiredChase : repack.topChase;
  const displayedChaseValue = presentTopChaseValue(
    displayedChase,
    desiredSearchActive ? "Desired Chase Value" : "Top Chase Value",
  );
  const availability = presentPackAvailability(repack.availability);
  const providerHealth = presentProviderHealthV3(repack.providerHealth);

  return (
    <article className={styles.card} data-selected={selected ? "true" : "false"}>
      <button
        aria-pressed={selected}
        className={styles.cardSelect}
        onClick={(event) => onSelect(repack.publicRepackId, event.currentTarget)}
        type="button"
      >
        <CatalogImage
          fallbackAlt={repack.name}
          image={repack.primaryImage}
          variant="thumbnail"
        />
        <span className={styles.identity}>
          <span className={styles.vendor}>{repack.vendorDisplayName}</span>
          <span className={styles.name}>{repack.name}</span>
          <span
            className={styles.availability}
            data-state={repack.availability}
          >
            {availability.label}
            <span className="sr-only">. {availability.description}</span>
          </span>
          <span className={styles.category}>
            {repack.categories.map(({ label }) => label).join(" · ") || "Uncategorized"}
          </span>
        </span>
        <span className={styles.price}>
          <span aria-hidden="true">{price.displayValue}</span>
          <span className="sr-only">{price.accessibleLabel}</span>
        </span>
      </button>

      <div className={styles.metrics}>
        <MetricValue compact metric={estimate.evDollars} showReason={false} />
        <MetricValue compact metric={estimate.evPercent} showReason={false} />
        <MetricValue compact metric={buyback} showReason={false} />
      </div>

      {estimate.status === "last_known" || !providerHealth.rankingEligible ? (
        <div
          className={styles.evidence}
          data-health={providerHealth.state}
        >
          {estimate.status === "last_known" ? (
            <>
              <strong>{estimate.statusLabel}</strong>
              {estimate.freshness.sourceAgeLabel ? (
                <span>{estimate.freshness.sourceAgeLabel}</span>
              ) : null}
              {estimate.freshness.dataAsOf ? (
                <time dateTime={estimate.freshness.dataAsOf}>
                  {estimate.freshness.dataAsOfLabel}
                </time>
              ) : null}
            </>
          ) : null}
          {!providerHealth.rankingEligible ? (
            <span>{providerHealth.rankingLabel}</span>
          ) : null}
        </div>
      ) : null}

      <dl className={styles.details}>
        <div>
          <dt>EV confidence</dt>
          <dd aria-label={estimate.confidence.accessibleLabel}>
            {estimate.confidence.displayValue}
          </dd>
        </div>
        <div>
          <dt>{desiredSearchActive ? "Desired chase" : "Top chase"}</dt>
          <dd>{displayedChase?.collectible.name ?? "Unavailable"}</dd>
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
            onSelect={onSelect}
            repack={repack}
            selected={repack.publicRepackId === selectedPublicRepackId}
          />
        ))}
      </div>
    </section>
  );
}
