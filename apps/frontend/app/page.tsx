import Link from "next/link";
import { CatalogRouteRecovery, EmptyCatalog } from "@/components/catalog-state";
import { ProviderBanner } from "@/components/dashboard/ProviderBanner";
import { DashboardDisclaimer } from "@/components/shell/DashboardDisclaimer";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import {
  parseDashboardRouteQuery,
  type NextSearchParams,
} from "@/lib/catalog-route-state.server";
import { dashboardHrefFor } from "@/lib/provider-banner";
import { readDashboardBundle } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromMetadata } from "@/lib/public-release-status";
import { DashboardOverviewClient } from "./DashboardOverviewClient.client";

export default async function DashboardOverviewPage({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  const parsed = parseDashboardRouteQuery(await searchParams);
  const provider = parsed.provider;
  const dashboardHref = dashboardHrefFor(provider);
  const providerBanner = provider ? <ProviderBanner provider={provider} /> : null;

  if (!parsed.ok) {
    return (
      <>
        <DataReleaseStatusReporter status={{ state: "unavailable" }} />
        {providerBanner}
        <DashboardPageHeader activeView="overview" overviewHref={dashboardHref} />
        <section className="route-placeholder" aria-labelledby="invalid-overview-title">
          <div className="route-placeholder__inner">
            <p className="route-kicker">Dashboard link</p>
            <h2 className="route-title" id="invalid-overview-title">
              These filters cannot be applied
            </h2>
            <p className="route-copy">{parsed.message}</p>
            <Link className="route-action" href={dashboardHref}>
              Reset Dashboard
            </Link>
          </div>
        </section>
      </>
    );
  }

  const result = await readDashboardBundle(parsed.query);
  if (!result.ok) {
    return (
      <>
        <DataReleaseStatusReporter status={{ state: "unavailable" }} />
        {providerBanner}
        <DashboardPageHeader activeView="overview" overviewHref={dashboardHref} />
        <CatalogRouteRecovery />
      </>
    );
  }

  const status = dataReleaseStatusFromMetadata(result.data.metadata);

  return (
    <>
      <DataReleaseStatusReporter status={status} />
      {providerBanner}
      <DashboardPageHeader activeView="overview" overviewHref={dashboardHref} />
      {result.data.metadata.repackCount === 0 ? (
        <EmptyCatalog />
      ) : (
        <DashboardOverviewClient
          bundle={result.data}
          details={result.data.details}
          key={`${dashboardHref}:${result.data.metadata.publicReleaseId}:${JSON.stringify(result.data.activeFilters)}`}
          provider={provider}
        />
      )}
      <DashboardDisclaimer />
    </>
  );
}
