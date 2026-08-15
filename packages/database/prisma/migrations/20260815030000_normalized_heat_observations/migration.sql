-- Task 005: governed public identity and append-only normalized Heat evidence.

alter table public.canonical_revisions
  add constraint canonical_revisions_heat_source_unique
  unique (id, organization_id, public_change_sequence);

create table public.public_repack_identity_mappings (
  organization_id uuid not null,
  platform_key text not null,
  pack_external_id text not null,
  public_repack_id uuid not null,
  approved_configuration_key text not null,
  public_change_sequence bigint not null,
  approved_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint public_repack_identity_mappings_pkey
    primary key (organization_id, platform_key, pack_external_id),
  constraint public_repack_identity_mappings_public_id_unique
    unique (organization_id, public_repack_id),
  constraint public_repack_identity_mappings_heat_source_unique
    unique (organization_id, public_repack_id, public_change_sequence),
  constraint public_repack_identity_mappings_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint public_repack_identity_mappings_configuration_fk
    foreign key (
      organization_id, approved_configuration_key, public_change_sequence
    )
    references public.approved_public_catalog_configurations(
      organization_id, configuration_key, public_change_sequence
    ) on update no action on delete restrict,
  constraint public_repack_identity_mappings_change_fk
    foreign key (organization_id, public_change_sequence)
    references public.public_change_causes(organization_id, sequence),
  constraint public_repack_identity_mappings_platform_key_check
    check (
      platform_key = btrim(platform_key)
      and char_length(platform_key) between 1 and 128
    ),
  constraint public_repack_identity_mappings_pack_external_id_check
    check (
      pack_external_id = btrim(pack_external_id)
      and char_length(pack_external_id) between 1 and 512
    ),
  constraint public_repack_identity_mappings_configuration_key_check
    check (
      approved_configuration_key = btrim(approved_configuration_key)
      and char_length(approved_configuration_key) between 1 and 128
    ),
  constraint public_repack_identity_mappings_public_uuid_v5_check
    check ((get_byte(uuid_send(public_repack_id), 6) >> 4) = 5),
  constraint public_repack_identity_mappings_sequence_check
    check (public_change_sequence > 0),
  constraint public_repack_identity_mappings_approved_at_milliseconds_check
    check (date_trunc('milliseconds', approved_at) = approved_at)
);

create index public_repack_identity_mappings_change_idx
  on public.public_repack_identity_mappings
  (organization_id, public_change_sequence);

create table public.normalized_heat_window_checkpoints (
  organization_id uuid primary key,
  closed_before timestamp(6) with time zone not null default '-infinity',
  through_settled_sequence bigint not null default 0,
  next_catalog_sequence bigint not null default 1,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint normalized_heat_window_checkpoints_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint normalized_heat_window_checkpoints_sequence_check
    check (
      through_settled_sequence >= 0
      and next_catalog_sequence between 1 and 2147483648
    ),
  constraint normalized_heat_window_checkpoints_closed_before_milliseconds_check
    check (
      closed_before = '-infinity'::timestamp with time zone
      or date_trunc('milliseconds', closed_before) = closed_before
    )
);

create function public.normalized_heat_outcome_keys_valid(keys text[])
returns boolean
language plpgsql
immutable
strict
as $$
declare
  current_key text;
  previous_key text := null;
  total_bytes bigint := 0;
begin
  if cardinality(keys) > 10000 then
    return false;
  end if;
  foreach current_key in array keys loop
    if current_key is null
       or current_key <> btrim(current_key)
       or current_key !~ '^[0-9a-f]{64}$'
       or (previous_key is not null and current_key <= previous_key) then
      return false;
    end if;
    total_bytes := total_bytes + octet_length(current_key);
    if total_bytes > 8388608 then
      return false;
    end if;
    previous_key := current_key;
  end loop;
  return true;
end;
$$;

