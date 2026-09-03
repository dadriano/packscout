-- Preserve provider-authored facts even when their catalog subjects arrive later.
-- Existing facts are upgraded in place: source keys are derived from their
-- already-valid local foreign keys, while fact versions remain at version 1.
BEGIN;

-- This fact-shape change is safe only before either downstream consumer has
-- observed the predecessor shape. Freeze the publication boundary while the
-- precondition is checked so a consumer or release cannot advance between the
-- check and the fact-table locks below. Canonical rows and unconsumed
-- promotion_changes may already exist; promotion_ledger is intentionally not
-- required to remain at zero.
LOCK TABLE "provider_change_consumers", "provider_publication_state",
  "provider_releases" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "provider_change_consumers"
    WHERE "last_confirmed_sequence" <> 0
       OR "confirmation_kind" IS NOT NULL
       OR "confirmation_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'provider_fact_deferred_relationships_consumer_checkpoint_advanced';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "provider_publication_state"
    WHERE "completed_through_change_sequence" <> 0
       OR "completed_release_id" IS NOT NULL
       OR "completion_receipt_id" IS NOT NULL
       OR "completed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'provider_fact_deferred_relationships_publication_checkpoint_advanced';
  END IF;

  IF EXISTS (SELECT 1 FROM "provider_releases") THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'provider_fact_deferred_relationships_release_exists';
  END IF;
END;
$$;

-- Keep the backfill isolated from provider writes. These locks are held only
-- for this migration transaction and avoid a dual-shape write window.
LOCK TABLE "packs", "collectibles", "pulls", "pull_items", "market_events",
  "provider_run_pages", "quarantine_records" IN ACCESS EXCLUSIVE MODE;

-- The earliest provider baseline required a head page to clear next_cursor.
-- DataForrest may retain a source-issued checkpoint at head, and one review
-- database received this relaxed check before the additive migration existed.
-- Normalize both predecessor shapes here without rewriting applied history.
ALTER TABLE "provider_run_pages"
  DROP CONSTRAINT IF EXISTS "provider_run_pages_continuation_check";
ALTER TABLE "provider_run_pages"
  ADD CONSTRAINT "provider_run_pages_continuation_check" CHECK (
    "continuation" = 'head'
    OR ("continuation" = 'more' AND "next_cursor" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "provider_run_pages"
  VALIDATE CONSTRAINT "provider_run_pages_continuation_check";

-- The original fact tables are append-only. Remove only their guards before
-- the controlled source-key backfill; the replacement guards are installed
-- below before the transaction becomes visible.
DROP TRIGGER "pulls_append_only_trigger" ON "pulls";
DROP TRIGGER "pull_items_append_only_trigger" ON "pull_items";
DROP TRIGGER "market_events_append_only_trigger" ON "market_events";

ALTER TABLE "pulls"
  ADD COLUMN "pack_key" TEXT,
  ADD COLUMN "item_count" INTEGER,
  ADD COLUMN "row_version" BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6);

ALTER TABLE "pull_items"
  ADD COLUMN "collectible_key" TEXT,
  ADD COLUMN "row_version" BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6);

ALTER TABLE "market_events"
  ADD COLUMN "pack_key" TEXT,
  ADD COLUMN "collectible_key" TEXT,
  ADD COLUMN "row_version" BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6);

UPDATE "pulls" AS pull
SET "pack_key" = pack."pack_key",
    "item_count" = (
      SELECT count(*)::integer
      FROM "pull_items" AS item
      WHERE item."pull_id" = pull.id
    ),
    "updated_at" = pull."created_at"
FROM "packs" AS pack
WHERE pack.id = pull."pack_id";

UPDATE "pull_items" AS item
SET "collectible_key" = collectible."collectible_key",
    "updated_at" = item."created_at"
FROM "collectibles" AS collectible
WHERE collectible.id = item."collectible_id";

UPDATE "market_events" AS event
SET "pack_key" = pack."pack_key"
FROM "packs" AS pack
WHERE pack.id = event."pack_id";

