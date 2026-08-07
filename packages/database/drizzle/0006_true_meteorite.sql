CREATE TYPE "public"."estimated_ev_recomputation_result" AS ENUM('estimated', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."estimated_ev_recomputation_state" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "estimated_ev_recomputation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"configuration_revision_id" uuid NOT NULL,
	"platform_key" text NOT NULL,
	"pack_external_id" text NOT NULL,
	"ev_input_external_id" text NOT NULL,
	"pack_revision_id" uuid,
	"ev_input_revision_id" uuid,
	"state" "estimated_ev_recomputation_state" DEFAULT 'queued' NOT NULL,
	"result_status" "estimated_ev_recomputation_result",
	"calculation_revision_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "estimated_ev_recomputation_request_key_sha256" CHECK (length("estimated_ev_recomputation_requests"."request_key") = 64),
	CONSTRAINT "estimated_ev_recomputation_identity_not_blank" CHECK (length(trim("estimated_ev_recomputation_requests"."platform_key")) > 0 and length(trim("estimated_ev_recomputation_requests"."pack_external_id")) > 0 and length(trim("estimated_ev_recomputation_requests"."ev_input_external_id")) > 0),
	CONSTRAINT "estimated_ev_recomputation_attempt_nonnegative" CHECK ("estimated_ev_recomputation_requests"."attempt_count" >= 0),
	CONSTRAINT "estimated_ev_recomputation_claim_consistent" CHECK (("estimated_ev_recomputation_requests"."state" = 'running' and "estimated_ev_recomputation_requests"."claimed_by" is not null and "estimated_ev_recomputation_requests"."claim_token" is not null and "estimated_ev_recomputation_requests"."claim_expires_at" is not null) or ("estimated_ev_recomputation_requests"."state" <> 'running' and "estimated_ev_recomputation_requests"."claimed_by" is null and "estimated_ev_recomputation_requests"."claim_token" is null and "estimated_ev_recomputation_requests"."claim_expires_at" is null)),
	CONSTRAINT "estimated_ev_recomputation_completion_consistent" CHECK (("estimated_ev_recomputation_requests"."state" = 'completed' and "estimated_ev_recomputation_requests"."result_status" is not null and "estimated_ev_recomputation_requests"."calculation_revision_id" is not null and "estimated_ev_recomputation_requests"."completed_at" is not null) or ("estimated_ev_recomputation_requests"."state" <> 'completed' and "estimated_ev_recomputation_requests"."result_status" is null and "estimated_ev_recomputation_requests"."calculation_revision_id" is null and "estimated_ev_recomputation_requests"."completed_at" is null)),
	CONSTRAINT "estimated_ev_recomputation_failure_bounded" CHECK ("estimated_ev_recomputation_requests"."failure_code" is null or length("estimated_ev_recomputation_requests"."failure_code") <= 128),
	CONSTRAINT "estimated_ev_recomputation_claimed_by_bounded" CHECK ("estimated_ev_recomputation_requests"."claimed_by" is null or length("estimated_ev_recomputation_requests"."claimed_by") <= 256)
);
--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_requests_provider_id_provider_sources_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_requests_configuration_revision_id_provider_config_revisions_id_fk" FOREIGN KEY ("configuration_revision_id") REFERENCES "public"."provider_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_requests_pack_revision_id_canonical_revisions_id_fk" FOREIGN KEY ("pack_revision_id") REFERENCES "public"."canonical_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_requests_ev_input_revision_id_canonical_revisions_id_fk" FOREIGN KEY ("ev_input_revision_id") REFERENCES "public"."canonical_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_requests_calculation_revision_id_canonical_revisions_id_fk" FOREIGN KEY ("calculation_revision_id") REFERENCES "public"."canonical_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_provider_tenant_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."provider_sources"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_config_tenant_fk" FOREIGN KEY ("configuration_revision_id","provider_id","organization_id") REFERENCES "public"."provider_config_revisions"("id","provider_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_pack_revision_tenant_fk" FOREIGN KEY ("pack_revision_id","organization_id") REFERENCES "public"."canonical_revisions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_input_revision_tenant_fk" FOREIGN KEY ("ev_input_revision_id","organization_id") REFERENCES "public"."canonical_revisions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_ev_recomputation_requests" ADD CONSTRAINT "estimated_ev_recomputation_calculation_revision_tenant_fk" FOREIGN KEY ("calculation_revision_id","organization_id") REFERENCES "public"."canonical_revisions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estimated_ev_recomputation_request_key_unique" ON "estimated_ev_recomputation_requests" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "estimated_ev_recomputation_claim_idx" ON "estimated_ev_recomputation_requests" USING btree ("state","available_at","created_at","id");--> statement-breakpoint
CREATE INDEX "estimated_ev_recomputation_tenant_pack_idx" ON "estimated_ev_recomputation_requests" USING btree ("organization_id","platform_key","pack_external_id","created_at");