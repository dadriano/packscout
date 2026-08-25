-- Observation v2 is additive. Existing v1 revisions and semantic history keep
-- their exact contract/hash pair and strict pack-plus-card pull invariant.
ALTER TABLE "provider_source_revisions"
  DROP CONSTRAINT "provider_source_revisions_keys_check",
  ADD CONSTRAINT "provider_source_revisions_keys_check"
  CHECK (
    btrim("source_type_key") <> ''
    AND btrim("source_adapter_version") <> ''
    AND "normalized_contract_version" IN (
      'packscout.provider-observation.v1',
      'packscout.provider-observation.v2'
    )
    AND btrim("mapper_key") <> ''
    AND btrim("mapper_version") <> ''
    AND btrim("identity_namespace_key") <> ''
    AND btrim("cursor_codec_version") <> ''
    AND "configuration_hash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("configuration_json") = 'object'
    AND jsonb_typeof("record_id_scopes_json") = 'array'
    AND jsonb_array_length("record_id_scopes_json") > 0
  );

ALTER TABLE "source_semantic_observations"
  DROP CONSTRAINT "source_semantic_observations_content_check",
  ADD CONSTRAINT "source_semantic_observations_content_check"
  CHECK (
    (
      (
        "normalized_contract_version" = 'packscout.provider-observation.v1'
        AND "hash_version" = 'packscout.provider-observation-hash.v1'
      )
      OR (
        "normalized_contract_version" = 'packscout.provider-observation.v2'
        AND "hash_version" = 'packscout.provider-observation-hash.v2'
      )
    )
    AND "normalized_content_hash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("normalized_content_json") = 'object'
  );

-- The semantic trigger remains the database authority for normalized content.
-- V2 changes only pull relationship cardinality: one pack or card is required,
-- each is unique, and a two-target pull remains canonically [pack, card].
CREATE OR REPLACE FUNCTION "enforce_source_semantic_observation_content"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  "source" RECORD;
  "content" JSONB := NEW."normalized_content_json";
  "facts" JSONB := NEW."normalized_content_json"->'providerFacts';
  "relationship" JSONB;
  "seen_pack" BOOLEAN := FALSE;
  "seen_card" BOOLEAN := FALSE;
