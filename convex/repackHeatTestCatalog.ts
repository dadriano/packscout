import type { MutationCtx } from "./_generated/server";
import {
  seedCatalogManifestGraph,
  type SeedMockCatalogManifestGraphResult,
} from "./mockCatalogManifestSeed";
import { MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION } from
  "./mockDataReleaseFixture";
import {
  buildMockProviderCatalogReleasePlans,
  MOCK_PROVIDER_PLATFORM_KEYS,
} from "./mockProviderCatalogFixture";

export async function seedHeatCatalogManifestForTest(
  ctx: MutationCtx,
  input: Readonly<{
    providerRevisions?: Readonly<
      Partial<Record<(typeof MOCK_PROVIDER_PLATFORM_KEYS)[number], number>>
    >;
    observationSequence?: number;
    serverTime?: string;
  }> = {},
): Promise<SeedMockCatalogManifestGraphResult> {
  return await seedCatalogManifestGraph(ctx, {
    plans: await buildMockProviderCatalogReleasePlans({
      providerRevisions: input.providerRevisions,
    }),
    confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
    serverTime: input.serverTime ?? new Date().toISOString(),
    observationSequence: input.observationSequence,
    dataSource: "canonical",
  });
}
