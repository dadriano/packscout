-- Clean empty-database provider baseline for PostgreSQL 16+.
-- Provider identity is supplied only by initialize_provider_database_identity;
-- application startup must never invoke schema-changing SQL.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "entity_lifecycle" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "availability_state" AS ENUM ('available', 'sold_out', 'unavailable');

-- CreateEnum
CREATE TYPE "evidence_state" AS ENUM ('complete', 'partial', 'unknown');

-- CreateEnum
CREATE TYPE "pack_format" AS ENUM ('repack', 'gacha');

-- CreateEnum
CREATE TYPE "collectible_type" AS ENUM ('card', 'watch', 'art', 'coin', 'sealed_product', 'memorabilia', 'other');

-- CreateEnum
CREATE TYPE "content_role" AS ENUM ('top_chase', 'featured_chase', 'possible_outcome', 'other');

-- CreateEnum
CREATE TYPE "market_event_type" AS ENUM ('sale', 'buyback', 'mint', 'burn', 'transfer', 'list', 'unlist', 'swap', 'ship', 'other');

-- CreateEnum
CREATE TYPE "promotion_operation" AS ENUM ('upsert', 'retire');

-- CreateEnum
CREATE TYPE "runtime_state" AS ENUM ('idle', 'running', 'paused', 'stopped', 'error');

-- CreateEnum
CREATE TYPE "worker_role" AS ENUM ('import', 'promotion');

-- CreateEnum
CREATE TYPE "run_state" AS ENUM ('queued', 'running', 'succeeded', 'incomplete', 'failed');

-- CreateEnum
CREATE TYPE "run_trigger" AS ENUM ('scheduled', 'manual', 'recovery');

-- CreateEnum
CREATE TYPE "page_continuation" AS ENUM ('more', 'head');

-- CreateEnum
CREATE TYPE "command_type" AS ENUM ('run', 'pause', 'resume', 'stop', 'retry_run', 'retry_quarantine');

