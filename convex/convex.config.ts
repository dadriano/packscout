import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    PACKSCOUT_RUNTIME_ENVIRONMENT: v.optional(
      v.union(
        v.literal("local"),
        v.literal("development"),
        v.literal("preproduction"),
        v.literal("production"),
      ),
    ),
    PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED: v.optional(v.literal("1")),
    PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED: v.optional(v.literal("1")),
    PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: v.optional(v.string()),
  },
});
