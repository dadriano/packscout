-- Exact public provider plans cross the provider/central boundary only as
-- independently verified relay evidence. The activity envelope stays bounded;
-- event, proof cache, and manifest gate are accepted in one central transaction.

-- A gate generation belongs to central and advances once for each new logical
-- request. A provider completion sequence is only source evidence; keeping it
-- in separate columns prevents a large or delayed provider sequence from
-- skipping an explicit operation or poisoning central acknowledgement.
ALTER TABLE "manifest_gate_intents"
  ADD COLUMN "provider_source_generation" BIGINT,
  ADD COLUMN "provider_source_gate_generation" BIGINT,
  ADD COLUMN "provider_source_cause" TEXT,
  ADD COLUMN "provider_source_evidence_digest" CHAR(64),
  ADD COLUMN "provider_source_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "operation_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "claimed_work_kind" TEXT,
  ADD COLUMN "claimed_source_generation" BIGINT,
  ADD COLUMN "claimed_cause" TEXT,
  ADD COLUMN "claimed_evidence_digest" CHAR(64),
  ADD COLUMN "claimed_requested_at" TIMESTAMPTZ(6);

-- This migration is forward-safe for a pre-release database that already
-- contains gate rows. The old requested generation becomes the initial local
-- serial; every subsequent source event advances it by exactly one.
UPDATE "manifest_gate_intents"
SET
  "provider_source_generation" = CASE
    WHEN "latest_cause" IN ('provider_completion', 'continuation')
      THEN "requested_generation" ELSE NULL END,
  "provider_source_gate_generation" = CASE
    WHEN "latest_cause" IN ('provider_completion', 'continuation')
      THEN "requested_generation" ELSE NULL END,
  "provider_source_cause" = CASE
    WHEN "latest_cause" IN ('provider_completion', 'continuation')
      THEN "latest_cause" ELSE NULL END,
  "provider_source_evidence_digest" = CASE
    WHEN "latest_cause" IN ('provider_completion', 'continuation')
      THEN "latest_evidence_digest" ELSE NULL END,
  "provider_source_requested_at" = CASE
    WHEN "latest_cause" IN ('provider_completion', 'continuation')
      THEN "latest_requested_at" ELSE NULL END,
  "operation_requested_at" = CASE
    WHEN "operation_generation" IS NOT NULL
      THEN "latest_requested_at" ELSE NULL END,
  "claimed_work_kind" = CASE
    WHEN "claimed_generation" IS NULL THEN NULL
    WHEN "claimed_generation" = "operation_generation" THEN 'explicit'
    ELSE 'provider_source' END,
  "claimed_source_generation" = CASE
    WHEN "claimed_generation" IS NOT NULL
      AND "claimed_generation" IS DISTINCT FROM "operation_generation"
      THEN "requested_generation" ELSE NULL END,
  "claimed_cause" = CASE
    WHEN "claimed_generation" IS NULL THEN NULL
    WHEN "claimed_generation" = "operation_generation"
      THEN 'manifest_eligibility_change'
    ELSE "latest_cause" END,
  "claimed_evidence_digest" = CASE
    WHEN "claimed_generation" IS NULL THEN NULL
    WHEN "claimed_generation" = "operation_generation"
      THEN "authorization_digest"
    ELSE "latest_evidence_digest" END,
  "claimed_requested_at" = CASE
    WHEN "claimed_generation" IS NULL THEN NULL
    ELSE "latest_requested_at" END;

