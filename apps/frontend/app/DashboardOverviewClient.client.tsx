"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  PublicRepackFilters,
  PublicRepackViewDetailV3,
} from "@packscout/contracts";
import type { DashboardBundleV3 } from "@/lib/public-repacks-v3";
import { CatalogFilters } from "@/components/catalog/CatalogFilters.client";
import { OverviewDashboard } from "@/components/catalog/OverviewDashboard.client";
import type { InspectorActionOutcome } from "@/components/catalog/PackInspector.client";
import {
  NoMatches,
  type CatalogConstraint,
} from "@/components/catalog-state";
import {
  formatDollarAmount,
  serializeDashboardFilters,
} from "@/lib/catalog-query-state.client";
import { useNarrowCatalogInspector } from "@/lib/catalog-viewport.client";
import {
  dashboardHrefFor,
  type DashboardProvider,
} from "@/lib/provider-banner";
import {
  createDashboardViewEvent,
  createFiltersAppliedEvent,
  createPromoCopiedEvent,
  createRepackLinkOpenedEvent,
  queueProductTelemetry,
} from "@/lib/telemetry.client";
import styles from "./DashboardOverviewClient.module.css";

type DashboardOverviewClientProps = Readonly<{
  bundle: DashboardBundleV3;
  details: readonly PublicRepackViewDetailV3[];
  provider: DashboardProvider | null;
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
): 0 | 1 | 2 | 3 | 4 | 5 {
  return (Number(filters.vendors.length > 0) +
    Number(filters.categories.length > 0) +
    Number(filters.collectibleTypes.length > 0) +
    Number(filters.price.mode === "narrowed") +
    Number(filters.availability === "all")) as 0 | 1 | 2 | 3 | 4 | 5;
}

function activeConstraints(
  filters: PublicRepackFilters,
): readonly CatalogConstraint[] {
  const constraints: CatalogConstraint[] = [];
  if (filters.vendors.length > 0) {
    constraints.push({ label: "Vendors", value: filters.vendors.join(", ") });
  }
  if (filters.categories.length > 0) {
    constraints.push({
      label: "Categories",
      value: filters.categories.join(", "),
    });
  }
  if (filters.collectibleTypes.length > 0) {
    constraints.push({
      label: "Collectible types",
      value: filters.collectibleTypes.join(", "),
    });
  }
  if (filters.availability === "all") {
    constraints.push({
      label: "Availability",
      value: "Including unavailable, unknown, and sold-out packs",
    });
  }
  if (filters.price.mode === "narrowed") {
    constraints.push({
      label: "Repack Price",
      value: `$${formatDollarAmount(filters.price.minMinor)}–$${formatDollarAmount(filters.price.maxMinor)}`,
    });
  }
  return constraints;
}

export function DashboardOverviewClient({
  bundle,
  details,
  provider,
}: DashboardOverviewClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedPublicRepackId, setSelectedPublicRepackId] = useState<string | null>(
    bundle.selectedRepack?.publicRepackId ?? null,
  );
  const [feedback, setFeedback] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sideInspectorDismissed, setSideInspectorDismissed] = useState(false);
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
    startTransition(() =>
      router.push(serializeDashboardFilters(filters, provider ?? undefined)),
    );
  }

  function resetFilters() {
    startTransition(() => router.push(dashboardHrefFor(provider)));
  }

  useEffect(() => {
    queueProductTelemetry(
      createDashboardViewEvent({
        publicReleaseId: bundle.release.publicReleaseId,
        surface: "overview",
      }),
    );
  }, [bundle.release.publicReleaseId]);

  useEffect(() => {
    const count = activeFilterCount(bundle.activeFilters);
    if (count === 0) return;
    queueProductTelemetry(
      createFiltersAppliedEvent({
        publicReleaseId: bundle.release.publicReleaseId,
        surface: "overview",
        outcome: bundle.kpis.totalRepacks === 0 ? "no_matches" : "results",
        activeFilterCount: count,
        resultCount: bundle.kpis.totalRepacks,
      }),
    );
  }, [
    bundle.activeFilters,
    bundle.kpis.totalRepacks,
    bundle.release.publicReleaseId,
  ]);

  function reportInspectorAction(outcome: InspectorActionOutcome) {
    setFeedback(actionMessage(outcome));
    queueProductTelemetry(
      outcome.name === "promo_copied"
        ? createPromoCopiedEvent({
            publicReleaseId: bundle.release.publicReleaseId,
            publicRepackId: outcome.publicRepackId,
            vendorKey: outcome.vendorKey,
            outcome: outcome.outcome,
          })
        : createRepackLinkOpenedEvent({
            publicReleaseId: bundle.release.publicReleaseId,
            publicRepackId: outcome.publicRepackId,
            vendorKey: outcome.vendorKey,
            outcome: outcome.outcome,
          }),
    );
  }

  const filterControls = (
    <CatalogFilters
      accepted={bundle.activeFilters}
      facets={bundle.facets}
      onApply={navigate}
      onReset={resetFilters}
      pending={pending}
      showAvailabilityToggle={false}
    />
  );

  if (bundle.kpis.totalRepacks === 0) {
    return (
      <div className={styles.root}>
        {filterControls}
        <NoMatches
          constraints={activeConstraints(bundle.activeFilters)}
          onClearFilters={resetFilters}
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <OverviewDashboard
        bundle={selectedBundle}
        controls={filterControls}
        inspectorOpen={narrowInspector ? sheetOpen : !sideInspectorDismissed}
        inspectorPlacement={narrowInspector ? "sheet" : "side"}
        inspectorReturnFocusRef={selectionTriggerRef}
        onCloseInspector={() => {
          if (narrowInspector) setSheetOpen(false);
          else setSideInspectorDismissed(true);
        }}
        onInspectorAction={reportInspectorAction}
        onSelectOpportunity={(publicRepackId, trigger) => {
          selectionTriggerRef.current = trigger;
          setSelectedPublicRepackId(publicRepackId);
          if (narrowInspector) setSheetOpen(true);
          else setSideInspectorDismissed(false);
        }}
        selectedPublicRepackId={selectedPublicRepackId}
      />
      <p aria-live="polite" className={styles.feedback} role="status">
        {feedback}
      </p>
    </div>
  );
}