create table public.normalized_heat_observations (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  observation_key text not null,
  canonical_revision_id uuid not null,
  public_change_sequence bigint not null,
  mapping_public_change_sequence bigint not null,
  public_repack_id uuid not null,
  observation_kind text not null,
  occurred_at timestamp(6) with time zone not null,
  catalog_sequence integer,
  realized_return_basis_points integer,
  value_multiple_basis_points integer,
  available_chase_count integer,
  outcome_keys text[] not null default array[]::text[],
  retained_until timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint normalized_heat_observations_pkey
    primary key (id, organization_id),
  constraint normalized_heat_observations_key_unique
    unique (organization_id, observation_key),
  constraint normalized_heat_observations_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint normalized_heat_observations_revision_fk
    foreign key (
      canonical_revision_id, organization_id, public_change_sequence
    ) references public.canonical_revisions(
      id, organization_id, public_change_sequence
    ),
  constraint normalized_heat_observations_source_change_fk
    foreign key (organization_id, public_change_sequence)
    references public.public_change_causes(organization_id, sequence),
  constraint normalized_heat_observations_mapping_change_fk
    foreign key (organization_id, mapping_public_change_sequence)
    references public.public_change_causes(organization_id, sequence),
  constraint normalized_heat_observations_identity_mapping_fk
    foreign key (
      organization_id, public_repack_id, mapping_public_change_sequence
    ) references public.public_repack_identity_mappings(
      organization_id, public_repack_id, public_change_sequence
    ),
  constraint normalized_heat_observations_key_check
    check (
      observation_key ~ '^[0-9a-f]{64}$'
    ),
  constraint normalized_heat_observations_kind_check
    check (observation_kind in ('pull', 'catalog_snapshot')),
  constraint normalized_heat_observations_sequence_check
    check (
      public_change_sequence > 0
      and mapping_public_change_sequence > 0
      and (catalog_sequence is null
        or catalog_sequence between 1 and 2147483647)
    ),
  constraint normalized_heat_observations_public_uuid_v5_check
    check ((get_byte(uuid_send(public_repack_id), 6) >> 4) = 5),
  constraint normalized_heat_observations_occurred_at_milliseconds_check
    check (date_trunc('milliseconds', occurred_at) = occurred_at),
  constraint normalized_heat_observations_basis_points_check
    check (
      (realized_return_basis_points is null
        or realized_return_basis_points between 0 and 10000000)
      and (value_multiple_basis_points is null
        or value_multiple_basis_points between 0 and 10000000)
    ),
  constraint normalized_heat_observations_catalog_bounds_check
    check (
      (available_chase_count is null
        or available_chase_count between 0 and 10000)
      and public.normalized_heat_outcome_keys_valid(outcome_keys)
    ),
  constraint normalized_heat_observations_shape_check
    check (
      (observation_kind = 'pull'
        and catalog_sequence is null
        and available_chase_count is null
        and outcome_keys = array[]::text[])
      or
      (observation_kind = 'catalog_snapshot'
        and catalog_sequence is not null
        and realized_return_basis_points is null
        and value_multiple_basis_points is null
        and available_chase_count is not null)
    ),
  constraint normalized_heat_observations_retention_check
    check (retained_until >= occurred_at + interval '7 days')
);

create index normalized_heat_observations_window_idx
  on public.normalized_heat_observations
  (
    organization_id, public_repack_id, occurred_at,
    public_change_sequence
  );

create index normalized_heat_observations_retention_idx
  on public.normalized_heat_observations
  (organization_id, retained_until);

create table public.normalized_heat_observation_outcomes (
  organization_id uuid not null,
  canonical_revision_id uuid not null,
  public_change_sequence bigint not null,
  occurred_at timestamp(6) with time zone not null,
  status text not null,
  reason_code text not null,
  observation_id uuid,
  retained_until timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint normalized_heat_observation_outcomes_pkey
    primary key (organization_id, canonical_revision_id),
  constraint normalized_heat_observation_outcomes_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint normalized_heat_observation_outcomes_revision_fk
    foreign key (
      canonical_revision_id, organization_id, public_change_sequence
    ) references public.canonical_revisions(
      id, organization_id, public_change_sequence
    ),
  constraint normalized_heat_observation_outcomes_change_fk
    foreign key (organization_id, public_change_sequence)
    references public.public_change_causes(organization_id, sequence),
  constraint normalized_heat_observation_outcomes_observation_fk
    foreign key (observation_id, organization_id)
    references public.normalized_heat_observations(id, organization_id),
  constraint normalized_heat_observation_outcomes_status_check
    check (status in ('normalized', 'deferred', 'rejected', 'duplicate')),
  constraint normalized_heat_observation_outcomes_reason_check
    check (
      reason_code in (
        'NORMALIZED',
        'MAPPING_MISSING',
        'EVIDENCE_UNSUPPORTED',
        'EVIDENCE_MALFORMED',
        'WINDOW_CLOSED',
        'CATALOG_LIMIT_EXCEEDED',
        'DUPLICATE_SOURCE_EVENT'
      )
    ),
  constraint normalized_heat_observation_outcomes_shape_check
    check ((status = 'normalized') = (observation_id is not null)),
  constraint normalized_heat_observation_outcomes_occurred_at_milliseconds_check
    check (date_trunc('milliseconds', occurred_at) = occurred_at),
  constraint normalized_heat_observation_outcomes_retention_check
    check (retained_until >= occurred_at + interval '7 days')
);

create index normalized_heat_observation_outcomes_coverage_idx
  on public.normalized_heat_observation_outcomes
  (organization_id, occurred_at, public_change_sequence, status);

create index normalized_heat_observation_outcomes_retention_idx
  on public.normalized_heat_observation_outcomes
  (organization_id, retained_until);

create function public.reject_public_repack_identity_mapping_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'public repack identity mappings are immutable'
    using errcode = '55000';
end;
$$;

create trigger public_repack_identity_mappings_immutable
before update or delete on public.public_repack_identity_mappings
for each row execute function public.reject_public_repack_identity_mapping_mutation();

create function public.protect_normalized_heat_observation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'normalized Heat observations are append-only'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    if old.retained_until > current_timestamp then
      raise exception 'normalized Heat observation retention has not elapsed'
        using errcode = '55000';
    end if;
    return old;
  end if;
  return new;
end;
$$;

create trigger normalized_heat_observations_append_only
before update or delete on public.normalized_heat_observations
for each row execute function public.protect_normalized_heat_observation();

create trigger normalized_heat_observation_outcomes_append_only
before update or delete on public.normalized_heat_observation_outcomes
for each row execute function public.protect_normalized_heat_observation();
