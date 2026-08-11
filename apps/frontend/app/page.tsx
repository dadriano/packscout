import Link from "next/link";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";
import { CatalogRouteRecovery, EmptyCatalog } from "@/components/catalog-state";
import { catalogDemoIsEnabled, demoPackDetails } from "@/lib/catalog-demo-data.server";
import { parseDashboardRouteQuery, type NextSearchParams } from "@/lib/catalog-route-state.server";
import { readDashboardBundle } from "@/lib/public-catalog.server";
import { DashboardOverviewClient } from "./DashboardOverviewClient.client";

export default async function DashboardOverviewPage({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  const parsed = parseDashboardRouteQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
        <ShellStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="overview" />
        <section className="route-placeholder" aria-labelledby="invalid-overview-title">
          <div className="route-placeholder__inner">
            <p className="route-kicker">Dashboard link</p>
            <h2 className="route-title" id="invalid-overview-title">These filters cannot be applied</h2>
            <p className="route-copy">{parsed.message}</p>
            <Link className="route-action" href="/">Reset Dashboard</Link>
          </div>
        </section>
      </>
    );
  }

  const result = await readDashboardBundle(parsed.query);
  if (!result.ok) {
    return (
      <>
        <ShellStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="overview" />
        <CatalogRouteRecovery />
      </>
    );
  }

  const status = result.data.metadata.freshness === "delayed"
    ? { state: "delayed" as const, updatedAt: result.data.metadata.lastSuccessfulObservationAt }
    : { state: "fresh" as const, updatedAt: result.data.metadata.lastSuccessfulObservationAt };
  const details = catalogDemoIsEnabled()
    ? demoPackDetails()
    : result.data.selectedPack
      ? [result.data.selectedPack]
      : [];

  return (
    <>
      <ShellStatusReporter status={status} />
      <DashboardPageHeader activeView="overview" />
      {result.data.metadata.packCount === 0 ? (
        <EmptyCatalog />
      ) : (
        <DashboardOverviewClient
          bundle={result.data}
          details={details}
          key={`${result.data.metadata.publicationId}:${JSON.stringify(result.data.activeFilters)}`}
        />
      )}
    </>
  );
}
