-- CreateEnum
CREATE TYPE "connection_profile_state" AS ENUM ('draft', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "connection_revision_state" AS ENUM ('candidate', 'active', 'retired', 'revoked');

-- CreateEnum
CREATE TYPE "provider_source_instance_state" AS ENUM ('draft', 'paused', 'active', 'disabled', 'replaced');

-- CreateEnum
CREATE TYPE "source_continuation_kind" AS ENUM ('continue', 'poll_after');

-- CreateEnum
CREATE TYPE "source_delivery_disposition" AS ENUM ('inserted', 'revised', 'duplicate', 'quarantined');

-- CreateEnum
CREATE TYPE "source_diagnostic_scope" AS ENUM ('source', 'connection');

-- CreateEnum
CREATE TYPE "source_diagnostic_severity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "source_diagnostic_correlation_kind" AS ENUM ('lifecycle', 'connection_test', 'source_test', 'run', 'page', 'connection_episode');

-- CreateEnum
CREATE TYPE "source_request_attempt_state" AS ENUM ('in_flight', 'captured', 'failed', 'connection_outcome_uncertain');

-- CreateEnum
CREATE TYPE "source_request_operation_kind" AS ENUM ('connection_test', 'source_test', 'page_read');

-- CreateEnum
CREATE TYPE "source_retention_state" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "source_test_job_state" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'fenced');

-- CreateEnum
CREATE TYPE "supervisor_epoch_state" AS ENUM ('active', 'fenced_draining', 'released', 'expired');

-- Clean forward enum migration. `sale` remains an event type, never a record kind.
ALTER TYPE "canonical_record_kind" RENAME VALUE 'sale' TO 'market_event';

-- AlterEnum
ALTER TYPE "import_trigger" ADD VALUE 'continuation';

ALTER TYPE "source_record_kind" RENAME VALUE 'sale' TO 'trade';

-- AlterTable
ALTER TABLE "import_pages" ADD COLUMN     "cursor_codec_version" TEXT,
ADD COLUMN     "cursor_generation" BIGINT,
ADD COLUMN     "connection_health_generation" BIGINT,
ADD COLUMN     "connection_profile_id" UUID,
ADD COLUMN     "connection_revision_id" UUID,
ADD COLUMN     "continuation_kind" "source_continuation_kind",
ADD COLUMN     "identity_namespace_key" TEXT,
ADD COLUMN     "mapper_key" TEXT,
ADD COLUMN     "mapper_version" TEXT,
ADD COLUMN     "minimum_delay_seconds" INTEGER,
ADD COLUMN     "next_cursor_fingerprint" TEXT,
ADD COLUMN     "normalized_contract_version" TEXT,
ADD COLUMN     "request_attempt_id" UUID,
ADD COLUMN     "requested_cursor_fingerprint" TEXT,
ADD COLUMN     "requested_cursor_key" TEXT,
ADD COLUMN     "source_adapter_version" TEXT,
ADD COLUMN     "source_instance_id" UUID,
ADD COLUMN     "source_revision_id" UUID,
ADD COLUMN     "source_type_key" TEXT,
ADD COLUMN     "supervisor_epoch_id" UUID;

-- AlterTable
ALTER TABLE "import_runs" ADD COLUMN     "cursor_codec_version" TEXT,
ADD COLUMN     "cursor_generation" BIGINT,
ADD COLUMN     "connection_profile_id" UUID,
ADD COLUMN     "connection_revision_id" UUID,
ADD COLUMN     "identity_namespace_key" TEXT,
ADD COLUMN     "lease_token" UUID,
ADD COLUMN     "mapper_key" TEXT,
ADD COLUMN     "mapper_version" TEXT,
ADD COLUMN     "normalized_contract_version" TEXT,
ADD COLUMN     "requested_cursor_fingerprint" TEXT,
ADD COLUMN     "requested_cursor_key" TEXT,
ADD COLUMN     "source_adapter_version" TEXT,
ADD COLUMN     "source_instance_id" UUID,
ADD COLUMN     "source_revision_id" UUID,
ADD COLUMN     "source_type_key" TEXT;

-- CreateTable
CREATE TABLE "source_connection_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "source_type_key" TEXT NOT NULL,
    "connection_type_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "state" "connection_profile_state" NOT NULL DEFAULT 'draft',
    "request_limit" INTEGER NOT NULL,
    "active_revision_id" UUID,
    "created_by_actor_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_connection_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_connection_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "source_type_key" TEXT NOT NULL,
    "source_adapter_version" TEXT NOT NULL,
    "configuration_ciphertext" BYTEA NOT NULL,
    "configuration_nonce" BYTEA NOT NULL,
    "configuration_auth_tag" BYTEA NOT NULL,
    "encryption_key_version" INTEGER NOT NULL,
    "configuration_fingerprint" TEXT NOT NULL,
    "state" "connection_revision_state" NOT NULL DEFAULT 'candidate',
    "health_generation" BIGINT NOT NULL DEFAULT 0,
    "created_by_actor_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_actor_key" TEXT,

    CONSTRAINT "source_connection_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_connection_test_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "blocking_episode_id" UUID,
    "expected_health_generation" BIGINT NOT NULL,
    "state" "source_test_job_state" NOT NULL DEFAULT 'queued',
    "requested_by_actor_key" TEXT NOT NULL,
    "claim_owner" TEXT,
    "claim_token" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "supervisor_epoch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "source_connection_test_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_connection_test_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "request_attempt_id" UUID NOT NULL,
    "request_terminal_state" "source_request_attempt_state" NOT NULL,
    "supervisor_epoch_id" UUID NOT NULL,
    "pre_test_health_generation" BIGINT NOT NULL,
    "resulting_health_generation" BIGINT NOT NULL,
    "outcome" TEXT NOT NULL,
    "safe_code" TEXT,
    "response_status" INTEGER,
    "latency_ms" INTEGER,
    "measurements_json" JSONB NOT NULL DEFAULT '{}',
    "tested_by_actor_key" TEXT NOT NULL,
    "tested_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_connection_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_connection_health_episodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "opened_health_generation" BIGINT NOT NULL,
    "closed_health_generation" BIGINT,
    "failure_class" TEXT NOT NULL,
    "safe_code" TEXT NOT NULL,
    "opened_by_request_attempt_id" UUID,
    "closed_by_test_result_id" UUID,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "source_connection_health_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_source_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_type_key" TEXT NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "state" "provider_source_instance_state" NOT NULL DEFAULT 'draft',
    "active_revision_id" UUID,
    "created_by_actor_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6),
    "paused_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "replaced_at" TIMESTAMPTZ(6),

    CONSTRAINT "provider_source_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_source_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "source_type_key" TEXT NOT NULL,
    "source_adapter_version" TEXT NOT NULL,
    "normalized_contract_version" TEXT NOT NULL,
    "mapper_key" TEXT NOT NULL,
    "mapper_version" TEXT NOT NULL,
    "identity_namespace_key" TEXT NOT NULL,
    "cursor_codec_version" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL,
    "configuration_hash" TEXT NOT NULL,
    "record_id_scopes_json" JSONB NOT NULL,
    "created_by_actor_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_source_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_source_schedule_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "freshness_grace_seconds" INTEGER NOT NULL DEFAULT 900,
    "created_by_actor_key" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_source_schedule_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_source_schedules" (
    "source_instance_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "active_schedule_revision_id" UUID NOT NULL,
    "next_due_at" TIMESTAMPTZ(6) NOT NULL,
    "last_due_at" TIMESTAMPTZ(6),
    "claim_owner" TEXT,
    "claim_token" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "last_claimed_at" TIMESTAMPTZ(6),
    "last_outcome" TEXT,
    "last_run_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_source_schedules_pkey" PRIMARY KEY ("source_instance_id")
);

-- CreateTable
CREATE TABLE "provider_source_cursors" (
    "source_instance_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "source_adapter_version" TEXT NOT NULL,
    "cursor_codec_version" TEXT NOT NULL,
    "cursor_generation" BIGINT NOT NULL DEFAULT 1,
    "cursor" TEXT,
    "cursor_fingerprint" TEXT,
    "advanced_by_run_id" UUID,
    "advanced_by_page_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_source_cursors_pkey" PRIMARY KEY ("source_instance_id")
);

-- CreateTable
CREATE TABLE "provider_source_cursor_fingerprints" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "cursor_generation" BIGINT NOT NULL,
    "source_adapter_version" TEXT NOT NULL,
    "cursor_codec_version" TEXT NOT NULL,
    "cursor_fingerprint" TEXT NOT NULL,
    "first_committed_run_id" UUID,
    "first_committed_page_id" UUID,
    "committed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_source_cursor_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_source_health_states" (
    "source_instance_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "health_generation" BIGINT NOT NULL DEFAULT 0,
    "last_attempted_at" TIMESTAMPTZ(6),
    "last_head_reached_at" TIMESTAMPTZ(6),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "latest_failure_code" TEXT,
    "recovered_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_source_health_states_pkey" PRIMARY KEY ("source_instance_id")
);

-- CreateTable
CREATE TABLE "provider_source_test_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "expected_health_generation" BIGINT NOT NULL,
    "state" "source_test_job_state" NOT NULL DEFAULT 'queued',
    "requested_by_actor_key" TEXT NOT NULL,
    "claim_owner" TEXT,
    "claim_token" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "supervisor_epoch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "provider_source_test_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_source_test_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "request_attempt_id" UUID NOT NULL,
    "request_terminal_state" "source_request_attempt_state" NOT NULL,
    "supervisor_epoch_id" UUID NOT NULL,
    "pre_test_health_generation" BIGINT NOT NULL,
    "resulting_health_generation" BIGINT NOT NULL,
    "outcome" TEXT NOT NULL,
    "safe_code" TEXT,
    "measurements_json" JSONB NOT NULL DEFAULT '{}',
    "tested_by_actor_key" TEXT NOT NULL,
    "tested_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_source_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_supervisor_epochs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_key" TEXT NOT NULL,
    "epoch_number" BIGINT NOT NULL,
    "state" "supervisor_epoch_state" NOT NULL DEFAULT 'active',
    "owner_key" TEXT NOT NULL,
    "lease_token" UUID NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL,
    "last_renewed_at" TIMESTAMPTZ(6) NOT NULL,
    "lease_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "takeover_not_before" TIMESTAMPTZ(6) NOT NULL,
    "fenced_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "safe_reason_code" TEXT,

    CONSTRAINT "source_supervisor_epochs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_request_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "operation_kind" "source_request_operation_kind" NOT NULL,
    "state" "source_request_attempt_state" NOT NULL DEFAULT 'in_flight',
    "request_lease_id" UUID NOT NULL,
    "claim_owner" TEXT NOT NULL,
    "claim_token" UUID NOT NULL,
    "supervisor_epoch_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "expected_health_generation" BIGINT NOT NULL,
    "provider_id" UUID,
    "source_instance_id" UUID,
    "source_revision_id" UUID,
    "connection_test_job_id" UUID,
    "source_test_job_id" UUID,
    "run_id" UUID,
    "page_number" INTEGER,
    "cursor_generation" BIGINT,
    "requested_cursor_fingerprint" TEXT,
    "requested_cursor_key" TEXT,
    "blocking_episode_id" UUID,
    "blocking_episode_connection_revision_id" UUID,
    "outcome_class" TEXT,
    "safe_code" TEXT,
    "safe_outcome_hash" TEXT,
    "response_status" INTEGER,
    "response_bytes" INTEGER,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "terminal_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "compacted_at" TIMESTAMPTZ(6),

    CONSTRAINT "source_request_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compact_source_request_attempts" (
    "request_attempt_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "operation_kind" "source_request_operation_kind" NOT NULL,
    "terminal_state" "source_request_attempt_state" NOT NULL,
    "outcome_class" TEXT NOT NULL,
    "safe_outcome_hash" TEXT NOT NULL,
    "request_lease_id" UUID NOT NULL,
    "claim_owner" TEXT NOT NULL,
    "claim_token" UUID NOT NULL,
    "supervisor_epoch_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "expected_health_generation" BIGINT NOT NULL,
    "provider_id" UUID,
    "source_instance_id" UUID,
    "source_revision_id" UUID,
    "connection_test_job_id" UUID,
    "source_test_job_id" UUID,
    "run_id" UUID,
    "page_number" INTEGER,
    "cursor_generation" BIGINT,
    "requested_cursor_fingerprint" TEXT,
    "requested_cursor_key" TEXT,
    "blocking_episode_id" UUID,
    "blocking_episode_connection_revision_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "terminal_at" TIMESTAMPTZ(6) NOT NULL,
    "compacted_at" TIMESTAMPTZ(6),

    CONSTRAINT "compact_source_request_attempts_pkey" PRIMARY KEY ("request_attempt_id")
);

-- CreateTable
CREATE TABLE "source_record_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "record_id_scope_key" TEXT NOT NULL,
    "provider_record_id" TEXT NOT NULL,
    "record_kind" "source_record_kind" NOT NULL,
    "record_discriminator" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_record_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_semantic_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "effective_source_time" TIMESTAMPTZ(6) NOT NULL,
    "normalized_contract_version" TEXT NOT NULL,
    "hash_version" TEXT NOT NULL,
    "normalized_content_hash" TEXT NOT NULL,
    "normalized_content_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_semantic_observations_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- Existing canonical revisions retain their legacy source-record origin. New
-- normalized imports use the semantic-observation origin exclusively.
ALTER TABLE "canonical_revisions"
  ALTER COLUMN "source_record_id" DROP NOT NULL,
  ADD COLUMN "origin_semantic_observation_id" UUID,
  ADD CONSTRAINT "canonical_revisions_exactly_one_source_origin_check"
  CHECK (("source_record_id" IS NULL) <> ("origin_semantic_observation_id" IS NULL));

