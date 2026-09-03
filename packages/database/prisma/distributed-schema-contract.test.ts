import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const prismaDirectory = fileURLToPath(new URL(".", import.meta.url));
const centralSchemaPath = join(prismaDirectory, "central", "schema.prisma");
const providerSchemaPath = join(prismaDirectory, "provider", "schema.prisma");

const CENTRAL_TABLES = [
  "database_identity",
  "organizations",
  "operators",
  "operator_memberships",
  "operator_sessions",
  "auth_rate_limits",
  "audit_events",
  "worker_instances",
  "email_message_intents",
  "email_message_attempts",
  "email_link_tokens",
  "providers",
  "provider_public_profile_versions",
  "provider_config_versions",
  "provider_credential_versions",
  "provider_database_nodes",
  "provider_connection_tests",
  "provider_activity_events",
  "global_activity_events",
  "provider_health",
  "admin_alerts",
  "global_categories",
  "global_collectibles",
  "global_collectible_categories",
  "global_collectible_name_aliases",
  "provider_category_correlations",
  "provider_collectible_correlations",
  "correlation_suggestions",
  "catalog_ledger",
  "collectible_aliases",
  "catalog_decision_events",
  "catalog_promotion_changes",
  "provider_release_invalidation_ledger",
  "provider_release_invalidations",
  "provider_invalidation_checkpoints",
  "catalog_consumer_checkpoints",
  "catalog_versions",
  "catalog_version_batches",
  "catalog_publication_operations",
  "manifest_activation_state",
  "manifest_activation_operations",
  "artifact_retention_executions",
] as const;

const PROVIDER_TABLES = [
  "database_identity",
  "categories",
  "packs",
  "collectibles",
  "collectible_name_aliases",
  "collectible_instances",
  "pack_contents",
  "pack_content_snapshots",
  "provider_accounts",
  "pulls",
  "pull_items",
  "market_events",
  "promotion_ledger",
  "promotion_changes",
  "provider_runtime",
  "provider_state_events",
  "provider_worker_states",
  "provider_runs",
  "provider_run_pages",
  "control_commands",
  "quarantine_records",
  "quarantine_attempts",
  "pack_ev_recomputation_requests",
  "retention_executions",
  "local_audit_events",
  "provider_activity_outbox",
  "provider_change_consumers",
  "provider_releases",
  "provider_release_batches",
  "provider_publication_operations",
  "provider_publication_receipts",
  "provider_publication_state",
  "pack_publication_scopes",
  "pack_publication_heads",
  "pack_build_requests",
  "pack_publication_change_receipts",
  "pack_publication_impact_progress",
  "pack_snapshot_artifacts",
  "pack_snapshot_batches",
  "pack_activation_intents",
  "pack_publication_operations",
  "pack_publication_receipts",
] as const;

const CENTRAL_ENUMS = {
  operator_state: ["pending", "active", "disabled", "cancelled"],
  operator_role: ["admin", "data_operator"],
  audit_outcome: ["success", "failure", "blocked"],
  provider_lifecycle: ["draft", "active", "disabled", "archived"],
  credential_lifecycle: ["active", "retired", "revoked"],
  credential_kind: ["source", "database"],
  connection_test_kind: ["source", "database", "activation"],
  connection_test_outcome: ["succeeded", "failed"],
  alert_state: ["active", "acknowledged", "resolved"],
  severity: ["info", "warning", "critical"],
  catalog_identity_state: ["provisional", "canonical", "retired"],
  category_kind: [
    "vertical",
    "sport",
    "league",
    "franchise",
    "brand",
    "set",
    "other",
  ],
  correlation_method: ["deterministic", "manual", "provisional"],
  suggestion_state: ["pending", "accepted", "rejected", "superseded"],
  entity_lifecycle: ["active", "retired"],
  collectible_type: [
    "card",
    "watch",
    "art",
    "coin",
    "sealed_product",
    "memorabilia",
    "other",
  ],
  promotion_operation: ["upsert", "retire"],
  activity_origin: ["provider", "central"],
  artifact_lifecycle: [
    "building",
    "assembled",
    "publishing",
    "complete",
    "blocked",
    "failed",
  ],
  publication_operation_state: ["pending", "accepted", "ambiguous", "failed"],
  manifest_operation: ["advance", "add", "remove", "rollback"],
  retention_state: ["running", "succeeded", "failed"],
  worker_instance_state: ["running", "stopped"],
  worker_activity_kind: [
    "idle",
    "scheduling",
    "importing",
    "estimated_ev",
    "retention",
    "message_outbox",
  ],
  email_message_intent_state: [
    "pending",
    "retrying",
    "sent",
    "skipped",
    "failed",
  ],
  email_message_attempt_outcome: ["sent", "skipped", "failed"],
  email_link_purpose: ["operator_password_reset", "operator_invitation"],
} as const;

