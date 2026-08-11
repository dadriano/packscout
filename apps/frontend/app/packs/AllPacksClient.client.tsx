"use client";

import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import type {
  ListPublicPacksInput,
  ListPublicPacksPage,
  PublicCatalogFilters,
  PublicCatalogSort,
  PublicPackDetail,
} from "@packscout/contracts";
import { AllPacksTable } from "@/components/catalog/AllPacksTable.client";
import { CatalogFilters } from "@/components/catalog/CatalogFilters.client";
import { CursorPagination } from "@/components/catalog/CursorPagination";
import { PackInspector } from "@/components/catalog/PackInspector.client";
import type { InspectorActionOutcome } from "@/components/catalog/PackInspector.client";
import {
  buildPublishedPackHref,
  copyPublicPromoCode,
} from "@/components/catalog/pack-actions.client";
import { NoMatches } from "@/components/catalog-state";
import {
  DEFAULT_CATALOG_QUERY,
  nextCatalogPage,
  previousCatalogPage,
  resetCatalogPagination,
  serializeCatalogQueryState,
} from "@/lib/catalog-query-state.client";
import { useNarrowCatalogInspector } from "@/lib/catalog-viewport.client";
import {
  createCatalogSearchEvent,
  createDashboardViewEvent,
  createFiltersAppliedEvent,
  createPackLinkOpenedEvent,
  createPromoCopiedEvent,
  queueProductTelemetry,
} from "@/lib/telemetry.client";
import styles from "./AllPacksClient.module.css";

type AllPacksClientProps = Readonly<{
  page: ListPublicPacksPage;
  query: ListPublicPacksInput;
  details: readonly PublicPackDetail[];
}>;

function activeConstraints(page: ListPublicPacksPage) {
  const constraints: Array<{ label: string; value: string }> = [];
  if (page.activeQuery.search) constraints.push({ label: "Search", value: page.activeQuery.search });
  if (page.activeQuery.filters.platforms.length > 0) {
    constraints.push({ label: "Platforms", value: page.activeQuery.filters.platforms.join(", ") });
  }
  if (page.activeQuery.filters.categories.length > 0) {
    constraints.push({ label: "Categories", value: page.activeQuery.filters.categories.join(", ") });
  }
  if (page.activeQuery.filters.price.mode === "narrowed") {
    constraints.push({
      label: "Pack Price",
      value: `$${page.activeQuery.filters.price.minMinor / 100}–$${page.activeQuery.filters.price.maxMinor / 100}`,
    });
  }
  return constraints;
}

function activeFilterCount(filters: PublicCatalogFilters): 0 | 1 | 2 | 3 {
  return (Number(filters.platforms.length > 0) +
    Number(filters.categories.length > 0) +
    Number(filters.price.mode === "narrowed")) as 0 | 1 | 2 | 3;
}

