BEGIN;

-- Refuse an ambiguous existing current projection; never silently delete duplicates.
CREATE UNIQUE INDEX "pack_contents_active_identity_key"
  ON "pack_contents" ("pack_id", "collectible_id", "collectible_instance_id")
  NULLS NOT DISTINCT WHERE "lifecycle" = 'active';

CREATE TABLE "pack_content_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pack_id" uuid NOT NULL REFERENCES "packs"("id") ON DELETE RESTRICT,
  "source_key" text NOT NULL,
  "effective_at" timestamptz(6) NOT NULL,
  "effective_at_basis" text NOT NULL CHECK ("effective_at_basis" IN ('provider_updated_at', 'response_observed_at')),
  "collected_at" timestamptz(6) NOT NULL,
  "snapshot_digest" char(64) NOT NULL,
  "completeness" text NOT NULL,
  "normalized_snapshot" jsonb NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pack_content_snapshots_pack_effective_key" UNIQUE ("pack_id", "effective_at"),
  CONSTRAINT "pack_content_snapshots_id_pack_key" UNIQUE ("id", "pack_id"),
  CONSTRAINT "pack_content_snapshots_time_check" CHECK ("collected_at" >= "effective_at"),
  CONSTRAINT "pack_content_snapshots_digest_check" CHECK ("snapshot_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pack_content_snapshots_completeness_check" CHECK ("completeness" IN ('complete', 'partial')),
  CONSTRAINT "pack_content_snapshots_identity_check" CHECK (
    length("source_key") BETWEEN 1 AND 256
  ),
  CONSTRAINT "pack_content_snapshots_version_identity_check" CHECK (coalesce(
    jsonb_typeof("normalized_snapshot"->'sourceAdapterVersion') = 'string'
    AND length("normalized_snapshot"->>'sourceAdapterVersion') BETWEEN 1 AND 256
    AND jsonb_typeof("normalized_snapshot"->'mapperVersion') = 'string'
    AND length("normalized_snapshot"->>'mapperVersion') BETWEEN 1 AND 256,
    false
  )),
  CONSTRAINT "pack_content_snapshots_payload_check" CHECK (
    jsonb_typeof("normalized_snapshot") = 'object'
    AND jsonb_typeof("normalized_snapshot"->'items') = 'array'
    AND jsonb_array_length("normalized_snapshot"->'items') <= 1000
    AND octet_length("normalized_snapshot"::text) <= 262144
  )
);
ALTER TABLE "pack_contents" ADD COLUMN "source_snapshot_id" uuid;
ALTER TABLE "pack_contents" ADD CONSTRAINT "pack_contents_source_snapshot_pack_fkey"
  FOREIGN KEY ("source_snapshot_id", "pack_id") REFERENCES "pack_content_snapshots" ("id", "pack_id") ON DELETE RESTRICT;
CREATE INDEX "pack_content_snapshots_latest_idx" ON "pack_content_snapshots" ("pack_id", "effective_at" DESC);
CREATE TRIGGER "pack_content_snapshots_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "pack_content_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();

ALTER TABLE "promotion_changes" DROP CONSTRAINT "promotion_changes_entity_type_check";
ALTER TABLE "promotion_changes" ADD CONSTRAINT "promotion_changes_entity_type_check" CHECK ("entity_type" IN (
  'category', 'pack', 'collectible', 'collectible_name_alias', 'collectible_instance',
  'pack_content', 'pack_content_snapshot', 'provider_account', 'pull', 'pull_item', 'market_event'
));

CREATE FUNCTION "packscout_assert_pack_content_snapshot_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "promotion_changes" WHERE "entity_type" = 'pack_content_snapshot'
      AND "entity_id" = NEW.id AND "entity_version" = 1 AND "operation" = 'upsert'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'snapshot_write_requires_promotion_change';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "pack_content_snapshots_promotion_change_trigger"
  AFTER INSERT ON "pack_content_snapshots" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_pack_content_snapshot_change"();

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
    WHEN 'pack_content_snapshot' THEN
      mutable_entity := false;
      SELECT true INTO entity_found FROM "pack_content_snapshots" WHERE id = NEW."entity_id";
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

COMMIT;
