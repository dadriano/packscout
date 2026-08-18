import type {
  PublicRepackDetail,
  PublicRepackViewDetail,
} from "@packscout/contracts";
import type { QueryCtx } from "./_generated/server";
import type { ActivePublicCatalogManifest } from
  "./publicCatalogManifestReadModel";
import { attachHeatToRepackDetails } from "./repackHeatReadModel";

export async function attachHeatToCatalogManifestDetails(
  ctx: QueryCtx,
  active: ActivePublicCatalogManifest,
  details: readonly PublicRepackDetail[],
): Promise<PublicRepackViewDetail[]> {
  return await attachHeatToRepackDetails(ctx, active, details);
}