UPDATE "market_events" AS event
SET "collectible_key" = collectible."collectible_key"
FROM "collectibles" AS collectible
WHERE collectible.id = event."collectible_id";

UPDATE "market_events"
SET "updated_at" = "created_at";

-- Source/adapter rejections have no retryable canonical candidate. Normalize
-- any review-era keyed rows to the terminal evidence-free shape before the
-- idempotency key becomes unique. This is a controlled history migration, so
-- the ordinary transition/version guards are removed only around this update.
DROP TRIGGER "quarantine_records_guard_trigger" ON "quarantine_records";
DROP TRIGGER "quarantine_records_row_version_trigger" ON "quarantine_records";

UPDATE "quarantine_records"
SET "state" = 'expired',
    "resolved_at" = NULL,
    "evidence_expires_at" = greatest("evidence_expires_at", "created_at"),
    "evidence_expired_at" = greatest(
      coalesce("evidence_expired_at", clock_timestamp()),
      "created_at"
    ),
    "normalized_candidate" = NULL,
    "protected_evidence" = NULL,
    "row_version" = "row_version" + 1,
    "updated_at" = clock_timestamp()
WHERE "source_record_key" IS NOT NULL
  AND (
    "state" <> 'expired'
    OR "resolved_at" IS NOT NULL
    OR "evidence_expired_at" IS NULL
    OR "normalized_candidate" IS NOT NULL
    OR "protected_evidence" IS NOT NULL
  );

CREATE TRIGGER "quarantine_records_row_version_trigger"
  BEFORE UPDATE ON "quarantine_records"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "quarantine_records_guard_trigger"
  BEFORE UPDATE OR DELETE ON "quarantine_records"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_quarantine_record"();

