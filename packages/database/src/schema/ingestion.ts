import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
} from "drizzle-orm/pg-core";
import { organizations, providerConfigRevisions, providerSources } from "./core.ts";

export const importTriggerEnum = pgEnum("import_trigger", ["scheduled", "manual", "recovery"]);
export const importRunStateEnum = pgEnum("import_run_state", [
  "queued",
  "running",
  "succeeded",
  "incomplete",
  "failed",
]);
export const recordKindEnum = pgEnum("source_record_kind", ["catalog", "pull", "sale"]);
export const recordOutcomeEnum = pgEnum("source_record_outcome", [
  "accepted",
  "duplicate",
  "quarantined",
]);
export const quarantineStateEnum = pgEnum("quarantine_state", ["open", "resolved", "expired"]);

export interface RunCounters {
  accepted: number;
  duplicate: number;
  quarantined: number;
  pages: number;
  records: number;
  requestAttempts: number;
  transientRetries: number;
}

export interface RecordCounts {
  catalog: number;
  pulls: number;
  sales: number;
}

export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    configRevisionId: uuid("config_revision_id")
      .notNull()
      .references(() => providerConfigRevisions.id, { onDelete: "restrict" }),
    trigger: importTriggerEnum("trigger").notNull(),
    requestedByActorKey: text("requested_by_actor_key"),
    state: importRunStateEnum("state").notNull().default("queued"),
    requestedCursor: text("requested_cursor"),
    finalCursor: text("final_cursor"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0),
    reachedProviderHead: boolean("reached_provider_head").notNull().default(false),
    countersJson: jsonb("counters_json").$type<RunCounters>().notNull().default({
      accepted: 0,
      duplicate: 0,
      quarantined: 0,
      pages: 0,
      records: 0,
      requestAttempts: 0,
      transientRetries: 0,
    }),
    failureCode: text("failure_code"),
    failureSummary: text("failure_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("import_runs_organization_provider_created_idx").on(
      table.organizationId,
      table.providerId,
      table.createdAt,
    ),
    uniqueIndex("import_runs_provider_active_unique")
      .on(table.organizationId, table.providerId)
      .where(sql`${table.state} in ('queued', 'running')`),
    unique("import_runs_id_organization_provider_config_unique").on(
      table.id,
      table.organizationId,
      table.providerId,
      table.configRevisionId,
    ),
    unique("import_runs_id_organization_provider_unique").on(
      table.id,
      table.organizationId,
      table.providerId,
    ),
    foreignKey({
      name: "import_runs_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_runs_config_provider_tenant_fk",
      columns: [table.configRevisionId, table.providerId, table.organizationId],
      foreignColumns: [
        providerConfigRevisions.id,
        providerConfigRevisions.providerId,
        providerConfigRevisions.organizationId,
      ],
    }).onDelete("restrict"),
    check(
      "import_runs_requested_cursor_bounded",
      sql`${table.requestedCursor} is null or length(${table.requestedCursor}) <= 2048`,
    ),
    check(
      "import_runs_final_cursor_bounded",
      sql`${table.finalCursor} is null or length(${table.finalCursor}) <= 2048`,
    ),
    check(
      "import_runs_manual_actor_required",
      sql`${table.trigger} <> 'manual' or ${table.requestedByActorKey} is not null`,
    ),
    check(
      "import_runs_attempt_nonnegative",
      sql`${table.attempt} >= 0`,
    ),
    check(
      "import_runs_failure_bounded",
      sql`(${table.failureCode} is null or length(${table.failureCode}) <= 128) and (${table.failureSummary} is null or length(${table.failureSummary}) <= 500)`,
    ),
    check(
      "import_runs_lease_owner_bounded",
      sql`${table.leaseOwner} is null or length(${table.leaseOwner}) <= 256`,
    ),
  ],
);

