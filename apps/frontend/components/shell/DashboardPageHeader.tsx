"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type {
  ListPublicRepacksInput,
  PublicCollectibleDisplay,
} from "@packscout/contracts";
import { DesiredCollectibleSearch } from "@/components/catalog/DesiredCollectibleSearch.client";
import {
  resetCatalogPagination,
  serializeCatalogViewState,
  type CatalogViewLayout,
} from "@/lib/catalog-query-state.client";
import type { DashboardHref } from "@/lib/provider-banner";

type DesiredChaseControl = Readonly<{
  query: ListPublicRepacksInput;
  selected: PublicCollectibleDisplay | null;
  layout: CatalogViewLayout;
}>;

type DashboardPageHeaderProps = Readonly<{
  activeView: "overview" | "all-repacks";
  overviewHref?: DashboardHref;
  desiredChase?: DesiredChaseControl;
}>;

export function DashboardPageHeader({
  activeView,
  overviewHref = "/",
  desiredChase,
}: DashboardPageHeaderProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function selectDesiredChase(publicCollectibleId: string | null) {
    if (!desiredChase) return;
    const nextQuery = resetCatalogPagination(desiredChase.query, {
      desiredPublicCollectibleId: publicCollectibleId,
      ...(publicCollectibleId !== null && desiredChase.query.sort === "top_chase_value"
        ? { sort: "packscout_ev_dollars", direction: "desc" }
        : {}),
    });
    startTransition(() =>
      router.push(serializeCatalogViewState(nextQuery, desiredChase.layout)),
    );
  }

  return (
    <div
      className="page-heading-row"
      data-has-desired-chase={desiredChase ? "true" : undefined}
    >
      <div className="dashboard-heading-group">
        <h1 className="page-heading" data-route-heading tabIndex={-1}>
          Dashboard
        </h1>
        <nav aria-label="Dashboard views" className="dashboard-tabs" role="tablist">
          <Link
            aria-current={activeView === "overview" ? "page" : undefined}
            aria-selected={activeView === "overview"}
            className="dashboard-tabs__tab"
            href={overviewHref}
            role="tab"
          >
            Overview
          </Link>
          <Link
            aria-current={activeView === "all-repacks" ? "page" : undefined}
            aria-selected={activeView === "all-repacks"}
            className="dashboard-tabs__tab"
            href="/packs"
            role="tab"
          >
            All Repacks
          </Link>
        </nav>
      </div>
      {desiredChase ? (
        <div className="dashboard-desired-chase">
          <DesiredCollectibleSearch
            onSelect={selectDesiredChase}
            pending={pending}
            selected={desiredChase.selected}
            variant="heading"
          />
        </div>
      ) : null}
    </div>
  );
}
