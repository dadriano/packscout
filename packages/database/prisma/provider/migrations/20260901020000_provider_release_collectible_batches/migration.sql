ALTER TABLE "provider_release_batches"
  DROP CONSTRAINT "provider_release_batches_kind_check",
  ADD CONSTRAINT "provider_release_batches_kind_check"
    CHECK ("batch_kind" IN (
      'provider', 'category', 'collectible', 'repack', 'chase',
      'retired-repack', 'search-index'
    ));

CREATE OR REPLACE FUNCTION "packscout_assert_release_batches"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_id uuid;
  expected_count integer;
  actual_count integer;
  provider_batch_count integer;
  category_batch_count integer;
  collectible_batch_count integer;
  repack_batch_count integer;
  chase_batch_count integer;
  retired_repack_batch_count integer;
  search_index_batch_count integer;
  provider_record_count bigint;
  category_record_count bigint;
  collectible_record_count bigint;
  repack_record_count bigint;
  chase_record_count bigint;
  retired_repack_record_count bigint;
  search_index_record_count bigint;
  release_row "provider_releases"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'provider_releases' THEN
    release_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    release_id := OLD."provider_release_id";
  ELSE
    release_id := NEW."provider_release_id";
  END IF;
  SELECT * INTO release_row
  FROM "provider_releases"
  WHERE id = release_id AND "lifecycle" IN ('assembled', 'publishing', 'complete');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  expected_count := release_row."batch_count";
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE "batch_kind" = 'provider')::integer,
    count(*) FILTER (WHERE "batch_kind" = 'category')::integer,
    count(*) FILTER (WHERE "batch_kind" = 'collectible')::integer,
    count(*) FILTER (WHERE "batch_kind" = 'repack')::integer,
    count(*) FILTER (WHERE "batch_kind" = 'chase')::integer,
    count(*) FILTER (WHERE "batch_kind" = 'retired-repack')::integer,
    count(*) FILTER (WHERE "batch_kind" = 'search-index')::integer,
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'provider'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'category'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'collectible'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'repack'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'chase'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'retired-repack'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'search-index'), 0)
  INTO
    actual_count, provider_batch_count, category_batch_count,
    collectible_batch_count, repack_batch_count, chase_batch_count,
    retired_repack_batch_count, search_index_batch_count,
    provider_record_count, category_record_count, collectible_record_count,
    repack_record_count, chase_record_count, retired_repack_record_count,
    search_index_record_count
  FROM "provider_release_batches"
  WHERE "provider_release_id" = release_id;
  IF actual_count <> expected_count
     OR provider_batch_count <> 1
     OR category_batch_count = 0
     OR collectible_batch_count = 0
     OR repack_batch_count = 0
     OR chase_batch_count = 0
     OR retired_repack_batch_count = 0
     OR search_index_batch_count = 0
     OR provider_record_count <> 1
     OR category_record_count <> release_row."category_count"
     OR collectible_record_count <> release_row."collectible_reference_count"
     OR repack_record_count <> release_row."repack_count"
     OR chase_record_count <> release_row."chase_count"
     OR retired_repack_record_count <> release_row."retired_repack_count"
     OR search_index_record_count <> release_row."repack_count"
     OR EXISTS (
    SELECT 1
    FROM (
      SELECT "batch_kind", min("batch_index") AS first_index,
             max("batch_index") AS last_index, count(*) AS item_count
      FROM "provider_release_batches"
      WHERE "provider_release_id" = release_id
      GROUP BY "batch_kind"
    ) AS batch_group
    WHERE batch_group.first_index <> 0
       OR batch_group.last_index <> batch_group.item_count - 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_release_batch_set_incomplete';
  END IF;
  RETURN NULL;
END;
$$;

-- Keep finalize proofs exact as the release record set gains a first-class
-- collectible batch. Positional parameters avoid identifier ambiguity inside
-- the reusable provider schema function.
CREATE OR REPLACE FUNCTION "packscout_has_exact_provider_release_receipt"(
  p_receipt_id uuid,
  p_release_id uuid,
  p_through_change_sequence bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "provider_releases" AS release
    JOIN "provider_publication_operations" AS operation
      ON operation."provider_release_id" = release.id
    JOIN "provider_publication_receipts" AS receipt
      ON receipt."operation_id" = operation.id
     AND receipt."provider_release_id" = release.id
    WHERE release.id = $2
      AND release."through_change_sequence" = $3
      AND operation."operation_kind" = 'finalize'
      AND operation."batch_index" IS NULL
      AND operation."state" = 'accepted'
      AND receipt."outcome" = 'accepted'
      AND receipt."accepted_content_hash" = release."content_hash"
      AND receipt."accepted_record_count" = (
        SELECT COALESCE(sum(batch."record_count"), 0)::integer
        FROM "provider_release_batches" AS batch
        WHERE batch."provider_release_id" = release.id
      )
      AND ($1 IS NULL OR receipt.id = $1)
  );
$$;
