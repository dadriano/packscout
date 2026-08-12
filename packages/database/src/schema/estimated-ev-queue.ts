import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { canonicalRevisions } from "./canonical.ts";
import {
  organizations,
  providerConfigRevisions,
  providerSources,
} from "./core.ts";

export const estimatedEvRecomputationStateEnum = pgEnum(
  "estimated_ev_recomputation_state",
  ["queued", "running", "completed", "failed"],
);

export const estimatedEvRecomputationResultEnum = pgEnum(
  "estimated_ev_recomputation_result",
  ["estimated", "unavailable"],
);

export const estimatedEvRecomputationRequests = pgTable(
  "estimated_ev_recomputation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestKey: text("request_key").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    configurationRevisionId: uuid("configuration_revision_id")
      .notNull()
      .references(() => providerConfigRevisions.id, { onDelete: "restrict" }),
    platformKey: text("platform_key").notNull(),
    packExternalId: text("pack_external_id").notNull(),
    evInputExternalId: text("ev_input_external_id").notNull(),
    packRevisionId: uuid("pack_revision_id").references(
      () => canonicalRevisions.id,
      { onDelete: "restrict" },
    ),
    evInputRevisionId: uuid("ev_input_revision_id").references(
      () => canonicalRevisions.id,
      { onDelete: "restrict" },
    ),
    state: estimatedEvRecomputationStateEnum("state")
      .notNull()
      .default("queued"),
    resultStatus: estimatedEvRecomputationResultEnum("result_status"),
    calculationRevisionId: uuid("calculation_revision_id").references(
      () => canonicalRevisions.id,
      { onDelete: "restrict" },
    ),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("estimated_ev_recomputation_request_key_unique").on(
      table.requestKey,
    ),
    index("estimated_ev_recomputation_claim_idx").on(
      table.state,
      table.availableAt,
      table.createdAt,
      table.id,
    ),
    index("estimated_ev_recomputation_tenant_pack_idx").on(
      table.organizationId,
      table.platformKey,
      table.packExternalId,
      table.createdAt,
    ),
    foreignKey({
      name: "estimated_ev_recomputation_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "estimated_ev_recomputation_config_tenant_fk",
      columns: [
        table.configurationRevisionId,
        table.providerId,
        table.organizationId,
      ],
      foreignColumns: [
        providerConfigRevisions.id,
        providerConfigRevisions.providerId,
        providerConfigRevisions.organizationId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "estimated_ev_recomputation_pack_revision_tenant_fk",
      columns: [table.packRevisionId, table.organizationId],
      foreignColumns: [canonicalRevisions.id, canonicalRevisions.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "estimated_ev_recomputation_input_revision_tenant_fk",
      columns: [table.evInputRevisionId, table.organizationId],
      foreignColumns: [canonicalRevisions.id, canonicalRevisions.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "estimated_ev_recomputation_calculation_revision_tenant_fk",
      columns: [table.calculationRevisionId, table.organizationId],
      foreignColumns: [canonicalRevisions.id, canonicalRevisions.organizationId],
    }).onDelete("restrict"),
    check(
      "estimated_ev_recomputation_request_key_sha256",
      sql`length(${table.requestKey}) = 64`,
    ),
    check(
      "estimated_ev_recomputation_identity_not_blank",
      sql`length(trim(${table.platformKey})) > 0 and length(trim(${table.packExternalId})) > 0 and length(trim(${table.evInputExternalId})) > 0`,
    ),
    check(
      "estimated_ev_recomputation_attempt_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "estimated_ev_recomputation_claim_consistent",
      sql`(${table.state} = 'running' and ${table.claimedBy} is not null and ${table.claimToken} is not null and ${table.claimExpiresAt} is not null) or (${table.state} <> 'running' and ${table.claimedBy} is null and ${table.claimToken} is null and ${table.claimExpiresAt} is null)`,
    ),
    check(
      "estimated_ev_recomputation_completion_consistent",
      sql`(${table.state} = 'completed' and ${table.resultStatus} is not null and ${table.calculationRevisionId} is not null and ${table.completedAt} is not null) or (${table.state} <> 'completed' and ${table.resultStatus} is null and ${table.calculationRevisionId} is null and ${table.completedAt} is null)`,
    ),
    check(
      "estimated_ev_recomputation_failure_bounded",
      sql`${table.failureCode} is null or length(${table.failureCode}) <= 128`,
    ),
    check(
      "estimated_ev_recomputation_claimed_by_bounded",
      sql`${table.claimedBy} is null or length(${table.claimedBy}) <= 256`,
    ),
  ],
);
