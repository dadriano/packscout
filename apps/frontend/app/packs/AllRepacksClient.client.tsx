"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type {
  ListPublicRepacksInput,
  PublicRepackFilters,
  PublicRepackSort,
  PublicRepackViewDetailV3,
} from "@packscout/contracts";
import type { ListPublicRepacksPageV3 } from "@/lib/public-repacks-v3";
import { AllRepacksTable } from "@/components/catalog/AllRepacksTable.client";
import { AllRepacksCards } from "@/components/catalog/AllRepacksCards.client";
import { CatalogFilters } from "@/components/catalog/CatalogFilters.client";
import { CatalogResultsControls } from "@/components/catalog/CatalogResultsControls.client";
import { CursorPagination } from "@/components/catalog/CursorPagination";
import {
  RepackInspector,
  type InspectorActionOutcome,
} from "@/components/catalog/PackInspector.client";
import {
  buildPublishedRepackHref,
  copyPublicPromoCode,
} from "@/components/catalog/pack-actions.client";
import { NoMatches } from "@/components/catalog-state";
import {
  DEFAULT_CATALOG_QUERY,
  type CatalogPageSize,
  type CatalogViewLayout,
  catalogQueryForPageNavigation,
  catalogSheetInspectorInitiallyOpen,
  clearCatalogRepackSelection,
  formatDollarAmount,
  nextCatalogPage,
  previousCatalogPage,
  resetCatalogPagination,
  selectCatalogRepack,
  serializeCatalogViewState,
} from "@/lib/catalog-query-state.client";
import { formatCollectibleIdentity } from "@/lib/collectible-identity";
import {
  createRepackSearchEvent,
  createDashboardViewEvent,
  createFiltersAppliedEvent,
  createPromoCopiedEvent,
  createRepackLinkOpenedEvent,
  queueProductTelemetry,
} from "@/lib/telemetry.client";
import styles from "./AllRepacksClient.module.css";

type AllRepacksClientProps = Readonly<{
  page: ListPublicRepacksPageV3;
  query: ListPublicRepacksInput;
  details: readonly PublicRepackViewDetailV3[];
  initialLayout: CatalogViewLayout;
}>;

