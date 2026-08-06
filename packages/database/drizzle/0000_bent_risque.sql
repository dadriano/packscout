CREATE TYPE "public"."canonical_record_kind" AS ENUM('platform', 'pack', 'catalog_asset', 'pull', 'sale', 'estimated_ev');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."provider_auth_mode" AS ENUM('none', 'bearer');--> statement-breakpoint
CREATE TYPE "public"."operator_role" AS ENUM('admin', 'data_operator');--> statement-breakpoint
CREATE TYPE "public"."operator_state" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."provider_state" AS ENUM('draft', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."import_run_state" AS ENUM('queued', 'running', 'succeeded', 'incomplete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_trigger" AS ENUM('scheduled', 'manual', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."quarantine_state" AS ENUM('open', 'resolved', 'expired');--> statement-breakpoint
CREATE TYPE "public"."source_record_kind" AS ENUM('catalog', 'pull', 'sale');--> statement-breakpoint
CREATE TYPE "public"."source_record_outcome" AS ENUM('accepted', 'duplicate', 'quarantined');--> statement-breakpoint
CREATE TABLE "canonical_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform_key" text NOT NULL,
	"record_kind" "canonical_record_kind" NOT NULL,
	"external_id" text NOT NULL,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_entities_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "canonical_entities_platform_not_blank" CHECK (length(trim("canonical_entities"."platform_key")) > 0),
	CONSTRAINT "canonical_entities_external_not_blank" CHECK (length(trim("canonical_entities"."external_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "canonical_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"relationship_kind" text NOT NULL,
	"target_platform_key" text NOT NULL,
	"target_record_kind" "canonical_record_kind" NOT NULL,
	"target_external_id" text,
	"target_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "canonical_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"source_record_id" uuid NOT NULL,
	"content_json" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"provenance_json" jsonb NOT NULL,
	"provenance_hash" text NOT NULL,
	"actor_key" text,
	"source_updated_at" timestamp with time zone NOT NULL,
	"source_collected_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_revisions_id_entity_organization_unique" UNIQUE("id","entity_id","organization_id"),
	CONSTRAINT "canonical_revisions_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "canonical_revisions_revision_positive" CHECK ("canonical_revisions"."revision_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "source_record_projection_revisions" (
	"source_record_id" uuid NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"projection_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_record_projection_revisions_projection_index_nonnegative" CHECK ("source_record_projection_revisions"."projection_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_key" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"outcome" "audit_outcome" NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_rate_limits_attempt_count_nonnegative" CHECK ("auth_rate_limits"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "operator_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"role" "operator_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_memberships_organization_operator_unique" UNIQUE("organization_id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "operator_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_sessions_expiry_order" CHECK ("operator_sessions"."idle_expires_at" <= "operator_sessions"."absolute_expires_at" and "operator_sessions"."created_at" <= "operator_sessions"."idle_expires_at")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_normalized" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"state" "operator_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_email_is_normalized" CHECK ("operators"."email_normalized" = lower(trim("operators"."email_normalized"))),
	CONSTRAINT "operators_display_name_not_blank" CHECK (length(trim("operators"."display_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "provider_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"adapter_key" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"auth_mode" "provider_auth_mode" NOT NULL,
	"schedule_seconds" integer DEFAULT 300 NOT NULL,
	"stale_after_seconds" integer DEFAULT 900 NOT NULL,
	"tested_at" timestamp with time zone,
	"tested_by_actor_key" text,
	"created_by_actor_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_config_revisions_id_provider_organization_unique" UNIQUE("id","provider_id","organization_id"),
	CONSTRAINT "provider_config_revisions_schedule_safe" CHECK ("provider_config_revisions"."schedule_seconds" >= 60),
	CONSTRAINT "provider_config_revisions_stale_positive" CHECK ("provider_config_revisions"."stale_after_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_connection_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"latency_ms" integer,
	"sanitized_code" text,
	"tested_by_actor_key" text NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_secret_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "provider_secret_versions_key_version_positive" CHECK ("provider_secret_versions"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform_key" text NOT NULL,
	"display_name" text NOT NULL,
	"state" "provider_state" DEFAULT 'draft' NOT NULL,
	"active_revision_id" uuid,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_sources_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "provider_sources_platform_key_not_blank" CHECK (length(trim("provider_sources"."platform_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "import_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"requested_cursor" text,
	"next_cursor" text,
	"has_more" boolean NOT NULL,
	"payload_json" jsonb,
	"payload_hash" text NOT NULL,
	"record_counts_json" jsonb NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"payload_expired_at" timestamp with time zone,
	CONSTRAINT "import_pages_run_cursor_unique" UNIQUE NULLS NOT DISTINCT("run_id","requested_cursor"),
	CONSTRAINT "import_pages_id_organization_provider_run_unique" UNIQUE("id","organization_id","provider_id","run_id"),
	CONSTRAINT "import_pages_id_organization_run_unique" UNIQUE("id","organization_id","run_id"),
	CONSTRAINT "import_pages_page_number_positive" CHECK ("import_pages"."page_number" > 0),
	CONSTRAINT "import_pages_cursors_bounded" CHECK (("import_pages"."requested_cursor" is null or length("import_pages"."requested_cursor") <= 2048) and ("import_pages"."next_cursor" is null or length("import_pages"."next_cursor") <= 2048))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"trigger" "import_trigger" NOT NULL,
	"state" "import_run_state" DEFAULT 'queued' NOT NULL,
	"requested_cursor" text,
	"final_cursor" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"counters_json" jsonb DEFAULT '{"accepted":0,"duplicate":0,"quarantined":0,"pages":0,"records":0}'::jsonb NOT NULL,
	"failure_code" text,
	"failure_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_id_organization_provider_config_unique" UNIQUE("id","organization_id","provider_id","config_revision_id"),
	CONSTRAINT "import_runs_id_organization_provider_unique" UNIQUE("id","organization_id","provider_id"),
	CONSTRAINT "import_runs_requested_cursor_bounded" CHECK ("import_runs"."requested_cursor" is null or length("import_runs"."requested_cursor") <= 2048),
	CONSTRAINT "import_runs_final_cursor_bounded" CHECK ("import_runs"."final_cursor" is null or length("import_runs"."final_cursor") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "provider_cursor_checkpoints" (
	"config_revision_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"cursor" text,
	"advanced_by_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_cursor_checkpoints_cursor_bounded" CHECK ("provider_cursor_checkpoints"."cursor" is null or length("provider_cursor_checkpoints"."cursor") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "quarantine_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"source_record_id" uuid,
	"record_kind" "source_record_kind" NOT NULL,
	"external_id" text,
	"state" "quarantine_state" DEFAULT 'open' NOT NULL,
	"reason_code" text NOT NULL,
	"field_path" text,
	"sanitized_summary" text NOT NULL,
	"payload_json" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_retry_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"payload_expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_record_observations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_record_observations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_record_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_record_outcomes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_record_outcomes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"source_record_id" uuid,
	"record_kind" "source_record_kind" NOT NULL,
	"external_id" text NOT NULL,
	"outcome" "source_record_outcome" NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"first_run_id" uuid NOT NULL,
	"first_page_id" uuid NOT NULL,
	"record_kind" "source_record_kind" NOT NULL,
	"external_id" text NOT NULL,
	"source_time" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"payload_json" jsonb,
	"content_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"payload_expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_records_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "source_records_external_id_not_blank" CHECK (length(trim("source_records"."external_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_current_revision_id_canonical_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."canonical_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_relationships" ADD CONSTRAINT "canonical_relationships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_relationships" ADD CONSTRAINT "canonical_relationships_source_entity_id_canonical_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."canonical_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_relationships" ADD CONSTRAINT "canonical_relationships_target_entity_id_canonical_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."canonical_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_relationships" ADD CONSTRAINT "canonical_relationships_source_tenant_fk" FOREIGN KEY ("source_entity_id","organization_id") REFERENCES "public"."canonical_entities"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_relationships" ADD CONSTRAINT "canonical_relationships_target_tenant_fk" FOREIGN KEY ("target_entity_id","organization_id") REFERENCES "public"."canonical_entities"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_revisions" ADD CONSTRAINT "canonical_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_revisions" ADD CONSTRAINT "canonical_revisions_entity_id_canonical_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."canonical_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_revisions" ADD CONSTRAINT "canonical_revisions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_revisions" ADD CONSTRAINT "canonical_revisions_entity_tenant_fk" FOREIGN KEY ("entity_id","organization_id") REFERENCES "public"."canonical_entities"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_revisions" ADD CONSTRAINT "canonical_revisions_source_tenant_fk" FOREIGN KEY ("source_record_id","organization_id") REFERENCES "public"."source_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_projection_revisions" ADD CONSTRAINT "source_record_projection_revisions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_projection_revisions" ADD CONSTRAINT "source_record_projection_revisions_canonical_revision_id_canonical_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."canonical_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_projection_revisions" ADD CONSTRAINT "source_record_projection_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_projection_revisions" ADD CONSTRAINT "source_record_projection_revisions_source_tenant_fk" FOREIGN KEY ("source_record_id","organization_id") REFERENCES "public"."source_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_projection_revisions" ADD CONSTRAINT "source_record_projection_revisions_revision_tenant_fk" FOREIGN KEY ("canonical_revision_id","organization_id") REFERENCES "public"."canonical_revisions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_memberships" ADD CONSTRAINT "operator_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_memberships" ADD CONSTRAINT "operator_memberships_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_membership_fk" FOREIGN KEY ("organization_id","operator_id") REFERENCES "public"."operator_memberships"("organization_id","operator_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_config_revisions" ADD CONSTRAINT "provider_config_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_config_revisions" ADD CONSTRAINT "provider_config_revisions_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_config_revisions" ADD CONSTRAINT "provider_config_revisions_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD CONSTRAINT "provider_connection_tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD CONSTRAINT "provider_connection_tests_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD CONSTRAINT "provider_connection_tests_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD CONSTRAINT "provider_connection_tests_revision_tenant_fk" FOREIGN KEY ("revision_id","provider_id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_versions" ADD CONSTRAINT "provider_secret_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_versions" ADD CONSTRAINT "provider_secret_versions_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_versions" ADD CONSTRAINT "provider_secret_versions_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_versions" ADD CONSTRAINT "provider_secret_versions_revision_tenant_fk" FOREIGN KEY ("revision_id","provider_id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sources" ADD CONSTRAINT "provider_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sources" ADD CONSTRAINT "provider_sources_active_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_run_tenant_fk" FOREIGN KEY ("run_id","organization_id","provider_id") REFERENCES "public"."import_runs"("id","organization_id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_config_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_config_provider_tenant_fk" FOREIGN KEY ("config_revision_id","provider_id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cursor_checkpoints" ADD CONSTRAINT "provider_cursor_checkpoints_config_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cursor_checkpoints" ADD CONSTRAINT "provider_cursor_checkpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cursor_checkpoints" ADD CONSTRAINT "provider_cursor_checkpoints_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cursor_checkpoints" ADD CONSTRAINT "provider_cursor_checkpoints_advanced_by_run_id_import_runs_id_fk" FOREIGN KEY ("advanced_by_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cursor_checkpoints" ADD CONSTRAINT "provider_cursor_checkpoints_config_tenant_fk" FOREIGN KEY ("config_revision_id","provider_id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_cursor_checkpoints" ADD CONSTRAINT "provider_cursor_checkpoints_run_tenant_fk" FOREIGN KEY ("advanced_by_run_id","organization_id","provider_id") REFERENCES "public"."import_runs"("id","organization_id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_source_tenant_fk" FOREIGN KEY ("source_record_id","organization_id") REFERENCES "public"."source_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_observations" ADD CONSTRAINT "source_record_observations_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_observations" ADD CONSTRAINT "source_record_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_observations" ADD CONSTRAINT "source_record_observations_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_observations" ADD CONSTRAINT "source_record_observations_page_id_import_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."import_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_observations" ADD CONSTRAINT "source_record_observations_source_tenant_fk" FOREIGN KEY ("source_record_id","organization_id") REFERENCES "public"."source_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_observations" ADD CONSTRAINT "source_record_observations_page_run_tenant_fk" FOREIGN KEY ("page_id","organization_id","run_id") REFERENCES "public"."import_pages"("id","organization_id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_page_id_import_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."import_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_page_run_tenant_fk" FOREIGN KEY ("page_id","organization_id","run_id") REFERENCES "public"."import_pages"("id","organization_id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_source_tenant_fk" FOREIGN KEY ("source_record_id","organization_id") REFERENCES "public"."source_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_first_run_id_import_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_first_page_id_import_pages_id_fk" FOREIGN KEY ("first_page_id") REFERENCES "public"."import_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_first_page_tenant_fk" FOREIGN KEY ("first_page_id","organization_id","provider_id","first_run_id") REFERENCES "public"."import_pages"("id","organization_id","provider_id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_entities_stable_identity_unique" ON "canonical_entities" USING btree ("organization_id","platform_key","record_kind","external_id");--> statement-breakpoint
CREATE INDEX "canonical_entities_current_revision_idx" ON "canonical_entities" USING btree ("current_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_relationships_source_kind_target_unique" ON "canonical_relationships" USING btree ("source_entity_id","relationship_kind","target_platform_key","target_record_kind","target_external_id");--> statement-breakpoint
CREATE INDEX "canonical_relationships_unresolved_lookup_idx" ON "canonical_relationships" USING btree ("organization_id","target_platform_key","target_record_kind","target_external_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_revisions_entity_number_unique" ON "canonical_revisions" USING btree ("entity_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_revisions_content_provenance_unique" ON "canonical_revisions" USING btree ("entity_id","content_hash","provenance_hash");--> statement-breakpoint
CREATE INDEX "canonical_revisions_organization_accepted_idx" ON "canonical_revisions" USING btree ("organization_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_projection_revisions_source_projection_unique" ON "source_record_projection_revisions" USING btree ("source_record_id","projection_index");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_projection_revisions_pair_unique" ON "source_record_projection_revisions" USING btree ("source_record_id","canonical_revision_id");--> statement-breakpoint
CREATE INDEX "audit_events_organization_occurred_idx" ON "audit_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "operator_memberships_operator_idx" ON "operator_memberships" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_sessions_token_hash_unique" ON "operator_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_sessions_active_token_idx" ON "operator_sessions" USING btree ("token_hash") WHERE "operator_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "operator_sessions_operator_idx" ON "operator_sessions" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_email_normalized_unique" ON "operators" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_config_revisions_provider_version_unique" ON "provider_config_revisions" USING btree ("provider_id","version");--> statement-breakpoint
CREATE INDEX "provider_connection_tests_provider_tested_idx" ON "provider_connection_tests" USING btree ("provider_id","tested_at");--> statement-breakpoint
CREATE INDEX "provider_secret_versions_provider_created_idx" ON "provider_secret_versions" USING btree ("organization_id","provider_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_sources_organization_platform_unique" ON "provider_sources" USING btree ("organization_id","platform_key");--> statement-breakpoint
CREATE UNIQUE INDEX "import_pages_run_number_unique" ON "import_pages" USING btree ("run_id","page_number");--> statement-breakpoint
CREATE INDEX "import_pages_expiry_idx" ON "import_pages" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "import_runs_organization_provider_created_idx" ON "import_runs" USING btree ("organization_id","provider_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_cursor_checkpoints_organization_provider_idx" ON "provider_cursor_checkpoints" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "quarantine_records_organization_state_idx" ON "quarantine_records" USING btree ("organization_id","state","created_at");--> statement-breakpoint
CREATE INDEX "quarantine_records_expiry_idx" ON "quarantine_records" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_observations_record_run_page_unique" ON "source_record_observations" USING btree ("source_record_id","run_id","page_id");--> statement-breakpoint
CREATE INDEX "source_record_observations_organization_run_idx" ON "source_record_observations" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_outcomes_page_kind_external_unique" ON "source_record_outcomes" USING btree ("page_id","record_kind","external_id");--> statement-breakpoint
CREATE INDEX "source_record_outcomes_organization_run_idx" ON "source_record_outcomes" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_immutable_identity_unique" ON "source_records" USING btree ("organization_id","provider_id","record_kind","external_id","source_time","content_hash");--> statement-breakpoint
CREATE INDEX "source_records_expiry_idx" ON "source_records" USING btree ("organization_id","expires_at");
--> statement-breakpoint
ALTER TABLE "provider_sources" ADD CONSTRAINT "provider_sources_active_revision_scope_fk" FOREIGN KEY ("active_revision_id","id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_current_revision_scope_fk" FOREIGN KEY ("current_revision_id","id","organization_id") REFERENCES "public"."canonical_revisions"("id","entity_id","organization_id") ON DELETE restrict ON UPDATE no action;
