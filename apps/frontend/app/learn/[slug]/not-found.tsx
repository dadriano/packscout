import Link from "next/link";
import { publicReadError } from "@packscout/contracts";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { resolveGatedRoute, resolveVisitorAccess } from "@/lib/access-gate.server";
import { readPublicCatalogRecordUpdateStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromRecordUpdateResult } from "@/lib/public-release-status";

export default async function LearnArticleNotFound() {
  // Not-found answers unknown paths for everyone, including signed-out
  // visitors, so it is ungated by construction. The record-status read carries
  // the server catalog credential (closed-beta-access/005), so it runs only
  // once the same gate the product pages use has admitted this visitor;
  // everyone else gets the bounded unavailable state, and no authorized
  // catalog read — and no release source or timestamp — happens for them.
  const route = resolveGatedRoute(await resolveVisitorAccess());
  const status = dataReleaseStatusFromRecordUpdateResult(
    route.kind === "render"
      ? await readPublicCatalogRecordUpdateStatus()
      : publicReadError("RELEASE_UNAVAILABLE"),
  );
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
