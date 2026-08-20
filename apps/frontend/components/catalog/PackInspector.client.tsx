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
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import { MetricValue } from "@/components/metrics/MetricValue";
import {
  presentBuyback,
  presentPackScoutEv,
  presentVendorReportedEv,
} from "@/lib/metric-presentation";
import {
  DEFAULT_CATALOG_QUERY,
  catalogHrefForSummary,
} from "@/lib/catalog-query-state.client";
import {
  EXPECTED_VALUE_ARTICLE_HREF,
  METRIC_TRUST_COPY,
} from "@/lib/metric-vocabulary";
import { CatalogImage } from "./CatalogImage.client";
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

type RepackDestinationActionProps = Pick<
  RepackInspectorProps,
  "onActionOutcome"
> & { readonly repack: PublicRepackViewDetail };

function RepackDestinationAction({
  repack,
  onActionOutcome,
}: RepackDestinationActionProps) {
  const outbound = buildPublishedRepackHref(
    repack.actions.repackLink,
    repack.availability,
  );
  const vendorCatalogHref = catalogHrefForSummary(
    {
      ...DEFAULT_CATALOG_QUERY.filters,
      availability: repack.availability === "sold_out" ? "all" : "active",
    },
    { type: "vendor", key: repack.vendorKey },
  );

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

  return (
    <div className={styles.repackDestination}>
      {outbound.ok ? (
        <a
          className={styles.openPack}
          href={outbound.href}
          onClick={reportOutboundOpen}
          rel="noopener noreferrer"
          target="_blank"
        >
          Visit repack
          <span aria-hidden="true">↗</span>
          <span className="sr-only"> in a new tab</span>
        </a>
      ) : (
        <Link className={styles.openPack} href={vendorCatalogHref}>
          Browse {repack.vendorDisplayName} repacks
        </Link>
      )}
      <p>
        {outbound.ok
          ? "Opens the vendor listing in a new tab."
          : "This listing has no published direct link."}
      </p>
    </div>
  );
}

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

  if (!promo) return null;

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
  const chaseUnavailableReason =
    chase.reasonCopy ?? METRIC_TRUST_COPY.unavailableExplanation;
  const headingId = `repack-inspector-${placement}-${repack.publicRepackId}`;
  const vendorLimitations = packScoutEv.confidence.limitations.filter((limitation) =>
    /vendor/i.test(limitation),
  );
  const estimateLimitations = packScoutEv.confidence.limitations.filter(
    (limitation) => !/vendor/i.test(limitation),
  );
  const estimatedEvHint = [
    METRIC_TRUST_COPY.longRunExplanation,
    timing.calculatedLabel,
    timing.releaseLabel,
    ...estimateLimitations,
  ].join(" ");
  const vendorReportedEvHint = [
    METRIC_TRUST_COPY.sourceExplanation,
    vendorObservation?.label,
    ...vendorLimitations,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (placement !== "sheet") return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [placement]);

  function closeInspector() {
    if (placement === "sheet" && dialogRef.current?.open) {
      dialogRef.current.close();
    }
    onClose?.();
    requestAnimationFrame(() => returnFocusRef?.current?.focus());
  }

  function handleSheetCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeInspector();
  }

  function handleSheetKeys(event: KeyboardEvent<HTMLElement>) {
    if (placement !== "sheet") return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeInspector();
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
      {onClose ? (
        <button
          aria-label="Close repack details"
          autoFocus={placement === "sheet"}
          className={styles.closeButton}
          onClick={closeInspector}
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
            ) : (
              <span aria-hidden="true" className={styles.vendorMark}>
                {repack.vendorDisplayName.trim().slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>
              Offered by <strong>{repack.vendorDisplayName}</strong>
            </span>
          </p>
          <p className={styles.price}>
            <span className={styles.priceValue}>
              <span aria-hidden="true">{price.displayValue}</span>
              <GlossaryHint field="repackPrice" />
            </span>
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

      <div className={styles.detailsGrid}>
        <div className={styles.sectionBlock}>
          <EstimatedEvMetrics
            compact
            headingHint={{
              label: "Estimated EV",
              definition: estimatedEvHint,
              learnHref: EXPECTED_VALUE_ARTICLE_HREF,
            }}
            presentation={packScoutEv}
            showFinancialDisclaimer={false}
            showRepackPrice={false}
          />
          <div className={styles.vendorEstimate}>
            <div className={styles.sectionHeading}>
              <h3>
                Vendor-reported EV
                <GlossaryHint
                  content={{
                    label: "Vendor-reported EV",
                    definition: vendorReportedEvHint,
                    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
                  }}
                  field="vendorReportedEv"
                />
              </h3>
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
              <p className={styles.vendorEstimateReason}>
                {vendorEv.reasonCopy}
              </p>
            ) : null}
          </div>
          <div className={styles.buybackMetric}>
            <MetricValue
              compact
              glossaryContent={{
                label: buyback.label,
                definition: coverage,
              }}
              metric={buyback}
            />
          </div>
          <div className={styles.estimateLearnMore}>
            <Link
              className={styles.learnLink}
              href={EXPECTED_VALUE_ARTICLE_HREF}
            >
              How this estimate works
              <span aria-hidden="true"> →</span>
            </Link>
            <span className={styles.financialDisclaimer}>
              {METRIC_TRUST_COPY.financialDisclaimer}
            </span>
          </div>
        </div>

        <div className={styles.secondaryDetails}>
          <section
            aria-labelledby={`top-chase-${repack.publicRepackId}`}
            className={styles.chase}
          >
            <div className={styles.sectionHeading}>
              <h3 id={`top-chase-${repack.publicRepackId}`}>
                {showsDesiredChase ? "Desired chase match" : "Top chase"}
              </h3>
              <span>{chaseValueLabel}</span>
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
                <div>
                  <p aria-hidden="true" className={styles.chaseName}>{chase.name}</p>
                  {chase.valueAvailability === "unavailable" ? (
                    <GlossaryHint
                      content={{
                        label: chaseValueLabel,
                        definition: chaseUnavailableReason,
                      }}
                      field="topChaseValue"
                      trigger={<span aria-hidden="true" className={styles.chaseValueUnavailableGlyph} />}
                      triggerAriaLabel={`${chaseValueLabel}: ${chase.displayValue}. ${chaseUnavailableReason}`}
                      triggerClassName={styles.chaseValueUnavailableTrigger}
                    />
                  ) : (
                    <p aria-hidden="true" className={styles.chaseValue}>{chase.displayValue}</p>
                  )}
                  <p aria-hidden="true" className={styles.chaseEvidence}>{chase.evidenceLabel}</p>
                  <p aria-hidden="true" className={styles.chaseEvidence}>
                    {chase.matchConfidenceLabel}
                  </p>
                </div>
              </div>
            ) : (
              <GlossaryHint
                content={{
                  label: showsDesiredChase ? "Desired chase match" : "Top chase",
                  definition: `${chase.name}. ${chaseUnavailableReason}`,
                }}
                field="topChase"
                trigger={
                  <span aria-hidden="true" className={styles.chaseUnavailableGlyph}>
                    <span />
                    <span />
                    <span />
                  </span>
                }
                triggerAriaLabel={chase.accessibleLabel}
                triggerClassName={styles.chaseUnavailableTrigger}
              />
            )}
          </section>
          <RepackDestinationAction
            onActionOutcome={onActionOutcome}
            repack={repack}
          />
        </div>
      </div>

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
