-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Required for gen_random_uuid() defaults.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "operator_state" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "operator_role" AS ENUM ('admin', 'data_operator');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('success', 'failure', 'blocked');

-- CreateEnum
CREATE TYPE "provider_lifecycle" AS ENUM ('draft', 'active', 'disabled', 'archived');

-- CreateEnum
CREATE TYPE "credential_lifecycle" AS ENUM ('active', 'retired', 'revoked');

-- CreateEnum
CREATE TYPE "credential_kind" AS ENUM ('source', 'database');

-- CreateEnum
CREATE TYPE "connection_test_kind" AS ENUM ('source', 'database', 'activation');

-- CreateEnum
CREATE TYPE "connection_test_outcome" AS ENUM ('succeeded', 'failed');

-- CreateEnum
CREATE TYPE "alert_state" AS ENUM ('active', 'acknowledged', 'resolved');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "catalog_identity_state" AS ENUM ('provisional', 'canonical', 'retired');

-- CreateEnum
CREATE TYPE "category_kind" AS ENUM ('vertical', 'sport', 'league', 'franchise', 'brand', 'set', 'other');

-- CreateEnum
CREATE TYPE "correlation_method" AS ENUM ('deterministic', 'manual', 'provisional');

-- CreateEnum
CREATE TYPE "suggestion_state" AS ENUM ('pending', 'accepted', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "entity_lifecycle" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "collectible_type" AS ENUM ('card', 'watch', 'art', 'coin', 'sealed_product', 'memorabilia', 'other');

-- CreateEnum
CREATE TYPE "promotion_operation" AS ENUM ('upsert', 'retire');

-- CreateEnum
CREATE TYPE "activity_origin" AS ENUM ('provider', 'central');

-- CreateEnum
CREATE TYPE "artifact_lifecycle" AS ENUM ('building', 'assembled', 'publishing', 'complete', 'blocked', 'failed');

-- CreateEnum
CREATE TYPE "publication_operation_state" AS ENUM ('pending', 'accepted', 'ambiguous', 'failed');

-- CreateEnum
CREATE TYPE "manifest_operation" AS ENUM ('advance', 'add', 'remove', 'rollback');

-- CreateEnum
CREATE TYPE "retention_state" AS ENUM ('running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "database_identity" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "database_role" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "provider_id" UUID,
    "provider_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_identity_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_normalized" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "state" "operator_state" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "role" "operator_role" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_hash" TEXT NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_rate_limits" (
    "bucket_key" TEXT NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "blocked_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_rate_limits_pkey" PRIMARY KEY ("bucket_key")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "actor_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID,
    "outcome" "audit_outcome" NOT NULL,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_key" VARCHAR(53) NOT NULL,
    "display_name" TEXT NOT NULL,
    "lifecycle" "provider_lifecycle" NOT NULL DEFAULT 'draft',
    "active_config_version_id" UUID,
    "active_public_profile_version_id" UUID,
    "topology_version" BIGINT NOT NULL DEFAULT 1,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_public_profile_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "version_number" BIGINT NOT NULL,
    "display_name" TEXT NOT NULL,
    "logo_url" TEXT,
    "website_url" TEXT,
    "listing_hosts" TEXT[],
    "image_origins" TEXT[],
    "referral_parameters" JSONB NOT NULL DEFAULT '[]',
    "promo_code" TEXT,
    "promo_label" TEXT,
    "content_hash" CHAR(64) NOT NULL,
    "created_by_operator_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_public_profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_config_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "version_number" BIGINT NOT NULL,
    "adapter_key" TEXT NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "source_credential_version_id" UUID,
    "schedule_seconds" INTEGER NOT NULL,
    "stale_after_seconds" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(6),
    "created_by_operator_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credential_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "credential_kind" "credential_kind" NOT NULL,
    "version_number" BIGINT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "lifecycle" "credential_lifecycle" NOT NULL DEFAULT 'active',
    "activated_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credential_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_database_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "node_key" TEXT NOT NULL,
    "node_role" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database_name" TEXT NOT NULL,
    "ssl_mode" TEXT NOT NULL,
    "credential_version_id" UUID NOT NULL,
    "region" TEXT,
    "enabled" BOOLEAN NOT NULL,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_database_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_connection_tests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "config_version_id" UUID NOT NULL,
    "source_credential_version_id" UUID,
    "database_credential_version_id" UUID,
    "topology_version" BIGINT NOT NULL,
    "database_node_id" UUID,
    "database_node_row_version" BIGINT,
    "target_digest" CHAR(64) NOT NULL,
    "test_kind" "connection_test_kind" NOT NULL,
    "outcome" "connection_test_outcome" NOT NULL,
    "latency_ms" INTEGER,
    "response_status" INTEGER,
    "sanitized_code" TEXT,
    "result_summary" JSONB NOT NULL DEFAULT '{}',
    "record_counts" JSONB,
    "has_more" BOOLEAN,
    "next_cursor_present" BOOLEAN,
    "tested_by_operator_id" UUID NOT NULL,
    "tested_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_connection_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "origin" "activity_origin" NOT NULL,
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
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health" (
    "provider_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "last_activity_event_id" UUID,
    "last_activity_at" TIMESTAMPTZ(6),
    "observed_state" TEXT NOT NULL,
    "freshness_state" TEXT NOT NULL,
    "quality_state" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "open_quarantine_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempted_at" TIMESTAMPTZ(6),
    "last_head_reached_at" TIMESTAMPTZ(6),
    "recovered_at" TIMESTAMPTZ(6),
    "last_direct_probe_at" TIMESTAMPTZ(6),
    "last_runner_heartbeat_at" TIMESTAMPTZ(6),
    "latest_failure_code" TEXT,
    "recovery_hint" TEXT,
    "latest_mapping_warning_at" TIMESTAMPTZ(6),
    "mapping_warning_severity" TEXT,
    "mapping_warning_active" BOOLEAN NOT NULL DEFAULT false,
    "latest_calculation_warning_at" TIMESTAMPTZ(6),
    "calculation_warning_severity" TEXT,
    "calculation_warning_active" BOOLEAN NOT NULL DEFAULT false,
    "publication_lag" BIGINT NOT NULL DEFAULT 0,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_health_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "admin_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "latest_activity_event_id" UUID,
    "kind" TEXT NOT NULL,
    "severity" "severity" NOT NULL,
    "state" "alert_state" NOT NULL DEFAULT 'active',
    "dedupe_key" TEXT NOT NULL,
    "recovery_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "provider_id" UUID,
    "run_id" UUID,
    "quarantine_id" UUID,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "reopened_count" INTEGER NOT NULL DEFAULT 0,
    "acknowledged_by_actor_key" TEXT,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_by_actor_key" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "admin_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_category_id" UUID,
    "category_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "category_kind" "category_kind" NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_collectibles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "primary_category_id" UUID,
    "collectible_type" "collectible_type" NOT NULL,
    "identity_state" "catalog_identity_state" NOT NULL,
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
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_collectibles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_collectible_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "global_collectible_id" UUID NOT NULL,
    "global_category_id" UUID NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_collectible_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_collectible_name_aliases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "global_collectible_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "lifecycle" "entity_lifecycle" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_collectible_name_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_category_correlations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "local_category_id" UUID NOT NULL,
    "local_entity_version" BIGINT NOT NULL,
    "global_category_id" UUID NOT NULL,
    "correlation_version" BIGINT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "method" "correlation_method" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "valid_from_event_sequence" BIGINT NOT NULL,
    "valid_to_event_sequence" BIGINT,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_category_correlations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_collectible_correlations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "local_collectible_id" UUID NOT NULL,
    "local_entity_version" BIGINT NOT NULL,
    "global_collectible_id" UUID NOT NULL,
    "correlation_version" BIGINT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "method" "correlation_method" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "valid_from_event_sequence" BIGINT NOT NULL,
    "valid_to_event_sequence" BIGINT,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_collectible_correlations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correlation_suggestions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "local_collectible_id" UUID NOT NULL,
    "local_entity_version" BIGINT NOT NULL,
    "provisional_collectible_id" UUID NOT NULL,
    "candidate_collectible_id" UUID NOT NULL,
    "rule_version" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "review_state" "suggestion_state" NOT NULL DEFAULT 'pending',
    "decision_event_sequence" BIGINT NOT NULL,
    "rationale" JSONB NOT NULL DEFAULT '{}',
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correlation_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_ledger" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_ledger_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "collectible_aliases" (
    "alias_collectible_id" UUID NOT NULL,
    "canonical_collectible_id" UUID NOT NULL,
    "decision_event_sequence" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collectible_aliases_pkey" PRIMARY KEY ("alias_collectible_id")
);

-- CreateTable
CREATE TABLE "catalog_decision_events" (
    "sequence" BIGINT NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_decision_events_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "catalog_promotion_changes" (
    "sequence" BIGINT NOT NULL,
    "decision_event_sequence" BIGINT NOT NULL,
    "provider_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_version" BIGINT NOT NULL,
    "operation" "promotion_operation" NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_promotion_changes_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "provider_release_invalidation_ledger" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_release_invalidation_ledger_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "provider_release_invalidations" (
    "sequence" BIGINT NOT NULL,
    "provider_id" UUID NOT NULL,
    "catalog_change_sequence" BIGINT,
    "public_profile_version_id" UUID,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_release_invalidations_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "provider_invalidation_checkpoints" (
    "provider_id" UUID NOT NULL,
    "last_confirmed_invalidation_sequence" BIGINT NOT NULL DEFAULT 0,
    "confirmed_provider_release_id" UUID,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_invalidation_checkpoints_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "catalog_consumer_checkpoints" (
    "consumer_key" TEXT NOT NULL,
    "last_confirmed_sequence" BIGINT NOT NULL DEFAULT 0,
    "confirmation_id" TEXT,
    "lease_owner" TEXT,
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(6),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_consumer_checkpoints_pkey" PRIMARY KEY ("consumer_key")
);

-- CreateTable
CREATE TABLE "catalog_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "predecessor_id" UUID,
    "through_change_sequence" BIGINT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "lifecycle" "artifact_lifecycle" NOT NULL DEFAULT 'building',
    "category_count" INTEGER NOT NULL,
    "collectible_count" INTEGER NOT NULL,
    "alias_count" INTEGER NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assembled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "catalog_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_version_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_version_id" UUID NOT NULL,
    "batch_kind" TEXT NOT NULL,
    "batch_index" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "record_count" INTEGER NOT NULL,
    "byte_count" INTEGER NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_version_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_publication_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_version_id" UUID NOT NULL,
    "operation_kind" TEXT NOT NULL,
    "batch_index" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "request_bytes" BYTEA NOT NULL,
    "body_hash" CHAR(64),
    "lease_fence" BIGINT NOT NULL,
    "state" "publication_operation_state" NOT NULL DEFAULT 'pending',
    "convex_receipt_id" TEXT,
    "receipt_hash" CHAR(64),
    "receipt" JSONB,
    "failure_code" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "catalog_publication_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifest_activation_state" (
    "singleton_key" BOOLEAN NOT NULL DEFAULT true,
    "active_manifest_id" TEXT,
    "active_manifest_fingerprint" CHAR(64),
    "previous_manifest_id" TEXT,
    "previous_manifest_fingerprint" CHAR(64),
    "lease_owner" TEXT,
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_receipt_id" TEXT,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manifest_activation_state_pkey" PRIMARY KEY ("singleton_key")
);

-- CreateTable
CREATE TABLE "manifest_activation_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "operation" "manifest_operation" NOT NULL,
    "expected_manifest_id" TEXT,
    "target_provider_release_id" UUID,
    "target_catalog_version_id" UUID,
    "new_manifest_fingerprint" CHAR(64) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "lease_fence" BIGINT NOT NULL,
    "state" "publication_operation_state" NOT NULL DEFAULT 'pending',
    "convex_receipt_id" TEXT,
    "receipt_hash" CHAR(64),
    "receipt" JSONB,
    "requested_by_operator_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "manifest_activation_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_retention_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state" "retention_state" NOT NULL DEFAULT 'running',
    "cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "batch_size" INTEGER NOT NULL,
    "selected_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_count" INTEGER NOT NULL DEFAULT 0,
    "protected_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_retention_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "operators_email_normalized_unique" ON "operators"("email_normalized");

-- CreateIndex
CREATE INDEX "operator_memberships_operator_idx" ON "operator_memberships"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_memberships_organization_operator_unique" ON "operator_memberships"("organization_id", "operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_sessions_token_hash_unique" ON "operator_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "operator_sessions_operator_idx" ON "operator_sessions"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_organization_occurred_idx" ON "audit_events"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "providers_provider_key_unique" ON "providers"("provider_key");

-- CreateIndex
CREATE UNIQUE INDEX "providers_id_organization_unique" ON "providers"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_public_profile_versions_provider_version_unique" ON "provider_public_profile_versions"("provider_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "provider_public_profile_versions_id_provider_unique" ON "provider_public_profile_versions"("id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_config_versions_provider_version_unique" ON "provider_config_versions"("provider_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "provider_config_versions_id_provider_unique" ON "provider_config_versions"("id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credential_versions_provider_kind_version_unique" ON "provider_credential_versions"("provider_id", "credential_kind", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credential_versions_id_provider_unique" ON "provider_credential_versions"("id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_database_nodes_provider_node_unique" ON "provider_database_nodes"("provider_id", "node_key");

-- CreateIndex
CREATE UNIQUE INDEX "provider_database_nodes_id_provider_unique" ON "provider_database_nodes"("id", "provider_id");

-- CreateIndex
CREATE INDEX "provider_connection_tests_provider_config_idx" ON "provider_connection_tests"("provider_id", "config_version_id");

-- CreateIndex
CREATE INDEX "provider_connection_tests_provider_kind_tested_idx" ON "provider_connection_tests"("provider_id", "test_kind", "tested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "provider_activity_events_provider_id_unique" ON "provider_activity_events"("provider_id", "id");

-- CreateIndex
CREATE INDEX "admin_alerts_organization_state_seen_idx" ON "admin_alerts"("organization_id", "state", "last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "admin_alerts_organization_dedupe_unique" ON "admin_alerts"("organization_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "global_categories_category_key_unique" ON "global_categories"("category_key");

-- CreateIndex
CREATE INDEX "global_categories_parent_lifecycle_order_idx" ON "global_categories"("parent_category_id", "lifecycle", "display_order");

-- CreateIndex
CREATE INDEX "global_collectibles_type_name_idx" ON "global_collectibles"("collectible_type", "normalized_name");

-- CreateIndex
CREATE INDEX "global_collectibles_identity_state_idx" ON "global_collectibles"("identity_state");

-- CreateIndex
CREATE UNIQUE INDEX "provider_category_correlations_version_unique" ON "provider_category_correlations"("provider_id", "local_category_id", "correlation_version");

-- CreateIndex
CREATE UNIQUE INDEX "provider_collectible_correlations_version_unique" ON "provider_collectible_correlations"("provider_id", "local_collectible_id", "correlation_version");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_promotion_changes_entity_version_operation_unique" ON "catalog_promotion_changes"("entity_type", "entity_id", "entity_version", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_version_batches_version_kind_index_unique" ON "catalog_version_batches"("catalog_version_id", "batch_kind", "batch_index");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_publication_operations_idempotency_unique" ON "catalog_publication_operations"("idempotency_key");

-- One accepted remote receipt can prove exactly one local catalog operation.
CREATE UNIQUE INDEX "catalog_publication_operations_receipt_unique"
  ON "catalog_publication_operations"("convex_receipt_id")
  WHERE "convex_receipt_id" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "manifest_activation_operations_idempotency_unique" ON "manifest_activation_operations"("idempotency_key");

-- One accepted remote receipt can prove exactly one local manifest operation.
CREATE UNIQUE INDEX "manifest_activation_operations_receipt_unique"
  ON "manifest_activation_operations"("convex_receipt_id")
  WHERE "convex_receipt_id" IS NOT NULL;

-- Native helpers used by checks that Prisma cannot express.
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

CREATE FUNCTION "packscout_profile_hosts_valid"("values" text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT cardinality("values") <= 16
     AND "packscout_text_array_is_sorted_unique"("values")
     AND NOT EXISTS (
       SELECT 1
       FROM unnest("values") AS host
       WHERE length(host) NOT BETWEEN 1 AND 253
          OR host <> lower(host)
          OR host ~ '[/@?#]'
          OR host !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$'
     );
$$;

CREATE FUNCTION "packscout_profile_origins_valid"("values" text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT cardinality("values") <= 16
     AND "packscout_text_array_is_sorted_unique"("values")
     AND NOT EXISTS (
       SELECT 1
       FROM unnest("values") AS origin
       WHERE length(origin) > 2048
          OR origin !~ '^https://[^/@?#]+$'
     );
$$;

CREATE FUNCTION "packscout_profile_referrals_valid"("value" jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof("value") = 'array'
     AND jsonb_array_length("value") <= 8
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements("value") WITH ORDINALITY AS item(value, ordinal)
       LEFT JOIN jsonb_array_elements("value") WITH ORDINALITY AS prior(value, ordinal)
         ON prior.ordinal = item.ordinal - 1
       WHERE jsonb_typeof(item.value) <> 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(item.value)) <> 2
          OR NOT (item.value ? 'name' AND item.value ? 'value')
          OR jsonb_typeof(item.value -> 'name') <> 'string'
          OR jsonb_typeof(item.value -> 'value') <> 'string'
          OR (item.value ->> 'name') !~ '^[A-Za-z0-9._~-]{1,64}$'
          OR length(btrim(item.value ->> 'value')) NOT BETWEEN 1 AND 256
          OR (item.ordinal > 1 AND prior.value ->> 'name' >= item.value ->> 'name')
     );
$$;

CREATE FUNCTION "packscout_logo_origin_allowed"("url" text, "origins" text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT length("url") <= 2048
     AND "url" ~ '^https://[^/@?#]+'
     AND EXISTS (
       SELECT 1
       FROM unnest("origins") AS origin
       WHERE "url" = origin
          OR "url" LIKE origin || '/%'
          OR "url" LIKE origin || '?%'
          OR "url" LIKE origin || '#%'
     );
$$;

-- Partial uniqueness and query indexes from the physical contract.
CREATE UNIQUE INDEX "provider_database_nodes_one_enabled_primary_per_provider_unique"
  ON "provider_database_nodes"("provider_id")
  WHERE "enabled" AND "node_role" = 'primary';

CREATE UNIQUE INDEX "global_collectible_categories_active_pair_unique"
  ON "global_collectible_categories"("global_collectible_id", "global_category_id")
  WHERE "lifecycle" = 'active';

CREATE UNIQUE INDEX "global_collectible_name_aliases_active_name_unique"
  ON "global_collectible_name_aliases"("global_collectible_id", "normalized_name")
  WHERE "lifecycle" = 'active';

CREATE UNIQUE INDEX "provider_category_correlations_active_local_unique"
  ON "provider_category_correlations"("provider_id", "local_category_id")
  WHERE "valid_to_event_sequence" IS NULL;

CREATE UNIQUE INDEX "provider_collectible_correlations_active_local_unique"
  ON "provider_collectible_correlations"("provider_id", "local_collectible_id")
  WHERE "valid_to_event_sequence" IS NULL;

CREATE UNIQUE INDEX "correlation_suggestions_pending_candidate_rule_unique"
  ON "correlation_suggestions"("provider_id", "local_collectible_id", "candidate_collectible_id", "rule_version")
  WHERE "review_state" = 'pending';

CREATE UNIQUE INDEX "catalog_decision_events_correlation_request_unique"
  ON "catalog_decision_events"("actor_type", "actor_id")
  WHERE "actor_type" IN (
    'provider_correlation_request',
    'provider_correlation_conflict',
    'provider_category_correlation_request',
    'provider_category_correlation_conflict'
  );

CREATE UNIQUE INDEX "provider_release_invalidations_catalog_cause_unique"
  ON "provider_release_invalidations"("provider_id", "catalog_change_sequence")
  WHERE "catalog_change_sequence" IS NOT NULL;

CREATE UNIQUE INDEX "provider_release_invalidations_profile_cause_unique"
  ON "provider_release_invalidations"("provider_id", "public_profile_version_id")
  WHERE "public_profile_version_id" IS NOT NULL;

CREATE UNIQUE INDEX "catalog_versions_complete_content_unique"
  ON "catalog_versions"("schema_version", "content_hash")
  WHERE "lifecycle" = 'complete';

-- Scalar and shape constraints.
ALTER TABLE "database_identity"
  ADD CONSTRAINT "database_identity_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "database_identity_central_role_check" CHECK (
    "database_role" = 'central'
    AND "provider_id" IS NULL
    AND "provider_key" IS NULL
  ),
  ADD CONSTRAINT "database_identity_schema_version_nonblank_check" CHECK (btrim("schema_version") <> '');

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_slug_nonblank_check" CHECK (btrim("slug") <> ''),
  ADD CONSTRAINT "organizations_name_nonblank_check" CHECK (btrim("name") <> '');

ALTER TABLE "operators"
  ADD CONSTRAINT "operators_email_normalized_check" CHECK (
    "email_normalized" = lower(btrim("email_normalized")) AND "email_normalized" <> ''
  ),
  ADD CONSTRAINT "operators_display_name_nonblank_check" CHECK (btrim("display_name") <> '');

ALTER TABLE "operator_sessions"
  ADD CONSTRAINT "operator_sessions_expiry_order_check" CHECK (
    "created_at" <= "idle_expires_at" AND "idle_expires_at" <= "absolute_expires_at"
  );

ALTER TABLE "auth_rate_limits"
  ADD CONSTRAINT "auth_rate_limits_attempt_count_check" CHECK ("attempt_count" >= 0);

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_copy_nonblank_check" CHECK (
    btrim("actor_key") <> '' AND btrim("action") <> '' AND btrim("subject_type") <> ''
  ),
  ADD CONSTRAINT "audit_events_metadata_object_check" CHECK (jsonb_typeof("metadata_json") = 'object');

ALTER TABLE "providers"
  ADD CONSTRAINT "providers_provider_key_check" CHECK ("provider_key" ~ '^[a-z][a-z0-9_]{0,52}$'),
  ADD CONSTRAINT "providers_display_name_nonblank_check" CHECK (btrim("display_name") <> ''),
  ADD CONSTRAINT "providers_positive_versions_check" CHECK ("topology_version" > 0 AND "row_version" > 0);

ALTER TABLE "provider_public_profile_versions"
  ADD CONSTRAINT "provider_public_profile_versions_positive_version_check" CHECK ("version_number" > 0),
  ADD CONSTRAINT "provider_public_profile_versions_display_name_check" CHECK (
    length(btrim("display_name")) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT "provider_public_profile_versions_website_url_check" CHECK (
    "website_url" IS NULL
    OR (length("website_url") <= 2048 AND "website_url" ~ '^https://[^/@?#]+')
  ),
  ADD CONSTRAINT "provider_public_profile_versions_listing_hosts_check" CHECK (
    "packscout_profile_hosts_valid"("listing_hosts")
  ),
  ADD CONSTRAINT "provider_public_profile_versions_image_origins_check" CHECK (
    "packscout_profile_origins_valid"("image_origins")
  ),
  ADD CONSTRAINT "provider_public_profile_versions_referrals_check" CHECK (
    "packscout_profile_referrals_valid"("referral_parameters")
  ),
  ADD CONSTRAINT "provider_public_profile_versions_promo_pair_check" CHECK (
    ("promo_code" IS NULL) = ("promo_label" IS NULL)
    AND ("promo_code" IS NULL OR "promo_code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    AND ("promo_label" IS NULL OR length(btrim("promo_label")) BETWEEN 1 AND 100)
  ),
  ADD CONSTRAINT "provider_public_profile_versions_logo_check" CHECK (
    "logo_url" IS NULL OR "packscout_logo_origin_allowed"("logo_url", "image_origins")
  ),
  ADD CONSTRAINT "provider_public_profile_versions_content_hash_check" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "provider_config_versions"
  ADD CONSTRAINT "provider_config_versions_positive_version_check" CHECK ("version_number" > 0),
  ADD CONSTRAINT "provider_config_versions_adapter_key_nonblank_check" CHECK (btrim("adapter_key") <> ''),
  ADD CONSTRAINT "provider_config_versions_endpoint_url_check" CHECK (
    length("endpoint_url") <= 2048 AND "endpoint_url" ~ '^https://[^/@?#]+'
  ),
  ADD CONSTRAINT "provider_config_versions_schedule_check" CHECK ("schedule_seconds" >= 60),
  ADD CONSTRAINT "provider_config_versions_stale_check" CHECK ("stale_after_seconds" > 0),
  ADD CONSTRAINT "provider_config_versions_configuration_object_check" CHECK (
    jsonb_typeof("configuration") = 'object'
  );

ALTER TABLE "provider_credential_versions"
  ADD CONSTRAINT "provider_credential_versions_positive_values_check" CHECK (
    "version_number" > 0 AND "key_version" > 0
    AND octet_length("ciphertext") > 0
    AND octet_length("nonce") > 0
    AND octet_length("auth_tag") > 0
  ),
  ADD CONSTRAINT "provider_credential_versions_lifecycle_time_check" CHECK (
    ("lifecycle" = 'active' AND "retired_at" IS NULL AND "revoked_at" IS NULL)
    OR ("lifecycle" = 'retired' AND "retired_at" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("lifecycle" = 'revoked' AND "revoked_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_credential_versions_time_order_check" CHECK (
    ("activated_at" IS NULL OR "retired_at" IS NULL OR "activated_at" <= "retired_at")
    AND ("activated_at" IS NULL OR "revoked_at" IS NULL OR "activated_at" <= "revoked_at")
    AND ("retired_at" IS NULL OR "revoked_at" IS NULL OR "retired_at" <= "revoked_at")
  );

ALTER TABLE "provider_database_nodes"
  ADD CONSTRAINT "provider_database_nodes_node_key_nonblank_check" CHECK (btrim("node_key") <> ''),
  ADD CONSTRAINT "provider_database_nodes_node_role_check" CHECK ("node_role" IN ('primary', 'replica')),
  ADD CONSTRAINT "provider_database_nodes_host_nonblank_check" CHECK (btrim("host") <> ''),
  ADD CONSTRAINT "provider_database_nodes_port_check" CHECK ("port" BETWEEN 1 AND 65535),
  ADD CONSTRAINT "provider_database_nodes_database_name_nonblank_check" CHECK (btrim("database_name") <> ''),
  ADD CONSTRAINT "provider_database_nodes_ssl_mode_check" CHECK (
    "ssl_mode" IN ('disable', 'prefer', 'require', 'verify-ca', 'verify-full')
  ),
  ADD CONSTRAINT "provider_database_nodes_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_connection_tests"
  ADD CONSTRAINT "provider_connection_tests_positive_versions_check" CHECK (
    "topology_version" > 0 AND ("database_node_row_version" IS NULL OR "database_node_row_version" > 0)
  ),
  ADD CONSTRAINT "provider_connection_tests_node_pair_check" CHECK (
    ("database_node_id" IS NULL) = ("database_node_row_version" IS NULL)
  ),
  ADD CONSTRAINT "provider_connection_tests_database_target_check" CHECK (
    "test_kind" = 'source'
    OR ("database_credential_version_id" IS NOT NULL AND "database_node_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_connection_tests_target_digest_check" CHECK (
    "target_digest" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "provider_connection_tests_numeric_bounds_check" CHECK (
    ("latency_ms" IS NULL OR "latency_ms" >= 0)
    AND ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599)
  ),
  ADD CONSTRAINT "provider_connection_tests_summary_object_check" CHECK (
    jsonb_typeof("result_summary") = 'object'
  );

ALTER TABLE "provider_activity_events"
  ADD CONSTRAINT "provider_activity_events_digest_check" CHECK ("event_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "provider_activity_events_copy_nonblank_check" CHECK (
    btrim("event_type") <> '' AND btrim("dedupe_key") <> '' AND btrim("recovery_key") <> ''
    AND btrim("title") <> '' AND btrim("summary") <> ''
  ),
  ADD CONSTRAINT "provider_activity_events_local_refs_check" CHECK (
    "origin" = 'provider' OR ("local_run_id" IS NULL AND "local_quarantine_id" IS NULL)
  ),
  ADD CONSTRAINT "provider_activity_events_evidence_object_check" CHECK (jsonb_typeof("evidence") = 'object'),
  ADD CONSTRAINT "provider_activity_events_time_order_check" CHECK (
    "event_at" <= "received_at" AND "received_at" <= "created_at"
  );

ALTER TABLE "provider_health"
  ADD CONSTRAINT "provider_health_counts_check" CHECK (
    "consecutive_failures" >= 0 AND "open_quarantine_count" >= 0 AND "publication_lag" >= 0
  ),
  ADD CONSTRAINT "provider_health_activity_pair_check" CHECK (
    ("last_activity_event_id" IS NULL) = ("last_activity_at" IS NULL)
  ),
  ADD CONSTRAINT "provider_health_mapping_warning_check" CHECK (
    ("latest_mapping_warning_at" IS NULL) = ("mapping_warning_severity" IS NULL)
    AND (NOT "mapping_warning_active" OR "latest_mapping_warning_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_health_calculation_warning_check" CHECK (
    ("latest_calculation_warning_at" IS NULL) = ("calculation_warning_severity" IS NULL)
    AND (NOT "calculation_warning_active" OR "latest_calculation_warning_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "provider_health_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "admin_alerts"
  ADD CONSTRAINT "admin_alerts_counts_check" CHECK (
    "occurrence_count" > 0 AND "reopened_count" >= 0
  ),
  ADD CONSTRAINT "admin_alerts_time_order_check" CHECK ("first_seen_at" <= "last_seen_at"),
  ADD CONSTRAINT "admin_alerts_acknowledgement_pair_check" CHECK (
    ("acknowledged_by_actor_key" IS NULL) = ("acknowledged_at" IS NULL)
  ),
  ADD CONSTRAINT "admin_alerts_resolution_pair_check" CHECK (
    ("resolved_by_actor_key" IS NULL) = ("resolved_at" IS NULL)
  ),
  ADD CONSTRAINT "admin_alerts_state_time_check" CHECK (
    ("state" = 'active' AND "acknowledged_at" IS NULL AND "resolved_at" IS NULL)
    OR ("state" = 'acknowledged' AND "acknowledged_at" IS NOT NULL AND "resolved_at" IS NULL)
    OR ("state" = 'resolved' AND "resolved_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "admin_alerts_activity_provider_pair_check" CHECK (
    "latest_activity_event_id" IS NULL OR "provider_id" IS NOT NULL
  );

ALTER TABLE "global_categories"
  ADD CONSTRAINT "global_categories_key_nonblank_check" CHECK (btrim("category_key") <> ''),
  ADD CONSTRAINT "global_categories_display_name_check" CHECK (length(btrim("display_name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "global_categories_no_self_parent_check" CHECK ("parent_category_id" IS NULL OR "parent_category_id" <> "id"),
  ADD CONSTRAINT "global_categories_display_order_check" CHECK ("display_order" >= 0),
  ADD CONSTRAINT "global_categories_lifecycle_time_check" CHECK (
    ("lifecycle" = 'active' AND "retired_at" IS NULL)
    OR ("lifecycle" = 'retired' AND "retired_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "global_categories_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "global_collectibles"
  ADD CONSTRAINT "global_collectibles_names_check" CHECK (
    length(btrim("display_name")) BETWEEN 1 AND 240
    AND length(btrim("normalized_name")) BETWEEN 1 AND 240
  ),
  ADD CONSTRAINT "global_collectibles_year_check" CHECK ("year" IS NULL OR "year" BETWEEN 1000 AND 9999),
  ADD CONSTRAINT "global_collectibles_optional_copy_check" CHECK (
    ("brand" IS NULL OR length(btrim("brand")) BETWEEN 1 AND 120)
    AND ("set_or_series" IS NULL OR length(btrim("set_or_series")) BETWEEN 1 AND 200)
    AND ("card_number" IS NULL OR length(btrim("card_number")) BETWEEN 1 AND 100)
    AND ("reference_number" IS NULL OR length(btrim("reference_number")) BETWEEN 1 AND 100)
    AND ("subject" IS NULL OR length(btrim("subject")) BETWEEN 1 AND 200)
    AND ("grade" IS NULL OR length(btrim("grade")) BETWEEN 1 AND 100)
    AND ("grader" IS NULL OR length(btrim("grader")) BETWEEN 1 AND 100)
  ),
  ADD CONSTRAINT "global_collectibles_image_pair_check" CHECK (
    ("primary_image_url" IS NULL) = ("primary_image_alt" IS NULL)
    AND ("primary_image_url" IS NULL OR (length("primary_image_url") <= 2048 AND "primary_image_url" ~ '^https://[^/@?#]+'))
    AND ("primary_image_alt" IS NULL OR length(btrim("primary_image_alt")) BETWEEN 1 AND 200)
  ),
  ADD CONSTRAINT "global_collectibles_valuation_money_pair_check" CHECK (
    ("valuation_amount" IS NULL) = ("valuation_currency" IS NULL)
    AND ("valuation_amount" IS NULL OR "valuation_amount" >= 0)
    AND ("valuation_usd_amount" IS NULL OR "valuation_usd_amount" >= 0)
    AND (
      "valuation_currency" IS NULL
      OR "valuation_currency" ~ '^[A-Z0-9]{2,12}$'
      OR "valuation_currency" ~ '^0x[0-9A-Fa-f]{40}$'
    )
  ),
  ADD CONSTRAINT "global_collectibles_valuation_allowlists_check" CHECK (
    "valuation_unavailable_reason" IS NULL
      OR "valuation_unavailable_reason" IN ('VALUATION_UNAVAILABLE', 'CURRENCY_UNSUPPORTED')
  ),
  ADD CONSTRAINT "global_collectibles_valuation_type_check" CHECK (
    "valuation_type" IS NULL
      OR "valuation_type" IN ('market_estimate', 'vendor_reported', 'last_sale', 'appraisal')
  ),
  ADD CONSTRAINT "global_collectibles_valuation_descriptor_check" CHECK (
    ("valuation_type" IS NULL) = ("valuation_observed_at" IS NULL)
    AND (
      "valuation_type" IS NULL
      OR "valuation_amount" IS NOT NULL
      OR "valuation_unavailable_reason" IS NOT NULL
      OR "valuation_usd_amount" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "global_collectibles_identity_time_check" CHECK (
    ("identity_state" = 'retired' AND "retired_at" IS NOT NULL)
    OR ("identity_state" <> 'retired' AND "retired_at" IS NULL)
  ),
  ADD CONSTRAINT "global_collectibles_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "global_collectible_categories"
  ADD CONSTRAINT "global_collectible_categories_lifecycle_time_check" CHECK (
    ("lifecycle" = 'active' AND "retired_at" IS NULL)
    OR ("lifecycle" = 'retired' AND "retired_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "global_collectible_categories_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "global_collectible_name_aliases"
  ADD CONSTRAINT "global_collectible_name_aliases_names_check" CHECK (
    length(btrim("display_name")) BETWEEN 1 AND 240
    AND length(btrim("normalized_name")) BETWEEN 1 AND 240
  ),
  ADD CONSTRAINT "global_collectible_name_aliases_lifecycle_time_check" CHECK (
    ("lifecycle" = 'active' AND "retired_at" IS NULL)
    OR ("lifecycle" = 'retired' AND "retired_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "global_collectible_name_aliases_row_version_check" CHECK ("row_version" > 0);

ALTER TABLE "provider_category_correlations"
  ADD CONSTRAINT "provider_category_correlations_positive_versions_check" CHECK (
    "local_entity_version" > 0 AND "correlation_version" > 0 AND "row_version" > 0
  ),
  ADD CONSTRAINT "provider_category_correlations_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "provider_category_correlations_interval_check" CHECK (
    ("valid_to_event_sequence" IS NULL) = ("valid_to" IS NULL)
    AND ("valid_to_event_sequence" IS NULL OR "valid_from_event_sequence" < "valid_to_event_sequence")
    AND ("valid_to" IS NULL OR "valid_from" <= "valid_to")
  );

ALTER TABLE "provider_collectible_correlations"
  ADD CONSTRAINT "provider_collectible_correlations_positive_versions_check" CHECK (
    "local_entity_version" > 0 AND "correlation_version" > 0 AND "row_version" > 0
  ),
  ADD CONSTRAINT "provider_collectible_correlations_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "provider_collectible_correlations_interval_check" CHECK (
    ("valid_to_event_sequence" IS NULL) = ("valid_to" IS NULL)
    AND ("valid_to_event_sequence" IS NULL OR "valid_from_event_sequence" < "valid_to_event_sequence")
    AND ("valid_to" IS NULL OR "valid_from" <= "valid_to")
  );

ALTER TABLE "correlation_suggestions"
  ADD CONSTRAINT "correlation_suggestions_positive_versions_check" CHECK (
    "local_entity_version" > 0 AND "row_version" > 0
  ),
  ADD CONSTRAINT "correlation_suggestions_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "correlation_suggestions_distinct_candidate_check" CHECK (
    "candidate_collectible_id" <> "provisional_collectible_id"
  ),
  ADD CONSTRAINT "correlation_suggestions_bounded_rationale_check" CHECK (
    jsonb_typeof("rationale") = 'object'
    AND octet_length("rationale"::text) <= 4096
    AND NOT ("rationale" ?| ARRAY[
      'raw', 'payload', 'credential', 'databaseUrl', 'externalIdentifier'
    ])
  );

ALTER TABLE "catalog_ledger"
  ADD CONSTRAINT "catalog_ledger_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "catalog_ledger_sequence_check" CHECK ("last_sequence" >= 0);

ALTER TABLE "collectible_aliases"
  ADD CONSTRAINT "collectible_aliases_distinct_target_check" CHECK (
    "alias_collectible_id" <> "canonical_collectible_id"
  ),
  ADD CONSTRAINT "collectible_aliases_positive_decision_check" CHECK ("decision_event_sequence" > 0);

ALTER TABLE "catalog_decision_events"
  ADD CONSTRAINT "catalog_decision_events_sequence_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "catalog_decision_events_copy_nonblank_check" CHECK (
    btrim("event_type") <> '' AND btrim("actor_type") <> ''
    AND btrim("actor_id") <> '' AND btrim("reason") <> ''
  ),
  ADD CONSTRAINT "catalog_decision_events_state_shape_check" CHECK (
    ("before_state" IS NULL OR jsonb_typeof("before_state") = 'object')
    AND ("after_state" IS NULL OR jsonb_typeof("after_state") = 'object')
  ),
  ADD CONSTRAINT "catalog_decision_events_bounded_evidence_check" CHECK (
    length("event_type") <= 80
    AND length("actor_type") <= 80
    AND length("actor_id") <= 180
    AND length("reason") <= 160
    AND ("before_state" IS NULL OR octet_length("before_state"::text) <= 4096)
    AND ("after_state" IS NULL OR octet_length("after_state"::text) <= 4096)
  );

ALTER TABLE "catalog_promotion_changes"
  ADD CONSTRAINT "catalog_promotion_changes_sequences_check" CHECK (
    "sequence" > 0 AND "decision_event_sequence" > 0 AND "entity_version" > 0
  ),
  ADD CONSTRAINT "catalog_promotion_changes_entity_type_check" CHECK (
    "entity_type" IN (
      'global_category',
      'global_collectible',
      'global_collectible_category',
      'global_collectible_name_alias',
      'collectible_alias',
      'provider_category_correlation',
      'provider_collectible_correlation'
    )
  ),
  ADD CONSTRAINT "catalog_promotion_changes_provider_scope_check" CHECK (
    "entity_type" NOT IN ('provider_category_correlation', 'provider_collectible_correlation')
    OR "provider_id" IS NOT NULL
  );

ALTER TABLE "provider_release_invalidation_ledger"
  ADD CONSTRAINT "provider_release_invalidation_ledger_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "provider_release_invalidation_ledger_sequence_check" CHECK ("last_sequence" >= 0);

ALTER TABLE "provider_release_invalidations"
  ADD CONSTRAINT "provider_release_invalidations_sequence_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "provider_release_invalidations_exact_cause_check" CHECK (
    (("catalog_change_sequence" IS NOT NULL)::int + ("public_profile_version_id" IS NOT NULL)::int) = 1
  ),
  ADD CONSTRAINT "provider_release_invalidations_reason_nonblank_check" CHECK (btrim("reason") <> '');

ALTER TABLE "provider_invalidation_checkpoints"
  ADD CONSTRAINT "provider_invalidation_checkpoints_values_check" CHECK (
    "last_confirmed_invalidation_sequence" >= 0 AND "row_version" > 0
  ),
  ADD CONSTRAINT "provider_invalidation_checkpoints_confirmation_check" CHECK (
    ("last_confirmed_invalidation_sequence" = 0 AND "confirmed_provider_release_id" IS NULL)
    OR ("last_confirmed_invalidation_sequence" > 0 AND "confirmed_provider_release_id" IS NOT NULL)
  );

ALTER TABLE "catalog_consumer_checkpoints"
  ADD CONSTRAINT "catalog_consumer_checkpoints_key_check" CHECK ("consumer_key" = 'catalog_publication'),
  ADD CONSTRAINT "catalog_consumer_checkpoints_values_check" CHECK (
    "last_confirmed_sequence" >= 0 AND "lease_fence" >= 0 AND "row_version" > 0
  ),
  ADD CONSTRAINT "catalog_consumer_checkpoints_confirmation_check" CHECK (
    ("last_confirmed_sequence" = 0 AND "confirmation_id" IS NULL)
    OR ("last_confirmed_sequence" > 0 AND "confirmation_id" IS NOT NULL AND btrim("confirmation_id") <> '')
  ),
  ADD CONSTRAINT "catalog_consumer_checkpoints_lease_check" CHECK (
    ("lease_owner" IS NULL AND "lease_expires_at" IS NULL)
    OR ("lease_owner" IS NOT NULL AND btrim("lease_owner") <> '' AND "lease_expires_at" IS NOT NULL)
  );

ALTER TABLE "catalog_versions"
  ADD CONSTRAINT "catalog_versions_boundary_check" CHECK ("through_change_sequence" >= 0),
  ADD CONSTRAINT "catalog_versions_schema_version_nonblank_check" CHECK (btrim("schema_version") <> ''),
  ADD CONSTRAINT "catalog_versions_counts_check" CHECK (
    "category_count" >= 0 AND "collectible_count" >= 0 AND "alias_count" >= 0
  ),
  ADD CONSTRAINT "catalog_versions_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "catalog_versions_lifecycle_time_check" CHECK (
    ("lifecycle" = 'building' AND "assembled_at" IS NULL AND "completed_at" IS NULL)
    OR ("lifecycle" IN ('assembled', 'publishing', 'blocked') AND "assembled_at" IS NOT NULL AND "completed_at" IS NULL)
    OR ("lifecycle" = 'complete' AND "assembled_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "assembled_at" <= "completed_at")
    OR ("lifecycle" = 'failed' AND "completed_at" IS NULL)
  );

ALTER TABLE "catalog_version_batches"
  ADD CONSTRAINT "catalog_version_batches_kind_check" CHECK (
    "batch_kind" IN ('categories', 'collectibles', 'aliases')
  ),
  ADD CONSTRAINT "catalog_version_batches_counts_check" CHECK (
    "batch_index" >= 0 AND "record_count" >= 0 AND "byte_count" >= 0
  ),
  ADD CONSTRAINT "catalog_version_batches_payload_check" CHECK (
    jsonb_typeof("payload") = 'array'
  ),
  ADD CONSTRAINT "catalog_version_batches_body_hash_check" CHECK ("body_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "catalog_publication_operations"
  ADD CONSTRAINT "catalog_publication_operations_batch_index_check" CHECK (
    ("operation_kind" = 'batch' AND "batch_index" IS NOT NULL AND "batch_index" >= 0 AND "body_hash" IS NOT NULL)
    OR ("operation_kind" <> 'batch' AND "batch_index" IS NULL AND "body_hash" IS NULL)
  ),
  ADD CONSTRAINT "catalog_publication_operations_request_check" CHECK (
    "operation_kind" IN ('start', 'batch', 'finalize', 'status', 'block', 'reuse')
    AND btrim("idempotency_key") <> ''
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND octet_length("request_bytes") > 0
    AND "request_digest" = encode(digest("request_bytes", 'sha256'), 'hex')
    AND ("body_hash" IS NULL OR "body_hash" ~ '^[0-9a-f]{64}$')
    AND "lease_fence" >= 0
  ),
  ADD CONSTRAINT "catalog_publication_operations_terminal_evidence_check" CHECK (
    ("state" = 'pending' AND "completed_at" IS NULL AND "convex_receipt_id" IS NULL AND "receipt_hash" IS NULL AND "receipt" IS NULL AND "failure_code" IS NULL)
    OR (
      "state" = 'accepted' AND "completed_at" IS NOT NULL
      AND "convex_receipt_id" IS NOT NULL AND btrim("convex_receipt_id") <> ''
      AND "receipt_hash" IS NOT NULL AND "receipt" IS NOT NULL
      AND jsonb_typeof("receipt") = 'object'
      AND "receipt_hash" = encode(digest(convert_to("receipt"::text, 'UTF8'), 'sha256'), 'hex')
      AND "failure_code" IS NULL
    )
    OR ("state" = 'ambiguous' AND "completed_at" IS NOT NULL AND "convex_receipt_id" IS NULL AND "receipt_hash" IS NULL AND "receipt" IS NULL AND "failure_code" IS NULL)
    OR ("state" = 'failed' AND "completed_at" IS NOT NULL AND "convex_receipt_id" IS NULL AND "receipt_hash" IS NULL AND "receipt" IS NULL AND "failure_code" IS NOT NULL AND btrim("failure_code") <> '')
  ),
  ADD CONSTRAINT "catalog_publication_operations_receipt_hash_check" CHECK (
    "receipt_hash" IS NULL OR "receipt_hash" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "manifest_activation_state"
  ADD CONSTRAINT "manifest_activation_state_singleton_check" CHECK ("singleton_key"),
  ADD CONSTRAINT "manifest_activation_state_active_pair_check" CHECK (
    ("active_manifest_id" IS NULL) = ("active_manifest_fingerprint" IS NULL)
  ),
  ADD CONSTRAINT "manifest_activation_state_previous_pair_check" CHECK (
    ("previous_manifest_id" IS NULL) = ("previous_manifest_fingerprint" IS NULL)
  ),
  ADD CONSTRAINT "manifest_activation_state_hashes_check" CHECK (
    ("active_manifest_fingerprint" IS NULL OR "active_manifest_fingerprint" ~ '^[0-9a-f]{64}$')
    AND ("previous_manifest_fingerprint" IS NULL OR "previous_manifest_fingerprint" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "manifest_activation_state_lease_check" CHECK (
    "lease_fence" >= 0 AND "row_version" > 0
    AND (
      ("lease_owner" IS NULL AND "lease_expires_at" IS NULL)
      OR ("lease_owner" IS NOT NULL AND btrim("lease_owner") <> '' AND "lease_expires_at" IS NOT NULL)
    )
  );

ALTER TABLE "manifest_activation_operations"
  ADD CONSTRAINT "manifest_activation_operations_target_check" CHECK (
    ("operation" = 'remove' AND "target_provider_release_id" IS NULL AND "target_catalog_version_id" IS NULL)
    OR ("operation" IN ('advance', 'add', 'rollback') AND "target_provider_release_id" IS NOT NULL AND "target_catalog_version_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "manifest_activation_operations_request_check" CHECK (
    btrim("idempotency_key") <> ''
    AND "new_manifest_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "lease_fence" >= 0
  ),
  ADD CONSTRAINT "manifest_activation_operations_terminal_evidence_check" CHECK (
    ("state" = 'pending' AND "completed_at" IS NULL AND "convex_receipt_id" IS NULL AND "receipt_hash" IS NULL AND "receipt" IS NULL)
    OR (
      "state" = 'accepted' AND "completed_at" IS NOT NULL
      AND "convex_receipt_id" IS NOT NULL AND btrim("convex_receipt_id") <> ''
      AND "receipt_hash" IS NOT NULL AND "receipt" IS NOT NULL
      AND jsonb_typeof("receipt") = 'object'
      AND "receipt_hash" = encode(digest(convert_to("receipt"::text, 'UTF8'), 'sha256'), 'hex')
    )
    OR ("state" IN ('ambiguous', 'failed') AND "completed_at" IS NOT NULL AND "convex_receipt_id" IS NULL AND "receipt_hash" IS NULL AND "receipt" IS NULL)
  ),
  ADD CONSTRAINT "manifest_activation_operations_receipt_hash_check" CHECK (
    "receipt_hash" IS NULL OR "receipt_hash" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "artifact_retention_executions"
  ADD CONSTRAINT "artifact_retention_executions_counts_check" CHECK (
    "batch_size" > 0 AND "selected_count" >= 0 AND "deleted_count" >= 0
    AND "protected_count" >= 0 AND "failed_count" >= 0
    AND "deleted_count" + "protected_count" + "failed_count" <= "selected_count"
  ),
  ADD CONSTRAINT "artifact_retention_executions_state_time_check" CHECK (
    ("state" = 'running' AND "finished_at" IS NULL AND "failure_code" IS NULL)
    OR ("state" = 'succeeded' AND "finished_at" IS NOT NULL AND "failure_code" IS NULL)
    OR ("state" = 'failed' AND "finished_at" IS NOT NULL AND "failure_code" IS NOT NULL)
  ),
  ADD CONSTRAINT "artifact_retention_executions_finish_order_check" CHECK (
    "finished_at" IS NULL OR "started_at" <= "finished_at"
  );

-- Same-authority foreign keys. Every delete action is explicitly restrictive.
ALTER TABLE "operator_memberships"
  ADD CONSTRAINT "operator_memberships_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "operator_memberships_operator_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "operator_sessions"
  ADD CONSTRAINT "operator_sessions_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "operator_sessions_operator_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "operator_sessions_membership_fk" FOREIGN KEY ("organization_id", "operator_id") REFERENCES "operator_memberships"("organization_id", "operator_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "providers"
  ADD CONSTRAINT "providers_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "providers_active_config_fk" FOREIGN KEY ("active_config_version_id", "id") REFERENCES "provider_config_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "providers_active_profile_fk" FOREIGN KEY ("active_public_profile_version_id", "id") REFERENCES "provider_public_profile_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_public_profile_versions"
  ADD CONSTRAINT "provider_public_profile_versions_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_public_profile_versions_operator_fk" FOREIGN KEY ("created_by_operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_config_versions"
  ADD CONSTRAINT "provider_config_versions_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_config_versions_source_credential_fk" FOREIGN KEY ("source_credential_version_id", "provider_id") REFERENCES "provider_credential_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_config_versions_operator_fk" FOREIGN KEY ("created_by_operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_credential_versions"
  ADD CONSTRAINT "provider_credential_versions_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_database_nodes"
  ADD CONSTRAINT "provider_database_nodes_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_database_nodes_credential_fk" FOREIGN KEY ("credential_version_id", "provider_id") REFERENCES "provider_credential_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_connection_tests"
  ADD CONSTRAINT "provider_connection_tests_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_connection_tests_config_fk" FOREIGN KEY ("config_version_id", "provider_id") REFERENCES "provider_config_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_connection_tests_source_credential_fk" FOREIGN KEY ("source_credential_version_id", "provider_id") REFERENCES "provider_credential_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_connection_tests_database_credential_fk" FOREIGN KEY ("database_credential_version_id", "provider_id") REFERENCES "provider_credential_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_connection_tests_database_node_fk" FOREIGN KEY ("database_node_id", "provider_id") REFERENCES "provider_database_nodes"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_connection_tests_operator_fk" FOREIGN KEY ("tested_by_operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_activity_events"
  ADD CONSTRAINT "provider_activity_events_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_activity_events_provider_organization_fk" FOREIGN KEY ("provider_id", "organization_id") REFERENCES "providers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_health"
  ADD CONSTRAINT "provider_health_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_health_provider_organization_fk" FOREIGN KEY ("provider_id", "organization_id") REFERENCES "providers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_health_last_activity_fk" FOREIGN KEY ("provider_id", "last_activity_event_id") REFERENCES "provider_activity_events"("provider_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "admin_alerts"
  ADD CONSTRAINT "admin_alerts_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "admin_alerts_provider_organization_fk" FOREIGN KEY ("provider_id", "organization_id") REFERENCES "providers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "admin_alerts_latest_activity_fk" FOREIGN KEY ("provider_id", "latest_activity_event_id") REFERENCES "provider_activity_events"("provider_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "global_categories"
  ADD CONSTRAINT "global_categories_parent_fk" FOREIGN KEY ("parent_category_id") REFERENCES "global_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "global_collectibles"
  ADD CONSTRAINT "global_collectibles_primary_category_fk" FOREIGN KEY ("primary_category_id") REFERENCES "global_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "global_collectible_categories"
  ADD CONSTRAINT "global_collectible_categories_collectible_fk" FOREIGN KEY ("global_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "global_collectible_categories_category_fk" FOREIGN KEY ("global_category_id") REFERENCES "global_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "global_collectible_name_aliases"
  ADD CONSTRAINT "global_collectible_name_aliases_collectible_fk" FOREIGN KEY ("global_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_category_correlations"
  ADD CONSTRAINT "provider_category_correlations_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_category_correlations_global_category_fk" FOREIGN KEY ("global_category_id") REFERENCES "global_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_category_correlations_valid_from_event_fk" FOREIGN KEY ("valid_from_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_category_correlations_valid_to_event_fk" FOREIGN KEY ("valid_to_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_collectible_correlations"
  ADD CONSTRAINT "provider_collectible_correlations_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_collectible_correlations_global_collectible_fk" FOREIGN KEY ("global_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_collectible_correlations_valid_from_event_fk" FOREIGN KEY ("valid_from_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_collectible_correlations_valid_to_event_fk" FOREIGN KEY ("valid_to_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "correlation_suggestions"
  ADD CONSTRAINT "correlation_suggestions_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "correlation_suggestions_provisional_fk" FOREIGN KEY ("provisional_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "correlation_suggestions_candidate_fk" FOREIGN KEY ("candidate_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "correlation_suggestions_decision_event_fk" FOREIGN KEY ("decision_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "collectible_aliases"
  ADD CONSTRAINT "collectible_aliases_alias_collectible_fk" FOREIGN KEY ("alias_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "collectible_aliases_canonical_collectible_fk" FOREIGN KEY ("canonical_collectible_id") REFERENCES "global_collectibles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "collectible_aliases_decision_event_fk" FOREIGN KEY ("decision_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "catalog_promotion_changes"
  ADD CONSTRAINT "catalog_promotion_changes_decision_event_fk" FOREIGN KEY ("decision_event_sequence") REFERENCES "catalog_decision_events"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "catalog_promotion_changes_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_release_invalidations"
  ADD CONSTRAINT "provider_release_invalidations_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_release_invalidations_catalog_change_fk" FOREIGN KEY ("catalog_change_sequence") REFERENCES "catalog_promotion_changes"("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_release_invalidations_public_profile_fk" FOREIGN KEY ("public_profile_version_id", "provider_id") REFERENCES "provider_public_profile_versions"("id", "provider_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "provider_invalidation_checkpoints"
  ADD CONSTRAINT "provider_invalidation_checkpoints_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "catalog_versions"
  ADD CONSTRAINT "catalog_versions_predecessor_fk" FOREIGN KEY ("predecessor_id") REFERENCES "catalog_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "catalog_version_batches"
  ADD CONSTRAINT "catalog_version_batches_catalog_version_fk" FOREIGN KEY ("catalog_version_id") REFERENCES "catalog_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "catalog_publication_operations"
  ADD CONSTRAINT "catalog_publication_operations_catalog_version_fk" FOREIGN KEY ("catalog_version_id") REFERENCES "catalog_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "manifest_activation_operations"
  ADD CONSTRAINT "manifest_activation_operations_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "manifest_activation_operations_catalog_version_fk" FOREIGN KEY ("target_catalog_version_id") REFERENCES "catalog_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "manifest_activation_operations_operator_fk" FOREIGN KEY ("requested_by_operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Generic immutability, no-delete, and optimistic-version guards.
CREATE FUNCTION "packscout_reject_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "packscout_reject_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'deleting from % is prohibited', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "packscout_enforce_row_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_payload jsonb := to_jsonb(OLD) - 'row_version' - 'updated_at';
  new_payload jsonb := to_jsonb(NEW) - 'row_version' - 'updated_at';
BEGIN
  IF new_payload = old_payload THEN
    IF NEW.row_version IS DISTINCT FROM OLD.row_version
       OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION '% semantic no-op must not change row_version or updated_at', TG_TABLE_NAME
        USING ERRCODE = '40001';
    END IF;
  ELSE
    IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION '% material update must increment row_version once and advance updated_at', TG_TABLE_NAME
        USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "providers_row_version_guard"
  BEFORE UPDATE ON "providers"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_database_nodes_row_version_guard"
  BEFORE UPDATE ON "provider_database_nodes"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_health_row_version_guard"
  BEFORE UPDATE ON "provider_health"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "global_categories_row_version_guard"
  BEFORE UPDATE ON "global_categories"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "global_collectibles_row_version_guard"
  BEFORE UPDATE ON "global_collectibles"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "global_collectible_categories_row_version_guard"
  BEFORE UPDATE ON "global_collectible_categories"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "global_collectible_name_aliases_row_version_guard"
  BEFORE UPDATE ON "global_collectible_name_aliases"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_category_correlations_row_version_guard"
  BEFORE UPDATE ON "provider_category_correlations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_collectible_correlations_row_version_guard"
  BEFORE UPDATE ON "provider_collectible_correlations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "correlation_suggestions_row_version_guard"
  BEFORE UPDATE ON "correlation_suggestions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "provider_invalidation_checkpoints_row_version_guard"
  BEFORE UPDATE ON "provider_invalidation_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "catalog_consumer_checkpoints_row_version_guard"
  BEFORE UPDATE ON "catalog_consumer_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();
CREATE TRIGGER "manifest_activation_state_row_version_guard"
  BEFORE UPDATE ON "manifest_activation_state"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_row_version"();

-- Consumer positions and lease generations never move backward. Receipt checks are
-- deferred below so an accepted operation and its checkpoint can commit atomically.
CREATE FUNCTION "packscout_guard_catalog_consumer_checkpoint"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.consumer_key IS DISTINCT FROM OLD.consumer_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'catalog consumer checkpoint identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_confirmed_sequence < OLD.last_confirmed_sequence
     OR NEW.lease_fence < OLD.lease_fence THEN
    RAISE EXCEPTION 'catalog consumer checkpoint and lease fence are monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_fence <= OLD.lease_fence THEN
    RAISE EXCEPTION 'catalog lease ownership change requires a new fence' USING ERRCODE = '40001';
  END IF;
  IF NEW.last_confirmed_sequence = OLD.last_confirmed_sequence
     AND NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
    RAISE EXCEPTION 'catalog checkpoint receipt is immutable at a confirmed sequence' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_confirmed_sequence > (
    SELECT last_sequence FROM "catalog_ledger" WHERE singleton_key
  ) THEN
    RAISE EXCEPTION 'catalog checkpoint cannot pass the allocated catalog ledger' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "catalog_consumer_checkpoints_monotonic_guard"
  BEFORE UPDATE ON "catalog_consumer_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_catalog_consumer_checkpoint"();

CREATE FUNCTION "packscout_has_exact_catalog_completion_receipt"(
  receipt_id_value text,
  catalog_version_id_value uuid,
  confirmed_sequence_value bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "catalog_publication_operations" operation
    JOIN "catalog_versions" version ON version.id = operation.catalog_version_id
    WHERE version.id = catalog_version_id_value
      AND operation.state = 'accepted'
      AND operation.operation_kind IN ('finalize', 'reuse')
      AND operation.convex_receipt_id IS NOT NULL
      AND operation.receipt_hash IS NOT NULL
      AND operation.receipt IS NOT NULL
      AND (receipt_id_value IS NULL OR operation.convex_receipt_id = receipt_id_value)
      AND (
        (operation.operation_kind = 'finalize' AND version.through_change_sequence = confirmed_sequence_value)
        OR (operation.operation_kind = 'reuse' AND version.through_change_sequence <= confirmed_sequence_value)
      )
  );
$$;

CREATE FUNCTION "packscout_validate_catalog_checkpoint_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_confirmed_sequence <= OLD.last_confirmed_sequence THEN
    RETURN NULL;
  END IF;
  IF NOT "packscout_has_exact_catalog_completion_receipt"(
    NEW.confirmation_id,
    (
      SELECT operation.catalog_version_id
      FROM "catalog_publication_operations" operation
      WHERE operation.convex_receipt_id = NEW.confirmation_id
        AND operation.lease_fence = NEW.lease_fence
    ),
    NEW.last_confirmed_sequence
  ) OR NOT EXISTS (
    SELECT 1
    FROM "catalog_publication_operations" operation
    JOIN "catalog_versions" version ON version.id = operation.catalog_version_id
    WHERE operation.convex_receipt_id = NEW.confirmation_id
      AND operation.lease_fence = NEW.lease_fence
      AND version.lifecycle = 'complete'
  ) THEN
    RAISE EXCEPTION 'catalog checkpoint requires its exact accepted completion receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "catalog_consumer_checkpoints_receipt_guard"
  AFTER UPDATE ON "catalog_consumer_checkpoints"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_checkpoint_receipt"();

CREATE FUNCTION "packscout_guard_manifest_activation_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.singleton_key IS DISTINCT FROM OLD.singleton_key THEN
    RAISE EXCEPTION 'manifest activation state identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_fence < OLD.lease_fence THEN
    RAISE EXCEPTION 'manifest activation lease fence is monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_fence <= OLD.lease_fence THEN
    RAISE EXCEPTION 'manifest lease ownership change requires a new fence' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "manifest_activation_state_monotonic_guard"
  BEFORE UPDATE ON "manifest_activation_state"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_manifest_activation_state"();

CREATE FUNCTION "packscout_validate_manifest_activation_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.active_manifest_id,
    NEW.active_manifest_fingerprint,
    NEW.previous_manifest_id,
    NEW.previous_manifest_fingerprint,
    NEW.last_receipt_id
  ) IS NOT DISTINCT FROM (
    OLD.active_manifest_id,
    OLD.active_manifest_fingerprint,
    OLD.previous_manifest_id,
    OLD.previous_manifest_fingerprint,
    OLD.last_receipt_id
  ) THEN
    RETURN NULL;
  END IF;
  IF NEW.active_manifest_id IS NULL
     OR NEW.active_manifest_fingerprint IS NULL
     OR NEW.previous_manifest_id IS DISTINCT FROM OLD.active_manifest_id
     OR NEW.previous_manifest_fingerprint IS DISTINCT FROM OLD.active_manifest_fingerprint
     OR NOT EXISTS (
       SELECT 1
       FROM "manifest_activation_operations" operation
       WHERE operation.state = 'accepted'
         AND operation.convex_receipt_id = NEW.last_receipt_id
         AND operation.lease_fence = NEW.lease_fence
         AND operation.expected_manifest_id IS NOT DISTINCT FROM OLD.active_manifest_id
         AND operation.new_manifest_fingerprint = NEW.active_manifest_fingerprint
     ) THEN
    RAISE EXCEPTION 'manifest state change requires its exact accepted activation receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "manifest_activation_state_receipt_guard"
  AFTER UPDATE ON "manifest_activation_state"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_manifest_activation_receipt"();

CREATE TRIGGER "audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "provider_public_profile_versions_append_only"
  BEFORE UPDATE OR DELETE ON "provider_public_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "provider_config_versions_append_only"
  BEFORE UPDATE OR DELETE ON "provider_config_versions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "provider_connection_tests_append_only"
  BEFORE UPDATE OR DELETE ON "provider_connection_tests"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "provider_activity_events_append_only"
  BEFORE UPDATE OR DELETE ON "provider_activity_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "collectible_aliases_append_only"
  BEFORE UPDATE OR DELETE ON "collectible_aliases"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "catalog_decision_events_append_only"
  BEFORE UPDATE OR DELETE ON "catalog_decision_events"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "catalog_promotion_changes_append_only"
  BEFORE UPDATE OR DELETE ON "catalog_promotion_changes"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "provider_release_invalidations_append_only"
  BEFORE UPDATE OR DELETE ON "provider_release_invalidations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();
CREATE TRIGGER "catalog_version_batches_no_mutation"
  BEFORE UPDATE OR DELETE ON "catalog_version_batches"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_mutation"();

CREATE TRIGGER "providers_no_delete"
  BEFORE DELETE ON "providers"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "provider_credential_versions_no_delete"
  BEFORE DELETE ON "provider_credential_versions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "provider_database_nodes_no_delete"
  BEFORE DELETE ON "provider_database_nodes"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "global_categories_no_delete"
  BEFORE DELETE ON "global_categories"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "global_collectibles_no_delete"
  BEFORE DELETE ON "global_collectibles"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "global_collectible_categories_no_delete"
  BEFORE DELETE ON "global_collectible_categories"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "global_collectible_name_aliases_no_delete"
  BEFORE DELETE ON "global_collectible_name_aliases"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "provider_category_correlations_no_delete"
  BEFORE DELETE ON "provider_category_correlations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "provider_collectible_correlations_no_delete"
  BEFORE DELETE ON "provider_collectible_correlations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "correlation_suggestions_no_delete"
  BEFORE DELETE ON "correlation_suggestions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "catalog_consumer_checkpoints_no_delete"
  BEFORE DELETE ON "catalog_consumer_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "catalog_versions_no_delete"
  BEFORE DELETE ON "catalog_versions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "catalog_publication_operations_no_delete"
  BEFORE DELETE ON "catalog_publication_operations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "manifest_activation_operations_no_delete"
  BEFORE DELETE ON "manifest_activation_operations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "manifest_activation_state_no_delete"
  BEFORE DELETE ON "manifest_activation_state"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();
CREATE TRIGGER "artifact_retention_executions_no_delete"
  BEFORE DELETE ON "artifact_retention_executions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();

CREATE FUNCTION "packscout_enforce_credential_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.provider_id, NEW.credential_kind, NEW.version_number, NEW.ciphertext,
      NEW.nonce, NEW.auth_tag, NEW.key_version, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.credential_kind, OLD.version_number, OLD.ciphertext,
      OLD.nonce, OLD.auth_tag, OLD.key_version, OLD.created_at) THEN
    RAISE EXCEPTION 'credential identity and encrypted payload are immutable' USING ERRCODE = '55000';
  END IF;

  IF NOT (
    NEW.lifecycle = OLD.lifecycle
    OR (OLD.lifecycle = 'active' AND NEW.lifecycle IN ('retired', 'revoked'))
    OR (OLD.lifecycle = 'retired' AND NEW.lifecycle = 'revoked')
  ) THEN
    RAISE EXCEPTION 'credential lifecycle transition % -> % is not allowed', OLD.lifecycle, NEW.lifecycle
      USING ERRCODE = '55000';
  END IF;

  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'credential activation time is immutable once set' USING ERRCODE = '55000';
  END IF;
  IF NEW.activated_at IS NOT NULL AND OLD.activated_at IS NULL AND NEW.activated_at < OLD.created_at THEN
    RAISE EXCEPTION 'credential activation cannot predate creation' USING ERRCODE = '23514';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'credential retirement time is immutable once set' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'credential revocation time is immutable once set' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_credential_versions_one_way"
  BEFORE UPDATE ON "provider_credential_versions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_credential_transition"();

CREATE FUNCTION "packscout_require_provider_membership"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  provider_value uuid;
  operator_value uuid;
BEGIN
  provider_value := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
  operator_value := NULLIF(to_jsonb(NEW) ->> TG_ARGV[1], '')::uuid;
  IF operator_value IS NULL THEN
    RETURN NULL;
  END IF;
  IF provider_value IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "providers" p
    JOIN "operator_memberships" membership
      ON membership.organization_id = p.organization_id
     AND membership.operator_id = operator_value
    WHERE p.id = provider_value
  ) THEN
    RAISE EXCEPTION 'operator does not belong to the provider organization' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_public_profile_versions_membership_guard"
  AFTER INSERT OR UPDATE ON "provider_public_profile_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_provider_membership"('provider_id', 'created_by_operator_id');
CREATE CONSTRAINT TRIGGER "provider_config_versions_membership_guard"
  AFTER INSERT OR UPDATE ON "provider_config_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_provider_membership"('provider_id', 'created_by_operator_id');
CREATE CONSTRAINT TRIGGER "provider_connection_tests_membership_guard"
  AFTER INSERT OR UPDATE ON "provider_connection_tests"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_provider_membership"('provider_id', 'tested_by_operator_id');
CREATE CONSTRAINT TRIGGER "manifest_activation_operations_membership_guard"
  AFTER INSERT OR UPDATE ON "manifest_activation_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_provider_membership"('provider_id', 'requested_by_operator_id');

CREATE FUNCTION "packscout_require_credential_kind"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  provider_value uuid;
  credential_value uuid;
  required_kind credential_kind := TG_ARGV[2]::credential_kind;
BEGIN
  provider_value := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
  credential_value := NULLIF(to_jsonb(NEW) ->> TG_ARGV[1], '')::uuid;
  IF credential_value IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "provider_credential_versions" credential
    WHERE credential.id = credential_value
      AND credential.provider_id = provider_value
      AND credential.credential_kind = required_kind
  ) THEN
    RAISE EXCEPTION 'credential does not have required kind %', required_kind USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_config_versions_source_kind_guard"
  AFTER INSERT OR UPDATE ON "provider_config_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_credential_kind"('provider_id', 'source_credential_version_id', 'source');
CREATE CONSTRAINT TRIGGER "provider_database_nodes_database_kind_guard"
  AFTER INSERT OR UPDATE ON "provider_database_nodes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_credential_kind"('provider_id', 'credential_version_id', 'database');
CREATE CONSTRAINT TRIGGER "provider_connection_tests_source_kind_guard"
  AFTER INSERT OR UPDATE ON "provider_connection_tests"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_credential_kind"('provider_id', 'source_credential_version_id', 'source');
CREATE CONSTRAINT TRIGGER "provider_connection_tests_database_kind_guard"
  AFTER INSERT OR UPDATE ON "provider_connection_tests"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_credential_kind"('provider_id', 'database_credential_version_id', 'database');

CREATE FUNCTION "packscout_validate_provider_database_name"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_name text;
BEGIN
  SELECT 'packscout_' || p.provider_key INTO expected_name
  FROM "providers" p
  WHERE p.id = NEW.provider_id;
  IF NEW.database_name IS DISTINCT FROM expected_name THEN
    RAISE EXCEPTION 'provider database name does not match provider key' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_database_nodes_name_guard"
  AFTER INSERT OR UPDATE ON "provider_database_nodes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_provider_database_name"();

CREATE FUNCTION "packscout_bump_topology_for_node_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  routing_changed boolean;
BEGIN
  routing_changed := TG_OP = 'INSERT' AND NEW.enabled;
  IF TG_OP = 'UPDATE' THEN
    routing_changed := (OLD.enabled OR NEW.enabled) AND (
      NEW.enabled IS DISTINCT FROM OLD.enabled
      OR NEW.node_role IS DISTINCT FROM OLD.node_role
      OR NEW.host IS DISTINCT FROM OLD.host
      OR NEW.port IS DISTINCT FROM OLD.port
      OR NEW.database_name IS DISTINCT FROM OLD.database_name
      OR NEW.ssl_mode IS DISTINCT FROM OLD.ssl_mode
      OR NEW.credential_version_id IS DISTINCT FROM OLD.credential_version_id
      OR NEW.region IS DISTINCT FROM OLD.region
    );
  END IF;
  IF routing_changed THEN
    UPDATE "providers"
    SET topology_version = topology_version + 1,
        row_version = row_version + 1,
        updated_at = clock_timestamp()
    WHERE id = NEW.provider_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "provider_database_nodes_topology_bump"
  AFTER INSERT OR UPDATE ON "provider_database_nodes"
  FOR EACH ROW EXECUTE FUNCTION "packscout_bump_topology_for_node_change"();

CREATE FUNCTION "packscout_activation_target_digest_nullable_source"(
  provider_value uuid,
  config_value uuid,
  source_credential_value uuid,
  database_credential_value uuid,
  topology_value bigint,
  node_value uuid,
  node_row_version_value bigint
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      concat_ws(
        ':',
        'packscout-activation-target-v1',
        provider_value::text,
        config_value::text,
        coalesce(source_credential_value::text, '-'),
        database_credential_value::text,
        topology_value::text,
        node_value::text,
        node_row_version_value::text
      ),
      'sha256'
    ),
    'hex'
  );
$$;

CREATE FUNCTION "packscout_assert_provider_activation"(provider_value uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  provider_row "providers"%ROWTYPE;
  config_row "provider_config_versions"%ROWTYPE;
  node_row "provider_database_nodes"%ROWTYPE;
  expected_digest text;
BEGIN
  SELECT * INTO provider_row FROM "providers" WHERE id = provider_value;
  IF NOT FOUND OR provider_row.lifecycle <> 'active' THEN
    RETURN;
  END IF;
  IF provider_row.active_config_version_id IS NULL THEN
    RAISE EXCEPTION 'active provider requires an active configuration' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO config_row
  FROM "provider_config_versions"
  WHERE id = provider_row.active_config_version_id
    AND provider_id = provider_row.id;
  IF NOT FOUND OR (config_row.expires_at IS NOT NULL AND config_row.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'active provider configuration is missing, foreign, or expired' USING ERRCODE = '23514';
  END IF;

  IF config_row.source_credential_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "provider_credential_versions" credential
    WHERE credential.id = config_row.source_credential_version_id
      AND credential.provider_id = provider_row.id
      AND credential.credential_kind = 'source'
      AND credential.lifecycle = 'active'
  ) THEN
    RAISE EXCEPTION 'active provider source credential is not active' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO node_row
  FROM "provider_database_nodes"
  WHERE provider_id = provider_row.id
    AND enabled
    AND node_role = 'primary';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active provider requires one enabled primary database node' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "provider_credential_versions" credential
    WHERE credential.id = node_row.credential_version_id
      AND credential.provider_id = provider_row.id
      AND credential.credential_kind = 'database'
      AND credential.lifecycle = 'active'
  ) THEN
    RAISE EXCEPTION 'active provider database credential is not active' USING ERRCODE = '23514';
  END IF;

  expected_digest := "packscout_activation_target_digest_nullable_source"(
    provider_row.id,
    config_row.id,
    config_row.source_credential_version_id,
    node_row.credential_version_id,
    provider_row.topology_version,
    node_row.id,
    node_row.row_version
  );

  IF NOT EXISTS (
    SELECT 1
    FROM "provider_connection_tests" test
    WHERE test.provider_id = provider_row.id
      AND test.config_version_id = config_row.id
      AND test.source_credential_version_id IS NOT DISTINCT FROM config_row.source_credential_version_id
      AND test.database_credential_version_id = node_row.credential_version_id
      AND test.topology_version = provider_row.topology_version
      AND test.database_node_id = node_row.id
      AND test.database_node_row_version = node_row.row_version
      AND test.target_digest = expected_digest
      AND test.test_kind = 'activation'
      AND test.outcome = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'active provider lacks a successful exact activation test' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "packscout_validate_provider_activation_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "packscout_assert_provider_activation"(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "providers_exact_activation_guard"
  AFTER INSERT OR UPDATE ON "providers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_provider_activation_trigger"();

CREATE FUNCTION "packscout_revalidate_credential_provider"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "packscout_assert_provider_activation"(NEW.provider_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_credential_versions_activation_guard"
  AFTER UPDATE ON "provider_credential_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_revalidate_credential_provider"();

-- Deferred graph invariants.
CREATE FUNCTION "packscout_validate_global_category_acyclic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestry(id, parent_id, path, cycle) AS (
      SELECT category.id, category.parent_category_id, ARRAY[category.id], false
      FROM "global_categories" category
      WHERE category.id = NEW.id
      UNION ALL
      SELECT parent.id,
             parent.parent_category_id,
             ancestry.path || parent.id,
             parent.id = ANY(ancestry.path)
      FROM ancestry
      JOIN "global_categories" parent ON parent.id = ancestry.parent_id
      WHERE NOT ancestry.cycle
    )
    SELECT 1 FROM ancestry WHERE cycle
  ) THEN
    RAISE EXCEPTION 'global category ancestry must be acyclic' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "global_categories_acyclic_guard"
  AFTER INSERT OR UPDATE OF "parent_category_id" ON "global_categories"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_global_category_acyclic"();

CREATE FUNCTION "packscout_validate_collectible_alias_acyclic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_cycle boolean;
  has_surviving_target boolean;
BEGIN
  WITH RECURSIVE chain(id, path, cycle) AS (
    SELECT NEW.canonical_collectible_id,
           ARRAY[NEW.alias_collectible_id, NEW.canonical_collectible_id],
           NEW.canonical_collectible_id = NEW.alias_collectible_id
    UNION ALL
    SELECT next_alias.canonical_collectible_id,
           chain.path || next_alias.canonical_collectible_id,
           next_alias.canonical_collectible_id = ANY(chain.path)
    FROM chain
    JOIN "collectible_aliases" next_alias ON next_alias.alias_collectible_id = chain.id
    WHERE NOT chain.cycle
  )
  SELECT coalesce(bool_or(chain.cycle), false),
         coalesce(bool_or(
           NOT chain.cycle
           AND NOT EXISTS (
             SELECT 1 FROM "collectible_aliases" continuation
             WHERE continuation.alias_collectible_id = chain.id
           )
           AND EXISTS (
             SELECT 1 FROM "global_collectibles" target
             WHERE target.id = chain.id AND target.identity_state <> 'retired'
           )
         ), false)
  INTO has_cycle, has_surviving_target
  FROM chain;

  IF has_cycle THEN
    RAISE EXCEPTION 'collectible aliases must be acyclic' USING ERRCODE = '23514';
  END IF;
  IF NOT has_surviving_target THEN
    RAISE EXCEPTION 'collectible alias must resolve to a surviving identity' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "collectible_aliases_acyclic_survivor_guard"
  AFTER INSERT ON "collectible_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_collectible_alias_acyclic"();

CREATE FUNCTION "packscout_assert_primary_category_link"(collectible_value uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  primary_value uuid;
BEGIN
  SELECT primary_category_id INTO primary_value
  FROM "global_collectibles"
  WHERE id = collectible_value;
  IF FOUND AND primary_value IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "global_collectible_categories" link
    WHERE link.global_collectible_id = collectible_value
      AND link.global_category_id = primary_value
      AND link.lifecycle = 'active'
  ) THEN
    RAISE EXCEPTION 'primary category requires an active collectible-category link' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "packscout_validate_collectible_primary_link"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "packscout_assert_primary_category_link"(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_validate_category_link"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lifecycle = 'active' AND NOT EXISTS (
    SELECT 1 FROM "global_categories" category
    WHERE category.id = NEW.global_category_id AND category.lifecycle = 'active'
  ) THEN
    RAISE EXCEPTION 'retired categories cannot receive active links' USING ERRCODE = '23514';
  END IF;
  PERFORM "packscout_assert_primary_category_link"(NEW.global_collectible_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "global_collectibles_primary_link_guard"
  AFTER INSERT OR UPDATE OF "primary_category_id" ON "global_collectibles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_collectible_primary_link"();
CREATE CONSTRAINT TRIGGER "global_collectible_categories_link_guard"
  AFTER INSERT OR UPDATE ON "global_collectible_categories"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_category_link"();

CREATE FUNCTION "packscout_validate_collectible_name_limit"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    SELECT count(*)
    FROM "global_collectible_name_aliases" alias
    WHERE alias.global_collectible_id = NEW.global_collectible_id
      AND alias.lifecycle = 'active'
  ) > 32 THEN
    RAISE EXCEPTION 'a collectible may expose at most 32 active names' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "global_collectible_name_aliases_limit_guard"
  AFTER INSERT OR UPDATE ON "global_collectible_name_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_collectible_name_limit"();

CREATE FUNCTION "packscout_enforce_correlation_close_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.valid_to_event_sequence IS NOT NULL
     OR NEW.valid_to_event_sequence IS NULL
     OR OLD.valid_to IS NOT NULL
     OR NEW.valid_to IS NULL
     OR (to_jsonb(NEW) - 'valid_to_event_sequence' - 'valid_to' - 'row_version' - 'updated_at')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'valid_to_event_sequence' - 'valid_to' - 'row_version' - 'updated_at') THEN
    RAISE EXCEPTION '% history permits only one CAS-protected close', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_category_correlations_close_only"
  BEFORE UPDATE ON "provider_category_correlations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_correlation_close_only"();
CREATE TRIGGER "provider_collectible_correlations_close_only"
  BEFORE UPDATE ON "provider_collectible_correlations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_correlation_close_only"();

-- Commit-ordered ledgers reconcile allocated ranges with their immutable rows.
CREATE FUNCTION "packscout_guard_catalog_ledger_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.singleton_key IS DISTINCT FROM OLD.singleton_key
     OR NEW.last_sequence < OLD.last_sequence THEN
    RAISE EXCEPTION 'catalog ledger is singleton and monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_sequence = OLD.last_sequence THEN
    IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION 'catalog ledger no-op must not change updated_at' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'catalog ledger allocation must advance updated_at' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "catalog_ledger_monotonic_guard"
  BEFORE UPDATE ON "catalog_ledger"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_catalog_ledger_update"();
CREATE TRIGGER "catalog_ledger_no_delete"
  BEFORE DELETE ON "catalog_ledger"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();

CREATE FUNCTION "packscout_validate_catalog_sequence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allocated bigint;
BEGIN
  SELECT last_sequence INTO allocated FROM "catalog_ledger" WHERE singleton_key;
  IF allocated IS NULL THEN
    RAISE EXCEPTION 'catalog ledger singleton is missing' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence > allocated THEN
    RAISE EXCEPTION 'catalog history sequence exceeds its allocated ledger range' USING ERRCODE = '23514';
  END IF;
  IF (
    TG_TABLE_NAME = 'catalog_decision_events'
    AND EXISTS (SELECT 1 FROM "catalog_promotion_changes" WHERE sequence = NEW.sequence)
  ) OR (
    TG_TABLE_NAME = 'catalog_promotion_changes'
    AND EXISTS (SELECT 1 FROM "catalog_decision_events" WHERE sequence = NEW.sequence)
  ) THEN
    RAISE EXCEPTION 'catalog ledger sequence cannot identify multiple history rows' USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_validate_catalog_ledger_range"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count bigint := NEW.last_sequence - OLD.last_sequence;
  used_count bigint;
  distinct_count bigint;
  used_min bigint;
  used_max bigint;
BEGIN
  IF expected_count = 0 THEN
    RETURN NULL;
  END IF;
  SELECT count(*), count(DISTINCT sequence), min(sequence), max(sequence)
  INTO used_count, distinct_count, used_min, used_max
  FROM (
    SELECT sequence
    FROM "catalog_decision_events"
    WHERE sequence > OLD.last_sequence AND sequence <= NEW.last_sequence
    UNION ALL
    SELECT sequence
    FROM "catalog_promotion_changes"
    WHERE sequence > OLD.last_sequence AND sequence <= NEW.last_sequence
  ) used;
  IF used_count <> expected_count
     OR distinct_count <> expected_count
     OR used_min <> OLD.last_sequence + 1
     OR used_max <> NEW.last_sequence THEN
    RAISE EXCEPTION 'catalog ledger allocation must be contiguous and fully materialized' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "catalog_ledger_reconciliation_guard"
  AFTER UPDATE ON "catalog_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_ledger_range"();
CREATE CONSTRAINT TRIGGER "catalog_decision_events_ledger_guard"
  AFTER INSERT ON "catalog_decision_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_sequence"();
CREATE CONSTRAINT TRIGGER "catalog_promotion_changes_ledger_guard"
  AFTER INSERT ON "catalog_promotion_changes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_sequence"();

CREATE FUNCTION "packscout_guard_invalidation_ledger_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.singleton_key IS DISTINCT FROM OLD.singleton_key
     OR NEW.last_sequence < OLD.last_sequence THEN
    RAISE EXCEPTION 'provider invalidation ledger is singleton and monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_sequence = OLD.last_sequence THEN
    IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION 'provider invalidation ledger no-op must not change updated_at' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'provider invalidation allocation must advance updated_at' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_release_invalidation_ledger_monotonic_guard"
  BEFORE UPDATE ON "provider_release_invalidation_ledger"
  FOR EACH ROW EXECUTE FUNCTION "packscout_guard_invalidation_ledger_update"();
CREATE TRIGGER "provider_release_invalidation_ledger_no_delete"
  BEFORE DELETE ON "provider_release_invalidation_ledger"
  FOR EACH ROW EXECUTE FUNCTION "packscout_reject_delete"();

CREATE FUNCTION "packscout_validate_invalidation_sequence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allocated bigint;
BEGIN
  SELECT last_sequence INTO allocated
  FROM "provider_release_invalidation_ledger"
  WHERE singleton_key;
  IF allocated IS NULL THEN
    RAISE EXCEPTION 'provider invalidation ledger singleton is missing' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence > allocated THEN
    RAISE EXCEPTION 'provider invalidation sequence exceeds its allocated ledger range' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "packscout_validate_invalidation_ledger_range"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count bigint := NEW.last_sequence - OLD.last_sequence;
  used_count bigint;
  used_min bigint;
  used_max bigint;
BEGIN
  IF expected_count = 0 THEN
    RETURN NULL;
  END IF;
  SELECT count(*), min(sequence), max(sequence)
  INTO used_count, used_min, used_max
  FROM "provider_release_invalidations"
  WHERE sequence > OLD.last_sequence AND sequence <= NEW.last_sequence;
  IF used_count <> expected_count
     OR used_min <> OLD.last_sequence + 1
     OR used_max <> NEW.last_sequence THEN
    RAISE EXCEPTION 'provider invalidation allocation must be contiguous and fully materialized' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "provider_release_invalidation_ledger_reconciliation_guard"
  AFTER UPDATE ON "provider_release_invalidation_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_invalidation_ledger_range"();
CREATE CONSTRAINT TRIGGER "provider_release_invalidations_ledger_guard"
  AFTER INSERT ON "provider_release_invalidations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_invalidation_sequence"();

CREATE FUNCTION "packscout_require_catalog_promotion"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_type_value text := TG_ARGV[0];
  entity_id_value uuid;
  entity_version_value bigint;
  provider_value uuid;
  operation_value promotion_operation := 'upsert';
  state_value text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'row_version' - 'updated_at') = (to_jsonb(OLD) - 'row_version' - 'updated_at') THEN
    RETURN NULL;
  END IF;
  entity_id_value := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  entity_version_value := (to_jsonb(NEW) ->> TG_ARGV[2])::bigint;
  IF array_length(TG_ARGV, 1) >= 4 AND TG_ARGV[3] <> '' THEN
    state_value := to_jsonb(NEW) ->> TG_ARGV[3];
    IF state_value IN ('retired') OR state_value IS NOT NULL AND TG_ARGV[3] = 'valid_to_event_sequence' THEN
      operation_value := 'retire';
    END IF;
  END IF;
  IF array_length(TG_ARGV, 1) >= 5 AND TG_ARGV[4] <> '' THEN
    provider_value := NULLIF(to_jsonb(NEW) ->> TG_ARGV[4], '')::uuid;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "catalog_promotion_changes" change
    WHERE change.entity_type = entity_type_value
      AND change.entity_id = entity_id_value
      AND change.entity_version = entity_version_value
      AND change.operation = operation_value
      AND (provider_value IS NULL OR change.provider_id = provider_value)
  ) THEN
    RAISE EXCEPTION 'canonical material change lacks its catalog promotion row' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "global_categories_promotion_guard"
  AFTER INSERT OR UPDATE ON "global_categories"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_catalog_promotion"('global_category', 'id', 'row_version', 'lifecycle', '');
CREATE CONSTRAINT TRIGGER "global_collectibles_promotion_guard"
  AFTER INSERT OR UPDATE ON "global_collectibles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_catalog_promotion"('global_collectible', 'id', 'row_version', 'identity_state', '');
CREATE CONSTRAINT TRIGGER "global_collectible_categories_promotion_guard"
  AFTER INSERT OR UPDATE ON "global_collectible_categories"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_catalog_promotion"('global_collectible_category', 'id', 'row_version', 'lifecycle', '');
CREATE CONSTRAINT TRIGGER "global_collectible_name_aliases_promotion_guard"
  AFTER INSERT OR UPDATE ON "global_collectible_name_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_catalog_promotion"('global_collectible_name_alias', 'id', 'row_version', 'lifecycle', '');
CREATE CONSTRAINT TRIGGER "provider_category_correlations_promotion_guard"
  AFTER INSERT OR UPDATE ON "provider_category_correlations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_catalog_promotion"('provider_category_correlation', 'id', 'correlation_version', 'valid_to_event_sequence', 'provider_id');
CREATE CONSTRAINT TRIGGER "provider_collectible_correlations_promotion_guard"
  AFTER INSERT OR UPDATE ON "provider_collectible_correlations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_catalog_promotion"('provider_collectible_correlation', 'id', 'correlation_version', 'valid_to_event_sequence', 'provider_id');

CREATE FUNCTION "packscout_require_collectible_alias_promotion"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "catalog_promotion_changes" change
    WHERE change.entity_type = 'collectible_alias'
      AND change.entity_id = NEW.alias_collectible_id
      AND change.entity_version = 1
      AND change.operation = 'upsert'
      AND change.decision_event_sequence = NEW.decision_event_sequence
  ) THEN
    RAISE EXCEPTION 'collectible alias lacks its catalog promotion row' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "collectible_aliases_promotion_guard"
  AFTER INSERT ON "collectible_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_collectible_alias_promotion"();

CREATE FUNCTION "packscout_require_correlation_invalidation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "provider_release_invalidations" invalidation
    WHERE invalidation.provider_id = NEW.provider_id
      AND invalidation.catalog_change_sequence = NEW.sequence
  ) THEN
    RAISE EXCEPTION 'provider-scoped catalog change lacks a release invalidation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "catalog_promotion_changes_invalidation_guard"
  AFTER INSERT ON "catalog_promotion_changes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_correlation_invalidation"();

CREATE FUNCTION "packscout_require_active_profile_invalidation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cause_profile uuid;
BEGIN
  IF NEW.active_public_profile_version_id IS NOT DISTINCT FROM OLD.active_public_profile_version_id THEN
    RETURN NULL;
  END IF;
  cause_profile := coalesce(NEW.active_public_profile_version_id, OLD.active_public_profile_version_id);
  IF cause_profile IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "provider_release_invalidations" invalidation
    WHERE invalidation.provider_id = NEW.id
      AND invalidation.public_profile_version_id = cause_profile
  ) THEN
    RAISE EXCEPTION 'active public-profile change lacks a release invalidation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "providers_active_profile_invalidation_guard"
  AFTER UPDATE OF "active_public_profile_version_id" ON "providers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_active_profile_invalidation"();

-- Controlled forward-only state transitions and immutable request evidence.
CREATE FUNCTION "packscout_enforce_publication_operation_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_identity jsonb;
  new_identity jsonb;
  current_fence bigint;
  current_owner text;
  current_expiration timestamptz;
  current_manifest_id text;
BEGIN
  IF TG_TABLE_NAME = 'catalog_publication_operations' THEN
    old_identity := to_jsonb(OLD) - 'state' - 'convex_receipt_id' - 'receipt_hash' - 'receipt' - 'failure_code' - 'completed_at';
    new_identity := to_jsonb(NEW) - 'state' - 'convex_receipt_id' - 'receipt_hash' - 'receipt' - 'failure_code' - 'completed_at';
  ELSE
    old_identity := to_jsonb(OLD) - 'state' - 'convex_receipt_id' - 'receipt_hash' - 'receipt' - 'completed_at';
    new_identity := to_jsonb(NEW) - 'state' - 'convex_receipt_id' - 'receipt_hash' - 'receipt' - 'completed_at';
  END IF;
  IF old_identity IS DISTINCT FROM new_identity THEN
    RAISE EXCEPTION '% operation identity and request are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('accepted', 'failed') THEN
    RAISE EXCEPTION '% terminal operation is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF NEW.state = OLD.state THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION '% operation state must advance when evidence changes', TG_TABLE_NAME USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Serialize terminal evidence with the coordination row and reject any
  -- worker whose operation was created under an older lease generation.
  IF TG_TABLE_NAME = 'catalog_publication_operations' THEN
    SELECT lease_fence, lease_owner, lease_expires_at
    INTO current_fence, current_owner, current_expiration
    FROM "catalog_consumer_checkpoints"
    WHERE consumer_key = 'catalog_publication'
    FOR UPDATE;
  ELSE
    SELECT lease_fence, lease_owner, lease_expires_at, active_manifest_id
    INTO current_fence, current_owner, current_expiration, current_manifest_id
    FROM "manifest_activation_state"
    WHERE singleton_key
    FOR UPDATE;
  END IF;
  IF current_fence IS NULL
     OR current_fence <> NEW.lease_fence
     OR current_owner IS NULL
     OR current_expiration IS NULL
     OR current_expiration <= statement_timestamp() THEN
    RAISE EXCEPTION '% operation cannot advance under a stale or inactive lease fence', TG_TABLE_NAME
      USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('accepted', 'ambiguous', 'failed'))
    OR (OLD.state = 'ambiguous' AND NEW.state IN ('accepted', 'failed'))
  ) THEN
    RAISE EXCEPTION '% operation transition % -> % is not allowed', TG_TABLE_NAME, OLD.state, NEW.state
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'accepted' AND TG_TABLE_NAME = 'catalog_publication_operations' THEN
    IF NEW.operation_kind = 'batch' AND NOT EXISTS (
      SELECT 1
      FROM "catalog_version_batches" batch
      WHERE batch.catalog_version_id = NEW.catalog_version_id
        AND batch.batch_index = NEW.batch_index
        AND batch.body_hash = NEW.body_hash
    ) THEN
      RAISE EXCEPTION 'accepted catalog batch receipt does not identify an exact local batch'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'accepted' AND TG_TABLE_NAME = 'manifest_activation_operations' THEN
    IF NEW.expected_manifest_id IS DISTINCT FROM current_manifest_id THEN
      RAISE EXCEPTION 'accepted manifest operation does not match the active manifest predecessor'
        USING ERRCODE = '40001';
    END IF;
    IF NEW.target_catalog_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM "catalog_versions" version
      WHERE version.id = NEW.target_catalog_version_id
        AND version.lifecycle = 'complete'
    ) THEN
      RAISE EXCEPTION 'accepted manifest operation requires a complete local catalog version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "catalog_publication_operations_one_way"
  BEFORE UPDATE ON "catalog_publication_operations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_publication_operation_transition"();
CREATE TRIGGER "manifest_activation_operations_one_way"
  BEFORE UPDATE ON "manifest_activation_operations"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_publication_operation_transition"();

CREATE FUNCTION "packscout_enforce_catalog_version_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle IN ('complete', 'failed') THEN
    RAISE EXCEPTION 'terminal catalog version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.lifecycle <> 'building' AND (
    to_jsonb(NEW) - 'lifecycle' - 'completed_at'
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - 'lifecycle' - 'completed_at'
  ) THEN
    RAISE EXCEPTION 'catalog descriptor is immutable after assembly' USING ERRCODE = '55000';
  END IF;
  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT (
    (OLD.lifecycle = 'building' AND NEW.lifecycle IN ('assembled', 'failed'))
    OR (OLD.lifecycle = 'assembled' AND NEW.lifecycle IN ('publishing', 'blocked', 'failed'))
    OR (OLD.lifecycle = 'publishing' AND NEW.lifecycle IN ('complete', 'blocked', 'failed'))
    OR (OLD.lifecycle = 'blocked' AND NEW.lifecycle IN ('publishing', 'complete', 'failed'))
  ) THEN
    RAISE EXCEPTION 'catalog lifecycle transition % -> % is not allowed', OLD.lifecycle, NEW.lifecycle
      USING ERRCODE = '55000';
  END IF;
  IF NEW.lifecycle = OLD.lifecycle AND OLD.lifecycle <> 'building'
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'assembled catalog version may change only by lifecycle transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "catalog_versions_one_way"
  BEFORE UPDATE ON "catalog_versions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_catalog_version_transition"();

CREATE FUNCTION "packscout_validate_catalog_version_completion"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lifecycle <> 'complete' THEN
    RETURN NULL;
  END IF;
  IF NOT "packscout_has_exact_catalog_completion_receipt"(
    NULL,
    NEW.id,
    NEW.through_change_sequence
  ) THEN
    RAISE EXCEPTION 'catalog completion requires an accepted finalize or reuse receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "catalog_versions_completion_receipt_guard"
  AFTER INSERT OR UPDATE ON "catalog_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_version_completion"();

CREATE FUNCTION "packscout_require_building_catalog_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "catalog_versions" version
    WHERE version.id = NEW.catalog_version_id AND version.lifecycle = 'building'
  ) THEN
    RAISE EXCEPTION 'catalog batches may be inserted only while the version is building' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "catalog_version_batches_building_guard"
  BEFORE INSERT ON "catalog_version_batches"
  FOR EACH ROW EXECUTE FUNCTION "packscout_require_building_catalog_version"();

CREATE FUNCTION "packscout_validate_catalog_version_batches"(version_value uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  version_row "catalog_versions"%ROWTYPE;
  category_records bigint;
  collectible_records bigint;
  alias_records bigint;
  batch_kind_count bigint;
BEGIN
  SELECT * INTO version_row FROM "catalog_versions" WHERE id = version_value;
  IF NOT FOUND OR version_row.lifecycle = 'building' OR version_row.lifecycle = 'failed' THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(record_count) FILTER (WHERE batch_kind = 'categories'), 0),
         coalesce(sum(record_count) FILTER (WHERE batch_kind = 'collectibles'), 0),
         coalesce(sum(record_count) FILTER (WHERE batch_kind = 'aliases'), 0),
         count(DISTINCT batch_kind)
  INTO category_records, collectible_records, alias_records, batch_kind_count
  FROM "catalog_version_batches"
  WHERE catalog_version_id = version_value;
  IF batch_kind_count <> 3
     OR category_records <> version_row.category_count
     OR collectible_records <> version_row.collectible_count
     OR alias_records <> version_row.alias_count THEN
    RAISE EXCEPTION 'catalog batches must include every required kind and match the assembled descriptor counts' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "catalog_version_batches"
    WHERE catalog_version_id = version_value
    GROUP BY batch_kind
    HAVING min(batch_index) <> 0 OR max(batch_index) + 1 <> count(*)
  ) THEN
    RAISE EXCEPTION 'catalog batch indexes must be contiguous from zero for each kind' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "catalog_version_batches"
    WHERE catalog_version_id = version_value
      AND jsonb_array_length(payload) <> record_count
  ) THEN
    RAISE EXCEPTION 'catalog batch record count must match its stored payload' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "packscout_validate_catalog_version_batches_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_value uuid;
BEGIN
  IF TG_TABLE_NAME = 'catalog_versions' THEN
    version_value := NEW.id;
  ELSE
    version_value := NEW.catalog_version_id;
  END IF;
  PERFORM "packscout_validate_catalog_version_batches"(version_value);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "catalog_versions_batch_reconciliation_guard"
  AFTER INSERT OR UPDATE ON "catalog_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_version_batches_trigger"();
CREATE CONSTRAINT TRIGGER "catalog_version_batches_reconciliation_guard"
  AFTER INSERT ON "catalog_version_batches"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "packscout_validate_catalog_version_batches_trigger"();

CREATE FUNCTION "packscout_enforce_retention_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'running' OR NEW.state NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'retention execution permits only running -> terminal' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.cutoff_at, NEW.batch_size, NEW.started_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.cutoff_at, OLD.batch_size, OLD.started_at, OLD.created_at) THEN
    RAISE EXCEPTION 'retention execution identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "artifact_retention_executions_one_way"
  BEFORE UPDATE ON "artifact_retention_executions"
  FOR EACH ROW EXECUTE FUNCTION "packscout_enforce_retention_transition"();

-- Required singleton/control rows for a fresh central authority.
INSERT INTO "database_identity" (
  "singleton_key", "database_role", "schema_version", "provider_id", "provider_key", "created_at"
) VALUES (
  true, 'central', 'distributed-central-v1', NULL, NULL, now()
);

INSERT INTO "catalog_ledger" ("singleton_key", "last_sequence", "updated_at")
VALUES (true, 0, now());

INSERT INTO "provider_release_invalidation_ledger" ("singleton_key", "last_sequence", "updated_at")
VALUES (true, 0, now());

INSERT INTO "catalog_consumer_checkpoints" (
  "consumer_key", "last_confirmed_sequence", "confirmation_id", "lease_owner",
  "lease_fence", "lease_expires_at", "row_version", "created_at", "updated_at"
) VALUES (
  'catalog_publication', 0, NULL, NULL, 0, NULL, 1, now(), now()
);

INSERT INTO "manifest_activation_state" (
  "singleton_key", "active_manifest_id", "active_manifest_fingerprint",
  "previous_manifest_id", "previous_manifest_fingerprint", "lease_owner",
  "lease_fence", "lease_expires_at", "last_receipt_id", "row_version", "updated_at"
) VALUES (
  true, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, 1, now()
);