-- Fail before replacing constraints if the old foreign-key guarantees did not
-- produce a complete source-key backfill.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pulls"
    WHERE ("pack_id" IS NOT NULL AND "pack_key" IS NULL)
       OR "item_count" IS NULL
       OR "item_count" <= 0
  ) OR EXISTS (
    SELECT 1 FROM "pull_items"
    WHERE "collectible_id" IS NOT NULL AND "collectible_key" IS NULL
  ) OR EXISTS (
    SELECT 1 FROM "market_events"
    WHERE ("pack_id" IS NOT NULL AND "pack_key" IS NULL)
       OR ("collectible_id" IS NOT NULL AND "collectible_key" IS NULL)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'provider_fact_source_key_backfill_incomplete';
  END IF;
END;
$$;

ALTER TABLE "pulls"
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updated_at" SET NOT NULL,
  ALTER COLUMN "item_count" SET NOT NULL,
  ALTER COLUMN "pack_id" DROP NOT NULL;

ALTER TABLE "pull_items"
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updated_at" SET NOT NULL,
  ALTER COLUMN "collectible_id" DROP NOT NULL;

ALTER TABLE "market_events"
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updated_at" SET NOT NULL;

CREATE UNIQUE INDEX "packs_id_pack_key_key" ON "packs"("id", "pack_key");
CREATE UNIQUE INDEX "collectibles_id_collectible_key_key"
  ON "collectibles"("id", "collectible_key");

CREATE INDEX "pulls_unresolved_pack_key_idx" ON "pulls"("pack_key", "id")
  WHERE "pack_key" IS NOT NULL AND "pack_id" IS NULL;
CREATE INDEX "pull_items_unresolved_collectible_key_idx"
  ON "pull_items"("collectible_key", "id")
  WHERE "collectible_key" IS NOT NULL AND "collectible_id" IS NULL;
CREATE INDEX "market_events_unresolved_pack_key_idx"
  ON "market_events"("pack_key", "id")
  WHERE "pack_key" IS NOT NULL AND "pack_id" IS NULL;
CREATE INDEX "market_events_unresolved_collectible_key_idx"
  ON "market_events"("collectible_key", "id")
  WHERE "collectible_key" IS NOT NULL AND "collectible_id" IS NULL;

-- A source-reported malformed record is quarantined once even if the same
-- provider response is delivered again. Null preserves historical rows that
-- predate a safe source key and remains repeatable under PostgreSQL uniqueness.
CREATE UNIQUE INDEX "quarantine_records_source_record_key_key"
  ON "quarantine_records"("source_record_key");

ALTER TABLE "pulls" DROP CONSTRAINT "pulls_pack_id_fkey";
ALTER TABLE "pull_items" DROP CONSTRAINT "pull_items_collectible_id_fkey";
ALTER TABLE "market_events" DROP CONSTRAINT "market_events_pack_id_fkey";
ALTER TABLE "market_events" DROP CONSTRAINT "market_events_collectible_id_fkey";

ALTER TABLE "pulls"
  ADD CONSTRAINT "pulls_pack_id_key_fkey"
    FOREIGN KEY ("pack_id", "pack_key")
    REFERENCES "packs"("id", "pack_key") MATCH SIMPLE
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "pull_items"
  ADD CONSTRAINT "pull_items_collectible_id_key_fkey"
    FOREIGN KEY ("collectible_id", "collectible_key")
    REFERENCES "collectibles"("id", "collectible_key") MATCH SIMPLE
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "market_events"
  ADD CONSTRAINT "market_events_pack_id_key_fkey"
    FOREIGN KEY ("pack_id", "pack_key")
    REFERENCES "packs"("id", "pack_key") MATCH SIMPLE
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID,
  ADD CONSTRAINT "market_events_collectible_id_key_fkey"
    FOREIGN KEY ("collectible_id", "collectible_key")
    REFERENCES "collectibles"("id", "collectible_key") MATCH SIMPLE
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "pulls"
  VALIDATE CONSTRAINT "pulls_pack_id_key_fkey";
ALTER TABLE "pull_items"
  VALIDATE CONSTRAINT "pull_items_collectible_id_key_fkey";
ALTER TABLE "market_events"
  VALIDATE CONSTRAINT "market_events_pack_id_key_fkey";
ALTER TABLE "market_events"
  VALIDATE CONSTRAINT "market_events_collectible_id_key_fkey";

ALTER TABLE "pulls"
  ADD CONSTRAINT "pulls_pack_key_check"
    CHECK ("pack_key" IS NULL OR length(btrim("pack_key")) > 0) NOT VALID,
  ADD CONSTRAINT "pulls_pack_resolution_check"
    CHECK ("pack_id" IS NULL OR "pack_key" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "pulls_item_count_check"
    CHECK ("item_count" > 0) NOT VALID,
  ADD CONSTRAINT "pulls_row_version_check"
    CHECK ("row_version" > 0) NOT VALID;

ALTER TABLE "pull_items"
  ADD CONSTRAINT "pull_items_collectible_key_check"
    CHECK ("collectible_key" IS NULL OR length(btrim("collectible_key")) > 0) NOT VALID,
  ADD CONSTRAINT "pull_items_collectible_resolution_check"
    CHECK ("collectible_id" IS NULL OR "collectible_key" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "pull_items_row_version_check"
    CHECK ("row_version" > 0) NOT VALID;

-- Some review databases received this safety check before the additive
-- migration was split from the baseline. Accept either predecessor shape.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'pull_items'::regclass
      AND conname = 'pull_items_instance_collectible_check'
  ) THEN
    ALTER TABLE "pull_items"
      ADD CONSTRAINT "pull_items_instance_collectible_check"
        CHECK ("collectible_instance_id" IS NULL OR "collectible_id" IS NOT NULL) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE "market_events"
  DROP CONSTRAINT "market_events_subject_check",
  ADD CONSTRAINT "market_events_pack_key_check"
    CHECK ("pack_key" IS NULL OR length(btrim("pack_key")) > 0) NOT VALID,
  ADD CONSTRAINT "market_events_collectible_key_check"
    CHECK ("collectible_key" IS NULL OR length(btrim("collectible_key")) > 0) NOT VALID,
  ADD CONSTRAINT "market_events_pack_resolution_check"
    CHECK ("pack_id" IS NULL OR "pack_key" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "market_events_collectible_resolution_check"
    CHECK ("collectible_id" IS NULL OR "collectible_key" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "market_events_subject_check"
    CHECK ("pack_key" IS NOT NULL OR "collectible_key" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "market_events_row_version_check"
    CHECK ("row_version" > 0) NOT VALID;

ALTER TABLE "pulls"
  VALIDATE CONSTRAINT "pulls_pack_key_check",
  VALIDATE CONSTRAINT "pulls_pack_resolution_check",
  VALIDATE CONSTRAINT "pulls_item_count_check",
  VALIDATE CONSTRAINT "pulls_row_version_check";
ALTER TABLE "pull_items"
  VALIDATE CONSTRAINT "pull_items_collectible_key_check",
  VALIDATE CONSTRAINT "pull_items_collectible_resolution_check",
  VALIDATE CONSTRAINT "pull_items_instance_collectible_check",
  VALIDATE CONSTRAINT "pull_items_row_version_check";
ALTER TABLE "market_events"
  VALIDATE CONSTRAINT "market_events_pack_key_check",
  VALIDATE CONSTRAINT "market_events_collectible_key_check",
  VALIDATE CONSTRAINT "market_events_pack_resolution_check",
  VALIDATE CONSTRAINT "market_events_collectible_resolution_check",
  VALIDATE CONSTRAINT "market_events_subject_check",
  VALIDATE CONSTRAINT "market_events_row_version_check";

CREATE TRIGGER "pulls_row_version_trigger" BEFORE UPDATE ON "pulls"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "pull_items_row_version_trigger" BEFORE UPDATE ON "pull_items"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "market_events_row_version_trigger" BEFORE UPDATE ON "market_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();

-- Canonical correlation keys are durable identities, not mutable labels.
-- Keeping them stable prevents an update from stranding unresolved facts that
-- are waiting to correlate by provider key.
CREATE OR REPLACE FUNCTION "packscout_guard_mutable_entity_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stable_key_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_NAME || '_delete_forbidden';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_NAME || '_id_immutable';
  END IF;

  stable_key_column := CASE TG_TABLE_NAME
    WHEN 'categories' THEN 'category_key'
    WHEN 'packs' THEN 'pack_key'
    WHEN 'collectibles' THEN 'collectible_key'
    WHEN 'collectible_instances' THEN 'instance_key'
    WHEN 'provider_accounts' THEN 'account_key'
    ELSE NULL
  END;
  IF stable_key_column IS NOT NULL
     AND to_jsonb(NEW)->stable_key_column
           IS DISTINCT FROM to_jsonb(OLD)->stable_key_column THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = TG_TABLE_NAME || '_stable_key_immutable';
  END IF;

  IF OLD."lifecycle" = 'retired'
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_NAME || '_retired_immutable';
  END IF;
  IF NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle"
     AND NOT (OLD."lifecycle" = 'active' AND NEW."lifecycle" = 'retired') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = TG_TABLE_NAME || '_lifecycle_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

-- Facts retain source-authored content. Resolution may fill a missing local
-- UUID once, but it cannot change or remove either the source key or a UUID.
CREATE FUNCTION "packscout_guard_resolvable_fact"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_document jsonb;
  new_document jsonb;
  relationship_enriched boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = TG_TABLE_NAME || '_source_fact_immutable';
  END IF;

  old_document := to_jsonb(OLD);
  new_document := to_jsonb(NEW);

  CASE TG_TABLE_NAME
    WHEN 'pulls' THEN
      IF (new_document - 'pack_id' - 'row_version' - 'updated_at')
           IS DISTINCT FROM
         (old_document - 'pack_id' - 'row_version' - 'updated_at') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'pulls_source_fact_immutable';
      END IF;
      relationship_enriched := old_document->>'pack_id' IS NULL
        AND new_document->>'pack_id' IS NOT NULL;
      IF old_document->>'pack_id' IS NOT NULL
           AND new_document->>'pack_id' IS DISTINCT FROM old_document->>'pack_id' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'pulls_relationship_resolution_not_monotonic';
      END IF;

    WHEN 'pull_items' THEN
      IF (new_document - 'collectible_id' - 'row_version' - 'updated_at')
           IS DISTINCT FROM
         (old_document - 'collectible_id' - 'row_version' - 'updated_at') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'pull_items_source_fact_immutable';
      END IF;
      relationship_enriched := old_document->>'collectible_id' IS NULL
        AND new_document->>'collectible_id' IS NOT NULL;
      IF old_document->>'collectible_id' IS NOT NULL
           AND new_document->>'collectible_id' IS DISTINCT FROM old_document->>'collectible_id' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'pull_items_relationship_resolution_not_monotonic';
      END IF;

    WHEN 'market_events' THEN
      IF (new_document - 'pack_id' - 'collectible_id' - 'row_version' - 'updated_at')
           IS DISTINCT FROM
         (old_document - 'pack_id' - 'collectible_id' - 'row_version' - 'updated_at') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'market_events_source_fact_immutable';
      END IF;
      IF (old_document->>'pack_id' IS NOT NULL
            AND new_document->>'pack_id' IS DISTINCT FROM old_document->>'pack_id')
         OR (old_document->>'collectible_id' IS NOT NULL
            AND new_document->>'collectible_id' IS DISTINCT FROM old_document->>'collectible_id') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'market_events_relationship_resolution_not_monotonic';
      END IF;
      relationship_enriched := (
          old_document->>'pack_id' IS NULL
          AND new_document->>'pack_id' IS NOT NULL
        ) OR (
          old_document->>'collectible_id' IS NULL
          AND new_document->>'collectible_id' IS NOT NULL
        );

    ELSE
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'resolvable_fact_table_not_contracted';
  END CASE;

  IF NOT relationship_enriched THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = TG_TABLE_NAME || '_relationship_resolution_not_monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pulls_resolvable_fact_guard_trigger" BEFORE UPDATE OR DELETE ON "pulls"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_resolvable_fact"();
CREATE TRIGGER "pull_items_resolvable_fact_guard_trigger" BEFORE UPDATE OR DELETE ON "pull_items"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_resolvable_fact"();
CREATE TRIGGER "market_events_resolvable_fact_guard_trigger" BEFORE UPDATE OR DELETE ON "market_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_resolvable_fact"();

-- The immutable expected count seals a pull's item set without depending on
-- transaction IDs, so initial createMany works inside repository savepoints.
-- Both parent and child inserts recheck the final count at commit; a later
-- append therefore cannot change a completed pull.
CREATE OR REPLACE FUNCTION "packscout_assert_pull_has_item"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_pull_id uuid;
  expected_item_count integer;
  actual_item_count bigint;
  source_pack_key text;
BEGIN
  target_pull_id := CASE
    WHEN TG_TABLE_NAME = 'pulls' THEN (to_jsonb(NEW)->>'id')::uuid
    ELSE (to_jsonb(NEW)->>'pull_id')::uuid
  END;

  SELECT pull."item_count", pull."pack_key"
    INTO expected_item_count, source_pack_key
  FROM "pulls" AS pull
  WHERE pull.id = target_pull_id;

  SELECT count(*) INTO actual_item_count
  FROM "pull_items"
  WHERE "pull_id" = target_pull_id;

  IF actual_item_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'pull_requires_item';
  END IF;
  IF expected_item_count IS NULL OR actual_item_count <> expected_item_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'pull_item_count_mismatch';
  END IF;
  IF source_pack_key IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "pull_items"
       WHERE "pull_id" = target_pull_id AND "collectible_key" IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'pull_requires_source_relationship';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "pull_items_exact_count_trigger"
  AFTER INSERT ON "pull_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_pull_has_item"();

CREATE OR REPLACE FUNCTION "packscout_assert_fact_entity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  change_entity_type text;
BEGIN
  change_entity_type := CASE TG_TABLE_NAME
    WHEN 'pulls' THEN 'pull'
    WHEN 'pull_items' THEN 'pull_item'
    WHEN 'market_events' THEN 'market_event'
    ELSE NULL
  END;
  IF change_entity_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'promotion_fact_table_not_contracted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."row_version" <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_fact_initial_version_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "promotion_changes" AS change
    WHERE change."entity_type" = change_entity_type
      AND change."entity_id" = NEW.id
      AND change."entity_version" = NEW."row_version"
      AND change."operation" = 'upsert'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fact_write_requires_promotion_change';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "packscout_assert_promotion_change_entity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_found boolean := false;
  current_version bigint := 1;
  current_lifecycle "entity_lifecycle";
  mutable_entity boolean := true;
BEGIN
  CASE NEW."entity_type"
    WHEN 'category' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "categories" WHERE id = NEW."entity_id";
    WHEN 'pack' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "packs" WHERE id = NEW."entity_id";
    WHEN 'collectible' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "collectibles" WHERE id = NEW."entity_id";
    WHEN 'collectible_name_alias' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "collectible_name_aliases" WHERE id = NEW."entity_id";
    WHEN 'collectible_instance' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "collectible_instances" WHERE id = NEW."entity_id";
    WHEN 'pack_content' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "pack_contents" WHERE id = NEW."entity_id";
    WHEN 'provider_account' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "provider_accounts" WHERE id = NEW."entity_id";
    WHEN 'pull' THEN
      mutable_entity := false;
      SELECT true, "row_version" INTO entity_found, current_version FROM "pulls" WHERE id = NEW."entity_id";
    WHEN 'pull_item' THEN
      mutable_entity := false;
      SELECT true, "row_version" INTO entity_found, current_version FROM "pull_items" WHERE id = NEW."entity_id";
    WHEN 'market_event' THEN
      mutable_entity := false;
      SELECT true, "row_version" INTO entity_found, current_version FROM "market_events" WHERE id = NEW."entity_id";
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_change_entity_type_invalid';
  END CASE;

  IF entity_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'promotion_change_entity_missing';
  END IF;
  IF NOT mutable_entity THEN
    IF NEW."operation" <> 'upsert'
       OR NEW."entity_version" > current_version
       OR (NEW."entity_version" > 1 AND NOT EXISTS (
         SELECT 1 FROM "promotion_changes" AS prior
         WHERE prior."entity_type" = NEW."entity_type"
           AND prior."entity_id" = NEW."entity_id"
           AND prior."entity_version" = NEW."entity_version" - 1
       )) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_fact_change_invalid';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."entity_version" > current_version
     OR (NEW."operation" = 'retire' AND (
       current_lifecycle <> 'retired' OR NEW."entity_version" <> current_version
     ))
     OR (NEW."operation" = 'upsert'
         AND current_lifecycle = 'retired'
         AND NEW."entity_version" = current_version)
     OR (NEW."entity_version" > 1 AND NOT EXISTS (
       SELECT 1 FROM "promotion_changes" AS prior
       WHERE prior."entity_type" = NEW."entity_type"
         AND prior."entity_id" = NEW."entity_id"
         AND prior."entity_version" = NEW."entity_version" - 1
     )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_change_entity_version_invalid';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER "pulls_promotion_change_trigger" ON "pulls";
DROP TRIGGER "pull_items_promotion_change_trigger" ON "pull_items";
DROP TRIGGER "market_events_promotion_change_trigger" ON "market_events";

CREATE CONSTRAINT TRIGGER "pulls_promotion_change_trigger" AFTER INSERT OR UPDATE ON "pulls"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_fact_entity_change"();
CREATE CONSTRAINT TRIGGER "pull_items_promotion_change_trigger" AFTER INSERT OR UPDATE ON "pull_items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_fact_entity_change"();
CREATE CONSTRAINT TRIGGER "market_events_promotion_change_trigger" AFTER INSERT OR UPDATE ON "market_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_fact_entity_change"();

COMMIT;
