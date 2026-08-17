import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";

/** Legacy Heat-only catalog fixture retained until Task 012 cuts Heat over. */
export async function seedLegacyHeatCatalogForTest(
  ctx: MutationCtx,
  dataSource: "mock" | "canonical",
): Promise<Id<"dataReleases">> {
  const fixture = buildMockDataReleaseV2();
  const releaseId = await ctx.db.insert("dataReleases", {
    publicReleaseId: fixture.metadata.publicReleaseId,
    lifecycle: "complete",
    metadata: {
      ...fixture.metadata,
      dataSource,
      sourceWatermark: "1",
    },
    searchShardCount: 0,
  });
  const vendorIds = new Map<string, Id<"vendors">>();
  for (const detail of fixture.vendors) {
    const vendorId = await ctx.db.insert("vendors", {
      releaseId,
      publicVendorId: detail.publicVendorId,
      vendorKey: detail.vendorKey,
      detail,
    });
    vendorIds.set(detail.publicVendorId, vendorId);
  }
  for (const detail of fixture.repacks) {
    const vendorId = vendorIds.get(detail.publicVendorId);
    if (vendorId === undefined) throw new Error("Heat test vendor is missing.");
    await ctx.db.insert("repacks", {
      releaseId,
      publicRepackId: detail.publicRepackId,
      vendorId,
      detail,
    });
  }
  await ctx.db.insert("dataReleaseState", {
    key: "singleton",
    activeReleaseId: releaseId,
    previousReleaseId: null,
    latestObservationSequence: 1,
    dataAsOf: fixture.metadata.dataAsOf,
    lastSuccessfulObservationAt: fixture.metadata.lastSuccessfulObservationAt,
    staleAt: fixture.metadata.staleAt,
    freshness: fixture.metadata.freshness,
    delayedVendorCount: fixture.metadata.delayedVendorCount,
    updatedAt: fixture.metadata.completedAt,
  });
  return releaseId;
}
