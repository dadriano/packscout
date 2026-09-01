BEGIN;

CREATE TABLE "promotion_job_liveness_evaluator_state" (
  "singleton_key" BOOLEAN NOT NULL DEFAULT true,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "lifecycle" TEXT NOT NULL DEFAULT 'pending_activation',
  "evaluator_epoch" BIGINT NOT NULL DEFAULT 0,
  "cadence_seconds" INTEGER NOT NULL DEFAULT 60,
  "baseline_at" TIMESTAMPTZ(6),
  "activated_at" TIMESTAMPTZ(6),
  "paused_at" TIMESTAMPTZ(6),
  "last_successful_window_index" BIGINT,
  "last_successful_evaluation_at" TIMESTAMPTZ(6),
  "evaluated_through" TIMESTAMPTZ(6),
  "roster_version" BIGINT,
  "roster_high_water" BIGINT,
  "roster_digest" CHAR(64),
  "expected_count" INTEGER,
  "reachable_count" INTEGER,
  "unavailable_count" INTEGER,
  "healthy_count" INTEGER,
  "overdue_count" INTEGER,
  "alerting_count" INTEGER,
  "manifest_evaluated" BOOLEAN,
  "last_failure_code" TEXT,
  "row_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_job_liveness_evaluator_state_pkey"
    PRIMARY KEY ("singleton_key"),
  CONSTRAINT "promotion_job_liveness_evaluator_state_shape_check" CHECK (
    "singleton_key" = true
    AND "state" IN ('pending', 'current', 'stale', 'failed')
    AND "lifecycle" IN ('pending_activation', 'active', 'paused')
    AND "evaluator_epoch" >= 0
    AND "cadence_seconds" = 60
    AND "row_version" > 0
    AND (
      ("lifecycle" = 'pending_activation'
        AND "evaluator_epoch" = 0
        AND "baseline_at" IS NULL
        AND "activated_at" IS NULL
        AND "paused_at" IS NULL
        AND "last_successful_window_index" IS NULL)
      OR
      ("lifecycle" = 'active'
        AND "evaluator_epoch" > 0
        AND "baseline_at" IS NOT NULL
        AND "activated_at" IS NOT NULL
        AND "paused_at" IS NULL
        AND "last_successful_window_index" >= 0
        AND "last_successful_evaluation_at" IS NOT NULL)
      OR
      ("lifecycle" = 'paused'
        AND "evaluator_epoch" > 0
        AND "baseline_at" IS NOT NULL
        AND "activated_at" IS NOT NULL
        AND "paused_at" >= "activated_at"
        AND "last_successful_window_index" >= 0
        AND "last_successful_evaluation_at" IS NOT NULL)
    )
    AND (
      (
        "last_successful_evaluation_at" IS NULL
        AND "evaluated_through" IS NULL
        AND "roster_version" IS NULL
        AND "roster_high_water" IS NULL
        AND "roster_digest" IS NULL
        AND "expected_count" IS NULL
        AND "reachable_count" IS NULL
        AND "unavailable_count" IS NULL
        AND "healthy_count" IS NULL
        AND "overdue_count" IS NULL
        AND "alerting_count" IS NULL
        AND "manifest_evaluated" IS NULL
      )
      OR
      (
        "last_successful_evaluation_at" IS NOT NULL
        AND "evaluated_through" IS NOT NULL
        AND "evaluated_through" = "last_successful_evaluation_at"
        AND "roster_version" >= 0
        AND "roster_high_water" >= 0
        AND "roster_digest" ~ '^[0-9a-f]{64}$'
        AND "expected_count" >= 1
        AND "reachable_count" >= 1
        AND "unavailable_count" >= 0
        AND "reachable_count" + "unavailable_count" = "expected_count"
        AND "healthy_count" >= 0
        AND "overdue_count" >= 0
        AND "alerting_count" >= 0
        AND "healthy_count" + "overdue_count" + "alerting_count"
          = "reachable_count"
        AND "manifest_evaluated" = true
      )
    )
    AND (
      ("state" IN ('pending', 'current') AND "last_failure_code" IS NULL)
      OR
      ("state" IN ('stale', 'failed')
        AND "last_failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$')
    )
  )
);

INSERT INTO "promotion_job_liveness_evaluator_state" ("singleton_key")
VALUES (true);

CREATE TABLE "promotion_job_liveness_observations" (
  "job_key" TEXT NOT NULL,
  "job_kind" TEXT NOT NULL,
  "organization_id" UUID,
  "provider_id" UUID,
  "evidence_source" TEXT NOT NULL,
  "route_failure_code" TEXT,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
  "trusted_observed_at" TIMESTAMPTZ(6),
  "schedule_lifecycle" TEXT,
  "schedule_epoch" BIGINT,
  "schedule_health" TEXT,
  "latest_countable_window_index" BIGINT,
  "last_admitted_window_index" BIGINT,
  "missed_window_count" BIGINT,
  "last_scheduled_checkin_at" TIMESTAMPTZ(6),
  "row_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_job_liveness_observations_pkey" PRIMARY KEY ("job_key"),
  CONSTRAINT "promotion_job_liveness_observations_provider_organization_fk"
    FOREIGN KEY ("provider_id", "organization_id")
    REFERENCES "providers"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotion_job_liveness_observations_identity_check" CHECK (
    ("job_kind" = 'manifest_reconciliation'
      AND "job_key" = 'manifest'
      AND "organization_id" IS NULL
      AND "provider_id" IS NULL)
    OR
    ("job_kind" = 'provider_publication'
      AND "job_key" = 'provider:' || "provider_id"::text
      AND "organization_id" IS NOT NULL
      AND "provider_id" IS NOT NULL)
  ),
  CONSTRAINT "promotion_job_liveness_observations_evidence_check" CHECK (
    "evidence_source" IN ('live', 'last_known', 'unavailable')
    AND "row_version" > 0
    AND (
      ("evidence_source" = 'live'
        AND "route_failure_code" IS NULL
        AND "trusted_observed_at" IS NOT NULL)
      OR
      ("evidence_source" = 'last_known'
        AND "route_failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$'
        AND "trusted_observed_at" IS NOT NULL)
      OR
      ("evidence_source" = 'unavailable'
        AND "route_failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$'
        AND "trusted_observed_at" IS NULL)
    )
  ),
  CONSTRAINT "promotion_job_liveness_observations_judgment_check" CHECK (
    (
      "trusted_observed_at" IS NULL
      AND "schedule_lifecycle" IS NULL
      AND "schedule_epoch" IS NULL
      AND "schedule_health" IS NULL
      AND "latest_countable_window_index" IS NULL
      AND "last_admitted_window_index" IS NULL
      AND "missed_window_count" IS NULL
      AND "last_scheduled_checkin_at" IS NULL
    )
    OR
    (
      "trusted_observed_at" IS NOT NULL
      AND "schedule_lifecycle" IN ('pending_activation', 'active', 'paused')
      AND "schedule_epoch" >= 0
      AND "schedule_health" IN ('inactive', 'healthy', 'overdue', 'alerting')
      AND "latest_countable_window_index" >= 0
      AND "last_admitted_window_index" >= 0
      AND "missed_window_count" >= 0
      AND (
        ("schedule_lifecycle" = 'active'
          AND "schedule_epoch" > 0
          AND "schedule_health" IN ('healthy', 'overdue', 'alerting'))
        OR
        ("schedule_lifecycle" IN ('pending_activation', 'paused')
          AND "schedule_health" = 'inactive'
          AND "missed_window_count" = 0)
      )
    )
  )
);

