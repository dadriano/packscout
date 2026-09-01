BEGIN;

CREATE TABLE "manifest_reconciliation_job_wake" (
  "singleton_key" BOOLEAN NOT NULL DEFAULT true,
  "requested_generation" BIGINT NOT NULL DEFAULT 0,
  "acknowledged_generation" BIGINT NOT NULL DEFAULT 0,
  "latest_cause" TEXT,
  "latest_requested_at" TIMESTAMP(6) WITH TIME ZONE,
  "latest_delivery_generation" BIGINT,
  "latest_delivery_state" TEXT,
  "last_delivery_attempt_at" TIMESTAMP(6) WITH TIME ZONE,
  "latest_delivery_failure_code" TEXT,
  "row_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_reconciliation_job_wake_pkey" PRIMARY KEY ("singleton_key"),
  CONSTRAINT "manifest_reconciliation_job_wake_shape_check" CHECK (
    "singleton_key" = true
    AND "requested_generation" >= 0
    AND "acknowledged_generation" BETWEEN 0 AND "requested_generation"
    AND "row_version" > 0
    AND ("requested_generation" = 0) = ("latest_cause" IS NULL)
    AND ("requested_generation" = 0) = ("latest_requested_at" IS NULL)
    AND ("latest_cause" IS NULL OR "latest_cause" IN (
      'provider_completion', 'manifest_eligibility_change', 'continuation'
    ))
    AND ("latest_delivery_generation" IS NULL) = ("latest_delivery_state" IS NULL)
    AND ("latest_delivery_generation" IS NULL) = ("last_delivery_attempt_at" IS NULL)
    AND ("latest_delivery_generation" IS NULL OR
      "latest_delivery_generation" BETWEEN 1 AND "requested_generation")
    AND ("latest_delivery_state" IS NULL OR "latest_delivery_state" IN (
      'pending', 'accepted', 'delivered', 'retry_wait', 'failed'
    ))
    AND (
      ("latest_delivery_state" IN ('retry_wait', 'failed')
        AND "latest_delivery_failure_code" ~ '^[A-Z0-9_]{1,128}$')
      OR
      (coalesce("latest_delivery_state", '') NOT IN ('retry_wait', 'failed')
        AND "latest_delivery_failure_code" IS NULL)
    )
  )
);

CREATE TABLE "manifest_reconciliation_job_schedule" (
  "singleton_key" BOOLEAN NOT NULL DEFAULT true,
  "lifecycle" TEXT NOT NULL DEFAULT 'pending_activation',
  "schedule_epoch" BIGINT NOT NULL DEFAULT 0,
  "cadence_seconds" INTEGER NOT NULL DEFAULT 60,
  "baseline_at" TIMESTAMP(6) WITH TIME ZONE,
  "activated_at" TIMESTAMP(6) WITH TIME ZONE,
  "paused_at" TIMESTAMP(6) WITH TIME ZONE,
  "last_admitted_window_index" BIGINT,
  "last_scheduled_checkin_at" TIMESTAMP(6) WITH TIME ZONE,
  "next_expected_checkin_at" TIMESTAMP(6) WITH TIME ZONE,
  "row_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_reconciliation_job_schedule_pkey" PRIMARY KEY ("singleton_key"),
  CONSTRAINT "manifest_reconciliation_job_schedule_shape_check" CHECK (
    "singleton_key" = true
    AND "lifecycle" IN ('pending_activation', 'active', 'paused')
    AND "schedule_epoch" >= 0
    AND "cadence_seconds" = 60
    AND "row_version" > 0
    AND ("last_admitted_window_index" IS NULL OR "last_admitted_window_index" >= 1)
    AND ("last_admitted_window_index" IS NULL) = ("last_scheduled_checkin_at" IS NULL)
    AND (
      ("lifecycle" = 'pending_activation'
        AND "schedule_epoch" = 0 AND "baseline_at" IS NULL
        AND "activated_at" IS NULL AND "paused_at" IS NULL
        AND "last_admitted_window_index" IS NULL
        AND "next_expected_checkin_at" IS NULL)
      OR
      ("lifecycle" = 'active'
        AND "schedule_epoch" >= 1 AND "baseline_at" IS NOT NULL
        AND "activated_at" IS NOT NULL AND "paused_at" IS NULL
        AND "next_expected_checkin_at" IS NOT NULL
        AND "next_expected_checkin_at" > "baseline_at")
      OR
      ("lifecycle" = 'paused'
        AND "schedule_epoch" >= 1 AND "baseline_at" IS NOT NULL
        AND "activated_at" IS NOT NULL AND "paused_at" IS NOT NULL
        AND "paused_at" >= "activated_at"
        AND "next_expected_checkin_at" IS NULL)
    )
  )
);

