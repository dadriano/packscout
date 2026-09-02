-- Keep complete central catalogs admissible by the retained-array provider
-- bootstrap consumer. The same 100 MiB boundary is enforced again with exact
-- bootstrap framing in application code; JSONB text bytes are a conservative
-- database-side guard that runs before payload hydration.
CREATE OR REPLACE FUNCTION "packscout_validate_catalog_version_batches"(version_value uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  version_row "catalog_versions"%ROWTYPE;
  category_records bigint;
  collectible_records bigint;
  alias_records bigint;
  batch_kind_count bigint;
  catalog_payload_bytes bigint;
BEGIN
  SELECT * INTO version_row FROM "catalog_versions" WHERE id = version_value;
  IF NOT FOUND OR version_row.lifecycle = 'building' OR version_row.lifecycle = 'failed' THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(record_count) FILTER (WHERE batch_kind = 'categories'), 0),
         coalesce(sum(record_count) FILTER (WHERE batch_kind = 'collectibles'), 0),
         coalesce(sum(record_count) FILTER (WHERE batch_kind = 'aliases'), 0),
         count(DISTINCT batch_kind),
         coalesce(sum(octet_length(payload::text)), 0)
  INTO category_records, collectible_records, alias_records, batch_kind_count,
       catalog_payload_bytes
  FROM "catalog_version_batches"
  WHERE catalog_version_id = version_value;
  IF batch_kind_count <> 3
     OR category_records <> version_row.category_count
     OR collectible_records <> version_row.collectible_count
     OR alias_records <> version_row.alias_count THEN
    RAISE EXCEPTION 'catalog batches must include every required kind and match the assembled descriptor counts' USING ERRCODE = '23514';
  END IF;
  IF catalog_payload_bytes > 104857600 THEN
    RAISE EXCEPTION 'catalog batch payloads exceed the provider promotion bootstrap budget' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "catalog_version_batches"
    WHERE catalog_version_id = version_value
    GROUP BY batch_kind
    HAVING min(batch_index) <> 0 OR max(batch_index) + 1 <> count(*)
  ) THEN
    RAISE EXCEPTION 'catalog batch indexes must be contiguous from zero for each kind' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "catalog_version_batches"
    WHERE catalog_version_id = version_value
      AND jsonb_array_length(payload) <> record_count
  ) THEN
    RAISE EXCEPTION 'catalog batch record count must match its stored payload' USING ERRCODE = '23514';
  END IF;
END;
$$;
