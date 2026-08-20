import { ConvexError, v } from "convex/values";
import { env, internalMutation } from "./_generated/server";
import { seedMockCatalogManifestGraph } from "./mockCatalogManifestSeed";
import { MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION } from "./mockDataReleaseFixture";
import { buildMockProviderCatalogReleasePlans } from "./mockProviderCatalogFixture";

function refuse(
  code: "MOCK_SEED_DISABLED" | "MOCK_SEED_ENVIRONMENT_UNSAFE",
): never {
  throw new ConvexError({
    code,
    message: "The mock catalog manifest seed was refused without changing data.",
  });
}

function assertSeedEnvironment(): void {
  const configuredEnv = env as typeof env & {
    readonly PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED?: "1";
  };
  if (configuredEnv.PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED !== "1") {
    refuse("MOCK_SEED_DISABLED");
  }
  if (
    env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "local" &&
    env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "development" &&
    env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "preproduction"
  ) {
    refuse("MOCK_SEED_ENVIRONMENT_UNSAFE");
  }
}

export const seed = internalMutation({
  args: {},
  returns: v.object({
    status: v.union(v.literal("created"), v.literal("unchanged")),
    publicReleaseId: v.string(),
    repackCount: v.literal(6),
  }),
  handler: async (ctx) => {
    assertSeedEnvironment();
    const serverTime = new Date().toISOString();
    const result = await seedMockCatalogManifestGraph(ctx, {
      plans: await buildMockProviderCatalogReleasePlans(),
      confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
      serverTime,
    });
    return {
      status: result.status,
      publicReleaseId: result.publicReleaseId,
      repackCount: 6 as const,
    };
  },
});
