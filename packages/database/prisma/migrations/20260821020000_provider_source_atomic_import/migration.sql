-- Task 006 clean cutover: source-pinned runs and normalized pages do not carry
-- legacy provider-configuration or cursor/has_more ownership.
ALTER TABLE "import_runs"
  ALTER COLUMN "config_revision_id" DROP NOT NULL,
  ADD COLUMN "claim_lease_id" UUID,
  ADD COLUMN "current_checkpoint" BYTEA,
  ADD COLUMN "current_checkpoint_fingerprint" TEXT,
  ADD COLUMN "current_checkpoint_key" TEXT,
  ADD COLUMN "next_page_number" INTEGER;

-- requested_checkpoint* is immutable run-start provenance. The current tuple
-- is the durable page-turn intent and advances after each committed page.
UPDATE "import_runs"
SET "current_checkpoint" = "requested_checkpoint",
    "current_checkpoint_fingerprint" = "requested_checkpoint_fingerprint",
    "current_checkpoint_key" = "requested_checkpoint_key",
    "next_page_number" = 1
WHERE "source_instance_id" IS NOT NULL;

ALTER TABLE "import_runs"
  ADD CONSTRAINT "import_runs_exactly_one_runtime_owner_check"
  CHECK (
    (
      "source_instance_id" IS NULL
      AND "config_revision_id" IS NOT NULL
      AND "current_checkpoint" IS NULL
      AND "current_checkpoint_fingerprint" IS NULL
      AND "current_checkpoint_key" IS NULL
      AND "next_page_number" IS NULL
    )
    OR
    (
      "source_instance_id" IS NOT NULL
      AND "config_revision_id" IS NULL
      AND "requested_cursor" IS NULL
      AND "final_cursor" IS NULL
      AND (("current_checkpoint" IS NULL) =
        ("current_checkpoint_fingerprint" IS NULL))
      AND (
        "current_checkpoint" IS NULL
        OR octet_length("current_checkpoint") BETWEEN 1 AND 16384
      )
      AND (
        "current_checkpoint_fingerprint" IS NULL
        OR "current_checkpoint_fingerprint" ~ '^[0-9a-f]{64}$'
      )
      AND "current_checkpoint_key" =
        COALESCE("current_checkpoint_fingerprint", 'initial')
      AND "next_page_number" IS NOT NULL
      AND "next_page_number" > 0
    )
  );

-- Page attempts must remain valid historical proof after the run advances to
-- its next checkpoint. Their run FK therefore pins the immutable claim scope,
-- while admission atomically compares the attempt checkpoint to run.current_*.
CREATE UNIQUE INDEX "import_runs_source_lease_claim_unique"
ON "import_runs" (
  "id", "organization_id", "provider_id", "source_instance_id",
  "source_revision_id", "connection_profile_id", "connection_revision_id",
  "checkpoint_generation", "lease_owner", "lease_token"
);

ALTER TABLE "source_request_attempts"
  DROP CONSTRAINT "source_request_attempts_run_fk",
  ADD CONSTRAINT "source_request_attempts_run_fk"
  FOREIGN KEY (
    "run_id", "organization_id", "provider_id", "source_instance_id",
    "source_revision_id", "connection_profile_id", "connection_revision_id",
    "checkpoint_generation", "claim_owner", "claim_token"
  )
  REFERENCES "import_runs"(
    "id", "organization_id", "provider_id", "source_instance_id",
    "source_revision_id", "connection_profile_id", "connection_revision_id",
    "checkpoint_generation", "lease_owner", "lease_token"
  ) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "compact_source_request_attempts"
  DROP CONSTRAINT "compact_source_request_attempts_run_fk",
  ADD CONSTRAINT "compact_source_request_attempts_run_fk"
  FOREIGN KEY (
    "run_id", "organization_id", "provider_id", "source_instance_id",
    "source_revision_id", "connection_profile_id", "connection_revision_id",
    "checkpoint_generation", "claim_owner", "claim_token"
  )
  REFERENCES "import_runs"(
    "id", "organization_id", "provider_id", "source_instance_id",
    "source_revision_id", "connection_profile_id", "connection_revision_id",
    "checkpoint_generation", "lease_owner", "lease_token"
  ) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Compact receipts retain the safe measurements that participate in the
-- successful-capture digest after the short-lived attempt row expires.
ALTER TABLE "compact_source_request_attempts"
  ADD COLUMN "response_bytes" INTEGER,
  ADD COLUMN "duration_ms" INTEGER,
  ADD CONSTRAINT "compact_source_request_attempts_measurements_check"
  CHECK (
    ("response_bytes" IS NULL OR "response_bytes" >= 0)
    AND ("duration_ms" IS NULL OR "duration_ms" >= 0)
  );

ALTER TABLE "import_pages"
  DROP CONSTRAINT "import_pages_run_cursor_unique",
  ALTER COLUMN "has_more" DROP NOT NULL,
  ADD COLUMN "run_claim_lease_id" UUID,
  ADD COLUMN "protected_raw_response" BYTEA,
  ADD COLUMN "protected_raw_response_sha256" TEXT,
  ADD CONSTRAINT "import_pages_normalized_runtime_shape_check"
  CHECK (
    "source_instance_id" IS NULL
    OR (
      "requested_cursor" IS NULL
      AND "next_cursor" IS NULL
      AND "has_more" IS NULL
      AND "protected_raw_response_sha256" ~ '^[0-9a-f]{64}$'
      AND (
        (
          "protected_raw_response" IS NOT NULL
          AND octet_length("protected_raw_response") BETWEEN 1 AND 2097152
          AND "payload_expired_at" IS NULL
        )
        OR (
          "protected_raw_response" IS NULL
          AND "payload_expired_at" IS NOT NULL
        )
      )
    )
  );

