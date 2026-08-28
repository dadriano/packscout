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
    PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS: v.optional(v.string()),
    PACKSCOUT_HEAT_PUBLICATION_KEY_IDS: v.optional(v.string()),
    PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS: v.optional(v.string()),
    PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES: v.optional(v.string()),
    // Server-to-server secret for the admin's product-user integration —
    // directory reads and beta-allowlist management share it, because they are
    // one integration. Absent by default: the HTTP surface fails closed until
    // it is configured.
    PACKSCOUT_ADMIN_DIRECTORY_TOKEN: v.optional(v.string()),
    // The closed-beta master switch. "1" closes PackScout to unadmitted
    // callers; unset keeps the product fully public. Server-side deployment
    // configuration only: no client input, header, or query can influence it.
    PACKSCOUT_CLOSED_BETA: v.optional(v.literal("1")),
    // Server-held credential authorizing PackScout's own server rendering
    // path to read the catalog while the closed beta is on. Mirrored by the
    // frontend server environment variable of the same name; never browser
    // visible. Absent by default: while the beta is on, catalog reads fail
    // closed to admitted identities only until it is configured.
    PACKSCOUT_CATALOG_READ_TOKEN: v.optional(v.string()),
    PRIVY_APP_ID: v.optional(v.string()),
  },
});
