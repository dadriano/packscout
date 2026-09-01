-- Durable fair gate claims plus exact signed status/bootstrap observations.
ALTER TABLE "manifest_gate_intents"
  ADD COLUMN "operation_generation" BIGINT,
  ADD COLUMN "requested_operation" "manifest_operation",
  ADD COLUMN "target_provider_release_id" UUID,
  ADD COLUMN "target_catalog_version_id" UUID,
  ADD COLUMN "requested_by_operator_id" UUID,
  ADD COLUMN "authorization_digest" CHAR(64),
  ADD COLUMN "claim_owner" TEXT,
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "claimed_generation" BIGINT,
  ADD COLUMN "claim_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_attempted_at" TIMESTAMPTZ(6),
  ADD COLUMN "retry_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_failure_code" TEXT;

ALTER TABLE "manifest_gate_intents"
  DROP CONSTRAINT "manifest_gate_intents_shape_check";

DROP INDEX "manifest_gate_intents_pending_idx";

ALTER TABLE "manifest_gate_intents"
  ADD CONSTRAINT "manifest_gate_intents_shape_check" CHECK (
    "requested_generation" >= 0
    AND "acknowledged_generation" BETWEEN 0 AND "requested_generation"
    AND "row_version" > 0
    AND "attempt_count" >= 0
    AND ("requested_generation" = 0) = ("latest_cause" IS NULL)
    AND ("requested_generation" = 0) = ("latest_evidence_digest" IS NULL)
    AND ("requested_generation" = 0) = ("latest_requested_at" IS NULL)
    AND ("latest_cause" IS NULL OR "latest_cause" IN (
      'provider_completion', 'manifest_eligibility_change', 'continuation'
    ))
    AND ("latest_evidence_digest" IS NULL OR
      "latest_evidence_digest" ~ '^[0-9a-f]{64}$')
    AND (
      (
        "operation_generation" IS NULL
        AND "requested_operation" IS NULL
        AND "target_provider_release_id" IS NULL
        AND "target_catalog_version_id" IS NULL
        AND "requested_by_operator_id" IS NULL
        AND "authorization_digest" IS NULL
      )
      OR (
        "operation_generation" > "acknowledged_generation"
        AND "operation_generation" <= "requested_generation"
        AND "requested_operation" IS NOT NULL
        AND "requested_by_operator_id" IS NOT NULL
        AND "authorization_digest" ~ '^[0-9a-f]{64}$'
        AND (
          (
            "requested_operation" = 'remove'
            AND "target_provider_release_id" IS NULL
            AND "target_catalog_version_id" IS NULL
          )
          OR (
            "requested_operation" IN ('advance', 'add', 'rollback')
            AND "target_provider_release_id" IS NOT NULL
            AND "target_catalog_version_id" IS NOT NULL
          )
        )
      )
    )
    AND (
      (
        "claim_owner" IS NULL
        AND "claim_token" IS NULL
        AND "claimed_generation" IS NULL
        AND "claim_expires_at" IS NULL
      )
      OR (
        btrim("claim_owner") <> ''
        AND "claim_token" IS NOT NULL
        AND "claimed_generation" > "acknowledged_generation"
        AND "claimed_generation" <= "requested_generation"
        AND "claim_expires_at" IS NOT NULL
      )
    )
    AND ("last_attempted_at" IS NULL OR "attempt_count" > 0)
    AND ("last_failure_code" IS NULL OR
      "last_failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$')
  );

CREATE INDEX "manifest_gate_intents_pending_idx"
  ON "manifest_gate_intents"
    ("acknowledged_generation", "requested_generation", "retry_at", "last_attempted_at")
  WHERE "requested_generation" > "acknowledged_generation";

CREATE INDEX "manifest_gate_intents_claim_idx"
  ON "manifest_gate_intents"
    ("retry_at", "last_attempted_at", "updated_at", "provider_id")
  WHERE "requested_generation" > "acknowledged_generation";

CREATE TABLE "manifest_activation_status_observations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "lease_fence" BIGINT NOT NULL,
  "result_kind" TEXT NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "request_bytes" BYTEA NOT NULL,
  "receipt_hash" CHAR(64) NOT NULL,
  "receipt_bytes" BYTEA NOT NULL,
  "response_digest" CHAR(64) NOT NULL,
  "response_bytes" BYTEA NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_activation_status_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manifest_activation_status_observations_operation_fk"
    FOREIGN KEY ("operation_id")
    REFERENCES "manifest_activation_operations"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "manifest_activation_status_observations_response_unique"
    UNIQUE ("operation_id", "response_digest"),
  CONSTRAINT "manifest_activation_status_observations_shape_check" CHECK (
    "lease_fence" > 0
    AND "result_kind" IN ('not_found', 'terminal')
    AND "request_digest" = encode(digest("request_bytes", 'sha256'), 'hex')
    AND octet_length("request_bytes") BETWEEN 2 AND 262144
    AND "receipt_hash" = encode(digest("receipt_bytes", 'sha256'), 'hex')
    AND octet_length("receipt_bytes") BETWEEN 2 AND 262144
    AND "response_digest" = encode(digest("response_bytes", 'sha256'), 'hex')
    AND octet_length("response_bytes") BETWEEN 2 AND 524288
    AND convert_from("response_bytes", 'UTF8')::jsonb -> 'receipt'
      = convert_from("receipt_bytes", 'UTF8')::jsonb
  )
);

CREATE INDEX "manifest_activation_status_observations_operation_idx"
  ON "manifest_activation_status_observations" ("operation_id", "observed_at");

