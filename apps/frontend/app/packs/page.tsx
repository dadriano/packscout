import type { Metadata } from "next";
import Link from "next/link";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";
import { CatalogRouteRecovery, EmptyCatalog } from "@/components/catalog-state";
import { parseAllPacksRouteQuery, type NextSearchParams } from "@/lib/catalog-route-state.server";
import { readPublicPacks } from "@/lib/public-catalog.server";
import { snapshotStatusFromMetadata } from "@/lib/public-shell-status";
import { AllPacksClient } from "./AllPacksClient.client";

export const metadata: Metadata = {
  title: "All Packs",
};

export default async function AllPacksPage({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  const parsed = parseAllPacksRouteQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
        <ShellStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="all-packs" />
        <section className="route-placeholder" aria-labelledby="invalid-catalog-title">
          <div className="route-placeholder__inner">
            <p className="route-kicker">Catalog link</p>
            <h2 className="route-title" id="invalid-catalog-title">This catalog link cannot be applied</h2>
            <p className="route-copy">{parsed.message}</p>
            <Link className="route-action" href="/packs">Reset catalog</Link>
          </div>
        </section>
      </>
    );
  }

  const result = await readPublicPacks(parsed.query);
  if (!result.ok) {
    return (
      <>
        <ShellStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="all-packs" />
        <CatalogRouteRecovery />
      </>
    );
  }

  const status = snapshotStatusFromMetadata(result.data.metadata);

  return (
    <>
      <ShellStatusReporter status={status} />
      <DashboardPageHeader activeView="all-packs" />
      {result.data.metadata.packCount === 0 ? (
        <EmptyCatalog />
      ) : (
        <AllPacksClient
          details={result.data.details}
          key={`${result.data.metadata.publicationId}:${result.data.range.start}:${result.data.queryFingerprint}`}
          page={result.data}
          query={parsed.query}
        />
      )}
    </>
  );
}