CREATE TABLE "manifest_reconciliation_job_invocations" (
  "run_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "delivery_key_digest" CHAR(64) NOT NULL,
  "trigger_evidence_digest" CHAR(64) NOT NULL,
  "delivery_issued_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "delivery_expires_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "trigger_kind" TEXT NOT NULL,
  "lifecycle_state" TEXT NOT NULL DEFAULT 'running',
  "outcome" TEXT,
  "observed_wake_generation" BIGINT,
  "schedule_epoch" BIGINT,
  "schedule_window_index" BIGINT,
  "scheduled_due_at" TIMESTAMP(6) WITH TIME ZONE,
  "scheduled_checkin_at" TIMESTAMP(6) WITH TIME ZONE,
  "requested_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "started_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "finished_at" TIMESTAMP(6) WITH TIME ZONE,
  "ownership_key" TEXT,
  "ownership_token" UUID,
  "ownership_expires_at" TIMESTAMP(6) WITH TIME ZONE,
  "before_lane_position" BIGINT,
  "after_lane_position" BIGINT,
  "before_settled_position" BIGINT,
  "after_settled_position" BIGINT,
  "cycle_count" INTEGER NOT NULL DEFAULT 0,
  "promotion_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "publication_count" INTEGER NOT NULL DEFAULT 0,
  "operation_count" INTEGER NOT NULL DEFAULT 0,
  "related_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "related_attempt_set_digest" CHAR(64) NOT NULL,
  "safe_failure_code" TEXT,
  "continuation_generation" BIGINT,
  "result_active_generation" BIGINT,
  "result_public_release_id" UUID,
  "result_release_fingerprint" CHAR(64),
  "retention_protected" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_reconciliation_job_invocations_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "manifest_reconciliation_job_invocations_delivery_key"
    UNIQUE ("delivery_key_digest"),
  CONSTRAINT "manifest_reconciliation_job_invocations_delivery_check" CHECK (
    "delivery_key_digest" ~ '^[0-9a-f]{64}$'
    AND "trigger_evidence_digest" ~ '^[0-9a-f]{64}$'
    AND "delivery_expires_at" = "delivery_issued_at" + interval '30 days'
    AND "requested_at" >= "delivery_issued_at"
    AND "started_at" >= "requested_at"
  ),
  CONSTRAINT "manifest_reconciliation_job_invocations_trigger_check" CHECK (
    "trigger_kind" IN ('change_wake', 'reconciliation_cron', 'manual', 'continuation')
    AND (
      ("trigger_kind" = 'reconciliation_cron'
        AND "schedule_epoch" >= 1 AND "schedule_window_index" >= 1
        AND "scheduled_due_at" IS NOT NULL AND "scheduled_checkin_at" IS NOT NULL)
      OR
      ("trigger_kind" <> 'reconciliation_cron'
        AND "schedule_epoch" IS NULL AND "schedule_window_index" IS NULL
        AND "scheduled_due_at" IS NULL AND "scheduled_checkin_at" IS NULL)
    )
    AND ("observed_wake_generation" IS NULL OR "observed_wake_generation" >= 1)
    AND ("trigger_kind" NOT IN ('change_wake', 'continuation')
      OR "observed_wake_generation" IS NOT NULL)
  ),
  CONSTRAINT "manifest_reconciliation_job_invocations_lifecycle_check" CHECK (
    "lifecycle_state" IN ('running', 'terminal')
    AND (
      ("lifecycle_state" = 'running' AND "outcome" IS NULL
        AND "finished_at" IS NULL
        AND "ownership_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
        AND "ownership_token" IS NOT NULL
        AND "ownership_expires_at" > "started_at"
        AND "safe_failure_code" IS NULL
        AND "continuation_generation" IS NULL
        AND "result_active_generation" IS NULL
        AND "result_public_release_id" IS NULL
        AND "result_release_fingerprint" IS NULL)
      OR
      ("lifecycle_state" = 'terminal'
        AND "outcome" IN ('caught_up', 'no_change', 'coalesced',
          'continuation_required', 'deferred', 'blocked', 'failed')
        AND "finished_at" >= "started_at"
        AND "ownership_key" IS NULL AND "ownership_token" IS NULL
        AND "ownership_expires_at" IS NULL
        AND (("outcome" = 'continuation_required') =
          ("continuation_generation" IS NOT NULL))
        AND ("continuation_generation" IS NULL OR
          "continuation_generation" > coalesce("observed_wake_generation", 0))
        AND ("safe_failure_code" IS NULL OR
          "safe_failure_code" ~ '^[A-Z0-9_]{1,128}$')
        AND ("result_public_release_id" IS NULL) =
          ("result_release_fingerprint" IS NULL)
        AND ("result_active_generation" IS NULL OR "result_active_generation" >= 0)
        AND ("result_public_release_id" IS NULL OR "result_active_generation" > 0)
        AND ("result_release_fingerprint" IS NULL OR
          "result_release_fingerprint" ~ '^[0-9a-f]{64}$'))
    )
  ),
  CONSTRAINT "manifest_reconciliation_job_invocations_progress_check" CHECK (
    ("before_lane_position" IS NULL) = ("after_lane_position" IS NULL)
    AND ("before_lane_position" IS NULL OR
      ("before_lane_position" >= 0 AND "after_lane_position" >= "before_lane_position"))
    AND ("before_settled_position" IS NULL) = ("after_settled_position" IS NULL)
    AND ("before_settled_position" IS NULL OR
      ("before_settled_position" >= 0 AND "after_settled_position" >= "before_settled_position"))
    AND "cycle_count" BETWEEN 0 AND 1000000
    AND "promotion_attempt_count" BETWEEN 0 AND 25
    AND "publication_count" BETWEEN 0 AND "promotion_attempt_count"
    AND "operation_count" BETWEEN 0 AND 1000000
    AND "related_attempt_count" = "promotion_attempt_count"
    AND "related_attempt_set_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "manifest_reconciliation_job_invocations_history_idx"
  ON "manifest_reconciliation_job_invocations" ("started_at" DESC, "run_id" DESC);
CREATE INDEX "manifest_reconciliation_job_invocations_running_idx"
  ON "manifest_reconciliation_job_invocations" ("ownership_expires_at")
  WHERE "lifecycle_state" = 'running';
CREATE INDEX "manifest_reconciliation_job_invocations_retention_idx"
  ON "manifest_reconciliation_job_invocations" ("finished_at" DESC, "run_id" DESC)
  WHERE "lifecycle_state" = 'terminal' AND "retention_protected" = false;

CREATE TABLE "manifest_reconciliation_job_delivery_tombstones" (
  "delivery_key_digest" CHAR(64) NOT NULL,
  "trigger_evidence_digest" CHAR(64) NOT NULL,
  "invocation_run_id" UUID,
  "trigger_kind" TEXT NOT NULL,
  "issued_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "expires_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_reconciliation_job_delivery_tombstones_pkey"
    PRIMARY KEY ("delivery_key_digest"),
  CONSTRAINT "manifest_reconciliation_job_delivery_tombstones_invocation_key"
    UNIQUE ("invocation_run_id"),
  CONSTRAINT "manifest_reconciliation_job_delivery_tombstones_invocation_fkey"
    FOREIGN KEY ("invocation_run_id")
    REFERENCES "manifest_reconciliation_job_invocations"("run_id")
    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "manifest_reconciliation_job_delivery_tombstones_shape_check" CHECK (
    "delivery_key_digest" ~ '^[0-9a-f]{64}$'
    AND "trigger_evidence_digest" ~ '^[0-9a-f]{64}$'
    AND "trigger_kind" IN ('change_wake', 'reconciliation_cron', 'manual', 'continuation')
    AND "expires_at" = "issued_at" + interval '30 days'
  )
);

CREATE INDEX "manifest_reconciliation_job_delivery_tombstones_expiry_idx"
  ON "manifest_reconciliation_job_delivery_tombstones"
    ("expires_at", "delivery_key_digest");

CREATE TABLE "manifest_reconciliation_invocation_details" (
  "run_id" UUID NOT NULL,
  "attempt_count" INTEGER NOT NULL,
  "operation_count" INTEGER NOT NULL,
  "attempt_set_digest" CHAR(64) NOT NULL,
  "canonical_detail_body" TEXT NOT NULL,
  "canonical_detail_digest" CHAR(64) NOT NULL,
  "observed_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_reconciliation_invocation_details_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "manifest_reconciliation_invocation_details_invocation_fkey"
    FOREIGN KEY ("run_id")
    REFERENCES "manifest_reconciliation_job_invocations"("run_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "manifest_reconciliation_invocation_details_shape_check" CHECK (
    "attempt_count" BETWEEN 1 AND 25
    AND "operation_count" BETWEEN 0 AND 1000000
    AND "attempt_set_digest" ~ '^[0-9a-f]{64}$'
    AND octet_length("canonical_detail_body") BETWEEN 2 AND 65536
    AND "canonical_detail_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "manifest_gate_intents" (
  "provider_id" UUID NOT NULL,
  "requested_generation" BIGINT NOT NULL DEFAULT 0,
  "acknowledged_generation" BIGINT NOT NULL DEFAULT 0,
  "latest_cause" TEXT,
  "latest_evidence_digest" CHAR(64),
  "latest_requested_at" TIMESTAMP(6) WITH TIME ZONE,
  "row_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manifest_gate_intents_pkey" PRIMARY KEY ("provider_id"),
  CONSTRAINT "manifest_gate_intents_provider_fkey" FOREIGN KEY ("provider_id")
    REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "manifest_gate_intents_shape_check" CHECK (
    "requested_generation" >= 0
    AND "acknowledged_generation" BETWEEN 0 AND "requested_generation"
    AND "row_version" > 0
    AND ("requested_generation" = 0) = ("latest_cause" IS NULL)
    AND ("requested_generation" = 0) = ("latest_evidence_digest" IS NULL)
    AND ("requested_generation" = 0) = ("latest_requested_at" IS NULL)
    AND ("latest_cause" IS NULL OR "latest_cause" IN (
      'provider_completion', 'manifest_eligibility_change', 'continuation'
    ))
    AND ("latest_evidence_digest" IS NULL OR
      "latest_evidence_digest" ~ '^[0-9a-f]{64}$')
  )
);

CREATE INDEX "manifest_gate_intents_pending_idx"
  ON "manifest_gate_intents"
    ("acknowledged_generation", "requested_generation", "updated_at")
  WHERE "requested_generation" > "acknowledged_generation";

CREATE TABLE "provider_promotion_invocation_projections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider_id" UUID NOT NULL,
  "provider_invocation_id_digest" CHAR(64) NOT NULL,
  "projection_digest" CHAR(64) NOT NULL,
  "trigger_kind" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "scheduled_checkin_at" TIMESTAMP(6) WITH TIME ZONE,
  "started_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "finished_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "before_lane_position" BIGINT,
  "after_lane_position" BIGINT,
  "before_settled_position" BIGINT,
  "after_settled_position" BIGINT,
  "cycle_count" INTEGER NOT NULL,
  "promotion_attempt_count" INTEGER NOT NULL,
  "publication_count" INTEGER NOT NULL,
  "operation_count" INTEGER NOT NULL,
  "safe_failure_code" TEXT,
  "canonical_detail_body" TEXT NOT NULL,
  "canonical_detail_digest" CHAR(64) NOT NULL,
  "projected_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_promotion_invocation_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_promotion_invocation_projections_identity_key"
    UNIQUE ("provider_id", "provider_invocation_id_digest"),
  CONSTRAINT "provider_promotion_invocation_projections_provider_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "providers"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "provider_promotion_invocation_projections_shape_check" CHECK (
    "provider_invocation_id_digest" ~ '^[0-9a-f]{64}$'
    AND "projection_digest" ~ '^[0-9a-f]{64}$'
    AND "trigger_kind" IN ('change_wake', 'reconciliation_cron', 'manual', 'continuation')
    AND "outcome" IN ('caught_up', 'no_change', 'coalesced',
      'continuation_required', 'deferred', 'blocked', 'failed')
    AND (("trigger_kind" = 'reconciliation_cron') =
      ("scheduled_checkin_at" IS NOT NULL))
    AND "finished_at" >= "started_at"
    AND ("before_lane_position" IS NULL) = ("after_lane_position" IS NULL)
    AND ("before_lane_position" IS NULL OR
      ("before_lane_position" >= 0 AND "after_lane_position" >= "before_lane_position"))
    AND ("before_settled_position" IS NULL) = ("after_settled_position" IS NULL)
    AND ("before_settled_position" IS NULL OR
      ("before_settled_position" >= 0 AND "after_settled_position" >= "before_settled_position"))
    AND "cycle_count" BETWEEN 0 AND 1000000
    AND "promotion_attempt_count" BETWEEN 0 AND 25
    AND "publication_count" BETWEEN 0 AND "promotion_attempt_count"
    AND "operation_count" BETWEEN 0 AND 1000000
    AND ("safe_failure_code" IS NULL OR
      "safe_failure_code" ~ '^[A-Z0-9_]{1,128}$')
    AND octet_length("canonical_detail_body") BETWEEN 2 AND 65536
    AND "canonical_detail_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "provider_promotion_invocation_projections_history_idx"
  ON "provider_promotion_invocation_projections"
    ("provider_id", "started_at" DESC, "id" DESC);

INSERT INTO "manifest_reconciliation_job_wake" ("singleton_key") VALUES (true);
INSERT INTO "manifest_reconciliation_job_schedule" ("singleton_key") VALUES (true);

CREATE TRIGGER "manifest_reconciliation_job_wake_row_version_guard"
  BEFORE UPDATE ON "manifest_reconciliation_job_wake"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "manifest_reconciliation_job_schedule_row_version_guard"
  BEFORE UPDATE ON "manifest_reconciliation_job_schedule"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "manifest_gate_intents_row_version_guard"
  BEFORE UPDATE ON "manifest_gate_intents"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();

CREATE FUNCTION "guard_terminal_manifest_reconciliation_invocation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."lifecycle_state" = 'terminal' AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (
      OLD."retention_protected" = true
      AND NEW."retention_protected" = false
      AND NEW."updated_at" >= OLD."updated_at"
      AND (to_jsonb(NEW) - 'retention_protected' - 'updated_at') =
        (to_jsonb(OLD) - 'retention_protected' - 'updated_at')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'terminal manifest reconciliation invocation is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_terminal_manifest_reconciliation_invocation"
  BEFORE UPDATE ON "manifest_reconciliation_job_invocations"
  FOR EACH ROW EXECUTE FUNCTION "guard_terminal_manifest_reconciliation_invocation"();

CREATE FUNCTION "guard_manifest_reconciliation_invocation_detail"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "lifecycle_state" INTO parent_state
    FROM "manifest_reconciliation_job_invocations" WHERE "run_id" = OLD."run_id"
    FOR SHARE;
    IF parent_state IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'manifest reconciliation invocation detail is parent-owned';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."run_id" IS DISTINCT FROM OLD."run_id" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'manifest reconciliation invocation detail identity is immutable';
  END IF;
  SELECT "lifecycle_state" INTO parent_state
  FROM "manifest_reconciliation_job_invocations" WHERE "run_id" = NEW."run_id"
  FOR SHARE;
  IF parent_state = 'terminal' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'terminal manifest reconciliation invocation detail is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_manifest_reconciliation_invocation_detail"
  BEFORE INSERT OR UPDATE OR DELETE ON "manifest_reconciliation_invocation_details"
  FOR EACH ROW EXECUTE FUNCTION "guard_manifest_reconciliation_invocation_detail"();

CREATE FUNCTION "guard_manifest_reconciliation_delivery_tombstone"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT (
    OLD."invocation_run_id" IS NOT NULL
    AND NEW."invocation_run_id" IS NULL
    AND (to_jsonb(NEW) - 'invocation_run_id') =
      (to_jsonb(OLD) - 'invocation_run_id')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'manifest reconciliation delivery tombstone is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_manifest_reconciliation_delivery_tombstone"
  BEFORE UPDATE ON "manifest_reconciliation_job_delivery_tombstones"
  FOR EACH ROW EXECUTE FUNCTION "guard_manifest_reconciliation_delivery_tombstone"();

CREATE FUNCTION "guard_provider_promotion_invocation_projection"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'provider promotion invocation projection is immutable';
END;
$$;

CREATE TRIGGER "guard_provider_promotion_invocation_projection"
  BEFORE UPDATE ON "provider_promotion_invocation_projections"
  FOR EACH ROW EXECUTE FUNCTION "guard_provider_promotion_invocation_projection"();

COMMIT;
