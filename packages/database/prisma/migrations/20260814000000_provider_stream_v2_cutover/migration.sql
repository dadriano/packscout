-- Clean V2 cutover: provider terminology, archive imports, and durable source semantics.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.source_records LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'provider_stream_v2_cutover_requires_empty_source_records';
  END IF;
END
$$;

ALTER TYPE public.source_record_kind RENAME VALUE 'sale' TO 'trade';
ALTER TYPE public.canonical_record_kind RENAME VALUE 'sale' TO 'trade';
CREATE TYPE public.provider_source_mode AS ENUM ('http', 'archive');

ALTER TABLE public.provider_config_revisions
  ADD COLUMN source_mode public.provider_source_mode NOT NULL DEFAULT 'http',
  ADD COLUMN mapping_adapter_key text,
  ADD COLUMN actor_pseudonym_key_fingerprint character(64),
  ADD COLUMN archive_importer_build_sha character(40);

ALTER TABLE public.provider_config_revisions
  ADD CONSTRAINT provider_config_revisions_archive_mode_honest CHECK (
    (
      source_mode = 'http'::public.provider_source_mode
      AND mapping_adapter_key IS NULL
      AND actor_pseudonym_key_fingerprint IS NULL
      AND archive_importer_build_sha IS NULL
    )
    OR (
      source_mode = 'archive'::public.provider_source_mode
      AND endpoint_url ~ '^archive://sha256/[0-9a-f]{64}$'
      AND mapping_adapter_key ~ '^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$'
      AND actor_pseudonym_key_fingerprint ~ '^[0-9a-f]{64}$'
      AND archive_importer_build_sha ~ '^[0-9a-f]{40}$'
      AND auth_mode = 'none'::public.provider_auth_mode
      AND tested_at IS NULL
      AND tested_by_actor_key IS NULL
    )
  );

CREATE UNIQUE INDEX provider_config_revisions_archive_locator_unique
  ON public.provider_config_revisions (organization_id, provider_id, endpoint_url)
  WHERE source_mode = 'archive'::public.provider_source_mode;

ALTER TABLE public.import_runs
  ADD COLUMN archive_sha256 text;

ALTER TABLE public.import_runs
  DROP CONSTRAINT import_runs_manual_actor_required;

ALTER TABLE public.import_runs
  ADD CONSTRAINT import_runs_operator_actor_required CHECK (
    trigger NOT IN ('manual'::public.import_trigger, 'archive'::public.import_trigger)
    OR requested_by_actor_key IS NOT NULL
  ),
  ADD CONSTRAINT import_runs_archive_sha256_format CHECK (
    archive_sha256 IS NULL OR archive_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT import_runs_archive_trigger_consistent CHECK (
    (trigger = 'archive'::public.import_trigger) = (archive_sha256 IS NOT NULL)
  );

CREATE INDEX import_runs_archive_lookup_idx
  ON public.import_runs (organization_id, provider_id, archive_sha256);

CREATE UNIQUE INDEX import_runs_archive_identity_unique
  ON public.import_runs (organization_id, provider_id, archive_sha256)
  WHERE archive_sha256 IS NOT NULL;

ALTER TABLE public.source_records
  ADD COLUMN record_identity_hash text NOT NULL,
  ADD COLUMN source_facts_hash text NOT NULL;

DROP INDEX public.source_records_immutable_identity_unique;

CREATE UNIQUE INDEX source_records_source_facts_unique
  ON public.source_records (
    organization_id,
    provider_id,
    record_kind,
    external_id,
    source_facts_hash
  );

CREATE INDEX source_records_stable_identity_idx
  ON public.source_records (
    organization_id,
    provider_id,
    record_kind,
    external_id,
    record_identity_hash
  );

CREATE UNIQUE INDEX source_records_immutable_event_identity_unique
  ON public.source_records (organization_id, provider_id, record_kind, external_id)
  WHERE record_kind IN (
    'pull'::public.source_record_kind,
    'trade'::public.source_record_kind
  );

ALTER TABLE public.source_record_observations
  ADD COLUMN source_collected_at timestamp with time zone NOT NULL;
