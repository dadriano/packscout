-- Task buyback-adjusted-ev/005: immutable method-versioned buyback-adjusted EV
-- revisions. Completed calculations are append-only history under
-- packscout-buyback-adjusted-ev-v1; failed or unbindable work lives in a
-- separate deduplicated ledger and can never advance completed freshness.
-- Historical pre-buyback estimated EV rows remain untouched in
-- canonical_revisions under their original method identity.

create table public.buyback_ev_revisions (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  provider_id uuid not null,
  configuration_revision_id uuid not null,
  platform_key text not null,
  product_key text not null,
  product_revision_id text not null,
  method_version text not null,
  confidence_policy_version text not null,
  lifecycle text not null default 'completed',
  status text not null,
  revision_number integer not null,
  calculation_key text not null,
  effective_fingerprint text not null,
  result_hash text not null,
  source_revision_id text not null,
  source_manifest_sha256 text,
  observation_coherence text not null,
  odds_source text not null,
  used_closed_range_midpoint boolean not null,
  calculated_at timestamp(6) with time zone not null,
  data_as_of_state text not null,
  data_observed_at timestamp(6) with time zone,
  pack_price_minor_units bigint,
  underlying_outcome_ev_minor_units bigint,
  draw_multiplier integer,
  gross_ev_minor_units bigint,
  gross_return_basis_points bigint,
  ev_dollars_minor_units bigint,
  ev_percent_basis_points bigint,
  confidence_score_basis_points integer,
  confidence_band text,
  confidence_limitation_codes text[] not null default array[]::text[],
  freshness_state text not null,
  source_age_milliseconds bigint,
  freshness_expires_at timestamp(6) with time zone,
  internal_reasons text[] not null default array[]::text[],
  public_primary_reason text,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint buyback_ev_revisions_pkey primary key (id),
  constraint buyback_ev_revisions_id_organization_unique
    unique (id, organization_id),
  constraint buyback_ev_revisions_identity_unique
    unique (organization_id, calculation_key),
  constraint buyback_ev_revisions_fingerprint_unique
    unique (organization_id, effective_fingerprint),
  constraint buyback_ev_revisions_product_number_unique
    unique (organization_id, platform_key, product_key, revision_number),
  constraint buyback_ev_revisions_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint buyback_ev_revisions_provider_fk
    foreign key (provider_id) references public.provider_sources(id),
  constraint buyback_ev_revisions_provider_tenant_fk
    foreign key (provider_id, organization_id)
    references public.provider_sources(id, organization_id),
  constraint buyback_ev_revisions_configuration_fk
    foreign key (configuration_revision_id)
    references public.provider_config_revisions(id),
  constraint buyback_ev_revisions_configuration_tenant_fk
    foreign key (configuration_revision_id, provider_id, organization_id)
    references public.provider_config_revisions(id, provider_id, organization_id),
  constraint buyback_ev_revisions_method_version_check
    check (method_version = 'packscout-buyback-adjusted-ev-v1'),
  constraint buyback_ev_revisions_confidence_policy_check
    check (
      confidence_policy_version = 'packscout-buyback-adjusted-ev-confidence-v1'
    ),
  constraint buyback_ev_revisions_lifecycle_check
    check (lifecycle = 'completed'),
  constraint buyback_ev_revisions_status_check
    check (status in ('available', 'unavailable')),
  constraint buyback_ev_revisions_revision_number_check
    check (revision_number between 1 and 2147483647),
  constraint buyback_ev_revisions_hash_check
    check (
      calculation_key ~ '^[0-9a-f]{64}$'
      and effective_fingerprint ~ '^[0-9a-f]{64}$'
      and result_hash ~ '^[0-9a-f]{64}$'
      and (source_manifest_sha256 is null
        or source_manifest_sha256 ~ '^[0-9a-f]{64}$')
    ),
  constraint buyback_ev_revisions_platform_key_check
    check (platform_key ~ '^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$'),
  constraint buyback_ev_revisions_product_key_check
    check (product_key ~ '^[a-z0-9]([a-z0-9._:-]{0,126}[a-z0-9])?$'),
  constraint buyback_ev_revisions_source_revision_check
    check (
      product_revision_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:@/-]{0,126}[A-Za-z0-9])?$'
      and source_revision_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:@/-]{0,126}[A-Za-z0-9])?$'
    ),
  constraint buyback_ev_revisions_observation_coherence_check
    check (observation_coherence in ('provider_revision', 'guarded_collection')),
  constraint buyback_ev_revisions_odds_source_check
    check (odds_source in ('current_remaining_inventory', 'platform_published')),
  constraint buyback_ev_revisions_data_as_of_check
    check (
      data_as_of_state in ('known', 'unknown_source_time')
      and ((data_as_of_state = 'known') = (data_observed_at is not null))
    ),
  constraint buyback_ev_revisions_milliseconds_check
    check (
      date_trunc('milliseconds', calculated_at) = calculated_at
      and (data_observed_at is null
        or date_trunc('milliseconds', data_observed_at) = data_observed_at)
      and (freshness_expires_at is null
        or date_trunc('milliseconds', freshness_expires_at) = freshness_expires_at)
    ),
  constraint buyback_ev_revisions_limitation_codes_check
    check (
      cardinality(confidence_limitation_codes) <= 4
      and confidence_limitation_codes <@ array[
        'closed_range_midpoint',
        'platform_published_odds',
        'source_age_over_15_through_30_minutes',
        'source_age_over_30_through_60_minutes'
      ]::text[]
    ),
  constraint buyback_ev_revisions_internal_reasons_check
    check (
      cardinality(internal_reasons) <= 21
      and internal_reasons <@ array[
        'MISSING_PROVENANCE',
        'MISSING_PRODUCT_IDENTITY',
        'MISSING_SOURCE_TIME',
        'NON_ATOMIC_OBSERVATION',
        'INVALID_PRICE',
        'UNSUPPORTED_CURRENCY',
        'UNSUPPORTED_MONEY_PRECISION',
        'EXPIRED_PARITY_APPROVAL',
        'MIXED_CURRENCY_BASIS',
        'AMBIGUOUS_DRAW_SEMANTICS',
        'INCOMPLETE_PROBABILITIES',
        'ODDS_CONFLICT',
        'INCOMPLETE_VALUES',
        'INVALID_VALUE_RANGE',
        'UNKNOWN_BUYBACK_ELIGIBILITY',
        'MISSING_BUYBACK',
        'INVALID_BUYBACK_TERMS',
        'CONDITIONAL_BUYBACK_TERMS',
        'HETEROGENEOUS_OUTCOME_BUCKET',
        'STALE_EVIDENCE',
        'ARITHMETIC_OVERFLOW'
      ]::text[]
    ),
  constraint buyback_ev_revisions_public_reason_check
    check (
      public_primary_reason is null
      or public_primary_reason in (
        'SOURCE_EVIDENCE_UNAVAILABLE',
        'PRICE_UNAVAILABLE',
        'CURRENCY_UNSUPPORTED',
        'ODDS_UNAVAILABLE',
        'VALUE_UNAVAILABLE',
        'BUYBACK_UNAVAILABLE',
        'SOURCE_DATA_STALE',
        'CALCULATION_UNAVAILABLE'
      )
    ),
  constraint buyback_ev_revisions_bounds_check
    check (
      (pack_price_minor_units is null
        or pack_price_minor_units between 1 and 1000000000000)
      and (underlying_outcome_ev_minor_units is null
        or underlying_outcome_ev_minor_units between 0 and 1000000000000)
      and (gross_ev_minor_units is null
        or gross_ev_minor_units between 0 and 1000000000000)
      and (draw_multiplier is null or draw_multiplier between 1 and 100)
      and (ev_dollars_minor_units is null
        or ev_dollars_minor_units
          between -1000000000000 and 1000000000000)
      and (gross_return_basis_points is null
        or gross_return_basis_points between 0 and 10000000000000000)
      and (ev_percent_basis_points is null
        or ev_percent_basis_points
          between -10000 and 10000000000000000)
      and (confidence_score_basis_points is null
        or confidence_score_basis_points between 0 and 10000)
      and (confidence_band is null
        or confidence_band in ('low', 'medium', 'high'))
      and (source_age_milliseconds is null or source_age_milliseconds >= 0)
    ),
  constraint buyback_ev_revisions_available_shape_check
    check (
      status <> 'available'
      or (
        gross_ev_minor_units is not null
        and gross_return_basis_points is not null
        and ev_dollars_minor_units is not null
        and ev_percent_basis_points is not null
        and pack_price_minor_units is not null
        and underlying_outcome_ev_minor_units is not null
        and draw_multiplier is not null
        and confidence_score_basis_points is not null
        and confidence_band is not null
        and data_as_of_state = 'known'
        and freshness_state = 'current'
        and cardinality(internal_reasons) = 0
        and public_primary_reason is null
      )
    ),
  constraint buyback_ev_revisions_unavailable_shape_check
    check (
      status <> 'unavailable'
      or (
        gross_ev_minor_units is null
        and gross_return_basis_points is null
        and ev_dollars_minor_units is null
        and ev_percent_basis_points is null
        and pack_price_minor_units is null
        and underlying_outcome_ev_minor_units is null
        and draw_multiplier is null
        and confidence_score_basis_points is null
        and confidence_band is null
        and cardinality(confidence_limitation_codes) = 0
        and cardinality(internal_reasons) >= 1
        and public_primary_reason is not null
      )
    ),
  constraint buyback_ev_revisions_arithmetic_check
    check (
      status <> 'available'
      or (
        ev_dollars_minor_units = gross_ev_minor_units - pack_price_minor_units
        and ev_percent_basis_points = gross_return_basis_points - 10000
        and gross_return_basis_points =
          ((gross_ev_minor_units * 20000) + pack_price_minor_units)
            / (pack_price_minor_units * 2)
      )
    ),
  constraint buyback_ev_revisions_confidence_band_check
    check (
      status <> 'available'
      or (confidence_score_basis_points between 0 and 4999
          and confidence_band = 'low')
      or (confidence_score_basis_points between 5000 and 7999
          and confidence_band = 'medium')
      or (confidence_score_basis_points between 8000 and 10000
          and confidence_band = 'high')
    ),
  constraint buyback_ev_revisions_freshness_check
    check (
      (
        freshness_state = 'current'
        and data_as_of_state = 'known'
        and source_age_milliseconds =
          (extract(epoch from (calculated_at - data_observed_at)) * 1000)::bigint
        and source_age_milliseconds between 0 and 3600000
        and freshness_expires_at = data_observed_at + interval '60 minutes'
      )
      or (
        freshness_state = 'expired'
        and status = 'unavailable'
        and data_as_of_state = 'known'
        and source_age_milliseconds =
          (extract(epoch from (calculated_at - data_observed_at)) * 1000)::bigint
        and source_age_milliseconds > 3600000
        and freshness_expires_at = data_observed_at + interval '60 minutes'
      )
      or (
        freshness_state = 'unknown_source_time'
        and status = 'unavailable'
        and data_as_of_state = 'unknown_source_time'
        and source_age_milliseconds is null
        and freshness_expires_at is null
      )
    )
);

