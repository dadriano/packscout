BEGIN;

-- This table is intentionally not backfilled from the raw publication
-- transcript. Rollout must drain or restart pre-deploy in-flight releases;
-- a finalize with an older accepted applyBatch and no compact row fails closed.
-- Hold off legacy operation inserts/acceptance until the new deferred trigger
-- exists, so the precheck cannot race an old worker transaction.
LOCK TABLE "provider_publication_operations" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "provider_publication_operations" AS operation
    JOIN "provider_releases" AS release
      ON release.id = operation."provider_release_id"
    WHERE operation."operation_kind" = 'applyBatch'
      AND operation."state" = 'accepted'
      AND release."lifecycle" NOT IN ('complete', 'blocked', 'failed')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'provider_publication_compact_evidence_inflight_release';
  END IF;
END;
$$;

CREATE TABLE "provider_publication_batch_evidence" (
  "operation_id" uuid NOT NULL,
  "provider_release_id" uuid NOT NULL,
  "batch_index" integer NOT NULL,
  "batch_kind" text NOT NULL,
  "batch_hash" character(64) NOT NULL,
  "record_count" integer NOT NULL,
  "byte_count" integer NOT NULL,
  "release_context_hash" character(64) NOT NULL,
  "search_shard_descriptors" jsonb NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_publication_batch_evidence_pkey"
    PRIMARY KEY ("operation_id")
);

CREATE UNIQUE INDEX "provider_publication_batch_evidence_release_index_key"
  ON "provider_publication_batch_evidence"("provider_release_id", "batch_index");

CREATE UNIQUE INDEX "provider_publication_batch_evidence_operation_release_key"
  ON "provider_publication_batch_evidence"("operation_id", "provider_release_id");

ALTER TABLE "provider_publication_batch_evidence"
  ADD CONSTRAINT "provider_publication_batch_evidence_operation_release_fkey"
    FOREIGN KEY ("operation_id", "provider_release_id")
    REFERENCES "provider_publication_operations"("id", "provider_release_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_publication_batch_evidence_release_id_fkey"
    FOREIGN KEY ("provider_release_id")
    REFERENCES "provider_releases"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE FUNCTION "packscout_valid_publication_search_shard_evidence"(
  evidence jsonb,
  batch_kind text,
  record_count integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  descriptor jsonb;
BEGIN
  IF jsonb_typeof(evidence) <> 'array'
     OR jsonb_array_length(evidence) > 100 THEN
    RETURN false;
  END IF;
  IF batch_kind <> 'search_shards' THEN
    RETURN evidence = '[]'::jsonb;
  END IF;
  IF jsonb_array_length(evidence) <> record_count THEN
    RETURN false;
  END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(evidence)
  LOOP
    IF jsonb_typeof(descriptor) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(descriptor)) <> 4
       OR NOT descriptor ?& ARRAY[
         'shardNumber', 'rowCount', 'byteCount', 'contentHash'
       ]
       OR jsonb_typeof(descriptor->'shardNumber') IS DISTINCT FROM 'number'
       OR NOT COALESCE(
         descriptor->>'shardNumber' ~ '^(0|[1-9][0-9]{0,2})$', false
       )
       OR (descriptor->>'shardNumber')::integer NOT BETWEEN 0 AND 249
       OR jsonb_typeof(descriptor->'rowCount') IS DISTINCT FROM 'number'
       OR NOT COALESCE(
         descriptor->>'rowCount' ~ '^[1-9][0-9]{0,1}$', false
       )
       OR (descriptor->>'rowCount')::integer NOT BETWEEN 1 AND 32
       OR jsonb_typeof(descriptor->'byteCount') IS DISTINCT FROM 'number'
       OR NOT COALESCE(
         descriptor->>'byteCount' ~ '^[1-9][0-9]{0,4}$', false
       )
       OR (descriptor->>'byteCount')::integer NOT BETWEEN 1 AND 49152
       OR jsonb_typeof(descriptor->'contentHash') IS DISTINCT FROM 'string'
       OR NOT COALESCE(
         descriptor->>'contentHash' ~ '^[0-9a-f]{64}$', false
       ) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE "provider_publication_batch_evidence"
  ADD CONSTRAINT "provider_publication_batch_evidence_shape_check" CHECK (
    "batch_index" BETWEEN 0 AND 4095
    AND "batch_kind" IN (
      'vendors', 'categories', 'collectibles', 'repacks',
      'repack_chases', 'search_shards'
    )
    AND "batch_hash" ~ '^[0-9a-f]{64}$'
    AND "record_count" BETWEEN 1 AND 100
    AND "byte_count" BETWEEN 1 AND 49152
    AND "release_context_hash" ~ '^[0-9a-f]{64}$'
    AND "packscout_valid_publication_search_shard_evidence"(
      "search_shard_descriptors", "batch_kind", "record_count"
    )
  );

CREATE FUNCTION "packscout_guard_publication_batch_evidence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'provider_publication_batch_evidence_immutable';
END;
$$;

CREATE TRIGGER "provider_publication_batch_evidence_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "provider_publication_batch_evidence"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_publication_batch_evidence"();

CREATE FUNCTION "packscout_assert_publication_batch_evidence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_operation_id uuid;
  proof_matches boolean;
BEGIN
  IF TG_TABLE_NAME = 'provider_publication_batch_evidence' THEN
    target_operation_id := NEW."operation_id";
  ELSE
    target_operation_id := NEW.id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "provider_publication_operations" AS operation
    JOIN "provider_publication_batch_evidence" AS evidence
      ON evidence."operation_id" = operation.id
     AND evidence."provider_release_id" = operation."provider_release_id"
    JOIN "provider_publication_receipts" AS receipt
      ON receipt."operation_id" = operation.id
     AND receipt."provider_release_id" = operation."provider_release_id"
    WHERE operation.id = target_operation_id
      AND operation."operation_kind" = 'applyBatch'
      AND operation."state" = 'accepted'
      AND evidence."batch_index" = operation."batch_index"
      AND evidence."batch_hash" = operation."body_hash"
      AND receipt."outcome" = 'accepted'
      AND receipt."accepted_content_hash" = evidence."batch_hash"
      AND receipt."accepted_record_count" = evidence."record_count"
      AND (
        SELECT COALESCE(sum(candidate."record_count"), 0)
        FROM "provider_publication_batch_evidence" AS candidate
        WHERE candidate."provider_release_id" = operation."provider_release_id"
          AND candidate."batch_kind" = 'search_shards'
      ) <= 250
  ) INTO proof_matches;

  IF NOT proof_matches THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'provider_publication_batch_evidence_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_publication_batch_evidence_operation_match_trigger"
  AFTER INSERT ON "provider_publication_batch_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_publication_batch_evidence"();

CREATE CONSTRAINT TRIGGER "provider_publication_operations_batch_evidence_trigger"
  AFTER INSERT OR UPDATE ON "provider_publication_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."operation_kind" = 'applyBatch' AND NEW."state" = 'accepted')
  EXECUTE FUNCTION "packscout_assert_publication_batch_evidence"();

COMMIT;
