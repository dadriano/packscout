"use client";

import Link from "next/link";
import {
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  DataReleaseMetadata,
  PublicRepackChase,
  PublicRepackViewDetail,
} from "@packscout/contracts";
import { SavedRepackButton } from "@/components/auth/SavedItemButton.client";
import { EstimatedEvMetrics } from "@/components/metrics/EstimatedEvMetrics";
import { MetricValue } from "@/components/metrics/MetricValue";
import {
  presentBuyback,
  presentPackScoutEv,
  presentVendorReportedEv,
} from "@/lib/metric-presentation";
import { EXPECTED_VALUE_ARTICLE_HREF } from "@/lib/metric-vocabulary";
import { CatalogImage } from "./CatalogImage.client";
import { RepackHeatDetails } from "./RepackHeatDetails";
import {
  buildPublishedRepackHref,
  copyPublicPromoCode,
  type ClipboardWriter,
} from "./pack-actions.client";
import {
  presentEstimateCoverage,
  presentEstimateTiming,
  presentTopChase,
  presentVendorReportedObservation,
} from "./pack-inspector-presentation";
import { presentRepackPrice } from "./overview-presentation";
import styles from "./PackInspector.module.css";

export type InspectorActionOutcome =
  | Readonly<{
      name: "promo_copied";
      publicRepackId: string;
      vendorKey: string;
      outcome: "clipboard" | "manual_fallback";
    }>
  | Readonly<{
      name: "repack_link_opened";
      publicRepackId: string;
      vendorKey: string;
      outcome: "opened";
    }>;

export type RepackInspectorProps = Readonly<{
  repack: PublicRepackViewDetail;
  metadata: DataReleaseMetadata;
  placement?: "side" | "preview" | "sheet";
  clipboardWriter?: ClipboardWriter | null;
  onActionOutcome?: (outcome: InspectorActionOutcome) => void;
  onClose?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  highlightedChase?: PublicRepackChase | null;
}>;

type PartnerActionsProps = Pick<
  RepackInspectorProps,
  "clipboardWriter" | "onActionOutcome"
> & { readonly repack: PublicRepackViewDetail };