export function AllPacksClient({ page, query, details }: AllPacksClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(page.activeQuery.search);
  const [selectedPublicPackId, setSelectedPublicPackId] = useState<string | null>(
    page.selectedPack?.publicPackId ?? null,
  );
  const [actionFeedback, setActionFeedback] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const narrowInspector = useNarrowCatalogInspector();
  const detailById = useMemo(
    () => new Map(details.map((detail) => [detail.publicPackId, detail])),
    [details],
  );
  const selectedPack = selectedPublicPackId
    ? detailById.get(selectedPublicPackId) ??
      (page.selectedPack?.publicPackId === selectedPublicPackId ? page.selectedPack : null)
    : null;

  useEffect(() => {
    queueProductTelemetry(
      createDashboardViewEvent({
        snapshotVersion: page.metadata.publicationId,
        surface: "all_packs",
      }),
    );
  }, [page.metadata.publicationId]);

  useEffect(() => {
    const normalizedSearch = page.activeQuery.search;
    if (normalizedSearch.length === 0) return;
    queueProductTelemetry(
      createCatalogSearchEvent({
        snapshotVersion: page.metadata.publicationId,
        queryLength: normalizedSearch.length,
        resultCount: page.range.total,
        outcome: page.range.total === 0 ? "no_matches" : "results",
      }),
    );
  }, [
    page.activeQuery.search,
    page.metadata.publicationId,
    page.range.total,
  ]);

  useEffect(() => {
    const count = activeFilterCount(page.activeQuery.filters);
    if (count === 0) return;
    queueProductTelemetry(
      createFiltersAppliedEvent({
        snapshotVersion: page.metadata.publicationId,
        surface: "all_packs",
        outcome: page.range.total === 0 ? "no_matches" : "results",
        activeFilterCount: count,
        resultCount: page.range.total,
      }),
    );
  }, [
    page.activeQuery.filters,
    page.metadata.publicationId,
    page.range.total,
  ]);

  function reportAction(outcome: InspectorActionOutcome) {
    queueProductTelemetry(
      outcome.name === "promo_copied"
        ? createPromoCopiedEvent({
            snapshotVersion: page.metadata.publicationId,
            publicPackId: outcome.publicPackId,
            platformKey: outcome.platformKey,
            outcome: outcome.outcome,
          })
        : createPackLinkOpenedEvent({
            snapshotVersion: page.metadata.publicationId,
            publicPackId: outcome.publicPackId,
            platformKey: outcome.platformKey,
            outcome: outcome.outcome,
          }),
    );
  }

  function navigate(nextQuery: ListPublicPacksInput) {
    startTransition(() => router.push(serializeCatalogQueryState(nextQuery)));
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(resetCatalogPagination(query, { search }));
  }

  function applyFilters(filters: PublicCatalogFilters) {
    navigate(resetCatalogPagination(query, { filters }));
  }

  function sortCatalog(sort: PublicCatalogSort, direction: "asc" | "desc") {
    navigate(resetCatalogPagination(query, { sort, direction }));
  }

  async function copyPromo(publicPackId: string) {
    setSelectedPublicPackId(publicPackId);
    if (narrowInspector) setSheetOpen(true);
    const detail = detailById.get(publicPackId);
    const promo = detail?.actions.promo;
    if (!promo) {
      setActionFeedback("Promo details are not available for this pack.");
      const summary = page.rows.find((row) => row.publicPackId === publicPackId);
      if (summary) {
        queueProductTelemetry(
          createPromoCopiedEvent({
            snapshotVersion: page.metadata.publicationId,
            publicPackId,
            platformKey: summary.platformKey,
            outcome: "failed",
          }),
        );
      }
      return;
    }
    const outcome = await copyPublicPromoCode(promo.code);
    setActionFeedback(outcome.ok ? "Promo code copied." : `Copy manually: ${promo.code}`);
    queueProductTelemetry(
      createPromoCopiedEvent({
        snapshotVersion: page.metadata.publicationId,
        publicPackId,
        platformKey: detail.platformKey,
        outcome: outcome.ok ? "clipboard" : "manual_fallback",
      }),
    );
  }

  function openPack(publicPackId: string) {
    setSelectedPublicPackId(publicPackId);
    if (narrowInspector) setSheetOpen(true);
    const detail = detailById.get(publicPackId);
    const outbound = detail
      ? buildPublishedPackHref(detail.actions.packLink, detail.availability)
      : { ok: false as const, code: "MISSING_LINK" as const };
    if (!outbound.ok) {
      setActionFeedback("The pack link is not available.");
      const summary = page.rows.find((row) => row.publicPackId === publicPackId);
      if (summary) {
        queueProductTelemetry(
          createPackLinkOpenedEvent({
            snapshotVersion: page.metadata.publicationId,
            publicPackId,
            platformKey: summary.platformKey,
            outcome: "blocked",
          }),
        );
      }
      return;
    }
    window.open(outbound.href, "_blank", "noopener,noreferrer");
    setActionFeedback("Provider listing opened in a new tab.");
    queueProductTelemetry(
      createPackLinkOpenedEvent({
        snapshotVersion: page.metadata.publicationId,
        publicPackId,
        platformKey: detail!.platformKey,
        outcome: "opened",
      }),
    );
  }

  const noMatches = page.range.total === 0;

  return (
    <div className={styles.root}>
      <form className={styles.search} onSubmit={submitSearch} role="search">
        <label htmlFor="all-packs-search">Search all packs</label>
        <div className={styles.searchControl}>
          <input
            autoComplete="off"
            id="all-packs-search"
            maxLength={120}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Pack, platform, or category"
            type="search"
            value={search}
          />
          <button disabled={pending} type="submit">{pending ? "Searching…" : "Search"}</button>
        </div>
        <p>
          {page.activeQuery.search
            ? "Results use relevance only. Clear search to restore metric sorting."
            : "Search is submitted explicitly; current results keep their accepted order."}
        </p>
      </form>

      <CatalogFilters
        accepted={page.activeQuery.filters}
        facets={page.facets}
        onApply={applyFilters}
        onReset={() => navigate(DEFAULT_CATALOG_QUERY)}
        pending={pending}
      />

      {noMatches ? (
        <NoMatches
          constraints={activeConstraints(page)}
          onClearFilters={() => navigate(DEFAULT_CATALOG_QUERY)}
        />
      ) : (
        <>
          <AllPacksTable
            onCopyPromo={copyPromo}
            onOpenPack={openPack}
            onSelect={(publicPackId, trigger) => {
              selectionTriggerRef.current = trigger;
              setSelectedPublicPackId(publicPackId);
              if (narrowInspector) setSheetOpen(true);
            }}
            onSort={sortCatalog}
            page={page}
            selectedPublicPackId={selectedPublicPackId}
          />
          <CursorPagination
            hasNext={page.nextCursor !== null}
            hasPrevious={page.hasPrevious}
            onNext={() => navigate(nextCatalogPage(query, page.nextCursor, page.queryFingerprint))}
            onPrevious={() => navigate(previousCatalogPage(query, page.queryFingerprint))}
            pending={pending}
            range={page.range}
          />
        </>
      )}

      <p aria-live="polite" className={styles.feedback} role="status">{actionFeedback}</p>

      {selectedPack && (!narrowInspector || sheetOpen) ? (
        <div className={styles.preview}>
          <PackInspector
            metadata={page.metadata}
            onActionOutcome={reportAction}
            onClose={() => setSheetOpen(false)}
            pack={selectedPack}
            placement={narrowInspector ? "sheet" : "preview"}
            returnFocusRef={selectionTriggerRef}
          />
        </div>
      ) : null}
    </div>
  );
}
