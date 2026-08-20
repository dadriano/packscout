"use client";

import type { ReactNode, RefObject } from "react";
import type { DashboardBundle } from "@packscout/contracts";
import {
  DEFAULT_CATALOG_QUERY,
  serializeCatalogQueryState,
} from "@/lib/catalog-query-state.client";
import type { ClipboardWriter } from "./pack-actions.client";
import { CatalogSummaries } from "./CatalogSummaries";
import { OpportunityTable } from "./OpportunityTable.client";
import { OverviewKpis } from "./OverviewKpis";
import {
  RepackInspector,
  type InspectorActionOutcome,
} from "./PackInspector.client";
import { resolveOverviewSelection } from "./overview-presentation";
import styles from "./OverviewDashboard.module.css";

type OverviewDashboardProps = Readonly<{
  bundle: DashboardBundle;
  controls?: ReactNode;
  selectedPublicRepackId?: string | null;
  inspectorPlacement?: "side" | "preview" | "sheet";
  inspectorOpen?: boolean;
  clipboardWriter?: ClipboardWriter | null;
  inspectorReturnFocusRef?: RefObject<HTMLElement | null>;
  onCloseInspector?: () => void;
  onInspectorAction?: (outcome: InspectorActionOutcome) => void;
  onSelectOpportunity: (
    publicRepackId: string,
    trigger: HTMLButtonElement,
  ) => void;
}>;

export function OverviewDashboard({
  bundle,
  controls,
  selectedPublicRepackId,
  inspectorPlacement = "side",
  inspectorOpen = true,
  clipboardWriter,
  inspectorReturnFocusRef,
  onCloseInspector,
  onInspectorAction,
  onSelectOpportunity,
}: OverviewDashboardProps) {
  const selectedId = resolveOverviewSelection(
    bundle.opportunities,
    selectedPublicRepackId ?? bundle.selectedRepack?.publicRepackId,
  );
  const selectedRepack =
    bundle.selectedRepack?.publicRepackId === selectedId
      ? bundle.selectedRepack
      : null;

  const showSideInspector =
    inspectorOpen && inspectorPlacement === "side";
  const showSheetInspector =
    inspectorOpen && inspectorPlacement === "sheet" && selectedRepack;
  const repacksHref = serializeCatalogQueryState({
    ...DEFAULT_CATALOG_QUERY,
    filters: bundle.activeFilters,
  });

  return (
    <section
      aria-label="PackScout repack overview"
      className={styles.workspace}
      data-has-side-inspector={showSideInspector}
    >
      <div className={styles.resultsColumn}>
        <OverviewKpis kpis={bundle.kpis} repacksHref={repacksHref} />
        {controls ? <div className={styles.controls}>{controls}</div> : null}
        <OpportunityTable
          onSelectOpportunity={onSelectOpportunity}
          opportunities={bundle.opportunities}
          selectedPublicRepackId={selectedId}
        />
        <div className={styles.summaryGrid}>
          <CatalogSummaries
            activeFilters={bundle.activeFilters}
            summaries={bundle.vendorSummaries}
            title="By vendor"
          />
          <CatalogSummaries
            activeFilters={bundle.activeFilters}
            summaries={bundle.categorySummaries}
            title="By category"
          />
        </div>
      </div>

      {showSideInspector ? (
        <div className={styles.inspectorColumn}>
          {selectedRepack ? (
            <RepackInspector
              clipboardWriter={clipboardWriter}
              key={selectedRepack.publicRepackId}
              metadata={bundle.metadata}
              onActionOutcome={onInspectorAction}
              onClose={onCloseInspector}
              repack={selectedRepack}
              placement={inspectorPlacement}
              returnFocusRef={inspectorReturnFocusRef}
            />
          ) : (
            <aside aria-label="Repack details" className={styles.pendingInspector}>
              <p>
                {selectedId
                  ? "Updating selected repack details…"
                  : "Select an opportunity to inspect its current evidence."}
              </p>
            </aside>
          )}
        </div>
      ) : null}

      {showSheetInspector ? (
        <RepackInspector
          clipboardWriter={clipboardWriter}
          key={selectedRepack.publicRepackId}
          metadata={bundle.metadata}
          onActionOutcome={onInspectorAction}
          onClose={onCloseInspector}
          repack={selectedRepack}
          placement="sheet"
          returnFocusRef={inspectorReturnFocusRef}
        />
      ) : null}
    </section>
  );
}
