"use client";

import type { ReactNode, RefObject } from "react";
import type { DashboardBundle } from "@packscout/contracts";
import type { ClipboardWriter } from "./pack-actions.client";
import { CatalogSummaries } from "./CatalogSummaries";
import { OpportunityTable } from "./OpportunityTable.client";
import { OverviewKpis } from "./OverviewKpis";
import {
  PackInspector,
  type InspectorActionOutcome,
} from "./PackInspector.client";
import { resolveOverviewSelection } from "./overview-presentation";
import styles from "./OverviewDashboard.module.css";

type OverviewDashboardProps = Readonly<{
  bundle: DashboardBundle;
  controls?: ReactNode;
  selectedPublicPackId?: string | null;
  inspectorPlacement?: "side" | "preview" | "sheet";
  inspectorOpen?: boolean;
  clipboardWriter?: ClipboardWriter | null;
  inspectorReturnFocusRef?: RefObject<HTMLElement | null>;
  onCloseInspector?: () => void;
  onInspectorAction?: (outcome: InspectorActionOutcome) => void;
  onSelectOpportunity: (
    publicPackId: string,
    trigger: HTMLButtonElement,
  ) => void;
}>;

export function OverviewDashboard({
  bundle,
  controls,
  selectedPublicPackId,
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
    selectedPublicPackId ?? bundle.selectedPack?.publicPackId,
  );
  const selectedPack =
    bundle.selectedPack?.publicPackId === selectedId
      ? bundle.selectedPack
      : null;

  return (
    <section aria-label="PackScout catalog overview" className={styles.workspace}>
      <div className={styles.resultsColumn}>
        <OverviewKpis kpis={bundle.kpis} />
        {controls ? <div className={styles.controls}>{controls}</div> : null}
        <OpportunityTable
          onSelectOpportunity={onSelectOpportunity}
          opportunities={bundle.opportunities}
          selectedPublicPackId={selectedId}
        />
        <div className={styles.summaryGrid}>
          <CatalogSummaries
            summaries={bundle.platformSummaries}
            title="By platform"
          />
          <CatalogSummaries
            summaries={bundle.categorySummaries}
            title="By category"
          />
        </div>
      </div>

      <div className={styles.inspectorColumn}>
        {!inspectorOpen ? null : selectedPack ? (
          <PackInspector
            clipboardWriter={clipboardWriter}
            key={selectedPack.publicPackId}
            metadata={bundle.metadata}
            onActionOutcome={onInspectorAction}
            onClose={onCloseInspector}
            pack={selectedPack}
            placement={inspectorPlacement}
            returnFocusRef={inspectorReturnFocusRef}
          />
        ) : (
          <aside aria-label="Pack details" className={styles.pendingInspector}>
            <p>
              {selectedId
                ? "Updating selected pack details…"
                : "Select an opportunity to inspect its current evidence."}
            </p>
          </aside>
        )}
      </div>
    </section>
  );
}
