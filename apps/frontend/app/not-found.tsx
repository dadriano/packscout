import Link from "next/link";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { readPublicShellStatus } from "@/lib/public-repacks.server";
import { dataReleaseStatusFromPublicResult } from "@/lib/public-release-status";

export default async function NotFoundPage() {
  const status = dataReleaseStatusFromPublicResult(await readPublicShellStatus());
  return (
    <>
      <DataReleaseStatusReporter status={status} />
      <section className="route-placeholder" aria-labelledby="not-found-title">
        <div className="route-placeholder__inner">
          <p className="route-kicker">404 · Off route</p>
          <h1
            className="route-title"
            data-route-heading
            id="not-found-title"
            tabIndex={-1}
          >
            Page not found
          </h1>
          <p className="route-copy">The page you requested is not part of PackScout.</p>
          <Link className="route-action" href="/">
            Return to Dashboard
          </Link>
        </div>
      </section>
    </>
  );
}
