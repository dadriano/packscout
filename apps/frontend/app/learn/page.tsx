import type { Metadata } from "next";
import { LearnIndex } from "@/components/learn/LearnIndex";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { LEARN_GUIDES } from "@/lib/learn-content";
import { readPublicShellStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromPublicResult } from "@/lib/public-release-status";

export const metadata: Metadata = {
  title: "Learn",
  description:
    "Practical guides to collectible repacks, PackScout Estimated EV, and evidence-based red flags.",
};

export const dynamic = "force-dynamic";

export default async function LearnPage() {
  const status = dataReleaseStatusFromPublicResult(await readPublicShellStatus());
  return (
    <>
      <DataReleaseStatusReporter status={status} />
      <LearnIndex guides={LEARN_GUIDES} />
    </>
  );
}
