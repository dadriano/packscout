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
    PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS: v.optional(v.string()),
    PACKSCOUT_HEAT_PUBLICATION_KEY_IDS: v.optional(v.string()),
    PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS: v.optional(v.string()),
    PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES: v.optional(v.string()),
    // Server-to-server secret for the admin product-user directory integration.
    // Absent by default: the HTTP surface fails closed until it is configured.
    PACKSCOUT_ADMIN_DIRECTORY_TOKEN: v.optional(v.string()),
    // The closed-beta master switch. "1" closes PackScout to unadmitted
    // callers; unset keeps the product fully public. Server-side deployment
    // configuration only: no client input, header, or query can influence it.
    PACKSCOUT_CLOSED_BETA: v.optional(v.literal("1")),
    PRIVY_APP_ID: v.optional(v.string()),
  },
});
