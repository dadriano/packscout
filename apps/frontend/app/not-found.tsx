import Link from "next/link";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";
import { readPublicShellStatus } from "@/lib/public-catalog.server";
import { snapshotStatusFromPublicResult } from "@/lib/public-shell-status";

export default async function NotFoundPage() {
  const status = snapshotStatusFromPublicResult(await readPublicShellStatus());
  return (
    <>
      <ShellStatusReporter status={status} />
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