function PartnerActions({
  repack,
  clipboardWriter,
  onActionOutcome,
}: PartnerActionsProps) {
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "manual"
  >("idle");
  const manualCodeRef = useRef<HTMLInputElement>(null);
  const promo = repack.actions.promo;
  const outbound = buildPublishedRepackHref(
    repack.actions.repackLink,
    repack.availability,
  );

  async function copyPromo() {
    if (!promo) return;
    const result = await copyPublicPromoCode(
      promo.code,
      clipboardWriter,
    );
    if (result.ok) {
      setCopyState("copied");
      onActionOutcome?.({
        name: "promo_copied",
        publicRepackId: repack.publicRepackId,
        vendorKey: repack.vendorKey,
        outcome: "clipboard",
      });
      return;
    }
    setCopyState("manual");
    onActionOutcome?.({
      name: "promo_copied",
      publicRepackId: repack.publicRepackId,
      vendorKey: repack.vendorKey,
      outcome: "manual_fallback",
    });
    requestAnimationFrame(() => {
      manualCodeRef.current?.focus();
      manualCodeRef.current?.select();
    });
  }

  function reportOutboundOpen() {
    queueMicrotask(() => {
      onActionOutcome?.({
        name: "repack_link_opened",
        publicRepackId: repack.publicRepackId,
        vendorKey: repack.vendorKey,
        outcome: "opened",
      });
    });
  }

  if (!promo && !outbound.ok && outbound.code !== "SOLD_OUT") return null;

  return (
    <section aria-labelledby={`partner-actions-${repack.publicRepackId}`} className={styles.actions}>
      <h3 className="sr-only" id={`partner-actions-${repack.publicRepackId}`}>
        Partner actions
      </h3>

      {promo ? (
        <div className={styles.promo}>
          <span className={styles.promoLabel}>{promo.label}</span>
          <code className={styles.promoCode}>{promo.code}</code>
          <button className={styles.copyButton} onClick={copyPromo} type="button">
            {copyState === "copied" ? "Copied" : "Copy promo"}
          </button>
          <span aria-live="polite" className={styles.copyStatus} role="status">
            {copyState === "copied" ? "Promo code copied" : ""}
            {copyState === "manual" ? "Copy the code manually" : ""}
          </span>
          {copyState === "manual" ? (
            <label className={styles.manualCopy}>
              <span>Promo code</span>
              <input
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                ref={manualCodeRef}
                value={promo.code}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {outbound.ok ? (
        <div className={styles.openPackGroup}>
          <a
            className={styles.openPack}
            href={outbound.href}
            onClick={reportOutboundOpen}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open repack
            <span aria-hidden="true">↗</span>
            <span className="sr-only"> in a new tab</span>
          </a>
          <p>Opens the vendor listing in a new tab.</p>
        </div>
      ) : outbound.code === "SOLD_OUT" ? (
        <div className={styles.openPackGroup}>
          <button className={styles.openPack} disabled type="button">
            Open repack
          </button>
          <p>This repack is sold out.</p>
        </div>
      ) : null}
    </section>
  );
}

export function RepackInspector({
  repack,
  metadata,
  placement = "side",
  clipboardWriter,
  onActionOutcome,
  onClose,
  returnFocusRef,
  highlightedChase,
}: RepackInspectorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const price = presentRepackPrice(repack.price);
  const packScoutEv = presentPackScoutEv({
    repackPrice: repack.price.usdComparison,
    estimate: repack.evEstimates.packScout,
  });
  const vendorEv = presentVendorReportedEv(repack.evEstimates.vendorReported);
  const vendorObservation = presentVendorReportedObservation(vendorEv.observedAt);
  const buyback = presentBuyback(repack.buyback);
  const timing = presentEstimateTiming(repack.evEstimates.packScout, metadata);
  const coverage = presentEstimateCoverage(repack.contentSummary);
  const showsDesiredChase = highlightedChase !== undefined;
  const chaseValueLabel = showsDesiredChase
    ? "Desired Chase Value"
    : "Top Chase Value";
  const chase = presentTopChase(
    showsDesiredChase ? highlightedChase ?? null : repack.topChase,
    showsDesiredChase ? "Desired chase match" : "Top chase",
    chaseValueLabel,
  );
  const headingId = `repack-inspector-${placement}-${repack.publicRepackId}`;

  useEffect(() => {
    if (placement !== "sheet") return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [placement]);

  function closeSheet() {
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose?.();
    requestAnimationFrame(() => returnFocusRef?.current?.focus());
  }

  function handleSheetCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeSheet();
  }

  function handleSheetKeys(event: KeyboardEvent<HTMLElement>) {
    if (placement !== "sheet") return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const content = (
    <>
      {placement === "sheet" ? (
        <button
          aria-label="Close repack details"
          autoFocus
          className={styles.closeButton}
          onClick={closeSheet}
          ref={closeButtonRef}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}

      <header className={styles.hero}>
        <CatalogImage
          fallbackAlt={repack.name}
          image={repack.primaryImage}
          variant="pack"
        />
        <div className={styles.identity}>
          <span className={styles.availability} data-state={repack.availability}>
            {repack.availability === "active" ? "Available" : "Sold out"}
          </span>
          <p className={styles.category}>
            {repack.categories.length > 0
              ? repack.categories.map(({ label }) => label).join(" · ")
              : "Uncategorized"}
          </p>
          <h2 className={styles.packName} id={headingId}>
            {repack.name}
          </h2>
          <p className={styles.vendor}>
            {repack.vendorLogoUrl ? (
              <CatalogImage
                decorative
                fallback="none"
                fallbackAlt={`${repack.vendorDisplayName} logo`}
                image={{
                  url: repack.vendorLogoUrl,
                  alt: `${repack.vendorDisplayName} logo`,
                }}
                variant="vendor"
              />
            ) : null}
            <span>Offered by {repack.vendorDisplayName}</span>
          </p>
          <p className={styles.price}>
            <span aria-hidden="true">{price.displayValue}</span>
            <span className="sr-only">{price.accessibleLabel}</span>
            {price.reasonCopy ? (
              <small aria-hidden="true">{price.reasonCopy}</small>
            ) : null}
          </p>
          <div className={styles.saveAction}>
            <SavedRepackButton publicRepackId={repack.publicRepackId} />
          </div>
        </div>
      </header>

      <div className={styles.sectionBlock}>
        <EstimatedEvMetrics compact presentation={packScoutEv} />
        <div className={styles.vendorEstimate}>
          <div className={styles.sectionHeading}>
            <h3>Vendor-reported EV</h3>
            <span>Reported by vendor</span>
          </div>
          <div className={styles.vendorEstimateMetrics}>
            <MetricValue
              compact
              metric={vendorEv.evPercent}
              showReason={false}
              showSemanticState={false}
            />
            <MetricValue
              compact
              metric={vendorEv.reportedGrossEv}
              showReason={false}
              showSemanticState={false}
            />
          </div>
          {vendorEv.reasonCopy ? (
            <p className={styles.vendorEstimateReason}>{vendorEv.reasonCopy}</p>
          ) : null}
          {vendorObservation ? (
            <p className={styles.vendorEstimateContext}>
              <time dateTime={vendorObservation.observedAt}>
                {vendorObservation.label}
              </time>
            </p>
          ) : null}
        </div>
        <div className={styles.buybackMetric}>
          <MetricValue compact metric={buyback} />
        </div>
        <div className={styles.estimateContext}>
          <p>{coverage}</p>
          <p>
            {timing.calculatedAt ? (
              <time dateTime={timing.calculatedAt}>{timing.calculatedLabel}</time>
            ) : (
              timing.calculatedLabel
            )}
          </p>
          <p>
            <time dateTime={timing.dataAsOf}>{timing.releaseLabel}</time>
          </p>
          {packScoutEv.confidence.limitations.length > 0 ? (
            <ul className={styles.limitations}>
              {packScoutEv.confidence.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          ) : null}
          <Link className={styles.learnLink} href={EXPECTED_VALUE_ARTICLE_HREF}>
            How this estimate works
            <span aria-hidden="true"> →</span>
          </Link>
        </div>
      </div>

      <RepackHeatDetails
        headingId={`recent-heat-${repack.publicRepackId}`}
        heat={repack.heat}
      />

      <section aria-labelledby={`top-chase-${repack.publicRepackId}`} className={styles.chase}>
        <div className={styles.sectionHeading}>
          <h3 id={`top-chase-${repack.publicRepackId}`}>
            {showsDesiredChase ? "Desired chase match" : "Top chase"}
          </h3>
          <span>
            {chaseValueLabel}
          </span>
        </div>
        {chase.availability === "available" ? (
          <div className={styles.chaseContent}>
            <span className="sr-only">{chase.accessibleLabel}</span>
            <CatalogImage
              fallback="none"
              fallbackAlt={chase.name}
              image={chase.image}
              variant="chase"
            />
            <div aria-hidden="true">
              <p className={styles.chaseName}>{chase.name}</p>
              <p className={styles.chaseValue}>{chase.displayValue}</p>
              {chase.valueAvailability === "unavailable" ? (
                <p className={styles.chaseValueReason}>{chase.reasonCopy}</p>
              ) : null}
              <p className={styles.chaseEvidence}>{chase.evidenceLabel}</p>
              <p className={styles.chaseEvidence}>{chase.matchConfidenceLabel}</p>
            </div>
          </div>
        ) : (
          <div className={styles.chaseUnavailable}>
            <span className="sr-only">{chase.accessibleLabel}</span>
            <span aria-hidden="true">{chase.name}</span>
            <small aria-hidden="true">{chase.reasonCopy}</small>
          </div>
        )}
      </section>

      <PartnerActions
        clipboardWriter={clipboardWriter}
        key={repack.publicRepackId}
        onActionOutcome={onActionOutcome}
        repack={repack}
      />
    </>
  );

  if (placement === "sheet") {
    return (
      <dialog
        aria-labelledby={headingId}
        className={styles.inspector}
        data-placement="sheet"
        data-state={packScoutEv.semanticState}
        onCancel={handleSheetCancel}
        onKeyDown={handleSheetKeys}
        ref={dialogRef}
      >
        {content}
      </dialog>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className={styles.inspector}
      data-placement={placement}
      data-state={packScoutEv.semanticState}
      role="complementary"
    >
      {content}
    </section>
  );
}