-- CreateEnum
CREATE TYPE "command_state" AS ENUM ('pending', 'accepted', 'rejected', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "quarantine_state" AS ENUM ('open', 'resolved', 'expired');

-- CreateEnum
CREATE TYPE "quarantine_attempt_state" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "retention_state" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('success', 'failure', 'blocked');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "activity_delivery_state" AS ENUM ('pending', 'delivered');

-- CreateEnum
CREATE TYPE "artifact_lifecycle" AS ENUM ('building', 'assembled', 'publishing', 'complete', 'blocked', 'failed');

-- CreateEnum
CREATE TYPE "publication_operation_state" AS ENUM ('pending', 'accepted', 'ambiguous', 'failed');

-- CreateEnum
CREATE TYPE "publication_receipt_outcome" AS ENUM ('accepted', 'rejected');

-- CreateTable
CREATE TABLE "database_identity" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "database_role" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "provider_id" UUID NOT NULL,
    "provider_key" VARCHAR(53) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_identity_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_category_id" UUID,
    "category_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID,
    "pack_key" TEXT NOT NULL,
    "family_key" TEXT,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "pack_format" "pack_format" NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "availability" "availability_state" NOT NULL,
    "content_evidence" "evidence_state" NOT NULL,
    "total_inventory" BIGINT,
    "remaining_inventory" BIGINT,
    "price_amount" DECIMAL(38,18),
    "price_currency" VARCHAR(42),
    "price_usd_amount" DECIMAL(38,18),
    "price_unavailable_reason" TEXT,
    "buyback_rate" DECIMAL(20,18),
    "buyback_source_kind" TEXT,
    "vendor_ev_amount" DECIMAL(38,18),
    "vendor_ev_currency" VARCHAR(42),
    "vendor_ev_observed_at" TIMESTAMPTZ(6),
    "vendor_ev_unavailable_reason" TEXT,
    "packscout_ev_amount" DECIMAL(38,18),
    "packscout_ev_currency" VARCHAR(42),
    "packscout_ev_model_version" TEXT NOT NULL,
    "packscout_ev_confidence_policy_version" TEXT NOT NULL,
    "packscout_ev_confidence" JSONB,
    "packscout_ev_data_as_of" TIMESTAMPTZ(6),
    "packscout_ev_calculated_at" TIMESTAMPTZ(6),
    "packscout_ev_unavailable_reason" TEXT,
    "primary_image_url" TEXT,
    "primary_image_alt" TEXT,
    "listing_url" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collectibles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID,
    "collectible_key" TEXT NOT NULL,
    "collectible_type" "collectible_type" NOT NULL,
    "display_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "year" INTEGER,
    "brand" TEXT,
    "set_or_series" TEXT,
    "card_number" TEXT,
    "reference_number" TEXT,
    "subject" TEXT,
    "grade" TEXT,
    "grader" TEXT,
    "primary_image_url" TEXT,
    "primary_image_alt" TEXT,
    "valuation_amount" DECIMAL(38,18),
    "valuation_currency" VARCHAR(42),
    "valuation_usd_amount" DECIMAL(38,18),
    "valuation_unavailable_reason" TEXT,
    "valuation_type" TEXT,
    "valuation_observed_at" TIMESTAMPTZ(6),
    "data_as_of" TIMESTAMPTZ(6) NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collectibles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collectible_name_aliases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "collectible_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collectible_name_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collectible_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "collectible_id" UUID NOT NULL,
    "instance_key" TEXT NOT NULL,
    "certifier" TEXT,
    "certification_number" TEXT,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collectible_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_contents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pack_id" UUID NOT NULL,
    "collectible_id" UUID NOT NULL,
    "collectible_instance_id" UUID,
    "total_quantity" BIGINT,
    "available_quantity" BIGINT,
    "content_role" "content_role" NOT NULL,
    "probability" DECIMAL(20,18),
    "stated_value_amount" DECIMAL(38,18),
    "stated_value_currency" VARCHAR(42),
    "evidence_kinds" TEXT[],
    "match_confidence_basis_points" INTEGER NOT NULL,
    "match_confidence_band" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "display_order" INTEGER NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pack_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_key" CHAR(64) NOT NULL,
    "display_name" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pulls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pull_key" TEXT NOT NULL,
    "fact_digest" CHAR(64) NOT NULL,
    "pack_id" UUID NOT NULL,
    "provider_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "paid_amount" DECIMAL(38,18),
    "paid_currency" VARCHAR(42),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pulls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pull_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "collectible_id" UUID NOT NULL,
    "collectible_instance_id" UUID,
    "quantity" BIGINT NOT NULL,
    "stated_value_amount" DECIMAL(38,18),
    "stated_value_currency" VARCHAR(42),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_key" TEXT NOT NULL,
    "fact_digest" CHAR(64) NOT NULL,
    "event_group_id" UUID,
    "event_type" "market_event_type" NOT NULL,
    "pack_id" UUID,
    "collectible_id" UUID,
    "collectible_instance_id" UUID,
    "from_provider_account_id" UUID,
    "to_provider_account_id" UUID,
    "quantity" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "amount" DECIMAL(38,18),
    "currency" VARCHAR(42),
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_ledger" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_ledger_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "promotion_changes" (
    "sequence" BIGINT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_version" BIGINT NOT NULL,
    "operation" "promotion_operation" NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_changes_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "provider_runtime" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "central_provider_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "operating_state" "runtime_state" NOT NULL DEFAULT 'idle',
    "state_reason" TEXT,
    "state_generation" BIGINT NOT NULL DEFAULT 0,
    "cached_config_version_id" UUID,
    "cached_config_version_number" BIGINT,
    "cached_configuration" JSONB,
    "config_expires_at" TIMESTAMPTZ(6),
    "last_control_sync_at" TIMESTAMPTZ(6),
    "schedule_seconds" INTEGER,
    "next_due_at" TIMESTAMPTZ(6),
    "source_cursor" JSONB,
    "source_cursor_hash" CHAR(64),
    "freshness_state" TEXT NOT NULL,
    "quality_state" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "latest_failure_code" TEXT,
    "last_attempted_at" TIMESTAMPTZ(6),
    "last_head_reached_at" TIMESTAMPTZ(6),
    "last_runner_heartbeat_at" TIMESTAMPTZ(6),
    "recovered_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_runtime_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "provider_state_events" (
    "sequence" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    "from_state" "runtime_state",
    "to_state" "runtime_state" NOT NULL,
    "state_generation" BIGINT NOT NULL,
    "reason" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_state_events_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "provider_worker_states" (
    "worker_role" "worker_role" NOT NULL,
    "lease_owner" TEXT,
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_worker_states_pkey" PRIMARY KEY ("worker_role")
);

-- CreateTable
CREATE TABLE "provider_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "control_command_id" UUID,
    "recovery_of_run_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "trigger" "run_trigger" NOT NULL,
    "state" "run_state" NOT NULL DEFAULT 'queued',
    "requested_by_operator_id" UUID,
    "config_version_id" UUID NOT NULL,
    "config_version_number" BIGINT NOT NULL,
    "worker_fence" BIGINT NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "requested_cursor" JSONB,
    "requested_cursor_hash" CHAR(64),
    "final_cursor" JSONB,
    "final_cursor_hash" CHAR(64),
    "reached_source_head" BOOLEAN NOT NULL DEFAULT false,
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "catalog_record_count" INTEGER NOT NULL DEFAULT 0,
    "pull_record_count" INTEGER NOT NULL DEFAULT 0,
    "market_event_record_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "quarantined_count" INTEGER NOT NULL DEFAULT 0,
    "material_change_count" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "failure_class" TEXT,
    "failure_summary" TEXT,
    "heartbeat_at" TIMESTAMPTZ(6),
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "last_progress_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_run_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_run_id" UUID NOT NULL,
    "page_number" INTEGER NOT NULL,
    "contract_version" TEXT NOT NULL,
    "requested_cursor" JSONB,
    "requested_cursor_hash" CHAR(64),
    "next_cursor" JSONB,
    "next_cursor_hash" CHAR(64),
    "continuation" "page_continuation" NOT NULL,
    "response_digest" CHAR(64) NOT NULL,
    "record_count" INTEGER NOT NULL,
    "catalog_record_count" INTEGER NOT NULL,
    "pull_record_count" INTEGER NOT NULL,
    "market_event_record_count" INTEGER NOT NULL,
    "accepted_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "quarantined_count" INTEGER NOT NULL,
    "material_change_count" INTEGER NOT NULL,
    "committed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_run_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_commands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" TEXT NOT NULL,
    "command_type" "command_type" NOT NULL,
    "target_run_id" UUID,
    "target_quarantine_id" UUID,
    "expected_generation" BIGINT NOT NULL,
    "requested_by_operator_id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "reason" TEXT,
    "state" "command_state" NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "resulting_run_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quarantine_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_run_id" UUID NOT NULL,
    "provider_run_page_id" UUID NOT NULL,
    "record_index" INTEGER NOT NULL,
    "record_kind" TEXT NOT NULL,
    "entity_key" TEXT,
    "source_record_key" TEXT,
    "external_id" TEXT,
    "reason_code" TEXT NOT NULL,
    "field_path" TEXT,
    "sanitized_summary" TEXT NOT NULL,
    "candidate_schema_version" TEXT NOT NULL,
    "normalized_candidate" JSONB,
    "protected_evidence" JSONB,
    "evidence_expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now() + interval '90 days',
    "evidence_expired_at" TIMESTAMPTZ(6),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_retry_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "state" "quarantine_state" NOT NULL DEFAULT 'open',
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quarantine_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "quarantine_record_id" UUID NOT NULL,
    "requested_by_operator_id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "state" "quarantine_attempt_state" NOT NULL DEFAULT 'running',
    "failure_code" TEXT,
    "field_path" TEXT,
    "sanitized_summary" TEXT,
    "canonical_change_count" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_key" TEXT NOT NULL,
    "state" "retention_state" NOT NULL DEFAULT 'running',
    "cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "batch_size" INTEGER NOT NULL,
    "selected_count" INTEGER NOT NULL DEFAULT 0,
    "expired_count" INTEGER NOT NULL DEFAULT 0,
    "already_expired_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "remaining_count" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "sanitized_summary" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_audit_events" (
    "sequence" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    "command_id" UUID,
    "actor_operator_id" UUID,
    "correlation_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "outcome" "audit_outcome" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_audit_events_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "provider_activity_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_digest" CHAR(64) NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" "severity" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "recovery_key" TEXT NOT NULL,
    "local_run_id" UUID,
    "local_quarantine_id" UUID,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "event_at" TIMESTAMPTZ(6) NOT NULL,
    "delivery_state" "activity_delivery_state" NOT NULL DEFAULT 'pending',
    "delivery_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_delivery_attempt_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "last_failure_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_activity_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_change_consumers" (
    "consumer_key" TEXT NOT NULL,
    "last_confirmed_sequence" BIGINT NOT NULL DEFAULT 0,
    "confirmation_kind" TEXT,
    "confirmation_id" TEXT,
    "lease_owner" TEXT,
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_change_consumers_pkey" PRIMARY KEY ("consumer_key")
);

-- CreateTable
CREATE TABLE "provider_releases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "predecessor_id" UUID,
    "provider_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "public_provider_id" UUID NOT NULL,
    "through_change_sequence" BIGINT NOT NULL,
    "catalog_version_id" UUID NOT NULL,
    "catalog_content_hash" CHAR(64) NOT NULL,
    "central_schema_version" TEXT NOT NULL,
    "correlation_event_sequence" BIGINT NOT NULL,
    "correlation_snapshot_hash" CHAR(64) NOT NULL,
    "public_profile_version_id" UUID NOT NULL,
    "public_profile_hash" CHAR(64) NOT NULL,
    "provider_schema_version" TEXT NOT NULL,
    "public_schema_version" TEXT NOT NULL,
    "lifecycle" "artifact_lifecycle" NOT NULL DEFAULT 'building',
    "category_count" INTEGER NOT NULL,
    "repack_count" INTEGER NOT NULL,
    "collectible_reference_count" INTEGER NOT NULL,
    "chase_count" INTEGER NOT NULL,
    "retired_repack_count" INTEGER NOT NULL,
    "batch_count" INTEGER NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "index_hash" CHAR(64) NOT NULL,
    "data_as_of" TIMESTAMPTZ(6) NOT NULL,
    "last_successful_observation_at" TIMESTAMPTZ(6) NOT NULL,
    "stale_at" TIMESTAMPTZ(6) NOT NULL,
    "freshness" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assembled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "provider_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_release_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_release_id" UUID NOT NULL,
    "batch_kind" TEXT NOT NULL,
    "batch_index" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "record_count" INTEGER NOT NULL,
    "byte_count" INTEGER NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_release_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_publication_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_release_id" UUID NOT NULL,
    "operation_kind" TEXT NOT NULL,
    "batch_index" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "request_bytes" BYTEA NOT NULL,
    "body_hash" CHAR(64),
    "lease_fence" BIGINT NOT NULL,
    "state" "publication_operation_state" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempted_at" TIMESTAMPTZ(6),
    "failure_code" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "provider_publication_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_publication_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation_id" UUID NOT NULL,
    "provider_release_id" UUID NOT NULL,
    "remote_receipt_id" TEXT NOT NULL,
    "outcome" "publication_receipt_outcome" NOT NULL,
    "response_digest" CHAR(64) NOT NULL,
    "response_bytes" BYTEA NOT NULL,
    "accepted_content_hash" CHAR(64),
    "accepted_record_count" INTEGER,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_publication_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_publication_state" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "completed_release_id" UUID,
    "completed_through_change_sequence" BIGINT NOT NULL DEFAULT 0,
    "completion_receipt_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "observed_active_manifest_id" TEXT,
    "last_reconciled_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_publication_state_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_category_key_key" ON "categories"("category_key");

-- CreateIndex
CREATE INDEX "categories_parent_lifecycle_idx" ON "categories"("parent_category_id", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "packs_pack_key_key" ON "packs"("pack_key");

-- CreateIndex
CREATE INDEX "packs_category_lifecycle_idx" ON "packs"("category_id", "lifecycle");

-- CreateIndex
CREATE INDEX "packs_availability_lifecycle_idx" ON "packs"("availability", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "collectibles_collectible_key_key" ON "collectibles"("collectible_key");

-- CreateIndex
CREATE INDEX "collectibles_category_type_idx" ON "collectibles"("category_id", "collectible_type");

-- CreateIndex
CREATE INDEX "collectibles_normalized_name_idx" ON "collectibles"("normalized_name");

-- CreateIndex
CREATE INDEX "collectibles_lifecycle_idx" ON "collectibles"("lifecycle");

-- CreateIndex
CREATE INDEX "collectible_aliases_collectible_lifecycle_idx" ON "collectible_name_aliases"("collectible_id", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "collectible_instances_instance_key_key" ON "collectible_instances"("instance_key");

-- CreateIndex
CREATE INDEX "collectible_instances_collectible_lifecycle_idx" ON "collectible_instances"("collectible_id", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "collectible_instances_id_collectible_id_key" ON "collectible_instances"("id", "collectible_id");

-- CreateIndex
CREATE INDEX "pack_contents_pack_lifecycle_idx" ON "pack_contents"("pack_id", "lifecycle");

-- CreateIndex
CREATE INDEX "pack_contents_collectible_lifecycle_idx" ON "pack_contents"("collectible_id", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_account_key_key" ON "provider_accounts"("account_key");

-- CreateIndex
CREATE UNIQUE INDEX "pulls_pull_key_key" ON "pulls"("pull_key");

-- CreateIndex
CREATE INDEX "pulls_pack_occurred_idx" ON "pulls"("pack_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "pulls_account_occurred_idx" ON "pulls"("provider_account_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pull_items_pull_id_ordinal_key" ON "pull_items"("pull_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "market_events_event_key_key" ON "market_events"("event_key");

-- CreateIndex
CREATE INDEX "market_events_group_type_occurred_idx" ON "market_events"("event_group_id", "event_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "market_events_pack_occurred_idx" ON "market_events"("pack_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "market_events_collectible_occurred_idx" ON "market_events"("collectible_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "market_events_instance_occurred_idx" ON "market_events"("collectible_instance_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "promotion_changes_entity_version_operation_key" ON "promotion_changes"("entity_type", "entity_id", "entity_version", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "provider_state_events_state_generation_key" ON "provider_state_events"("state_generation");

-- CreateIndex
CREATE UNIQUE INDEX "provider_runs_idempotency_key_key" ON "provider_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "provider_runs_control_command_id_idx" ON "provider_runs"("control_command_id");

-- CreateIndex
CREATE INDEX "provider_runs_recovery_of_run_id_idx" ON "provider_runs"("recovery_of_run_id");

-- CreateIndex
CREATE INDEX "provider_runs_state_requested_idx" ON "provider_runs"("state", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "provider_run_pages_run_requested_cursor_idx" ON "provider_run_pages"("provider_run_id", "requested_cursor_hash");

-- CreateIndex
CREATE UNIQUE INDEX "provider_run_pages_id_provider_run_id_key" ON "provider_run_pages"("id", "provider_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_run_pages_run_page_number_key" ON "provider_run_pages"("provider_run_id", "page_number");

-- CreateIndex
CREATE UNIQUE INDEX "control_commands_idempotency_key_key" ON "control_commands"("idempotency_key");

-- CreateIndex
CREATE INDEX "control_commands_state_requested_idx" ON "control_commands"("state", "requested_at");

-- CreateIndex
CREATE INDEX "quarantine_records_state_created_idx" ON "quarantine_records"("state", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quarantine_records_run_page_idx" ON "quarantine_records"("provider_run_id", "provider_run_page_id");

-- CreateIndex
CREATE UNIQUE INDEX "quarantine_records_page_kind_record_key" ON "quarantine_records"("provider_run_page_id", "record_kind", "record_index");

-- CreateIndex
CREATE INDEX "quarantine_attempts_record_started_idx" ON "quarantine_attempts"("quarantine_record_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "retention_executions_started_state_idx" ON "retention_executions"("started_at" DESC, "state");

-- CreateIndex
CREATE INDEX "local_audit_events_occurred_idx" ON "local_audit_events"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "local_audit_events_correlation_id_idx" ON "local_audit_events"("correlation_id");

-- CreateIndex
CREATE INDEX "provider_activity_outbox_delivery_created_idx" ON "provider_activity_outbox"("delivery_state", "created_at");

-- CreateIndex
CREATE INDEX "provider_activity_outbox_dedupe_event_idx" ON "provider_activity_outbox"("dedupe_key", "event_at" DESC);

-- CreateIndex
CREATE INDEX "provider_releases_predecessor_id_idx" ON "provider_releases"("predecessor_id");

-- CreateIndex
CREATE INDEX "provider_releases_lifecycle_created_idx" ON "provider_releases"("lifecycle", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "provider_release_batches_release_kind_index_key" ON "provider_release_batches"("provider_release_id", "batch_kind", "batch_index");

-- CreateIndex
CREATE UNIQUE INDEX "provider_publication_operations_idempotency_key_key" ON "provider_publication_operations"("idempotency_key");

-- CreateIndex
CREATE INDEX "provider_publication_operations_state_requested_idx" ON "provider_publication_operations"("state", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_publication_operations_id_release_id_key" ON "provider_publication_operations"("id", "provider_release_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_publication_receipts_operation_id_key" ON "provider_publication_receipts"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_publication_receipts_remote_receipt_id_key" ON "provider_publication_receipts"("remote_receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_publication_receipts_operation_release_key" ON "provider_publication_receipts"("operation_id", "provider_release_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "packs" ADD CONSTRAINT "packs_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "collectibles" ADD CONSTRAINT "collectibles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "collectible_name_aliases" ADD CONSTRAINT "collectible_name_aliases_collectible_id_fkey" FOREIGN KEY ("collectible_id") REFERENCES "collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "collectible_instances" ADD CONSTRAINT "collectible_instances_collectible_id_fkey" FOREIGN KEY ("collectible_id") REFERENCES "collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pack_contents" ADD CONSTRAINT "pack_contents_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "packs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pack_contents" ADD CONSTRAINT "pack_contents_collectible_id_fkey" FOREIGN KEY ("collectible_id") REFERENCES "collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pack_contents" ADD CONSTRAINT "pack_contents_instance_collectible_fkey" FOREIGN KEY ("collectible_instance_id", "collectible_id") REFERENCES "collectible_instances"("id", "collectible_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pulls" ADD CONSTRAINT "pulls_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "packs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pulls" ADD CONSTRAINT "pulls_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pull_items" ADD CONSTRAINT "pull_items_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "pulls"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pull_items" ADD CONSTRAINT "pull_items_collectible_id_fkey" FOREIGN KEY ("collectible_id") REFERENCES "collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pull_items" ADD CONSTRAINT "pull_items_instance_collectible_fkey" FOREIGN KEY ("collectible_instance_id", "collectible_id") REFERENCES "collectible_instances"("id", "collectible_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "packs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_collectible_id_fkey" FOREIGN KEY ("collectible_id") REFERENCES "collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_instance_collectible_fkey" FOREIGN KEY ("collectible_instance_id", "collectible_id") REFERENCES "collectible_instances"("id", "collectible_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_from_account_id_fkey" FOREIGN KEY ("from_provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_to_account_id_fkey" FOREIGN KEY ("to_provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_control_command_id_fkey" FOREIGN KEY ("control_command_id") REFERENCES "control_commands"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_recovery_of_run_id_fkey" FOREIGN KEY ("recovery_of_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_run_pages" ADD CONSTRAINT "provider_run_pages_provider_run_id_fkey" FOREIGN KEY ("provider_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "control_commands" ADD CONSTRAINT "control_commands_target_run_id_fkey" FOREIGN KEY ("target_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "control_commands" ADD CONSTRAINT "control_commands_target_quarantine_id_fkey" FOREIGN KEY ("target_quarantine_id") REFERENCES "quarantine_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "control_commands" ADD CONSTRAINT "control_commands_resulting_run_id_fkey" FOREIGN KEY ("resulting_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_provider_run_id_fkey" FOREIGN KEY ("provider_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_page_run_fkey" FOREIGN KEY ("provider_run_page_id", "provider_run_id") REFERENCES "provider_run_pages"("id", "provider_run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quarantine_attempts" ADD CONSTRAINT "quarantine_attempts_record_id_fkey" FOREIGN KEY ("quarantine_record_id") REFERENCES "quarantine_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "local_audit_events" ADD CONSTRAINT "local_audit_events_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "control_commands"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_activity_outbox" ADD CONSTRAINT "provider_activity_outbox_local_run_id_fkey" FOREIGN KEY ("local_run_id") REFERENCES "provider_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_activity_outbox" ADD CONSTRAINT "provider_activity_outbox_local_quarantine_id_fkey" FOREIGN KEY ("local_quarantine_id") REFERENCES "quarantine_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_releases" ADD CONSTRAINT "provider_releases_predecessor_id_fkey" FOREIGN KEY ("predecessor_id") REFERENCES "provider_releases"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_release_batches" ADD CONSTRAINT "provider_release_batches_release_id_fkey" FOREIGN KEY ("provider_release_id") REFERENCES "provider_releases"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_publication_operations" ADD CONSTRAINT "provider_publication_operations_release_id_fkey" FOREIGN KEY ("provider_release_id") REFERENCES "provider_releases"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_publication_receipts" ADD CONSTRAINT "provider_publication_receipts_operation_release_fkey" FOREIGN KEY ("operation_id", "provider_release_id") REFERENCES "provider_publication_operations"("id", "provider_release_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_publication_receipts" ADD CONSTRAINT "provider_publication_receipts_release_id_fkey" FOREIGN KEY ("provider_release_id") REFERENCES "provider_releases"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_publication_state" ADD CONSTRAINT "provider_publication_state_release_id_fkey" FOREIGN KEY ("completed_release_id") REFERENCES "provider_releases"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_publication_state" ADD CONSTRAINT "provider_publication_state_receipt_id_fkey" FOREIGN KEY ("completion_receipt_id") REFERENCES "provider_publication_receipts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Native helpers used by checks that Prisma cannot express.
CREATE FUNCTION "packscout_currency_is_valid"("value" text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT "value" ~ '^[A-Z0-9]{2,12}$'
      OR "value" ~ '^0x[0-9A-Fa-f]{40}$';
$$;

CREATE FUNCTION "packscout_text_array_is_sorted_unique"("values" text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM unnest("values") WITH ORDINALITY AS current_value(value, ordinal)
    LEFT JOIN unnest("values") WITH ORDINALITY AS prior_value(value, ordinal)
      ON prior_value.ordinal = current_value.ordinal - 1
    WHERE current_value.value IS NULL
       OR (current_value.ordinal > 1 AND prior_value.value >= current_value.value)
  );
$$;

CREATE FUNCTION "packscout_confidence_is_valid"("value" jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof("value") = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys("value")) = 3
     AND "value" ?& ARRAY['scoreBasisPoints', 'band', 'limitationCodes']
     AND jsonb_typeof("value" -> 'scoreBasisPoints') = 'number'
     AND (("value" ->> 'scoreBasisPoints')::numeric % 1) = 0
     AND ("value" ->> 'scoreBasisPoints')::numeric BETWEEN 0 AND 10000
     AND jsonb_typeof("value" -> 'band') = 'string'
     AND (
       (("value" ->> 'scoreBasisPoints')::int BETWEEN 0 AND 4999 AND "value" ->> 'band' = 'low')
       OR (("value" ->> 'scoreBasisPoints')::int BETWEEN 5000 AND 7999 AND "value" ->> 'band' = 'medium')
       OR (("value" ->> 'scoreBasisPoints')::int BETWEEN 8000 AND 10000 AND "value" ->> 'band' = 'high')
     )
     AND jsonb_typeof("value" -> 'limitationCodes') = 'array'
     AND jsonb_array_length("value" -> 'limitationCodes') <= 16
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements("value" -> 'limitationCodes') WITH ORDINALITY AS current_value(value, ordinal)
       LEFT JOIN jsonb_array_elements("value" -> 'limitationCodes') WITH ORDINALITY AS prior_value(value, ordinal)
         ON prior_value.ordinal = current_value.ordinal - 1
       WHERE jsonb_typeof(current_value.value) <> 'string'
          OR length(btrim(current_value.value #>> '{}')) NOT BETWEEN 1 AND 64
          OR (
            current_value.ordinal > 1
            AND prior_value.value #>> '{}' >= current_value.value #>> '{}'
          )
     );
$$;

CREATE FUNCTION "packscout_json_has_protected_key"("value" jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  entry record;
BEGIN
  IF jsonb_typeof("value") = 'object' THEN
    FOR entry IN SELECT key, value FROM jsonb_each("value") LOOP
      IF lower(entry.key) IN (
        'credential', 'credentials', 'password', 'secret', 'token',
        'ciphertext', 'nonce', 'auth_tag', 'authorization'
      ) OR "packscout_json_has_protected_key"(entry.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof("value") = 'array' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements("value") LOOP
      IF "packscout_json_has_protected_key"(entry.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

-- Partial, constant-expression, and NULLS NOT DISTINCT uniqueness.
CREATE UNIQUE INDEX "collectible_name_aliases_active_name_key"
  ON "collectible_name_aliases"("collectible_id", "normalized_name")
  WHERE "lifecycle" = 'active';

CREATE UNIQUE INDEX "pack_contents_one_active_top_chase_key"
  ON "pack_contents"("pack_id")
  WHERE "lifecycle" = 'active' AND "content_role" = 'top_chase';

CREATE UNIQUE INDEX "pack_contents_active_exact_identity_key"
  ON "pack_contents"("pack_id", "collectible_instance_id")
  WHERE "lifecycle" = 'active' AND "collectible_instance_id" IS NOT NULL;

CREATE UNIQUE INDEX "pack_contents_active_collectible_identity_key"
  ON "pack_contents"("pack_id", "collectible_id")
  WHERE "lifecycle" = 'active' AND "collectible_instance_id" IS NULL;

CREATE UNIQUE INDEX "provider_runs_one_active_key"
  ON "provider_runs"((true))
  WHERE "state" IN ('queued', 'running');

CREATE UNIQUE INDEX "provider_runs_control_command_key"
  ON "provider_runs"("control_command_id")
  WHERE "control_command_id" IS NOT NULL;

DROP INDEX "provider_run_pages_run_requested_cursor_idx";
CREATE UNIQUE INDEX "provider_run_pages_run_requested_cursor_key"
  ON "provider_run_pages"("provider_run_id", "requested_cursor_hash") NULLS NOT DISTINCT;

CREATE UNIQUE INDEX "quarantine_attempts_one_running_key"
  ON "quarantine_attempts"("quarantine_record_id")
  WHERE "state" = 'running';

CREATE UNIQUE INDEX "provider_releases_complete_inputs_key"
  ON "provider_releases"(
    "through_change_sequence",
    "catalog_version_id",
    "catalog_content_hash",
    "correlation_event_sequence",
    "correlation_snapshot_hash",
    "public_profile_version_id",
    "public_profile_hash",
    "provider_schema_version",
    "public_schema_version",
    "content_hash",
    "index_hash"
  )
  WHERE "lifecycle" = 'complete';

-- Identity and canonical-domain checks.
ALTER TABLE "database_identity"
  ADD CONSTRAINT "database_identity_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "database_identity_role_check" CHECK ("database_role" = 'provider'),
  ADD CONSTRAINT "database_identity_schema_version_check" CHECK ("schema_version" = 'distributed-provider-v1'),
  ADD CONSTRAINT "database_identity_provider_key_check" CHECK ("provider_key" ~ '^[a-z][a-z0-9_]{0,52}$');

ALTER TABLE "categories"
  ADD CONSTRAINT "categories_no_self_parent_check" CHECK ("parent_category_id" IS NULL OR "parent_category_id" <> "id"),
  ADD CONSTRAINT "categories_category_key_check" CHECK (length(btrim("category_key")) > 0),
  ADD CONSTRAINT "categories_display_name_check" CHECK (length(btrim("display_name")) > 0),
  ADD CONSTRAINT "categories_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "categories_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "packs"
  ADD CONSTRAINT "packs_pack_key_check" CHECK (length(btrim("pack_key")) > 0),
  ADD CONSTRAINT "packs_family_key_check" CHECK ("family_key" IS NULL OR length(btrim("family_key")) > 0),
  ADD CONSTRAINT "packs_display_name_check" CHECK (length(btrim("display_name")) > 0),
  ADD CONSTRAINT "packs_inventory_check" CHECK (
    ("total_inventory" IS NULL OR "total_inventory" >= 0)
    AND ("remaining_inventory" IS NULL OR "remaining_inventory" >= 0)
    AND ("total_inventory" IS NULL OR "remaining_inventory" IS NULL OR "remaining_inventory" <= "total_inventory")
  ),
  ADD CONSTRAINT "packs_price_pair_check" CHECK (("price_amount" IS NULL) = ("price_currency" IS NULL)),
  ADD CONSTRAINT "packs_price_nonnegative_check" CHECK ("price_amount" IS NULL OR "price_amount" >= 0),
  ADD CONSTRAINT "packs_price_currency_check" CHECK ("price_currency" IS NULL OR "packscout_currency_is_valid"("price_currency")),
  ADD CONSTRAINT "packs_price_usd_nonnegative_check" CHECK ("price_usd_amount" IS NULL OR "price_usd_amount" >= 0),
  ADD CONSTRAINT "packs_buyback_check" CHECK (
    ("buyback_rate" IS NULL) = ("buyback_source_kind" IS NULL)
    AND ("buyback_rate" IS NULL OR "buyback_rate" BETWEEN 0 AND 1)
  ),
  ADD CONSTRAINT "packs_vendor_ev_pair_check" CHECK (("vendor_ev_amount" IS NULL) = ("vendor_ev_currency" IS NULL)),
  ADD CONSTRAINT "packs_vendor_ev_nonnegative_check" CHECK ("vendor_ev_amount" IS NULL OR "vendor_ev_amount" >= 0),
  ADD CONSTRAINT "packs_vendor_ev_currency_check" CHECK ("vendor_ev_currency" IS NULL OR "packscout_currency_is_valid"("vendor_ev_currency")),
  ADD CONSTRAINT "packs_packscout_ev_pair_check" CHECK (("packscout_ev_amount" IS NULL) = ("packscout_ev_currency" IS NULL)),
  ADD CONSTRAINT "packs_packscout_ev_nonnegative_check" CHECK ("packscout_ev_amount" IS NULL OR "packscout_ev_amount" >= 0),
  ADD CONSTRAINT "packs_packscout_ev_currency_check" CHECK ("packscout_ev_currency" IS NULL OR "packscout_currency_is_valid"("packscout_ev_currency")),
  ADD CONSTRAINT "packs_ev_versions_check" CHECK (
    length(btrim("packscout_ev_model_version")) > 0
    AND length(btrim("packscout_ev_confidence_policy_version")) > 0
  ),
  ADD CONSTRAINT "packs_confidence_check" CHECK ("packscout_ev_confidence" IS NULL OR "packscout_confidence_is_valid"("packscout_ev_confidence")),
  ADD CONSTRAINT "packs_image_pair_check" CHECK (("primary_image_url" IS NULL) = ("primary_image_alt" IS NULL)),
  ADD CONSTRAINT "packs_attributes_object_check" CHECK (jsonb_typeof("attributes") = 'object'),
  ADD CONSTRAINT "packs_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "packs_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "collectibles"
  ADD CONSTRAINT "collectibles_key_check" CHECK (length(btrim("collectible_key")) > 0),
  ADD CONSTRAINT "collectibles_names_check" CHECK (length(btrim("display_name")) > 0 AND length(btrim("normalized_name")) > 0),
  ADD CONSTRAINT "collectibles_year_check" CHECK ("year" IS NULL OR "year" BETWEEN 1000 AND 9999),
  ADD CONSTRAINT "collectibles_valuation_pair_check" CHECK (("valuation_amount" IS NULL) = ("valuation_currency" IS NULL)),
  ADD CONSTRAINT "collectibles_valuation_nonnegative_check" CHECK ("valuation_amount" IS NULL OR "valuation_amount" >= 0),
  ADD CONSTRAINT "collectibles_valuation_currency_check" CHECK ("valuation_currency" IS NULL OR "packscout_currency_is_valid"("valuation_currency")),
  ADD CONSTRAINT "collectibles_valuation_usd_nonnegative_check" CHECK ("valuation_usd_amount" IS NULL OR "valuation_usd_amount" >= 0),
  ADD CONSTRAINT "collectibles_image_pair_check" CHECK (("primary_image_url" IS NULL) = ("primary_image_alt" IS NULL)),
  ADD CONSTRAINT "collectibles_attributes_object_check" CHECK (jsonb_typeof("attributes") = 'object'),
  ADD CONSTRAINT "collectibles_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "collectibles_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "collectible_name_aliases"
  ADD CONSTRAINT "collectible_name_aliases_names_check" CHECK (length(btrim("display_name")) > 0 AND length(btrim("normalized_name")) > 0),
  ADD CONSTRAINT "collectible_name_aliases_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "collectible_name_aliases_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "collectible_instances"
  ADD CONSTRAINT "collectible_instances_key_check" CHECK (length(btrim("instance_key")) > 0),
  ADD CONSTRAINT "collectible_instances_certification_pair_check" CHECK (("certifier" IS NULL) = ("certification_number" IS NULL)),
  ADD CONSTRAINT "collectible_instances_attributes_object_check" CHECK (jsonb_typeof("attributes") = 'object'),
  ADD CONSTRAINT "collectible_instances_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "collectible_instances_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "pack_contents"
  ADD CONSTRAINT "pack_contents_quantity_check" CHECK (
    ("total_quantity" IS NULL OR "total_quantity" >= 0)
    AND ("available_quantity" IS NULL OR "available_quantity" >= 0)
    AND ("total_quantity" IS NULL OR "available_quantity" IS NULL OR "available_quantity" <= "total_quantity")
  ),
  ADD CONSTRAINT "pack_contents_probability_check" CHECK ("probability" IS NULL OR "probability" BETWEEN 0 AND 1),
  ADD CONSTRAINT "pack_contents_value_pair_check" CHECK (("stated_value_amount" IS NULL) = ("stated_value_currency" IS NULL)),
  ADD CONSTRAINT "pack_contents_value_nonnegative_check" CHECK ("stated_value_amount" IS NULL OR "stated_value_amount" >= 0),
  ADD CONSTRAINT "pack_contents_value_currency_check" CHECK ("stated_value_currency" IS NULL OR "packscout_currency_is_valid"("stated_value_currency")),
  ADD CONSTRAINT "pack_contents_evidence_check" CHECK (
    cardinality("evidence_kinds") BETWEEN 1 AND 6
    AND "packscout_text_array_is_sorted_unique"("evidence_kinds")
    AND "evidence_kinds" <@ ARRAY[
      'vendor_inventory', 'vendor_odds', 'vendor_featured_chase',
      'packscout_resolved', 'historical_pull_inference', 'name_only'
    ]::text[]
  ),
  ADD CONSTRAINT "pack_contents_confidence_check" CHECK (
    "match_confidence_basis_points" BETWEEN 0 AND 10000
    AND (
      ("match_confidence_basis_points" <= 4999 AND "match_confidence_band" = 'low')
      OR ("match_confidence_basis_points" BETWEEN 5000 AND 7999 AND "match_confidence_band" = 'medium')
      OR ("match_confidence_basis_points" >= 8000 AND "match_confidence_band" = 'high')
    )
  ),
  ADD CONSTRAINT "pack_contents_display_order_check" CHECK ("display_order" >= 0),
  ADD CONSTRAINT "pack_contents_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "pack_contents_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_accounts"
  ADD CONSTRAINT "provider_accounts_key_check" CHECK ("account_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "provider_accounts_attributes_object_check" CHECK (jsonb_typeof("attributes") = 'object'),
  ADD CONSTRAINT "provider_accounts_lifecycle_time_check" CHECK (("lifecycle" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "provider_accounts_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "pulls"
  ADD CONSTRAINT "pulls_key_check" CHECK (length(btrim("pull_key")) > 0),
  ADD CONSTRAINT "pulls_digest_check" CHECK ("fact_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "pulls_paid_pair_check" CHECK (("paid_amount" IS NULL) = ("paid_currency" IS NULL)),
  ADD CONSTRAINT "pulls_paid_nonnegative_check" CHECK ("paid_amount" IS NULL OR "paid_amount" >= 0),
  ADD CONSTRAINT "pulls_paid_currency_check" CHECK ("paid_currency" IS NULL OR "packscout_currency_is_valid"("paid_currency"));

ALTER TABLE "pull_items"
  ADD CONSTRAINT "pull_items_ordinal_check" CHECK ("ordinal" > 0),
  ADD CONSTRAINT "pull_items_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "pull_items_value_pair_check" CHECK (("stated_value_amount" IS NULL) = ("stated_value_currency" IS NULL)),
  ADD CONSTRAINT "pull_items_value_nonnegative_check" CHECK ("stated_value_amount" IS NULL OR "stated_value_amount" >= 0),
  ADD CONSTRAINT "pull_items_value_currency_check" CHECK ("stated_value_currency" IS NULL OR "packscout_currency_is_valid"("stated_value_currency"));

ALTER TABLE "market_events"
  ADD CONSTRAINT "market_events_key_check" CHECK (length(btrim("event_key")) > 0),
  ADD CONSTRAINT "market_events_digest_check" CHECK ("fact_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "market_events_subject_check" CHECK ("pack_id" IS NOT NULL OR "collectible_id" IS NOT NULL OR "collectible_instance_id" IS NOT NULL),
  ADD CONSTRAINT "market_events_instance_collectible_check" CHECK ("collectible_instance_id" IS NULL OR "collectible_id" IS NOT NULL),
  ADD CONSTRAINT "market_events_quantity_check" CHECK ("quantity" IS NULL OR "quantity" > 0),
  ADD CONSTRAINT "market_events_amount_pair_check" CHECK (("amount" IS NULL) = ("currency" IS NULL)),
  ADD CONSTRAINT "market_events_amount_nonnegative_check" CHECK ("amount" IS NULL OR "amount" >= 0),
  ADD CONSTRAINT "market_events_currency_check" CHECK ("currency" IS NULL OR "packscout_currency_is_valid"("currency")),
  ADD CONSTRAINT "market_events_details_object_check" CHECK (jsonb_typeof("details") = 'object');

ALTER TABLE "promotion_ledger"
  ADD CONSTRAINT "promotion_ledger_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "promotion_ledger_sequence_check" CHECK ("last_sequence" >= 0);

ALTER TABLE "promotion_changes"
  ADD CONSTRAINT "promotion_changes_sequence_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "promotion_changes_entity_version_check" CHECK ("entity_version" > 0),
  ADD CONSTRAINT "promotion_changes_entity_type_check" CHECK ("entity_type" IN (
    'category', 'pack', 'collectible', 'collectible_name_alias',
    'collectible_instance', 'pack_content', 'provider_account',
    'pull', 'pull_item', 'market_event'
  ));

-- Provider runtime, mixed-run, recovery, and publication checks.
ALTER TABLE "provider_runtime"
  ADD CONSTRAINT "provider_runtime_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "provider_runtime_provider_key_check" CHECK ("provider_key" ~ '^[a-z][a-z0-9_]{0,52}$'),
  ADD CONSTRAINT "provider_runtime_reason_check" CHECK (
    (("operating_state" IN ('paused', 'stopped', 'error')) AND length(btrim("state_reason")) > 0)
    OR (("operating_state" IN ('idle', 'running')) AND "state_reason" IS NULL)
  ),
  ADD CONSTRAINT "provider_runtime_generation_check" CHECK ("state_generation" >= 0),
  ADD CONSTRAINT "provider_runtime_config_group_check" CHECK (
    (
      "cached_config_version_id" IS NULL
      AND "cached_config_version_number" IS NULL
      AND "cached_configuration" IS NULL
      AND "last_control_sync_at" IS NULL
      AND "schedule_seconds" IS NULL
      AND "config_expires_at" IS NULL
    ) OR (
      "cached_config_version_id" IS NOT NULL
      AND "cached_config_version_number" > 0
      AND jsonb_typeof("cached_configuration") = 'object'
      AND NOT "packscout_json_has_protected_key"("cached_configuration")
      AND "last_control_sync_at" IS NOT NULL
      AND "schedule_seconds" >= 60
    )
  ),
  ADD CONSTRAINT "provider_runtime_cursor_pair_check" CHECK (("source_cursor" IS NULL) = ("source_cursor_hash" IS NULL)),
  ADD CONSTRAINT "provider_runtime_cursor_hash_check" CHECK ("source_cursor_hash" IS NULL OR "source_cursor_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "provider_runtime_health_check" CHECK (length(btrim("freshness_state")) > 0 AND length(btrim("quality_state")) > 0),
  ADD CONSTRAINT "provider_runtime_failures_check" CHECK ("consecutive_failures" >= 0),
  ADD CONSTRAINT "provider_runtime_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_state_events"
  ADD CONSTRAINT "provider_state_events_generation_check" CHECK ("state_generation" > 0),
  ADD CONSTRAINT "provider_state_events_distinct_state_check" CHECK ("from_state" IS NULL OR "from_state" <> "to_state"),
  ADD CONSTRAINT "provider_state_events_reason_check" CHECK (
    (("to_state" IN ('paused', 'stopped', 'error')) AND length(btrim("reason")) > 0)
    OR (("to_state" IN ('idle', 'running')) AND "reason" IS NULL)
  ),
  ADD CONSTRAINT "provider_state_events_actor_check" CHECK (length(btrim("actor_type")) > 0 AND length(btrim("actor_id")) > 0),
  ADD CONSTRAINT "provider_state_events_transition_check" CHECK (
    ("from_state" IS NULL AND "to_state" = 'idle')
    OR ("from_state" = 'idle' AND "to_state" IN ('running', 'paused', 'stopped', 'error'))
    OR ("from_state" = 'running' AND "to_state" IN ('idle', 'paused', 'stopped', 'error'))
    OR ("from_state" = 'paused' AND "to_state" IN ('idle', 'running', 'stopped', 'error'))
    OR ("from_state" = 'stopped' AND "to_state" IN ('idle', 'error'))
    OR ("from_state" = 'error' AND "to_state" IN ('idle', 'paused', 'stopped'))
  );

ALTER TABLE "provider_worker_states"
  ADD CONSTRAINT "provider_worker_states_lease_group_check" CHECK (
    ("lease_owner" IS NULL AND "heartbeat_at" IS NULL AND "lease_expires_at" IS NULL)
    OR ("lease_owner" IS NOT NULL AND "heartbeat_at" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "lease_expires_at" > "heartbeat_at")
  ),
  ADD CONSTRAINT "provider_worker_states_fence_check" CHECK ("lease_fence" >= 0),
  ADD CONSTRAINT "provider_worker_states_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_runs"
  ADD CONSTRAINT "provider_runs_idempotency_key_check" CHECK (length(btrim("idempotency_key")) > 0),
  ADD CONSTRAINT "provider_runs_recovery_check" CHECK (
    ("trigger" = 'recovery' AND "recovery_of_run_id" IS NOT NULL)
    OR ("trigger" <> 'recovery' AND "recovery_of_run_id" IS NULL)
  ),
  ADD CONSTRAINT "provider_runs_config_check" CHECK ("config_version_number" > 0),
  ADD CONSTRAINT "provider_runs_fence_attempt_check" CHECK ("worker_fence" >= 0 AND "attempt_number" > 0),
  ADD CONSTRAINT "provider_runs_requested_cursor_pair_check" CHECK (("requested_cursor" IS NULL) = ("requested_cursor_hash" IS NULL)),
  ADD CONSTRAINT "provider_runs_final_cursor_pair_check" CHECK (("final_cursor" IS NULL) = ("final_cursor_hash" IS NULL)),
  ADD CONSTRAINT "provider_runs_cursor_hash_check" CHECK (
    ("requested_cursor_hash" IS NULL OR "requested_cursor_hash" ~ '^[0-9a-f]{64}$')
    AND ("final_cursor_hash" IS NULL OR "final_cursor_hash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "provider_runs_counts_check" CHECK (
    "page_count" >= 0
    AND "catalog_record_count" >= 0
    AND "pull_record_count" >= 0
    AND "market_event_record_count" >= 0
    AND "accepted_count" >= 0
    AND "duplicate_count" >= 0
    AND "quarantined_count" >= 0
    AND "material_change_count" >= 0
    AND "material_change_count" <= "accepted_count"
    AND "accepted_count" + "duplicate_count" + "quarantined_count"
      = "catalog_record_count" + "pull_record_count" + "market_event_record_count"
  ),
  ADD CONSTRAINT "provider_runs_state_time_check" CHECK (
    ("state" = 'queued' AND "started_at" IS NULL AND "finished_at" IS NULL)
    OR ("state" = 'running' AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
    OR ("state" IN ('succeeded', 'incomplete', 'failed') AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_runs_time_order_check" CHECK (
    ("started_at" IS NULL OR "started_at" >= "requested_at")
    AND ("last_progress_at" IS NULL OR ("started_at" IS NOT NULL AND "last_progress_at" >= "started_at"))
    AND ("heartbeat_at" IS NULL OR ("started_at" IS NOT NULL AND "heartbeat_at" >= "started_at"))
    AND ("finished_at" IS NULL OR ("started_at" IS NOT NULL AND "finished_at" >= "started_at"))
  ),
  ADD CONSTRAINT "provider_runs_failure_check" CHECK (
    ("state" = 'succeeded' AND "failure_code" IS NULL AND "failure_class" IS NULL AND "failure_summary" IS NULL)
    OR ("state" IN ('queued', 'running') AND "failure_code" IS NULL AND "failure_class" IS NULL AND "failure_summary" IS NULL)
    OR ("state" IN ('incomplete', 'failed') AND length(btrim("failure_code")) > 0 AND length(btrim("failure_class")) > 0 AND length(btrim("failure_summary")) > 0)
  ),
  ADD CONSTRAINT "provider_runs_head_check" CHECK ("state" <> 'succeeded' OR "reached_source_head"),
  ADD CONSTRAINT "provider_runs_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_run_pages"
  ADD CONSTRAINT "provider_run_pages_page_number_check" CHECK ("page_number" > 0),
  ADD CONSTRAINT "provider_run_pages_contract_version_check" CHECK (length(btrim("contract_version")) > 0),
  ADD CONSTRAINT "provider_run_pages_requested_cursor_pair_check" CHECK (("requested_cursor" IS NULL) = ("requested_cursor_hash" IS NULL)),
  ADD CONSTRAINT "provider_run_pages_next_cursor_pair_check" CHECK (("next_cursor" IS NULL) = ("next_cursor_hash" IS NULL)),
  ADD CONSTRAINT "provider_run_pages_cursor_hash_check" CHECK (
    ("requested_cursor_hash" IS NULL OR "requested_cursor_hash" ~ '^[0-9a-f]{64}$')
    AND ("next_cursor_hash" IS NULL OR "next_cursor_hash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "provider_run_pages_continuation_check" CHECK (
    ("continuation" = 'head' AND "next_cursor" IS NULL)
    OR ("continuation" = 'more' AND "next_cursor" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_run_pages_digest_check" CHECK ("response_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "provider_run_pages_counts_check" CHECK (
    "record_count" >= 0
    AND "catalog_record_count" >= 0
    AND "pull_record_count" >= 0
    AND "market_event_record_count" >= 0
    AND "accepted_count" >= 0
    AND "duplicate_count" >= 0
    AND "quarantined_count" >= 0
    AND "material_change_count" >= 0
    AND "catalog_record_count" + "pull_record_count" + "market_event_record_count" = "record_count"
    AND "accepted_count" + "duplicate_count" + "quarantined_count" = "record_count"
    AND "material_change_count" <= "accepted_count"
  );

ALTER TABLE "control_commands"
  ADD CONSTRAINT "control_commands_idempotency_key_check" CHECK (length(btrim("idempotency_key")) > 0),
  ADD CONSTRAINT "control_commands_generation_check" CHECK ("expected_generation" >= 0),
  ADD CONSTRAINT "control_commands_target_check" CHECK (
    ("command_type" = 'retry_run' AND "target_run_id" IS NOT NULL AND "target_quarantine_id" IS NULL)
    OR ("command_type" = 'retry_quarantine' AND "target_run_id" IS NULL AND "target_quarantine_id" IS NOT NULL)
    OR ("command_type" IN ('run', 'pause', 'resume', 'stop') AND "target_run_id" IS NULL AND "target_quarantine_id" IS NULL)
  ),
  ADD CONSTRAINT "control_commands_resulting_run_check" CHECK ("resulting_run_id" IS NULL OR "command_type" IN ('run', 'retry_run')),
  ADD CONSTRAINT "control_commands_state_time_check" CHECK (
    ("state" = 'pending' AND "acknowledged_at" IS NULL AND "completed_at" IS NULL)
    OR ("state" = 'accepted' AND "acknowledged_at" IS NOT NULL AND "completed_at" IS NULL)
    OR ("state" IN ('rejected', 'completed', 'failed') AND "acknowledged_at" IS NOT NULL AND "completed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "control_commands_time_order_check" CHECK (
    ("acknowledged_at" IS NULL OR "acknowledged_at" >= "requested_at")
    AND ("completed_at" IS NULL OR ("acknowledged_at" IS NOT NULL AND "completed_at" >= "acknowledged_at"))
  ),
  ADD CONSTRAINT "control_commands_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "quarantine_records"
  ADD CONSTRAINT "quarantine_records_position_retry_check" CHECK ("record_index" >= 0 AND "retry_count" >= 0),
  ADD CONSTRAINT "quarantine_records_text_check" CHECK (
    length(btrim("record_kind")) > 0
    AND length(btrim("reason_code")) > 0
    AND length(btrim("sanitized_summary")) > 0
    AND length(btrim("candidate_schema_version")) > 0
  ),
  ADD CONSTRAINT "quarantine_records_candidate_shape_check" CHECK ("normalized_candidate" IS NULL OR jsonb_typeof("normalized_candidate") = 'object'),
  ADD CONSTRAINT "quarantine_records_evidence_shape_check" CHECK ("protected_evidence" IS NULL OR jsonb_typeof("protected_evidence") = 'object'),
  ADD CONSTRAINT "quarantine_records_evidence_time_check" CHECK (
    "evidence_expires_at" >= "created_at"
    AND ("evidence_expired_at" IS NULL OR "evidence_expired_at" >= "created_at")
  ),
  ADD CONSTRAINT "quarantine_records_state_check" CHECK (
    ("state" = 'open' AND "resolved_at" IS NULL AND "evidence_expired_at" IS NULL)
    OR ("state" = 'resolved' AND "resolved_at" IS NOT NULL)
    OR (
      "state" = 'expired'
      AND "resolved_at" IS NULL
      AND "evidence_expired_at" IS NOT NULL
      AND "normalized_candidate" IS NULL
      AND "protected_evidence" IS NULL
    )
  ),
  ADD CONSTRAINT "quarantine_records_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "quarantine_attempts"
  ADD CONSTRAINT "quarantine_attempts_change_count_check" CHECK ("canonical_change_count" IS NULL OR "canonical_change_count" >= 0),
  ADD CONSTRAINT "quarantine_attempts_state_check" CHECK (
    ("state" = 'running' AND "finished_at" IS NULL AND "failure_code" IS NULL AND "canonical_change_count" IS NULL)
    OR ("state" = 'succeeded' AND "finished_at" IS NOT NULL AND "failure_code" IS NULL AND "canonical_change_count" IS NOT NULL)
    OR ("state" = 'failed' AND "finished_at" IS NOT NULL AND length(btrim("failure_code")) > 0)
  ),
  ADD CONSTRAINT "quarantine_attempts_time_check" CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at");

ALTER TABLE "retention_executions"
  ADD CONSTRAINT "retention_executions_counts_check" CHECK (
    "batch_size" > 0
    AND "selected_count" >= 0
    AND "expired_count" >= 0
    AND "already_expired_count" >= 0
    AND "failed_count" >= 0
    AND "remaining_count" >= 0
    AND "expired_count" + "already_expired_count" + "failed_count" <= "selected_count"
  ),
  ADD CONSTRAINT "retention_executions_state_check" CHECK (
    ("state" = 'running' AND "finished_at" IS NULL AND "failure_code" IS NULL)
    OR ("state" = 'succeeded' AND "finished_at" IS NOT NULL AND "failure_code" IS NULL)
    OR ("state" = 'failed' AND "finished_at" IS NOT NULL AND length(btrim("failure_code")) > 0)
  ),
  ADD CONSTRAINT "retention_executions_time_check" CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at");

ALTER TABLE "local_audit_events"
  ADD CONSTRAINT "local_audit_events_text_check" CHECK (
    length(btrim("action")) > 0
    AND length(btrim("target_type")) > 0
    AND length(btrim("target_id")) > 0
  ),
  ADD CONSTRAINT "local_audit_events_details_object_check" CHECK (jsonb_typeof("details") = 'object');

ALTER TABLE "provider_activity_outbox"
  ADD CONSTRAINT "provider_activity_outbox_digest_check" CHECK ("event_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "provider_activity_outbox_text_check" CHECK (
    length(btrim("event_type")) > 0
    AND length(btrim("dedupe_key")) > 0
    AND length(btrim("recovery_key")) > 0
    AND length(btrim("title")) > 0
    AND length(btrim("summary")) > 0
  ),
  ADD CONSTRAINT "provider_activity_outbox_evidence_object_check" CHECK (jsonb_typeof("evidence") = 'object'),
  ADD CONSTRAINT "provider_activity_outbox_attempt_check" CHECK ("delivery_attempt_count" >= 0),
  ADD CONSTRAINT "provider_activity_outbox_delivery_check" CHECK (
    ("delivery_state" = 'pending' AND "delivered_at" IS NULL)
    OR ("delivery_state" = 'delivered' AND "delivered_at" IS NOT NULL AND "last_failure_code" IS NULL)
  ),
  ADD CONSTRAINT "provider_activity_outbox_attempt_time_check" CHECK (
    ("delivery_attempt_count" = 0 AND "last_delivery_attempt_at" IS NULL)
    OR ("delivery_attempt_count" > 0 AND "last_delivery_attempt_at" IS NOT NULL)
  );

ALTER TABLE "provider_change_consumers"
  ADD CONSTRAINT "provider_change_consumers_key_check" CHECK ("consumer_key" IN ('catalog_correlation', 'provider_release')),
  ADD CONSTRAINT "provider_change_consumers_sequence_fence_check" CHECK ("last_confirmed_sequence" >= 0 AND "lease_fence" >= 0),
  ADD CONSTRAINT "provider_change_consumers_confirmation_check" CHECK (
    ("last_confirmed_sequence" = 0 AND "confirmation_kind" IS NULL AND "confirmation_id" IS NULL)
    OR ("last_confirmed_sequence" > 0 AND length(btrim("confirmation_kind")) > 0 AND length(btrim("confirmation_id")) > 0)
  ),
  ADD CONSTRAINT "provider_change_consumers_lease_check" CHECK (
    ("lease_owner" IS NULL AND "lease_expires_at" IS NULL)
    OR ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_change_consumers_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_releases"
  ADD CONSTRAINT "provider_releases_provider_key_check" CHECK ("provider_key" ~ '^[a-z][a-z0-9_]{0,52}$'),
  ADD CONSTRAINT "provider_releases_sequence_count_check" CHECK (
    "through_change_sequence" >= 0
    AND "correlation_event_sequence" >= 0
    AND "category_count" >= 0
    AND "repack_count" >= 0
    AND "collectible_reference_count" >= 0
    AND "chase_count" >= 0
    AND "retired_repack_count" >= 0
    AND "batch_count" >= 0
  ),
  ADD CONSTRAINT "provider_releases_hash_check" CHECK (
    "catalog_content_hash" ~ '^[0-9a-f]{64}$'
    AND "correlation_snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "public_profile_hash" ~ '^[0-9a-f]{64}$'
    AND "content_hash" ~ '^[0-9a-f]{64}$'
    AND "index_hash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "provider_releases_schema_version_check" CHECK (
    "provider_schema_version" = 'distributed-provider-v1'
    AND length(btrim("central_schema_version")) > 0
    AND length(btrim("public_schema_version")) > 0
  ),
  ADD CONSTRAINT "provider_releases_time_check" CHECK (
    "last_successful_observation_at" <= "data_as_of"
    AND "data_as_of" <= "stale_at"
    AND ("assembled_at" IS NULL OR "assembled_at" >= "created_at")
    AND ("completed_at" IS NULL OR ("assembled_at" IS NOT NULL AND "completed_at" >= "assembled_at"))
  ),
  ADD CONSTRAINT "provider_releases_lifecycle_check" CHECK (
    ("lifecycle" = 'building' AND "assembled_at" IS NULL AND "completed_at" IS NULL)
    OR ("lifecycle" IN ('assembled', 'publishing', 'blocked', 'failed') AND "assembled_at" IS NOT NULL AND "completed_at" IS NULL)
    OR ("lifecycle" = 'complete' AND "assembled_at" IS NOT NULL AND "completed_at" IS NOT NULL)
  );

ALTER TABLE "provider_release_batches"
  ADD CONSTRAINT "provider_release_batches_kind_check" CHECK ("batch_kind" IN ('provider', 'category', 'repack', 'chase', 'retired-repack', 'search-index')),
  ADD CONSTRAINT "provider_release_batches_counts_check" CHECK ("batch_index" >= 0 AND "record_count" >= 0 AND "byte_count" >= 0),
  ADD CONSTRAINT "provider_release_batches_payload_check" CHECK (jsonb_typeof("payload") IN ('array', 'object')),
  ADD CONSTRAINT "provider_release_batches_hash_check" CHECK ("body_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "provider_publication_operations"
  ADD CONSTRAINT "provider_publication_operations_text_check" CHECK (length(btrim("operation_kind")) > 0 AND length(btrim("idempotency_key")) > 0),
  ADD CONSTRAINT "provider_publication_operations_index_check" CHECK ("batch_index" IS NULL OR "batch_index" >= 0),
  ADD CONSTRAINT "provider_publication_operations_hash_check" CHECK (
    "request_digest" ~ '^[0-9a-f]{64}$'
    AND ("body_hash" IS NULL OR "body_hash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "provider_publication_operations_fence_attempt_check" CHECK ("lease_fence" >= 0 AND "attempt_count" >= 0),
  ADD CONSTRAINT "provider_publication_operations_state_time_check" CHECK (
    ("state" IN ('pending', 'ambiguous') AND "completed_at" IS NULL)
    OR ("state" IN ('accepted', 'failed') AND "completed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_publication_operations_attempt_time_check" CHECK (
    ("attempt_count" = 0 AND "last_attempted_at" IS NULL)
    OR ("attempt_count" > 0 AND "last_attempted_at" IS NOT NULL)
  );

ALTER TABLE "provider_publication_receipts"
  ADD CONSTRAINT "provider_publication_receipts_text_check" CHECK (length(btrim("remote_receipt_id")) > 0),
  ADD CONSTRAINT "provider_publication_receipts_hash_check" CHECK (
    "response_digest" ~ '^[0-9a-f]{64}$'
    AND ("accepted_content_hash" IS NULL OR "accepted_content_hash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "provider_publication_receipts_outcome_check" CHECK (
    ("outcome" = 'accepted' AND "accepted_content_hash" IS NOT NULL AND "accepted_record_count" >= 0)
    OR ("outcome" = 'rejected' AND "accepted_content_hash" IS NULL AND "accepted_record_count" IS NULL)
  );

ALTER TABLE "provider_publication_state"
  ADD CONSTRAINT "provider_publication_state_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "provider_publication_state_completion_check" CHECK (
    (
      "completed_release_id" IS NULL
      AND "completed_through_change_sequence" = 0
      AND "completion_receipt_id" IS NULL
      AND "completed_at" IS NULL
    ) OR (
      "completed_release_id" IS NOT NULL
      AND "completed_through_change_sequence" >= 0
      AND "completion_receipt_id" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "provider_publication_state_row_version_check" CHECK ("row_version" > 0);

-- Compare-and-swap row-version behavior: callers supply the next version on a
-- material update; semantic no-ops preserve both version and timestamp.
CREATE FUNCTION "packscout_enforce_row_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'row_version' - 'updated_at')
       IS NOT DISTINCT FROM
     (to_jsonb(OLD) - 'row_version' - 'updated_at') THEN
    NEW."row_version" := OLD."row_version";
    NEW."updated_at" := OLD."updated_at";
    RETURN NEW;
  END IF;

  IF NEW."row_version" <> OLD."row_version" + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'row_version_conflict';
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "categories_row_version_trigger" BEFORE UPDATE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "packs_row_version_trigger" BEFORE UPDATE ON "packs"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "collectibles_row_version_trigger" BEFORE UPDATE ON "collectibles"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "collectible_name_aliases_row_version_trigger" BEFORE UPDATE ON "collectible_name_aliases"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "collectible_instances_row_version_trigger" BEFORE UPDATE ON "collectible_instances"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "pack_contents_row_version_trigger" BEFORE UPDATE ON "pack_contents"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_accounts_row_version_trigger" BEFORE UPDATE ON "provider_accounts"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_runtime_row_version_trigger" BEFORE UPDATE ON "provider_runtime"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_worker_states_row_version_trigger" BEFORE UPDATE ON "provider_worker_states"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_runs_row_version_trigger" BEFORE UPDATE ON "provider_runs"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "control_commands_row_version_trigger" BEFORE UPDATE ON "control_commands"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "quarantine_records_row_version_trigger" BEFORE UPDATE ON "quarantine_records"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_change_consumers_row_version_trigger" BEFORE UPDATE ON "provider_change_consumers"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_publication_state_row_version_trigger" BEFORE UPDATE ON "provider_publication_state"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();

CREATE FUNCTION "packscout_reject_append_only_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = TG_TABLE_NAME || '_append_only';
END;
$$;

CREATE TRIGGER "pulls_append_only_trigger" BEFORE UPDATE OR DELETE ON "pulls"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "pull_items_append_only_trigger" BEFORE UPDATE OR DELETE ON "pull_items"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "market_events_append_only_trigger" BEFORE UPDATE OR DELETE ON "market_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "promotion_changes_append_only_trigger" BEFORE UPDATE OR DELETE ON "promotion_changes"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "provider_state_events_append_only_trigger" BEFORE UPDATE OR DELETE ON "provider_state_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "provider_run_pages_append_only_trigger" BEFORE UPDATE OR DELETE ON "provider_run_pages"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "local_audit_events_append_only_trigger" BEFORE UPDATE OR DELETE ON "local_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();
CREATE TRIGGER "provider_publication_receipts_append_only_trigger" BEFORE UPDATE OR DELETE ON "provider_publication_receipts"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_append_only_change"();

-- Mutable canonical rows retire once and are never physically deleted. A
-- retired row is a terminal historical record; changing it would make an
-- already-published promotion sequence describe different content.
CREATE FUNCTION "packscout_guard_mutable_entity_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_NAME || '_delete_forbidden';
  END IF;
  IF OLD."lifecycle" = 'retired'
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_NAME || '_retired_immutable';
  END IF;
  IF NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle"
     AND NOT (OLD."lifecycle" = 'active' AND NEW."lifecycle" = 'retired') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = TG_TABLE_NAME || '_lifecycle_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "categories_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();
CREATE TRIGGER "packs_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "packs"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();
CREATE TRIGGER "collectibles_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "collectibles"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();
CREATE TRIGGER "collectible_name_aliases_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "collectible_name_aliases"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();
CREATE TRIGGER "collectible_instances_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "collectible_instances"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();
CREATE TRIGGER "pack_contents_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "pack_contents"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();
CREATE TRIGGER "provider_accounts_lifecycle_guard_trigger" BEFORE UPDATE OR DELETE ON "provider_accounts"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_mutable_entity_lifecycle"();

-- The provider identity row is immutable and must agree with the physical DB.
CREATE FUNCTION "packscout_guard_database_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'database_identity_immutable';
  END IF;

  IF NEW."database_role" <> 'provider'
     OR NEW."schema_version" <> 'distributed-provider-v1'
     OR current_database() <> 'packscout_' || NEW."provider_key" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_database_identity_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "database_identity_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "database_identity"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_database_identity"();

-- Category parentage is checked at commit so a multi-row tree rewrite is safe.
CREATE FUNCTION "packscout_assert_category_acyclic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."parent_category_id" IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors(id, parent_category_id) AS (
      SELECT category.id, category."parent_category_id"
      FROM "categories" AS category
      WHERE category.id = NEW."parent_category_id"
      UNION
      SELECT category.id, category."parent_category_id"
      FROM "categories" AS category
      JOIN ancestors ON category.id = ancestors.parent_category_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category_cycle';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "categories_acyclic_trigger"
  AFTER INSERT OR UPDATE OF "parent_category_id" ON "categories"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_category_acyclic"();

-- Pulls become visible only with at least one ordered item.
CREATE FUNCTION "packscout_assert_pull_has_item"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pull_items" WHERE "pull_id" = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'pull_requires_item';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "pulls_require_item_trigger"
  AFTER INSERT ON "pulls"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_pull_has_item"();

-- Ledger changes and the singleton head must always commit at one contiguous
-- boundary. The ledger-side check scans only the newly allocated sequence
-- range once; each change-side check uses primary/unique indexes. This avoids
-- a full promotion-history scan for every inserted change.
CREATE FUNCTION "packscout_assert_promotion_ledger_range"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_head bigint;
  range_count bigint;
  range_first bigint;
  range_last bigint;
BEGIN
  prior_head := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD."last_sequence" END;
  IF NEW."last_sequence" = prior_head THEN
    RETURN NULL;
  END IF;
  SELECT count(*), min("sequence"), max("sequence")
    INTO range_count, range_first, range_last
  FROM "promotion_changes"
  WHERE "sequence" > prior_head AND "sequence" <= NEW."last_sequence";
  IF range_count <> NEW."last_sequence" - prior_head
     OR range_first <> prior_head + 1
     OR range_last <> NEW."last_sequence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_ledger_not_contiguous';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_assert_promotion_change_sequence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ledger_head bigint;
BEGIN
  SELECT "last_sequence" INTO ledger_head
  FROM "promotion_ledger" WHERE "singleton_key" = true;
  IF ledger_head IS NULL OR NEW."sequence" > ledger_head
     OR (NEW."sequence" > 1 AND NOT EXISTS (
       SELECT 1 FROM "promotion_changes" WHERE "sequence" = NEW."sequence" - 1
     )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_change_outside_ledger';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_guard_promotion_ledger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."singleton_key" IS DISTINCT FROM OLD."singleton_key" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'promotion_ledger_identity_immutable';
  END IF;
  IF NEW."last_sequence" < OLD."last_sequence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_ledger_regression';
  END IF;
  IF NEW."last_sequence" = OLD."last_sequence" THEN
    NEW."updated_at" := OLD."updated_at";
  ELSE
    NEW."updated_at" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotion_ledger_guard_trigger" BEFORE UPDATE OR DELETE ON "promotion_ledger"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_promotion_ledger"();
CREATE CONSTRAINT TRIGGER "promotion_ledger_consistency_trigger"
  AFTER INSERT OR UPDATE ON "promotion_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_promotion_ledger_range"();
CREATE CONSTRAINT TRIGGER "promotion_changes_consistency_trigger"
  AFTER INSERT ON "promotion_changes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_promotion_change_sequence"();

-- Every contracted canonical/fact mutation must have its exact promotion row
-- at the same commit boundary. Mutable rows use their row_version and retire
-- operation; immutable facts always use version 1/upsert. The reverse check
-- prevents changes for missing entities or future/incorrect versions.
CREATE FUNCTION "packscout_assert_mutable_entity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  change_entity_type text;
  expected_operation "promotion_operation";
BEGIN
  change_entity_type := CASE TG_TABLE_NAME
    WHEN 'categories' THEN 'category'
    WHEN 'packs' THEN 'pack'
    WHEN 'collectibles' THEN 'collectible'
    WHEN 'collectible_name_aliases' THEN 'collectible_name_alias'
    WHEN 'collectible_instances' THEN 'collectible_instance'
    WHEN 'pack_contents' THEN 'pack_content'
    WHEN 'provider_accounts' THEN 'provider_account'
    ELSE NULL
  END;
  IF change_entity_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'promotion_entity_table_not_contracted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."row_version" <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_entity_initial_version_invalid';
  END IF;
  expected_operation := CASE WHEN NEW."lifecycle" = 'retired' THEN 'retire' ELSE 'upsert' END;
  IF NOT EXISTS (
    SELECT 1
    FROM "promotion_changes" AS change
    WHERE change."entity_type" = change_entity_type
      AND change."entity_id" = NEW.id
      AND change."entity_version" = NEW."row_version"
      AND change."operation" = expected_operation
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'canonical_write_requires_promotion_change';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_assert_fact_entity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  change_entity_type text;
BEGIN
  change_entity_type := CASE TG_TABLE_NAME
    WHEN 'pulls' THEN 'pull'
    WHEN 'pull_items' THEN 'pull_item'
    WHEN 'market_events' THEN 'market_event'
    ELSE NULL
  END;
  IF change_entity_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'promotion_fact_table_not_contracted';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "promotion_changes" AS change
    WHERE change."entity_type" = change_entity_type
      AND change."entity_id" = NEW.id
      AND change."entity_version" = 1
      AND change."operation" = 'upsert'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fact_write_requires_promotion_change';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_assert_promotion_change_entity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_found boolean := false;
  current_version bigint := 1;
  current_lifecycle "entity_lifecycle";
  mutable_entity boolean := true;
BEGIN
  CASE NEW."entity_type"
    WHEN 'category' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "categories" WHERE id = NEW."entity_id";
    WHEN 'pack' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "packs" WHERE id = NEW."entity_id";
    WHEN 'collectible' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "collectibles" WHERE id = NEW."entity_id";
    WHEN 'collectible_name_alias' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "collectible_name_aliases" WHERE id = NEW."entity_id";
    WHEN 'collectible_instance' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "collectible_instances" WHERE id = NEW."entity_id";
    WHEN 'pack_content' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "pack_contents" WHERE id = NEW."entity_id";
    WHEN 'provider_account' THEN
      SELECT true, "row_version", "lifecycle" INTO entity_found, current_version, current_lifecycle FROM "provider_accounts" WHERE id = NEW."entity_id";
    WHEN 'pull' THEN
      mutable_entity := false;
      SELECT true INTO entity_found FROM "pulls" WHERE id = NEW."entity_id";
    WHEN 'pull_item' THEN
      mutable_entity := false;
      SELECT true INTO entity_found FROM "pull_items" WHERE id = NEW."entity_id";
    WHEN 'market_event' THEN
      mutable_entity := false;
      SELECT true INTO entity_found FROM "market_events" WHERE id = NEW."entity_id";
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_change_entity_type_invalid';
  END CASE;

  IF entity_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'promotion_change_entity_missing';
  END IF;
  IF NOT mutable_entity THEN
    IF NEW."entity_version" <> 1 OR NEW."operation" <> 'upsert' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_fact_change_invalid';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."entity_version" > current_version
     OR (NEW."operation" = 'retire' AND (
       current_lifecycle <> 'retired' OR NEW."entity_version" <> current_version
     ))
     OR (NEW."operation" = 'upsert'
         AND current_lifecycle = 'retired'
         AND NEW."entity_version" = current_version)
     OR (NEW."entity_version" > 1 AND NOT EXISTS (
       SELECT 1 FROM "promotion_changes" AS prior
       WHERE prior."entity_type" = NEW."entity_type"
         AND prior."entity_id" = NEW."entity_id"
         AND prior."entity_version" = NEW."entity_version" - 1
     )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promotion_change_entity_version_invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "categories_promotion_change_trigger" AFTER INSERT OR UPDATE ON "categories"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "packs_promotion_change_trigger" AFTER INSERT OR UPDATE ON "packs"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "collectibles_promotion_change_trigger" AFTER INSERT OR UPDATE ON "collectibles"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "collectible_name_aliases_promotion_change_trigger" AFTER INSERT OR UPDATE ON "collectible_name_aliases"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "collectible_instances_promotion_change_trigger" AFTER INSERT OR UPDATE ON "collectible_instances"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "pack_contents_promotion_change_trigger" AFTER INSERT OR UPDATE ON "pack_contents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "provider_accounts_promotion_change_trigger" AFTER INSERT OR UPDATE ON "provider_accounts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_mutable_entity_change"();
CREATE CONSTRAINT TRIGGER "pulls_promotion_change_trigger" AFTER INSERT ON "pulls"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_fact_entity_change"();
CREATE CONSTRAINT TRIGGER "pull_items_promotion_change_trigger" AFTER INSERT ON "pull_items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_fact_entity_change"();
CREATE CONSTRAINT TRIGGER "market_events_promotion_change_trigger" AFTER INSERT ON "market_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_fact_entity_change"();
CREATE CONSTRAINT TRIGGER "promotion_changes_entity_trigger" AFTER INSERT ON "promotion_changes"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "packscout_assert_promotion_change_entity"();

-- Runtime identity and transition history are one local authority.
CREATE FUNCTION "packscout_assert_runtime_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "database_identity" AS identity
    WHERE identity."singleton_key" = true
      AND identity."database_role" = 'provider'
      AND identity."schema_version" = 'distributed-provider-v1'
      AND identity."provider_id" = NEW."central_provider_id"
      AND identity."provider_key" = NEW."provider_key"
      AND current_database() = 'packscout_' || identity."provider_key"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_runtime_identity_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_runtime_identity_trigger"
  AFTER INSERT OR UPDATE OF "central_provider_id", "provider_key" ON "provider_runtime"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_runtime_identity"();

CREATE FUNCTION "packscout_assert_runtime_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."operating_state" IS DISTINCT FROM OLD."operating_state" THEN
    IF NEW."state_generation" <> OLD."state_generation" + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'runtime_generation_mismatch';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "provider_state_events" AS event
      WHERE event."state_generation" = NEW."state_generation"
        AND event."from_state" = OLD."operating_state"
        AND event."to_state" = NEW."operating_state"
        AND event."reason" IS NOT DISTINCT FROM NEW."state_reason"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'runtime_transition_event_missing';
    END IF;
  ELSIF NEW."state_generation" <> OLD."state_generation" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'runtime_generation_without_transition';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_runtime_transition_trigger"
  AFTER UPDATE OF "operating_state", "state_generation", "state_reason" ON "provider_runtime"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_runtime_transition"();

CREATE FUNCTION "packscout_guard_worker_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."worker_role" IS DISTINCT FROM OLD."worker_role" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_worker_state_identity_immutable';
  END IF;
  IF NEW."lease_fence" < OLD."lease_fence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'worker_fence_regression';
  END IF;
  IF NEW."lease_owner" IS DISTINCT FROM OLD."lease_owner"
     AND NEW."lease_owner" IS NOT NULL
     AND NEW."lease_fence" <= OLD."lease_fence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'worker_owner_requires_new_fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_worker_states_guard_trigger"
  BEFORE UPDATE OR DELETE ON "provider_worker_states"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_worker_state"();

-- Runs are one-way state machines; their request identity and terminal outcome
-- never change. Page commits must use the live import fence.
CREATE FUNCTION "packscout_guard_provider_run"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_run_history_immutable';
  END IF;

  IF ROW(
    NEW.id, NEW."control_command_id", NEW."recovery_of_run_id", NEW."idempotency_key",
    NEW."trigger", NEW."requested_by_operator_id", NEW."config_version_id",
    NEW."config_version_number", NEW."worker_fence", NEW."attempt_number",
    NEW."requested_cursor", NEW."requested_cursor_hash", NEW."requested_at", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."control_command_id", OLD."recovery_of_run_id", OLD."idempotency_key",
    OLD."trigger", OLD."requested_by_operator_id", OLD."config_version_id",
    OLD."config_version_number", OLD."worker_fence", OLD."attempt_number",
    OLD."requested_cursor", OLD."requested_cursor_hash", OLD."requested_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_run_request_immutable';
  END IF;

  IF OLD."state" IN ('succeeded', 'incomplete', 'failed')
     AND (to_jsonb(NEW) - 'row_version' - 'updated_at')
           IS DISTINCT FROM
         (to_jsonb(OLD) - 'row_version' - 'updated_at') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_run_terminal_immutable';
  END IF;

  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'queued' AND NEW."state" IN ('running', 'failed'))
    OR (OLD."state" = 'running' AND NEW."state" IN ('succeeded', 'incomplete', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_state_transition_invalid';
  END IF;

  IF NEW."page_count" < OLD."page_count"
     OR NEW."catalog_record_count" < OLD."catalog_record_count"
     OR NEW."pull_record_count" < OLD."pull_record_count"
     OR NEW."market_event_record_count" < OLD."market_event_record_count"
     OR NEW."accepted_count" < OLD."accepted_count"
     OR NEW."duplicate_count" < OLD."duplicate_count"
     OR NEW."quarantined_count" < OLD."quarantined_count"
     OR NEW."material_change_count" < OLD."material_change_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_counter_regression';
  END IF;

  IF NEW."state" NOT IN ('succeeded', 'incomplete', 'failed')
     AND ROW(NEW."final_cursor", NEW."final_cursor_hash", NEW."reached_source_head", NEW."failure_code", NEW."failure_class", NEW."failure_summary", NEW."finished_at")
           IS DISTINCT FROM
         ROW(NULL::jsonb, NULL::character(64), false, NULL::text, NULL::text, NULL::text, NULL::timestamptz) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_terminal_fields_before_terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_runs_guard_trigger" BEFORE UPDATE OR DELETE ON "provider_runs"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_provider_run"();

CREATE FUNCTION "packscout_assert_run_recovery"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_attempt integer;
  prior_state "run_state";
BEGIN
  IF NEW."trigger" <> 'recovery' THEN
    RETURN NULL;
  END IF;
  SELECT "attempt_number", "state" INTO prior_attempt, prior_state
  FROM "provider_runs" WHERE id = NEW."recovery_of_run_id";
  IF prior_state <> 'incomplete' OR NEW."attempt_number" <> prior_attempt + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_recovery_invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_runs_recovery_trigger"
  AFTER INSERT ON "provider_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_run_recovery"();

CREATE FUNCTION "packscout_assert_run_page_fence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_fence bigint;
  run_status "run_state";
  current_fence bigint;
  current_owner text;
  current_expiry timestamptz;
BEGIN
  SELECT "lease_fence", "lease_owner", "lease_expires_at"
    INTO current_fence, current_owner, current_expiry
  FROM "provider_worker_states" WHERE "worker_role" = 'import'
  FOR UPDATE;
  SELECT "worker_fence", "state" INTO run_fence, run_status
  FROM "provider_runs" WHERE id = NEW."provider_run_id"
  FOR UPDATE;

  IF run_status <> 'running'
     OR run_fence <> current_fence
     OR current_owner IS NULL
     OR current_expiry IS NULL
     OR current_expiry <= statement_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'stale_import_worker_fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_run_pages_fence_trigger"
  BEFORE INSERT ON "provider_run_pages"
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_run_page_fence"();

CREATE FUNCTION "packscout_assert_run_page_lineage"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row "provider_runs"%ROWTYPE;
  prior_page "provider_run_pages"%ROWTYPE;
  runtime_cursor_hash character(64);
BEGIN
  SELECT * INTO run_row FROM "provider_runs" WHERE id = NEW."provider_run_id";
  SELECT "source_cursor_hash" INTO runtime_cursor_hash
  FROM "provider_runtime" WHERE "singleton_key" = true;

  IF NEW."page_number" = 1 THEN
    IF NEW."requested_cursor_hash" IS DISTINCT FROM run_row."requested_cursor_hash" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_page_initial_cursor_mismatch';
    END IF;
  ELSE
    SELECT * INTO prior_page
    FROM "provider_run_pages"
    WHERE "provider_run_id" = NEW."provider_run_id"
      AND "page_number" = NEW."page_number" - 1;
    IF NOT FOUND
       OR prior_page."continuation" <> 'more'
       OR NEW."requested_cursor_hash" IS DISTINCT FROM prior_page."next_cursor_hash" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_page_cursor_lineage_mismatch';
    END IF;
  END IF;

  IF runtime_cursor_hash IS DISTINCT FROM NEW."next_cursor_hash" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_runtime_cursor_not_advanced';
  END IF;
  IF NEW."continuation" = 'head' AND NOT run_row."reached_source_head" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_head_not_recorded';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_run_pages_lineage_trigger"
  AFTER INSERT ON "provider_run_pages"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_run_page_lineage"();

CREATE FUNCTION "packscout_assert_run_counters"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_id uuid;
  run_row "provider_runs"%ROWTYPE;
  page_totals record;
BEGIN
  IF TG_TABLE_NAME = 'provider_runs' THEN
    run_id := NEW.id;
  ELSE
    run_id := NEW."provider_run_id";
  END IF;
  SELECT * INTO run_row FROM "provider_runs" WHERE id = run_id;
  SELECT
    count(*)::integer AS page_count,
    COALESCE(sum("catalog_record_count"), 0)::integer AS catalog_count,
    COALESCE(sum("pull_record_count"), 0)::integer AS pull_count,
    COALESCE(sum("market_event_record_count"), 0)::integer AS market_count,
    COALESCE(sum("accepted_count"), 0)::integer AS accepted_count,
    COALESCE(sum("duplicate_count"), 0)::integer AS duplicate_count,
    COALESCE(sum("quarantined_count"), 0)::integer AS quarantined_count,
    COALESCE(sum("material_change_count"), 0)::integer AS material_count
  INTO page_totals
  FROM "provider_run_pages" WHERE "provider_run_id" = run_id;

  IF ROW(
    run_row."page_count", run_row."catalog_record_count", run_row."pull_record_count",
    run_row."market_event_record_count", run_row."accepted_count", run_row."duplicate_count",
    run_row."quarantined_count", run_row."material_change_count"
  ) IS DISTINCT FROM ROW(
    page_totals.page_count, page_totals.catalog_count, page_totals.pull_count,
    page_totals.market_count, page_totals.accepted_count, page_totals.duplicate_count,
    page_totals.quarantined_count, page_totals.material_count
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_run_page_counter_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_runs_counter_trigger"
  AFTER INSERT OR UPDATE ON "provider_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_run_counters"();
CREATE CONSTRAINT TRIGGER "provider_run_pages_counter_trigger"
  AFTER INSERT ON "provider_run_pages"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_run_counters"();

-- Command/result references are deferrable because the command and resulting
-- run are normally created in the same transaction.
CREATE FUNCTION "packscout_assert_command_run_link"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_id uuid;
  resulting_run_id uuid;
  linked_command_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'provider_runs' THEN
    IF NEW."control_command_id" IS NULL THEN
      RETURN NULL;
    END IF;
    command_id := NEW."control_command_id";
    resulting_run_id := NEW.id;
  ELSE
    IF NEW."resulting_run_id" IS NULL THEN
      RETURN NULL;
    END IF;
    command_id := NEW.id;
    resulting_run_id := NEW."resulting_run_id";
  END IF;

  SELECT "control_command_id" INTO linked_command_id
  FROM "provider_runs" WHERE id = resulting_run_id;
  IF linked_command_id IS DISTINCT FROM command_id
     OR NOT EXISTS (
       SELECT 1 FROM "control_commands"
       WHERE id = command_id AND "resulting_run_id" = resulting_run_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'command_resulting_run_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_runs_command_link_trigger"
  AFTER INSERT ON "provider_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_command_run_link"();
CREATE CONSTRAINT TRIGGER "control_commands_run_link_trigger"
  AFTER INSERT OR UPDATE OF "resulting_run_id" ON "control_commands"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_command_run_link"();

CREATE FUNCTION "packscout_guard_control_command"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'control_command_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."idempotency_key", NEW."command_type", NEW."target_run_id",
    NEW."target_quarantine_id", NEW."expected_generation", NEW."requested_by_operator_id",
    NEW."correlation_id", NEW."reason", NEW."requested_at", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."idempotency_key", OLD."command_type", OLD."target_run_id",
    OLD."target_quarantine_id", OLD."expected_generation", OLD."requested_by_operator_id",
    OLD."correlation_id", OLD."reason", OLD."requested_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'control_command_request_immutable';
  END IF;
  IF OLD."state" IN ('rejected', 'completed', 'failed')
     AND (to_jsonb(NEW) - 'row_version' - 'updated_at')
           IS DISTINCT FROM
         (to_jsonb(OLD) - 'row_version' - 'updated_at') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'control_command_terminal_immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'pending' AND NEW."state" IN ('accepted', 'rejected', 'failed'))
    OR (OLD."state" = 'accepted' AND NEW."state" IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'control_command_state_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "control_commands_guard_trigger" BEFORE UPDATE OR DELETE ON "control_commands"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_control_command"();

CREATE FUNCTION "packscout_guard_quarantine_record"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'quarantine_record_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."provider_run_id", NEW."provider_run_page_id", NEW."record_index",
    NEW."record_kind", NEW."entity_key", NEW."source_record_key", NEW."external_id",
    NEW."reason_code", NEW."field_path", NEW."sanitized_summary",
    NEW."candidate_schema_version", NEW."evidence_expires_at", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."provider_run_id", OLD."provider_run_page_id", OLD."record_index",
    OLD."record_kind", OLD."entity_key", OLD."source_record_key", OLD."external_id",
    OLD."reason_code", OLD."field_path", OLD."sanitized_summary",
    OLD."candidate_schema_version", OLD."evidence_expires_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'quarantine_record_origin_immutable';
  END IF;
  IF NEW."retry_count" < OLD."retry_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'quarantine_retry_count_regression';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state"
     AND NOT (OLD."state" = 'open' AND NEW."state" IN ('resolved', 'expired')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'quarantine_state_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "quarantine_records_guard_trigger" BEFORE UPDATE OR DELETE ON "quarantine_records"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_quarantine_record"();

CREATE FUNCTION "packscout_guard_quarantine_attempt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'quarantine_attempt_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."quarantine_record_id", NEW."requested_by_operator_id",
    NEW."correlation_id", NEW."started_at", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."quarantine_record_id", OLD."requested_by_operator_id",
    OLD."correlation_id", OLD."started_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'quarantine_attempt_request_immutable';
  END IF;
  IF OLD."state" <> 'running'
     OR NEW."state" NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'quarantine_attempt_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "quarantine_attempts_guard_trigger"
  BEFORE UPDATE OR DELETE ON "quarantine_attempts"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_quarantine_attempt"();

CREATE FUNCTION "packscout_guard_retention_execution"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retention_execution_history_immutable';
  END IF;
  IF ROW(NEW.id, NEW."policy_key", NEW."cutoff_at", NEW."batch_size", NEW."started_at", NEW."created_at")
       IS DISTINCT FROM
     ROW(OLD.id, OLD."policy_key", OLD."cutoff_at", OLD."batch_size", OLD."started_at", OLD."created_at") THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retention_execution_request_immutable';
  END IF;
  IF OLD."state" <> 'running'
     OR NEW."state" NOT IN ('running', 'succeeded', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retention_execution_transition_invalid';
  END IF;
  IF NEW."selected_count" < OLD."selected_count"
     OR NEW."expired_count" < OLD."expired_count"
     OR NEW."already_expired_count" < OLD."already_expired_count"
     OR NEW."failed_count" < OLD."failed_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retention_execution_counter_regression';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "retention_executions_guard_trigger"
  BEFORE UPDATE OR DELETE ON "retention_executions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_retention_execution"();

CREATE FUNCTION "packscout_guard_activity_outbox"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_activity_outbox_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."event_digest", NEW."event_type", NEW."severity", NEW."dedupe_key",
    NEW."recovery_key", NEW."local_run_id", NEW."local_quarantine_id", NEW."title",
    NEW."summary", NEW."evidence", NEW."event_at", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."event_digest", OLD."event_type", OLD."severity", OLD."dedupe_key",
    OLD."recovery_key", OLD."local_run_id", OLD."local_quarantine_id", OLD."title",
    OLD."summary", OLD."evidence", OLD."event_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_activity_outbox_payload_immutable';
  END IF;
  IF NEW."delivery_attempt_count" < OLD."delivery_attempt_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activity_delivery_attempt_regression';
  END IF;
  IF OLD."delivery_state" = 'delivered'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'activity_delivery_terminal_immutable';
  END IF;
  IF NEW."delivery_state" IS DISTINCT FROM OLD."delivery_state"
     AND NOT (OLD."delivery_state" = 'pending' AND NEW."delivery_state" = 'delivered') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activity_delivery_transition_invalid';
  END IF;
  IF (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    NEW."updated_at" := OLD."updated_at";
  ELSE
    NEW."updated_at" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_activity_outbox_guard_trigger"
  BEFORE UPDATE OR DELETE ON "provider_activity_outbox"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_activity_outbox"();

CREATE FUNCTION "packscout_guard_change_consumer"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."consumer_key" IS DISTINCT FROM OLD."consumer_key" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_change_consumer_identity_immutable';
  END IF;
  IF NEW."last_confirmed_sequence" < OLD."last_confirmed_sequence"
     OR NEW."lease_fence" < OLD."lease_fence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_change_consumer_regression';
  END IF;
  IF NEW."lease_owner" IS DISTINCT FROM OLD."lease_owner"
     AND NEW."lease_owner" IS NOT NULL
     AND NEW."lease_fence" <= OLD."lease_fence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_change_consumer_owner_requires_new_fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_change_consumers_guard_trigger"
  BEFORE UPDATE OR DELETE ON "provider_change_consumers"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_change_consumer"();

-- Receipt identity is shared by release completion, the publication head, and
-- the provider-release consumer checkpoint. A NULL receipt asks whether any
-- exact finalize receipt exists; checkpoint/head callers pass its exact UUID.
CREATE FUNCTION "packscout_has_exact_provider_release_receipt"(
  p_receipt_id uuid,
  p_release_id uuid,
  p_through_change_sequence bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "provider_releases" AS release
    JOIN "provider_publication_operations" AS operation
      ON operation."provider_release_id" = release.id
    JOIN "provider_publication_receipts" AS receipt
      ON receipt."operation_id" = operation.id
     AND receipt."provider_release_id" = release.id
    WHERE release.id = p_release_id
      AND release."through_change_sequence" = p_through_change_sequence
      AND operation."operation_kind" = 'finalize'
      AND operation."batch_index" IS NULL
      AND operation."state" = 'accepted'
      AND receipt."outcome" = 'accepted'
      AND receipt."accepted_content_hash" = release."content_hash"
      AND receipt."accepted_record_count" = (
        SELECT COALESCE(sum(batch."record_count"), 0)::integer
        FROM "provider_release_batches" AS batch
        WHERE batch."provider_release_id" = release.id
      )
      AND (p_receipt_id IS NULL OR receipt.id = p_receipt_id)
  );
$$;

CREATE FUNCTION "packscout_assert_provider_release_confirmation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."consumer_key" <> 'provider_release'
     OR NEW."last_confirmed_sequence" = OLD."last_confirmed_sequence" THEN
    RETURN NULL;
  END IF;
  IF NEW."confirmation_kind" <> 'provider_publication_receipt'
     OR NEW."confirmation_id" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR NOT "packscout_has_exact_provider_release_receipt"(
       NEW."confirmation_id"::uuid,
       (
         SELECT receipt."provider_release_id"
         FROM "provider_publication_receipts" AS receipt
         WHERE receipt.id = NEW."confirmation_id"::uuid
       ),
       NEW."last_confirmed_sequence"
     )
     OR NOT EXISTS (
       SELECT 1
       FROM "provider_publication_receipts" AS receipt
       JOIN "provider_releases" AS release ON release.id = receipt."provider_release_id"
       WHERE receipt.id = NEW."confirmation_id"::uuid
         AND release."lifecycle" = 'complete'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_release_confirmation_missing';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_change_consumers_confirmation_trigger"
  AFTER UPDATE OF "last_confirmed_sequence", "confirmation_kind", "confirmation_id" ON "provider_change_consumers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_provider_release_confirmation"();

CREATE FUNCTION "packscout_assert_release_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "database_identity" AS identity
    WHERE identity."singleton_key" = true
      AND identity."provider_id" = NEW."provider_id"
      AND identity."provider_key" = NEW."provider_key"
      AND NEW."provider_schema_version" = identity."schema_version"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_release_identity_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_releases_identity_trigger"
  AFTER INSERT OR UPDATE OF "provider_id", "provider_key", "provider_schema_version" ON "provider_releases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_release_identity"();

CREATE FUNCTION "packscout_guard_provider_release"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_release_history_immutable';
  END IF;
  IF OLD."lifecycle" <> 'building'
     AND (to_jsonb(NEW) - 'lifecycle' - 'assembled_at' - 'completed_at')
           IS DISTINCT FROM
         (to_jsonb(OLD) - 'lifecycle' - 'assembled_at' - 'completed_at') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_release_descriptor_immutable';
  END IF;
  IF NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle" AND NOT (
    (OLD."lifecycle" = 'building' AND NEW."lifecycle" IN ('assembled', 'blocked', 'failed'))
    OR (OLD."lifecycle" = 'assembled' AND NEW."lifecycle" IN ('publishing', 'blocked', 'failed'))
    OR (OLD."lifecycle" = 'publishing' AND NEW."lifecycle" IN ('complete', 'blocked', 'failed'))
    OR (OLD."lifecycle" = 'blocked' AND NEW."lifecycle" IN ('building', 'publishing', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_release_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_releases_guard_trigger"
  BEFORE UPDATE OR DELETE ON "provider_releases"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_provider_release"();

CREATE FUNCTION "packscout_guard_release_batch"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_id uuid;
  release_state "artifact_lifecycle";
BEGIN
  release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."provider_release_id" ELSE NEW."provider_release_id" END;
  SELECT "lifecycle" INTO release_state FROM "provider_releases" WHERE id = release_id;
  IF release_state <> 'building' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_release_batch_immutable_after_assembly';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_release_batches_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "provider_release_batches"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_release_batch"();

CREATE FUNCTION "packscout_assert_release_batches"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_id uuid;
  expected_count integer;
  actual_count integer;
  provider_batch_count integer;
  provider_record_count bigint;
  category_record_count bigint;
  repack_record_count bigint;
  chase_record_count bigint;
  retired_repack_record_count bigint;
  release_row "provider_releases"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'provider_releases' THEN
    release_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    release_id := OLD."provider_release_id";
  ELSE
    release_id := NEW."provider_release_id";
  END IF;
  SELECT * INTO release_row
  FROM "provider_releases"
  WHERE id = release_id AND "lifecycle" IN ('assembled', 'publishing', 'complete');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  expected_count := release_row."batch_count";
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE "batch_kind" = 'provider')::integer,
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'provider'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'category'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'repack'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'chase'), 0),
    COALESCE(sum("record_count") FILTER (WHERE "batch_kind" = 'retired-repack'), 0)
  INTO
    actual_count, provider_batch_count, provider_record_count,
    category_record_count, repack_record_count, chase_record_count,
    retired_repack_record_count
  FROM "provider_release_batches"
  WHERE "provider_release_id" = release_id;
  IF actual_count <> expected_count
     OR provider_batch_count <> 1
     OR provider_record_count <> 1
     OR category_record_count <> release_row."category_count"
     OR repack_record_count <> release_row."repack_count"
     OR chase_record_count <> release_row."chase_count"
     OR retired_repack_record_count <> release_row."retired_repack_count"
     OR EXISTS (
    SELECT 1
    FROM (
      SELECT "batch_kind", min("batch_index") AS first_index,
             max("batch_index") AS last_index, count(*) AS item_count
      FROM "provider_release_batches"
      WHERE "provider_release_id" = release_id
      GROUP BY "batch_kind"
    ) AS batch_group
    WHERE batch_group.first_index <> 0
       OR batch_group.last_index <> batch_group.item_count - 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_release_batch_set_incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_releases_batch_count_trigger"
  AFTER INSERT OR UPDATE ON "provider_releases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_release_batches"();
CREATE CONSTRAINT TRIGGER "provider_release_batches_count_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "provider_release_batches"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_release_batches"();

-- A complete release must be backed by the exact accepted finalize receipt.
-- The accepted count reconciles to the immutable transmitted batch records;
-- provider/catalog reference validation remains the assembler's responsibility.
CREATE FUNCTION "packscout_assert_provider_release_completion"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."lifecycle" <> 'complete' THEN
    RETURN NULL;
  END IF;
  IF NOT "packscout_has_exact_provider_release_receipt"(
    NULL, NEW.id, NEW."through_change_sequence"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_release_completion_receipt_missing';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_releases_completion_receipt_trigger"
  AFTER INSERT OR UPDATE OF "lifecycle" ON "provider_releases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_provider_release_completion"();

CREATE FUNCTION "packscout_guard_publication_operation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  promotion_fence bigint;
  promotion_owner text;
  promotion_expiry timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_operation_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."provider_release_id", NEW."operation_kind", NEW."batch_index",
    NEW."idempotency_key", NEW."request_digest", NEW."request_bytes", NEW."body_hash",
    NEW."lease_fence", NEW."requested_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."provider_release_id", OLD."operation_kind", OLD."batch_index",
    OLD."idempotency_key", OLD."request_digest", OLD."request_bytes", OLD."body_hash",
    OLD."lease_fence", OLD."requested_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_operation_request_immutable';
  END IF;
  IF NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_publication_attempt_regression';
  END IF;
  IF OLD."state" IN ('accepted', 'failed')
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_operation_terminal_immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'pending' AND NEW."state" IN ('accepted', 'ambiguous', 'failed'))
    OR (OLD."state" = 'ambiguous' AND NEW."state" IN ('accepted', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_publication_operation_transition_invalid';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NEW."state" IN ('accepted', 'failed') THEN
    SELECT "lease_fence", "lease_owner", "lease_expires_at"
      INTO promotion_fence, promotion_owner, promotion_expiry
    FROM "provider_worker_states" WHERE "worker_role" = 'promotion'
    FOR UPDATE;
    IF NEW."lease_fence" <> promotion_fence
       OR promotion_owner IS NULL
       OR promotion_expiry IS NULL
       OR promotion_expiry <= statement_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'stale_promotion_worker_fence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_publication_operations_guard_trigger"
  BEFORE UPDATE OR DELETE ON "provider_publication_operations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_publication_operation"();

CREATE FUNCTION "packscout_assert_publication_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_hash character(64);
  operation_state "publication_operation_state";
  operation_kind text;
BEGIN
  SELECT
    CASE
      WHEN operation."operation_kind" = 'finalize' THEN release."content_hash"
      ELSE COALESCE(operation."body_hash", release."content_hash")
    END,
    operation."state",
    operation."operation_kind"
    INTO expected_hash, operation_state, operation_kind
  FROM "provider_publication_operations" AS operation
  JOIN "provider_releases" AS release ON release.id = operation."provider_release_id"
  WHERE operation.id = NEW."operation_id"
    AND operation."provider_release_id" = NEW."provider_release_id";

  IF NEW."outcome" = 'accepted'
     AND (NEW."accepted_content_hash" IS DISTINCT FROM expected_hash OR operation_state <> 'accepted') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication_receipt_request_mismatch';
  END IF;
  IF NEW."outcome" = 'accepted'
     AND operation_kind = 'finalize'
     AND NEW."accepted_record_count" IS DISTINCT FROM (
       SELECT COALESCE(sum(batch."record_count"), 0)::integer
       FROM "provider_release_batches" AS batch
       WHERE batch."provider_release_id" = NEW."provider_release_id"
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication_receipt_count_mismatch';
  END IF;
  IF NEW."outcome" = 'rejected' AND operation_state <> 'failed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication_rejection_operation_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_publication_receipts_match_trigger"
  AFTER INSERT ON "provider_publication_receipts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_publication_receipt"();

CREATE FUNCTION "packscout_guard_publication_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."singleton_key" IS DISTINCT FROM OLD."singleton_key" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_state_identity_immutable';
  END IF;
  IF NEW."completed_through_change_sequence" < OLD."completed_through_change_sequence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_publication_checkpoint_regression';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_publication_state_guard_trigger"
  BEFORE UPDATE OR DELETE ON "provider_publication_state"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_publication_state"();

CREATE FUNCTION "packscout_assert_publication_completion"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."completed_release_id" IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT "packscout_has_exact_provider_release_receipt"(
    NEW."completion_receipt_id",
    NEW."completed_release_id",
    NEW."completed_through_change_sequence"
  ) OR NOT EXISTS (
    SELECT 1 FROM "provider_releases" AS release
    WHERE release.id = NEW."completed_release_id"
      AND release."lifecycle" = 'complete'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_publication_completion_receipt_missing';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_publication_state_completion_trigger"
  AFTER INSERT OR UPDATE OF "completed_release_id", "completed_through_change_sequence", "completion_receipt_id" ON "provider_publication_state"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_assert_publication_completion"();

-- Provider-invariant singleton rows can be seeded by the reusable template.
INSERT INTO "promotion_ledger" ("singleton_key", "last_sequence") VALUES (true, 0);
INSERT INTO "provider_worker_states" ("worker_role") VALUES ('import'), ('promotion');
INSERT INTO "provider_change_consumers" ("consumer_key") VALUES ('catalog_correlation'), ('provider_release');
INSERT INTO "provider_publication_state" ("singleton_key") VALUES (true);

-- Explicit post-migration initialization. It is safe to replay with the exact
-- same identity, but a UUID/key/database mismatch is permanently rejected.
CREATE FUNCTION public.initialize_provider_database_identity(
  p_provider_id uuid,
  p_provider_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_identity public."database_identity"%ROWTYPE;
  expected_database_name text;
BEGIN
  IF p_provider_id IS NULL
     OR p_provider_key IS NULL
     OR p_provider_key !~ '^[a-z][a-z0-9_]{0,52}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_database_identity_invalid';
  END IF;

  expected_database_name := 'packscout_' || p_provider_key;
  IF current_database() <> expected_database_name THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_database_name_mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_database(), 0)
  );

  SELECT * INTO existing_identity
  FROM public."database_identity"
  WHERE "singleton_key" = true;

  IF FOUND THEN
    IF existing_identity."database_role" <> 'provider'
       OR existing_identity."schema_version" <> 'distributed-provider-v1'
       OR existing_identity."provider_id" <> p_provider_id
       OR existing_identity."provider_key" <> p_provider_key
       OR NOT EXISTS (
         SELECT 1 FROM public."provider_runtime" AS runtime
         WHERE runtime."singleton_key" = true
           AND runtime."central_provider_id" = p_provider_id
           AND runtime."provider_key" = p_provider_key
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_database_identity_already_initialized';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public."database_identity" (
    "singleton_key", "database_role", "schema_version", "provider_id", "provider_key"
  ) VALUES (
    true, 'provider', 'distributed-provider-v1', p_provider_id, p_provider_key
  );

  INSERT INTO public."provider_runtime" (
    "singleton_key", "central_provider_id", "provider_key", "operating_state",
    "freshness_state", "quality_state"
  ) VALUES (
    true, p_provider_id, p_provider_key, 'idle', 'unknown', 'unknown'
  );
END;
$$;

-- PostgreSQL grants function execution to PUBLIC by default. Provisioning is
-- intentionally restricted to the database owner (which retains ownership
-- privileges) so an application role cannot bind or replace provider identity.
REVOKE EXECUTE ON FUNCTION public.initialize_provider_database_identity(uuid, text) FROM PUBLIC;