CREATE TABLE "manifest_activation_state_observations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "observation_kind" TEXT NOT NULL,
  "lease_fence" BIGINT NOT NULL,
  "active_generation" BIGINT NOT NULL,
  "active_manifest_id" TEXT,
  "active_manifest_fingerprint" CHAR(64),
  "active_manifest_bytes" BYTEA,
  "active_manifest_bytes_hash" CHAR(64),
  "previous_manifest_id" TEXT,
  "previous_manifest_fingerprint" CHAR(64),
  "previous_manifest_bytes" BYTEA,
  "previous_manifest_bytes_hash" CHAR(64),
  "active_state_bytes" BYTEA NOT NULL,
  "active_state_hash" CHAR(64) NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "request_bytes" BYTEA NOT NULL,
  "convex_receipt_id" TEXT NOT NULL,
  "receipt_hash" CHAR(64) NOT NULL,
  "receipt_bytes" BYTEA NOT NULL,
  "response_digest" CHAR(64) NOT NULL,
  "response_bytes" BYTEA NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_activation_state_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manifest_activation_state_observations_response_unique"
    UNIQUE ("response_digest", "lease_fence"),
  CONSTRAINT "manifest_activation_state_observations_shape_check" CHECK (
    "observation_kind" IN ('bootstrap', 'reconciliation')
    AND "lease_fence" > 0
    AND "active_generation" >= 0
    AND btrim("convex_receipt_id") <> ''
    AND "active_state_hash" = encode(digest("active_state_bytes", 'sha256'), 'hex')
    AND convert_from("active_state_bytes", 'UTF8')::jsonb ->> 'generation'
      = "active_generation"::text
    AND "request_digest" = encode(digest("request_bytes", 'sha256'), 'hex')
    AND octet_length("request_bytes") BETWEEN 2 AND 262144
    AND "receipt_hash" = encode(digest("receipt_bytes", 'sha256'), 'hex')
    AND octet_length("receipt_bytes") BETWEEN 2 AND 262144
    AND "response_digest" = encode(digest("response_bytes", 'sha256'), 'hex')
    AND octet_length("response_bytes") BETWEEN 2 AND 524288
    AND convert_from("response_bytes", 'UTF8')::jsonb -> 'receipt'
      = convert_from("receipt_bytes", 'UTF8')::jsonb
    AND (
      (
        "active_generation" = 0
        AND "active_manifest_id" IS NULL
        AND "active_manifest_fingerprint" IS NULL
        AND "active_manifest_bytes" IS NULL
        AND "active_manifest_bytes_hash" IS NULL
        AND "previous_manifest_id" IS NULL
        AND "previous_manifest_fingerprint" IS NULL
        AND "previous_manifest_bytes" IS NULL
        AND "previous_manifest_bytes_hash" IS NULL
      )
      OR (
        "active_generation" > 0
        AND "active_manifest_id" IS NOT NULL
        AND "active_manifest_fingerprint" IS NOT NULL
        AND "active_manifest_bytes" IS NOT NULL
        AND "active_manifest_bytes_hash"
          = encode(digest("active_manifest_bytes", 'sha256'), 'hex')
        AND convert_from("active_manifest_bytes", 'UTF8')::jsonb ->> 'publicReleaseId'
          = "active_manifest_id"
        AND convert_from("active_manifest_bytes", 'UTF8')::jsonb ->> 'manifestFingerprint'
          = "active_manifest_fingerprint"
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
            AND "previous_manifest_bytes_hash"
              = encode(digest("previous_manifest_bytes", 'sha256'), 'hex')
            AND convert_from("previous_manifest_bytes", 'UTF8')::jsonb ->> 'publicReleaseId'
              = "previous_manifest_id"
            AND convert_from("previous_manifest_bytes", 'UTF8')::jsonb ->> 'manifestFingerprint'
              = "previous_manifest_fingerprint"
          )
        )
      )
    )
  )
);

CREATE INDEX "manifest_activation_state_observations_generation_idx"
  ON "manifest_activation_state_observations" ("active_generation", "observed_at");

CREATE FUNCTION "packscout_reject_manifest_observation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "manifest_activation_status_observations_immutable"
  BEFORE UPDATE OR DELETE ON "manifest_activation_status_observations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_manifest_observation_mutation"();

CREATE TRIGGER "manifest_activation_state_observations_immutable"
  BEFORE UPDATE OR DELETE ON "manifest_activation_state_observations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_manifest_observation_mutation"();

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
  ) AND NOT EXISTS (
    SELECT 1
    FROM "manifest_activation_state_observations" observation
    WHERE observation.lease_fence = NEW.lease_fence
      AND observation.convex_receipt_id = NEW.last_receipt_id
      AND observation.active_generation = NEW.active_generation
      AND observation.active_manifest_id IS NOT DISTINCT FROM NEW.active_manifest_id
      AND observation.active_manifest_fingerprint IS NOT DISTINCT FROM NEW.active_manifest_fingerprint
      AND observation.active_manifest_bytes IS NOT DISTINCT FROM NEW.active_manifest_bytes
      AND observation.active_manifest_bytes_hash IS NOT DISTINCT FROM NEW.active_manifest_bytes_hash
      AND observation.active_state_bytes = NEW.active_state_bytes
      AND observation.active_state_hash = NEW.active_state_hash
      AND observation.previous_manifest_id IS NOT DISTINCT FROM NEW.previous_manifest_id
      AND observation.previous_manifest_fingerprint IS NOT DISTINCT FROM NEW.previous_manifest_fingerprint
      AND observation.previous_manifest_bytes IS NOT DISTINCT FROM NEW.previous_manifest_bytes
      AND observation.previous_manifest_bytes_hash IS NOT DISTINCT FROM NEW.previous_manifest_bytes_hash
  ) THEN
    RAISE EXCEPTION 'manifest state change requires exact accepted or signed observation evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
