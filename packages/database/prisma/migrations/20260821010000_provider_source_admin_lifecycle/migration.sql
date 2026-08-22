-- Task 004: pause is requested while a page owns the source, then finalized only
-- after that page reaches its durable commit boundary. No source pins move.
ALTER TABLE "provider_source_instances"
  ADD COLUMN "pause_requested_at" TIMESTAMPTZ(6);

ALTER TABLE "provider_source_instances"
  ADD CONSTRAINT "provider_source_instances_pause_request_check"
  CHECK ("pause_requested_at" IS NULL OR "state" = 'active');

CREATE INDEX "provider_source_instances_pause_request_idx"
ON "provider_source_instances" ("organization_id", "pause_requested_at")
WHERE "pause_requested_at" IS NOT NULL;

-- A disabled profile has no active pointer, so revocation recovery jobs carry
-- the exact blocked revision fence independently of an optional health episode.
ALTER TABLE "source_connection_test_jobs"
  ADD COLUMN "recovery_blocked_revision_id" UUID;

ALTER TABLE "source_connection_test_jobs"
  ADD CONSTRAINT "source_connection_test_jobs_recovery_blocked_revision_fk"
  FOREIGN KEY (
    "recovery_blocked_revision_id",
    "organization_id",
    "connection_profile_id"
  ) REFERENCES "source_connection_revisions" (
    "id",
    "organization_id",
    "connection_profile_id"
  ) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "source_connection_test_jobs_recovery_fence_idx"
ON "source_connection_test_jobs" (
  "organization_id",
  "connection_profile_id",
  "recovery_blocked_revision_id",
  "created_at"
)
WHERE "recovery_blocked_revision_id" IS NOT NULL;
