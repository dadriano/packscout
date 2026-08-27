import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardDisclaimer } from "@/components/shell/DashboardDisclaimer";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { ShellSurfaceReporter } from "@/components/shell/ShellSurface.client";
import {
  gatedSurfaceRobots,
  resolveGatedRoute,
  resolveVisitorAccess,
} from "@/lib/access-gate.server";
import { CatalogResultRecovery, EmptyCatalog } from "@/components/catalog-state";
import { parseAllRepacksRouteQuery, type NextSearchParams } from "@/lib/catalog-route-state.server";
import {
  catalogQueryAfterReadError,
  parseCatalogViewLayout,
  serializeCatalogViewState,
} from "@/lib/catalog-query-state.client";
import { toUrlSearchParams } from "@/lib/catalog-route-state.server";
import { readPublicRepacks } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromMetadata } from "@/lib/public-release-status";
import { AllRepacksClient } from "./AllRepacksClient.client";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "All Repacks",
    robots: gatedSurfaceRobots(await resolveVisitorAccess()),
  };
}

export default async function AllRepacksPage({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  // The access decision comes first (closed-beta-access/007): no parsing and
  // no catalog read happens for a visitor the beta does not admit.
  const route = resolveGatedRoute(await resolveVisitorAccess());
  if (route.kind === "redirect") redirect(route.destination);

  const resolvedSearchParams = await searchParams;
  const parsed = parseAllRepacksRouteQuery(resolvedSearchParams);
  if (!parsed.ok) {
    return (
      <>
        <ShellSurfaceReporter mode="product" />
        <DataReleaseStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="all-repacks" />
        <section className="route-placeholder" aria-labelledby="invalid-catalog-title">
          <div className="route-placeholder__inner">
            <p className="route-kicker">Catalog link</p>
            <h2 className="route-title" id="invalid-catalog-title">This repack catalog link cannot be applied</h2>
            <p className="route-copy">{parsed.message}</p>
            <Link className="route-action" href="/packs">Reset repack catalog</Link>
          </div>
        </section>
      </>
    );
  }

  const layout = parseCatalogViewLayout(
    toUrlSearchParams(resolvedSearchParams).get("view"),
  );
  if (layout === null) {
    throw new Error("A validated catalog view must resolve to a layout.");
  }

  const result = await readPublicRepacks(parsed.query);
  if (!result.ok) {
    const recoveryHref = serializeCatalogViewState(
      catalogQueryAfterReadError(parsed.query, result.code),
      layout,
    );
    return (
      <>
        <ShellSurfaceReporter mode="product" />
        <DataReleaseStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="all-repacks" />
        <CatalogResultRecovery error={result} recoveryHref={recoveryHref} />
      </>
    );
  }

  const status = dataReleaseStatusFromMetadata(result.data.metadata);

  return (
    <>
      <ShellSurfaceReporter mode="product" />
      <DataReleaseStatusReporter status={status} />
      <DashboardPageHeader
        activeView="all-repacks"
        desiredChase={{
          query: parsed.query,
          selected: result.data.desiredCollectible,
          layout,
        }}
      />
      {result.data.metadata.repackCount === 0 ? (
        <EmptyCatalog />
      ) : (
        <AllRepacksClient
          details={result.data.details}
          key={`${result.data.metadata.publicReleaseId}:${result.data.range.start}:${result.data.queryFingerprint}`}
          initialLayout={layout}
          page={result.data}
          query={parsed.query}
        />
      )}
      <DashboardDisclaimer />
    </>
  );
}