function activeConstraints(page: ListPublicRepacksPageV3) {
  const constraints: Array<{ label: string; value: string }> = [];
  if (page.activeQuery.search) {
    constraints.push({ label: "Search", value: page.activeQuery.search });
  }
  if (page.activeQuery.filters.vendors.length > 0) {
    constraints.push({
      label: "Vendors",
      value: page.activeQuery.filters.vendors.join(", "),
    });
  }
  if (page.activeQuery.filters.categories.length > 0) {
    constraints.push({
      label: "Categories",
      value: page.activeQuery.filters.categories.join(", "),
    });
  }
  if (page.activeQuery.filters.collectibleTypes.length > 0) {
    constraints.push({
      label: "Collectible types",
      value: page.activeQuery.filters.collectibleTypes.join(", "),
    });
  }
  if (page.activeQuery.filters.availability === "all") {
    constraints.push({
      label: "Availability",
      value: "Including unavailable, unknown, and sold-out packs",
    });
  }
  if (page.activeQuery.filters.price.mode === "narrowed") {
    constraints.push({
      label: "Repack Price",
      value: `$${formatDollarAmount(page.activeQuery.filters.price.minMinor)}–$${formatDollarAmount(page.activeQuery.filters.price.maxMinor)}`,
    });
  }
  if (page.desiredCollectible) {
    constraints.push({
      label: "Desired chase",
      value: formatCollectibleIdentity(page.desiredCollectible),
    });
  }
  return constraints;
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

export function AllRepacksClient({
  page,
  query,
  details,
  initialLayout,
}: AllRepacksClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigationQuery = catalogQueryForPageNavigation(query, page);
  const navigationHref = serializeCatalogViewState(
    navigationQuery,
    initialLayout,
  );
  const initialInspectorOpen = catalogSheetInspectorInitiallyOpen(
    navigationQuery.selectedPublicRepackId,
  );
  const [selectedPublicRepackId, setSelectedPublicRepackId] = useState<
    string | null
  >(initialInspectorOpen ? page.selectedRepack?.publicRepackId ?? null : null);
  const [actionFeedback, setActionFeedback] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(initialInspectorOpen);
  const actionFeedbackRepackIdRef = useRef<string | null>(null);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const detailById = useMemo(
    () => new Map(details.map((detail) => [detail.publicRepackId, detail])),
    [details],
  );
  const repackHrefById = useMemo(() => {
    const hrefs = new Map<string, string>();
    for (const detail of details) {
      const outbound = buildPublishedRepackHref(
        detail.actions.repackLink,
        detail.availability,
      );
      if (outbound.ok) hrefs.set(detail.publicRepackId, outbound.href);
    }
    return hrefs;
  }, [details]);
  const selectedRepack = selectedPublicRepackId
    ? detailById.get(selectedPublicRepackId) ??
      (page.selectedRepack?.publicRepackId === selectedPublicRepackId
        ? page.selectedRepack
        : null)
    : null;

  useEffect(() => {
    if (page.paginationReset !== "release_changed") return;
    router.replace(navigationHref);
  }, [navigationHref, page.paginationReset, router]);

  useEffect(() => {
    queueProductTelemetry(
      createDashboardViewEvent({
        publicReleaseId: page.release.publicReleaseId,
        surface: "all_repacks",
      }),
    );
  }, [page.release.publicReleaseId]);

  useEffect(() => {
    const normalizedSearch = page.activeQuery.search;
    if (normalizedSearch.length === 0) return;
    queueProductTelemetry(
      createRepackSearchEvent({
        publicReleaseId: page.release.publicReleaseId,
        queryLength: normalizedSearch.length,
        resultCount: page.range.total,
        outcome: page.range.total === 0 ? "no_matches" : "results",
      }),
    );
  }, [page.activeQuery.search, page.release.publicReleaseId, page.range.total]);

  useEffect(() => {
    const count = activeFilterCount(page.activeQuery.filters);
    if (count === 0) return;
    queueProductTelemetry(
      createFiltersAppliedEvent({
        publicReleaseId: page.release.publicReleaseId,
        surface: "all_repacks",
        outcome: page.range.total === 0 ? "no_matches" : "results",
        activeFilterCount: count,
        resultCount: page.range.total,
      }),
    );
  }, [
    page.activeQuery.filters,
    page.release.publicReleaseId,
    page.range.total,
  ]);

  function reportAction(outcome: InspectorActionOutcome) {
    queueProductTelemetry(
      outcome.name === "promo_copied"
        ? createPromoCopiedEvent({
            publicReleaseId: page.release.publicReleaseId,
            publicRepackId: outcome.publicRepackId,
            vendorKey: outcome.vendorKey,
            outcome: outcome.outcome,
          })
        : createRepackLinkOpenedEvent({
            publicReleaseId: page.release.publicReleaseId,
            publicRepackId: outcome.publicRepackId,
            vendorKey: outcome.vendorKey,
            outcome: outcome.outcome,
          }),
    );
  }

  function navigate(
    nextQuery: ListPublicRepacksInput,
    layout = initialLayout,
  ) {
    startTransition(() => router.push(serializeCatalogViewState(nextQuery, layout)));
  }

  function applyFilters(filters: PublicRepackFilters) {
    navigate(resetCatalogPagination(navigationQuery, { filters }));
  }

  function selectRepack(publicRepackId: string) {
    actionFeedbackRepackIdRef.current = null;
    setActionFeedback("");
    setSelectedPublicRepackId(publicRepackId);
    setInspectorOpen(true);
    navigate(selectCatalogRepack(navigationQuery, publicRepackId));
  }

  function closeInspector() {
    setInspectorOpen(false);
    setSelectedPublicRepackId(null);
    navigate(clearCatalogRepackSelection(navigationQuery));
  }

  function sortCatalog(sort: PublicRepackSort, direction: "asc" | "desc") {
    navigate(resetCatalogPagination(navigationQuery, { sort, direction }));
  }

  function changePageSize(pageSize: CatalogPageSize) {
    navigate(resetCatalogPagination(navigationQuery, { pageSize }));
  }

  async function copyPromo(publicRepackId: string) {
    actionFeedbackRepackIdRef.current = publicRepackId;
    setActionFeedback("");
    const detail = detailById.get(publicRepackId);
    const promo = detail?.actions.promo;
    if (!promo) {
      setActionFeedback("Promo details are not available for this repack.");
      const summary = page.rows.find(
        (row) => row.publicRepackId === publicRepackId,
      );
      if (summary) {
        queueProductTelemetry(
          createPromoCopiedEvent({
            publicReleaseId: page.release.publicReleaseId,
            publicRepackId,
            vendorKey: summary.vendorKey,
            outcome: "failed",
          }),
        );
      }
      return;
    }
    const outcome = await copyPublicPromoCode(promo.code);
    if (actionFeedbackRepackIdRef.current === publicRepackId) {
      setActionFeedback(
        outcome.ok ? "Promo code copied." : `Copy manually: ${promo.code}`,
      );
    }
    queueProductTelemetry(
      createPromoCopiedEvent({
        publicReleaseId: page.release.publicReleaseId,
        publicRepackId,
        vendorKey: detail.vendorKey,
        outcome: outcome.ok ? "clipboard" : "manual_fallback",
      }),
    );
  }

  function openRepack(publicRepackId: string) {
    actionFeedbackRepackIdRef.current = publicRepackId;
    setActionFeedback("");
    const detail = detailById.get(publicRepackId);
    const outbound = detail
      ? buildPublishedRepackHref(
          detail.actions.repackLink,
          detail.availability,
        )
      : { ok: false as const, code: "MISSING_LINK" as const };
    if (!outbound.ok) {
      setActionFeedback("The repack link is not available.");
      const summary = page.rows.find(
        (row) => row.publicRepackId === publicRepackId,
      );
      if (summary) {
        queueProductTelemetry(
          createRepackLinkOpenedEvent({
            publicReleaseId: page.release.publicReleaseId,
            publicRepackId,
            vendorKey: summary.vendorKey,
            outcome: "blocked",
          }),
        );
      }
      return;
    }
    setActionFeedback("Vendor listing opened in a new tab.");
    queueProductTelemetry(
      createRepackLinkOpenedEvent({
        publicReleaseId: page.release.publicReleaseId,
        publicRepackId,
        vendorKey: detail!.vendorKey,
        outcome: "opened",
      }),
    );
  }

  const noMatches = page.range.total === 0;
  const resultsControls = (
    <CatalogResultsControls
      desiredSearchActive={page.desiredCollectible !== null}
      direction={page.activeQuery.direction}
      layout={initialLayout}
      onLayoutChange={(layout) => navigate(navigationQuery, layout)}
      onPageSizeChange={changePageSize}
      onSort={sortCatalog}
      pageSize={page.activeQuery.pageSize as CatalogPageSize}
      pending={pending}
      searchActive={page.activeQuery.search.length > 0}
      sort={page.activeQuery.sort}
    />
  );

  return (
    <div className={styles.root}>
      <CatalogFilters
        accepted={page.activeQuery.filters}
        facets={page.facets}
        onApply={applyFilters}
        onReset={() => navigate(DEFAULT_CATALOG_QUERY)}
        pending={pending}
      />

      {page.paginationReset === "release_changed" ? (
        <p aria-live="polite" className={styles.feedback} role="status">
          Repack data changed, so pagination returned to the first page.
        </p>
      ) : null}

      {noMatches ? (
        <NoMatches
          constraints={activeConstraints(page)}
          onClearFilters={() => navigate(DEFAULT_CATALOG_QUERY)}
        />
      ) : (
        <>
          {initialLayout === "table" ? (
            <AllRepacksTable
              controls={resultsControls}
              onCopyPromo={copyPromo}
              onOpenRepack={openRepack}
              onSelect={(publicRepackId, trigger) => {
                selectionTriggerRef.current = trigger;
                selectRepack(publicRepackId);
              }}
              onSort={sortCatalog}
              page={page}
              repackHrefById={repackHrefById}
              selectedPublicRepackId={selectedPublicRepackId}
            />
          ) : (
            <AllRepacksCards
              controls={resultsControls}
              onSelect={(publicRepackId, trigger) => {
                selectionTriggerRef.current = trigger;
                selectRepack(publicRepackId);
              }}
              page={page}
              selectedPublicRepackId={selectedPublicRepackId}
            />
          )}
          <CursorPagination
            hasNext={page.nextCursor !== null}
            hasPrevious={page.hasPrevious}
            onNext={() =>
              navigate(
                nextCatalogPage(
                  navigationQuery,
                  page.nextCursor,
                  page.queryFingerprint,
                ),
              )
            }
            onPrevious={() =>
              navigate(
                previousCatalogPage(navigationQuery, page.queryFingerprint),
              )
            }
            pending={pending}
            range={page.range}
          />
        </>
      )}

      <p aria-live="polite" className={styles.feedback} role="status">
        {actionFeedback}
      </p>

      {selectedRepack && inspectorOpen ? (
        <RepackInspector
          highlightedChase={
            page.desiredCollectible
              ? page.desiredChaseMatches.find(
                  ({ publicRepackId }) =>
                    publicRepackId === selectedRepack.publicRepackId,
                )?.chase ?? null
              : undefined
          }
          release={page.release}
          onActionOutcome={reportAction}
          onClose={closeInspector}
          placement="sheet"
          repack={selectedRepack}
          returnFocusRef={selectionTriggerRef}
        />
      ) : null}
    </div>
  );
}
