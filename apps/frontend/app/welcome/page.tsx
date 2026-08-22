import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";
import { LANDING_METADATA } from "@/lib/landing-content";

/**
 * The landing surface's own address (closed-beta-access/006).
 *
 * This route exists so the landing page is addressable and renderable on its
 * own — reviewable, smoke-testable, and reachable without touching the root.
 * The root route keeps its existing dashboard behavior untouched here;
 * closed-beta-access/007 owns wiring `/` to render `LandingPage` for
 * visitors who are not admitted.
 *
 * The route performs no reads. The reporter below hands the shell a static
 * "unavailable" status — this page carries no catalog data, so the shell's
 * freshness indicator must not sit in its checking state forever — exactly
 * the pattern the dashboard's no-data branches use.
 */
export const metadata: Metadata = LANDING_METADATA;

export default function WelcomePage() {
  return (
    <>
      <DataReleaseStatusReporter status={{ state: "unavailable" }} />
      <LandingPage />
    </>
  );
}
