import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  organizations,
  providerConfigRevisions,
  providerSources,
} from "./core.ts";
import { importRuns } from "./ingestion.ts";

export const providerSchedules = pgTable(
  "provider_schedules",
  {
    providerId: uuid("provider_id")
      .primaryKey()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    configRevisionId: uuid("config_revision_id")
      .notNull()
      .references(() => providerConfigRevisions.id, { onDelete: "restrict" }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    lastOutcome: text("last_outcome"),
    lastRunId: uuid("last_run_id").references(() => importRuns.id, {
      onDelete: "restrict",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("provider_schedules_provider_tenant_revision_unique").on(
      table.providerId,
      table.organizationId,
      table.configRevisionId,
    ),
    index("provider_schedules_due_idx").on(
      table.organizationId,
      table.nextDueAt,
    ),
    foreignKey({
      name: "provider_schedules_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "provider_schedules_revision_tenant_fk",
      columns: [
        table.configRevisionId,
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
      name: "provider_schedules_last_run_tenant_fk",
      columns: [table.lastRunId, table.organizationId, table.providerId],
      foreignColumns: [
        importRuns.id,
        importRuns.organizationId,
        importRuns.providerId,
      ],
    }).onDelete("restrict"),
    check(
      "provider_schedules_claim_pair",
      sql`(${table.claimOwner} is null) = (${table.claimExpiresAt} is null)`,
    ),
    check(
      "provider_schedules_claim_owner_bounded",
      sql`${table.claimOwner} is null or length(${table.claimOwner}) between 1 and 256`,
    ),
    check(
      "provider_schedules_outcome_known",
      sql`${table.lastOutcome} is null or ${table.lastOutcome} in ('started', 'coalesced', 'not_enabled')`,
    ),
  ],
);

export const providerHealthStates = pgTable(
  "provider_health_states",
  {
    providerId: uuid("provider_id")
      .primaryKey()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    lastHeadReachedAt: timestamp("last_head_reached_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    latestFailureCode: text("latest_failure_code"),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    latestMappingWarningAt: timestamp("latest_mapping_warning_at", {
      withTimezone: true,
    }),
    mappingWarningSeverity: text("mapping_warning_severity"),
    mappingWarningActive: boolean("mapping_warning_active").notNull().default(false),
    latestCalculationWarningAt: timestamp("latest_calculation_warning_at", {
      withTimezone: true,
    }),
    calculationWarningSeverity: text("calculation_warning_severity"),
    calculationWarningActive: boolean("calculation_warning_active")
      .notNull()
      .default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("provider_health_states_provider_tenant_unique").on(
      table.providerId,
      table.organizationId,
    ),
    foreignKey({
      name: "provider_health_states_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    check(
      "provider_health_states_failure_count_nonnegative",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "provider_health_states_failure_code_bounded",
      sql`${table.latestFailureCode} is null or length(${table.latestFailureCode}) between 1 and 128`,
    ),
    check(
      "provider_health_states_mapping_severity_known",
      sql`${table.mappingWarningSeverity} is null or ${table.mappingWarningSeverity} in ('warning', 'degraded')`,
    ),
    check(
      "provider_health_states_mapping_active_complete",
      sql`not ${table.mappingWarningActive} or (${table.latestMappingWarningAt} is not null and ${table.mappingWarningSeverity} is not null)`,
    ),
    check(
      "provider_health_states_calculation_severity_known",
      sql`${table.calculationWarningSeverity} is null or ${table.calculationWarningSeverity} in ('warning', 'degraded')`,
    ),
    check(
      "provider_health_states_calculation_active_complete",
      sql`not ${table.calculationWarningActive} or (${table.latestCalculationWarningAt} is not null and ${table.calculationWarningSeverity} is not null)`,
    ),
  ],
);