const PROVIDER_ENUMS = {
  entity_lifecycle: ["active", "retired"],
  availability_state: ["available", "sold_out", "unavailable"],
  evidence_state: ["complete", "partial", "unknown"],
  pack_format: ["repack", "gacha"],
  collectible_type: [
    "card",
    "watch",
    "art",
    "coin",
    "sealed_product",
    "memorabilia",
    "other",
  ],
  content_role: ["top_chase", "featured_chase", "possible_outcome", "other"],
  market_event_type: [
    "sale",
    "buyback",
    "mint",
    "burn",
    "transfer",
    "list",
    "unlist",
    "swap",
    "ship",
    "other",
  ],
  promotion_operation: ["upsert", "retire"],
  runtime_state: ["idle", "running", "paused", "stopped", "error"],
  worker_role: ["import", "promotion"],
  run_state: ["queued", "running", "succeeded", "incomplete", "failed"],
  run_trigger: ["scheduled", "manual", "recovery"],
  page_continuation: ["more", "head"],
  command_type: [
    "run",
    "pause",
    "resume",
    "stop",
    "retry_run",
    "retry_quarantine",
  ],
  command_state: ["pending", "accepted", "rejected", "completed", "failed"],
  quarantine_state: ["open", "resolved", "expired"],
  quarantine_attempt_state: ["running", "succeeded", "failed"],
  retention_state: ["running", "succeeded", "failed"],
  ev_recomputation_state: ["queued", "running", "completed", "failed"],
  ev_recomputation_result: ["estimated", "unavailable"],
  audit_outcome: ["success", "failure", "blocked"],
  severity: ["info", "warning", "critical"],
  activity_delivery_state: ["pending", "delivered"],
  artifact_lifecycle: [
    "building",
    "assembled",
    "publishing",
    "complete",
    "blocked",
    "failed",
  ],
  publication_operation_state: ["pending", "accepted", "ambiguous", "failed"],
  publication_receipt_outcome: ["accepted", "rejected"],
} as const;

const CENTRAL_SOFT_REFERENCES = [
  "worker_instances.activity_organization_id",
  "worker_instances.activity_provider_id",
  "worker_instances.activity_run_id",
  "provider_activity_events.local_run_id",
  "provider_activity_events.local_quarantine_id",
  "admin_alerts.run_id",
  "admin_alerts.quarantine_id",
  "provider_category_correlations.local_category_id",
  "provider_collectible_correlations.local_collectible_id",
  "correlation_suggestions.local_collectible_id",
  "provider_invalidation_checkpoints.confirmed_provider_release_id",
  "manifest_activation_state.active_manifest_id",
  "manifest_activation_state.previous_manifest_id",
  "manifest_activation_operations.expected_manifest_id",
  "manifest_activation_operations.target_provider_release_id",
] as const;

const PROVIDER_SOFT_REFERENCES = [
  "pack_publication_scopes.organization_id",
  "pack_publication_scopes.provider_id",
  "database_identity.provider_id",
  "provider_runtime.central_provider_id",
  "provider_runtime.cached_config_version_id",
  "provider_runs.requested_by_operator_id",
  "provider_runs.config_version_id",
  "control_commands.requested_by_operator_id",
  "quarantine_attempts.requested_by_operator_id",
  "local_audit_events.actor_operator_id",
  "provider_releases.provider_id",
  "provider_releases.catalog_version_id",
  "provider_releases.correlation_event_sequence",
  "provider_releases.public_profile_version_id",
  "provider_publication_state.observed_active_manifest_id",
] as const;

const CENTRAL_ALLOWED_UNBOUND_UUIDS = [
  "database_identity.provider_id",
  "audit_events.subject_id",
  "worker_instances.activity_organization_id",
  "worker_instances.activity_provider_id",
  "worker_instances.activity_run_id",
  "provider_activity_events.local_run_id",
  "provider_activity_events.local_quarantine_id",
  "admin_alerts.run_id",
  "admin_alerts.quarantine_id",
  "provider_category_correlations.local_category_id",
  "provider_collectible_correlations.local_collectible_id",
  "correlation_suggestions.local_collectible_id",
  "catalog_promotion_changes.entity_id",
  "provider_invalidation_checkpoints.confirmed_provider_release_id",
  "manifest_activation_operations.target_provider_release_id",
] as const;

const PROVIDER_ALLOWED_UNBOUND_UUIDS = [
  // Central authority is bound once against database_identity by the scope trigger.
  "pack_publication_scopes.organization_id",
  "pack_publication_scopes.provider_id",
  // Polymorphic build/activation reference: scoped deferred SQL constraint below.
  "pack_publication_heads.lease_work_id",
  "database_identity.provider_id",
  "market_events.event_group_id",
  "promotion_changes.entity_id",
  "provider_runtime.central_provider_id",
  "provider_runtime.cached_config_version_id",
  "provider_state_events.correlation_id",
  "provider_runs.requested_by_operator_id",
  "provider_runs.config_version_id",
  "control_commands.requested_by_operator_id",
  "control_commands.correlation_id",
  "quarantine_attempts.requested_by_operator_id",
  "quarantine_attempts.correlation_id",
  "local_audit_events.actor_operator_id",
  "local_audit_events.correlation_id",
  "provider_releases.provider_id",
  "provider_releases.public_provider_id",
  "provider_releases.catalog_version_id",
  "provider_releases.public_profile_version_id",
] as const;