CREATE UNIQUE INDEX "promotion_job_liveness_observations_provider_unique"
  ON "promotion_job_liveness_observations" ("provider_id")
  WHERE "provider_id" IS NOT NULL;
CREATE INDEX "promotion_job_liveness_observations_evaluated_idx"
  ON "promotion_job_liveness_observations" ("evaluated_at" DESC, "job_key");

CREATE TABLE "promotion_job_liveness_conditions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subject_kind" TEXT NOT NULL,
  "subject_key" TEXT NOT NULL,
  "organization_id" UUID,
  "provider_id" UUID,
  "schedule_epoch" BIGINT NOT NULL,
  "condition_state" TEXT NOT NULL,
  "anchor_last_scheduled_checkin_at" TIMESTAMPTZ(6),
  "latest_missed_window_count" BIGINT NOT NULL,
  "opened_at" TIMESTAMPTZ(6) NOT NULL,
  "latest_evaluated_at" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at" TIMESTAMPTZ(6),
  "delivery_action" TEXT,
  "delivery_state" TEXT,
  "delivery_event_id" UUID,
  "delivery_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_delivery_attempt_at" TIMESTAMPTZ(6),
  "next_delivery_attempt_at" TIMESTAMPTZ(6),
  "last_delivery_failure_code" TEXT,
  "row_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_job_liveness_conditions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotion_job_liveness_conditions_episode_unique"
    UNIQUE ("subject_kind", "subject_key", "schedule_epoch"),
  CONSTRAINT "promotion_job_liveness_conditions_provider_organization_fk"
    FOREIGN KEY ("provider_id", "organization_id")
    REFERENCES "providers"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotion_job_liveness_conditions_identity_check" CHECK (
    ("subject_kind" = 'manifest_schedule'
      AND "subject_key" = 'manifest'
      AND "organization_id" IS NULL
      AND "provider_id" IS NULL)
    OR
    ("subject_kind" = 'provider_schedule'
      AND "subject_key" = "provider_id"::text
      AND "organization_id" IS NOT NULL
      AND "provider_id" IS NOT NULL)
  ),
  CONSTRAINT "promotion_job_liveness_conditions_shape_check" CHECK (
    "schedule_epoch" > 0
    AND "condition_state" IN ('active', 'resolved')
    AND "latest_missed_window_count" >= 0
    AND "opened_at" <= "latest_evaluated_at"
    AND "row_version" > 0
    AND (
      ("condition_state" = 'active'
        AND "resolved_at" IS NULL
        AND "latest_missed_window_count" >= 3
        AND coalesce("delivery_action", '') <> 'recover')
      OR
      ("condition_state" = 'resolved'
        AND "resolved_at" >= "opened_at")
    )
    AND (
      ("delivery_action" IS NULL
        AND "delivery_state" IS NULL
        AND "delivery_event_id" IS NULL
        AND "delivery_attempt_count" = 0
        AND "last_delivery_attempt_at" IS NULL
        AND "next_delivery_attempt_at" IS NULL
        AND "last_delivery_failure_code" IS NULL)
      OR
      ("delivery_action" IN ('raise', 'recover')
        AND "delivery_state" IN ('pending', 'retry_wait', 'delivered')
        AND "delivery_event_id" IS NOT NULL
        AND "delivery_attempt_count" >= 0
        AND (
          ("delivery_attempt_count" = 0
            AND "last_delivery_attempt_at" IS NULL)
          OR
          ("delivery_attempt_count" > 0
            AND "last_delivery_attempt_at" IS NOT NULL)
        )
        AND (
          ("delivery_state" = 'retry_wait'
            AND "last_delivery_failure_code" ~ '^[A-Z][A-Z0-9_]{0,127}$'
            AND "next_delivery_attempt_at" IS NOT NULL)
          OR
          ("delivery_state" IN ('pending', 'delivered')
            AND "last_delivery_failure_code" IS NULL
            AND "next_delivery_attempt_at" IS NULL)
        ))
    )
  )
);

CREATE INDEX "promotion_job_liveness_conditions_delivery_idx"
  ON "promotion_job_liveness_conditions"
    ("next_delivery_attempt_at", "latest_evaluated_at", "id")
  WHERE "delivery_state" IN ('pending', 'retry_wait');
CREATE INDEX "promotion_job_liveness_conditions_subject_idx"
  ON "promotion_job_liveness_conditions"
    ("subject_kind", "subject_key", "condition_state", "schedule_epoch" DESC);

CREATE TRIGGER "promotion_job_liveness_evaluator_state_row_version_guard"
  BEFORE UPDATE ON "promotion_job_liveness_evaluator_state"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "promotion_job_liveness_observations_row_version_guard"
  BEFORE UPDATE ON "promotion_job_liveness_observations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "promotion_job_liveness_conditions_row_version_guard"
  BEFORE UPDATE ON "promotion_job_liveness_conditions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();

COMMIT;
