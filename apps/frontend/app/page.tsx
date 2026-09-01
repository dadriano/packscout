import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CatalogResultRecovery, EmptyCatalog } from "@/components/catalog-state";
import { ProviderBanner } from "@/components/dashboard/ProviderBanner";
import { LandingPage } from "@/components/landing/LandingPage";
import { DashboardDisclaimer } from "@/components/shell/DashboardDisclaimer";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { ShellSurfaceReporter } from "@/components/shell/ShellSurface.client";
import {
  resolveRootRoute,
  resolveVisitorAccess,
  rootRouteMetadata,
} from "@/lib/access-gate.server";
import {
  parseDashboardRouteQuery,
  type NextSearchParams,
} from "@/lib/catalog-route-state.server";
import { dashboardHrefFor } from "@/lib/provider-banner";
import {
  readDashboardBundle,
  readPublicCatalogRecordUpdateStatus,
} from "@/lib/public-repacks.server";
import { dashboardCatalogIsEmpty } from "@/lib/public-repacks-v3";
import { dataReleaseStatusFromRecordUpdateResult } from "@/lib/public-release-status";
import { DashboardOverviewClient } from "./DashboardOverviewClient.client";

/**
 * The root stays dual-purpose (closed-beta-access/007): the server resolves
 * the visitor's access before anything renders, and this route serves the
 * product to admitted visitors (and to everyone once the beta switch is
 * off), the landing surface to strangers, and hands held or unresolved
 * sessions to the holding surface. The landing branch performs no catalog
 * read of any kind; the dashboard read below runs only after the decision
 * says this visitor gets the product. Metadata follows the same decision, so
 * the indexable landing metadata is what a crawler sees while the beta is on
 * and today's defaults return exactly when it is off.
 */
export async function generateMetadata(): Promise<Metadata> {
  return rootRouteMetadata(await resolveVisitorAccess());
}

export default async function DashboardOverviewPage({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  const route = resolveRootRoute(await resolveVisitorAccess());
  if (route.kind === "redirect") redirect(route.destination);
  if (route.kind === "landing") {
    return (
      <>
        <ShellSurfaceReporter mode="gateway" />
        <LandingPage />
      </>
    );
  }

  const parsed = parseDashboardRouteQuery(await searchParams);
  const provider = parsed.provider;
  const dashboardHref = dashboardHrefFor(provider);
  const providerBanner = provider ? <ProviderBanner provider={provider} /> : null;

  if (!parsed.ok) {
    return (
      <>
        <ShellSurfaceReporter mode="product" />
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

  const [result, recordUpdateResult] = await Promise.all([
    readDashboardBundle(parsed.query),
    readPublicCatalogRecordUpdateStatus(),
  ]);
  const status = dataReleaseStatusFromRecordUpdateResult(
    recordUpdateResult,
    result.ok ? result.data.release.publicReleaseId : undefined,
  );
  if (!result.ok) {
    return (
      <>
        <ShellSurfaceReporter mode="product" />
        <DataReleaseStatusReporter status={status} />
        {providerBanner}
        <DashboardPageHeader activeView="overview" overviewHref={dashboardHref} />
        <CatalogResultRecovery
          error={result}
          recoveryActionLabel="Reset Dashboard"
          recoveryHref={dashboardHref}
        />
      </>
    );
  }

  return (
    <>
      <ShellSurfaceReporter mode="product" />
      <DataReleaseStatusReporter status={status} />
      {providerBanner}
      <DashboardPageHeader activeView="overview" overviewHref={dashboardHref} />
      {dashboardCatalogIsEmpty(result.data) ? (
        <EmptyCatalog />
      ) : (
        <DashboardOverviewClient
          bundle={result.data}
          details={result.data.details}
          key={`${dashboardHref}:${result.data.release.publicReleaseId}:${JSON.stringify(result.data.activeFilters)}`}
          provider={provider}
        />
      )}
      <DashboardDisclaimer />
    </>
  );
}
