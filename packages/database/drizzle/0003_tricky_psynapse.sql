CREATE TYPE "public"."quarantine_attempt_state" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."canonical_record_kind" ADD VALUE 'ev_input' BEFORE 'pull';--> statement-breakpoint
CREATE TABLE "quarantine_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"quarantine_id" uuid NOT NULL,
	"source_record_id" uuid,
	"state" "quarantine_attempt_state" DEFAULT 'running' NOT NULL,
	"requested_by_actor_key" text NOT NULL,
	"failure_code" text,
	"field_path" text,
	"sanitized_summary" text,
	"canonical_revision_count" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "quarantine_attempts_actor_key_bounded" CHECK (length("quarantine_attempts"."requested_by_actor_key") between 1 and 256),
	CONSTRAINT "quarantine_attempts_failure_bounded" CHECK (("quarantine_attempts"."failure_code" is null or length("quarantine_attempts"."failure_code") <= 128) and ("quarantine_attempts"."field_path" is null or length("quarantine_attempts"."field_path") <= 256) and ("quarantine_attempts"."sanitized_summary" is null or length("quarantine_attempts"."sanitized_summary") <= 500)),
	CONSTRAINT "quarantine_attempts_revision_count_nonnegative" CHECK ("quarantine_attempts"."canonical_revision_count" is null or "quarantine_attempts"."canonical_revision_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_health_states" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_head_reached_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"latest_failure_code" text,
	"recovered_at" timestamp with time zone,
	"latest_mapping_warning_at" timestamp with time zone,
	"mapping_warning_severity" text,
	"mapping_warning_active" boolean DEFAULT false NOT NULL,
	"latest_calculation_warning_at" timestamp with time zone,
	"calculation_warning_severity" text,
	"calculation_warning_active" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_health_states_provider_tenant_unique" UNIQUE("provider_id","organization_id"),
	CONSTRAINT "provider_health_states_failure_count_nonnegative" CHECK ("provider_health_states"."consecutive_failures" >= 0),
	CONSTRAINT "provider_health_states_failure_code_bounded" CHECK ("provider_health_states"."latest_failure_code" is null or length("provider_health_states"."latest_failure_code") between 1 and 128),
	CONSTRAINT "provider_health_states_mapping_severity_known" CHECK ("provider_health_states"."mapping_warning_severity" is null or "provider_health_states"."mapping_warning_severity" in ('warning', 'degraded')),
	CONSTRAINT "provider_health_states_mapping_active_complete" CHECK (not "provider_health_states"."mapping_warning_active" or ("provider_health_states"."latest_mapping_warning_at" is not null and "provider_health_states"."mapping_warning_severity" is not null)),
	CONSTRAINT "provider_health_states_calculation_severity_known" CHECK ("provider_health_states"."calculation_warning_severity" is null or "provider_health_states"."calculation_warning_severity" in ('warning', 'degraded')),
	CONSTRAINT "provider_health_states_calculation_active_complete" CHECK (not "provider_health_states"."calculation_warning_active" or ("provider_health_states"."latest_calculation_warning_at" is not null and "provider_health_states"."calculation_warning_severity" is not null))
);
--> statement-breakpoint
CREATE TABLE "provider_schedules" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"last_claimed_at" timestamp with time zone,
	"last_outcome" text,
	"last_run_id" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_schedules_provider_tenant_revision_unique" UNIQUE("provider_id","organization_id","config_revision_id"),
	CONSTRAINT "provider_schedules_claim_pair" CHECK (("provider_schedules"."claim_owner" is null) = ("provider_schedules"."claim_expires_at" is null)),
	CONSTRAINT "provider_schedules_claim_owner_bounded" CHECK ("provider_schedules"."claim_owner" is null or length("provider_schedules"."claim_owner") between 1 and 256),
	CONSTRAINT "provider_schedules_outcome_known" CHECK ("provider_schedules"."last_outcome" is null or "provider_schedules"."last_outcome" in ('started', 'coalesced', 'not_enabled'))
);
--> statement-breakpoint
ALTER TABLE "quarantine_attempts" ADD CONSTRAINT "quarantine_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_attempts" ADD CONSTRAINT "quarantine_attempts_quarantine_id_quarantine_records_id_fk" FOREIGN KEY ("quarantine_id") REFERENCES "public"."quarantine_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_attempts" ADD CONSTRAINT "quarantine_attempts_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_health_states" ADD CONSTRAINT "provider_health_states_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_health_states" ADD CONSTRAINT "provider_health_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_health_states" ADD CONSTRAINT "provider_health_states_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_config_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_last_run_id_import_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_revision_tenant_fk" FOREIGN KEY ("config_revision_id","provider_id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD CONSTRAINT "provider_schedules_last_run_tenant_fk" FOREIGN KEY ("last_run_id","organization_id","provider_id") REFERENCES "public"."import_runs"("id","organization_id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quarantine_attempts_one_running_unique" ON "quarantine_attempts" USING btree ("quarantine_id") WHERE "quarantine_attempts"."state" = 'running';--> statement-breakpoint
CREATE INDEX "quarantine_attempts_organization_quarantine_started_idx" ON "quarantine_attempts" USING btree ("organization_id","quarantine_id","started_at");--> statement-breakpoint
CREATE INDEX "provider_schedules_due_idx" ON "provider_schedules" USING btree ("organization_id","next_due_at");