const FORBIDDEN_MODEL_PATTERNS = [
  /^canonical_(?:entities|revisions|relationships)$/u,
  /(?:^|_)source_records?(?:_|$)/u,
  /(?:^|_)legacy(?:_|$)/iu,
  /(?:^|_)generic(?:_|$)/iu,
  /(?:^|_)streams?(?:_|$)/u,
  /(?:^|_)product(?:_|$)/u,
  /(?:^|_)heat(?:_|$)/iu,
  /^estimated_ev_recomputation/u,
] as const;

const FORBIDDEN_FIELD_PATTERNS = [
  /(?:^|_)legacy(?:_|$)/iu,
  /(?:^|_)generic(?:_|$)/iu,
  /(?:^|_)streams?(?:_|$)/u,
  /(?:^|_)platform(?:_|$)/u,
  /(?:^|_)site(?:_|$)/u,
  /(?:^|_)product(?:_|$)/u,
  /(?:^|_)heat(?:_|$)/iu,
  /(?:^|_)raw(?:_|$)/u,
  /(?:^|_)mapper(?:_|$)/u,
  /(?:^|_)provenance(?:_|$)/u,
  /^source_(?:adapter|page|payload|staging)(?:_|$)/u,
  /^source_record_(?!key$)/u,
  /^canonical_(?:entity|revision|relationship)_id$/u,
] as const;

interface NamedBlock {
  readonly name: string;
  readonly body: string;
}

function namedBlocks(source: string, kind: "enum" | "generator" | "model"): NamedBlock[] {
  const blocks: NamedBlock[] = [];
  const pattern = new RegExp(
    `^${kind}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\{([\\s\\S]*?)^\\s*\\}`,
    "gmu",
  );
  for (const match of source.matchAll(pattern)) {
    blocks.push({ name: match[1]!, body: match[2]! });
  }
  return blocks;
}

function fieldsIn(model: NamedBlock): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of model.body.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("@@")
    ) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+[^\s]+/u.exec(trimmed);
    if (match) fields.set(match[1]!, trimmed);
  }
  return fields;
}

function relationScalarFields(model: NamedBlock): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const relation of model.body.matchAll(/@relation\s*\(([\s\S]*?)\)/gu)) {
    const relationFields = /\bfields\s*:\s*\[([^\]]+)\]/u.exec(relation[1]!);
    if (!relationFields) continue;
    for (const field of relationFields[1]!.split(",")) {
      fields.add(field.trim());
    }
  }
  return fields;
}

function enumInventory(source: string): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    namedBlocks(source, "enum").map((block) => [
      block.name,
      block.body
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/u, "").trim())
        .filter((line) => line !== "")
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)\b/u.exec(line)?.[1])
        .filter((label): label is string => label !== undefined),
    ]),
  );
}

function generatedClientOutput(source: string, role: string): string {
  const generators = namedBlocks(source, "generator");
  assert.equal(generators.length, 1, `${role} must define exactly one Prisma generator`);
  const output = /^\s*output\s*=\s*"([^"]+)"\s*$/mu.exec(generators[0]!.body)?.[1];
  assert.ok(output, `${role} must use an explicit generated-client output`);
  return output;
}

function modelMap(source: string): ReadonlyMap<string, NamedBlock> {
  return new Map(namedBlocks(source, "model").map((block) => [block.name, block]));
}

function assertDatabaseIdentity(
  models: ReadonlyMap<string, NamedBlock>,
  role: string,
): void {
  const identity = models.get("database_identity");
  assert.ok(identity, `${role} must contain database_identity`);
  assert.deepEqual(
    [...fieldsIn(identity).keys()].sort(),
    [
      "created_at",
      "database_role",
      "provider_id",
      "provider_key",
      "schema_version",
      "singleton_key",
    ],
    `${role} database_identity fields drifted`,
  );
}

function assertNoForbiddenNames(models: readonly NamedBlock[], role: string): void {
  for (const model of models) {
    for (const pattern of FORBIDDEN_MODEL_PATTERNS) {
      assert.doesNotMatch(model.name, pattern, `${role} has forbidden model ${model.name}`);
    }
    for (const field of fieldsIn(model).keys()) {
      for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
        assert.doesNotMatch(
          field,
          pattern,
          `${role} has forbidden field ${model.name}.${field}`,
        );
      }
    }
  }
}

