import type { Metadata } from "next";
import Link from "next/link";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { CatalogRouteRecovery, EmptyCatalog } from "@/components/catalog-state";
import { parseAllRepacksRouteQuery, type NextSearchParams } from "@/lib/catalog-route-state.server";
import { readPublicRepacks } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromMetadata } from "@/lib/public-release-status";
import { AllRepacksClient } from "./AllRepacksClient.client";

export const metadata: Metadata = {
  title: "All Repacks",
};

export default async function AllRepacksPage({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  const parsed = parseAllRepacksRouteQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
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

  const result = await readPublicRepacks(parsed.query);
  if (!result.ok) {
    return (
      <>
        <DataReleaseStatusReporter status={{ state: "unavailable" }} />
        <DashboardPageHeader activeView="all-repacks" />
        <CatalogRouteRecovery />
      </>
    );
  }

  const status = dataReleaseStatusFromMetadata(result.data.metadata);

  return (
    <>
      <DataReleaseStatusReporter status={status} />
      <DashboardPageHeader activeView="all-repacks" />
      {result.data.metadata.repackCount === 0 ? (
        <EmptyCatalog />
      ) : (
        <AllRepacksClient
          details={result.data.details}
          key={`${result.data.metadata.publicReleaseId}:${result.data.range.start}:${result.data.queryFingerprint}`}
          page={result.data}
          query={parsed.query}
        />
      )}
    </>
  );
}
