-- CreateEnum
CREATE TYPE "public"."public_change_kind" AS ENUM (
  'provider_projection',
  'quarantine_correction',
  'relationship_resolution',
  'estimated_ev_outcome',
  'public_configuration',
  'provider_lifecycle',
  'manual_correction'
);

-- CreateEnum
CREATE TYPE "public"."public_derivation_kind" AS ENUM ('estimated_ev');

-- CreateEnum
CREATE TYPE "public"."public_derivation_state" AS ENUM (
  'pending',
  'claimed',
  'succeeded',
  'business_unavailable',
  'technical_failure'
);

-- CreateEnum
CREATE TYPE "public"."public_derivation_outcome" AS ENUM (
  'success',
  'business_unavailable',
  'technical_failure'
);

-- CreateTable
CREATE TABLE "public"."settled_public_watermarks" (
  "organization_id" UUID NOT NULL,
  "next_sequence" BIGINT NOT NULL DEFAULT 1,
  "settled_sequence" BIGINT NOT NULL DEFAULT 0,
  "source_head_sequence" BIGINT NOT NULL DEFAULT 0,
  "settled_at" TIMESTAMPTZ(6),
  "source_head_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "settled_public_watermarks_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "settled_public_watermarks_sequence_bounds" CHECK (
    next_sequence >= 1
    AND settled_sequence >= 0
    AND source_head_sequence >= 0
    AND next_sequence = source_head_sequence + 1
    AND settled_sequence <= source_head_sequence
  ),
  CONSTRAINT "settled_public_watermarks_head_timestamp" CHECK (
    (source_head_sequence = 0 AND source_head_at IS NULL)
    OR (source_head_sequence > 0 AND source_head_at IS NOT NULL)
  ),
  CONSTRAINT "settled_public_watermarks_settled_timestamp" CHECK (
    (settled_sequence = 0 AND settled_at IS NULL)
    OR (settled_sequence > 0 AND settled_at IS NOT NULL)
  )
);

-- CreateTable
CREATE TABLE "public"."public_change_causes" (
  "organization_id" UUID NOT NULL,
  "sequence" BIGINT NOT NULL,
  "change_kind" "public"."public_change_kind" NOT NULL,
  "entity_key" TEXT NOT NULL,
  "source_key" TEXT,
  "source_revision_key" TEXT,
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "authoritative_transaction_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "public_change_causes_pkey" PRIMARY KEY ("organization_id", "sequence"),
  CONSTRAINT "public_change_causes_sequence_positive" CHECK (sequence > 0),
  CONSTRAINT "public_change_causes_entity_key_bounded" CHECK (
    length(btrim(entity_key)) BETWEEN 1 AND 512
  ),
  CONSTRAINT "public_change_causes_source_key_bounded" CHECK (
    source_key IS NULL OR length(btrim(source_key)) BETWEEN 1 AND 128
  ),
  CONSTRAINT "public_change_causes_source_revision_key_bounded" CHECK (
    source_revision_key IS NULL
    OR length(btrim(source_revision_key)) BETWEEN 1 AND 128
  ),
  CONSTRAINT "public_change_causes_transaction_bounded" CHECK (
    length(btrim(authoritative_transaction_id)) BETWEEN 1 AND 128
  )
);