create index buyback_ev_revisions_current_idx
  on public.buyback_ev_revisions
  (organization_id, platform_key, product_key, lifecycle, revision_number);

create table public.buyback_ev_revision_source_refs (
  organization_id uuid not null,
  revision_id uuid not null,
  reference_index integer not null,
  source_revision_id text not null,
  source_manifest_sha256 text,
  canonical_revision_id uuid,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint buyback_ev_revision_source_refs_pkey
    primary key (revision_id, reference_index),
  constraint buyback_ev_revision_source_refs_revision_source_unique
    unique (revision_id, source_revision_id),
  constraint buyback_ev_revision_source_refs_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint buyback_ev_revision_source_refs_revision_fk
    foreign key (revision_id) references public.buyback_ev_revisions(id),
  constraint buyback_ev_revision_source_refs_revision_tenant_fk
    foreign key (revision_id, organization_id)
    references public.buyback_ev_revisions(id, organization_id),
  constraint buyback_ev_revision_source_refs_canonical_fk
    foreign key (canonical_revision_id)
    references public.canonical_revisions(id) on delete restrict,
  constraint buyback_ev_revision_source_refs_canonical_tenant_fk
    foreign key (canonical_revision_id, organization_id)
    references public.canonical_revisions(id, organization_id),
  constraint buyback_ev_revision_source_refs_index_check
    check (reference_index between 0 and 15),
  constraint buyback_ev_revision_source_refs_source_revision_check
    check (
      source_revision_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:@/-]{0,126}[A-Za-z0-9])?$'
    ),
  constraint buyback_ev_revision_source_refs_manifest_check
    check (
      source_manifest_sha256 is null
      or source_manifest_sha256 ~ '^[0-9a-f]{64}$'
    )
);

