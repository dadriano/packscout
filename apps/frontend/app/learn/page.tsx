import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LearnIndex } from "@/components/learn/LearnIndex";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { ShellSurfaceReporter } from "@/components/shell/ShellSurface.client";
import {
  gatedSurfaceRobots,
  resolveGatedRoute,
  resolveVisitorAccess,
} from "@/lib/access-gate.server";
import { LEARN_GUIDES } from "@/lib/learn-content";
import { readPublicCatalogRecordUpdateStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromRecordUpdateResult } from "@/lib/public-release-status";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Learn",
    description:
      "Full guides to repacks, expected value, buyer red flags, and PackScout's data methodology.",
    robots: gatedSurfaceRobots(await resolveVisitorAccess()),
  };
}

export const dynamic = "force-dynamic";

export default async function LearnPage() {
  // The access decision comes first (closed-beta-access/007): the shell
  // status read runs only for visitors the beta admits.
  const route = resolveGatedRoute(await resolveVisitorAccess());
  if (route.kind === "redirect") redirect(route.destination);

  const status = dataReleaseStatusFromRecordUpdateResult(
    await readPublicCatalogRecordUpdateStatus(),
  );
  return (
    <>
      <ShellSurfaceReporter mode="product" />
      <DataReleaseStatusReporter status={status} />
      <LearnIndex guides={LEARN_GUIDES} />
    </>
  );
}
