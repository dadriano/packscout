import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccessHoldingNotice } from "@/components/access/AccessHoldingNotice";
import { ShellSurfaceReporter } from "@/components/shell/ShellSurface.client";
import {
  resolveAccessRoute,
  resolveVisitorAccess,
} from "@/lib/access-gate.server";
import { ACCESS_HOLDING_COPY } from "@/lib/access-holding-content";

/**
 * The holding surface's address (closed-beta-access/007 owns the route and
 * the reason hand-off; closed-beta-access/008 owns the experience).
 *
 * The page re-resolves the visitor's access on the server rather than
 * trusting anything from the URL, renders the holding notice for held and
 * unresolved sessions, and sends everyone else back to the root — which
 * renders for them instead of redirecting here, so no decision can bounce
 * between the two. It is never indexed: it is a personal status surface,
 * not a product page, in either switch position.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const route = resolveAccessRoute(await resolveVisitorAccess());
  return {
    title: route.kind === "hold"
      ? ACCESS_HOLDING_COPY[route.reason].title
      : "Access",
    robots: { index: false, follow: false },
  };
}

export default async function AccessPage() {
  const route = resolveAccessRoute(await resolveVisitorAccess());
  if (route.kind === "redirect") redirect(route.destination);
  return (
    <>
      <ShellSurfaceReporter mode="gateway" />
      <AccessHoldingNotice reason={route.reason} />
    </>
  );
}
