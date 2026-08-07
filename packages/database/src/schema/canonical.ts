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
  uniqueIndex,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organizations } from "./core.ts";
import { sourceRecords } from "./ingestion.ts";

export const canonicalRecordKindEnum = pgEnum("canonical_record_kind", [
  "platform",
  "pack",
  "catalog_asset",
  "ev_input",
  "pull",
  "sale",
  "estimated_ev",
]);

export const canonicalEntities = pgTable(
  "canonical_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    platformKey: text("platform_key").notNull(),
    recordKind: canonicalRecordKindEnum("record_kind").notNull(),
    externalId: text("external_id").notNull(),
    currentRevisionId: uuid("current_revision_id").references(
      (): AnyPgColumn => canonicalRevisions.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("canonical_entities_stable_identity_unique").on(
      table.organizationId,
      table.platformKey,
      table.recordKind,
      table.externalId,
    ),
    unique("canonical_entities_id_organization_unique").on(table.id, table.organizationId),
    index("canonical_entities_current_revision_idx").on(table.currentRevisionId),
    check("canonical_entities_platform_not_blank", sql`length(trim(${table.platformKey})) > 0`),
    check("canonical_entities_external_not_blank", sql`length(trim(${table.externalId})) > 0`),
  ],
);

export const canonicalRevisions = pgTable(
  "canonical_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => canonicalEntities.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "restrict" }),
    contentJson: jsonb("content_json").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    provenanceJson: jsonb("provenance_json").$type<Record<string, unknown>>().notNull(),
    provenanceHash: text("provenance_hash").notNull(),
    actorKey: text("actor_key"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    sourceCollectedAt: timestamp("source_collected_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("canonical_revisions_entity_number_unique").on(
      table.entityId,
      table.revisionNumber,
    ),
    uniqueIndex("canonical_revisions_content_provenance_unique").on(
      table.entityId,
      table.contentHash,
      table.provenanceHash,
    ),
    unique("canonical_revisions_id_entity_organization_unique").on(
      table.id,
      table.entityId,
      table.organizationId,
    ),
    unique("canonical_revisions_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    foreignKey({
      name: "canonical_revisions_entity_tenant_fk",
      columns: [table.entityId, table.organizationId],
      foreignColumns: [canonicalEntities.id, canonicalEntities.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "canonical_revisions_source_tenant_fk",
      columns: [table.sourceRecordId, table.organizationId],
      foreignColumns: [sourceRecords.id, sourceRecords.organizationId],
    }).onDelete("restrict"),
    index("canonical_revisions_organization_accepted_idx").on(
      table.organizationId,
      table.acceptedAt,
    ),
    check("canonical_revisions_revision_positive", sql`${table.revisionNumber} > 0`),
  ],
);

export const sourceRecordProjectionRevisions = pgTable(
  "source_record_projection_revisions",
  {
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "restrict" }),
    canonicalRevisionId: uuid("canonical_revision_id")
      .notNull()
      .references(() => canonicalRevisions.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectionIndex: integer("projection_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_record_projection_revisions_source_projection_unique").on(
      table.sourceRecordId,
      table.projectionIndex,
    ),
    uniqueIndex("source_record_projection_revisions_pair_unique").on(
      table.sourceRecordId,
      table.canonicalRevisionId,
    ),
    foreignKey({
      name: "source_record_projection_revisions_source_tenant_fk",
      columns: [table.sourceRecordId, table.organizationId],
      foreignColumns: [sourceRecords.id, sourceRecords.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "source_record_projection_revisions_revision_tenant_fk",
      columns: [table.canonicalRevisionId, table.organizationId],
      foreignColumns: [canonicalRevisions.id, canonicalRevisions.organizationId],
    }).onDelete("restrict"),
    check(
      "source_record_projection_revisions_projection_index_nonnegative",
      sql`${table.projectionIndex} >= 0`,
    ),
  ],
);

export const canonicalRelationships = pgTable(
  "canonical_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => canonicalEntities.id, { onDelete: "restrict" }),
    relationshipKind: text("relationship_kind").notNull(),
    targetPlatformKey: text("target_platform_key").notNull(),
    targetRecordKind: canonicalRecordKindEnum("target_record_kind").notNull(),
    targetExternalId: text("target_external_id"),
    targetEntityId: uuid("target_entity_id").references(() => canonicalEntities.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("canonical_relationships_source_kind_target_unique").on(
      table.sourceEntityId,
      table.relationshipKind,
      table.targetPlatformKey,
      table.targetRecordKind,
      table.targetExternalId,
    ),
    index("canonical_relationships_unresolved_lookup_idx").on(
      table.organizationId,
      table.targetPlatformKey,
      table.targetRecordKind,
      table.targetExternalId,
      table.resolvedAt,
    ),
    foreignKey({
      name: "canonical_relationships_source_tenant_fk",
      columns: [table.sourceEntityId, table.organizationId],
      foreignColumns: [canonicalEntities.id, canonicalEntities.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "canonical_relationships_target_tenant_fk",
      columns: [table.targetEntityId, table.organizationId],
      foreignColumns: [canonicalEntities.id, canonicalEntities.organizationId],
    }).onDelete("restrict"),
  ],
);