export const providerCursorCheckpoints = pgTable(
  "provider_cursor_checkpoints",
  {
    configRevisionId: uuid("config_revision_id")
      .primaryKey()
      .references(() => providerConfigRevisions.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    cursor: text("cursor"),
    advancedByRunId: uuid("advanced_by_run_id").references(() => importRuns.id, {
      onDelete: "restrict",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("provider_cursor_checkpoints_organization_provider_idx").on(
      table.organizationId,
      table.providerId,
    ),
    foreignKey({
      name: "provider_cursor_checkpoints_config_tenant_fk",
      columns: [table.configRevisionId, table.providerId, table.organizationId],
      foreignColumns: [
        providerConfigRevisions.id,
        providerConfigRevisions.providerId,
        providerConfigRevisions.organizationId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "provider_cursor_checkpoints_run_tenant_fk",
      columns: [table.advancedByRunId, table.organizationId, table.providerId],
      foreignColumns: [importRuns.id, importRuns.organizationId, importRuns.providerId],
    }).onDelete("restrict"),
    check(
      "provider_cursor_checkpoints_cursor_bounded",
      sql`${table.cursor} is null or length(${table.cursor}) <= 2048`,
    ),
  ],
);

export const importPages = pgTable(
  "import_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "restrict" }),
    pageNumber: integer("page_number").notNull(),
    requestedCursor: text("requested_cursor"),
    nextCursor: text("next_cursor"),
    hasMore: boolean("has_more").notNull(),
    payloadJson: jsonb("payload_json").$type<unknown>(),
    payloadHash: text("payload_hash").notNull(),
    recordCountsJson: jsonb("record_counts_json").$type<RecordCounts>().notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    payloadExpiredAt: timestamp("payload_expired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("import_pages_run_number_unique").on(table.runId, table.pageNumber),
    unique("import_pages_run_cursor_unique")
      .on(table.runId, table.requestedCursor)
      .nullsNotDistinct(),
    unique("import_pages_id_organization_provider_run_unique").on(
      table.id,
      table.organizationId,
      table.providerId,
      table.runId,
    ),
    unique("import_pages_id_organization_run_unique").on(
      table.id,
      table.organizationId,
      table.runId,
    ),
    foreignKey({
      name: "import_pages_run_tenant_fk",
      columns: [table.runId, table.organizationId, table.providerId],
      foreignColumns: [importRuns.id, importRuns.organizationId, importRuns.providerId],
    }).onDelete("restrict"),
    index("import_pages_expiry_idx").on(table.organizationId, table.expiresAt),
    check("import_pages_page_number_positive", sql`${table.pageNumber} > 0`),
    check(
      "import_pages_cursors_bounded",
      sql`(${table.requestedCursor} is null or length(${table.requestedCursor}) <= 2048) and (${table.nextCursor} is null or length(${table.nextCursor}) <= 2048)`,
    ),
  ],
);

export const sourceRecords = pgTable(
  "source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    firstRunId: uuid("first_run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "restrict" }),
    firstPageId: uuid("first_page_id")
      .notNull()
      .references(() => importPages.id, { onDelete: "restrict" }),
    recordKind: recordKindEnum("record_kind").notNull(),
    externalId: text("external_id").notNull(),
    sourceTime: timestamp("source_time", { withTimezone: true }).notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
    contentHash: text("content_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    payloadExpiredAt: timestamp("payload_expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_records_immutable_identity_unique").on(
      table.organizationId,
      table.providerId,
      table.recordKind,
      table.externalId,
      table.sourceTime,
      table.contentHash,
    ),
    unique("source_records_id_organization_unique").on(table.id, table.organizationId),
    foreignKey({
      name: "source_records_first_page_tenant_fk",
      columns: [table.firstPageId, table.organizationId, table.providerId, table.firstRunId],
      foreignColumns: [
        importPages.id,
        importPages.organizationId,
        importPages.providerId,
        importPages.runId,
      ],
    }).onDelete("restrict"),
    index("source_records_expiry_idx").on(table.organizationId, table.expiresAt),
    check("source_records_external_id_not_blank", sql`length(trim(${table.externalId})) > 0`),
  ],
);

export const sourceRecordObservations = pgTable(
  "source_record_observations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "restrict" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => importPages.id, { onDelete: "restrict" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_record_observations_record_run_page_unique").on(
      table.sourceRecordId,
      table.runId,
      table.pageId,
    ),
    index("source_record_observations_organization_run_idx").on(
      table.organizationId,
      table.runId,
    ),
    foreignKey({
      name: "source_record_observations_source_tenant_fk",
      columns: [table.sourceRecordId, table.organizationId],
      foreignColumns: [sourceRecords.id, sourceRecords.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "source_record_observations_page_run_tenant_fk",
      columns: [table.pageId, table.organizationId, table.runId],
      foreignColumns: [importPages.id, importPages.organizationId, importPages.runId],
    }).onDelete("restrict"),
  ],
);

