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
    PACKSCOUT_MOCK_CATALOG_SEED_ENABLED: v.optional(v.literal("1")),
  },
});
