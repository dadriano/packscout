-- Distributed manifest activation keeps exact replay evidence in central.
-- The pre-launch legacy table has no reusable canonical request bytes, so a
-- non-empty table must be drained before this clean authority can be enabled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "manifest_activation_operations") THEN
    RAISE EXCEPTION 'manifest activation exact-evidence migration requires an empty operation ledger'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE "manifest_activation_state"
  ADD COLUMN "active_generation" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "active_manifest_bytes" BYTEA,
  ADD COLUMN "active_manifest_bytes_hash" CHAR(64),
  ADD COLUMN "active_state_bytes" BYTEA,
  ADD COLUMN "active_state_hash" CHAR(64),
  ADD COLUMN "previous_manifest_bytes" BYTEA,
  ADD COLUMN "previous_manifest_bytes_hash" CHAR(64);

ALTER TABLE "manifest_activation_operations"
  ADD COLUMN "new_manifest_id" TEXT NOT NULL,
  ADD COLUMN "new_manifest_bytes" BYTEA NOT NULL,
  ADD COLUMN "new_manifest_bytes_hash" CHAR(64) NOT NULL,
  ADD COLUMN "request_bytes" BYTEA NOT NULL,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_attempted_at" TIMESTAMPTZ(6),
  ADD COLUMN "completion_lease_fence" BIGINT,
  ADD COLUMN "receipt_bytes" BYTEA,
  ADD COLUMN "response_digest" CHAR(64),
  ADD COLUMN "response_bytes" BYTEA,
  ADD COLUMN "failure_code" TEXT;

ALTER TABLE "manifest_activation_state"
  ADD CONSTRAINT "manifest_activation_state_exact_evidence_check" CHECK (
    "active_generation" >= 0
    AND (
      (
        "active_manifest_id" IS NULL
        AND "active_manifest_fingerprint" IS NULL
        AND "active_manifest_bytes" IS NULL
        AND "active_manifest_bytes_hash" IS NULL
        AND "active_state_bytes" IS NULL
        AND "active_state_hash" IS NULL
        AND "active_generation" = 0
      )
      OR (
        "active_manifest_id" IS NOT NULL
        AND "active_manifest_fingerprint" IS NOT NULL
        AND "active_manifest_bytes" IS NOT NULL
        AND "active_manifest_bytes_hash" = encode(digest("active_manifest_bytes", 'sha256'), 'hex')
        AND "active_state_bytes" IS NOT NULL
        AND "active_state_hash" = encode(digest("active_state_bytes", 'sha256'), 'hex')
        AND "active_generation" > 0
        AND convert_from("active_manifest_bytes", 'UTF8')::jsonb ->> 'publicReleaseId'
          = "active_manifest_id"
        AND convert_from("active_manifest_bytes", 'UTF8')::jsonb ->> 'manifestFingerprint'
          = "active_manifest_fingerprint"
        AND convert_from("active_state_bytes", 'UTF8')::jsonb ->> 'generation'
          = "active_generation"::text
      )
    )
    AND (
      (
        "previous_manifest_id" IS NULL
        AND "previous_manifest_fingerprint" IS NULL
        AND "previous_manifest_bytes" IS NULL
        AND "previous_manifest_bytes_hash" IS NULL
      )
      OR (
        "previous_manifest_id" IS NOT NULL
        AND "previous_manifest_fingerprint" IS NOT NULL
        AND "previous_manifest_bytes" IS NOT NULL
        AND "previous_manifest_bytes_hash" = encode(digest("previous_manifest_bytes", 'sha256'), 'hex')
        AND convert_from("previous_manifest_bytes", 'UTF8')::jsonb ->> 'publicReleaseId'
          = "previous_manifest_id"
        AND convert_from("previous_manifest_bytes", 'UTF8')::jsonb ->> 'manifestFingerprint'
          = "previous_manifest_fingerprint"
      )
    )
  );

ALTER TABLE "manifest_activation_operations"
  DROP CONSTRAINT "manifest_activation_operations_terminal_evidence_check",
  DROP CONSTRAINT "manifest_activation_operations_request_check";

