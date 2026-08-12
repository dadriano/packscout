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
import { organizations } from "./core.ts";
import { quarantineRecords, sourceRecords } from "./ingestion.ts";

export const quarantineAttemptStateEnum = pgEnum("quarantine_attempt_state", [
  "running",
  "succeeded",
  "failed",
]);

export const quarantineAttempts = pgTable(
  "quarantine_attempts",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    quarantineId: uuid("quarantine_id")
      .notNull()
      .references(() => quarantineRecords.id, { onDelete: "restrict" }),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "restrict",
    }),
    state: quarantineAttemptStateEnum("state").notNull().default("running"),
    requestedByActorKey: text("requested_by_actor_key").notNull(),
    failureCode: text("failure_code"),
    fieldPath: text("field_path"),
    sanitizedSummary: text("sanitized_summary"),
    canonicalRevisionCount: integer("canonical_revision_count"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("quarantine_attempts_one_running_unique")
      .on(table.quarantineId)
      .where(sql`${table.state} = 'running'`),
    index("quarantine_attempts_organization_quarantine_started_idx").on(
      table.organizationId,
      table.quarantineId,
      table.startedAt,
    ),
    foreignKey({
      name: "quarantine_attempts_quarantine_tenant_fk",
      columns: [table.quarantineId, table.organizationId],
      foreignColumns: [quarantineRecords.id, quarantineRecords.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "quarantine_attempts_source_tenant_fk",
      columns: [table.sourceRecordId, table.organizationId],
      foreignColumns: [sourceRecords.id, sourceRecords.organizationId],
    }).onDelete("restrict"),
    check(
      "quarantine_attempts_actor_key_bounded",
      sql`length(${table.requestedByActorKey}) between 1 and 256`,
    ),
    check(
      "quarantine_attempts_failure_bounded",
      sql`(${table.failureCode} is null or length(${table.failureCode}) <= 128) and (${table.fieldPath} is null or length(${table.fieldPath}) <= 256) and (${table.sanitizedSummary} is null or length(${table.sanitizedSummary}) <= 500)`,
    ),
    check(
      "quarantine_attempts_revision_count_nonnegative",
      sql`${table.canonicalRevisionCount} is null or ${table.canonicalRevisionCount} >= 0`,
    ),
  ],
);