function assertSoftReferencesHaveNoPrismaRelation(
  models: ReadonlyMap<string, NamedBlock>,
  references: readonly string[],
  role: string,
): void {
  for (const reference of references) {
    const separator = reference.indexOf(".");
    const modelName = reference.slice(0, separator);
    const fieldName = reference.slice(separator + 1);
    const model = models.get(modelName);
    assert.ok(model, `${role} soft-reference model ${modelName} is missing`);
    assert.ok(
      fieldsIn(model).has(fieldName),
      `${role} soft-reference field ${reference} is missing`,
    );
    assert.ok(
      !relationScalarFields(model).has(fieldName),
      `${role} soft reference ${reference} must not become a Prisma relation`,
    );
  }
}

function unboundUuidIdentifiers(source: string): string[] {
  const result: string[] = [];
  for (const model of namedBlocks(source, "model")) {
    const relationFields = relationScalarFields(model);
    for (const [fieldName, definition] of fieldsIn(model)) {
      if (
        fieldName !== "id" &&
        fieldName.endsWith("_id") &&
        /\bString\??(?=\s)/u.test(definition) &&
        /@db\.Uuid\b/u.test(definition) &&
        !relationFields.has(fieldName)
      ) {
        result.push(`${model.name}.${fieldName}`);
      }
    }
  }
  return result.sort();
}

function migrationFiles(directory: string): string[] {
  const results: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "migration.sql") results.push(path);
    }
  };
  visit(directory);
  return results.sort();
}

function baselineMigration(role: "central" | "provider"): string {
  const files = migrationFiles(join(prismaDirectory, role, "migrations"))
    .filter((path) => path.includes("_baseline/"));
  assert.equal(files.length, 1, `${role} must have exactly one clean baseline migration`);
  return readFileSync(files[0]!, "utf8");
}

function migrationContents(role: "central" | "provider", name: string): string {
  return readFileSync(
    join(prismaDirectory, role, "migrations", name, "migration.sql"),
    "utf8",
  );
}

test("distributed Prisma schemas freeze exact role inventories and enum vocabularies", () => {
  const centralSource = readFileSync(centralSchemaPath, "utf8");
  const providerSource = readFileSync(providerSchemaPath, "utf8");
  const centralModels = modelMap(centralSource);
  const providerModels = modelMap(providerSource);

  assert.deepEqual([...centralModels.keys()].sort(), [...CENTRAL_TABLES].sort());
  assert.deepEqual([...providerModels.keys()].sort(), [...PROVIDER_TABLES].sort());
  assert.equal(centralModels.size, 42);
  assert.equal(providerModels.size, 42);
  assert.deepEqual(enumInventory(centralSource), CENTRAL_ENUMS);
  assert.deepEqual(enumInventory(providerSource), PROVIDER_ENUMS);

  const centralOutput = generatedClientOutput(centralSource, "central");
  const providerOutput = generatedClientOutput(providerSource, "provider");
  assert.notEqual(centralOutput, providerOutput, "generated Prisma clients must be distinct");
  assert.match(centralOutput, /(?:^|\/)generated\/central$/u);
  assert.match(providerOutput, /(?:^|\/)generated\/provider$/u);

  assertDatabaseIdentity(centralModels, "central");
  assertDatabaseIdentity(providerModels, "provider");
  assertNoForbiddenNames([...centralModels.values()], "central");
  assertNoForbiddenNames([...providerModels.values()], "provider");

  const sharedTables = [...centralModels.keys()].filter((name) => providerModels.has(name));
  assert.deepEqual(sharedTables, ["database_identity"]);
});

test("cross-authority identifiers stay soft while every local UUID reference is relational", () => {
  const centralSource = readFileSync(centralSchemaPath, "utf8");
  const providerSource = readFileSync(providerSchemaPath, "utf8");
  const centralModels = modelMap(centralSource);
  const providerModels = modelMap(providerSource);

  assertSoftReferencesHaveNoPrismaRelation(
    centralModels,
    CENTRAL_SOFT_REFERENCES,
    "central",
  );
  assertSoftReferencesHaveNoPrismaRelation(
    providerModels,
    PROVIDER_SOFT_REFERENCES,
    "provider",
  );
  assert.deepEqual(
    unboundUuidIdentifiers(centralSource),
    [...CENTRAL_ALLOWED_UNBOUND_UUIDS].sort(),
    "central UUID identifiers without local Prisma relations drifted",
  );
  assert.deepEqual(
    unboundUuidIdentifiers(providerSource),
    [...PROVIDER_ALLOWED_UNBOUND_UUIDS].sort(),
    "provider UUID identifiers without local Prisma relations drifted",
  );
});

test("pack publication owns only scoped local references and immutable episodes", () => {
  const migration = migrationContents("provider", "20260903194000_pack_publication_state");
  assert.match(migration, /provider_id = NEW.provider_id/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER pack_lease_reference/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_pack_lease_reference/u);
  assert.match(migration, /w.organization_id = head.organization_id AND w.provider_id = head.provider_id/u);
  assert.match(migration, /w.public_repack_id = head.public_repack_id AND w.state = 'publishing'/u);
  assert.match(migration, /after_pack_id uuid REFERENCES packs\(id\)/u);
  assert.match(migration, /OLD.state IN \('published','superseded','rolled_back'\)/u);
  assert.match(migration, /pack_publication_one_shared_boundary_idx/u);
});

