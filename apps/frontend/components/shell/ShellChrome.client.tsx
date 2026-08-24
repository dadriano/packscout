"use client";

import { Suspense } from "react";
import { CatalogSearch } from "./CatalogSearch.client";
import { DataReleaseStatus } from "./DataReleaseStatus.client";
import { PrimaryNavigation } from "./PrimaryNavigation.client";
import { useShellSurfaceMode } from "./ShellSurface.client";

function CatalogSearchFallback() {
  return (
    <form className="catalog-search" role="search">
      <div className="catalog-search__control">
        <span aria-hidden="true" className="catalog-search__icon" />
        <label className="catalog-search__label" htmlFor="global-catalog-search-fallback">
          Search repacks
        </label>
        <input
          className="catalog-search__field"
          disabled
          id="global-catalog-search-fallback"
          placeholder="Search repacks, vendors, categories…"
          type="search"
        />
      </div>
    </form>
  );
}

/**
 * The product-only stretch of the shell header: primary navigation, catalog
 * search, and the data-release status. On the gateway surfaces (the landing
 * page and the holding surface) it renders nothing, so an unadmitted visitor
 * is never offered navigation into routes that would only bounce them back
 * — while the brand, account, and theme controls around it stay for
 * everyone, keeping sign-in and sign-out reachable from every state.
 */
export function ShellProductChrome() {
  const mode = useShellSurfaceMode();
  if (mode !== "product") return null;
  return (
    <>
      <PrimaryNavigation />
      <Suspense fallback={<CatalogSearchFallback />}>
        <CatalogSearch />
      </Suspense>
      <DataReleaseStatus />
    </>
  );
}