-- Cursor uniqueness remains only for untouched historical legacy runs. The
-- normalized source path sequences pages by run.next_page_number instead.
CREATE UNIQUE INDEX "import_pages_legacy_run_cursor_unique"
ON "import_pages" ("run_id", "requested_cursor") NULLS NOT DISTINCT
WHERE "source_instance_id" IS NULL;

-- Each normalized quarantine is owned by exactly one delivery position. The
-- legacy source_record_id column remains only for historical/legacy rows and is
-- forbidden on the new occurrence-owned path.
CREATE UNIQUE INDEX "source_delivery_occurrences_tenant_unique"
ON "source_delivery_occurrences"("id", "organization_id");

ALTER TABLE "quarantine_records"
  ALTER COLUMN "record_kind" DROP NOT NULL,
  ADD COLUMN "delivery_occurrence_id" BIGINT,
  ADD CONSTRAINT "quarantine_records_delivery_occurrence_path_check"
  CHECK (
    "delivery_occurrence_id" IS NULL
    OR "source_record_id" IS NULL
  );

CREATE UNIQUE INDEX "quarantine_records_delivery_occurrence_unique"
ON "quarantine_records"("delivery_occurrence_id");

CREATE UNIQUE INDEX "quarantine_records_delivery_occurrence_tenant_unique"
ON "quarantine_records"("delivery_occurrence_id", "organization_id");

ALTER TABLE "quarantine_records"
  ADD CONSTRAINT "quarantine_records_delivery_occurrence_fk"
  FOREIGN KEY ("delivery_occurrence_id", "organization_id")
  REFERENCES "source_delivery_occurrences"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- EV requests retain exactly one runtime origin. Legacy configuration-backed
-- rows remain valid historical work; normalized imports enqueue only the
-- source-revision form and never synthesize a provider configuration.
ALTER TABLE "estimated_ev_recomputation_requests"
  ALTER COLUMN "configuration_revision_id" DROP NOT NULL,
  ADD COLUMN "source_instance_id" UUID,
  ADD COLUMN "source_revision_id" UUID,
  ADD CONSTRAINT "estimated_ev_recomputation_exactly_one_origin_check"
  CHECK (
    ("configuration_revision_id" IS NOT NULL
      AND "source_instance_id" IS NULL
      AND "source_revision_id" IS NULL)
    OR
    ("configuration_revision_id" IS NULL
      AND "source_instance_id" IS NOT NULL
      AND "source_revision_id" IS NOT NULL)
  );

CREATE UNIQUE INDEX "estimated_ev_recomputation_id_organization_unique"
ON "estimated_ev_recomputation_requests"("id", "organization_id");

ALTER TABLE "estimated_ev_recomputation_requests"
  ADD CONSTRAINT "estimated_ev_recomputation_source_revision_fk"
  FOREIGN KEY (
    "source_revision_id", "organization_id", "provider_id", "source_instance_id"
  )
  REFERENCES "provider_source_revisions"(
    "id", "organization_id", "provider_id", "source_instance_id"
  )
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- A calculated EV revision is derived work, not a second provider observation.
-- Its durable origin is the exact recomputation request whose source revision
-- is already tenant- and provider-pinned above.
ALTER TABLE "canonical_revisions"
  DROP CONSTRAINT "canonical_revisions_exactly_one_source_origin_check",
  ADD COLUMN "origin_ev_recomputation_request_id" UUID,
  ADD CONSTRAINT "canonical_revisions_exactly_one_source_origin_check"
  CHECK (
    num_nonnulls(
      "source_record_id",
      "origin_semantic_observation_id",
      "origin_ev_recomputation_request_id"
    ) = 1
  ),
  ADD CONSTRAINT "canonical_revisions_origin_ev_recomputation_fk"
  FOREIGN KEY ("origin_ev_recomputation_request_id", "organization_id")
  REFERENCES "estimated_ev_recomputation_requests"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE FUNCTION "enforce_canonical_ev_recomputation_origin_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."origin_ev_recomputation_request_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."estimated_ev_recomputation_requests" AS request
    JOIN public."provider_sources" AS provider
      ON provider."id" = request."provider_id"
     AND provider."organization_id" = request."organization_id"
    JOIN public."canonical_entities" AS entity
      ON entity."id" = NEW."entity_id"
     AND entity."organization_id" = NEW."organization_id"
    WHERE request."id" = NEW."origin_ev_recomputation_request_id"
      AND request."organization_id" = NEW."organization_id"
      AND entity."record_kind" = 'estimated_ev'::public."canonical_record_kind"
      AND entity."platform_key" = request."platform_key"
      AND entity."external_id" = request."pack_external_id"
  ) THEN
    RAISE EXCEPTION 'canonical EV recomputation origin does not match entity identity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'canonical_revisions_ev_recomputation_origin_identity_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "canonical_revision_ev_recomputation_origin_identity_guard"
BEFORE INSERT OR UPDATE OF
  "organization_id", "entity_id", "origin_ev_recomputation_request_id"
ON "canonical_revisions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_canonical_ev_recomputation_origin_identity"();