test("provider facts preserve source identities while local relationships resolve monotonically", () => {
  const providerSource = readFileSync(providerSchemaPath, "utf8");
  const providerModels = modelMap(providerSource);
  const pulls = providerModels.get("pulls");
  const pullItems = providerModels.get("pull_items");
  const marketEvents = providerModels.get("market_events");
  const packs = providerModels.get("packs");
  const collectibles = providerModels.get("collectibles");
  assert.ok(pulls);
  assert.ok(pullItems);
  assert.ok(marketEvents);
  assert.ok(packs);
  assert.ok(collectibles);

  const pullFields = fieldsIn(pulls);
  assert.match(pullFields.get("pack_key") ?? "", /^pack_key\s+String\?/u);
  assert.match(pullFields.get("pack_id") ?? "", /^pack_id\s+String\?\s+@db\.Uuid/u);
  assert.match(pullFields.get("item_count") ?? "", /^item_count\s+Int$/u);
  assert.match(pullFields.get("row_version") ?? "", /BigInt\s+@default\(1\)/u);
  assert.ok(pullFields.has("updated_at"));
  assert.match(
    pulls.body,
    /pack\s+packs\?\s+@relation\(fields:\s*\[pack_id, pack_key\],\s*references:\s*\[id, pack_key\]/u,
  );
  assert.doesNotMatch(pulls.body, /@@index\(\[pack_key\]/u);

  const pullItemFields = fieldsIn(pullItems);
  assert.match(
    pullItemFields.get("collectible_key") ?? "",
    /^collectible_key\s+String\?/u,
  );
  assert.match(
    pullItemFields.get("collectible_id") ?? "",
    /^collectible_id\s+String\?\s+@db\.Uuid/u,
  );
  assert.match(pullItemFields.get("row_version") ?? "", /BigInt\s+@default\(1\)/u);
  assert.ok(pullItemFields.has("updated_at"));
  assert.match(
    pullItems.body,
    /collectible\s+collectibles\?\s+@relation\(fields:\s*\[collectible_id, collectible_key\],\s*references:\s*\[id, collectible_key\]/u,
  );
  assert.doesNotMatch(pullItems.body, /@@index\(\[collectible_key\]/u);

  const marketEventFields = fieldsIn(marketEvents);
  for (const fieldName of ["pack_key", "collectible_key"]) {
    assert.match(marketEventFields.get(fieldName) ?? "", /String\?/u);
  }
  for (const fieldName of ["pack_id", "collectible_id"]) {
    assert.match(marketEventFields.get(fieldName) ?? "", /String\?\s+@db\.Uuid/u);
  }
  assert.match(marketEventFields.get("row_version") ?? "", /BigInt\s+@default\(1\)/u);
  assert.ok(marketEventFields.has("updated_at"));
  assert.match(
    marketEvents.body,
    /pack\s+packs\?\s+@relation\(fields:\s*\[pack_id, pack_key\],\s*references:\s*\[id, pack_key\]/u,
  );
  assert.match(
    marketEvents.body,
    /collectible\s+collectibles\?\s+@relation\(fields:\s*\[collectible_id, collectible_key\],\s*references:\s*\[id, collectible_key\]/u,
  );
  assert.doesNotMatch(marketEvents.body, /@@index\(\[(?:pack|collectible)_key\]/u);
  assert.match(packs.body, /@@unique\(\[id, pack_key\],\s*map:\s*"packs_id_pack_key_key"\)/u);
  assert.match(
    collectibles.body,
    /@@unique\(\[id, collectible_key\],\s*map:\s*"collectibles_id_collectible_key_key"\)/u,
  );

  const migration = migrationContents(
    "provider",
    "20260829120000_provider_fact_deferred_relationships",
  );
  for (const expectedIndex of [
    /CREATE INDEX "pulls_unresolved_pack_key_idx"\s+ON "pulls"\("pack_key", "id"\)\s+WHERE "pack_key" IS NOT NULL AND "pack_id" IS NULL/u,
    /CREATE INDEX "pull_items_unresolved_collectible_key_idx"\s+ON "pull_items"\("collectible_key", "id"\)\s+WHERE "collectible_key" IS NOT NULL AND "collectible_id" IS NULL/u,
    /CREATE INDEX "market_events_unresolved_pack_key_idx"\s+ON "market_events"\("pack_key", "id"\)\s+WHERE "pack_key" IS NOT NULL AND "pack_id" IS NULL/u,
    /CREATE INDEX "market_events_unresolved_collectible_key_idx"\s+ON "market_events"\("collectible_key", "id"\)\s+WHERE "collectible_key" IS NOT NULL AND "collectible_id" IS NULL/u,
  ]) {
    assert.match(migration, expectedIndex);
  }
  for (const expectedConstraint of [
    /FOREIGN KEY \("pack_id", "pack_key"\)\s+REFERENCES "packs"\("id", "pack_key"\) MATCH SIMPLE/u,
    /FOREIGN KEY \("collectible_id", "collectible_key"\)\s+REFERENCES "collectibles"\("id", "collectible_key"\) MATCH SIMPLE/u,
    /"pulls_pack_resolution_check"\s+CHECK \("pack_id" IS NULL OR "pack_key" IS NOT NULL\)/u,
    /"pulls_item_count_check"\s+CHECK \("item_count" > 0\)/u,
    /"pull_items_collectible_resolution_check"\s+CHECK \("collectible_id" IS NULL OR "collectible_key" IS NOT NULL\)/u,
    /"market_events_subject_check"\s+CHECK \("pack_key" IS NOT NULL OR "collectible_key" IS NOT NULL\)/u,
  ]) {
    assert.match(migration, expectedConstraint);
  }
  for (const factTable of ["pulls", "pull_items", "market_events"]) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER "${factTable}_row_version_trigger" BEFORE UPDATE ON "${factTable}"`, "u"),
    );
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER "${factTable}_resolvable_fact_guard_trigger" BEFORE UPDATE OR DELETE ON "${factTable}"`, "u"),
    );
    assert.match(
      migration,
      new RegExp(`CREATE CONSTRAINT TRIGGER "${factTable}_promotion_change_trigger" AFTER INSERT OR UPDATE ON "${factTable}"`, "u"),
    );
    assert.doesNotMatch(
      migration,
      new RegExp(`CREATE TRIGGER "${factTable}_append_only_trigger"`, "u"),
    );
  }
  assert.match(
    migration,
    /TG_OP = 'INSERT' AND NEW\."row_version" <> 1[\s\S]{0,160}MESSAGE = 'promotion_fact_initial_version_invalid'/u,
  );
  assert.match(migration, /change\."entity_version" = NEW\."row_version"/u);
  assert.match(
    migration,
    /SELECT true, "row_version" INTO entity_found, current_version FROM "pulls"/u,
  );
  assert.match(migration, /NEW\."entity_version" > 1 AND NOT EXISTS/u);
  assert.match(migration, /MESSAGE = 'pull_requires_item'/u);
  assert.match(migration, /MESSAGE = 'pull_requires_source_relationship'/u);
  assert.match(migration, /MESSAGE = 'pull_item_count_mismatch'/u);
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER "pull_items_exact_count_trigger"\s+AFTER INSERT ON "pull_items"/u,
  );
  for (const stableKey of [
    "category_key",
    "pack_key",
    "collectible_key",
    "instance_key",
    "account_key",
  ]) {
    assert.match(migration, new RegExp(`THEN '${stableKey}'`, "u"));
  }
  assert.match(migration, /MESSAGE = TG_TABLE_NAME \|\| '_stable_key_immutable'/u);
});

test("provider pack membership receipts retain source proof and require same-pack references", () => {
  const providerModels = modelMap(readFileSync(providerSchemaPath, "utf8"));
  const snapshots = providerModels.get("pack_content_snapshots");
  const contents = providerModels.get("pack_contents");
  assert.ok(snapshots);
  assert.ok(contents);
  const fields = fieldsIn(snapshots);
  for (const fieldName of [
    "source_key", "effective_at_basis", "completeness",
  ]) assert.match(fields.get(fieldName) ?? "", new RegExp(`^${fieldName}\\s+String$`, "u"));
  for (const fieldName of ["effective_at", "collected_at", "created_at"]) {
    assert.match(fields.get(fieldName) ?? "", /DateTime\s+(?:@default\(now\(\)\)\s+)?@db\.Timestamptz\(6\)/u);
  }
  assert.match(fields.get("snapshot_digest") ?? "", /String\s+@db\.Char\(64\)/u);
  assert.match(fields.get("normalized_snapshot") ?? "", /Json\s+@db\.JsonB/u);
  assert.ok(!fields.has("source_adapter_version"));
  assert.ok(!fields.has("mapper_version"));
  assert.match(fields.get("pack_id") ?? "", /String\s+@db\.Uuid/u);
  assert.match(snapshots.body, /pack\s+packs\s+@relation\(fields:\s*\[pack_id\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict/u);
  assert.match(snapshots.body, /@@unique\(\[id, pack_id\]/u);
  assert.match(snapshots.body, /@@unique\(\[pack_id, effective_at\]/u);
  assert.match(snapshots.body, /@@index\(\[pack_id, effective_at\(sort: Desc\)\]/u);
  assert.match(fieldsIn(contents).get("source_snapshot_id") ?? "", /String\?\s+@db\.Uuid/u);
  assert.match(contents.body, /source_snapshot\s+pack_content_snapshots\?\s+@relation\(fields:\s*\[source_snapshot_id, pack_id\],\s*references:\s*\[id, pack_id\],\s*onDelete:\s*Restrict/u);

  const migration = migrationContents("provider", "20260831010000_provider_pack_content_snapshots");
  assert.match(migration, /^BEGIN;/u);
  assert.match(migration, /CREATE UNIQUE INDEX "pack_contents_active_identity_key"\s+ON "pack_contents" \("pack_id", "collectible_id", "collectible_instance_id"\)\s+NULLS NOT DISTINCT WHERE "lifecycle" = 'active'/u);
  assert.ok(migration.indexOf("CREATE UNIQUE INDEX") < migration.indexOf("CREATE TABLE"));
  assert.doesNotMatch(migration, /(?:DELETE FROM|TRUNCATE)\s+"?pack_contents"?/iu);
  assert.match(migration, /FOREIGN KEY \("source_snapshot_id", "pack_id"\) REFERENCES "pack_content_snapshots" \("id", "pack_id"\) ON DELETE RESTRICT/u);
  assert.match(migration, /"pack_content_snapshots_time_check" CHECK \("collected_at" >= "effective_at"\)/u);
  assert.match(migration, /"effective_at_basis" IN \('provider_updated_at', 'response_observed_at'\)/u);
  assert.match(migration, /"completeness" IN \('complete', 'partial'\)/u);
  assert.match(migration, /"pack_content_snapshots_version_identity_check" CHECK \(coalesce\(/u);
  for (const fieldName of ["sourceAdapterVersion", "mapperVersion"]) {
    assert.ok(migration.includes(`jsonb_typeof("normalized_snapshot"->'${fieldName}') = 'string'`));
    assert.ok(migration.includes(`length("normalized_snapshot"->>'${fieldName}') BETWEEN 1 AND 256`));
  }
  assert.match(migration, /jsonb_array_length\("normalized_snapshot"->'items'\) <= 1000/u);
  assert.match(migration, /octet_length\("normalized_snapshot"::text\) <= 262144/u);
  assert.match(migration, /CREATE TRIGGER "pack_content_snapshots_append_only_trigger"\s+BEFORE UPDATE OR DELETE ON "pack_content_snapshots"\s+FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"\(\)/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "pack_content_snapshots_promotion_change_trigger"\s+AFTER INSERT ON "pack_content_snapshots" DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /"entity_type" = 'pack_content_snapshot'\s+AND "entity_id" = NEW.id AND "entity_version" = 1 AND "operation" = 'upsert'/u);
  assert.match(migration, /WHEN 'pack_content_snapshot' THEN\s+mutable_entity := false;/u);
  assert.match(migration, /COMMIT;\s*$/u);
});

test("provider quarantine source keys are nullable durable idempotency keys", () => {
  const providerModels = modelMap(readFileSync(providerSchemaPath, "utf8"));
  const quarantineRecords = providerModels.get("quarantine_records");
  assert.ok(quarantineRecords);
  assert.match(
    fieldsIn(quarantineRecords).get("source_record_key") ?? "",
    /String\?\s+@unique\(map:\s*"quarantine_records_source_record_key_key"\)/u,
  );

  const providerMigration = migrationContents(
    "provider",
    "20260829120000_provider_fact_deferred_relationships",
  );
  assert.match(
    providerMigration,
    /CREATE UNIQUE INDEX "quarantine_records_source_record_key_key"\s+ON "quarantine_records"\("source_record_key"\)/u,
  );
});

test("clean baselines pin schema identities without hard-coding a provider", () => {
  const centralMigration = baselineMigration("central");
  const providerMigration = baselineMigration("provider");
  const initializerDeclaration = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?public"?\.)?"?initialize_provider_database_identity"?\s*\(\s*p_provider_id\s+UUID\s*,\s*p_provider_key\s+TEXT\s*\)/iu;
  const initializerStart = providerMigration.search(initializerDeclaration);
  assert.notEqual(initializerStart, -1, "provider identity initializer is missing");
  const providerInitializer = providerMigration.slice(initializerStart);

  assert.deepEqual(
    [...new Set(centralMigration.match(/distributed-(?:central|provider)-v[0-9]+/gu) ?? [])],
    ["distributed-central-v1"],
  );
  assert.deepEqual(
    [...new Set(providerMigration.match(/distributed-(?:central|provider)-v[0-9]+/gu) ?? [])],
    ["distributed-provider-v1"],
  );
  assert.match(centralMigration, /INSERT\s+INTO\s+(?:"?public"?\.)?"?database_identity"?/iu);
  assert.equal(
    centralMigration.match(/INSERT\s+INTO\s+(?:"?public"?\.)?"?database_identity"?/giu)?.length,
    1,
    "central baseline must seed database_identity exactly once",
  );
  assert.match(centralMigration, /['"]central['"]/u);

  assert.match(
    providerInitializer,
    initializerDeclaration,
  );
  assert.equal(
    providerMigration.match(/\bCREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?public"?\.)?"?initialize_provider_database_identity"?\b/giu)?.length,
    1,
    "provider baseline must define exactly one identity initializer",
  );
  assert.match(providerInitializer, /\bcurrent_database\s*\(\s*\)/iu);
  assert.match(providerInitializer, /['"]packscout_['"]\s*\|\|\s*p_provider_key\b/iu);
  assert.match(
    providerInitializer,
    /INSERT\s+INTO\s+(?:"?public"?\.)?"?database_identity"?[\s\S]{0,500}\bp_provider_id\b[\s\S]{0,100}\bp_provider_key\b/iu,
  );
  assert.match(
    providerInitializer,
    /INSERT\s+INTO\s+(?:"?public"?\.)?"?provider_runtime"?[\s\S]{0,500}\bp_provider_id\b[\s\S]{0,100}\bp_provider_key\b/iu,
  );
  assert.equal(
    providerMigration.match(/INSERT\s+INTO\s+(?:"?public"?\.)?"?database_identity"?/giu)?.length,
    1,
    "provider identity must only be inserted by its initializer",
  );
  assert.equal(
    providerMigration.match(/INSERT\s+INTO\s+(?:"?public"?\.)?"?provider_runtime"?/giu)?.length,
    1,
    "provider runtime must only be inserted by its initializer",
  );
  assert.match(providerInitializer, /RAISE\s+EXCEPTION/iu);
  assert.match(providerInitializer, /(?:ON\s+CONFLICT|IF\s+(?:EXISTS|FOUND))/iu);

  assert.doesNotMatch(
    providerInitializer,
    /['"][0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}['"]/iu,
    "provider migration must not hard-code a provider UUID",
  );
  assert.doesNotMatch(
    providerInitializer,
    /'packscout_[a-z][a-z0-9_]{0,52}'/u,
    "provider migration must not hard-code a provider database/key",
  );
});

test("central baseline pins exactly-once and bounded global-correlation evidence", () => {
  const migration = baselineMigration("central");
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "catalog_decision_events_correlation_request_unique"/u,
  );
  for (const actorType of [
    "provider_correlation_request",
    "provider_correlation_conflict",
    "provider_category_correlation_request",
    "provider_category_correlation_conflict",
  ]) {
    assert.match(migration, new RegExp(`'${actorType}'`, "u"));
  }
  assert.match(migration, /catalog_decision_events_bounded_evidence_check/u);
  assert.match(migration, /octet_length\("after_state"::text\) <= 4096/u);
  assert.match(migration, /correlation_suggestions_bounded_rationale_check/u);
  assert.match(migration, /'raw', 'payload', 'credential', 'databaseUrl', 'externalIdentifier'/u);
});

test("admin support state stays central while recomputation work stays provider-local", () => {
  const centralSource = readFileSync(centralSchemaPath, "utf8");
  const providerSource = readFileSync(providerSchemaPath, "utf8");
  const centralModels = modelMap(centralSource);
  const providerModels = modelMap(providerSource);

  for (const modelName of [
    "operators",
    "worker_instances",
    "email_message_intents",
    "email_link_tokens",
  ]) {
    const model = centralModels.get(modelName);
    assert.ok(model, `central ${modelName} is missing`);
    const fields = fieldsIn(model);
    for (const fieldName of ["row_version", "created_at", "updated_at"]) {
      assert.ok(fields.has(fieldName), `${modelName}.${fieldName} is required`);
    }
  }

  for (const modelName of [
    "worker_instances",
    "email_message_intents",
    "email_message_attempts",
    "email_link_tokens",
    "global_activity_events",
  ]) {
    assert.ok(centralModels.has(modelName), `${modelName} must be central`);
    assert.ok(!providerModels.has(modelName), `${modelName} must not be provider-local`);
  }

  const recomputation = providerModels.get("pack_ev_recomputation_requests");
  assert.ok(recomputation, "provider recomputation queue is missing");
  assert.ok(!centralModels.has("pack_ev_recomputation_requests"));
  const recomputationFields = fieldsIn(recomputation);
  for (const fieldName of [
    "pack_id",
    "trigger_change_sequence",
    "input_hash",
    "state",
    "row_version",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(
      recomputationFields.has(fieldName),
      `pack_ev_recomputation_requests.${fieldName} is required`,
    );
  }

  const centralMigration = baselineMigration("central");
  assert.match(centralMigration, /operators_credential_lifecycle_check/u);
  assert.match(centralMigration, /email_link_tokens_one_outstanding_unique/u);
  assert.match(centralMigration, /global_activity_events_append_only/u);
  assert.match(centralMigration, /worker_instances_row_version_guard/u);

  const providerMigration = baselineMigration("provider");
  assert.match(providerMigration, /pack_ev_recomputation_requests_state_check/u);
  assert.match(providerMigration, /pack_ev_recomputation_requests_claim_idx/u);
  assert.match(providerMigration, /pack_ev_recomputation_requests_state_guard_trigger/u);
  assert.match(providerMigration, /pack_ev_recomputation_requests_pack_id_fkey/u);
  assert.match(providerMigration, /pack_ev_recomputation_requests_trigger_change_fkey/u);
});