ALTER TABLE "manifest_activation_operations"
  ADD CONSTRAINT "manifest_activation_operations_exact_request_check" CHECK (
    btrim("idempotency_key") <> ''
    AND btrim("new_manifest_id") <> ''
    AND "new_manifest_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "new_manifest_bytes_hash" ~ '^[0-9a-f]{64}$'
    AND "new_manifest_bytes_hash" = encode(digest("new_manifest_bytes", 'sha256'), 'hex')
    AND octet_length("new_manifest_bytes") BETWEEN 2 AND 65536
    AND convert_from("new_manifest_bytes", 'UTF8')::jsonb ->> 'publicReleaseId'
      = "new_manifest_id"
    AND convert_from("new_manifest_bytes", 'UTF8')::jsonb ->> 'manifestFingerprint'
      = "new_manifest_fingerprint"
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "request_digest" = encode(digest("request_bytes", 'sha256'), 'hex')
    AND octet_length("request_bytes") BETWEEN 2 AND 262144
    AND "lease_fence" > 0
    AND "attempt_count" >= 0
    AND (
      ("attempt_count" = 0 AND "last_attempted_at" IS NULL AND "completion_lease_fence" IS NULL)
      OR ("attempt_count" > 0 AND "last_attempted_at" IS NOT NULL AND "completion_lease_fence" > 0)
    )
  ),
  ADD CONSTRAINT "manifest_activation_operations_exact_terminal_evidence_check" CHECK (
    (
      "state" = 'pending'
      AND "completed_at" IS NULL
      AND "convex_receipt_id" IS NULL
      AND "receipt_hash" IS NULL
      AND "receipt" IS NULL
      AND "receipt_bytes" IS NULL
      AND "response_digest" IS NULL
      AND "response_bytes" IS NULL
      AND "failure_code" IS NULL
    )
    OR (
      "state" = 'accepted'
      AND "completed_at" IS NOT NULL
      AND "attempt_count" > 0
      AND "convex_receipt_id" IS NOT NULL
      AND btrim("convex_receipt_id") <> ''
      AND "receipt_hash" ~ '^[0-9a-f]{64}$'
      AND "receipt" IS NOT NULL
      AND jsonb_typeof("receipt") = 'object'
      AND "receipt_bytes" IS NOT NULL
      AND "receipt_hash" = encode(digest("receipt_bytes", 'sha256'), 'hex')
      AND convert_from("receipt_bytes", 'UTF8')::jsonb = "receipt"
      AND "response_digest" ~ '^[0-9a-f]{64}$'
      AND "response_bytes" IS NOT NULL
      AND "response_digest" = encode(digest("response_bytes", 'sha256'), 'hex')
      AND convert_from("response_bytes", 'UTF8')::jsonb -> 'receipt' = "receipt"
      AND "failure_code" IS NULL
    )
    OR (
      "state" IN ('ambiguous', 'failed')
      AND "completed_at" IS NOT NULL
      AND "attempt_count" > 0
      AND "convex_receipt_id" IS NULL
      AND "receipt_hash" IS NULL
      AND "receipt" IS NULL
      AND "receipt_bytes" IS NULL
      AND "response_digest" IS NULL
      AND "response_bytes" IS NULL
      AND "failure_code" IS NOT NULL
      AND "failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$'
    )
  );

CREATE OR REPLACE FUNCTION "packscout_enforce_publication_operation_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_identity jsonb;
  new_identity jsonb;
  old_non_attempt jsonb;
  new_non_attempt jsonb;
  current_fence bigint;
  current_owner text;
  current_expiration timestamptz;
  current_manifest_id text;
  effective_fence bigint;