ALTER TABLE "manifest_gate_intents"
  DROP CONSTRAINT "manifest_gate_intents_shape_check";

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
        "provider_source_generation" IS NULL
        AND "provider_source_gate_generation" IS NULL
        AND "provider_source_cause" IS NULL
        AND "provider_source_evidence_digest" IS NULL
        AND "provider_source_requested_at" IS NULL
      )
      OR (
        "provider_source_generation" > 0
        AND "provider_source_gate_generation" BETWEEN 1
          AND "requested_generation"
        AND "provider_source_cause" IN (
          'provider_completion', 'manifest_eligibility_change', 'continuation'
        )
        AND "provider_source_evidence_digest" ~ '^[0-9a-f]{64}$'
        AND "provider_source_requested_at" IS NOT NULL
      )
    )
    AND (
      (
        "operation_generation" IS NULL
        AND "operation_requested_at" IS NULL
        AND "requested_operation" IS NULL
        AND "target_provider_release_id" IS NULL
        AND "target_catalog_version_id" IS NULL
        AND "requested_by_operator_id" IS NULL
        AND "authorization_digest" IS NULL
      )
      OR (
        "operation_generation" > "acknowledged_generation"
        AND "operation_generation" <= "requested_generation"
        AND "operation_requested_at" IS NOT NULL
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
    AND "requested_generation" = greatest(
      "acknowledged_generation",
      coalesce("provider_source_gate_generation", 0),
      coalesce("operation_generation", 0)
    )
    AND (
      (
        "claim_owner" IS NULL
        AND "claim_token" IS NULL
        AND "claimed_generation" IS NULL
        AND "claimed_work_kind" IS NULL
        AND "claimed_source_generation" IS NULL
        AND "claimed_cause" IS NULL
        AND "claimed_evidence_digest" IS NULL
        AND "claimed_requested_at" IS NULL
        AND "claim_expires_at" IS NULL
      )
      OR (
        btrim("claim_owner") <> ''
        AND "claim_token" IS NOT NULL
        AND "claimed_generation" > "acknowledged_generation"
        AND "claimed_generation" <= "requested_generation"
        AND "claim_expires_at" IS NOT NULL
        AND "claimed_work_kind" IN ('provider_source', 'explicit')
        AND "claimed_cause" IN (
          'provider_completion', 'manifest_eligibility_change', 'continuation'
        )
        AND "claimed_evidence_digest" ~ '^[0-9a-f]{64}$'
        AND "claimed_requested_at" IS NOT NULL
        AND (
          (
            "claimed_work_kind" = 'provider_source'
            AND "claimed_source_generation" > 0
            AND "claimed_generation" <=
              "provider_source_gate_generation"
          )
          OR (
            "claimed_work_kind" = 'explicit'
            AND "claimed_source_generation" IS NULL
            AND "claimed_generation" = "operation_generation"
          )
        )
      )
    )
    AND ("last_attempted_at" IS NULL OR "attempt_count" > 0)
    AND ("last_failure_code" IS NULL OR
      "last_failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$')
  );

CREATE TABLE "provider_completion_publish_plans" (
  "event_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "provider_release_id" UUID NOT NULL,
  "public_provider_release_id" UUID NOT NULL,
  "provider_release_fingerprint" CHAR(64) NOT NULL,
  "catalog_version_id" UUID NOT NULL,
  "catalog_content_hash" CHAR(64) NOT NULL,
  "provider_release_content_hash" CHAR(64) NOT NULL,
  "completed_through_change_sequence" BIGINT NOT NULL,
  "artifact_attempt_id" UUID NOT NULL,
  "terminal_operation_kind" TEXT NOT NULL,
  "terminal_operation_id" TEXT NOT NULL,
  "terminal_receipt_sha256" CHAR(64) NOT NULL,
  "evidence_digest" CHAR(64) NOT NULL,
  "plan_sha256" CHAR(64) NOT NULL,
  "plan_bytes" BYTEA NOT NULL,
  "completed_head_sha256" CHAR(64) NOT NULL,
  "completed_head_bytes" BYTEA NOT NULL,
  "active_observation_sha256" CHAR(64) NOT NULL,
  "active_observation_bytes" BYTEA NOT NULL,
  "verified_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_completion_publish_plans_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "provider_completion_publish_plans_provider_evidence_key"
    UNIQUE ("provider_id", "evidence_digest"),
  CONSTRAINT "provider_completion_publish_plans_provider_attempt_key"
    UNIQUE ("provider_id", "artifact_attempt_id"),
  CONSTRAINT "provider_completion_plans_provider_event_key"
    UNIQUE ("provider_id", "event_id"),
  CONSTRAINT "provider_completion_plans_release_generation_key"
    UNIQUE (
      "provider_id", "provider_release_id",
      "completed_through_change_sequence"
    ),
  CONSTRAINT "provider_completion_publish_plans_shape_check" CHECK (
    "provider_release_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "catalog_content_hash" ~ '^[0-9a-f]{64}$'
    AND "provider_release_content_hash" ~ '^[0-9a-f]{64}$'
    AND "completed_through_change_sequence" > 0
    AND "terminal_operation_kind" IN ('finalize', 'confirmReuse')
    AND "terminal_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "terminal_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND "evidence_digest" ~ '^[0-9a-f]{64}$'
    AND "plan_sha256" = encode(digest("plan_bytes", 'sha256'), 'hex')
    AND octet_length("plan_bytes") BETWEEN 2 AND 268435456
    AND jsonb_typeof(convert_from("plan_bytes", 'UTF8')::jsonb) = 'object'
    AND "completed_head_sha256" =
      encode(digest("completed_head_bytes", 'sha256'), 'hex')
    AND octet_length("completed_head_bytes") BETWEEN 2 AND 262144
    AND jsonb_typeof(convert_from("completed_head_bytes", 'UTF8')::jsonb) = 'object'
    AND "active_observation_sha256" =
      encode(digest("active_observation_bytes", 'sha256'), 'hex')
    AND octet_length("active_observation_bytes") BETWEEN 2 AND 262144
    AND jsonb_typeof(convert_from("active_observation_bytes", 'UTF8')::jsonb) = 'object'
  )
);

ALTER TABLE "provider_completion_publish_plans"
  ADD CONSTRAINT "provider_completion_publish_plans_provider_fk"
    FOREIGN KEY ("provider_id") REFERENCES "providers"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_completion_publish_plans_catalog_version_fk"
    FOREIGN KEY ("catalog_version_id") REFERENCES "catalog_versions"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_completion_publish_plans_activity_event_fk"
    FOREIGN KEY ("provider_id", "event_id")
    REFERENCES "provider_activity_events"("provider_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "provider_completion_publish_plans_manifest_lookup_idx"
  ON "provider_completion_publish_plans" (
    "provider_id", "public_provider_release_id",
    "provider_release_fingerprint",
    "completed_through_change_sequence" DESC
  );

CREATE INDEX "provider_completion_publish_plans_retention_idx"
  ON "provider_completion_publish_plans" ("verified_at", "event_id");

-- A provider-local release is immutable even when later reuse completions
-- advance its observation boundary. Serialize the first identity binding so
-- concurrent relays cannot create two different plans for one local release.
CREATE FUNCTION "packscout_guard_provider_completion_publish_plan_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'provider-completion-plan:' || NEW.provider_id::text,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM "provider_completion_publish_plans" existing
    WHERE existing.provider_id = NEW.provider_id
      AND (
        (
          existing.provider_release_id = NEW.provider_release_id
          AND (
            existing.public_provider_release_id <>
              NEW.public_provider_release_id
            OR existing.provider_release_fingerprint <>
              NEW.provider_release_fingerprint
            OR existing.catalog_version_id <> NEW.catalog_version_id
            OR existing.catalog_content_hash <> NEW.catalog_content_hash
            OR existing.provider_release_content_hash <>
              NEW.provider_release_content_hash
            OR existing.plan_sha256 <> NEW.plan_sha256
            OR existing.plan_bytes <> NEW.plan_bytes
          )
        )
        OR (
          existing.public_provider_release_id =
            NEW.public_provider_release_id
          AND existing.provider_release_fingerprint =
            NEW.provider_release_fingerprint
          AND (
            existing.plan_sha256 <> NEW.plan_sha256
            OR existing.plan_bytes <> NEW.plan_bytes
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'provider_completion_publish_plan_identity_conflict';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_completion_publish_plans_identity_guard_trigger"
  BEFORE INSERT ON "provider_completion_publish_plans"
  FOR EACH ROW EXECUTE FUNCTION
    "packscout_guard_provider_completion_publish_plan_insert"();

CREATE FUNCTION "packscout_provider_completion_publish_plan_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'provider_completion_publish_plan_immutable';
END;
$$;

CREATE TRIGGER "provider_completion_publish_plans_immutable_trigger"
  BEFORE UPDATE ON "provider_completion_publish_plans"
  FOR EACH ROW EXECUTE FUNCTION
    "packscout_provider_completion_publish_plan_immutable"();
