CREATE TYPE "public"."admin_alert_state" AS ENUM('active', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."operational_event_kind" AS ENUM('run_failed', 'run_incomplete', 'provider_stale', 'provider_recovered', 'quarantine_resolved', 'quarantine_expired', 'retention_failed', 'retention_recovered');--> statement-breakpoint
CREATE TYPE "public"."operational_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."retention_execution_state" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"latest_event_id" uuid NOT NULL,
	"kind" "operational_event_kind" NOT NULL,
	"severity" "operational_severity" NOT NULL,
	"state" "admin_alert_state" DEFAULT 'active' NOT NULL,
	"dedupe_key" text NOT NULL,
	"recovery_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"provider_id" uuid,
	"run_id" uuid,
	"quarantine_id" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"acknowledged_by_actor_key" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_by_actor_key" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "admin_alerts_counts_positive" CHECK ("admin_alerts"."occurrence_count" > 0 and "admin_alerts"."reopened_count" >= 0),
	CONSTRAINT "admin_alerts_copy_bounded" CHECK (length("admin_alerts"."dedupe_key") between 1 and 256 and length("admin_alerts"."recovery_key") between 1 and 256 and length("admin_alerts"."title") between 1 and 160 and length("admin_alerts"."summary") between 1 and 500),
	CONSTRAINT "admin_alerts_acknowledgement_pair" CHECK (("admin_alerts"."acknowledged_by_actor_key" is null) = ("admin_alerts"."acknowledged_at" is null)),
	CONSTRAINT "admin_alerts_resolution_pair" CHECK (("admin_alerts"."resolved_by_actor_key" is null) = ("admin_alerts"."resolved_at" is null)),
	CONSTRAINT "admin_alerts_run_provider_required" CHECK ("admin_alerts"."run_id" is null or "admin_alerts"."provider_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "operational_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "operational_event_kind" NOT NULL,
	"severity" "operational_severity" NOT NULL,
	"provider_id" uuid,
	"run_id" uuid,
	"quarantine_id" uuid,
	"dedupe_key" text NOT NULL,
	"recovery_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operational_events_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "operational_events_copy_bounded" CHECK (length("operational_events"."dedupe_key") between 1 and 256 and length("operational_events"."recovery_key") between 1 and 256 and length("operational_events"."title") between 1 and 160 and length("operational_events"."summary") between 1 and 500),
	CONSTRAINT "operational_events_run_provider_required" CHECK ("operational_events"."run_id" is null or "operational_events"."provider_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "retention_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"state" "retention_execution_state" DEFAULT 'running' NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"batch_size" integer NOT NULL,
	"selected_count" integer DEFAULT 0 NOT NULL,
	"expired_count" integer DEFAULT 0 NOT NULL,
	"already_expired_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"remaining_count" integer DEFAULT 0 NOT NULL,
	"pages_expired_count" integer DEFAULT 0 NOT NULL,
	"source_records_expired_count" integer DEFAULT 0 NOT NULL,
	"quarantines_expired_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"sanitized_summary" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "retention_executions_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "retention_executions_batch_size_bounded" CHECK ("retention_executions"."batch_size" between 1 and 10000),
	CONSTRAINT "retention_executions_counts_nonnegative" CHECK ("retention_executions"."selected_count" >= 0 and "retention_executions"."expired_count" >= 0 and "retention_executions"."already_expired_count" >= 0 and "retention_executions"."failed_count" >= 0 and "retention_executions"."remaining_count" >= 0 and "retention_executions"."pages_expired_count" >= 0 and "retention_executions"."source_records_expired_count" >= 0 and "retention_executions"."quarantines_expired_count" >= 0),
	CONSTRAINT "retention_executions_failure_bounded" CHECK (("retention_executions"."failure_code" is null or length("retention_executions"."failure_code") between 1 and 128) and ("retention_executions"."sanitized_summary" is null or length("retention_executions"."sanitized_summary") between 1 and 500))
);
--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_latest_event_id_operational_events_id_fk" FOREIGN KEY ("latest_event_id") REFERENCES "public"."operational_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_quarantine_id_quarantine_records_id_fk" FOREIGN KEY ("quarantine_id") REFERENCES "public"."quarantine_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_latest_event_tenant_fk" FOREIGN KEY ("latest_event_id","organization_id") REFERENCES "public"."operational_events"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_run_tenant_fk" FOREIGN KEY ("run_id","organization_id","provider_id") REFERENCES "public"."import_runs"("id","organization_id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_quarantine_tenant_fk" FOREIGN KEY ("quarantine_id","organization_id") REFERENCES "public"."quarantine_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_quarantine_id_quarantine_records_id_fk" FOREIGN KEY ("quarantine_id") REFERENCES "public"."quarantine_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_run_tenant_fk" FOREIGN KEY ("run_id","organization_id","provider_id") REFERENCES "public"."import_runs"("id","organization_id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_quarantine_tenant_fk" FOREIGN KEY ("quarantine_id","organization_id") REFERENCES "public"."quarantine_records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_executions" ADD CONSTRAINT "retention_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_alerts_organization_dedupe_unique" ON "admin_alerts" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "admin_alerts_organization_state_seen_idx" ON "admin_alerts" USING btree ("organization_id","state","last_seen_at");--> statement-breakpoint
CREATE INDEX "operational_events_organization_occurred_idx" ON "operational_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "operational_events_organization_dedupe_idx" ON "operational_events" USING btree ("organization_id","dedupe_key","occurred_at");--> statement-breakpoint
CREATE INDEX "retention_executions_organization_started_idx" ON "retention_executions" USING btree ("organization_id","started_at");