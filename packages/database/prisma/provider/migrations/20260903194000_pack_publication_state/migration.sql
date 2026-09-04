-- Dormant pack-local publication authority; this migration starts no processors.
CREATE TABLE pack_publication_scopes (
  provider_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  change_sequence bigint NOT NULL DEFAULT 0 CHECK (change_sequence >= 0),
  shared_change_sequence bigint NOT NULL DEFAULT 0 CHECK (shared_change_sequence >= 0),
  UNIQUE (organization_id, provider_id)
);
CREATE FUNCTION guard_pack_publication_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM database_identity WHERE singleton_key AND provider_id = NEW.provider_id) THEN
    RAISE EXCEPTION 'pack.publication_scope_mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id OR NEW.provider_id <> OLD.provider_id
    OR NEW.change_sequence < OLD.change_sequence OR NEW.shared_change_sequence < OLD.shared_change_sequence) THEN
    RAISE EXCEPTION 'pack.publication_scope_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pack_publication_scope_guard BEFORE INSERT OR UPDATE ON pack_publication_scopes
  FOR EACH ROW EXECUTE FUNCTION guard_pack_publication_scope();

CREATE TABLE pack_publication_heads (
  public_repack_id uuid PRIMARY KEY REFERENCES packs(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, provider_id uuid NOT NULL,
  latest_sequence bigint NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  accepted_sequence bigint NOT NULL DEFAULT 0 CHECK (accepted_sequence >= 0),
  publication_epoch bigint NOT NULL DEFAULT 0 CHECK (publication_epoch >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  held boolean NOT NULL DEFAULT false, active_snapshot_id text,
  lease_owner uuid, lease_work_id uuid, lease_kind text CHECK (lease_kind IN ('build', 'activation')),
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0), lease_expires_at timestamptz,
  FOREIGN KEY (organization_id, provider_id) REFERENCES pack_publication_scopes(organization_id, provider_id),
  UNIQUE (organization_id, provider_id, public_repack_id),
  CHECK ((lease_owner IS NULL AND lease_work_id IS NULL AND lease_kind IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_work_id IS NOT NULL AND lease_kind IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE pack_build_requests (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, provider_id uuid NOT NULL, public_repack_id uuid NOT NULL,
  pack_publication_sequence bigserial NOT NULL, desired_state_sha256 varchar(64) NOT NULL,
  expected_publication_epoch bigint NOT NULL CHECK (expected_publication_epoch >= 0),
  request_json jsonb NOT NULL, inputs_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting','ready','publishing','retry_scheduled','blocked','published','superseded','rolled_back')),
  reason_code varchar(64), attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, provider_id, public_repack_id) REFERENCES pack_publication_heads(organization_id, provider_id, public_repack_id),
  UNIQUE (organization_id, provider_id, public_repack_id, id),
  UNIQUE (public_repack_id, pack_publication_sequence),
  CHECK (desired_state_sha256 ~ '^[a-f0-9]{64}$'),
  -- Full dependency evidence follows the admitted 16 MB input budget, with
  -- bounded headroom for PostgreSQL JSONB formatting, through every work record.
  -- Current capture and pinned lifecycle baseline each have a 16 MB canonical bound.
  -- JSONB formatting headroom is separate from the unchanged request/document budgets.
  CHECK (octet_length(inputs_json::text) <= 36000000 AND octet_length(request_json::text) <= 18000000)
);
CREATE INDEX pack_build_requests_claim_idx ON pack_build_requests(state, available_at, public_repack_id, pack_publication_sequence);

CREATE TABLE pack_publication_change_receipts (
  organization_id uuid NOT NULL, provider_id uuid NOT NULL, boundary_identity varchar(200) NOT NULL,
  boundary_sha256 varchar(64) NOT NULL, result_sha256 varchar(64) NOT NULL, outcomes_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider_id, boundary_identity),
  FOREIGN KEY (organization_id, provider_id) REFERENCES pack_publication_scopes(organization_id, provider_id),
  CHECK (boundary_sha256 ~ '^[a-f0-9]{64}$' AND result_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(outcomes_json) = 'array' AND jsonb_array_length(outcomes_json) <= 250)
);
CREATE TABLE pack_snapshot_artifacts (
  public_pack_snapshot_id varchar(68) PRIMARY KEY,
  organization_id uuid NOT NULL, provider_id uuid NOT NULL, public_repack_id uuid NOT NULL,
  content_sha256 varchar(64) NOT NULL, snapshot_json jsonb NOT NULL, descriptor_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, provider_id, public_repack_id) REFERENCES pack_publication_heads(organization_id, provider_id, public_repack_id),
  UNIQUE (organization_id, provider_id, public_repack_id, public_pack_snapshot_id),
  UNIQUE (public_repack_id, content_sha256),
  CHECK (public_pack_snapshot_id = 'pps_' || content_sha256 AND content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(snapshot_json::text) <= 18000000 AND octet_length(descriptor_json::text) <= 100000)
);
CREATE TABLE pack_publication_impact_progress (
  organization_id uuid NOT NULL, provider_id uuid NOT NULL, boundary_identity varchar(200) NOT NULL,
  boundary_sha256 varchar(64) NOT NULL, through_sequence bigint, shared_sequence bigint,
  references_json jsonb NOT NULL, after_pack_id uuid REFERENCES packs(id), page_number integer NOT NULL DEFAULT 0 CHECK (page_number >= 0),
  result_sha256 varchar(64) NOT NULL, complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, provider_id, boundary_identity),
  FOREIGN KEY (organization_id, provider_id) REFERENCES pack_publication_scopes(organization_id, provider_id),
  CHECK ((through_sequence IS NULL) <> (shared_sequence IS NULL)),
  CHECK (octet_length(references_json::text) <= 18000000),
  CHECK (boundary_sha256 ~ '^[a-f0-9]{64}$' AND result_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX pack_publication_one_provider_boundary_idx ON pack_publication_impact_progress(provider_id)
  WHERE through_sequence IS NOT NULL AND NOT complete;
CREATE UNIQUE INDEX pack_publication_one_shared_boundary_idx ON pack_publication_impact_progress(provider_id)
  WHERE shared_sequence IS NOT NULL AND NOT complete;
CREATE FUNCTION guard_pack_impact_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.complete AND NEW IS DISTINCT FROM OLD) OR
    (to_jsonb(NEW) - ARRAY['after_pack_id','page_number','result_sha256','complete']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['after_pack_id','page_number','result_sha256','complete']) OR
    NEW.page_number <> OLD.page_number + 1 OR NEW.after_pack_id < OLD.after_pack_id THEN
    RAISE EXCEPTION 'pack.impact_progress_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guarded_progress BEFORE UPDATE OR DELETE ON pack_publication_impact_progress
  FOR EACH ROW EXECUTE FUNCTION guard_pack_impact_progress();
CREATE TABLE pack_snapshot_batches (
  public_pack_snapshot_id varchar(68) NOT NULL REFERENCES pack_snapshot_artifacts(public_pack_snapshot_id),
  batch_index integer NOT NULL CHECK (batch_index BETWEEN 0 AND 31), batch_json jsonb NOT NULL,
  PRIMARY KEY (public_pack_snapshot_id, batch_index), CHECK (octet_length(batch_json::text) <= 600000)
);
CREATE TABLE pack_activation_intents (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, provider_id uuid NOT NULL, public_repack_id uuid NOT NULL,
  build_request_id uuid NOT NULL UNIQUE, public_pack_snapshot_id varchar(68) NOT NULL,
  pack_publication_sequence bigint NOT NULL, intent_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting','ready','publishing','retry_scheduled','blocked','published','superseded','rolled_back')),
  reason_code varchar(64), attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pack_activation_request_fkey FOREIGN KEY (organization_id, provider_id, public_repack_id, build_request_id)
    REFERENCES pack_build_requests(organization_id, provider_id, public_repack_id, id),
  CONSTRAINT pack_activation_artifact_fkey FOREIGN KEY (organization_id, provider_id, public_repack_id, public_pack_snapshot_id)
    REFERENCES pack_snapshot_artifacts(organization_id, provider_id, public_repack_id, public_pack_snapshot_id),
  UNIQUE (organization_id, provider_id, public_repack_id, id),
  CONSTRAINT pack_activation_request_scope_key UNIQUE (organization_id, provider_id, public_repack_id, build_request_id),
  CHECK (octet_length(intent_json::text) <= 18000000)
);
CREATE INDEX pack_activation_intents_claim_idx ON pack_activation_intents(state, available_at, public_repack_id, pack_publication_sequence);
CREATE INDEX pack_activation_intents_sequence_idx ON pack_activation_intents(public_repack_id, pack_publication_sequence);
CREATE TABLE pack_publication_operations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, provider_id uuid NOT NULL, public_repack_id uuid NOT NULL,
  intent_id uuid NOT NULL, idempotency_key varchar(200) NOT NULL, request_sha256 varchar(64) NOT NULL,
  request_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, provider_id, public_repack_id, intent_id)
    REFERENCES pack_activation_intents(organization_id, provider_id, public_repack_id, id),
  UNIQUE (intent_id, idempotency_key), UNIQUE (organization_id, provider_id, public_repack_id, intent_id, id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$' AND octet_length(request_json::text) <= 18000000)
);
CREATE TABLE pack_publication_receipts (
  operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, provider_id uuid NOT NULL, public_repack_id uuid NOT NULL,
  intent_id uuid NOT NULL, receipt_sha256 varchar(64) NOT NULL, receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, provider_id, public_repack_id, intent_id, operation_id)
    REFERENCES pack_publication_operations(organization_id, provider_id, public_repack_id, intent_id, id),
  UNIQUE (organization_id, provider_id, public_repack_id, intent_id, operation_id),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$' AND octet_length(receipt_json::text) <= 10000)
);

