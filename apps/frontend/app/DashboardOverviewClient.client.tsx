"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import type {
  DashboardBundle,
  PublicCatalogFilters,
  PublicPackDetail,
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
  createPackLinkOpenedEvent,
  createPromoCopiedEvent,
  queueProductTelemetry,
} from "@/lib/telemetry.client";
import styles from "./DashboardOverviewClient.module.css";

type DashboardOverviewClientProps = Readonly<{
  bundle: DashboardBundle;
  details: readonly PublicPackDetail[];
}>;

function actionMessage(outcome: InspectorActionOutcome): string {
  if (outcome.name === "pack_link_opened") return "Provider listing opened in a new tab.";
  return outcome.outcome === "clipboard"
    ? "Promo code copied."
    : "Clipboard access is unavailable. Copy the visible code manually.";
}

function activeFilterCount(filters: PublicCatalogFilters): 0 | 1 | 2 | 3 {
  return (Number(filters.platforms.length > 0) +
    Number(filters.categories.length > 0) +
    Number(filters.price.mode === "narrowed")) as 0 | 1 | 2 | 3;
}

export function DashboardOverviewClient({
  bundle,
  details,
}: DashboardOverviewClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedPublicPackId, setSelectedPublicPackId] = useState<string | null>(
    bundle.selectedPack?.publicPackId ?? null,
  );
  const [feedback, setFeedback] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const narrowInspector = useNarrowCatalogInspector();
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const detailById = useMemo(
    () => new Map(details.map((detail) => [detail.publicPackId, detail])),
    [details],
  );
  const selectedPack = selectedPublicPackId
    ? detailById.get(selectedPublicPackId) ??
      (bundle.selectedPack?.publicPackId === selectedPublicPackId ? bundle.selectedPack : null)
    : bundle.selectedPack;
  const selectedBundle = useMemo(
    () => ({ ...bundle, selectedPack: selectedPack ?? null }),
    [bundle, selectedPack],
  );

  function navigate(filters: PublicCatalogFilters) {
    startTransition(() => router.push(serializeDashboardFilters(filters)));
  }

  const allPacksHref = serializeCatalogQueryState({
    ...DEFAULT_CATALOG_QUERY,
    filters: bundle.activeFilters,
  });

  useEffect(() => {
    queueProductTelemetry(
      createDashboardViewEvent({
        snapshotVersion: bundle.metadata.publicationId,
        surface: "overview",
      }),
    );
  }, [bundle.metadata.publicationId]);

  useEffect(() => {
    const count = activeFilterCount(bundle.activeFilters);
    if (count === 0) return;
    queueProductTelemetry(
      createFiltersAppliedEvent({
        snapshotVersion: bundle.metadata.publicationId,
        surface: "overview",
        outcome: bundle.kpis.totalPacks === 0 ? "no_matches" : "results",
        activeFilterCount: count,
        resultCount: bundle.kpis.totalPacks,
      }),
    );
  }, [
    bundle.activeFilters,
    bundle.kpis.totalPacks,
    bundle.metadata.publicationId,
  ]);

  function reportInspectorAction(outcome: InspectorActionOutcome) {
    setFeedback(actionMessage(outcome));
    queueProductTelemetry(
      outcome.name === "promo_copied"
        ? createPromoCopiedEvent({
            snapshotVersion: bundle.metadata.publicationId,
            publicPackId: outcome.publicPackId,
            platformKey: outcome.platformKey,
            outcome: outcome.outcome,
          })
        : createPackLinkOpenedEvent({
            snapshotVersion: bundle.metadata.publicationId,
            publicPackId: outcome.publicPackId,
            platformKey: outcome.platformKey,
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
            <Link className={styles.viewAll} href={allPacksHref}>
              View all packs <span aria-hidden="true">→</span>
            </Link>
          </div>
        }
        inspectorOpen={!narrowInspector || sheetOpen}
        inspectorPlacement={narrowInspector ? "sheet" : "side"}
        inspectorReturnFocusRef={selectionTriggerRef}
        onCloseInspector={() => setSheetOpen(false)}
        onInspectorAction={reportInspectorAction}
        onSelectOpportunity={(publicPackId, trigger) => {
          selectionTriggerRef.current = trigger;
          setSelectedPublicPackId(publicPackId);
          if (narrowInspector) setSheetOpen(true);
        }}
        selectedPublicPackId={selectedPublicPackId}
      />
      <p aria-live="polite" className={styles.feedback} role="status">{feedback}</p>
    </div>
  );
}
