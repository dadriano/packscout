CREATE TABLE "provider_promotion_projection_outbox" (
  "activity_event_id" UUID NOT NULL,
  "invocation_run_id" UUID NOT NULL,
  "provider_invocation_id_digest" CHAR(64) NOT NULL,
  "provider_invocation_projection_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_promotion_projection_outbox_pkey"
    PRIMARY KEY ("activity_event_id"),
  CONSTRAINT "provider_promotion_projection_outbox_invocation_key"
    UNIQUE ("invocation_run_id"),
  CONSTRAINT "provider_promotion_projection_outbox_identity_key"
    UNIQUE ("provider_invocation_id_digest"),
  CONSTRAINT "provider_promotion_projection_outbox_shape_check" CHECK (
    "provider_invocation_id_digest" ~ '^[0-9a-f]{64}$'
    AND "provider_invocation_projection_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "provider_promotion_projection_outbox_activity_fkey"
    FOREIGN KEY ("activity_event_id")
    REFERENCES "provider_activity_outbox"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "provider_promotion_projection_outbox_invocation_fkey"
    FOREIGN KEY ("invocation_run_id")
    REFERENCES "provider_promotion_job_invocations"("run_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Relay-protected and acknowledged provider rows share one terminal-row cap.
DROP INDEX "provider_promotion_job_invocations_retention_idx";
CREATE INDEX "provider_promotion_job_invocations_retention_idx"
  ON "provider_promotion_job_invocations" ("finished_at" DESC, "run_id" DESC)
  WHERE "lifecycle_state" = 'terminal';

CREATE FUNCTION "guard_provider_promotion_projection_outbox"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'provider promotion projection outbox is immutable';
END;
$$;

CREATE TRIGGER "guard_provider_promotion_projection_outbox"
  BEFORE UPDATE ON "provider_promotion_projection_outbox"
  FOR EACH ROW EXECUTE FUNCTION "guard_provider_promotion_projection_outbox"();

CREATE INDEX "provider_activity_outbox_type_delivery_event_id_idx"
  ON "provider_activity_outbox"("event_type", "delivery_state", "event_at", "id");

-- Projection relay envelopes are transport records, not permanent provider
-- activity history. Only the bounded repository retention path may delete an
-- acknowledged envelope after its invocation-owned mapping has cascaded.
CREATE OR REPLACE FUNCTION "packscout_guard_activity_outbox"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."delivery_state" = 'delivered'
       AND OLD."event_type" = 'provider_promotion_invocation_terminal'
       AND NOT EXISTS (
         SELECT 1 FROM "provider_promotion_projection_outbox" AS mapping
         WHERE mapping."activity_event_id" = OLD.id
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'provider_activity_outbox_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."event_digest", NEW."event_type", NEW."severity",
    NEW."dedupe_key", NEW."recovery_key", NEW."local_run_id",
    NEW."local_quarantine_id", NEW."title", NEW."summary", NEW."evidence",
    NEW."event_at", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."event_digest", OLD."event_type", OLD."severity",
    OLD."dedupe_key", OLD."recovery_key", OLD."local_run_id",
    OLD."local_quarantine_id", OLD."title", OLD."summary", OLD."evidence",
    OLD."event_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'provider_activity_outbox_payload_immutable';
  END IF;
  IF NEW."delivery_attempt_count" < OLD."delivery_attempt_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'activity_delivery_attempt_regression';
  END IF;
  IF OLD."delivery_state" = 'delivered'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'activity_delivery_terminal_immutable';
  END IF;
  IF NEW."delivery_state" IS DISTINCT FROM OLD."delivery_state"
     AND NOT (
       OLD."delivery_state" = 'pending'
       AND NEW."delivery_state" = 'delivered'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'activity_delivery_transition_invalid';
  END IF;
  IF (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM
     (to_jsonb(OLD) - 'updated_at') THEN
    NEW."updated_at" := OLD."updated_at";
  ELSE
    NEW."updated_at" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
