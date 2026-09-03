BEGIN;

ALTER TABLE "manifest_reconciliation_job_invocations"
  ADD COLUMN "monitoring_order_key" CHAR(64)
  GENERATED ALWAYS AS (
    encode(sha256(
      '\x70726f6d6f74696f6e2d6a6f622d6d6f6e69746f72696e672d6f726465722d76313a6d616e69666573743a'::bytea
      || uuid_send("run_id")
    ), 'hex')
  ) STORED;

ALTER TABLE "provider_promotion_invocation_projections"
  ADD COLUMN "monitoring_order_key" CHAR(64)
  GENERATED ALWAYS AS (
    encode(sha256(
      '\x70726f6d6f74696f6e2d6a6f622d6d6f6e69746f72696e672d6f726465722d76313a70726f76696465723a'::bytea
      || uuid_send("id")
    ), 'hex')
  ) STORED;

-- Generated columns are populated after BEFORE UPDATE triggers run. Exclude the
-- derived ordering key from the terminal-row immutability comparison so the one
-- allowed retention release update remains possible.
CREATE OR REPLACE FUNCTION "guard_terminal_manifest_reconciliation_invocation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."lifecycle_state" = 'terminal' AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (
      OLD."retention_protected" = true
      AND NEW."retention_protected" = false
      AND NEW."updated_at" >= OLD."updated_at"
      AND (to_jsonb(NEW) - 'retention_protected' - 'updated_at' - 'monitoring_order_key') =
        (to_jsonb(OLD) - 'retention_protected' - 'updated_at' - 'monitoring_order_key')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'terminal manifest reconciliation invocation is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP INDEX "manifest_reconciliation_job_invocations_history_idx";
CREATE INDEX "manifest_reconciliation_job_invocations_history_idx"
  ON "manifest_reconciliation_job_invocations"
    ("started_at" DESC, "monitoring_order_key" DESC);

DROP INDEX "provider_promotion_invocation_projections_history_idx";
CREATE INDEX "provider_promotion_invocation_projections_history_idx"
  ON "provider_promotion_invocation_projections"
    ("provider_id", "started_at" DESC, "monitoring_order_key" DESC);

COMMIT;
