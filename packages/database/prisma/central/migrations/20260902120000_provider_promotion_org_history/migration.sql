BEGIN;

ALTER TABLE "provider_promotion_invocation_projections"
  ADD COLUMN "organization_id" UUID;

-- Existing projections predate the tenant key. The provider relationship is
-- already mandatory, so central is the sole authority for this backfill.
ALTER TABLE "provider_promotion_invocation_projections"
  DISABLE TRIGGER "guard_provider_promotion_invocation_projection";

UPDATE "provider_promotion_invocation_projections" AS projection
SET "organization_id" = provider."organization_id"
FROM "providers" AS provider
WHERE provider."id" = projection."provider_id";

ALTER TABLE "provider_promotion_invocation_projections"
  ENABLE TRIGGER "guard_provider_promotion_invocation_projection";

ALTER TABLE "provider_promotion_invocation_projections"
  ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "provider_promotion_invocation_projections"
  DROP CONSTRAINT "provider_promotion_invocation_projections_provider_fkey",
  ADD CONSTRAINT "provider_promotion_invocation_projections_provider_org_fk"
    FOREIGN KEY ("provider_id", "organization_id")
    REFERENCES "providers" ("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "provider_promotion_invocation_projections_org_history_idx"
  ON "provider_promotion_invocation_projections"
    ("organization_id", "started_at" DESC, "monitoring_order_key" DESC);

COMMIT;
