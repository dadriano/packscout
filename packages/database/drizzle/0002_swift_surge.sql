DROP INDEX "source_record_outcomes_page_kind_external_unique";--> statement-breakpoint
ALTER TABLE "import_runs" ALTER COLUMN "counters_json" SET DEFAULT '{"accepted":0,"duplicate":0,"quarantined":0,"pages":0,"records":0,"requestAttempts":0,"transientRetries":0}'::jsonb;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "requested_by_actor_key" text;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "reached_provider_head" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "import_runs" SET "requested_by_actor_key" = 'system:migration-unknown-actor' WHERE "trigger" = 'manual' AND "requested_by_actor_key" IS NULL;--> statement-breakpoint
UPDATE "import_runs" SET "counters_json" = "counters_json" || '{"requestAttempts":0,"transientRetries":0}'::jsonb;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD COLUMN "page_id" uuid;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD COLUMN "record_index" integer;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD COLUMN "record_index" integer;--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (PARTITION BY "page_id", "record_kind" ORDER BY "id") - 1 AS ordinal
	FROM "source_record_outcomes"
)
UPDATE "source_record_outcomes" AS outcomes SET "record_index" = ranked.ordinal
FROM ranked WHERE outcomes."id" = ranked."id";--> statement-breakpoint
UPDATE "quarantine_records" AS quarantine
SET ("page_id", "run_id") = (
	SELECT page."id", page."run_id"
	FROM "import_pages" AS page
	WHERE page."organization_id" = quarantine."organization_id"
		AND page."provider_id" = quarantine."provider_id"
	ORDER BY abs(extract(epoch FROM (page."committed_at" - quarantine."created_at"))), page."id"
	LIMIT 1
);--> statement-breakpoint
WITH ranked AS (
	SELECT quarantine."id",
		row_number() OVER (PARTITION BY quarantine."page_id", quarantine."record_kind" ORDER BY quarantine."created_at", quarantine."id") - 1
		+ coalesce((
			SELECT max(outcomes."record_index") + 1
			FROM "source_record_outcomes" AS outcomes
			WHERE outcomes."page_id" = quarantine."page_id"
				AND outcomes."record_kind" = quarantine."record_kind"
		), 0) AS ordinal
	FROM "quarantine_records" AS quarantine
)
UPDATE "quarantine_records" AS quarantine SET "record_index" = ranked.ordinal
FROM ranked WHERE quarantine."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "quarantine_records" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quarantine_records" ALTER COLUMN "page_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quarantine_records" ALTER COLUMN "record_index" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ALTER COLUMN "record_index" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_page_id_import_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."import_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_page_run_tenant_fk" FOREIGN KEY ("page_id","organization_id","run_id") REFERENCES "public"."import_pages"("id","organization_id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (PARTITION BY "organization_id", "provider_id" ORDER BY "created_at" DESC, "id" DESC) AS position
	FROM "import_runs"
	WHERE "state" IN ('queued', 'running')
)
UPDATE "import_runs" AS runs
SET "state" = 'incomplete',
	"finished_at" = coalesce(runs."finished_at", now()),
	"failure_code" = 'IMPORT_MIGRATION_COALESCED',
	"failure_summary" = 'Historical overlapping run was closed while enabling exclusive provider imports.',
	"lease_owner" = NULL,
	"lease_expires_at" = NULL
FROM ranked WHERE runs."id" = ranked."id" AND ranked.position > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_provider_active_unique" ON "import_runs" USING btree ("organization_id","provider_id") WHERE "import_runs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "quarantine_records_page_kind_index_unique" ON "quarantine_records" USING btree ("page_id","record_kind","record_index");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_outcomes_page_kind_index_unique" ON "source_record_outcomes" USING btree ("page_id","record_kind","record_index");--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_manual_actor_required" CHECK ("import_runs"."trigger" <> 'manual' or "import_runs"."requested_by_actor_key" is not null);--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_attempt_nonnegative" CHECK ("import_runs"."attempt" >= 0);--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_failure_bounded" CHECK (("import_runs"."failure_code" is null or length("import_runs"."failure_code") <= 128) and ("import_runs"."failure_summary" is null or length("import_runs"."failure_summary") <= 500));--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_lease_owner_bounded" CHECK ("import_runs"."lease_owner" is null or length("import_runs"."lease_owner") <= 256);--> statement-breakpoint
ALTER TABLE "quarantine_records" ADD CONSTRAINT "quarantine_records_record_index_nonnegative" CHECK ("quarantine_records"."record_index" >= 0);--> statement-breakpoint
ALTER TABLE "source_record_outcomes" ADD CONSTRAINT "source_record_outcomes_record_index_nonnegative" CHECK ("source_record_outcomes"."record_index" >= 0);