BEGIN
  IF TG_TABLE_NAME = 'catalog_publication_operations' THEN
    old_identity := to_jsonb(OLD) - 'state' - 'convex_receipt_id' - 'receipt_hash' - 'receipt' - 'failure_code' - 'completed_at';
    new_identity := to_jsonb(NEW) - 'state' - 'convex_receipt_id' - 'receipt_hash' - 'receipt' - 'failure_code' - 'completed_at';
  ELSE
    old_identity := to_jsonb(OLD)
      - 'state' - 'attempt_count' - 'last_attempted_at'
      - 'completion_lease_fence' - 'convex_receipt_id' - 'receipt_hash'
      - 'receipt' - 'receipt_bytes' - 'response_digest' - 'response_bytes'
      - 'failure_code' - 'completed_at';
    new_identity := to_jsonb(NEW)
      - 'state' - 'attempt_count' - 'last_attempted_at'
      - 'completion_lease_fence' - 'convex_receipt_id' - 'receipt_hash'
      - 'receipt' - 'receipt_bytes' - 'response_digest' - 'response_bytes'
      - 'failure_code' - 'completed_at';
  END IF;
  IF old_identity IS DISTINCT FROM new_identity THEN
    RAISE EXCEPTION '% operation identity and request are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('accepted', 'failed') THEN
    RAISE EXCEPTION '% terminal operation is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'catalog_publication_operations' THEN
    IF NEW.state = OLD.state THEN
      IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION '% operation state must advance when evidence changes', TG_TABLE_NAME USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    SELECT lease_fence, lease_owner, lease_expires_at
    INTO current_fence, current_owner, current_expiration
    FROM "catalog_consumer_checkpoints"
    WHERE consumer_key = 'catalog_publication'
    FOR UPDATE;
    effective_fence := NEW.lease_fence;
  ELSE
    SELECT lease_fence, lease_owner, lease_expires_at, active_manifest_id
    INTO current_fence, current_owner, current_expiration, current_manifest_id
    FROM "manifest_activation_state"
    WHERE singleton_key
    FOR UPDATE;
    effective_fence := coalesce(NEW.completion_lease_fence, NEW.lease_fence);

    IF NEW.state = OLD.state THEN
      old_non_attempt := to_jsonb(OLD)
        - 'attempt_count' - 'last_attempted_at' - 'completion_lease_fence';
      new_non_attempt := to_jsonb(NEW)
        - 'attempt_count' - 'last_attempted_at' - 'completion_lease_fence';
      IF OLD.state NOT IN ('pending', 'ambiguous')
         OR NEW.attempt_count <> OLD.attempt_count + 1
         OR NEW.last_attempted_at IS NULL
         OR (OLD.last_attempted_at IS NOT NULL
           AND NEW.last_attempted_at <= OLD.last_attempted_at)
         OR old_non_attempt IS DISTINCT FROM new_non_attempt THEN
        RAISE EXCEPTION '% operation delivery evidence is invalid', TG_TABLE_NAME USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF current_fence IS NULL
     OR current_fence <> effective_fence
     OR current_owner IS NULL
     OR current_expiration IS NULL
     OR current_expiration <= statement_timestamp() THEN
    RAISE EXCEPTION '% operation cannot advance under a stale or inactive lease fence', TG_TABLE_NAME
      USING ERRCODE = '40001';
  END IF;

  IF TG_TABLE_NAME = 'manifest_activation_operations'
     AND NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('accepted', 'ambiguous', 'failed'))
    OR (OLD.state = 'ambiguous' AND NEW.state IN ('accepted', 'failed'))
  ) THEN
    RAISE EXCEPTION '% operation transition % -> % is not allowed', TG_TABLE_NAME, OLD.state, NEW.state
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'accepted' AND TG_TABLE_NAME = 'catalog_publication_operations' THEN
    IF NEW.operation_kind = 'batch' AND NOT EXISTS (
      SELECT 1
      FROM "catalog_version_batches" batch
      WHERE batch.catalog_version_id = NEW.catalog_version_id
        AND batch.batch_index = NEW.batch_index
        AND batch.body_hash = NEW.body_hash
    ) THEN
      RAISE EXCEPTION 'accepted catalog batch receipt does not identify an exact local batch'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'accepted' AND TG_TABLE_NAME = 'manifest_activation_operations' THEN
    IF NEW.expected_manifest_id IS DISTINCT FROM current_manifest_id THEN
      RAISE EXCEPTION 'accepted manifest operation does not match the active manifest predecessor'
        USING ERRCODE = '40001';
    END IF;
    IF NEW.target_catalog_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM "catalog_versions" version
      WHERE version.id = NEW.target_catalog_version_id
        AND version.lifecycle = 'complete'
    ) THEN
      RAISE EXCEPTION 'accepted manifest operation requires a complete local catalog version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "packscout_validate_manifest_activation_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.active_generation,
    NEW.active_manifest_id,
    NEW.active_manifest_fingerprint,
    NEW.active_manifest_bytes,
    NEW.active_manifest_bytes_hash,
    NEW.active_state_bytes,
    NEW.active_state_hash,
    NEW.previous_manifest_id,
    NEW.previous_manifest_fingerprint,
    NEW.previous_manifest_bytes,
    NEW.previous_manifest_bytes_hash,
    NEW.last_receipt_id
  ) IS NOT DISTINCT FROM (
    OLD.active_generation,
    OLD.active_manifest_id,
    OLD.active_manifest_fingerprint,
    OLD.active_manifest_bytes,
    OLD.active_manifest_bytes_hash,
    OLD.active_state_bytes,
    OLD.active_state_hash,
    OLD.previous_manifest_id,
    OLD.previous_manifest_fingerprint,
    OLD.previous_manifest_bytes,
    OLD.previous_manifest_bytes_hash,
    OLD.last_receipt_id
  ) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "manifest_activation_operations" operation
    WHERE operation.state = 'accepted'
      AND operation.convex_receipt_id = NEW.last_receipt_id
      AND operation.completion_lease_fence = NEW.lease_fence
      AND operation.expected_manifest_id IS NOT DISTINCT FROM OLD.active_manifest_id
      AND operation.new_manifest_id = NEW.active_manifest_id
      AND operation.new_manifest_fingerprint = NEW.active_manifest_fingerprint
      AND operation.new_manifest_bytes = NEW.active_manifest_bytes
      AND operation.receipt -> 'details' -> 'activeState' ->> 'generation'
        = NEW.active_generation::text
      AND operation.receipt -> 'details' -> 'activeState' -> 'activeManifest' ->> 'publicReleaseId'
        = NEW.active_manifest_id
      AND operation.receipt -> 'details' -> 'activeState' -> 'activeManifest' ->> 'manifestFingerprint'
        = NEW.active_manifest_fingerprint
      AND (operation.receipt -> 'details' -> 'activeState' -> 'previousManifest' ->> 'publicReleaseId')
        IS NOT DISTINCT FROM NEW.previous_manifest_id
      AND (operation.receipt -> 'details' -> 'activeState' -> 'previousManifest' ->> 'manifestFingerprint')
        IS NOT DISTINCT FROM NEW.previous_manifest_fingerprint
      AND convert_from(NEW.active_state_bytes, 'UTF8')::jsonb ->> 'terminalReceiptSha256'
        = operation.receipt_hash
      AND convert_from(NEW.active_state_bytes, 'UTF8')::jsonb - 'terminalReceiptSha256'
        = operation.receipt -> 'details' -> 'activeState'
  ) THEN
    RAISE EXCEPTION 'manifest state change requires its exact accepted activation receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
