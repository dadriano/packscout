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
  PublicPackDetail,
  SnapshotMetadata,
} from "@packscout/contracts";
import { EstimatedEvMetrics } from "@/components/metrics/EstimatedEvMetrics";
import { MetricValue } from "@/components/metrics/MetricValue";
import {
  presentBuyback,
  presentEstimatedEv,
} from "@/lib/metric-presentation";
import { EXPECTED_VALUE_ARTICLE_HREF } from "@/lib/metric-vocabulary";
import { CatalogImage } from "./CatalogImage.client";
import {
  buildPublishedPackHref,
  copyPublicPromoCode,
  type ClipboardWriter,
} from "./pack-actions.client";
import {
  presentEstimateCoverage,
  presentEstimateTiming,
  presentTopChase,
} from "./pack-inspector-presentation";
import { presentPackPrice } from "./overview-presentation";
import styles from "./PackInspector.module.css";

export type InspectorActionOutcome =
  | Readonly<{
      name: "promo_copied";
      publicPackId: string;
      platformKey: string;
      outcome: "clipboard" | "manual_fallback";
    }>
  | Readonly<{
      name: "pack_link_opened";
      publicPackId: string;
      platformKey: string;
      outcome: "opened";
    }>;

export type PackInspectorProps = Readonly<{
  pack: PublicPackDetail;
  metadata: SnapshotMetadata;
  placement?: "side" | "preview" | "sheet";
  clipboardWriter?: ClipboardWriter | null;
  onActionOutcome?: (outcome: InspectorActionOutcome) => void;
  onClose?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}>;

type PartnerActionsProps = Pick<
  PackInspectorProps,
  "clipboardWriter" | "onActionOutcome"
> & { readonly pack: PublicPackDetail };

function PartnerActions({
  pack,
  clipboardWriter,
  onActionOutcome,
}: PartnerActionsProps) {
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "manual"
  >("idle");
  const manualCodeRef = useRef<HTMLInputElement>(null);
  const promo = pack.actions.promo;
  const outbound = buildPublishedPackHref(
    pack.actions.packLink,
    pack.availability,
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
        publicPackId: pack.publicPackId,
        platformKey: pack.platformKey,
        outcome: "clipboard",
      });
      return;
    }
    setCopyState("manual");
    onActionOutcome?.({
      name: "promo_copied",
      publicPackId: pack.publicPackId,
      platformKey: pack.platformKey,
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
        name: "pack_link_opened",
        publicPackId: pack.publicPackId,
        platformKey: pack.platformKey,
        outcome: "opened",
      });
    });
  }

  if (!promo && !outbound.ok && outbound.code !== "SOLD_OUT") return null;

  return (
    <section aria-labelledby={`partner-actions-${pack.publicPackId}`} className={styles.actions}>
      <h3 className="sr-only" id={`partner-actions-${pack.publicPackId}`}>
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
            Open pack
            <span aria-hidden="true">↗</span>
            <span className="sr-only"> in a new tab</span>
          </a>
          <p>Opens the provider listing in a new tab.</p>
        </div>
      ) : outbound.code === "SOLD_OUT" ? (
        <div className={styles.openPackGroup}>
          <button className={styles.openPack} disabled type="button">
            Open pack
          </button>
          <p>This pack is sold out.</p>
        </div>
      ) : null}
    </section>
  );
}

export function PackInspector({
  pack,
  metadata,
  placement = "side",
  clipboardWriter,
  onActionOutcome,
  onClose,
  returnFocusRef,
}: PackInspectorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const price = presentPackPrice(pack.price);
  const estimatedEv = presentEstimatedEv({
    packPrice: pack.price.usdComparison,
    estimatedEv: pack.estimatedEv,
  });
  const buyback = presentBuyback(pack.buyback);
  const timing = presentEstimateTiming(pack.estimatedEv, metadata);
  const coverage = presentEstimateCoverage(pack.estimatedEv.coverage);
  const chase = presentTopChase(pack.topChase);
  const headingId = `pack-inspector-${placement}-${pack.publicPackId}`;

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
          aria-label="Close pack details"
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
          fallbackAlt={pack.name}
          image={pack.primaryImage}
          variant="pack"
        />
        <div className={styles.identity}>
          <span className={styles.availability} data-state={pack.availability}>
            {pack.availability === "active" ? "Available" : "Sold out"}
          </span>
          <p className={styles.category}>{pack.category}</p>
          <h2 className={styles.packName} id={headingId}>
            {pack.name}
          </h2>
          <p className={styles.platform}>
            {pack.platformLogoUrl ? (
              <CatalogImage
                decorative
                fallback="none"
                fallbackAlt={`${pack.platformDisplayName} logo`}
                image={{
                  url: pack.platformLogoUrl,
                  alt: `${pack.platformDisplayName} logo`,
                }}
                variant="platform"
              />
            ) : null}
            <span>Offered by {pack.platformDisplayName}</span>
          </p>
          <p className={styles.price}>
            <span aria-hidden="true">{price.displayValue}</span>
            <span className="sr-only">{price.accessibleLabel}</span>
            {price.reasonCopy ? (
              <small aria-hidden="true">{price.reasonCopy}</small>
            ) : null}
          </p>
        </div>
      </header>

      <div className={styles.sectionBlock}>
        <EstimatedEvMetrics compact presentation={estimatedEv} />
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
            <time dateTime={timing.dataAsOf}>{timing.snapshotLabel}</time>
          </p>
          {pack.estimatedEv.limitations.length > 0 ? (
            <ul className={styles.limitations}>
              {pack.estimatedEv.limitations.map((limitation) => (
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

      <section aria-labelledby={`top-chase-${pack.publicPackId}`} className={styles.chase}>
        <div className={styles.sectionHeading}>
          <h3 id={`top-chase-${pack.publicPackId}`}>Top chase</h3>
          <span>Supported representative value</span>
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
        key={pack.publicPackId}
        onActionOutcome={onActionOutcome}
        pack={pack}
      />
    </>
  );

  if (placement === "sheet") {
    return (
      <dialog
        aria-labelledby={headingId}
        className={styles.inspector}
        data-placement="sheet"
        data-state={estimatedEv.semanticState}
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
      data-state={estimatedEv.semanticState}
      role="complementary"
    >
      {content}
    </section>
  );
}
