ALTER TYPE "public"."provider_state" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD COLUMN "response_status" integer;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD COLUMN "record_counts_json" jsonb;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD COLUMN "has_more" boolean;--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD COLUMN "next_cursor_present" boolean;--> statement-breakpoint
ALTER TABLE "provider_secret_versions" ADD CONSTRAINT "provider_secret_versions_revision_unique" UNIQUE("revision_id");--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD CONSTRAINT "provider_connection_tests_latency_nonnegative" CHECK ("provider_connection_tests"."latency_ms" is null or "provider_connection_tests"."latency_ms" >= 0);--> statement-breakpoint
ALTER TABLE "provider_connection_tests" ADD CONSTRAINT "provider_connection_tests_response_status_valid" CHECK ("provider_connection_tests"."response_status" is null or ("provider_connection_tests"."response_status" >= 100 and "provider_connection_tests"."response_status" <= 599));