BEGIN
  SELECT
    "record_id_scope_key",
    "provider_record_id",
    "record_kind"::TEXT AS "record_kind",
    "record_discriminator"
  INTO "source"
  FROM "source_record_identities"
  WHERE "id" = NEW."source_record_id"
    AND "organization_id" = NEW."organization_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic observation source record is unavailable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  IF NOT "jsonb_has_exact_keys"(
    "content"->'providerRecordIdentity',
    ARRAY['recordIdScopeKey', 'providerRecordId']
  )
    OR jsonb_typeof("content"->'providerRecordIdentity'->'recordIdScopeKey') <> 'string'
    OR jsonb_typeof("content"->'providerRecordIdentity'->'providerRecordId') <> 'string'
    OR "content"->'providerRecordIdentity'->>'recordIdScopeKey' <> "source"."record_id_scope_key"
    OR "content"->'providerRecordIdentity'->>'providerRecordId' <> "source"."provider_record_id"
    OR NOT "normalized_text_is_canonical"(
      "content"->'providerRecordIdentity'->>'providerRecordId',
      4096
    )
    OR jsonb_typeof("content"->'effectiveAt') <> 'string'
    OR NOT "normalized_utc_millisecond_timestamp_is_valid"("content"->>'effectiveAt')
    OR ("content"->>'effectiveAt')::TIMESTAMPTZ <> NEW."effective_source_time"
  THEN
    RAISE EXCEPTION 'semantic observation content does not match its identity key'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  IF "source"."record_kind" = 'catalog' THEN
    IF NOT "jsonb_has_exact_keys"(
      "content",
      ARRAY[
        'kind', 'entity', 'providerRecordIdentity', 'effectiveAt', 'firstSeenAt',
        'availability', 'providerFacts', 'relationships'
      ]
    )
      OR "content"->>'kind' <> 'catalog'
      OR jsonb_typeof("content"->'firstSeenAt') <> 'string'
      OR NOT "normalized_utc_millisecond_timestamp_is_valid"("content"->>'firstSeenAt')
      OR NOT ("content"->>'availability' IN ('available', 'unavailable', 'unknown'))
      OR jsonb_typeof("content"->'relationships') <> 'array'
      OR jsonb_array_length("content"->'relationships') <> 0
      OR NOT (
        ("source"."record_discriminator" = 'catalog_pack' AND "content"->>'entity' = 'pack')
        OR ("source"."record_discriminator" = 'catalog_card' AND "content"->>'entity' = 'card')
      )
      OR "facts"->>'kind' <> "content"->>'entity'
    THEN
      RAISE EXCEPTION 'semantic catalog content does not match its frozen meaning'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "source"."record_kind" = 'pull' THEN
    IF NOT "jsonb_has_exact_keys"(
      "content",
      ARRAY['kind', 'providerRecordIdentity', 'effectiveAt', 'providerFacts', 'relationships']
    )
      OR "content"->>'kind' <> 'pull'
      OR "facts"->>'kind' <> 'pull'
      OR jsonb_typeof("content"->'relationships') <> 'array'
      OR (
        NEW."normalized_contract_version" = 'packscout.provider-observation.v1'
        AND jsonb_array_length("content"->'relationships') <> 2
      )
      OR (
        NEW."normalized_contract_version" = 'packscout.provider-observation.v2'
        AND jsonb_array_length("content"->'relationships') NOT IN (1, 2)
      )
      OR NEW."normalized_contract_version" NOT IN (
        'packscout.provider-observation.v1',
        'packscout.provider-observation.v2'
      )
    THEN
      RAISE EXCEPTION 'semantic pull content does not match its frozen meaning'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSE
    IF NOT "jsonb_has_exact_keys"(
      "content",
      ARRAY[
        'kind', 'providerRecordIdentity', 'effectiveAt', 'providerFacts',
        'relationships', 'eventType', 'amount', 'currency', 'paymentMethod'
      ]
    )
      OR "content"->>'kind' <> 'trade'
      OR "facts"->>'kind' <> 'trade'
      OR jsonb_typeof("content"->'relationships') <> 'array'
      OR jsonb_array_length("content"->'relationships') <> 1
      OR jsonb_typeof("content"->'eventType') <> 'string'
      OR NOT "normalized_text_is_canonical"("content"->>'eventType', 128)
      OR NOT (
        "content"->'amount' = 'null'::jsonb
        OR jsonb_typeof("content"->'amount') = 'number'
      )
      OR NOT (
        "content"->'currency' = 'null'::jsonb
        OR (
          jsonb_typeof("content"->'currency') = 'string'
          AND "content"->>'currency' ~ '^[A-Z0-9]{2,12}$'
        )
      )
      OR NOT (
        "content"->'paymentMethod' = 'null'::jsonb
        OR (
          jsonb_typeof("content"->'paymentMethod') = 'string'
          AND "normalized_text_is_canonical"("content"->>'paymentMethod', 4096)
        )
      )
    THEN
      RAISE EXCEPTION 'semantic trade content does not match its frozen meaning'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  END IF;

  IF "facts"->>'kind' = 'pack' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY[
        'kind', 'displayName', 'description', 'category', 'imageReferences',
        'price', 'providerReportedEv', 'buybackPercent', 'drawCount', 'evInput',
        'authoritativeAvailability'
      ]
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'description', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'category', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'price', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'providerReportedEv', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'buybackPercent', 'number')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'drawCount', 'number')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'evInput', 'ev_input')
      OR NOT "normalized_provider_fact_is_valid"(
        "facts"->'authoritativeAvailability',
        'authoritative_availability'
      )
    THEN
      RAISE EXCEPTION 'semantic pack provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "facts"->>'kind' = 'card' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY[
        'kind', 'displayName', 'description', 'category', 'imageReferences',
        'estimatedValue', 'valueSource'
      ]
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'description', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'category', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'estimatedValue', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'valueSource', 'text')
    THEN
      RAISE EXCEPTION 'semantic card provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "facts"->>'kind' = 'pull' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY['kind', 'displayName', 'imageReferences', 'value', 'valueSource']
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'value', 'money')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'valueSource', 'text')
    THEN
      RAISE EXCEPTION 'semantic pull provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSIF "facts"->>'kind' = 'trade' THEN
    IF NOT "jsonb_has_exact_keys"(
      "facts",
      ARRAY['kind', 'displayName', 'imageReferences']
    )
      OR NOT "normalized_provider_fact_is_valid"("facts"->'displayName', 'text')
      OR NOT "normalized_provider_fact_is_valid"("facts"->'imageReferences', 'images')
    THEN
      RAISE EXCEPTION 'semantic trade provider facts are invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  ELSE
    RAISE EXCEPTION 'semantic provider facts discriminator is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  FOR "relationship" IN SELECT value FROM jsonb_array_elements("content"->'relationships')
  LOOP
    IF NOT "jsonb_has_exact_keys"("relationship", ARRAY['relationship', 'target'])
      OR NOT "jsonb_has_exact_keys"(
        "relationship"->'target',
        ARRAY['recordIdScopeKey', 'providerRecordId']
      )
      OR jsonb_typeof("relationship"->'relationship') <> 'string'
      OR jsonb_typeof("relationship"->'target'->'providerRecordId') <> 'string'
      OR NOT "normalized_text_is_canonical"(
        "relationship"->'target'->>'providerRecordId',
        4096
      )
    THEN
      RAISE EXCEPTION 'semantic relationship identity is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
    IF "relationship"->>'relationship' = 'pack'
      AND "relationship"->'target'->>'recordIdScopeKey' = 'catalog-pack-v1'
    THEN
      IF "seen_pack" THEN
        RAISE EXCEPTION 'semantic relationship set is duplicated'
          USING ERRCODE = '23514',
                CONSTRAINT = 'source_semantic_observations_semantic_guard';
      END IF;
      "seen_pack" := TRUE;
    ELSIF "relationship"->>'relationship' = 'card'
      AND "relationship"->'target'->>'recordIdScopeKey' = 'catalog-card-v1'
    THEN
      IF "seen_card" THEN
        RAISE EXCEPTION 'semantic relationship set is duplicated'
          USING ERRCODE = '23514',
                CONSTRAINT = 'source_semantic_observations_semantic_guard';
      END IF;
      "seen_card" := TRUE;
    ELSE
      RAISE EXCEPTION 'semantic relationship scope is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'source_semantic_observations_semantic_guard';
    END IF;
  END LOOP;
  IF "source"."record_kind" = 'pull' AND (
    (
      NEW."normalized_contract_version" = 'packscout.provider-observation.v1'
      AND (
        NOT ("seen_pack" AND "seen_card")
        OR "content"->'relationships'->0->>'relationship' <> 'pack'
        OR "content"->'relationships'->1->>'relationship' <> 'card'
      )
    )
    OR (
      NEW."normalized_contract_version" = 'packscout.provider-observation.v2'
      AND (
        (
          "seen_pack" AND "seen_card"
          AND (
            jsonb_array_length("content"->'relationships') <> 2
            OR "content"->'relationships'->0->>'relationship' <> 'pack'
            OR "content"->'relationships'->1->>'relationship' <> 'card'
          )
        )
        OR (
          "seen_pack" AND NOT "seen_card"
          AND (
            jsonb_array_length("content"->'relationships') <> 1
            OR "content"->'relationships'->0->>'relationship' <> 'pack'
          )
        )
        OR (
          NOT "seen_pack" AND "seen_card"
          AND (
            jsonb_array_length("content"->'relationships') <> 1
            OR "content"->'relationships'->0->>'relationship' <> 'card'
          )
        )
        OR NOT ("seen_pack" OR "seen_card")
      )
    )
  )
    OR ("source"."record_kind" = 'trade' AND NOT "seen_card")
  THEN
    RAISE EXCEPTION 'semantic relationship set is incomplete or noncanonical'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  -- The application hash uses JSON.stringify's IEEE-754 number rendering, which
  -- cannot be reproduced exactly from PostgreSQL JSONB for every valid number.
  -- Serialize inserts for a source record and retain the exact content/hash
  -- bijection inside each explicit contract/hash identity domain.
  IF EXISTS (
    SELECT 1
    FROM "source_semantic_observations" AS "existing"
    WHERE "existing"."source_record_id" = NEW."source_record_id"
      AND "existing"."effective_source_time" = NEW."effective_source_time"
      AND "existing"."normalized_contract_version" = NEW."normalized_contract_version"
      AND "existing"."hash_version" = NEW."hash_version"
      AND (
        (
          "existing"."normalized_content_hash" = NEW."normalized_content_hash"
          AND "existing"."normalized_content_json" <> NEW."normalized_content_json"
        )
        OR (
          "existing"."normalized_content_hash" <> NEW."normalized_content_hash"
          AND "existing"."normalized_content_json" = NEW."normalized_content_json"
        )
      )
  ) THEN
    RAISE EXCEPTION 'semantic observation hash and canonical content disagree'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'semantic observation effective time is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'source_semantic_observations_semantic_guard';
END;
$$;
