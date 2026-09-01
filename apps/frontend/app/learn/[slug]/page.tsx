import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArticleLayout } from "@/components/learn/ArticleLayout";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { ShellSurfaceReporter } from "@/components/shell/ShellSurface.client";
import {
  gatedSurfaceRobots,
  resolveGatedRoute,
  resolveVisitorAccess,
} from "@/lib/access-gate.server";
import { findLearnGuide, LEARN_GUIDES } from "@/lib/learn-content";
import { readPublicCatalogRecordUpdateStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromRecordUpdateResult } from "@/lib/public-release-status";

type LearnArticleProps = Readonly<{
  params: Promise<{ slug: string }>;
}>;

export function generateStaticParams() {
  return LEARN_GUIDES.map(({ slug }) => ({ slug }));
}

export const dynamic = "force-dynamic";
export const dynamicParams = false;

export async function generateMetadata({ params }: LearnArticleProps): Promise<Metadata> {
  const guide = findLearnGuide((await params).slug);
  const robots = gatedSurfaceRobots(await resolveVisitorAccess());
  return guide
    ? { title: guide.title, description: guide.summary, robots }
    : { robots };
}

export default async function LearnArticlePage({ params }: LearnArticleProps) {
  // The access decision comes first (closed-beta-access/007): an unadmitted
  // visitor is redirected before the guide lookup or the shell status read.
  const route = resolveGatedRoute(await resolveVisitorAccess());
  if (route.kind === "redirect") redirect(route.destination);

  const guide = findLearnGuide((await params).slug);
  if (!guide) notFound();
  const status = dataReleaseStatusFromRecordUpdateResult(
    await readPublicCatalogRecordUpdateStatus(),
  );

  return (
    <>
      <ShellSurfaceReporter mode="product" />
      <DataReleaseStatusReporter status={status} />
      <ArticleLayout guide={guide} />
    </>
  );
}