-- CreateTable
CREATE TABLE "source_delivery_occurrences" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "source_instance_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "record_index" INTEGER NOT NULL,
    "source_record_id" UUID,
    "semantic_observation_id" UUID,
    "request_attempt_id" UUID NOT NULL,
    "source_type_key" TEXT NOT NULL,
    "source_adapter_version" TEXT NOT NULL,
    "normalized_contract_version" TEXT NOT NULL,
    "mapper_key" TEXT NOT NULL,
    "mapper_version" TEXT NOT NULL,
    "identity_namespace_key" TEXT NOT NULL,
    "cursor_codec_version" TEXT NOT NULL,
    "cursor_generation" BIGINT NOT NULL,
    "connection_health_generation" BIGINT NOT NULL,
    "supervisor_epoch_id" UUID NOT NULL,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL,
    "native_evidence_reference" TEXT NOT NULL,
    "disposition" "source_delivery_disposition" NOT NULL,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_delivery_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_processor_diagnostic_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "scope" "source_diagnostic_scope" NOT NULL,
    "correlation_kind" "source_diagnostic_correlation_kind" NOT NULL,
    "event_kind" TEXT NOT NULL,
    "severity" "source_diagnostic_severity" NOT NULL,
    "phase" TEXT NOT NULL,
    "safe_code" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_ms" INTEGER,
    "response_bytes" INTEGER,
    "counters_json" JSONB NOT NULL DEFAULT '{}',
    "evidence_json" JSONB NOT NULL DEFAULT '{}',
    "continuation_kind" "source_continuation_kind",
    "minimum_delay_seconds" INTEGER,
    "retry_delay_ms" INTEGER,
    "cursor_fingerprint" TEXT,
    "source_type_key" TEXT NOT NULL,
    "source_adapter_version" TEXT NOT NULL,
    "normalized_contract_version" TEXT,
    "provider_id" UUID,
    "source_instance_id" UUID,
    "source_revision_id" UUID,
    "connection_profile_id" UUID NOT NULL,
    "connection_revision_id" UUID NOT NULL,
    "blocking_episode_id" UUID,
    "blocking_episode_connection_revision_id" UUID,
    "connection_test_job_id" UUID,
    "source_test_job_id" UUID,
    "run_id" UUID,
    "page_id" UUID,
    "request_attempt_id" UUID,
    "run_trigger" "import_trigger",
    "command_correlation_key" TEXT,
    "audit_event_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "source_processor_diagnostic_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_retention_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "state" "source_retention_state" NOT NULL DEFAULT 'running',
    "batch_size" INTEGER NOT NULL,
    "raw_page_cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "quarantine_cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "diagnostic_cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "request_attempt_cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "resume_after_key" TEXT,
    "pages_expired_count" INTEGER NOT NULL DEFAULT 0,
    "quarantines_expired_count" INTEGER NOT NULL DEFAULT 0,
    "diagnostics_deleted_count" INTEGER NOT NULL DEFAULT 0,
    "attempts_compacted_count" INTEGER NOT NULL DEFAULT 0,
    "attempts_deleted_count" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "sanitized_summary" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "source_retention_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_connection_profiles_state_idx" ON "source_connection_profiles"("organization_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_profiles_tenant_unique" ON "source_connection_profiles"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_profiles_type_unique" ON "source_connection_profiles"("id", "organization_id", "source_type_key");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_profiles_name_unique" ON "source_connection_profiles"("organization_id", "source_type_key", "display_name");

-- CreateIndex
CREATE INDEX "source_connection_revisions_state_idx" ON "source_connection_revisions"("organization_id", "connection_profile_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_revisions_scope_unique" ON "source_connection_revisions"("id", "organization_id", "connection_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_revisions_adapter_scope_unique" ON "source_connection_revisions"("id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_revisions_number_unique" ON "source_connection_revisions"("connection_profile_id", "revision_number");

-- CreateIndex
CREATE INDEX "source_connection_test_jobs_queue_idx" ON "source_connection_test_jobs"("organization_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_jobs_scope_unique" ON "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_jobs_claim_unique" ON "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_jobs_result_unique" ON "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id");

-- CreateIndex
CREATE INDEX "source_connection_test_results_revision_idx" ON "source_connection_test_results"("organization_id", "connection_revision_id", "tested_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_results_job_unique" ON "source_connection_test_results"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_results_attempt_unique" ON "source_connection_test_results"("request_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_results_scope_unique" ON "source_connection_test_results"("id", "organization_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_test_results_profile_unique" ON "source_connection_test_results"("id", "organization_id", "connection_profile_id");

-- CreateIndex
CREATE INDEX "source_connection_health_episodes_profile_idx" ON "source_connection_health_episodes"("organization_id", "connection_profile_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_health_episodes_scope_unique" ON "source_connection_health_episodes"("id", "organization_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_connection_health_episodes_profile_unique" ON "source_connection_health_episodes"("id", "organization_id", "connection_profile_id");

-- CreateIndex
CREATE INDEX "provider_source_instances_provider_state_idx" ON "provider_source_instances"("organization_id", "provider_id", "state");

-- CreateIndex
CREATE INDEX "provider_source_instances_profile_idx" ON "provider_source_instances"("organization_id", "connection_profile_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_instances_scope_unique" ON "provider_source_instances"("id", "organization_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_instances_owner_unique" ON "provider_source_instances"("id", "organization_id", "provider_id", "source_type_key", "connection_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_scope_unique" ON "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_pins_unique" ON "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_cursor_unique" ON "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "source_adapter_version", "cursor_codec_version");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_diagnostic_unique" ON "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_test_profile_unique" ON "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_number_unique" ON "provider_source_revisions"("source_instance_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_revisions_configuration_unique" ON "provider_source_revisions"("source_instance_id", "configuration_hash");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_schedule_revisions_scope_unique" ON "provider_source_schedule_revisions"("id", "organization_id", "source_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_schedule_revisions_number_unique" ON "provider_source_schedule_revisions"("source_instance_id", "revision_number");

-- CreateIndex
CREATE INDEX "provider_source_schedules_due_idx" ON "provider_source_schedules"("organization_id", "next_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_schedules_scope_unique" ON "provider_source_schedules"("source_instance_id", "organization_id", "provider_id");

-- CreateIndex
CREATE INDEX "provider_source_cursors_provider_idx" ON "provider_source_cursors"("organization_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_cursors_scope_unique" ON "provider_source_cursors"("source_instance_id", "organization_id", "provider_id");

-- CreateIndex
CREATE INDEX "provider_source_cursor_fingerprints_generation_idx" ON "provider_source_cursor_fingerprints"("organization_id", "source_instance_id", "cursor_generation");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_cursor_fingerprints_cycle_unique" ON "provider_source_cursor_fingerprints"("source_instance_id", "cursor_generation", "cursor_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_health_states_scope_unique" ON "provider_source_health_states"("source_instance_id", "organization_id", "provider_id");

-- CreateIndex
CREATE INDEX "provider_source_test_jobs_queue_idx" ON "provider_source_test_jobs"("organization_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_jobs_scope_unique" ON "provider_source_test_jobs"("id", "organization_id", "source_instance_id", "source_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_jobs_operation_unique" ON "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_jobs_claim_unique" ON "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_jobs_result_unique" ON "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id");

-- CreateIndex
CREATE INDEX "provider_source_test_results_source_idx" ON "provider_source_test_results"("organization_id", "source_instance_id", "tested_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_results_job_unique" ON "provider_source_test_results"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_results_attempt_unique" ON "provider_source_test_results"("request_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_source_test_results_scope_unique" ON "provider_source_test_results"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE INDEX "source_supervisor_epochs_owner_idx" ON "source_supervisor_epochs"("environment_key", "state", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_supervisor_epochs_number_unique" ON "source_supervisor_epochs"("environment_key", "epoch_number");

-- CreateIndex
CREATE UNIQUE INDEX "source_supervisor_epochs_lease_token_unique" ON "source_supervisor_epochs"("lease_token");

-- CreateIndex
CREATE INDEX "source_request_attempts_uncertain_idx" ON "source_request_attempts"("state", "supervisor_epoch_id", "started_at");

-- CreateIndex
CREATE INDEX "source_request_attempts_retention_idx" ON "source_request_attempts"("organization_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_request_attempts_lease_unique" ON "source_request_attempts"("request_lease_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_request_attempts_scope_unique" ON "source_request_attempts"("id", "organization_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE INDEX "compact_source_request_attempts_tenant_idx" ON "compact_source_request_attempts"("organization_id", "compacted_at");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_lease_unique" ON "compact_source_request_attempts"("request_lease_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_scope_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_connection_test_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "connection_test_job_id", "supervisor_epoch_id", "expected_health_generation", "terminal_state");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_source_test_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "source_test_job_id", "supervisor_epoch_id", "expected_health_generation", "terminal_state");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_page_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "page_number");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_page_fence_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "page_number", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "cursor_generation", "requested_cursor_key");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_occurrence_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "cursor_generation");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_diagnostic_source_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_source_request_attempts_diagnostic_run_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "connection_profile_id", "connection_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_attempts_diagnostic_connection_test_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "connection_test_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_attempts_diagnostic_source_test_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "source_test_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_attempts_diagnostic_episode_unique" ON "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "blocking_episode_id", "blocking_episode_connection_revision_id");

-- CreateIndex
CREATE INDEX "source_record_identities_provider_idx" ON "source_record_identities"("organization_id", "provider_id", "record_kind");

-- CreateIndex
CREATE UNIQUE INDEX "source_record_identities_scope_unique" ON "source_record_identities"("id", "organization_id", "source_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_record_identities_tenant_unique" ON "source_record_identities"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_record_identities_stable_unique" ON "source_record_identities"("organization_id", "source_instance_id", "record_id_scope_key", "provider_record_id");

-- CreateIndex
CREATE INDEX "source_semantic_observations_record_idx" ON "source_semantic_observations"("organization_id", "source_record_id", "effective_source_time");

-- CreateIndex
CREATE UNIQUE INDEX "source_semantic_observations_tenant_unique" ON "source_semantic_observations"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_semantic_observations_scope_unique" ON "source_semantic_observations"("id", "organization_id", "source_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_semantic_observations_contract_scope_unique" ON "source_semantic_observations"("id", "organization_id", "source_record_id", "normalized_contract_version");

-- CreateIndex
CREATE UNIQUE INDEX "source_semantic_observations_identity_unique" ON "source_semantic_observations"("source_record_id", "effective_source_time", "normalized_contract_version", "hash_version", "normalized_content_hash");

-- CreateIndex
CREATE INDEX "canonical_revisions_origin_semantic_observation_idx" ON "canonical_revisions"("organization_id", "origin_semantic_observation_id");

-- CreateIndex
CREATE INDEX "source_delivery_occurrences_run_idx" ON "source_delivery_occurrences"("organization_id", "source_instance_id", "run_id");

-- CreateIndex
CREATE INDEX "source_delivery_occurrences_observation_idx" ON "source_delivery_occurrences"("semantic_observation_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_delivery_occurrences_page_index_unique" ON "source_delivery_occurrences"("page_id", "record_index");

-- CreateIndex
CREATE INDEX "source_processor_diagnostic_events_source_feed_idx" ON "source_processor_diagnostic_events"("organization_id", "source_instance_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "source_processor_diagnostic_events_connection_feed_idx" ON "source_processor_diagnostic_events"("organization_id", "connection_profile_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "source_processor_diagnostic_events_retention_idx" ON "source_processor_diagnostic_events"("organization_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_processor_diagnostic_events_tenant_unique" ON "source_processor_diagnostic_events"("id", "organization_id");

-- CreateIndex
CREATE INDEX "source_retention_executions_started_idx" ON "source_retention_executions"("organization_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_retention_executions_tenant_unique" ON "source_retention_executions"("id", "organization_id");

-- Composite lineage keys for source-supervised imports. Rows without source
-- pins remain outside these keys; every source-supervised row is fully scoped.
CREATE UNIQUE INDEX "audit_events_tenant_unique"
ON "audit_events" ("id", "organization_id");

CREATE UNIQUE INDEX "import_runs_source_scope_unique"
ON "import_runs" ("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id");

CREATE UNIQUE INDEX "import_runs_source_owner_unique"
ON "import_runs" ("id", "organization_id", "provider_id", "source_instance_id");

CREATE UNIQUE INDEX "import_runs_source_claim_unique"
ON "import_runs" ("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "requested_cursor_key", "lease_owner", "lease_token");

CREATE UNIQUE INDEX "import_runs_source_diagnostic_unique"
ON "import_runs" ("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "trigger");

CREATE UNIQUE INDEX "import_pages_source_scope_unique"
ON "import_pages" ("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id");

CREATE UNIQUE INDEX "import_pages_source_attempt_unique"
ON "import_pages" ("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "request_attempt_id", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "connection_health_generation");

CREATE UNIQUE INDEX "import_pages_source_cursor_unique"
ON "import_pages" ("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "cursor_generation", "next_cursor_fingerprint");

-- The authoritative cursor also records pages that intentionally advance to a
-- null cursor at provider head. Its position key therefore cannot depend on a
-- nullable fingerprint; cursor history keeps using the fingerprint-bound key.
CREATE UNIQUE INDEX "import_pages_source_cursor_position_unique"
ON "import_pages" ("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "cursor_generation");

CREATE UNIQUE INDEX "import_pages_source_diagnostic_unique"
ON "import_pages" ("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "request_attempt_id");

-- Current-source uniqueness. Rows without source pins remain outside the
-- source-instance lifecycle and are excluded from this partial index.
CREATE UNIQUE INDEX "provider_source_instances_current_unique"
ON "provider_source_instances" ("provider_id")
WHERE "state" IN ('paused', 'active');

CREATE UNIQUE INDEX "source_connection_revisions_active_unique"
ON "source_connection_revisions" ("connection_profile_id")
WHERE "state" = 'active';

CREATE UNIQUE INDEX "source_connection_health_episodes_open_unique"
ON "source_connection_health_episodes" ("connection_profile_id")
WHERE "closed_at" IS NULL;

CREATE UNIQUE INDEX "source_connection_recovery_job_active_unique"
ON "source_connection_test_jobs" ("blocking_episode_id")
WHERE "blocking_episode_id" IS NOT NULL AND "state" IN ('queued', 'running');

CREATE UNIQUE INDEX "source_supervisor_epochs_active_unique"
ON "source_supervisor_epochs" ("environment_key")
WHERE "state" IN ('active', 'fenced_draining');

CREATE UNIQUE INDEX "import_runs_source_active_unique"
ON "import_runs" ("source_instance_id")
WHERE "source_instance_id" IS NOT NULL AND "state" IN ('queued', 'running');

CREATE UNIQUE INDEX "import_pages_request_attempt_unique"
ON "import_pages" ("request_attempt_id")
WHERE "request_attempt_id" IS NOT NULL;

-- Stable bounds and lifecycle invariants.
ALTER TABLE "source_connection_profiles"
  ADD CONSTRAINT "source_connection_profiles_request_limit_check"
  CHECK ("request_limit" BETWEEN 1 AND 4),
  ADD CONSTRAINT "source_connection_profiles_keys_check"
  CHECK (btrim("source_type_key") <> '' AND btrim("connection_type_key") <> '' AND btrim("display_name") <> '');

ALTER TABLE "source_connection_revisions"
  ADD CONSTRAINT "source_connection_revisions_number_check"
  CHECK ("revision_number" > 0 AND "encryption_key_version" > 0 AND "health_generation" >= 0),
  ADD CONSTRAINT "source_connection_revisions_config_check"
  CHECK (
    octet_length("configuration_ciphertext") > 0
    AND octet_length("configuration_nonce") > 0
    AND octet_length("configuration_auth_tag") > 0
    AND "configuration_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "source_connection_revisions_state_check"
  CHECK (
    ("state" = 'candidate' AND "activated_at" IS NULL AND "retired_at" IS NULL AND "revoked_at" IS NULL)
    OR ("state" = 'active' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL AND "revoked_at" IS NULL)
    OR ("state" = 'retired' AND "activated_at" IS NOT NULL AND "retired_at" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("state" = 'revoked' AND "revoked_at" IS NOT NULL AND "revoked_by_actor_key" IS NOT NULL)
  );

-- Credential material and the adapter/config identity it represents are
-- immutable referents. Lifecycle, health and revocation fields remain mutable.
CREATE FUNCTION "enforce_source_connection_revision_referent_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."connection_profile_id" IS DISTINCT FROM OLD."connection_profile_id"
    OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
    OR NEW."source_type_key" IS DISTINCT FROM OLD."source_type_key"
    OR NEW."source_adapter_version" IS DISTINCT FROM OLD."source_adapter_version"
    OR NEW."configuration_ciphertext" IS DISTINCT FROM OLD."configuration_ciphertext"
    OR NEW."configuration_nonce" IS DISTINCT FROM OLD."configuration_nonce"
    OR NEW."configuration_auth_tag" IS DISTINCT FROM OLD."configuration_auth_tag"
    OR NEW."encryption_key_version" IS DISTINCT FROM OLD."encryption_key_version"
    OR NEW."configuration_fingerprint" IS DISTINCT FROM OLD."configuration_fingerprint"
    OR NEW."created_by_actor_key" IS DISTINCT FROM OLD."created_by_actor_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'source connection revision referents are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_connection_revision_referents_immutable_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "source_connection_revision_referents_immutable_guard"
BEFORE UPDATE OF
  "id",
  "organization_id",
  "connection_profile_id",
  "revision_number",
  "source_type_key",
  "source_adapter_version",
  "configuration_ciphertext",
  "configuration_nonce",
  "configuration_auth_tag",
  "encryption_key_version",
  "configuration_fingerprint",
  "created_by_actor_key",
  "created_at"
ON "source_connection_revisions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_source_connection_revision_referent_immutability"();

ALTER TABLE "provider_source_instances"
  ADD CONSTRAINT "provider_source_instances_keys_check"
  CHECK (btrim("source_type_key") <> ''),
  ADD CONSTRAINT "provider_source_instances_lifecycle_check"
  CHECK (
    ("state" = 'draft' AND "activated_at" IS NULL AND "disabled_at" IS NULL AND "replaced_at" IS NULL)
    OR ("state" = 'paused' AND "active_revision_id" IS NOT NULL AND "activated_at" IS NOT NULL AND "disabled_at" IS NULL AND "replaced_at" IS NULL)
    OR ("state" = 'active' AND "active_revision_id" IS NOT NULL AND "activated_at" IS NOT NULL AND "disabled_at" IS NULL AND "replaced_at" IS NULL)
    OR ("state" = 'disabled' AND "disabled_at" IS NOT NULL AND "replaced_at" IS NULL)
    OR ("state" = 'replaced' AND "replaced_at" IS NOT NULL)
  );

ALTER TABLE "provider_source_revisions"
  ADD CONSTRAINT "provider_source_revisions_number_check"
  CHECK ("revision_number" > 0),
  ADD CONSTRAINT "provider_source_revisions_keys_check"
  CHECK (
    btrim("source_type_key") <> ''
    AND btrim("source_adapter_version") <> ''
    AND "normalized_contract_version" = 'packscout.provider-observation.v1'
    AND btrim("mapper_key") <> ''
    AND btrim("mapper_version") <> ''
    AND btrim("identity_namespace_key") <> ''
    AND btrim("cursor_codec_version") <> ''
    AND "configuration_hash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("configuration_json") = 'object'
    AND jsonb_typeof("record_id_scopes_json") = 'array'
    AND jsonb_array_length("record_id_scopes_json") > 0
  );

-- Source interpretation is append-only. A new adapter, mapper, namespace,
-- source configuration or scope declaration requires a new revision row.
CREATE FUNCTION "reject_provider_source_revision_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'provider source revisions are insert-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'provider_source_revisions_insert_only_guard';
  RETURN OLD;
END;
$$;

CREATE TRIGGER "provider_source_revisions_insert_only_guard"
BEFORE UPDATE OR DELETE ON "provider_source_revisions"
FOR EACH ROW
EXECUTE FUNCTION "reject_provider_source_revision_updates"();

ALTER TABLE "provider_source_schedule_revisions"
  ADD CONSTRAINT "provider_source_schedule_revisions_bounds_check"
  CHECK (
    "revision_number" > 0
    AND "interval_seconds" BETWEEN 60 AND 86400
    AND "freshness_grace_seconds" = 900
  );

ALTER TABLE "provider_source_schedules"
  ADD CONSTRAINT "provider_source_schedules_claim_check"
  CHECK (
    ("claim_owner" IS NULL AND "claim_token" IS NULL AND "claim_expires_at" IS NULL)
    OR ("claim_owner" IS NOT NULL AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  );

ALTER TABLE "provider_source_cursors"
  ADD CONSTRAINT "provider_source_cursors_generation_check"
  CHECK ("cursor_generation" >= 1),
  ADD CONSTRAINT "provider_source_cursors_page_run_check"
  CHECK (
    (
      "advanced_by_run_id" IS NULL
      AND "advanced_by_page_id" IS NULL
      AND "cursor" IS NULL
      AND "cursor_fingerprint" IS NULL
    )
    OR ("advanced_by_run_id" IS NOT NULL AND "advanced_by_page_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_source_cursors_envelope_check"
  CHECK (
    ("cursor" IS NULL AND "cursor_fingerprint" IS NULL)
    OR (
      "cursor" IS NOT NULL
      AND "cursor_fingerprint" IS NOT NULL
      AND octet_length("cursor") BETWEEN 1 AND 16384
      AND "cursor_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE "provider_source_cursor_fingerprints"
  ADD CONSTRAINT "provider_source_cursor_fingerprints_check"
  CHECK (
    "cursor_generation" >= 1
    AND "cursor_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "provider_source_cursor_fingerprints_page_run_check"
  CHECK ("first_committed_page_id" IS NOT NULL AND "first_committed_run_id" IS NOT NULL);

ALTER TABLE "provider_source_health_states"
  ADD CONSTRAINT "provider_source_health_states_counts_check"
  CHECK ("health_generation" >= 0 AND "consecutive_failures" >= 0);

ALTER TABLE "source_connection_test_jobs"
  ADD CONSTRAINT "source_connection_test_jobs_generation_check"
  CHECK ("expected_health_generation" >= 0),
  ADD CONSTRAINT "source_connection_test_jobs_claim_check"
  CHECK (
    ("state" = 'queued' AND "claim_owner" IS NULL AND "claim_token" IS NULL AND "claim_expires_at" IS NULL AND "started_at" IS NULL AND "finished_at" IS NULL)
    OR ("state" = 'running' AND "claim_owner" IS NOT NULL AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL AND "supervisor_epoch_id" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
    OR ("state" IN ('succeeded', 'failed', 'cancelled', 'fenced') AND "finished_at" IS NOT NULL)
  );

ALTER TABLE "provider_source_test_jobs"
  ADD CONSTRAINT "provider_source_test_jobs_generation_check"
  CHECK ("expected_health_generation" >= 0),
  ADD CONSTRAINT "provider_source_test_jobs_claim_check"
  CHECK (
    ("state" = 'queued' AND "claim_owner" IS NULL AND "claim_token" IS NULL AND "claim_expires_at" IS NULL AND "started_at" IS NULL AND "finished_at" IS NULL)
    OR ("state" = 'running' AND "claim_owner" IS NOT NULL AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL AND "supervisor_epoch_id" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
    OR ("state" IN ('succeeded', 'failed', 'cancelled', 'fenced') AND "finished_at" IS NOT NULL)
  );

ALTER TABLE "source_connection_test_results"
  ADD CONSTRAINT "source_connection_test_results_generation_check"
  CHECK (
    "pre_test_health_generation" >= 0
    AND "resulting_health_generation" >= "pre_test_health_generation"
    AND "outcome" IN ('success', 'failure')
    AND (("outcome" = 'success' AND "request_terminal_state" = 'captured') OR ("outcome" = 'failure' AND "request_terminal_state" IN ('captured', 'failed')))
    AND ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599)
    AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
    AND jsonb_typeof("measurements_json") = 'object'
  );

ALTER TABLE "provider_source_test_results"
  ADD CONSTRAINT "provider_source_test_results_generation_check"
  CHECK (
    "pre_test_health_generation" >= 0
    AND "resulting_health_generation" >= "pre_test_health_generation"
    AND "outcome" IN ('success', 'failure')
    AND (("outcome" = 'success' AND "request_terminal_state" = 'captured') OR ("outcome" = 'failure' AND "request_terminal_state" IN ('captured', 'failed')))
    AND jsonb_typeof("measurements_json") = 'object'
  );

ALTER TABLE "source_connection_health_episodes"
  ADD CONSTRAINT "source_connection_health_episodes_generation_check"
  CHECK (
    "opened_health_generation" > 0
    AND (
      ("closed_at" IS NULL AND "closed_health_generation" IS NULL AND "closed_by_test_result_id" IS NULL)
      OR ("closed_at" IS NOT NULL AND "closed_health_generation" > "opened_health_generation" AND "closed_by_test_result_id" IS NOT NULL)
    )
  );

ALTER TABLE "source_supervisor_epochs"
  ADD CONSTRAINT "source_supervisor_epochs_timing_check"
  CHECK (
    "epoch_number" > 0
    AND "last_renewed_at" >= "acquired_at"
    AND "lease_expires_at" > "last_renewed_at"
    AND "takeover_not_before" >= "lease_expires_at" + interval '15 seconds'
  ),
  ADD CONSTRAINT "source_supervisor_epochs_state_check"
  CHECK (
    ("state" = 'active' AND "fenced_at" IS NULL AND "released_at" IS NULL)
    OR ("state" = 'fenced_draining' AND "fenced_at" IS NOT NULL AND "released_at" IS NULL)
    OR ("state" IN ('released', 'expired') AND "released_at" IS NOT NULL)
  );

ALTER TABLE "source_request_attempts"
  ADD CONSTRAINT "source_request_attempts_scope_check"
  CHECK (
    ("operation_kind" = 'connection_test' AND "connection_test_job_id" IS NOT NULL AND "provider_id" IS NULL AND "source_instance_id" IS NULL AND "source_revision_id" IS NULL AND "source_test_job_id" IS NULL AND "run_id" IS NULL AND "page_number" IS NULL AND "cursor_generation" IS NULL AND "requested_cursor_fingerprint" IS NULL AND "requested_cursor_key" IS NULL AND (("blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL) OR ("blocking_episode_id" IS NOT NULL AND "blocking_episode_connection_revision_id" IS NOT NULL)))
    OR ("operation_kind" = 'source_test' AND "connection_test_job_id" IS NULL AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL AND "source_revision_id" IS NOT NULL AND "source_test_job_id" IS NOT NULL AND "run_id" IS NULL AND "page_number" IS NULL AND "cursor_generation" IS NULL AND "requested_cursor_fingerprint" IS NULL AND "requested_cursor_key" IS NULL AND (("blocking_episode_id" IS NULL) = ("blocking_episode_connection_revision_id" IS NULL)))
    OR ("operation_kind" = 'page_read' AND "connection_test_job_id" IS NULL AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL AND "source_revision_id" IS NOT NULL AND "source_test_job_id" IS NULL AND "run_id" IS NOT NULL AND "page_number" IS NOT NULL AND "page_number" > 0 AND "cursor_generation" IS NOT NULL AND "cursor_generation" >= 1 AND "requested_cursor_key" IS NOT NULL AND "requested_cursor_key" = COALESCE("requested_cursor_fingerprint", 'initial') AND (("blocking_episode_id" IS NULL) = ("blocking_episode_connection_revision_id" IS NULL)))
  ),
  ADD CONSTRAINT "source_request_attempts_terminal_check"
  CHECK (
    ("state" = 'in_flight' AND "terminal_at" IS NULL AND "expires_at" IS NULL AND "outcome_class" IS NULL AND "safe_outcome_hash" IS NULL)
    OR ("state" <> 'in_flight' AND "terminal_at" IS NOT NULL AND "expires_at" = "terminal_at" + interval '30 days' AND "outcome_class" IS NOT NULL AND "safe_outcome_hash" ~ '^[0-9a-f]{64}$' AND ("state" <> 'connection_outcome_uncertain' OR ("blocking_episode_id" IS NOT NULL AND "blocking_episode_connection_revision_id" IS NOT NULL)))
  ),
  ADD CONSTRAINT "source_request_attempts_measurement_check"
  CHECK (
    "expected_health_generation" >= 0
    AND ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599)
    AND ("response_bytes" IS NULL OR "response_bytes" >= 0)
    AND ("duration_ms" IS NULL OR "duration_ms" >= 0)
  );

ALTER TABLE "compact_source_request_attempts"
  ADD CONSTRAINT "compact_source_request_attempts_terminal_check"
  CHECK (
    "terminal_state" <> 'in_flight'
    AND btrim("outcome_class") <> ''
    AND btrim("claim_owner") <> ''
    AND "safe_outcome_hash" ~ '^[0-9a-f]{64}$'
    AND "terminal_at" >= "started_at"
    AND "expected_health_generation" >= 0
    AND ("terminal_state" <> 'connection_outcome_uncertain' OR ("blocking_episode_id" IS NOT NULL AND "blocking_episode_connection_revision_id" IS NOT NULL))
    AND ("compacted_at" IS NULL OR "compacted_at" >= "terminal_at")
  ),
  ADD CONSTRAINT "compact_source_request_attempts_scope_check"
  CHECK (
    ("operation_kind" = 'connection_test' AND "connection_test_job_id" IS NOT NULL AND "provider_id" IS NULL AND "source_instance_id" IS NULL AND "source_revision_id" IS NULL AND "source_test_job_id" IS NULL AND "run_id" IS NULL AND "page_number" IS NULL AND "cursor_generation" IS NULL AND "requested_cursor_fingerprint" IS NULL AND "requested_cursor_key" IS NULL AND (("blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL) OR ("blocking_episode_id" IS NOT NULL AND "blocking_episode_connection_revision_id" IS NOT NULL)))
    OR ("operation_kind" = 'source_test' AND "connection_test_job_id" IS NULL AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL AND "source_revision_id" IS NOT NULL AND "source_test_job_id" IS NOT NULL AND "run_id" IS NULL AND "page_number" IS NULL AND "cursor_generation" IS NULL AND "requested_cursor_fingerprint" IS NULL AND "requested_cursor_key" IS NULL AND (("blocking_episode_id" IS NULL) = ("blocking_episode_connection_revision_id" IS NULL)))
      OR ("operation_kind" = 'page_read' AND "connection_test_job_id" IS NULL AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL AND "source_revision_id" IS NOT NULL AND "source_test_job_id" IS NULL AND "run_id" IS NOT NULL AND "page_number" IS NOT NULL AND "page_number" > 0 AND "cursor_generation" IS NOT NULL AND "cursor_generation" >= 1 AND ("requested_cursor_fingerprint" IS NULL OR "requested_cursor_fingerprint" ~ '^[0-9a-f]{64}$') AND "requested_cursor_key" IS NOT NULL AND "requested_cursor_key" = COALESCE("requested_cursor_fingerprint", 'initial') AND (("blocking_episode_id" IS NULL) = ("blocking_episode_connection_revision_id" IS NULL)))
  );

CREATE FUNCTION "reject_source_test_result_mutations"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'source test results are insert-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'source_test_results_insert_only_guard';
  RETURN NULL;
END;
$$;

CREATE TRIGGER "source_connection_test_results_insert_only_guard"
BEFORE UPDATE OR DELETE ON "source_connection_test_results"
FOR EACH ROW
EXECUTE FUNCTION "reject_source_test_result_mutations"();

CREATE TRIGGER "provider_source_test_results_insert_only_guard"
BEFORE UPDATE OR DELETE ON "provider_source_test_results"
FOR EACH ROW
EXECUTE FUNCTION "reject_source_test_result_mutations"();

CREATE FUNCTION "enforce_compact_request_attempt_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR (to_jsonb(NEW) - 'compacted_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'compacted_at')
    OR OLD."compacted_at" IS NOT NULL
    OR NEW."compacted_at" IS NULL
  THEN
    RAISE EXCEPTION 'compact source request attempt proof is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'compact_source_request_attempts_immutable_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "compact_source_request_attempts_immutable_guard"
BEFORE UPDATE OR DELETE ON "compact_source_request_attempts"
FOR EACH ROW
EXECUTE FUNCTION "enforce_compact_request_attempt_immutability"();

-- These rows are durable history, not mutable projections. Exact no-op
-- updates remain harmless so ORM conflict paths can reread an existing stable
-- identity without manufacturing a second write model.
CREATE FUNCTION "enforce_provider_source_append_only_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514',
          CONSTRAINT = 'provider_source_append_only_history_guard';
END;
$$;

CREATE TRIGGER "provider_source_schedule_revisions_append_only_guard"
BEFORE UPDATE OR DELETE ON "provider_source_schedule_revisions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_provider_source_append_only_history"();

CREATE TRIGGER "provider_source_cursor_fingerprints_append_only_guard"
BEFORE UPDATE OR DELETE ON "provider_source_cursor_fingerprints"
FOR EACH ROW
EXECUTE FUNCTION "enforce_provider_source_append_only_history"();

CREATE TRIGGER "source_record_identities_append_only_guard"
BEFORE UPDATE OR DELETE ON "source_record_identities"
FOR EACH ROW
EXECUTE FUNCTION "enforce_provider_source_append_only_history"();

CREATE TRIGGER "source_semantic_observations_append_only_guard"
BEFORE UPDATE OR DELETE ON "source_semantic_observations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_provider_source_append_only_history"();

CREATE TRIGGER "source_delivery_occurrences_append_only_guard"
BEFORE UPDATE OR DELETE ON "source_delivery_occurrences"
FOR EACH ROW
EXECUTE FUNCTION "enforce_provider_source_append_only_history"();

CREATE FUNCTION "enforce_source_diagnostic_retention_boundary"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."expires_at" <= clock_timestamp() THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'source processor diagnostics are immutable until retention expiry'
    USING ERRCODE = '23514',
          CONSTRAINT = 'source_processor_diagnostics_retention_guard';
END;
$$;

CREATE TRIGGER "source_processor_diagnostics_retention_guard"
BEFORE UPDATE OR DELETE ON "source_processor_diagnostic_events"
FOR EACH ROW
EXECUTE FUNCTION "enforce_source_diagnostic_retention_boundary"();

CREATE FUNCTION "enforce_source_request_attempt_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  "compact_proof_exists" BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'in_flight'
      OR NEW."outcome_class" IS NOT NULL
      OR NEW."safe_code" IS NOT NULL
      OR NEW."safe_outcome_hash" IS NOT NULL
      OR NEW."response_status" IS NOT NULL
      OR NEW."response_bytes" IS NOT NULL
      OR NEW."duration_ms" IS NOT NULL
      OR NEW."terminal_at" IS NOT NULL
      OR NEW."expires_at" IS NOT NULL
      OR NEW."compacted_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'source request attempt must begin in flight without terminal evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_request_attempts_lifecycle_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public."compact_source_request_attempts" AS proof
      WHERE proof."request_attempt_id" = OLD."id"
        AND proof."organization_id" = OLD."organization_id"
        AND proof."operation_kind" = OLD."operation_kind"
        AND proof."terminal_state" = OLD."state"
        AND proof."outcome_class" = OLD."outcome_class"
        AND proof."safe_outcome_hash" = OLD."safe_outcome_hash"
        AND proof."request_lease_id" = OLD."request_lease_id"
        AND proof."claim_owner" = OLD."claim_owner"
        AND proof."claim_token" = OLD."claim_token"
        AND proof."supervisor_epoch_id" = OLD."supervisor_epoch_id"
        AND proof."connection_profile_id" = OLD."connection_profile_id"
        AND proof."connection_revision_id" = OLD."connection_revision_id"
        AND proof."expected_health_generation" = OLD."expected_health_generation"
        AND proof."provider_id" IS NOT DISTINCT FROM OLD."provider_id"
        AND proof."source_instance_id" IS NOT DISTINCT FROM OLD."source_instance_id"
        AND proof."source_revision_id" IS NOT DISTINCT FROM OLD."source_revision_id"
        AND proof."connection_test_job_id" IS NOT DISTINCT FROM OLD."connection_test_job_id"
        AND proof."source_test_job_id" IS NOT DISTINCT FROM OLD."source_test_job_id"
        AND proof."run_id" IS NOT DISTINCT FROM OLD."run_id"
        AND proof."page_number" IS NOT DISTINCT FROM OLD."page_number"
        AND proof."cursor_generation" IS NOT DISTINCT FROM OLD."cursor_generation"
        AND proof."requested_cursor_fingerprint" IS NOT DISTINCT FROM OLD."requested_cursor_fingerprint"
        AND proof."requested_cursor_key" IS NOT DISTINCT FROM OLD."requested_cursor_key"
        AND proof."blocking_episode_id" IS NOT DISTINCT FROM OLD."blocking_episode_id"
        AND proof."blocking_episode_connection_revision_id" IS NOT DISTINCT FROM OLD."blocking_episode_connection_revision_id"
        AND proof."started_at" = OLD."started_at"
        AND proof."terminal_at" = OLD."terminal_at"
        AND proof."compacted_at" = OLD."compacted_at"
    ) INTO "compact_proof_exists";

    IF OLD."state" = 'in_flight'
      OR OLD."compacted_at" IS NULL
      OR OLD."expires_at" IS NULL
      OR OLD."expires_at" > clock_timestamp()
      OR NOT "compact_proof_exists"
    THEN
      RAISE EXCEPTION 'source request attempt cannot be deleted before durable retention expiry'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_request_attempts_lifecycle_guard';
    END IF;
    RETURN OLD;
  END IF;

  IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;

  IF OLD."state" = 'in_flight' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public."compact_source_request_attempts" AS proof
      WHERE proof."request_attempt_id" = NEW."id"
        AND proof."organization_id" = NEW."organization_id"
        AND proof."operation_kind" = NEW."operation_kind"
        AND proof."terminal_state" = NEW."state"
        AND proof."outcome_class" = NEW."outcome_class"
        AND proof."safe_outcome_hash" = NEW."safe_outcome_hash"
        AND proof."request_lease_id" = NEW."request_lease_id"
        AND proof."claim_owner" = NEW."claim_owner"
        AND proof."claim_token" = NEW."claim_token"
        AND proof."supervisor_epoch_id" = NEW."supervisor_epoch_id"
        AND proof."connection_profile_id" = NEW."connection_profile_id"
        AND proof."connection_revision_id" = NEW."connection_revision_id"
        AND proof."expected_health_generation" = NEW."expected_health_generation"
        AND proof."provider_id" IS NOT DISTINCT FROM NEW."provider_id"
        AND proof."source_instance_id" IS NOT DISTINCT FROM NEW."source_instance_id"
        AND proof."source_revision_id" IS NOT DISTINCT FROM NEW."source_revision_id"
        AND proof."connection_test_job_id" IS NOT DISTINCT FROM NEW."connection_test_job_id"
        AND proof."source_test_job_id" IS NOT DISTINCT FROM NEW."source_test_job_id"
        AND proof."run_id" IS NOT DISTINCT FROM NEW."run_id"
        AND proof."page_number" IS NOT DISTINCT FROM NEW."page_number"
        AND proof."cursor_generation" IS NOT DISTINCT FROM NEW."cursor_generation"
        AND proof."requested_cursor_fingerprint" IS NOT DISTINCT FROM NEW."requested_cursor_fingerprint"
        AND proof."requested_cursor_key" IS NOT DISTINCT FROM NEW."requested_cursor_key"
        AND proof."blocking_episode_id" IS NOT DISTINCT FROM NEW."blocking_episode_id"
        AND proof."blocking_episode_connection_revision_id" IS NOT DISTINCT FROM NEW."blocking_episode_connection_revision_id"
        AND proof."started_at" = NEW."started_at"
        AND proof."terminal_at" = NEW."terminal_at"
        AND proof."compacted_at" IS NULL
    ) INTO "compact_proof_exists";

    IF NEW."state" = 'in_flight'
      OR NEW."compacted_at" IS NOT NULL
      OR (to_jsonb(NEW) - ARRAY[
        'state', 'blocking_episode_id', 'blocking_episode_connection_revision_id',
        'outcome_class', 'safe_code', 'safe_outcome_hash', 'response_status',
        'response_bytes', 'duration_ms', 'terminal_at', 'expires_at', 'compacted_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'state', 'blocking_episode_id', 'blocking_episode_connection_revision_id',
        'outcome_class', 'safe_code', 'safe_outcome_hash', 'response_status',
        'response_bytes', 'duration_ms', 'terminal_at', 'expires_at', 'compacted_at'
      ])
      OR NOT "compact_proof_exists"
    THEN
      RAISE EXCEPTION 'source request attempt terminal transition does not match durable proof'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_request_attempts_lifecycle_guard';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public."compact_source_request_attempts" AS proof
    WHERE proof."request_attempt_id" = OLD."id"
      AND proof."organization_id" = OLD."organization_id"
      AND proof."operation_kind" = OLD."operation_kind"
      AND proof."terminal_state" = OLD."state"
      AND proof."outcome_class" = OLD."outcome_class"
      AND proof."safe_outcome_hash" = OLD."safe_outcome_hash"
      AND proof."request_lease_id" = OLD."request_lease_id"
      AND proof."claim_owner" = OLD."claim_owner"
      AND proof."claim_token" = OLD."claim_token"
      AND proof."supervisor_epoch_id" = OLD."supervisor_epoch_id"
      AND proof."connection_profile_id" = OLD."connection_profile_id"
      AND proof."connection_revision_id" = OLD."connection_revision_id"
      AND proof."expected_health_generation" = OLD."expected_health_generation"
      AND proof."provider_id" IS NOT DISTINCT FROM OLD."provider_id"
      AND proof."source_instance_id" IS NOT DISTINCT FROM OLD."source_instance_id"
      AND proof."source_revision_id" IS NOT DISTINCT FROM OLD."source_revision_id"
      AND proof."connection_test_job_id" IS NOT DISTINCT FROM OLD."connection_test_job_id"
      AND proof."source_test_job_id" IS NOT DISTINCT FROM OLD."source_test_job_id"
      AND proof."run_id" IS NOT DISTINCT FROM OLD."run_id"
      AND proof."page_number" IS NOT DISTINCT FROM OLD."page_number"
      AND proof."cursor_generation" IS NOT DISTINCT FROM OLD."cursor_generation"
      AND proof."requested_cursor_fingerprint" IS NOT DISTINCT FROM OLD."requested_cursor_fingerprint"
      AND proof."requested_cursor_key" IS NOT DISTINCT FROM OLD."requested_cursor_key"
      AND proof."blocking_episode_id" IS NOT DISTINCT FROM OLD."blocking_episode_id"
      AND proof."blocking_episode_connection_revision_id" IS NOT DISTINCT FROM OLD."blocking_episode_connection_revision_id"
      AND proof."started_at" = OLD."started_at"
      AND proof."terminal_at" = OLD."terminal_at"
      AND proof."compacted_at" IS NULL
  ) INTO "compact_proof_exists";

  IF (to_jsonb(NEW) - 'compacted_at') IS NOT DISTINCT FROM
       (to_jsonb(OLD) - 'compacted_at')
    AND OLD."compacted_at" IS NULL
    AND NEW."compacted_at" IS NOT NULL
    AND OLD."expires_at" <= clock_timestamp()
    AND NEW."compacted_at" >= OLD."terminal_at"
    AND NEW."compacted_at" <= clock_timestamp()
    AND "compact_proof_exists"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'terminal source request attempt is immutable outside retention compaction'
    USING ERRCODE = '23514',
          CONSTRAINT = 'source_request_attempts_lifecycle_guard';
END;
$$;

CREATE TRIGGER "source_request_attempts_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "source_request_attempts"
FOR EACH ROW
EXECUTE FUNCTION "enforce_source_request_attempt_lifecycle"();

CREATE FUNCTION "enforce_connection_health_episode_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'connection health episodes are permanent lifecycle evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_connection_health_episodes_lifecycle_guard';
  END IF;

  IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;

  -- Episode creation precedes its immutable compact request proof in the same
  -- transaction. Permit that single null-to-value linkage only when the proof
  -- points back to this exact episode and connection revision.
  IF OLD."closed_at" IS NULL
    AND NEW."closed_at" IS NULL
    AND OLD."opened_by_request_attempt_id" IS NULL
    AND NEW."opened_by_request_attempt_id" IS NOT NULL
    AND (to_jsonb(NEW) - 'opened_by_request_attempt_id') IS NOT DISTINCT FROM
        (to_jsonb(OLD) - 'opened_by_request_attempt_id')
    AND EXISTS (
      SELECT 1
      FROM public."compact_source_request_attempts" AS proof
      WHERE proof."request_attempt_id" = NEW."opened_by_request_attempt_id"
        AND proof."organization_id" = OLD."organization_id"
        AND proof."connection_profile_id" = OLD."connection_profile_id"
        AND proof."connection_revision_id" = OLD."connection_revision_id"
        AND proof."blocking_episode_id" = OLD."id"
        AND proof."blocking_episode_connection_revision_id" = OLD."connection_revision_id"
        AND proof."terminal_state" IN ('failed', 'connection_outcome_uncertain')
    )
  THEN
    RETURN NEW;
  END IF;

  -- Closing is a one-way transition backed by a successful connection test
  -- whose job was explicitly issued against this episode. Same-revision
  -- recovery advances that revision; replacement recovery proves a current
  -- candidate while advancing the blocked revision by one generation.
  IF OLD."closed_at" IS NULL
    AND OLD."closed_health_generation" IS NULL
    AND OLD."closed_by_test_result_id" IS NULL
    AND OLD."opened_by_request_attempt_id" IS NOT NULL
    AND NEW."closed_at" IS NOT NULL
    AND NEW."closed_health_generation" = OLD."opened_health_generation" + 1
    AND NEW."closed_by_test_result_id" IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY[
      'closed_health_generation', 'closed_by_test_result_id', 'closed_at'
    ]) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'closed_health_generation', 'closed_by_test_result_id', 'closed_at'
    ])
    AND EXISTS (
      SELECT 1
      FROM public."source_connection_test_results" AS result
      JOIN public."source_connection_test_jobs" AS job
        ON job."id" = result."job_id"
       AND job."organization_id" = result."organization_id"
       AND job."connection_profile_id" = result."connection_profile_id"
       AND job."connection_revision_id" = result."connection_revision_id"
      JOIN public."source_connection_revisions" AS tested_revision
        ON tested_revision."id" = result."connection_revision_id"
       AND tested_revision."organization_id" = result."organization_id"
       AND tested_revision."connection_profile_id" = result."connection_profile_id"
      JOIN public."compact_source_request_attempts" AS request_proof
        ON request_proof."request_attempt_id" = result."request_attempt_id"
       AND request_proof."organization_id" = result."organization_id"
       AND request_proof."connection_profile_id" = result."connection_profile_id"
       AND request_proof."connection_revision_id" = result."connection_revision_id"
      WHERE result."id" = NEW."closed_by_test_result_id"
        AND result."organization_id" = OLD."organization_id"
        AND result."connection_profile_id" = OLD."connection_profile_id"
        AND result."outcome" = 'success'
        AND result."request_terminal_state" = 'captured'
        AND result."tested_at" >= OLD."opened_at"
        AND job."blocking_episode_id" = OLD."id"
        AND request_proof."blocking_episode_id" = OLD."id"
        AND request_proof."blocking_episode_connection_revision_id" =
            OLD."connection_revision_id"
        AND tested_revision."revoked_at" IS NULL
        AND tested_revision."health_generation" = result."resulting_health_generation"
        AND (
          (
            result."connection_revision_id" = OLD."connection_revision_id"
            AND tested_revision."state" IN ('active', 'candidate')
            AND result."pre_test_health_generation" = OLD."opened_health_generation"
            AND result."resulting_health_generation" = NEW."closed_health_generation"
          )
          OR (
            result."connection_revision_id" <> OLD."connection_revision_id"
            AND tested_revision."state" = 'candidate'
          )
        )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'connection health episode transition lacks correlated lifecycle proof'
    USING ERRCODE = '23514',
          CONSTRAINT = 'source_connection_health_episodes_lifecycle_guard';
END;
$$;

CREATE TRIGGER "source_connection_health_episodes_lifecycle_guard"
BEFORE UPDATE OR DELETE ON "source_connection_health_episodes"
FOR EACH ROW
EXECUTE FUNCTION "enforce_connection_health_episode_lifecycle"();

-- Episode creation temporarily uses a null opener so the episode identity can
-- be written into its compact request proof. At commit, require the final row
-- to point back to that exact typed terminal proof.
CREATE FUNCTION "enforce_connection_health_episode_open_proof"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  "episode" public."source_connection_health_episodes"%ROWTYPE;
  "proof_exists" BOOLEAN;
BEGIN
  SELECT *
  INTO "episode"
  FROM public."source_connection_health_episodes"
  WHERE "id" = NEW."id";

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public."compact_source_request_attempts" AS proof
    WHERE proof."request_attempt_id" = "episode"."opened_by_request_attempt_id"
      AND proof."organization_id" = "episode"."organization_id"
      AND proof."connection_profile_id" = "episode"."connection_profile_id"
      AND proof."connection_revision_id" = "episode"."connection_revision_id"
      AND proof."blocking_episode_id" = "episode"."id"
      AND proof."blocking_episode_connection_revision_id" = "episode"."connection_revision_id"
      AND (
        (
          proof."terminal_state" = 'failed'
          AND proof."outcome_class" = "episode"."failure_class"
          AND "episode"."failure_class" IN (
            'authentication_failed',
            'authorization_failed',
            'endpoint_invalid',
            'tls_failed',
            'destination_rejected',
            'profile_configuration_invalid'
          )
          AND "episode"."safe_code" = "episode"."failure_class"
        )
        OR (
          proof."terminal_state" = 'connection_outcome_uncertain'
          AND proof."outcome_class" = 'connection_outcome_uncertain'
          AND "episode"."failure_class" = 'connection_outcome_uncertain'
          AND "episode"."safe_code" = 'REQUEST_OUTCOME_UNCERTAIN'
        )
      )
  ) INTO "proof_exists";

  IF NOT "proof_exists" THEN
    RAISE EXCEPTION 'connection health episode opening lacks exact request proof'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_connection_health_episodes_open_proof_guard';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "source_connection_health_episodes_open_proof_guard"
AFTER INSERT OR UPDATE ON "source_connection_health_episodes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_connection_health_episode_open_proof"();

ALTER TABLE "source_record_identities"
  ADD CONSTRAINT "source_record_identities_scope_meaning_check"
  CHECK (
    btrim("provider_record_id") <> ''
    AND (
      ("record_id_scope_key" = 'catalog-pack-v1' AND "record_kind" = 'catalog' AND "record_discriminator" = 'catalog_pack')
      OR ("record_id_scope_key" = 'catalog-card-v1' AND "record_kind" = 'catalog' AND "record_discriminator" = 'catalog_card')
      OR ("record_id_scope_key" = 'pull-v1' AND "record_kind" = 'pull' AND "record_discriminator" = 'pull')
      OR ("record_id_scope_key" = 'trade-v1' AND "record_kind" = 'trade' AND "record_discriminator" = 'trade')
    )
  );

ALTER TABLE "source_semantic_observations"
  ADD CONSTRAINT "source_semantic_observations_content_check"
  CHECK (
    "normalized_contract_version" = 'packscout.provider-observation.v1'
    AND "hash_version" = 'packscout.provider-observation-hash.v1'
    AND "normalized_content_hash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("normalized_content_json") = 'object'
  );

CREATE FUNCTION "jsonb_has_exact_keys"("value" JSONB, "keys" TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof("value") = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys("value") AS actual("key")
      WHERE NOT (actual."key" = ANY ("keys"))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest("keys") AS required("key")
      WHERE NOT ("value" ? required."key")
    )
$$;

-- Zod's string trims use the ECMAScript whitespace set. Keep persisted semantic
-- content in the already-transformed form so JSONB equality is semantic equality.
CREATE FUNCTION "normalized_text_is_canonical"("value" TEXT, "maximum_length" INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT "maximum_length" >= 1
    AND "value" <> ''
    AND "value" = btrim(
      "value",
      E' \t\n\r\f\v'
        || chr(160)
        || chr(5760)
        || chr(8192)
        || chr(8193)
        || chr(8194)
        || chr(8195)
        || chr(8196)
        || chr(8197)
        || chr(8198)
        || chr(8199)
        || chr(8200)
        || chr(8201)
        || chr(8202)
        || chr(8232)
        || chr(8233)
        || chr(8239)
        || chr(8287)
        || chr(12288)
        || chr(65279)
    )
    AND char_length("value") <= "maximum_length"
$$;

CREATE FUNCTION "normalized_utc_millisecond_timestamp_is_valid"("value" TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN "value" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND "value" = to_char(
      "value"::TIMESTAMPTZ AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN FALSE;
END;
$$;

CREATE FUNCTION "normalized_provider_fact_is_valid"("fact" JSONB, "fact_type" TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  "item" JSONB;
  "text_value" TEXT;
  "numeric_value" NUMERIC;
BEGIN
  IF jsonb_typeof("fact") IS DISTINCT FROM 'object'
    OR jsonb_typeof("fact"->'state') IS DISTINCT FROM 'string'
  THEN
    RETURN FALSE;
  END IF;
  IF "fact"->>'state' IN ('absent', 'malformed') THEN
    RETURN "jsonb_has_exact_keys"("fact", ARRAY['state']);
  END IF;
  IF "fact"->>'state' <> 'present'
    OR NOT "jsonb_has_exact_keys"("fact", ARRAY['state', 'value'])
  THEN
    RETURN FALSE;
  END IF;

  IF "fact_type" = 'text' THEN
    RETURN jsonb_typeof("fact"->'value') = 'string'
      AND "normalized_text_is_canonical"("fact"->>'value', 10000);
  END IF;
  IF "fact_type" = 'number' THEN
    RETURN jsonb_typeof("fact"->'value') = 'number';
  END IF;
  IF "fact_type" = 'images' THEN
    IF jsonb_typeof("fact"->'value') <> 'array'
      OR jsonb_array_length("fact"->'value') > 64
    THEN
      RETURN FALSE;
    END IF;
    FOR "item" IN SELECT value FROM jsonb_array_elements("fact"->'value')
    LOOP
      IF jsonb_typeof("item") <> 'string'
        OR NOT "normalized_text_is_canonical"("item"#>>'{}', 2048)
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    RETURN TRUE;
  END IF;
  IF "fact_type" = 'money' THEN
    RETURN "jsonb_has_exact_keys"("fact"->'value', ARRAY['amount', 'currency'])
      AND jsonb_typeof("fact"->'value'->'amount') = 'number'
      AND jsonb_typeof("fact"->'value'->'currency') = 'string'
      AND "fact"->'value'->>'currency' ~ '^[A-Z0-9]{2,12}$';
  END IF;
  IF "fact_type" = 'authoritative_availability' THEN
    RETURN "jsonb_has_exact_keys"("fact"->'value', ARRAY['state', 'authority'])
      AND "fact"->'value'->>'state' = 'sold_out'
      AND "fact"->'value'->>'authority' = 'provider_explicit_sold_out';
  END IF;
  IF "fact_type" <> 'ev_input'
    OR NOT "jsonb_has_exact_keys"(
      "fact"->'value',
      ARRAY[
        'approved', 'currency', 'unitBasis', 'drawCount',
        'buybackPercent', 'totalQuantity', 'buckets'
      ]
    )
  THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof("fact"->'value'->'approved') <> 'boolean'
    OR NOT (
      "fact"->'value'->'currency' = 'null'::jsonb
      OR (
        jsonb_typeof("fact"->'value'->'currency') = 'string'
        AND "fact"->'value'->>'currency' ~ '^[A-Z0-9]{2,12}$'
      )
    )
    OR NOT (
      "fact"->'value'->'unitBasis' = 'null'::jsonb
      OR "fact"->'value'->>'unitBasis' IN ('per_draw', 'per_pack')
    )
    OR NOT (
      "fact"->'value'->'drawCount' = 'null'::jsonb
      OR jsonb_typeof("fact"->'value'->'drawCount') = 'number'
    )
    OR NOT (
      "fact"->'value'->'buybackPercent' = 'null'::jsonb
      OR jsonb_typeof("fact"->'value'->'buybackPercent') = 'number'
    )
    OR NOT (
      "fact"->'value'->'totalQuantity' = 'null'::jsonb
      OR jsonb_typeof("fact"->'value'->'totalQuantity') = 'number'
    )
    OR jsonb_typeof("fact"->'value'->'buckets') <> 'array'
    OR jsonb_array_length("fact"->'value'->'buckets') > 10000
  THEN
    RETURN FALSE;
  END IF;
  IF "fact"->'value'->'drawCount' <> 'null'::jsonb THEN
    "numeric_value" := ("fact"->'value'->>'drawCount')::NUMERIC;
    IF "numeric_value" <> trunc("numeric_value") THEN RETURN FALSE; END IF;
  END IF;
  IF "fact"->'value'->'totalQuantity' <> 'null'::jsonb THEN
    "numeric_value" := ("fact"->'value'->>'totalQuantity')::NUMERIC;
    IF "numeric_value" <> trunc("numeric_value") THEN RETURN FALSE; END IF;
  END IF;
  FOR "item" IN SELECT value FROM jsonb_array_elements("fact"->'value'->'buckets')
  LOOP
    IF NOT "jsonb_has_exact_keys"(
      "item",
      ARRAY['bucketId', 'label', 'probability', 'quantity', 'lowerValue', 'upperValue']
    )
      OR jsonb_typeof("item"->'bucketId') <> 'string'
      OR NOT "normalized_text_is_canonical"("item"->>'bucketId', 256)
      OR NOT (
        "item"->'label' = 'null'::jsonb
        OR (
          jsonb_typeof("item"->'label') = 'string'
          AND "normalized_text_is_canonical"("item"->>'label', 500)
        )
      )
      OR NOT (
        "item"->'probability' = 'null'::jsonb
        OR jsonb_typeof("item"->'probability') = 'number'
      )
      OR NOT (
        "item"->'quantity' = 'null'::jsonb
        OR jsonb_typeof("item"->'quantity') = 'number'
      )
      OR NOT (
        "item"->'lowerValue' = 'null'::jsonb
        OR jsonb_typeof("item"->'lowerValue') = 'number'
      )
      OR NOT (
        "item"->'upperValue' = 'null'::jsonb
        OR jsonb_typeof("item"->'upperValue') = 'number'
      )
    THEN
      RETURN FALSE;
    END IF;
    IF "item"->'quantity' <> 'null'::jsonb THEN
      "numeric_value" := ("item"->>'quantity')::NUMERIC;
      IF "numeric_value" <> trunc("numeric_value") THEN RETURN FALSE; END IF;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION "enforce_source_semantic_observation_content"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  "source" RECORD;
  "content" JSONB := NEW."normalized_content_json";
  "facts" JSONB := NEW."normalized_content_json"->'providerFacts';
  "relationship" JSONB;
  "seen_pack" BOOLEAN := FALSE;
  "seen_card" BOOLEAN := FALSE;
BEGIN
  SELECT
    "record_id_scope_key",
    "provider_record_id",
    "record_kind"::TEXT AS "record_kind",
    "record_discriminator"
  INTO "source"
  FROM "source_record_identities"
  WHERE "id" = NEW."source_record_id"
    AND "organization_id" = NEW."organization_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic observation source record is unavailable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  IF NOT "jsonb_has_exact_keys"(
    "content"->'providerRecordIdentity',
    ARRAY['recordIdScopeKey', 'providerRecordId']
  )
    OR jsonb_typeof("content"->'providerRecordIdentity'->'recordIdScopeKey') <> 'string'
    OR jsonb_typeof("content"->'providerRecordIdentity'->'providerRecordId') <> 'string'
    OR "content"->'providerRecordIdentity'->>'recordIdScopeKey' <> "source"."record_id_scope_key"
    OR "content"->'providerRecordIdentity'->>'providerRecordId' <> "source"."provider_record_id"
    OR NOT "normalized_text_is_canonical"(
      "content"->'providerRecordIdentity'->>'providerRecordId',
      4096
    )
    OR jsonb_typeof("content"->'effectiveAt') <> 'string'
    OR NOT "normalized_utc_millisecond_timestamp_is_valid"("content"->>'effectiveAt')
    OR ("content"->>'effectiveAt')::TIMESTAMPTZ <> NEW."effective_source_time"
  THEN
    RAISE EXCEPTION 'semantic observation content does not match its identity key'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  IF "source"."record_kind" = 'catalog' THEN
    IF NOT "jsonb_has_exact_keys"(
      "content",
      ARRAY[
        'kind', 'entity', 'providerRecordIdentity', 'effectiveAt', 'firstSeenAt',
        'availability', 'providerFacts', 'relationships'
      ]
    )
      OR "content"->>'kind' <> 'catalog'
      OR jsonb_typeof("content"->'firstSeenAt') <> 'string'
      OR NOT "normalized_utc_millisecond_timestamp_is_valid"("content"->>'firstSeenAt')
      OR NOT ("content"->>'availability' IN ('available', 'unavailable', 'unknown'))
      OR jsonb_typeof("content"->'relationships') <> 'array'
      OR jsonb_array_length("content"->'relationships') <> 0
      OR NOT (
        ("source"."record_discriminator" = 'catalog_pack' AND "content"->>'entity' = 'pack')
        OR ("source"."record_discriminator" = 'catalog_card' AND "content"->>'entity' = 'card')
      )
      OR "facts"->>'kind' <> "content"->>'entity'
    THEN
      RAISE EXCEPTION 'semantic catalog content does not match its frozen meaning'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "source"."record_kind" = 'pull' THEN
    IF NOT "jsonb_has_exact_keys"(
      "content",
      ARRAY['kind', 'providerRecordIdentity', 'effectiveAt', 'providerFacts', 'relationships']
    )
      OR "content"->>'kind' <> 'pull'
      OR "facts"->>'kind' <> 'pull'
      OR jsonb_typeof("content"->'relationships') <> 'array'
      OR jsonb_array_length("content"->'relationships') NOT IN (1, 2)
    THEN
      RAISE EXCEPTION 'semantic pull content does not match its frozen meaning'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSE
    IF NOT "jsonb_has_exact_keys"(
      "content",
      ARRAY[
        'kind', 'providerRecordIdentity', 'effectiveAt', 'providerFacts',
        'relationships', 'eventType', 'amount', 'currency', 'paymentMethod'
      ]
    )
      OR "content"->>'kind' <> 'trade'
      OR "facts"->>'kind' <> 'trade'
      OR jsonb_typeof("content"->'relationships') <> 'array'
      OR jsonb_array_length("content"->'relationships') <> 1
      OR jsonb_typeof("content"->'eventType') <> 'string'
      OR NOT "normalized_text_is_canonical"("content"->>'eventType', 128)
      OR NOT (
        "content"->'amount' = 'null'::jsonb
        OR jsonb_typeof("content"->'amount') = 'number'
      )
      OR NOT (
        "content"->'currency' = 'null'::jsonb
        OR (
          jsonb_typeof("content"->'currency') = 'string'
          AND "content"->>'currency' ~ '^[A-Z0-9]{2,12}$'
        )
      )
      OR NOT (
        "content"->'paymentMethod' = 'null'::jsonb
        OR (
          jsonb_typeof("content"->'paymentMethod') = 'string'
          AND "normalized_text_is_canonical"("content"->>'paymentMethod', 4096)
        )
      )
    THEN
      RAISE EXCEPTION 'semantic trade content does not match its frozen meaning'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  END IF;

  IF "facts"->>'kind' = 'pack' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY[
        'kind', 'displayName', 'description', 'category', 'imageReferences',
        'price', 'providerReportedEv', 'buybackPercent', 'drawCount', 'evInput',
        'authoritativeAvailability'
      ]
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'description', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'category', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'price', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'providerReportedEv', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'buybackPercent', 'number')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'drawCount', 'number')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'evInput', 'ev_input')
      OR NOT "normalized_provider_fact_is_valid"(
        "facts"->'authoritativeAvailability',
        'authoritative_availability'
      )
    THEN
      RAISE EXCEPTION 'semantic pack provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "facts"->>'kind' = 'card' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY[
        'kind', 'displayName', 'description', 'category', 'imageReferences',
        'estimatedValue', 'valueSource'
      ]
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'description', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'category', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'estimatedValue', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'valueSource', 'text')
    THEN
      RAISE EXCEPTION 'semantic card provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "facts"->>'kind' = 'pull' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY['kind', 'displayName', 'imageReferences', 'value', 'valueSource']
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'value', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'valueSource', 'text')
    THEN
      RAISE EXCEPTION 'semantic pull provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "facts"->>'kind' = 'trade' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY['kind', 'displayName', 'imageReferences']
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
    THEN
      RAISE EXCEPTION 'semantic trade provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSE
    RAISE EXCEPTION 'semantic provider facts discriminator is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  FOR "relationship" IN SELECT value FROM jsonb_array_elements("content"->'relationships')
  LOOP
    IF NOT "jsonb_has_exact_keys"("relationship", ARRAY['relationship', 'target'])
      OR NOT "jsonb_has_exact_keys"(
        "relationship"->'target',
        ARRAY['recordIdScopeKey', 'providerRecordId']
      )
      OR jsonb_typeof("relationship"->'relationship') <> 'string'
      OR jsonb_typeof("relationship"->'target'->'providerRecordId') <> 'string'
      OR NOT "normalized_text_is_canonical"(
        "relationship"->'target'->>'providerRecordId',
        4096
      )
    THEN
      RAISE EXCEPTION 'semantic relationship identity is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
    IF "relationship"->>'relationship' = 'pack'
      AND "relationship"->'target'->>'recordIdScopeKey' = 'catalog-pack-v1'
    THEN
      IF "seen_pack" THEN
        RAISE EXCEPTION 'semantic relationship set is duplicated'
          USING ERRCODE = '23514',
                CONSTRAINT = 'source_semantic_observations_semantic_guard';
      END IF;
      "seen_pack" := TRUE;
    ELSIF "relationship"->>'relationship' = 'card'
      AND "relationship"->'target'->>'recordIdScopeKey' = 'catalog-card-v1'
    THEN
      IF "seen_card" THEN
        RAISE EXCEPTION 'semantic relationship set is duplicated'
          USING ERRCODE = '23514',
                CONSTRAINT = 'source_semantic_observations_semantic_guard';
      END IF;
      "seen_card" := TRUE;
    ELSE
      RAISE EXCEPTION 'semantic relationship scope is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  END LOOP;
  IF (
    "source"."record_kind" = 'pull'
    AND (
      (
        "seen_pack" AND "seen_card"
        AND (
          jsonb_array_length("content"->'relationships') <> 2
          OR "content"->'relationships'->0->>'relationship' <> 'pack'
          OR "content"->'relationships'->1->>'relationship' <> 'card'
        )
      )
      OR (
        "seen_pack" AND NOT "seen_card"
        AND (
          jsonb_array_length("content"->'relationships') <> 1
          OR "content"->'relationships'->0->>'relationship' <> 'pack'
        )
      )
      OR (
        NOT "seen_pack" AND "seen_card"
        AND (
          jsonb_array_length("content"->'relationships') <> 1
          OR "content"->'relationships'->0->>'relationship' <> 'card'
        )
      )
      OR NOT ("seen_pack" OR "seen_card")
    )
  )
    OR ("source"."record_kind" = 'trade' AND NOT "seen_card")
  THEN
    RAISE EXCEPTION 'semantic relationship set is incomplete or noncanonical'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  -- The application hash uses JSON.stringify's IEEE-754 number rendering, which
  -- cannot be reproduced exactly from PostgreSQL JSONB for every valid number.
  -- Instead, serialize inserts for a source record (the row lock above) and
  -- enforce an exact JSONB content-to-hash bijection inside the semantic key.
  -- This also closes the concurrent forged-second-hash race.
  IF EXISTS (
    SELECT 1
    FROM "source_semantic_observations" AS "existing"
    WHERE "existing"."source_record_id" = NEW."source_record_id"
      AND "existing"."effective_source_time" = NEW."effective_source_time"
      AND "existing"."normalized_contract_version" = NEW."normalized_contract_version"
      AND "existing"."hash_version" = NEW."hash_version"
      AND (
        (
          "existing"."normalized_content_hash" = NEW."normalized_content_hash"
          AND "existing"."normalized_content_json" <> NEW."normalized_content_json"
        )
        OR (
          "existing"."normalized_content_hash" <> NEW."normalized_content_hash"
          AND "existing"."normalized_content_json" = NEW."normalized_content_json"
        )
      )
  ) THEN
    RAISE EXCEPTION 'semantic observation hash and canonical content disagree'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'semantic observation effective time is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
END;
$$;

CREATE TRIGGER "source_semantic_observations_semantic_guard"
BEFORE INSERT OR UPDATE OF
  "organization_id",
  "source_record_id",
  "effective_source_time",
  "normalized_contract_version",
  "hash_version",
  "normalized_content_hash",
  "normalized_content_json"
ON "source_semantic_observations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_source_semantic_observation_content"();

ALTER TABLE "source_delivery_occurrences"
  ADD CONSTRAINT "source_delivery_occurrences_position_check"
  CHECK ("record_index" >= 0 AND "cursor_generation" >= 1 AND "connection_health_generation" >= 0 AND btrim("native_evidence_reference") <> ''),
  ADD CONSTRAINT "source_delivery_occurrences_observation_check"
  CHECK (
    (
      "disposition" IN ('inserted', 'revised', 'duplicate')
      AND "source_record_id" IS NOT NULL
      AND "semantic_observation_id" IS NOT NULL
      AND "reason_code" IS NULL
    )
    OR (
      "disposition" = 'quarantined'
      AND "reason_code" IS NOT NULL
      AND btrim("reason_code") <> ''
      AND length("reason_code") <= 256
      AND ("semantic_observation_id" IS NULL OR "source_record_id" IS NOT NULL)
    )
  );

ALTER TABLE "source_processor_diagnostic_events"
  ADD CONSTRAINT "source_processor_diagnostic_events_scope_check"
  CHECK (
    (
      "correlation_kind" = 'connection_test'
      AND "event_kind" = 'connection_test'
      AND "scope" = 'connection'
      AND "provider_id" IS NULL AND "source_instance_id" IS NULL AND "source_revision_id" IS NULL
      AND "normalized_contract_version" IS NULL AND "source_test_job_id" IS NULL
      AND "run_id" IS NULL AND "page_id" IS NULL AND "run_trigger" IS NULL
      AND "command_correlation_key" IS NULL AND "audit_event_id" IS NULL
      AND "connection_test_job_id" IS NOT NULL
      AND (("blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL)
        OR ("blocking_episode_id" IS NOT NULL AND "blocking_episode_connection_revision_id" IS NOT NULL))
    )
    OR (
      "correlation_kind" = 'connection_episode'
      AND "event_kind" = 'connection_episode'
      AND "scope" = 'connection'
      AND "provider_id" IS NULL AND "source_instance_id" IS NULL AND "source_revision_id" IS NULL
      AND "normalized_contract_version" IS NULL AND "source_test_job_id" IS NULL
      AND "run_id" IS NULL AND "page_id" IS NULL AND "run_trigger" IS NULL
      AND "command_correlation_key" IS NULL AND "audit_event_id" IS NULL
      AND "connection_test_job_id" IS NULL AND "blocking_episode_id" IS NOT NULL
      AND "blocking_episode_connection_revision_id" IS NOT NULL
    )
    OR (
      "correlation_kind" = 'lifecycle'
      AND "event_kind" = 'source_lifecycle'
      AND "scope" = 'source'
      AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL
      AND "source_revision_id" IS NOT NULL AND "normalized_contract_version" IS NOT NULL
      AND "blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL
      AND "connection_test_job_id" IS NULL
      AND (("command_correlation_key" IS NOT NULL)::integer + ("audit_event_id" IS NOT NULL)::integer = 1)
      AND "source_test_job_id" IS NULL AND "run_id" IS NULL AND "page_id" IS NULL
      AND "request_attempt_id" IS NULL AND "run_trigger" IS NULL
    )
    OR (
      "correlation_kind" = 'source_test'
      AND "event_kind" = 'source_test'
      AND "scope" = 'source'
      AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL
      AND "source_revision_id" IS NOT NULL AND "normalized_contract_version" IS NOT NULL
      AND "blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL
      AND "connection_test_job_id" IS NULL AND "source_test_job_id" IS NOT NULL
      AND "command_correlation_key" IS NULL AND "audit_event_id" IS NULL
      AND "run_id" IS NULL AND "page_id" IS NULL AND "run_trigger" IS NULL
    )
    OR (
      "correlation_kind" = 'run'
      AND "event_kind" = 'source_run'
      AND "scope" = 'source'
      AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL
      AND "source_revision_id" IS NOT NULL AND "normalized_contract_version" IS NOT NULL
      AND "blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL
      AND "connection_test_job_id" IS NULL AND "source_test_job_id" IS NULL
      AND "command_correlation_key" IS NULL AND "audit_event_id" IS NULL
      AND "run_id" IS NOT NULL AND "run_trigger" IS NOT NULL
      AND "page_id" IS NULL AND "request_attempt_id" IS NULL
    )
    OR (
      "correlation_kind" = 'page'
      AND "event_kind" = 'source_page'
      AND "scope" = 'source'
      AND "provider_id" IS NOT NULL AND "source_instance_id" IS NOT NULL
      AND "source_revision_id" IS NOT NULL AND "normalized_contract_version" IS NOT NULL
      AND "blocking_episode_id" IS NULL AND "blocking_episode_connection_revision_id" IS NULL
      AND "connection_test_job_id" IS NULL AND "source_test_job_id" IS NULL
      AND "command_correlation_key" IS NULL AND "audit_event_id" IS NULL
      AND "run_id" IS NOT NULL AND "run_trigger" IS NOT NULL
      AND ("page_id" IS NOT NULL OR "request_attempt_id" IS NOT NULL)
    )
  ),
  ADD CONSTRAINT "source_processor_diagnostic_events_continuation_check"
  CHECK (
    ("continuation_kind" IS NULL AND "minimum_delay_seconds" IS NULL)
    OR ("continuation_kind" = 'continue' AND "minimum_delay_seconds" IS NULL)
    OR ("continuation_kind" = 'poll_after' AND "minimum_delay_seconds" BETWEEN 0 AND 86400)
  ),
  ADD CONSTRAINT "source_processor_diagnostic_events_safety_check"
  CHECK (
    btrim("event_kind") <> ''
    AND btrim("phase") <> ''
    AND btrim("safe_code") <> ''
    AND jsonb_typeof("counters_json") = 'object'
    AND jsonb_typeof("evidence_json") = 'object'
    AND octet_length("evidence_json"::text) <= 4096
    AND ("duration_ms" IS NULL OR "duration_ms" >= 0)
    AND ("response_bytes" IS NULL OR "response_bytes" >= 0)
    AND ("retry_delay_ms" IS NULL OR "retry_delay_ms" >= 0)
    AND ("cursor_fingerprint" IS NULL OR "cursor_fingerprint" ~ '^[0-9a-f]{64}$')
    AND ("command_correlation_key" IS NULL OR "command_correlation_key" ~ '^[a-z0-9]([a-z0-9_.:-]{0,126}[a-z0-9])?$')
    AND "expires_at" = "occurred_at" + interval '30 days'
  );

ALTER TABLE "source_retention_executions"
  ADD CONSTRAINT "source_retention_executions_bounds_check"
  CHECK (
    "batch_size" BETWEEN 1 AND 10000
    AND "raw_page_cutoff_at" <= "started_at"
    AND "quarantine_cutoff_at" <= "started_at"
    AND "diagnostic_cutoff_at" <= "started_at"
    AND "request_attempt_cutoff_at" <= "started_at"
    AND "pages_expired_count" >= 0
    AND "quarantines_expired_count" >= 0
    AND "diagnostics_deleted_count" >= 0
    AND "attempts_compacted_count" >= 0
    AND "attempts_deleted_count" >= 0
  ),
  ADD CONSTRAINT "source_retention_executions_state_check"
  CHECK (
    ("state" = 'running' AND "finished_at" IS NULL)
    OR ("state" IN ('succeeded', 'failed') AND "finished_at" IS NOT NULL)
  );

-- The reused cursor columns predate provider-source ingestion and carry a
-- 2,048-character legacy bound. Keep that historical contract for legacy
-- rows while source-owned rows use the exact 16 KiB UTF-8 bound below.
ALTER TABLE "import_runs"
  DROP CONSTRAINT "import_runs_requested_cursor_bounded",
  ADD CONSTRAINT "import_runs_requested_cursor_bounded"
  CHECK (
    "source_instance_id" IS NOT NULL
    OR "requested_cursor" IS NULL
    OR length("requested_cursor") <= 2048
  );

ALTER TABLE "import_runs"
  ADD CONSTRAINT "import_runs_source_pins_check"
  CHECK (
    "source_instance_id" IS NULL
    OR (
      "source_revision_id" IS NOT NULL
      AND "source_type_key" IS NOT NULL
      AND btrim("source_type_key") <> ''
      AND "source_adapter_version" IS NOT NULL
      AND btrim("source_adapter_version") <> ''
      AND "normalized_contract_version" IS NOT NULL
      AND btrim("normalized_contract_version") <> ''
      AND "mapper_key" IS NOT NULL
      AND btrim("mapper_key") <> ''
      AND "mapper_version" IS NOT NULL
      AND btrim("mapper_version") <> ''
      AND "identity_namespace_key" IS NOT NULL
      AND btrim("identity_namespace_key") <> ''
      AND "connection_profile_id" IS NOT NULL
      AND "connection_revision_id" IS NOT NULL
      AND "cursor_codec_version" IS NOT NULL
      AND btrim("cursor_codec_version") <> ''
      AND "cursor_generation" IS NOT NULL
      AND "cursor_generation" >= 1
      AND (("requested_cursor" IS NULL) = ("requested_cursor_fingerprint" IS NULL))
      AND ("requested_cursor" IS NULL OR octet_length("requested_cursor") BETWEEN 1 AND 16384)
      AND ("requested_cursor_fingerprint" IS NULL OR "requested_cursor_fingerprint" ~ '^[0-9a-f]{64}$')
      AND "requested_cursor_key" IS NOT NULL
      AND "requested_cursor_key" = COALESCE("requested_cursor_fingerprint", 'initial')
    )
  );

-- A source-owned run is an immutable execution envelope. Operational progress
-- may update trigger/state, counters, timestamps and lease fields, but neither
-- queued nor terminal history may be repointed at different source evidence.
CREATE FUNCTION "enforce_import_run_source_pin_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."source_instance_id" IS NOT NULL
    AND (
      NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
      OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id"
      OR NEW."source_instance_id" IS DISTINCT FROM OLD."source_instance_id"
      OR NEW."source_revision_id" IS DISTINCT FROM OLD."source_revision_id"
      OR NEW."source_type_key" IS DISTINCT FROM OLD."source_type_key"
      OR NEW."source_adapter_version" IS DISTINCT FROM OLD."source_adapter_version"
      OR NEW."normalized_contract_version" IS DISTINCT FROM OLD."normalized_contract_version"
      OR NEW."mapper_key" IS DISTINCT FROM OLD."mapper_key"
      OR NEW."mapper_version" IS DISTINCT FROM OLD."mapper_version"
      OR NEW."identity_namespace_key" IS DISTINCT FROM OLD."identity_namespace_key"
      OR NEW."connection_profile_id" IS DISTINCT FROM OLD."connection_profile_id"
      OR NEW."connection_revision_id" IS DISTINCT FROM OLD."connection_revision_id"
      OR NEW."cursor_codec_version" IS DISTINCT FROM OLD."cursor_codec_version"
      OR NEW."cursor_generation" IS DISTINCT FROM OLD."cursor_generation"
      OR NEW."requested_cursor" IS DISTINCT FROM OLD."requested_cursor"
      OR NEW."requested_cursor_fingerprint" IS DISTINCT FROM OLD."requested_cursor_fingerprint"
      OR NEW."requested_cursor_key" IS DISTINCT FROM OLD."requested_cursor_key"
    )
  THEN
    RAISE EXCEPTION 'source-owned import run pins are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'import_runs_source_pins_immutable_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "import_run_source_pins_immutable_guard"
BEFORE UPDATE OF
  "organization_id",
  "provider_id",
  "source_instance_id",
  "source_revision_id",
  "source_type_key",
  "source_adapter_version",
  "normalized_contract_version",
  "mapper_key",
  "mapper_version",
  "identity_namespace_key",
  "connection_profile_id",
  "connection_revision_id",
  "cursor_codec_version",
  "cursor_generation",
  "requested_cursor",
  "requested_cursor_fingerprint",
  "requested_cursor_key"
ON "import_runs"
FOR EACH ROW
EXECUTE FUNCTION "enforce_import_run_source_pin_immutability"();

ALTER TABLE "import_pages"
  DROP CONSTRAINT "import_pages_cursors_bounded",
  ADD CONSTRAINT "import_pages_cursors_bounded"
  CHECK (
    "source_instance_id" IS NOT NULL
    OR (
      ("requested_cursor" IS NULL OR length("requested_cursor") <= 2048)
      AND ("next_cursor" IS NULL OR length("next_cursor") <= 2048)
    )
  );

ALTER TABLE "import_pages"
  ADD CONSTRAINT "import_pages_source_pins_check"
  CHECK (
    "source_instance_id" IS NULL
    OR (
      "source_revision_id" IS NOT NULL
      AND "source_type_key" IS NOT NULL
      AND btrim("source_type_key") <> ''
      AND "source_adapter_version" IS NOT NULL
      AND btrim("source_adapter_version") <> ''
      AND "normalized_contract_version" IS NOT NULL
      AND btrim("normalized_contract_version") <> ''
      AND "mapper_key" IS NOT NULL
      AND btrim("mapper_key") <> ''
      AND "mapper_version" IS NOT NULL
      AND btrim("mapper_version") <> ''
      AND "identity_namespace_key" IS NOT NULL
      AND btrim("identity_namespace_key") <> ''
      AND "connection_profile_id" IS NOT NULL
      AND "connection_revision_id" IS NOT NULL
      AND "connection_health_generation" IS NOT NULL
      AND "connection_health_generation" >= 0
      AND "request_attempt_id" IS NOT NULL
      AND "supervisor_epoch_id" IS NOT NULL
      AND "cursor_codec_version" IS NOT NULL
      AND btrim("cursor_codec_version") <> ''
      AND "cursor_generation" IS NOT NULL
      AND "cursor_generation" >= 1
      AND (("requested_cursor" IS NULL) = ("requested_cursor_fingerprint" IS NULL))
      AND ("requested_cursor" IS NULL OR octet_length("requested_cursor") BETWEEN 1 AND 16384)
      AND ("requested_cursor_fingerprint" IS NULL OR "requested_cursor_fingerprint" ~ '^[0-9a-f]{64}$')
      AND "requested_cursor_key" IS NOT NULL
      AND "requested_cursor_key" = COALESCE("requested_cursor_fingerprint", 'initial')
      AND (("next_cursor" IS NULL) = ("next_cursor_fingerprint" IS NULL))
      AND ("next_cursor" IS NULL OR octet_length("next_cursor") BETWEEN 1 AND 16384)
      AND ("next_cursor_fingerprint" IS NULL OR "next_cursor_fingerprint" ~ '^[0-9a-f]{64}$')
    )
  ),
  ADD CONSTRAINT "import_pages_source_continuation_check"
  CHECK (
    "source_instance_id" IS NULL
    OR (
      "continuation_kind" IS NOT NULL
      AND (
        (
          "continuation_kind" = 'continue'
          AND "minimum_delay_seconds" IS NULL
          AND "next_cursor" IS NOT NULL
          AND "next_cursor_fingerprint" IS NOT NULL
          AND "next_cursor_fingerprint" ~ '^[0-9a-f]{64}$'
        )
        OR (
          "continuation_kind" = 'poll_after'
          AND "minimum_delay_seconds" IS NOT NULL
          AND "minimum_delay_seconds" BETWEEN 0 AND 86400
        )
      )
    )
  ),
  ADD CONSTRAINT "import_pages_source_raw_retention_check"
  CHECK ("source_instance_id" IS NULL OR "expires_at" = "committed_at" + interval '7 days');

-- Tenant-preserving ownership graph. Generic persistence always joins through these
-- composite keys; provider/source/profile identities can never cross organizations.
ALTER TABLE "source_connection_profiles"
  ADD CONSTRAINT "source_connection_profiles_org_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_connection_revisions"
  ADD CONSTRAINT "source_connection_revisions_profile_fk"
  FOREIGN KEY ("connection_profile_id", "organization_id", "source_type_key")
  REFERENCES "source_connection_profiles"("id", "organization_id", "source_type_key") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_connection_profiles"
  ADD CONSTRAINT "source_connection_profiles_active_revision_fk"
  FOREIGN KEY ("active_revision_id", "organization_id", "id")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_connection_health_episodes"
  ADD CONSTRAINT "source_connection_health_episodes_revision_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_connection_test_jobs"
  ADD CONSTRAINT "source_connection_test_jobs_revision_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_connection_test_jobs_episode_fk"
  FOREIGN KEY ("blocking_episode_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_health_episodes"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_connection_test_jobs_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_instances"
  ADD CONSTRAINT "provider_source_instances_provider_fk"
  FOREIGN KEY ("provider_id", "organization_id")
  REFERENCES "provider_sources"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_instances_profile_fk"
  FOREIGN KEY ("connection_profile_id", "organization_id", "source_type_key")
  REFERENCES "source_connection_profiles"("id", "organization_id", "source_type_key") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_revisions"
  ADD CONSTRAINT "provider_source_revisions_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id", "source_type_key", "connection_profile_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id", "source_type_key", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_revisions_profile_fk"
  FOREIGN KEY ("connection_profile_id", "organization_id", "source_type_key")
  REFERENCES "source_connection_profiles"("id", "organization_id", "source_type_key") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_instances"
  ADD CONSTRAINT "provider_source_instances_active_revision_fk"
  FOREIGN KEY ("active_revision_id", "organization_id", "provider_id", "id")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_schedule_revisions"
  ADD CONSTRAINT "provider_source_schedule_revisions_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_schedules"
  ADD CONSTRAINT "provider_source_schedules_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_schedules_revision_fk"
  FOREIGN KEY ("active_schedule_revision_id", "organization_id", "source_instance_id")
  REFERENCES "provider_source_schedule_revisions"("id", "organization_id", "source_instance_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_schedules_run_fk"
  FOREIGN KEY ("last_run_id", "organization_id", "provider_id", "source_instance_id")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_cursors"
  ADD CONSTRAINT "provider_source_cursors_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_cursors_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "source_adapter_version", "cursor_codec_version")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "source_adapter_version", "cursor_codec_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_cursors_run_fk"
  FOREIGN KEY ("advanced_by_run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_cursors_page_fk"
  FOREIGN KEY ("advanced_by_page_id", "organization_id", "provider_id", "advanced_by_run_id", "source_instance_id", "source_revision_id", "cursor_generation")
  REFERENCES "import_pages"("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "cursor_generation") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_cursor_fingerprints"
  ADD CONSTRAINT "provider_source_cursor_fingerprints_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_cursor_fingerprints_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "source_adapter_version", "cursor_codec_version")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "source_adapter_version", "cursor_codec_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_cursor_fingerprints_run_fk"
  FOREIGN KEY ("first_committed_run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_cursor_fingerprints_page_fk"
  FOREIGN KEY ("first_committed_page_id", "organization_id", "provider_id", "first_committed_run_id", "source_instance_id", "source_revision_id", "cursor_generation", "cursor_fingerprint")
  REFERENCES "import_pages"("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "cursor_generation", "next_cursor_fingerprint") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_health_states"
  ADD CONSTRAINT "provider_source_health_states_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_test_jobs"
  ADD CONSTRAINT "provider_source_test_jobs_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_test_jobs_connection_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_test_jobs_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_request_attempts"
  ADD CONSTRAINT "source_request_attempts_connection_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_source_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_connection_job_fk"
  FOREIGN KEY ("connection_test_job_id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token")
  REFERENCES "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_source_job_fk"
  FOREIGN KEY ("source_test_job_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token")
  REFERENCES "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_run_fk"
  FOREIGN KEY ("run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "requested_cursor_key", "claim_owner", "claim_token")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "requested_cursor_key", "lease_owner", "lease_token") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_request_attempts_episode_fk"
  FOREIGN KEY ("blocking_episode_id", "organization_id", "connection_profile_id", "blocking_episode_connection_revision_id")
  REFERENCES "source_connection_health_episodes"("id", "organization_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_connection_test_results"
  ADD CONSTRAINT "source_connection_test_results_job_fk"
  FOREIGN KEY ("job_id", "organization_id", "connection_profile_id", "connection_revision_id", "pre_test_health_generation", "supervisor_epoch_id")
  REFERENCES "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_connection_test_results_attempt_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "job_id", "supervisor_epoch_id", "pre_test_health_generation", "request_terminal_state")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "connection_test_job_id", "supervisor_epoch_id", "expected_health_generation", "terminal_state") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_connection_test_results_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_connection_health_episodes"
  ADD CONSTRAINT "source_connection_health_episodes_open_attempt_fk"
  FOREIGN KEY ("opened_by_request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_connection_health_episodes_close_result_fk"
  FOREIGN KEY ("closed_by_test_result_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_test_results"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_source_test_results"
  ADD CONSTRAINT "provider_source_test_results_job_fk"
  FOREIGN KEY ("job_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "pre_test_health_generation", "supervisor_epoch_id")
  REFERENCES "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_test_results_attempt_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "job_id", "supervisor_epoch_id", "pre_test_health_generation", "request_terminal_state")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "source_test_job_id", "supervisor_epoch_id", "expected_health_generation", "terminal_state") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_source_test_results_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_record_identities"
  ADD CONSTRAINT "source_record_identities_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_semantic_observations"
  ADD CONSTRAINT "source_semantic_observations_record_fk"
  FOREIGN KEY ("source_record_id", "organization_id")
  REFERENCES "source_record_identities"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "canonical_revisions"
  ADD CONSTRAINT "canonical_revisions_origin_semantic_observation_fk"
  FOREIGN KEY ("origin_semantic_observation_id", "organization_id")
  REFERENCES "source_semantic_observations"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- A semantic origin is valid only for the canonical identity derived from its
-- stable provider record. Catalog-pack observations may additionally origin the
-- separately derived EV-input identity with the same provider record ID; no
-- other scope-to-kind widening is valid. This closes cross-record,
-- cross-provider and cross-kind lineage even when tenant FKs are individually valid.
CREATE FUNCTION "enforce_canonical_semantic_origin_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."origin_semantic_observation_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."source_semantic_observations" AS observation
    JOIN public."source_record_identities" AS source_record
      ON source_record."id" = observation."source_record_id"
     AND source_record."organization_id" = observation."organization_id"
    JOIN public."provider_sources" AS provider
      ON provider."id" = source_record."provider_id"
     AND provider."organization_id" = source_record."organization_id"
    JOIN public."canonical_entities" AS entity
      ON entity."id" = NEW."entity_id"
     AND entity."organization_id" = NEW."organization_id"
    WHERE observation."id" = NEW."origin_semantic_observation_id"
      AND observation."organization_id" = NEW."organization_id"
      AND provider."platform_key" = entity."platform_key"
      AND source_record."provider_record_id" = entity."external_id"
      AND (
        entity."record_kind" = CASE source_record."record_discriminator"
          WHEN 'catalog_pack' THEN 'pack'::public."canonical_record_kind"
          WHEN 'catalog_card' THEN 'catalog_asset'::public."canonical_record_kind"
          WHEN 'pull' THEN 'pull'::public."canonical_record_kind"
          WHEN 'trade' THEN 'market_event'::public."canonical_record_kind"
          ELSE NULL
        END
        OR (
          source_record."record_id_scope_key" = 'catalog-pack-v1'
          AND source_record."record_kind" = 'catalog'
          AND source_record."record_discriminator" = 'catalog_pack'
          AND entity."record_kind" = 'ev_input'::public."canonical_record_kind"
        )
      )
  ) THEN
    RAISE EXCEPTION 'canonical semantic origin does not match entity identity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'canonical_revisions_semantic_origin_identity_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "canonical_revision_semantic_origin_identity_guard"
BEFORE INSERT OR UPDATE OF "organization_id", "entity_id", "origin_semantic_observation_id"
ON "canonical_revisions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_canonical_semantic_origin_identity"();

ALTER TABLE "source_delivery_occurrences"
  ADD CONSTRAINT "source_delivery_occurrences_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_delivery_occurrences_connection_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_delivery_occurrences_run_fk"
  FOREIGN KEY ("run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_delivery_occurrences_page_fk"
  FOREIGN KEY ("page_id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "request_attempt_id", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "connection_health_generation")
  REFERENCES "import_pages"("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "request_attempt_id", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "connection_health_generation") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_delivery_occurrences_attempt_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "connection_health_generation", "cursor_generation")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "cursor_generation") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_delivery_occurrences_record_fk"
  FOREIGN KEY ("source_record_id", "organization_id", "source_instance_id")
  REFERENCES "source_record_identities"("id", "organization_id", "source_instance_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_delivery_occurrences_observation_fk"
  FOREIGN KEY ("semantic_observation_id", "organization_id", "source_record_id", "normalized_contract_version")
  REFERENCES "source_semantic_observations"("id", "organization_id", "source_record_id", "normalized_contract_version") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_processor_diagnostic_events"
  ADD CONSTRAINT "source_processor_diagnostics_connection_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_source_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_episode_fk"
  FOREIGN KEY ("blocking_episode_id", "organization_id", "connection_profile_id", "blocking_episode_connection_revision_id")
  REFERENCES "source_connection_health_episodes"("id", "organization_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_connection_job_fk"
  FOREIGN KEY ("connection_test_job_id", "organization_id", "connection_profile_id", "connection_revision_id")
  REFERENCES "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_source_job_fk"
  FOREIGN KEY ("source_test_job_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id")
  REFERENCES "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_run_fk"
  FOREIGN KEY ("run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_trigger")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "trigger") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_page_fk"
  FOREIGN KEY ("page_id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id")
  REFERENCES "import_pages"("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_page_attempt_fk"
  FOREIGN KEY ("page_id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "request_attempt_id")
  REFERENCES "import_pages"("id", "organization_id", "provider_id", "run_id", "source_instance_id", "source_revision_id", "request_attempt_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_request_attempt_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_diagnostics_request_connection_test_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "connection_test_job_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "connection_test_job_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_diagnostics_request_source_test_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "source_test_job_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "source_test_job_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_diagnostics_request_episode_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "blocking_episode_id", "blocking_episode_connection_revision_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "connection_profile_id", "connection_revision_id", "blocking_episode_id", "blocking_episode_connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_request_source_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_request_run_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "connection_profile_id", "connection_revision_id")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "source_processor_diagnostics_audit_fk"
  FOREIGN KEY ("audit_event_id", "organization_id") REFERENCES "audit_events"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_retention_executions"
  ADD CONSTRAINT "source_retention_executions_org_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "compact_source_request_attempts"
  ADD CONSTRAINT "compact_source_request_attempts_org_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_connection_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_source_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_source_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_connection_job_fk"
  FOREIGN KEY ("connection_test_job_id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token")
  REFERENCES "source_connection_test_jobs"("id", "organization_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_source_job_fk"
  FOREIGN KEY ("source_test_job_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token")
  REFERENCES "provider_source_test_jobs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "supervisor_epoch_id", "claim_owner", "claim_token") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_run_fk"
  FOREIGN KEY ("run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "requested_cursor_key", "claim_owner", "claim_token")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "connection_profile_id", "connection_revision_id", "cursor_generation", "requested_cursor_key", "lease_owner", "lease_token") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "compact_source_request_attempts_episode_fk"
  FOREIGN KEY ("blocking_episode_id", "organization_id", "connection_profile_id", "blocking_episode_connection_revision_id")
  REFERENCES "source_connection_health_episodes"("id", "organization_id", "connection_profile_id", "connection_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "import_runs"
  ADD CONSTRAINT "import_runs_source_instance_fk"
  FOREIGN KEY ("source_instance_id", "organization_id", "provider_id")
  REFERENCES "provider_source_instances"("id", "organization_id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "import_runs_source_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "import_runs_connection_revision_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "import_pages"
  ADD CONSTRAINT "import_pages_source_run_fk"
  FOREIGN KEY ("run_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id")
  REFERENCES "import_runs"("id", "organization_id", "provider_id", "source_instance_id", "source_revision_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "import_pages_source_revision_fk"
  FOREIGN KEY ("source_revision_id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version")
  REFERENCES "provider_source_revisions"("id", "organization_id", "provider_id", "source_instance_id", "connection_profile_id", "source_type_key", "source_adapter_version", "normalized_contract_version", "mapper_key", "mapper_version", "identity_namespace_key", "cursor_codec_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "import_pages_connection_revision_fk"
  FOREIGN KEY ("connection_revision_id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version")
  REFERENCES "source_connection_revisions"("id", "organization_id", "connection_profile_id", "source_type_key", "source_adapter_version") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "import_pages_request_attempt_fk"
  FOREIGN KEY ("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "page_number", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "connection_health_generation", "cursor_generation", "requested_cursor_key")
  REFERENCES "compact_source_request_attempts"("request_attempt_id", "organization_id", "provider_id", "source_instance_id", "source_revision_id", "run_id", "page_number", "supervisor_epoch_id", "connection_profile_id", "connection_revision_id", "expected_health_generation", "cursor_generation", "requested_cursor_key") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "import_pages_supervisor_epoch_fk"
  FOREIGN KEY ("supervisor_epoch_id") REFERENCES "source_supervisor_epochs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
