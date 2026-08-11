import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleLayout } from "@/components/learn/ArticleLayout";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";
import { findLearnGuide, LEARN_GUIDES } from "@/lib/learn-content";
import { readPublicShellStatus } from "@/lib/public-catalog.server";
import { snapshotStatusFromPublicResult } from "@/lib/public-shell-status";

type LearnArticleProps = Readonly<{
  params: Promise<{ slug: string }>;
}>;

export function generateStaticParams() {
  return LEARN_GUIDES.map(({ slug }) => ({ slug }));
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: LearnArticleProps): Promise<Metadata> {
  const guide = findLearnGuide((await params).slug);
  return guide ? { title: guide.title, description: guide.description } : {};
}

export default async function LearnArticlePage({ params }: LearnArticleProps) {
  const guide = findLearnGuide((await params).slug);
  if (!guide) notFound();
  const status = snapshotStatusFromPublicResult(await readPublicShellStatus());

  return (
    <>
      <ShellStatusReporter status={status} />
      <ArticleLayout guide={guide} />
    </>
  );
}
