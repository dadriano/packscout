import Link from "next/link";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { readPublicShellStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromPublicResult } from "@/lib/public-release-status";

export default async function LearnArticleNotFound() {
  const status = dataReleaseStatusFromPublicResult(await readPublicShellStatus());
  return (
    <>
      <DataReleaseStatusReporter status={status} />
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