create index buyback_ev_revision_source_refs_lookup_idx
  on public.buyback_ev_revision_source_refs
  (organization_id, source_revision_id);

create table public.buyback_ev_persistence_failures (
  organization_id uuid not null,
  failure_key text not null,
  lifecycle text not null default 'failed',
  reason_code text not null,
  provider_id uuid,
  platform_key text,
  product_key text,
  occurrence_count integer not null default 1,
  first_seen_at timestamp(6) with time zone not null,
  last_seen_at timestamp(6) with time zone not null,
  constraint buyback_ev_persistence_failures_pkey
    primary key (organization_id, failure_key),
  constraint buyback_ev_persistence_failures_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint buyback_ev_persistence_failures_provider_fk
    foreign key (provider_id)
    references public.provider_sources(id) on delete restrict,
  constraint buyback_ev_persistence_failures_provider_tenant_fk
    foreign key (provider_id, organization_id)
    references public.provider_sources(id, organization_id),
  constraint buyback_ev_persistence_failures_key_check
    check (failure_key ~ '^[0-9a-f]{64}$'),
  constraint buyback_ev_persistence_failures_lifecycle_check
    check (lifecycle = 'failed'),
  constraint buyback_ev_persistence_failures_reason_check
    check (
      reason_code in (
        'CONTRACT_VIOLATION',
        'IDENTITY_REUSE_CONFLICT',
        'RESULT_CONFLICT',
        'UNBINDABLE_RESULT'
      )
    ),
  constraint buyback_ev_persistence_failures_platform_key_check
    check (
      platform_key is null
      or platform_key ~ '^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$'
    ),
  constraint buyback_ev_persistence_failures_product_key_check
    check (
      product_key is null
      or product_key ~ '^[a-z0-9]([a-z0-9._:-]{0,126}[a-z0-9])?$'
    ),
  constraint buyback_ev_persistence_failures_occurrence_check
    check (occurrence_count between 1 and 1000000000),
  constraint buyback_ev_persistence_failures_seen_check
    check (
      last_seen_at >= first_seen_at
      and date_trunc('milliseconds', first_seen_at) = first_seen_at
      and date_trunc('milliseconds', last_seen_at) = last_seen_at
    )
);

