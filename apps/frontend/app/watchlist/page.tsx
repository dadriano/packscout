import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WatchlistPage } from "@/components/watchlist/WatchlistPage.client";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { ShellSurfaceReporter } from "@/components/shell/ShellSurface.client";
import {
  PERSONAL_SURFACE_ROBOTS,
  resolveVisitorAccess,
  resolveWatchlistRoute,
  shellSurfaceForDecision,
} from "@/lib/access-gate.server";
import type { NextSearchParams } from "@/lib/catalog-route-state.server";
import { readPublicCatalogRecordUpdateStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromRecordUpdateResult } from "@/lib/public-release-status";
import { parseWatchlistTab } from "@/lib/watchlist";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Watchlist",
    robots: PERSONAL_SURFACE_ROBOTS,
  };
}

export const dynamic = "force-dynamic";

export default async function WatchlistRoute({
  searchParams,
}: Readonly<{ searchParams: Promise<NextSearchParams> }>) {
  const access = await resolveVisitorAccess();
  const route = resolveWatchlistRoute(access);
  if (route.kind === "redirect") redirect(route.destination);

  const surface = shellSurfaceForDecision(access);
  const status =
    surface === "product"
      ? dataReleaseStatusFromRecordUpdateResult(
          await readPublicCatalogRecordUpdateStatus(),
        )
      : null;

  return (
    <>
      <ShellSurfaceReporter mode={surface} />
      {status ? <DataReleaseStatusReporter status={status} /> : null}
      <WatchlistPage tab={parseWatchlistTab((await searchParams).tab)} />
    </>
  );
}
