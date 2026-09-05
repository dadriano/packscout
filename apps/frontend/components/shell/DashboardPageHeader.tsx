"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type {
  ListPublicRepacksInput,
  PublicCollectibleDisplay,
} from "@packscout/contracts";
import { DesiredCollectibleSearch } from "@/components/catalog/DesiredCollectibleSearch.client";
import { useOptionalChaseInspect } from "@/components/catalog/ChaseCollectibleInspector.client";
import {
  resetCatalogPagination,
  serializeCatalogViewState,
  type CatalogViewLayout,
} from "@/lib/catalog-query-state.client";
import type { DashboardHref } from "@/lib/provider-banner";
import styles from "./DashboardPageHeader.module.css";

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
  const chaseInspect = useOptionalChaseInspect();

  function selectDesiredChase(publicCollectibleId: string | null) {
    if (!desiredChase) return;
    if (publicCollectibleId === null) chaseInspect?.close(false);
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
    <>
      {activeView === "overview" ? (
        <section aria-labelledby="dashboard-hero-heading" className={styles.hero}>
          <h1 className={styles.heroTitle} data-route-heading id="dashboard-hero-heading" tabIndex={-1}>
            Scout for your next rip
          </h1>
          <p className={styles.heroCopy}>
            Compare repacks, odds, and EV across the top platforms.
          </p>
        </section>
      ) : (
        <h1 className="sr-only" data-route-heading tabIndex={-1}>All Repacks</h1>
      )}
      <div
        className="page-heading-row"
        data-has-desired-chase={desiredChase ? "true" : undefined}
        data-dashboard-view={activeView}
      >
        <div className="dashboard-heading-group">
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
              onInspect={
                chaseInspect
                  ? (publicCollectibleId, trigger, identity) =>
                      chaseInspect.open({
                        publicCollectibleId,
                        identity,
                        trigger,
                      })
                  : undefined
              }
              onSelect={selectDesiredChase}
              pending={pending}
              selected={desiredChase.selected}
              variant="heading"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