export const sourceRecordOutcomes = pgTable(
  "source_record_outcomes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "restrict" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => importPages.id, { onDelete: "restrict" }),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "restrict",
    }),
    recordKind: recordKindEnum("record_kind").notNull(),
    recordIndex: integer("record_index").notNull(),
    externalId: text("external_id"),
    outcome: recordOutcomeEnum("outcome").notNull(),
    reasonCode: text("reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_record_outcomes_page_kind_index_unique").on(
      table.pageId,
      table.recordKind,
      table.recordIndex,
    ),
    index("source_record_outcomes_organization_run_idx").on(
      table.organizationId,
      table.runId,
    ),
    foreignKey({
      name: "source_record_outcomes_page_run_tenant_fk",
      columns: [table.pageId, table.organizationId, table.runId],
      foreignColumns: [importPages.id, importPages.organizationId, importPages.runId],
    }).onDelete("restrict"),
    check("source_record_outcomes_record_index_nonnegative", sql`${table.recordIndex} >= 0`),
    foreignKey({
      name: "source_record_outcomes_source_tenant_fk",
      columns: [table.sourceRecordId, table.organizationId],
      foreignColumns: [sourceRecords.id, sourceRecords.organizationId],
    }).onDelete("restrict"),
  ],
);

export const quarantineRecords = pgTable(
  "quarantine_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerSources.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "restrict" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => importPages.id, { onDelete: "restrict" }),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "restrict",
    }),
    recordKind: recordKindEnum("record_kind").notNull(),
    recordIndex: integer("record_index").notNull(),
    externalId: text("external_id"),
    state: quarantineStateEnum("state").notNull().default("open"),
    reasonCode: text("reason_code").notNull(),
    fieldPath: text("field_path"),
    sanitizedSummary: text("sanitized_summary").notNull(),
    payloadJson: jsonb("payload_json").$type<unknown>(),
    retryCount: integer("retry_count").notNull().default(0),
    lastRetryAt: timestamp("last_retry_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    payloadExpiredAt: timestamp("payload_expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("quarantine_records_page_kind_index_unique").on(
      table.pageId,
      table.recordKind,
      table.recordIndex,
    ),
    index("quarantine_records_organization_state_idx").on(
      table.organizationId,
      table.state,
      table.createdAt,
    ),
    index("quarantine_records_expiry_idx").on(table.organizationId, table.expiresAt),
    foreignKey({
      name: "quarantine_records_provider_tenant_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [providerSources.id, providerSources.organizationId],
    }).onDelete("restrict"),
    check("quarantine_records_record_index_nonnegative", sql`${table.recordIndex} >= 0`),
    foreignKey({
      name: "quarantine_records_page_run_tenant_fk",
      columns: [table.pageId, table.organizationId, table.runId],
      foreignColumns: [importPages.id, importPages.organizationId, importPages.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "quarantine_records_source_tenant_fk",
      columns: [table.sourceRecordId, table.organizationId],
      foreignColumns: [sourceRecords.id, sourceRecords.organizationId],
    }).onDelete("restrict"),
  ],
);