-- CreateTable
CREATE TABLE "public"."public_derivation_obligations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "cause_sequence" BIGINT NOT NULL,
  "derivation_kind" "public"."public_derivation_kind" NOT NULL,
  "derivation_key" TEXT NOT NULL,
  "state" "public"."public_derivation_state" NOT NULL DEFAULT 'pending',
  "claimed_by" TEXT,
  "claim_token" UUID,
  "claim_expires_at" TIMESTAMPTZ(6),
  "outcome_classification" "public"."public_derivation_outcome",
  "outcome_reason_code" TEXT,
  "acknowledged_claim_token" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome_at" TIMESTAMPTZ(6),

  CONSTRAINT "public_derivation_obligations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_derivation_obligations_identity_bounded" CHECK (
    length(btrim(derivation_key)) BETWEEN 1 AND 256
  ),
  CONSTRAINT "public_derivation_obligations_claim_consistency" CHECK (
    (state = 'claimed' AND claimed_by IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (state <> 'claimed' AND claimed_by IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
  ),
  CONSTRAINT "public_derivation_obligations_outcome_consistency" CHECK (
    (state IN ('pending', 'claimed') AND outcome_classification IS NULL AND outcome_reason_code IS NULL AND acknowledged_claim_token IS NULL AND outcome_at IS NULL)
    OR (state = 'succeeded' AND outcome_classification = 'success' AND outcome_reason_code IS NULL AND acknowledged_claim_token IS NOT NULL AND outcome_at IS NOT NULL)
    OR (state = 'business_unavailable' AND outcome_classification = 'business_unavailable' AND outcome_reason_code IS NOT NULL AND acknowledged_claim_token IS NOT NULL AND outcome_at IS NOT NULL)
    OR (state = 'technical_failure' AND outcome_classification = 'technical_failure' AND outcome_reason_code IS NOT NULL AND acknowledged_claim_token IS NOT NULL AND outcome_at IS NOT NULL)
  ),
  CONSTRAINT "public_derivation_obligations_worker_bounded" CHECK (
    claimed_by IS NULL OR length(btrim(claimed_by)) BETWEEN 1 AND 256
  ),
  CONSTRAINT "public_derivation_obligations_reason_bounded" CHECK (
    outcome_reason_code IS NULL
    OR outcome_reason_code ~ '^[A-Za-z][A-Za-z0-9_]{0,127}$'
  )
);

-- AlterTable
ALTER TABLE "public"."estimated_ev_recomputation_requests"
ADD COLUMN "originating_public_change_sequence" BIGINT;

ALTER TABLE "public"."canonical_revisions"
ADD COLUMN "public_change_sequence" BIGINT;

ALTER TABLE "public"."canonical_relationships"
ADD COLUMN "created_public_change_sequence" BIGINT,
ADD COLUMN "resolved_public_change_sequence" BIGINT;

-- Backfill pre-feature EV work as migration-authored causes and obligations. The
-- request key is already a public-safe hash, so no payload or quarantine detail
-- enters the ledger.
INSERT INTO "public"."settled_public_watermarks" ("organization_id")
SELECT DISTINCT request.organization_id
FROM "public"."estimated_ev_recomputation_requests" AS request
ON CONFLICT ("organization_id") DO NOTHING;

WITH ranked AS (
  SELECT
    request.id,
    request.organization_id,
    row_number() OVER (
      PARTITION BY request.organization_id
      ORDER BY request.created_at, request.id
    )::BIGINT AS sequence
  FROM "public"."estimated_ev_recomputation_requests" AS request
)
UPDATE "public"."estimated_ev_recomputation_requests" AS request
SET "originating_public_change_sequence" = ranked.sequence
FROM ranked
WHERE request.id = ranked.id;

INSERT INTO "public"."public_change_causes" (
  "organization_id",
  "sequence",
  "change_kind",
  "entity_key",
  "source_key",
  "source_revision_key",
  "occurred_at",
  "authoritative_transaction_id",
  "created_at"
)
SELECT
  request.organization_id,
  request.originating_public_change_sequence,
  'provider_projection'::"public"."public_change_kind",
  'estimated-ev-request:v1:' || request.request_key,
  request.platform_key,
  request.configuration_revision_id::TEXT,
  request.created_at,
  'migration:20260815010000_public_change_settlement',
  request.created_at
FROM "public"."estimated_ev_recomputation_requests" AS request;

INSERT INTO "public"."public_derivation_obligations" (
  "organization_id",
  "cause_sequence",
  "derivation_kind",
  "derivation_key",
  "state",
  "claimed_by",
  "claim_token",
  "claim_expires_at",
  "outcome_classification",
  "outcome_reason_code",
  "acknowledged_claim_token",
  "created_at",
  "updated_at",
  "outcome_at"
)
SELECT
  request.organization_id,
  request.originating_public_change_sequence,
  'estimated_ev'::"public"."public_derivation_kind",
  request.request_key,
  CASE
    WHEN request.state = 'running' THEN 'claimed'
    WHEN request.state = 'completed' AND request.result_status = 'estimated' THEN 'succeeded'
    WHEN request.state = 'completed' AND request.result_status = 'unavailable' THEN 'business_unavailable'
    WHEN request.state = 'failed' THEN 'technical_failure'
    ELSE 'pending'
  END::"public"."public_derivation_state",
  request.claimed_by,
  request.claim_token,
  request.claim_expires_at,
  CASE
    WHEN request.state = 'completed' AND request.result_status = 'estimated' THEN 'success'
    WHEN request.state = 'completed' AND request.result_status = 'unavailable' THEN 'business_unavailable'
    WHEN request.state = 'failed' THEN 'technical_failure'
    ELSE NULL
  END::"public"."public_derivation_outcome",
  CASE
    WHEN request.state = 'completed' AND request.result_status = 'unavailable'
      THEN COALESCE(revision.content_json->'reasonCodes'->>0, 'HISTORICAL_UNAVAILABLE')
    WHEN request.state = 'failed'
      THEN COALESCE(request.failure_code, 'ESTIMATED_EV_RECOMPUTATION_FAILED')
    ELSE NULL
  END,
  CASE
    WHEN request.state IN ('completed', 'failed') THEN gen_random_uuid()
    ELSE NULL
  END,
  request.created_at,
  request.updated_at,
  CASE
    WHEN request.state IN ('completed', 'failed')
      THEN COALESCE(request.completed_at, request.updated_at)
    ELSE NULL
  END
FROM "public"."estimated_ev_recomputation_requests" AS request
LEFT JOIN "public"."canonical_revisions" AS revision
  ON revision.id = request.calculation_revision_id
 AND revision.organization_id = request.organization_id;

WITH heads AS (
  SELECT
    request.organization_id,
    max(request.originating_public_change_sequence) AS source_head_sequence,
    max(request.created_at) AS source_head_at,
    min(request.originating_public_change_sequence) FILTER (
      WHERE request.state <> 'completed'
    ) AS first_unsettled_sequence
  FROM "public"."estimated_ev_recomputation_requests" AS request
  GROUP BY request.organization_id
)
UPDATE "public"."settled_public_watermarks" AS watermark
SET
  next_sequence = heads.source_head_sequence + 1,
  source_head_sequence = heads.source_head_sequence,
  source_head_at = heads.source_head_at,
  settled_sequence = CASE
    WHEN heads.first_unsettled_sequence IS NULL THEN heads.source_head_sequence
    ELSE heads.first_unsettled_sequence - 1
  END,
  settled_at = CASE
    WHEN COALESCE(heads.first_unsettled_sequence - 1, heads.source_head_sequence) > 0
      THEN heads.source_head_at
    ELSE NULL
  END,
  updated_at = heads.source_head_at
FROM heads
WHERE watermark.organization_id = heads.organization_id;

ALTER TABLE "public"."estimated_ev_recomputation_requests"
ALTER COLUMN "originating_public_change_sequence" SET NOT NULL;

-- Backfill every immutable canonical revision with a directly queryable
-- sequence. Existing rows are a conservative migration backfill: pending EV
-- obligations above remain earlier in sequence order and therefore block the
-- whole historical snapshot until they settle.
INSERT INTO "public"."settled_public_watermarks" ("organization_id")
SELECT DISTINCT revision.organization_id
FROM "public"."canonical_revisions" AS revision
ON CONFLICT ("organization_id") DO NOTHING;

WITH revision_counts AS (
  SELECT organization_id, count(*)::BIGINT AS revision_count, max(accepted_at) AS head_at
  FROM "public"."canonical_revisions"
  GROUP BY organization_id
)
UPDATE "public"."settled_public_watermarks" AS watermark
SET
  next_sequence = watermark.next_sequence + revision_counts.revision_count,
  source_head_sequence = watermark.source_head_sequence + revision_counts.revision_count,
  source_head_at = GREATEST(watermark.source_head_at, revision_counts.head_at),
  updated_at = GREATEST(watermark.updated_at, revision_counts.head_at)
FROM revision_counts
WHERE watermark.organization_id = revision_counts.organization_id;

WITH ranked_revisions AS (
  SELECT
    revision.id,
    revision.organization_id,
    row_number() OVER (
      PARTITION BY revision.organization_id
      ORDER BY revision.accepted_at, revision.id
    )::BIGINT AS offset
  FROM "public"."canonical_revisions" AS revision
), revision_counts AS (
  SELECT organization_id, count(*)::BIGINT AS revision_count
  FROM ranked_revisions
  GROUP BY organization_id
)
UPDATE "public"."canonical_revisions" AS revision
SET public_change_sequence =
  watermark.source_head_sequence - revision_counts.revision_count + ranked_revisions.offset
FROM ranked_revisions
JOIN revision_counts
  ON revision_counts.organization_id = ranked_revisions.organization_id
JOIN "public"."settled_public_watermarks" AS watermark
  ON watermark.organization_id = ranked_revisions.organization_id
WHERE revision.id = ranked_revisions.id;

INSERT INTO "public"."public_change_causes" (
  "organization_id",
  "sequence",
  "change_kind",
  "entity_key",
  "source_key",
  "source_revision_key",
  "metadata_json",
  "occurred_at",
  "authoritative_transaction_id",
  "created_at"
)
SELECT
  revision.organization_id,
  revision.public_change_sequence,
  CASE
    WHEN entity.record_kind = 'estimated_ev'
      THEN 'estimated_ev_outcome'
    ELSE 'provider_projection'
  END::"public"."public_change_kind",
  'canonical:v1:' || entity.id::TEXT,
  entity.platform_key,
  revision.provenance_json->>'configRevisionId',
  jsonb_build_object('canonicalRevisionId', revision.id::TEXT),
  revision.accepted_at,
  'migration:20260815010000_public_change_settlement',
  revision.accepted_at
FROM "public"."canonical_revisions" AS revision
JOIN "public"."canonical_entities" AS entity
  ON entity.id = revision.entity_id
 AND entity.organization_id = revision.organization_id;

UPDATE "public"."canonical_relationships" AS relationship
SET
  created_public_change_sequence = (
    SELECT min(revision.public_change_sequence)
    FROM "public"."canonical_revisions" AS revision
    WHERE revision.organization_id = relationship.organization_id
      AND revision.entity_id = relationship.source_entity_id
  ),
  resolved_public_change_sequence = CASE
    WHEN relationship.target_entity_id IS NULL THEN NULL
    ELSE COALESCE(
      (
        SELECT min(revision.public_change_sequence)
        FROM "public"."canonical_revisions" AS revision
        WHERE revision.organization_id = relationship.organization_id
          AND revision.entity_id = relationship.target_entity_id
      ),
      (
        SELECT min(revision.public_change_sequence)
        FROM "public"."canonical_revisions" AS revision
        WHERE revision.organization_id = relationship.organization_id
          AND revision.entity_id = relationship.source_entity_id
      )
    )
  END;

ALTER TABLE "public"."canonical_revisions"
ALTER COLUMN "public_change_sequence" SET NOT NULL;

ALTER TABLE "public"."canonical_relationships"
ALTER COLUMN "created_public_change_sequence" SET NOT NULL;

-- Preserve the approved current provider configuration/lifecycle snapshot in
-- an immutable cause. Later transitions append another cause with the same
-- entity key and a higher sequence.
INSERT INTO "public"."settled_public_watermarks" ("organization_id")
SELECT DISTINCT provider.organization_id
FROM "public"."provider_sources" AS provider
WHERE provider.state <> 'draft'
ON CONFLICT ("organization_id") DO NOTHING;

WITH provider_counts AS (
  SELECT organization_id, count(*)::BIGINT AS provider_count, max(updated_at) AS head_at
  FROM "public"."provider_sources"
  WHERE state <> 'draft'
  GROUP BY organization_id
)
UPDATE "public"."settled_public_watermarks" AS watermark
SET
  next_sequence = watermark.next_sequence + provider_counts.provider_count,
  source_head_sequence = watermark.source_head_sequence + provider_counts.provider_count,
  source_head_at = GREATEST(watermark.source_head_at, provider_counts.head_at),
  updated_at = GREATEST(watermark.updated_at, provider_counts.head_at)
FROM provider_counts
WHERE watermark.organization_id = provider_counts.organization_id;

WITH ranked_providers AS (
  SELECT
    provider.id,
    provider.organization_id,
    row_number() OVER (
      PARTITION BY provider.organization_id
      ORDER BY provider.updated_at, provider.id
    )::BIGINT AS offset
  FROM "public"."provider_sources" AS provider
  WHERE provider.state <> 'draft'
), provider_counts AS (
  SELECT organization_id, count(*)::BIGINT AS provider_count
  FROM ranked_providers
  GROUP BY organization_id
)
INSERT INTO "public"."public_change_causes" (
  "organization_id",
  "sequence",
  "change_kind",
  "entity_key",
  "source_key",
  "source_revision_key",
  "metadata_json",
  "occurred_at",
  "authoritative_transaction_id",
  "created_at"
)
SELECT
  provider.organization_id,
  watermark.source_head_sequence - provider_counts.provider_count + ranked_providers.offset,
  'public_configuration'::"public"."public_change_kind",
  'provider:v1:' || provider.id::TEXT,
  provider.platform_key,
  provider.active_revision_id::TEXT,
  jsonb_build_object(
    'providerId', provider.id::TEXT,
    'platformKey', provider.platform_key,
    'state', provider.state::TEXT,
    'configurationRevisionId', provider.active_revision_id::TEXT
  ),
  provider.updated_at,
  'migration:20260815010000_public_change_settlement',
  provider.updated_at
FROM ranked_providers
JOIN provider_counts
  ON provider_counts.organization_id = ranked_providers.organization_id
JOIN "public"."provider_sources" AS provider
  ON provider.id = ranked_providers.id
 AND provider.organization_id = ranked_providers.organization_id
JOIN "public"."settled_public_watermarks" AS watermark
  ON watermark.organization_id = ranked_providers.organization_id;

WITH settlement AS (
  SELECT
    watermark.organization_id,
    watermark.source_head_sequence,
    min(obligation.cause_sequence) FILTER (
      WHERE obligation.state NOT IN ('succeeded', 'business_unavailable')
    ) AS first_unsettled_sequence
  FROM "public"."settled_public_watermarks" AS watermark
  LEFT JOIN "public"."public_derivation_obligations" AS obligation
    ON obligation.organization_id = watermark.organization_id
  GROUP BY watermark.organization_id, watermark.source_head_sequence
)
UPDATE "public"."settled_public_watermarks" AS watermark
SET
  settled_sequence = COALESCE(
    settlement.first_unsettled_sequence - 1,
    settlement.source_head_sequence
  ),
  settled_at = CASE
    WHEN COALESCE(settlement.first_unsettled_sequence - 1, settlement.source_head_sequence) > 0
      THEN COALESCE(watermark.source_head_at, CURRENT_TIMESTAMP)
    ELSE NULL
  END,
  updated_at = COALESCE(watermark.source_head_at, watermark.updated_at)
FROM settlement
WHERE watermark.organization_id = settlement.organization_id;

-- CreateIndex
CREATE INDEX "public_change_causes_organization_occurred_idx"
ON "public"."public_change_causes"("organization_id", "occurred_at", "sequence");

-- CreateIndex
CREATE INDEX "public_change_causes_source_head_idx"
ON "public"."public_change_causes"("organization_id", "source_key", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "public_derivation_obligations_cause_derivation_unique"
ON "public"."public_derivation_obligations"(
  "organization_id", "cause_sequence", "derivation_kind", "derivation_key"
);

-- CreateIndex
CREATE INDEX "public_derivation_obligations_claim_idx"
ON "public"."public_derivation_obligations"(
  "organization_id", "state", "claim_expires_at", "created_at", "id"
);

-- CreateIndex
CREATE INDEX "public_derivation_obligations_derivation_idx"
ON "public"."public_derivation_obligations"(
  "organization_id", "derivation_kind", "derivation_key"
);

-- CreateIndex
CREATE INDEX "estimated_ev_recomputation_originating_change_idx"
ON "public"."estimated_ev_recomputation_requests"(
  "organization_id", "originating_public_change_sequence"
);

-- CreateIndex
CREATE INDEX "canonical_revisions_public_change_idx"
ON "public"."canonical_revisions"("organization_id", "public_change_sequence");

-- AddForeignKey
ALTER TABLE "public"."settled_public_watermarks"
ADD CONSTRAINT "settled_public_watermarks_organization_id_organizations_id_fk"
FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."public_change_causes"
ADD CONSTRAINT "public_change_causes_organization_id_organizations_id_fk"
FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."public_derivation_obligations"
ADD CONSTRAINT "public_derivation_obligations_organization_fk"
FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."public_derivation_obligations"
ADD CONSTRAINT "public_derivation_obligations_cause_tenant_fk"
FOREIGN KEY ("organization_id", "cause_sequence")
REFERENCES "public"."public_change_causes"("organization_id", "sequence")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."estimated_ev_recomputation_requests"
ADD CONSTRAINT "estimated_ev_recomputation_originating_change_fk"
FOREIGN KEY ("organization_id", "originating_public_change_sequence")
REFERENCES "public"."public_change_causes"("organization_id", "sequence")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."canonical_revisions"
ADD CONSTRAINT "canonical_revisions_public_change_fk"
FOREIGN KEY ("organization_id", "public_change_sequence")
REFERENCES "public"."public_change_causes"("organization_id", "sequence")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."canonical_relationships"
ADD CONSTRAINT "canonical_relationships_created_change_fk"
FOREIGN KEY ("organization_id", "created_public_change_sequence")
REFERENCES "public"."public_change_causes"("organization_id", "sequence")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."canonical_relationships"
ADD CONSTRAINT "canonical_relationships_resolved_change_fk"
FOREIGN KEY ("organization_id", "resolved_public_change_sequence")
REFERENCES "public"."public_change_causes"("organization_id", "sequence")
ON DELETE RESTRICT ON UPDATE NO ACTION;