create index buyback_ev_persistence_failures_seen_idx
  on public.buyback_ev_persistence_failures
  (organization_id, last_seen_at);

create function public.reject_buyback_ev_revision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'PackScout buyback EV revisions are immutable'
    using errcode = '55000';
end;
$$;

create trigger buyback_ev_revisions_immutable
before update or delete on public.buyback_ev_revisions
for each row execute function public.reject_buyback_ev_revision_mutation();

create trigger buyback_ev_revision_source_refs_immutable
before update or delete on public.buyback_ev_revision_source_refs
for each row execute function public.reject_buyback_ev_revision_mutation();

create function public.protect_buyback_ev_persistence_failure()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'PackScout buyback EV persistence failures are append-only'
      using errcode = '55000';
  end if;
  if new.organization_id <> old.organization_id
     or new.failure_key <> old.failure_key
     or new.lifecycle <> old.lifecycle
     or new.reason_code <> old.reason_code
     or new.provider_id is distinct from old.provider_id
     or new.platform_key is distinct from old.platform_key
     or new.product_key is distinct from old.product_key
     or new.first_seen_at <> old.first_seen_at
     or new.occurrence_count <> old.occurrence_count + 1
     or new.last_seen_at < old.last_seen_at then
    raise exception
      'PackScout buyback EV persistence failures only accumulate occurrences'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger buyback_ev_persistence_failures_guarded
before update or delete on public.buyback_ev_persistence_failures
for each row execute function public.protect_buyback_ev_persistence_failure();
