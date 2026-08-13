"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  DashboardBundle,
  PublicRepackFilters,
  PublicRepackViewDetail,
} from "@packscout/contracts";
import { CatalogFilters } from "@/components/catalog/CatalogFilters.client";
import { OverviewDashboard } from "@/components/catalog/OverviewDashboard.client";
import type { InspectorActionOutcome } from "@/components/catalog/PackInspector.client";
import {
  DEFAULT_CATALOG_QUERY,
  serializeCatalogQueryState,
  serializeDashboardFilters,
} from "@/lib/catalog-query-state.client";
import { useNarrowCatalogInspector } from "@/lib/catalog-viewport.client";
import {
  createDashboardViewEvent,
  createFiltersAppliedEvent,
  createPromoCopiedEvent,
  createRepackLinkOpenedEvent,
  queueProductTelemetry,
} from "@/lib/telemetry.client";
import styles from "./DashboardOverviewClient.module.css";

type DashboardOverviewClientProps = Readonly<{
  bundle: DashboardBundle;
  details: readonly PublicRepackViewDetail[];
}>;

function actionMessage(outcome: InspectorActionOutcome): string {
  if (outcome.name === "repack_link_opened") {
    return "Vendor listing opened in a new tab.";
  }
  return outcome.outcome === "clipboard"
    ? "Promo code copied."
    : "Clipboard access is unavailable. Copy the visible code manually.";
}

function activeFilterCount(
  filters: PublicRepackFilters,
): 0 | 1 | 2 | 3 | 4 {
  return (Number(filters.vendors.length > 0) +
    Number(filters.categories.length > 0) +
    Number(filters.collectibleTypes.length > 0) +
    Number(filters.price.mode === "narrowed")) as 0 | 1 | 2 | 3 | 4;
}

export function DashboardOverviewClient({
  bundle,
  details,
}: DashboardOverviewClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedPublicRepackId, setSelectedPublicRepackId] = useState<string | null>(
    bundle.selectedRepack?.publicRepackId ?? null,
  );
  const [feedback, setFeedback] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const narrowInspector = useNarrowCatalogInspector();
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const detailById = useMemo(
    () => new Map(details.map((detail) => [detail.publicRepackId, detail])),
    [details],
  );
  const selectedRepack = selectedPublicRepackId
    ? detailById.get(selectedPublicRepackId) ??
      (bundle.selectedRepack?.publicRepackId === selectedPublicRepackId
        ? bundle.selectedRepack
        : null)
    : bundle.selectedRepack;
  const selectedBundle = useMemo(
    () => ({ ...bundle, selectedRepack: selectedRepack ?? null }),
    [bundle, selectedRepack],
  );

  function navigate(filters: PublicRepackFilters) {
    startTransition(() => router.push(serializeDashboardFilters(filters)));
  }

  const allRepacksHref = serializeCatalogQueryState({
    ...DEFAULT_CATALOG_QUERY,
    filters: bundle.activeFilters,
  });

  useEffect(() => {
    queueProductTelemetry(
      createDashboardViewEvent({
        publicReleaseId: bundle.metadata.publicReleaseId,
        surface: "overview",
      }),
    );
  }, [bundle.metadata.publicReleaseId]);

  useEffect(() => {
    const count = activeFilterCount(bundle.activeFilters);
    if (count === 0) return;
    queueProductTelemetry(
      createFiltersAppliedEvent({
        publicReleaseId: bundle.metadata.publicReleaseId,
        surface: "overview",
        outcome: bundle.kpis.totalRepacks === 0 ? "no_matches" : "results",
        activeFilterCount: count,
        resultCount: bundle.kpis.totalRepacks,
      }),
    );
  }, [
    bundle.activeFilters,
    bundle.kpis.totalRepacks,
    bundle.metadata.publicReleaseId,
  ]);

  function reportInspectorAction(outcome: InspectorActionOutcome) {
    setFeedback(actionMessage(outcome));
    queueProductTelemetry(
      outcome.name === "promo_copied"
        ? createPromoCopiedEvent({
            publicReleaseId: bundle.metadata.publicReleaseId,
            publicRepackId: outcome.publicRepackId,
            vendorKey: outcome.vendorKey,
            outcome: outcome.outcome,
          })
        : createRepackLinkOpenedEvent({
            publicReleaseId: bundle.metadata.publicReleaseId,
            publicRepackId: outcome.publicRepackId,
            vendorKey: outcome.vendorKey,
            outcome: outcome.outcome,
          }),
    );
  }

  return (
    <div className={styles.root}>
      <OverviewDashboard
        bundle={selectedBundle}
        controls={
          <div className={styles.controls}>
            <CatalogFilters
              accepted={bundle.activeFilters}
              facets={bundle.facets}
              onApply={navigate}
              onReset={() => startTransition(() => router.push("/"))}
              pending={pending}
            />
            <Link className={styles.viewAll} href={allRepacksHref}>
              View all repacks <span aria-hidden="true">→</span>
            </Link>
          </div>
        }
        inspectorOpen={!narrowInspector || sheetOpen}
        inspectorPlacement={narrowInspector ? "sheet" : "side"}
        inspectorReturnFocusRef={selectionTriggerRef}
        onCloseInspector={() => setSheetOpen(false)}
        onInspectorAction={reportInspectorAction}
        onSelectOpportunity={(publicRepackId, trigger) => {
          selectionTriggerRef.current = trigger;
          setSelectedPublicRepackId(publicRepackId);
          if (narrowInspector) setSheetOpen(true);
        }}
        selectedPublicRepackId={selectedPublicRepackId}
      />
      <p aria-live="polite" className={styles.feedback} role="status">
        {feedback}
      </p>
    </div>
  );
}