-- Exact request/artifact/operation/receipt bytes are never rewritten by a retry.
CREATE FUNCTION guard_pack_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pack.immutable_record'; END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['pack_publication_change_receipts','pack_snapshot_artifacts','pack_snapshot_batches',
    'pack_publication_operations','pack_publication_receipts'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_pack_publication_immutable()', name);
  END LOOP;
END $$;
CREATE FUNCTION guard_pack_publication_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - ARRAY['state','reason_code','attempts','available_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','reason_code','attempts','available_at']) THEN
    RAISE EXCEPTION 'pack.immutable_work';
  END IF;
  IF OLD.state IN ('published','superseded','rolled_back') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'pack.terminal_work';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_work BEFORE UPDATE OR DELETE ON pack_build_requests
  FOR EACH ROW EXECUTE FUNCTION guard_pack_publication_work();
CREATE TRIGGER immutable_work BEFORE UPDATE OR DELETE ON pack_activation_intents
  FOR EACH ROW EXECUTE FUNCTION guard_pack_publication_work();

-- The one pack lease has a polymorphic local target; enforce its scoped reference
-- at commit after both the head and work-state writes have completed.
CREATE FUNCTION guard_pack_lease_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head pack_publication_heads; valid boolean;
BEGIN
  SELECT * INTO head FROM pack_publication_heads WHERE public_repack_id = NEW.public_repack_id;
  IF head.lease_work_id IS NULL THEN RETURN NULL; END IF;
  IF head.lease_kind = 'build' THEN
    SELECT EXISTS(SELECT 1 FROM pack_build_requests w WHERE w.id = head.lease_work_id
      AND w.organization_id = head.organization_id AND w.provider_id = head.provider_id
      AND w.public_repack_id = head.public_repack_id AND w.state = 'publishing') INTO valid;
  ELSE
    SELECT EXISTS(SELECT 1 FROM pack_activation_intents w WHERE w.id = head.lease_work_id
      AND w.organization_id = head.organization_id AND w.provider_id = head.provider_id
      AND w.public_repack_id = head.public_repack_id AND w.state = 'publishing') INTO valid;
  END IF;
  IF NOT valid THEN RAISE EXCEPTION 'pack.lease_reference_invalid'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pack_lease_reference AFTER INSERT OR UPDATE ON pack_publication_heads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_pack_lease_reference();
