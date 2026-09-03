import type { ConvexHttpClient } from "convex/browser";
import {
  containsProtectedEvPublicationKeyV3,
  publicDashboardBundleV3Schema,
  publicRepackListPageV3Schema,
  publicShellStatusV3Schema,
  repackPageRangeSchema,
} from "@packscout/contracts";
import { api } from "../../convex/_generated/api.js";
import { DistributedClutchpacksPublicationError } from "./distributed-clutchpacks-publication-plan.mts";

type Client = Pick<ConvexHttpClient, "query" | "action">;
// Validate the complete consumed core; pagination/facet extras are not proof.
const listSchema = publicRepackListPageV3Schema.safeExtend({ range: repackPageRangeSchema }).strip();
const dashboardSchema = publicDashboardBundleV3Schema.strip();

function data(result: unknown): unknown {
  if (containsProtectedEvPublicationKeyV3(result) || result === null || typeof result !== "object" ||
      !("ok" in result) || result.ok !== true || !("data" in result)) {
    throw new DistributedClutchpacksPublicationError("LOCAL_CONVEX_PUBLIC_READBACK_FAILED");
  }
  return result.data;
}
const tokenArgs = (catalogReadToken?: string) => catalogReadToken === undefined ? {} : { catalogReadToken };

export async function readLocalClutchpacksV3List(client: Client, catalogReadToken?: string) {
  const result = await client.action(api.publicRepacksV3.listPublicRepacksV3,
    { pageSize: 50, filters: { availability: "all" }, ...tokenArgs(catalogReadToken) });
  return { ok: true as const, data: listSchema.parse(data(result)) };
}

/** V3 actions own their clock; the independent manifest query retains its contract. */
export async function readLocalClutchpacksPublicSurfaces(client: Client, catalogReadToken?: string) {
  const auth = tokenArgs(catalogReadToken);
  const [manifestShell, manifestList, shell, v3List, dashboard] = await Promise.all([
    client.query(api.publicRepacks.getPublicShellStatus, auth),
    client.query(api.publicRepacks.listPublicRepacks,
      { currentTime: Date.now(), pageSize: 50, filters: { availability: "all" }, ...auth }),
    client.action(api.publicRepacksV3.getPublicShellStatusV3, auth),
    readLocalClutchpacksV3List(client, catalogReadToken),
    client.action(api.publicRepacksV3.getDashboardBundleV3,
      { filters: { availability: "all" }, ...auth }),
  ]);
  return { manifestShell, manifestList, v3List,
    v3Shell: { ok: true as const, data: publicShellStatusV3Schema.parse(data(shell)) },
    dashboard: { ok: true as const, data: dashboardSchema.parse(data(dashboard)) } };
}
