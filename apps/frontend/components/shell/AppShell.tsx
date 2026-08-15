import { Suspense } from "react";
import { AccountControl } from "@/components/auth/AccountControl.client";
import { BrandLogo } from "./BrandLogo";
import { CatalogSearch } from "./CatalogSearch.client";
import { PrimaryNavigation } from "./PrimaryNavigation.client";
import { RouteFocusManager } from "./RouteFocusManager.client";
import {
  DataReleaseStatus,
  DataReleaseStatusProvider,
} from "./DataReleaseStatus.client";
import { ThemeControl } from "./ThemeControl.client";

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

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DataReleaseStatusProvider>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="app-header">
          <div className="app-header__inner">
            <BrandLogo />
            <PrimaryNavigation />
            <Suspense fallback={<CatalogSearchFallback />}>
              <CatalogSearch />
            </Suspense>
            <DataReleaseStatus />
            <AccountControl />
            <ThemeControl />
          </div>
        </header>
        <RouteFocusManager />
        <main className="app-content" id="main-content">
          {children}
        </main>
      </div>
    </DataReleaseStatusProvider>
  );
}
