-- Provider catalog settlement is a second, impact-aware causal view over the
-- organization-global public-change ledger. The global watermark remains the
-- Heat/audit boundary.

CREATE FUNCTION public.catalog_platform_keys_are_canonical(platform_keys TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT
    cardinality(platform_keys) <= 8
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(platform_keys) AS platform_key
      WHERE length(platform_key) > 128
         OR platform_key !~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
    )
    AND platform_keys = ARRAY(
      SELECT platform_key
      FROM unnest(platform_keys) AS platform_key
      ORDER BY platform_key COLLATE "C"
    )
    AND cardinality(platform_keys) = (
      SELECT count(DISTINCT platform_key)::INTEGER
      FROM unnest(platform_keys) AS platform_key
    )
$$;

CREATE TABLE public.public_change_catalog_impacts (
  organization_id UUID NOT NULL,
  cause_sequence BIGINT NOT NULL,
  provider_platform_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  shared_configuration_key TEXT,
  shared_configuration_revision INTEGER,
  shared_configuration_hash TEXT,
  lifecycle_platform_key TEXT,
  lifecycle_state public.provider_state,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT public_change_catalog_impacts_pkey
    PRIMARY KEY (organization_id, cause_sequence),
  CONSTRAINT public_change_catalog_impacts_provider_keys_canonical CHECK (
    public.catalog_platform_keys_are_canonical(provider_platform_keys)
  ),
  CONSTRAINT public_change_catalog_impacts_shared_epoch_consistent CHECK (
    num_nonnulls(
      shared_configuration_key,
      shared_configuration_revision,
      shared_configuration_hash
    ) = 0
    OR
    (num_nonnulls(
        shared_configuration_key,
        shared_configuration_revision,
        shared_configuration_hash
      ) = 3
      AND length(btrim(shared_configuration_key)) BETWEEN 1 AND 128
      AND shared_configuration_revision > 0
      AND shared_configuration_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT public_change_catalog_impacts_lifecycle_consistent CHECK (
    num_nonnulls(lifecycle_platform_key, lifecycle_state) = 0
    OR
    (num_nonnulls(lifecycle_platform_key, lifecycle_state) = 2
      AND length(lifecycle_platform_key) <= 128
      AND lifecycle_platform_key ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
      AND lifecycle_state IN ('active', 'disabled', 'archived')
      AND (
        (lifecycle_state = 'active'
          AND lifecycle_platform_key = ANY(provider_platform_keys))
        OR
        (lifecycle_state IN ('disabled', 'archived')
          AND NOT lifecycle_platform_key = ANY(provider_platform_keys))
      ))
  )
);

CREATE TABLE public.provider_catalog_checkpoints (
  organization_id UUID NOT NULL,
  platform_key TEXT NOT NULL,
  settled_sequence BIGINT NOT NULL DEFAULT 0,
  source_head_sequence BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMPTZ(6),
  source_head_at TIMESTAMPTZ(6),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT provider_catalog_checkpoints_pkey
    PRIMARY KEY (organization_id, platform_key),
  CONSTRAINT provider_catalog_checkpoints_platform_key_valid CHECK (
    length(platform_key) <= 128
    AND platform_key ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
  ),
  CONSTRAINT provider_catalog_checkpoints_sequence_bounds CHECK (
    settled_sequence >= 0
    AND source_head_sequence >= 0
    AND settled_sequence <= source_head_sequence
  ),
  CONSTRAINT provider_catalog_checkpoints_head_timestamp CHECK (
    (source_head_sequence = 0 AND source_head_at IS NULL)
    OR (source_head_sequence > 0 AND source_head_at IS NOT NULL)
  ),
  CONSTRAINT provider_catalog_checkpoints_settled_timestamp CHECK (
    (settled_sequence = 0 AND settled_at IS NULL)
    OR (settled_sequence > 0 AND settled_at IS NOT NULL)
  )
);

CREATE TABLE public.catalog_manifest_lifecycle_checkpoints (
  organization_id UUID NOT NULL,
  settled_sequence BIGINT NOT NULL DEFAULT 0,
  source_head_sequence BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMPTZ(6),
  source_head_at TIMESTAMPTZ(6),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT catalog_manifest_lifecycle_checkpoints_pkey
    PRIMARY KEY (organization_id),
  CONSTRAINT catalog_manifest_lifecycle_checkpoints_sequence_bounds CHECK (
    settled_sequence >= 0
    AND source_head_sequence >= 0
    AND settled_sequence <= source_head_sequence
  ),
  CONSTRAINT catalog_manifest_lifecycle_checkpoints_head_timestamp CHECK (
    (source_head_sequence = 0 AND source_head_at IS NULL)
    OR (source_head_sequence > 0 AND source_head_at IS NOT NULL)
  ),
  CONSTRAINT catalog_manifest_lifecycle_checkpoints_settled_timestamp CHECK (
    (settled_sequence = 0 AND settled_at IS NULL)
    OR (settled_sequence > 0 AND settled_at IS NOT NULL)
  )
);

ALTER TABLE public.approved_public_catalog_configurations
ADD CONSTRAINT approved_public_catalog_configurations_platform_limit CHECK (
  jsonb_typeof(configuration_json->'platforms') = 'array'
  AND jsonb_array_length(configuration_json->'platforms') BETWEEN 1 AND 8
);

ALTER TABLE public.provider_sources
ADD CONSTRAINT provider_sources_platform_key_valid CHECK (
  length(platform_key) <= 128
  AND platform_key ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
);

CREATE INDEX public_change_catalog_impacts_shared_epoch_idx
ON public.public_change_catalog_impacts (
  organization_id, shared_configuration_hash, cause_sequence
)
WHERE shared_configuration_hash IS NOT NULL;

CREATE INDEX public_change_catalog_impacts_lifecycle_idx
ON public.public_change_catalog_impacts (
  organization_id, lifecycle_platform_key, cause_sequence
)
WHERE lifecycle_platform_key IS NOT NULL;

ALTER TABLE public.public_change_catalog_impacts
ADD CONSTRAINT public_change_catalog_impacts_organization_fk
FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.public_change_catalog_impacts
ADD CONSTRAINT public_change_catalog_impacts_cause_fk
FOREIGN KEY (organization_id, cause_sequence)
REFERENCES public.public_change_causes(organization_id, sequence)
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.public_change_catalog_impacts
ADD CONSTRAINT public_change_catalog_impacts_lifecycle_provider_fk
FOREIGN KEY (organization_id, lifecycle_platform_key)
REFERENCES public.provider_sources(organization_id, platform_key)
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.provider_catalog_checkpoints
ADD CONSTRAINT provider_catalog_checkpoints_organization_fk
FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.provider_catalog_checkpoints
ADD CONSTRAINT provider_catalog_checkpoints_provider_fk
FOREIGN KEY (organization_id, platform_key)
REFERENCES public.provider_sources(organization_id, platform_key)
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.catalog_manifest_lifecycle_checkpoints
ADD CONSTRAINT catalog_manifest_lifecycle_checkpoints_organization_fk
FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Classify the historical ledger conservatively. Runtime writes never infer an
-- impact from source_key; callers must supply the complete explicit impact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.public_change_causes AS cause
    WHERE NOT (
      EXISTS (
        SELECT 1
        FROM public.approved_public_catalog_configurations AS configuration
        WHERE configuration.organization_id = cause.organization_id
          AND configuration.public_change_sequence = cause.sequence
      )
      OR EXISTS (
        SELECT 1
        FROM public.provider_sources AS provider
        WHERE cause.change_kind IN ('provider_lifecycle', 'public_configuration')
          AND cause.metadata_json->>'state' IN ('active', 'disabled', 'archived')
          AND provider.organization_id = cause.organization_id
          AND provider.id::TEXT = cause.metadata_json->>'providerId'
          AND provider.platform_key = cause.metadata_json->>'platformKey'
          AND provider.platform_key = cause.source_key
      )
      OR EXISTS (
        SELECT 1
        FROM public.canonical_revisions AS revision
        JOIN public.canonical_entities AS entity
          ON entity.id = revision.entity_id
         AND entity.organization_id = revision.organization_id
        WHERE revision.organization_id = cause.organization_id
          AND revision.public_change_sequence = cause.sequence
      )
      OR EXISTS (
        SELECT 1
        FROM public.estimated_ev_recomputation_requests AS request
        WHERE request.organization_id = cause.organization_id
          AND request.originating_public_change_sequence = cause.sequence
      )
      OR EXISTS (
        SELECT 1
        FROM public.canonical_relationships AS relationship
        WHERE relationship.organization_id = cause.organization_id
          AND (
            relationship.created_public_change_sequence = cause.sequence
            OR relationship.resolved_public_change_sequence = cause.sequence
          )
      )
    )
  ) THEN
    RAISE EXCEPTION
      'historical public change has no authoritative catalog impact classification'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

WITH classified AS (
  SELECT
    cause.organization_id,
    cause.sequence,
    COALESCE((
      SELECT array_agg(candidate.platform_key ORDER BY candidate.platform_key COLLATE "C")
      FROM (
        SELECT DISTINCT platform_key
        FROM (
          SELECT platform.value->>'platformKey' AS platform_key
          FROM public.approved_public_catalog_configurations AS configuration
          CROSS JOIN LATERAL jsonb_array_elements(
            configuration.configuration_json->'platforms'
          ) AS platform(value)
          WHERE configuration.organization_id = cause.organization_id
            AND configuration.public_change_sequence = cause.sequence

          UNION ALL

          SELECT entity.platform_key
          FROM public.canonical_revisions AS revision
          JOIN public.canonical_entities AS entity
            ON entity.id = revision.entity_id
           AND entity.organization_id = revision.organization_id
          WHERE revision.organization_id = cause.organization_id
            AND revision.public_change_sequence = cause.sequence
            AND entity.record_kind IN (
              'platform', 'pack', 'catalog_asset', 'ev_input', 'estimated_ev'
            )

          UNION ALL

          SELECT request.platform_key
          FROM public.estimated_ev_recomputation_requests AS request
          WHERE request.organization_id = cause.organization_id
            AND request.originating_public_change_sequence = cause.sequence

          UNION ALL

          SELECT source_entity.platform_key
          FROM public.canonical_relationships AS relationship
          JOIN public.canonical_entities AS source_entity
            ON source_entity.id = relationship.source_entity_id
           AND source_entity.organization_id = relationship.organization_id
          WHERE relationship.organization_id = cause.organization_id
            AND (
              relationship.created_public_change_sequence = cause.sequence
              OR relationship.resolved_public_change_sequence = cause.sequence
            )

          UNION ALL

          SELECT relationship.target_platform_key
          FROM public.canonical_relationships AS relationship
          WHERE relationship.organization_id = cause.organization_id
            AND (
              relationship.created_public_change_sequence = cause.sequence
              OR relationship.resolved_public_change_sequence = cause.sequence
            )

          UNION ALL

          SELECT provider.platform_key
          FROM public.provider_sources AS provider
          WHERE cause.change_kind IN ('provider_lifecycle', 'public_configuration')
            AND cause.metadata_json->>'state' = 'active'
            AND provider.organization_id = cause.organization_id
            AND provider.id::TEXT = cause.metadata_json->>'providerId'
            AND provider.platform_key = cause.metadata_json->>'platformKey'
            AND provider.platform_key = cause.source_key
        ) AS candidates
        WHERE platform_key IS NOT NULL
          AND length(platform_key) <= 128
          AND platform_key ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
      ) AS candidate
    ), ARRAY[]::TEXT[]) AS provider_platform_keys,
    configuration.configuration_key AS shared_configuration_key,
    configuration.revision AS shared_configuration_revision,
    configuration.configuration_hash AS shared_configuration_hash,
    lifecycle.platform_key AS lifecycle_platform_key,
    lifecycle.state AS lifecycle_state,
    cause.created_at
  FROM public.public_change_causes AS cause
  LEFT JOIN public.approved_public_catalog_configurations AS configuration
    ON configuration.organization_id = cause.organization_id
   AND configuration.public_change_sequence = cause.sequence
  LEFT JOIN LATERAL (
    SELECT
      provider.platform_key,
      (cause.metadata_json->>'state')::public.provider_state AS state
    FROM public.provider_sources AS provider
    WHERE cause.change_kind IN ('provider_lifecycle', 'public_configuration')
      AND cause.metadata_json->>'state' IN ('active', 'disabled', 'archived')
      AND provider.organization_id = cause.organization_id
      AND provider.id::TEXT = cause.metadata_json->>'providerId'
      AND provider.platform_key = cause.metadata_json->>'platformKey'
      AND provider.platform_key = cause.source_key
  ) AS lifecycle ON TRUE
)
INSERT INTO public.public_change_catalog_impacts (
  organization_id,
  cause_sequence,
  provider_platform_keys,
  shared_configuration_key,
  shared_configuration_revision,
  shared_configuration_hash,
  lifecycle_platform_key,
  lifecycle_state,
  created_at
)
SELECT
  organization_id,
  sequence,
  provider_platform_keys,
  shared_configuration_key,
  shared_configuration_revision,
  shared_configuration_hash,
  lifecycle_platform_key,
  lifecycle_state,
  created_at
FROM classified;

WITH provider_impacts AS (
  SELECT
    impact.organization_id,
    platform_key,
    impact.cause_sequence,
    cause.occurred_at,
    EXISTS (
      SELECT 1
      FROM public.public_derivation_obligations AS obligation
      WHERE obligation.organization_id = impact.organization_id
        AND obligation.cause_sequence = impact.cause_sequence
        AND obligation.state NOT IN ('succeeded', 'business_unavailable')
    ) AS blocked
  FROM public.public_change_catalog_impacts AS impact
  JOIN public.public_change_causes AS cause
    ON cause.organization_id = impact.organization_id
   AND cause.sequence = impact.cause_sequence
  CROSS JOIN LATERAL unnest(impact.provider_platform_keys) AS platform_key
), provider_heads AS (
  SELECT
    organization_id,
    platform_key,
    max(cause_sequence) AS source_head_sequence,
    (array_agg(occurred_at ORDER BY cause_sequence DESC))[1] AS source_head_at,
    min(cause_sequence) FILTER (WHERE blocked) AS first_blocked_sequence
  FROM provider_impacts
  GROUP BY organization_id, platform_key
), provider_settlement AS (
  SELECT
    head.*,
    COALESCE((
      SELECT max(impact.cause_sequence)
      FROM provider_impacts AS impact
      WHERE impact.organization_id = head.organization_id
        AND impact.platform_key = head.platform_key
        AND (
          head.first_blocked_sequence IS NULL
          OR impact.cause_sequence < head.first_blocked_sequence
        )
    ), 0) AS settled_sequence
  FROM provider_heads AS head
)
INSERT INTO public.provider_catalog_checkpoints (
  organization_id,
  platform_key,
  settled_sequence,
  source_head_sequence,
  settled_at,
  source_head_at,
  updated_at
)
SELECT
  settlement.organization_id,
  settlement.platform_key,
  settlement.settled_sequence,
  settlement.source_head_sequence,
  settled_cause.occurred_at,
  settlement.source_head_at,
  settlement.source_head_at
FROM provider_settlement AS settlement
LEFT JOIN public.public_change_causes AS settled_cause
  ON settled_cause.organization_id = settlement.organization_id
 AND settled_cause.sequence = settlement.settled_sequence;

WITH manifest_impacts AS (
  SELECT
    impact.organization_id,
    impact.cause_sequence,
    cause.occurred_at,
    EXISTS (
      SELECT 1
      FROM public.public_derivation_obligations AS obligation
      WHERE obligation.organization_id = impact.organization_id
        AND obligation.cause_sequence = impact.cause_sequence
        AND obligation.state NOT IN ('succeeded', 'business_unavailable')
    ) AS blocked
  FROM public.public_change_catalog_impacts AS impact
  JOIN public.public_change_causes AS cause
    ON cause.organization_id = impact.organization_id
   AND cause.sequence = impact.cause_sequence
  WHERE impact.shared_configuration_hash IS NOT NULL
     OR impact.lifecycle_platform_key IS NOT NULL
), manifest_heads AS (
  SELECT
    organization_id,
    max(cause_sequence) AS source_head_sequence,
    (array_agg(occurred_at ORDER BY cause_sequence DESC))[1] AS source_head_at,
    min(cause_sequence) FILTER (WHERE blocked) AS first_blocked_sequence
  FROM manifest_impacts
  GROUP BY organization_id
), manifest_settlement AS (
  SELECT
    head.*,
    COALESCE((
      SELECT max(impact.cause_sequence)
      FROM manifest_impacts AS impact
      WHERE impact.organization_id = head.organization_id
        AND (
          head.first_blocked_sequence IS NULL
          OR impact.cause_sequence < head.first_blocked_sequence
        )
    ), 0) AS settled_sequence
  FROM manifest_heads AS head
)
INSERT INTO public.catalog_manifest_lifecycle_checkpoints (
  organization_id,
  settled_sequence,
  source_head_sequence,
  settled_at,
  source_head_at,
  updated_at
)
SELECT
  settlement.organization_id,
  settlement.settled_sequence,
  settlement.source_head_sequence,
  settled_cause.occurred_at,
  settlement.source_head_at,
  settlement.source_head_at
FROM manifest_settlement AS settlement
LEFT JOIN public.public_change_causes AS settled_cause
  ON settled_cause.organization_id = settlement.organization_id
 AND settled_cause.sequence = settlement.settled_sequence;

CREATE FUNCTION public.reject_public_change_catalog_impact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'public change catalog impacts are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER public_change_catalog_impacts_immutable
BEFORE UPDATE OR DELETE ON public.public_change_catalog_impacts
FOR EACH ROW EXECUTE FUNCTION public.reject_public_change_catalog_impact_mutation();

CREATE FUNCTION public.reject_provider_platform_key_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider platform keys are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER provider_sources_platform_key_immutable
BEFORE UPDATE OF platform_key ON public.provider_sources
FOR EACH ROW
WHEN (OLD.platform_key IS DISTINCT FROM NEW.platform_key)
EXECUTE FUNCTION public.reject_provider_platform_key_mutation();

CREATE FUNCTION public.assert_public_change_catalog_impact_exists()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.public_change_catalog_impacts AS impact
    WHERE impact.organization_id = NEW.organization_id
      AND impact.cause_sequence = NEW.sequence
  ) THEN
    RAISE EXCEPTION 'public change cause requires an explicit catalog impact'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER public_change_causes_catalog_impact_required
AFTER INSERT ON public.public_change_causes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_public_change_catalog_impact_exists();

CREATE FUNCTION public.assert_shared_configuration_impact_matches_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.shared_configuration_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.approved_public_catalog_configurations AS configuration
    WHERE configuration.organization_id = NEW.organization_id
      AND configuration.public_change_sequence = NEW.cause_sequence
      AND configuration.configuration_key = NEW.shared_configuration_key
      AND configuration.revision = NEW.shared_configuration_revision
      AND configuration.configuration_hash = NEW.shared_configuration_hash
      AND NEW.provider_platform_keys = ARRAY(
        SELECT platform.value->>'platformKey'
        FROM jsonb_array_elements(
          configuration.configuration_json->'platforms'
        ) AS platform(value)
        ORDER BY (platform.value->>'platformKey') COLLATE "C"
      )
  ) THEN
    RAISE EXCEPTION 'shared configuration impact does not match its approval'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER public_change_catalog_impacts_shared_epoch_approval
AFTER INSERT ON public.public_change_catalog_impacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_shared_configuration_impact_matches_approval();
