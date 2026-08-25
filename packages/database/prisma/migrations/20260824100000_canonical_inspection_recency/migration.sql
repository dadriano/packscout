-- Canonical inspection: per-provider, per-kind recency.
--
-- The admin's Data section reports, for one provider, how fresh each canonical
-- record kind is. Answering that from `canonical_entities` meant ordering a
-- (organization, platform, kind) bucket by time, and the only index covering
-- that bucket is the stable-identity unique index, which orders by external id.
-- On a provider holding millions of records that turns a header card into a
-- sequential scan.
--
-- This index makes "oldest" and "newest" two index lookups instead. The tenant,
-- platform, and kind are equality-matched leading columns and `updated_at` is
-- stored descending, so a scan in either direction is bounded by the first row
-- it reads.
--
-- Built in-transaction like every other migration here. On a production table
-- of this size the index should be created out of band with
-- `CREATE INDEX CONCURRENTLY` before this migration is deployed; the
-- `IF NOT EXISTS` clause then makes this step a no-op rather than a second
-- build that holds a write lock against the ingestion path.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE INDEX IF NOT EXISTS canonical_entities_inspection_recency_idx
  ON public.canonical_entities (
    organization_id,
    platform_key,
    record_kind,
    updated_at DESC
  );
