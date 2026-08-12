import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const providerStateEnum = pgEnum("provider_state", [
  "draft",
  "active",
  "disabled",
  "archived",
]);

export const authModeEnum = pgEnum("provider_auth_mode", ["none", "bearer"]);

export const operatorRoleEnum = pgEnum("operator_role", ["admin", "data_operator"]);
export const operatorStateEnum = pgEnum("operator_state", ["active", "disabled"]);
export const auditOutcomeEnum = pgEnum("audit_outcome", ["success", "failure", "blocked"]);

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const operators = pgTable(
  "operators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailNormalized: text("email_normalized").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    state: operatorStateEnum("state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operators_email_normalized_unique").on(table.emailNormalized),
    check("operators_email_is_normalized", sql`${table.emailNormalized} = lower(trim(${table.emailNormalized}))`),
    check("operators_display_name_not_blank", sql`length(trim(${table.displayName})) > 0`),
  ],
);

export const operatorMemberships = pgTable(
  "operator_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    role: operatorRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("operator_memberships_organization_operator_unique").on(
      table.organizationId,
      table.operatorId,
    ),
    index("operator_memberships_operator_idx").on(table.operatorId),
  ],
);

export const operatorSessions = pgTable(
  "operator_sessions",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    csrfHash: text("csrf_hash").notNull(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("operator_sessions_token_hash_unique").on(table.tokenHash),
    index("operator_sessions_active_token_idx")
      .on(table.tokenHash)
      .where(sql`${table.revokedAt} is null`),
    index("operator_sessions_operator_idx").on(table.operatorId, table.createdAt),
    foreignKey({
      name: "operator_sessions_membership_fk",
      columns: [table.organizationId, table.operatorId],
      foreignColumns: [operatorMemberships.organizationId, operatorMemberships.operatorId],
    }).onDelete("restrict"),
    check(
      "operator_sessions_expiry_order",
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt} and ${table.createdAt} <= ${table.idleExpiresAt}`,
    ),
  ],
);

export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("auth_rate_limits_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
  ],
);

export const providerSources = pgTable(
  "provider_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    platformKey: text("platform_key").notNull(),
    displayName: text("display_name").notNull(),
    state: providerStateEnum("state").notNull().default("draft"),
    activeRevisionId: uuid("active_revision_id").references(
      (): AnyPgColumn => providerConfigRevisions.id,
      { onDelete: "restrict" },
    ),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_sources_organization_platform_unique").on(
      table.organizationId,
      table.platformKey,
    ),
    unique("provider_sources_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    check("provider_sources_platform_key_not_blank", sql`length(trim(${table.platformKey})) > 0`),
  ],
);

export const providerConfigRevisions = pgTable(
  "provider_config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    adapterKey: text("adapter_key").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    authMode: authModeEnum("auth_mode").notNull(),
    scheduleSeconds: integer("schedule_seconds").notNull().default(300),
    staleAfterSeconds: integer("stale_after_seconds").notNull().default(900),
    testedAt: timestamp("tested_at", { withTimezone: true }),
    testedByActorKey: text("tested_by_actor_key"),
    createdByActorKey: text("created_by_actor_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_config_revisions_provider_version_unique").on(
      table.providerId,
      table.version,
    ),
    unique("provider_config_revisions_id_provider_organization_unique").on(
      table.id,
      table.providerId,
      table.organizationId,
    ),
    foreignKey({
      name: "provider_config_revisions_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    check("provider_config_revisions_schedule_safe", sql`${table.scheduleSeconds} >= 60`),
    check("provider_config_revisions_stale_positive", sql`${table.staleAfterSeconds} > 0`),
  ],
);

export const providerConnectionTests = pgTable(
  "provider_connection_tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => providerConfigRevisions.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    latencyMs: integer("latency_ms"),
    responseStatus: integer("response_status"),
    recordCountsJson: jsonb("record_counts_json").$type<{
      catalog: number;
      pulls: number;
      sales: number;
    }>(),
    hasMore: boolean("has_more"),
    nextCursorPresent: boolean("next_cursor_present"),
    sanitizedCode: text("sanitized_code"),
    testedByActorKey: text("tested_by_actor_key").notNull(),
    testedAt: timestamp("tested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("provider_connection_tests_provider_tested_idx").on(table.providerId, table.testedAt),
    foreignKey({
      name: "provider_connection_tests_revision_tenant_fk",
      columns: [table.revisionId, table.providerId, table.organizationId],
      foreignColumns: [
        providerConfigRevisions.id,
        providerConfigRevisions.providerId,
        providerConfigRevisions.organizationId,
      ],
    }).onDelete("restrict"),
    check(
      "provider_connection_tests_latency_nonnegative",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check(
      "provider_connection_tests_response_status_valid",
      sql`${table.responseStatus} is null or (${table.responseStatus} >= 100 and ${table.responseStatus} <= 599)`,
    ),
  ],
);

export const providerSecretVersions = pgTable(
  "provider_secret_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => providerConfigRevisions.id, { onDelete: "restrict" }),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    authTag: bytea("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    index("provider_secret_versions_provider_created_idx").on(
      table.organizationId,
      table.providerId,
      table.createdAt,
    ),
    unique("provider_secret_versions_revision_unique").on(table.revisionId),
    foreignKey({
      name: "provider_secret_versions_revision_tenant_fk",
      columns: [table.revisionId, table.providerId, table.organizationId],
      foreignColumns: [
        providerConfigRevisions.id,
        providerConfigRevisions.providerId,
        providerConfigRevisions.organizationId,
      ],
    }).onDelete("restrict"),
    check("provider_secret_versions_key_version_positive", sql`${table.keyVersion} > 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    actorKey: text("actor_key").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    outcome: auditOutcomeEnum("outcome").notNull(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_organization_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);
