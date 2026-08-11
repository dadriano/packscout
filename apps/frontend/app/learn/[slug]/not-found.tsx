import Link from "next/link";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";
import { readPublicShellStatus } from "@/lib/public-catalog.server";
import { snapshotStatusFromPublicResult } from "@/lib/public-shell-status";

export default async function LearnArticleNotFound() {
  const status = snapshotStatusFromPublicResult(await readPublicShellStatus());
  return (
    <>
      <ShellStatusReporter status={status} />
      <section className="route-placeholder" aria-labelledby="article-not-found-title">
        <div className="route-placeholder__inner">
          <p className="route-kicker">404 · Learn</p>
          <h1
            className="route-title"
            data-route-heading
            id="article-not-found-title"
            tabIndex={-1}
          >
            Page not found
          </h1>
          <p className="route-copy">This PackScout guide does not exist.</p>
          <Link className="route-action" href="/learn">
            Back to Learn
          </Link>
        </div>
      </section>
    </>
  );
}
