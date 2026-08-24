import type { MetadataRoute } from "next";
import {
  readGateStatusForRequest,
  robotsPolicyForGateStatus,
} from "@/lib/access-gate.server";

/**
 * Crawler policy follows the beta switch (closed-beta-access/007): while the
 * beta is on — or its state cannot be read, which fails closed the same way —
 * the landing root stays crawlable and every gated surface is excluded; with
 * the switch off there is no restriction at all, matching the pre-beta site,
 * which shipped no robots file. Served dynamically so a switch flip reaches
 * crawlers within the gate-status cache TTL, not at the next deploy.
 */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsPolicyForGateStatus(await readGateStatusForRequest());
}
