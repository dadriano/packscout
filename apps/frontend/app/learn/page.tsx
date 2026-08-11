import type { Metadata } from "next";
import { LearnIndex } from "@/components/learn/LearnIndex";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";
import { LEARN_GUIDES } from "@/lib/learn-content";
import { readPublicShellStatus } from "@/lib/public-catalog.server";
import { snapshotStatusFromPublicResult } from "@/lib/public-shell-status";

export const metadata: Metadata = {
  title: "Learn",
  description:
    "Practical guides to collectible repacks, PackScout Estimated EV, and evidence-based red flags.",
};

export const dynamic = "force-dynamic";

export default async function LearnPage() {
  const status = snapshotStatusFromPublicResult(await readPublicShellStatus());
  return (
    <>
      <ShellStatusReporter status={status} />
      <LearnIndex guides={LEARN_GUIDES} />
    </>
  );
}
