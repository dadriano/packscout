import type {
  OperationalEventKind,
  OperationalNotification,
  OperationalSeverity,
} from "@packscout/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, providerSources } from "./core.ts";
import { importRuns, quarantineRecords } from "./ingestion.ts";

const operationalEventKinds = [
  "run_failed",
  "run_incomplete",
  "provider_stale",
  "provider_recovered",
  "quarantine_resolved",
  "quarantine_expired",
  "retention_failed",
  "retention_recovered",
] as const satisfies readonly [OperationalEventKind, ...OperationalEventKind[]];

export const operationalEventKindEnum = pgEnum(
  "operational_event_kind",
  operationalEventKinds,
);

const operationalSeverities = [
  "info",
  "warning",
  "critical",
] as const satisfies readonly [OperationalSeverity, ...OperationalSeverity[]];

export const operationalSeverityEnum = pgEnum(
  "operational_severity",
  operationalSeverities,
);

export const adminAlertStateEnum = pgEnum("admin_alert_state", [
  "active",
  "acknowledged",
  "resolved",
]);

export const retentionExecutionStateEnum = pgEnum("retention_execution_state", [
  "running",
  "succeeded",
  "failed",
]);

export const operationalEvents = pgTable(
  "operational_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: operationalEventKindEnum("kind").notNull(),
    severity: operationalSeverityEnum("severity").notNull(),
    providerId: uuid("provider_id").references(() => providerSources.id, {
      onDelete: "restrict",
    }),
    runId: uuid("run_id").references(() => importRuns.id, {
      onDelete: "restrict",
    }),
    quarantineId: uuid("quarantine_id").references(() => quarantineRecords.id, {
      onDelete: "restrict",
    }),
    dedupeKey: text("dedupe_key").notNull(),
    recoveryKey: text("recovery_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    evidenceJson: jsonb("evidence_json")
      .$type<OperationalNotification["evidence"]>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("operational_events_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    index("operational_events_organization_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    index("operational_events_organization_dedupe_idx").on(
      table.organizationId,
      table.dedupeKey,
      table.occurredAt,
    ),
    foreignKey({
      name: "operational_events_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "operational_events_run_tenant_fk",
      columns: [table.runId, table.organizationId, table.providerId],
      foreignColumns: [
        importRuns.id,
        importRuns.organizationId,
        importRuns.providerId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "operational_events_quarantine_tenant_fk",
      columns: [table.quarantineId, table.organizationId],
      foreignColumns: [quarantineRecords.id, quarantineRecords.organizationId],
    }).onDelete("restrict"),
    check(
      "operational_events_copy_bounded",
      sql`length(${table.dedupeKey}) between 1 and 256 and length(${table.recoveryKey}) between 1 and 256 and length(${table.title}) between 1 and 160 and length(${table.summary}) between 1 and 500`,
    ),
    check(
      "operational_events_run_provider_required",
      sql`${table.runId} is null or ${table.providerId} is not null`,
    ),
  ],
);

export const adminAlerts = pgTable(
  "admin_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    latestEventId: uuid("latest_event_id")
      .notNull()
      .references(() => operationalEvents.id, { onDelete: "restrict" }),
    kind: operationalEventKindEnum("kind").notNull(),
    severity: operationalSeverityEnum("severity").notNull(),
    state: adminAlertStateEnum("state").notNull().default("active"),
    dedupeKey: text("dedupe_key").notNull(),
    recoveryKey: text("recovery_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    providerId: uuid("provider_id").references(() => providerSources.id, {
      onDelete: "restrict",
    }),
    runId: uuid("run_id").references(() => importRuns.id, {
      onDelete: "restrict",
    }),
    quarantineId: uuid("quarantine_id").references(() => quarantineRecords.id, {
      onDelete: "restrict",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    reopenedCount: integer("reopened_count").notNull().default(0),
    acknowledgedByActorKey: text("acknowledged_by_actor_key"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedByActorKey: text("resolved_by_actor_key"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("admin_alerts_organization_dedupe_unique").on(
      table.organizationId,
      table.dedupeKey,
    ),
    index("admin_alerts_organization_state_seen_idx").on(
      table.organizationId,
      table.state,
      table.lastSeenAt,
    ),
    foreignKey({
      name: "admin_alerts_latest_event_tenant_fk",
      columns: [table.latestEventId, table.organizationId],
      foreignColumns: [operationalEvents.id, operationalEvents.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "admin_alerts_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "admin_alerts_run_tenant_fk",
      columns: [table.runId, table.organizationId, table.providerId],
      foreignColumns: [
        importRuns.id,
        importRuns.organizationId,
        importRuns.providerId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "admin_alerts_quarantine_tenant_fk",
      columns: [table.quarantineId, table.organizationId],
      foreignColumns: [quarantineRecords.id, quarantineRecords.organizationId],
    }).onDelete("restrict"),
    check(
      "admin_alerts_counts_positive",
      sql`${table.occurrenceCount} > 0 and ${table.reopenedCount} >= 0`,
    ),
    check(
      "admin_alerts_copy_bounded",
      sql`length(${table.dedupeKey}) between 1 and 256 and length(${table.recoveryKey}) between 1 and 256 and length(${table.title}) between 1 and 160 and length(${table.summary}) between 1 and 500`,
    ),
    check(
      "admin_alerts_acknowledgement_pair",
      sql`(${table.acknowledgedByActorKey} is null) = (${table.acknowledgedAt} is null)`,
    ),
    check(
      "admin_alerts_resolution_pair",
      sql`(${table.resolvedByActorKey} is null) = (${table.resolvedAt} is null)`,
    ),
    check(
      "admin_alerts_run_provider_required",
      sql`${table.runId} is null or ${table.providerId} is not null`,
    ),
  ],
);

export const retentionExecutions = pgTable(
  "retention_executions",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    state: retentionExecutionStateEnum("state").notNull().default("running"),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    batchSize: integer("batch_size").notNull(),
    selectedCount: integer("selected_count").notNull().default(0),
    expiredCount: integer("expired_count").notNull().default(0),
    alreadyExpiredCount: integer("already_expired_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    remainingCount: integer("remaining_count").notNull().default(0),
    pagesExpiredCount: integer("pages_expired_count").notNull().default(0),
    sourceRecordsExpiredCount: integer("source_records_expired_count")
      .notNull()
      .default(0),
    quarantinesExpiredCount: integer("quarantines_expired_count")
      .notNull()
      .default(0),
    failureCode: text("failure_code"),
    sanitizedSummary: text("sanitized_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("retention_executions_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    index("retention_executions_organization_started_idx").on(
      table.organizationId,
      table.startedAt,
    ),
    check(
      "retention_executions_batch_size_bounded",
      sql`${table.batchSize} between 1 and 10000`,
    ),
    check(
      "retention_executions_counts_nonnegative",
      sql`${table.selectedCount} >= 0 and ${table.expiredCount} >= 0 and ${table.alreadyExpiredCount} >= 0 and ${table.failedCount} >= 0 and ${table.remainingCount} >= 0 and ${table.pagesExpiredCount} >= 0 and ${table.sourceRecordsExpiredCount} >= 0 and ${table.quarantinesExpiredCount} >= 0`,
    ),
    check(
      "retention_executions_failure_bounded",
      sql`(${table.failureCode} is null or length(${table.failureCode}) between 1 and 128) and (${table.sanitizedSummary} is null or length(${table.sanitizedSummary}) between 1 and 500)`,
    ),
  ],
);
