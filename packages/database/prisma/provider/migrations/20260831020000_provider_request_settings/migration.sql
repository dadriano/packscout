-- Metadata-only additive cutover. No historical run/page/canonical row is rewritten.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE "provider_request_settings_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "revision_number" bigint NOT NULL UNIQUE CHECK ("revision_number" > 0),
  "records_per_request" integer NOT NULL CHECK ("records_per_request" BETWEEN 1 AND 5000),
  "origin" text NOT NULL CHECK ("origin" IN ('operator', 'adapter_default')),
  "config_version_id" uuid NOT NULL,
  "config_version_number" bigint NOT NULL CHECK ("config_version_number" > 0),
  "adapter_key" text NOT NULL CHECK ("adapter_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  "created_by_operator_id" uuid,
  "created_at" timestamptz(6) NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "provider_request_settings_revision_actor_check"
    CHECK ("origin" <> 'operator' OR "created_by_operator_id" IS NOT NULL),
  CONSTRAINT "provider_request_settings_revision_pin_key" UNIQUE ("id", "records_per_request")
);
CREATE TABLE "provider_request_settings" (
  "singleton_key" boolean PRIMARY KEY DEFAULT true CHECK ("singleton_key"),
  "active_revision_id" uuid NOT NULL UNIQUE REFERENCES "provider_request_settings_revisions"("id") ON DELETE RESTRICT
);
CREATE TRIGGER "provider_request_settings_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "provider_request_settings_revisions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();

ALTER TABLE "provider_runs"
  ADD COLUMN "records_per_request" integer,
  ADD COLUMN "request_settings_revision_id" uuid,
  ADD COLUMN "request_settings_parent_run_id" uuid,
  ADD CONSTRAINT "provider_runs_request_settings_parent_fkey"
    FOREIGN KEY ("request_settings_parent_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "provider_runs_request_settings_pair_check" CHECK (
    ("records_per_request" IS NULL AND "request_settings_revision_id" IS NULL)
    OR ("records_per_request" IS NOT NULL AND "records_per_request" BETWEEN 1 AND 5000 AND "request_settings_revision_id" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "provider_runs_request_settings_revision_fkey"
    FOREIGN KEY ("request_settings_revision_id", "records_per_request")
    REFERENCES "provider_request_settings_revisions"("id", "records_per_request")
    ON DELETE RESTRICT NOT VALID;

CREATE FUNCTION "packscout_guard_request_settings_pointer"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_number bigint; prior_number bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_request_settings_cannot_be_removed';
  END IF;
  SELECT revision_number INTO next_number FROM provider_request_settings_revisions WHERE id = NEW.active_revision_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT revision_number INTO prior_number FROM provider_request_settings_revisions WHERE id = OLD.active_revision_id;
  ELSE prior_number := 0;
  END IF;
  IF next_number IS DISTINCT FROM prior_number + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_request_settings_revision_sequence_invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "provider_request_settings_pointer_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "provider_request_settings"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_request_settings_pointer"();

CREATE FUNCTION "packscout_guard_run_request_settings"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parent_revision uuid; parent_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.records_per_request, NEW.request_settings_revision_id, NEW.request_settings_parent_run_id)
       IS DISTINCT FROM ROW(OLD.records_per_request, OLD.request_settings_revision_id, OLD.request_settings_parent_run_id) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_run_request_settings_immutable';
    END IF;
  ELSE
    -- Frozen old workers may continue on providers not yet cut over. Once
    -- initialized, every newly inserted run must carry an explicit durable pin.
    IF NEW.request_settings_revision_id IS NULL AND EXISTS (SELECT 1 FROM public.provider_request_settings) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_request_settings_required';
    END IF;
    IF NEW.request_settings_revision_id IS NOT NULL
       AND NEW.request_settings_parent_run_id IS NULL AND NEW.recovery_of_run_id IS NULL
       AND NEW.request_settings_revision_id IS DISTINCT FROM (SELECT active_revision_id FROM public.provider_request_settings) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_request_settings_not_current';
    END IF;
    IF NEW.request_settings_parent_run_id IS NOT NULL AND NEW.recovery_of_run_id IS NOT NULL
       AND NEW.request_settings_parent_run_id <> NEW.recovery_of_run_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_recovery_request_parent_mismatch';
    END IF;
    IF COALESCE(NEW.request_settings_parent_run_id, NEW.recovery_of_run_id) IS NOT NULL THEN
      SELECT request_settings_revision_id, records_per_request INTO parent_revision, parent_count
      FROM public.provider_runs WHERE id = COALESCE(NEW.request_settings_parent_run_id, NEW.recovery_of_run_id);
      IF ROW(NEW.request_settings_revision_id, NEW.records_per_request)
         IS DISTINCT FROM ROW(parent_revision, parent_count) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_recovery_request_settings_mismatch';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Validation only: frozen app roles need no new-table SELECT during the short
-- DDL-to-grants interval. The migration owner, not an application role, owns it.
REVOKE ALL ON FUNCTION "packscout_guard_run_request_settings"() FROM PUBLIC;
CREATE TRIGGER "provider_runs_request_settings_guard"
  BEFORE INSERT OR UPDATE ON "provider_runs"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_run_request_settings"();

CREATE FUNCTION "packscout_page_has_request_receipt"(page_id uuid, run_id uuid, page_number integer,
  lease_fence bigint, response_digest text, normalized_count integer, pinned_count integer, revision_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM local_audit_events audit
    WHERE audit.correlation_id = page_id
      AND audit.action = 'provider.source.page.translated' AND audit.target_type = 'provider_mixed_page'
      AND audit.target_id = page_id::text AND audit.outcome = 'success'
      AND audit.details->>'runId' = run_id::text
      AND audit.details->>'leaseFence' = lease_fence::text
      AND audit.details->>'pageNumber' = page_number::text
      AND audit.details->>'responseDigest' = response_digest
      AND audit.details->>'normalizedRecordCount' = normalized_count::text
      AND audit.details->>'recordsPerRequest' = pinned_count::text
      AND audit.details->>'requestSettingsRevisionId' = revision_id::text
      AND jsonb_typeof(audit.details->'sourceRecordCount') = 'number'
      AND (audit.details->>'sourceRecordCount')::numeric BETWEEN 0 AND pinned_count
      AND mod((audit.details->>'sourceRecordCount')::numeric, 1) = 0
  )
$$;

CREATE FUNCTION "packscout_guard_page_request_settings"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pinned_count integer; revision_id uuid;
BEGIN
  SELECT records_per_request, request_settings_revision_id INTO pinned_count, revision_id FROM provider_runs WHERE id = NEW.provider_run_id;
  -- Unknown historical pins remain unknown; new execution refuses them in the
  -- repositories/worker. This must not interrupt an already-running old worker.
  IF pinned_count IS NOT NULL AND NOT packscout_page_has_request_receipt(
    NEW.id, NEW.provider_run_id, NEW.page_number,
    (SELECT worker_fence FROM provider_runs WHERE id = NEW.provider_run_id),
    NEW.response_digest, NEW.record_count, pinned_count, revision_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_page_request_receipt_missing';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "provider_run_pages_request_settings_guard"
  BEFORE INSERT ON "provider_run_pages"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_page_request_settings"();
COMMIT;
