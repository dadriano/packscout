-- Provider-observation V1 may declare an exact relationship identity that is
-- already present in the canonical graph. The physical edge therefore cannot
-- carry the later source-native declaration's public ordering by itself.
-- Confirmation sets materialize that declaration as immutable, checkpointed
-- lineage without replacing or mutating retained canonical evidence.

alter type public.public_change_kind
  add value if not exists 'relationship_confirmation';

alter table public.canonical_relationships
  add constraint canonical_relationships_confirmation_identity_unique
  unique (
    id, organization_id, source_entity_id, relationship_kind,
    target_platform_key, target_record_kind, target_external_id
  );

create unique index source_record_identities_provider_scope_unique
  on public.source_record_identities(
    id, organization_id, provider_id, source_instance_id
  );

create index source_delivery_occurrences_relationship_coverage_idx
  on public.source_delivery_occurrences(
    organization_id, source_revision_id, id
  ) include (
    provider_id, source_instance_id, source_record_id,
    semantic_observation_id, normalized_contract_version, disposition
  );

create index source_delivery_occurrences_relationship_cursor_idx
  on public.source_delivery_occurrences(
    organization_id, source_revision_id, source_record_id, id desc
  ) include (
    provider_id, source_instance_id, semantic_observation_id,
    normalized_contract_version, disposition, collected_at,
    native_evidence_reference
  ) where source_record_id is not null
      and semantic_observation_id is not null;

create table public.source_relationship_confirmation_sets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider_id uuid not null,
  source_instance_id uuid not null,
  source_revision_id uuid not null,
  source_record_id uuid not null,
  semantic_observation_id uuid not null,
  source_entity_id uuid not null,
  source_canonical_revision_id uuid not null,
  source_canonical_content_hash text not null,
  normalized_contract_version text not null,
  semantic_effective_at timestamp(6) with time zone not null,
  declaration_hash text not null,
  relationship_count smallint not null,
  public_change_sequence bigint not null,
  confirmation_mode text not null,
  confirmed_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint source_relationship_confirmation_sets_tenant_unique
    unique (id, organization_id),
  constraint source_relationship_confirmation_sets_semantic_unique
    unique (
      organization_id, source_revision_id, semantic_observation_id
    ),
  constraint source_relationship_confirmation_sets_organization_fk
    foreign key (organization_id)
    references public.organizations(id),
  constraint source_relationship_confirmation_sets_provider_fk
    foreign key (provider_id, organization_id)
    references public.provider_sources(id, organization_id),
  constraint source_relationship_confirmation_sets_revision_fk
    foreign key (
      source_revision_id, organization_id, provider_id, source_instance_id
    ) references public.provider_source_revisions(
      id, organization_id, provider_id, source_instance_id
    ),
  constraint source_relationship_confirmation_sets_record_fk
    foreign key (
      source_record_id, organization_id, provider_id, source_instance_id
    ) references public.source_record_identities(
      id, organization_id, provider_id, source_instance_id
    ),
  constraint source_relationship_confirmation_sets_semantic_fk
    foreign key (
      semantic_observation_id, organization_id, source_record_id,
      normalized_contract_version
    ) references public.source_semantic_observations(
      id, organization_id, source_record_id, normalized_contract_version
    ),
  constraint source_relationship_confirmation_sets_entity_fk
    foreign key (source_entity_id, organization_id)
    references public.canonical_entities(id, organization_id),
  constraint source_relationship_confirmation_sets_revision_origin_fk
    foreign key (
      source_canonical_revision_id, source_entity_id, organization_id
    ) references public.canonical_revisions(
      id, entity_id, organization_id
    ),
  constraint source_relationship_confirmation_sets_change_fk
    foreign key (organization_id, public_change_sequence)
    references public.public_change_causes(organization_id, sequence),
  constraint source_relationship_confirmation_sets_contract_check
    check (
      normalized_contract_version = 'packscout.provider-observation.v1'
    ),
  constraint source_relationship_confirmation_sets_hash_check
    check (
      declaration_hash ~ '^[0-9a-f]{64}$'
      and source_canonical_content_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint source_relationship_confirmation_sets_count_check
    check (relationship_count between 1 and 2),
  constraint source_relationship_confirmation_sets_mode_check
    check (confirmation_mode in ('native', 'adopted')),
  constraint source_relationship_confirmation_sets_timestamp_check
    check (
      date_trunc('milliseconds', semantic_effective_at) =
        semantic_effective_at
      and date_trunc('milliseconds', confirmed_at) = confirmed_at
      and date_trunc('milliseconds', created_at) = created_at
    )
);

create index source_relationship_confirmation_sets_release_idx
  on public.source_relationship_confirmation_sets(
    organization_id, source_revision_id, source_entity_id,
    public_change_sequence desc
  );

create index source_relationship_confirmation_sets_latest_semantic_idx
  on public.source_relationship_confirmation_sets(
    organization_id, source_revision_id, source_entity_id,
    semantic_effective_at desc, public_change_sequence desc, id desc
  );

create table public.source_relationship_confirmations (
  confirmation_set_id uuid not null,
  organization_id uuid not null,
  canonical_relationship_id uuid not null,
  source_entity_id uuid not null,
  relationship_kind text not null,
  target_platform_key text not null,
  target_record_kind public.canonical_record_kind not null,
  target_external_id text not null,
  confirmation_public_change_sequence bigint not null,
  heat_effective_public_change_sequence bigint,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint source_relationship_confirmations_pkey
    primary key (
      confirmation_set_id, organization_id, canonical_relationship_id
    ),
  constraint source_relationship_confirmations_kind_unique
    unique (confirmation_set_id, organization_id, relationship_kind),
  constraint source_relationship_confirmations_set_fk
    foreign key (confirmation_set_id, organization_id)
    references public.source_relationship_confirmation_sets(
      id, organization_id
    ),
  constraint source_relationship_confirmations_relationship_fk
    foreign key (
      canonical_relationship_id, organization_id, source_entity_id,
      relationship_kind, target_platform_key, target_record_kind,
      target_external_id
    ) references public.canonical_relationships(
      id, organization_id, source_entity_id, relationship_kind,
      target_platform_key, target_record_kind, target_external_id
    ),
  constraint source_relationship_confirmations_kind_check
    check (
      (relationship_kind = 'pack'
        and target_record_kind = 'pack')
      or (relationship_kind = 'card'
        and target_record_kind = 'catalog_asset')
    ),
  constraint source_relationship_confirmations_heat_sequence_check
    check (
      confirmation_public_change_sequence > 0
      and (
        heat_effective_public_change_sequence is null
        or heat_effective_public_change_sequence >=
          confirmation_public_change_sequence
      )
    ),
  constraint source_relationship_confirmations_timestamp_check
    check (date_trunc('milliseconds', created_at) = created_at)
);

create index source_relationship_confirmations_set_kind_idx
  on public.source_relationship_confirmations(
    organization_id, confirmation_set_id, relationship_kind
  );

create index source_relationship_confirmations_relationship_idx
  on public.source_relationship_confirmations(
    organization_id, canonical_relationship_id, confirmation_set_id
  );

create index source_relationship_confirmations_target_idx
  on public.source_relationship_confirmations(
    organization_id, target_platform_key, target_record_kind,
    target_external_id, confirmation_set_id
  );

create index source_relationship_confirmations_effective_cursor_idx
  on public.source_relationship_confirmations(
    organization_id, heat_effective_public_change_sequence,
    confirmation_public_change_sequence, confirmation_set_id,
    canonical_relationship_id
  ) where heat_effective_public_change_sequence is not null;

-- Explicit coverage is required because the absence of a confirmation row
-- cannot distinguish "no declaration" from "legacy declaration not adopted".
-- The migration freezes one source-revision-local delivery watermark and the
-- exact latest-pull set count beneath it. Forward source revisions start
-- complete because their page transaction must persist confirmations
-- atomically with accepted delivery occurrences.
create table public.source_relationship_confirmation_backfills (
  organization_id uuid not null,
  provider_id uuid not null,
  source_instance_id uuid not null,
  source_revision_id uuid not null,
  phase text not null,
  target_delivery_occurrence_id bigint not null,
  retry_eligibility_cutoff_at timestamp(6) with time zone not null,
  processed_through_source_record_id uuid,
  target_semantic_set_count bigint not null,
  confirmed_semantic_set_count bigint not null default 0,
  failure_code text,
  started_at timestamp(6) with time zone,
  completed_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint source_relationship_confirmation_backfills_pkey
    primary key (organization_id, source_revision_id),
  constraint source_relationship_confirmation_backfills_revision_fk
    foreign key (
      source_revision_id, organization_id, provider_id, source_instance_id
    ) references public.provider_source_revisions(
      id, organization_id, provider_id, source_instance_id
    ),
  constraint source_relationship_confirmation_backfills_phase_check
    check (phase in ('pending', 'running', 'complete', 'failed')),
  constraint source_relationship_confirmation_backfills_count_check
    check (
      target_delivery_occurrence_id >= 0
      and target_semantic_set_count >= 0
      and confirmed_semantic_set_count between 0 and target_semantic_set_count
    ),
  constraint source_relationship_confirmation_backfills_failure_check
    check (
      (phase = 'failed' and failure_code ~ '^[A-Z][A-Z0-9_]{0,127}$')
      or (phase <> 'failed' and failure_code is null)
    ),
  constraint source_relationship_confirmation_backfills_shape_check
    check (
      (phase in ('pending', 'running') and completed_at is null)
      or (phase = 'complete'
        and confirmed_semantic_set_count = target_semantic_set_count
        and completed_at is not null)
      or phase = 'failed'
    ),
  constraint source_relationship_confirmation_backfills_timestamp_check
    check (
      date_trunc('milliseconds', created_at) = created_at
      and date_trunc('milliseconds', updated_at) = updated_at
      and date_trunc('milliseconds', retry_eligibility_cutoff_at) =
        retry_eligibility_cutoff_at
      and (started_at is null
        or date_trunc('milliseconds', started_at) = started_at)
      and (completed_at is null
        or date_trunc('milliseconds', completed_at) = completed_at)
    )
);

create index source_relationship_confirmation_backfills_phase_idx
  on public.source_relationship_confirmation_backfills(
    phase, organization_id, source_revision_id
  );

insert into public.source_relationship_confirmation_backfills (
  organization_id, provider_id, source_instance_id, source_revision_id,
  phase, target_delivery_occurrence_id, retry_eligibility_cutoff_at,
  processed_through_source_record_id, target_semantic_set_count,
  confirmed_semantic_set_count, started_at, completed_at, created_at, updated_at
)
select source_revision.organization_id,
       source_revision.provider_id,
       source_revision.source_instance_id,
       source_revision.id,
       case when coverage.target_count = 0 then 'complete' else 'pending' end,
       coverage.target_occurrence_id,
       initialized.at,
       null,
       coverage.target_count,
       0,
       case when coverage.target_count = 0 then initialized.at else null end,
       case when coverage.target_count = 0 then initialized.at else null end,
       initialized.at,
       initialized.at
from public.provider_source_revisions as source_revision
cross join lateral (
  select date_trunc('milliseconds', current_timestamp) as at
) as initialized
cross join lateral (
  select coalesce(max(occurrence.id), 0)::bigint as target_occurrence_id
  from public.source_delivery_occurrences as occurrence
  where occurrence.organization_id = source_revision.organization_id
    and occurrence.provider_id = source_revision.provider_id
    and occurrence.source_instance_id = source_revision.source_instance_id
    and occurrence.source_revision_id = source_revision.id
) as watermark
cross join lateral (
  select watermark.target_occurrence_id,
         count(*)::bigint as target_count
  from (
    select distinct on (semantic.source_record_id)
           semantic.source_record_id
    from public.source_delivery_occurrences as occurrence
    join public.source_semantic_observations as semantic
      on semantic.id = occurrence.semantic_observation_id
     and semantic.organization_id = occurrence.organization_id
     and semantic.source_record_id = occurrence.source_record_id
     and semantic.normalized_contract_version =
       'packscout.provider-observation.v1'
    where occurrence.organization_id = source_revision.organization_id
      and occurrence.provider_id = source_revision.provider_id
      and occurrence.source_instance_id = source_revision.source_instance_id
      and occurrence.source_revision_id = source_revision.id
      and occurrence.id <= watermark.target_occurrence_id
      and (
        occurrence.disposition in ('inserted', 'revised', 'duplicate')
        or (
          occurrence.disposition = 'quarantined'
          and exists (
            select 1
            from public.quarantine_records as quarantine
            join public.quarantine_attempts as attempt
              on attempt.quarantine_id = quarantine.id
             and attempt.organization_id = quarantine.organization_id
             and attempt.state = 'succeeded'
             and attempt.finished_at <= initialized.at
            where quarantine.delivery_occurrence_id = occurrence.id
              and quarantine.organization_id = occurrence.organization_id
              and quarantine.state = 'resolved'
              and quarantine.resolved_at <= initialized.at
          )
        )
      )
      and semantic.normalized_content_json ->> 'kind' = 'pull'
    order by semantic.source_record_id,
             semantic.effective_source_time desc,
             occurrence.id desc
  ) as latest
) as coverage;

create function public.initialize_source_relationship_confirmation_backfill()
returns trigger
language plpgsql
as $$
declare
  initialized_at timestamp(6) with time zone :=
    date_trunc('milliseconds', current_timestamp);
begin
  insert into public.source_relationship_confirmation_backfills (
    organization_id, provider_id, source_instance_id, source_revision_id,
    phase, target_delivery_occurrence_id, retry_eligibility_cutoff_at,
    target_semantic_set_count, confirmed_semantic_set_count,
    started_at, completed_at, created_at, updated_at
  ) values (
    new.organization_id, new.provider_id, new.source_instance_id, new.id,
    'complete', 0, initialized_at, 0, 0,
    initialized_at, initialized_at, initialized_at, initialized_at
  );
  return new;
end;
$$;

create trigger provider_source_revisions_initialize_relationship_backfill
after insert on public.provider_source_revisions
for each row execute function
  public.initialize_source_relationship_confirmation_backfill();

create function public.guard_source_relationship_confirmation_backfill()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id
     or new.provider_id <> old.provider_id
     or new.source_instance_id <> old.source_instance_id
     or new.source_revision_id <> old.source_revision_id
     or new.target_delivery_occurrence_id <>
       old.target_delivery_occurrence_id
     or new.retry_eligibility_cutoff_at <>
       old.retry_eligibility_cutoff_at
     or new.target_semantic_set_count <> old.target_semantic_set_count
     or new.confirmed_semantic_set_count <
       old.confirmed_semantic_set_count
     or (old.processed_through_source_record_id is not null
       and (new.processed_through_source_record_id is null
         or new.processed_through_source_record_id <
           old.processed_through_source_record_id))
     or old.phase in ('complete', 'failed') then
    raise exception 'source relationship confirmation backfill is immutable'
      using errcode = '55000';
  end if;

  if new.phase = 'complete' and exists (
    select 1
    from (
      select distinct on (semantic.source_record_id)
             semantic.id as semantic_observation_id
      from public.source_delivery_occurrences as occurrence
      join public.source_semantic_observations as semantic
        on semantic.id = occurrence.semantic_observation_id
       and semantic.organization_id = occurrence.organization_id
       and semantic.source_record_id = occurrence.source_record_id
       and semantic.normalized_contract_version =
         'packscout.provider-observation.v1'
      where occurrence.organization_id = new.organization_id
        and occurrence.provider_id = new.provider_id
        and occurrence.source_instance_id = new.source_instance_id
        and occurrence.source_revision_id = new.source_revision_id
        and occurrence.id <= new.target_delivery_occurrence_id
        and (
          occurrence.disposition in ('inserted', 'revised', 'duplicate')
          or (
            occurrence.disposition = 'quarantined'
            and exists (
              select 1
              from public.quarantine_records as quarantine
              join public.quarantine_attempts as attempt
                on attempt.quarantine_id = quarantine.id
               and attempt.organization_id = quarantine.organization_id
               and attempt.state = 'succeeded'
               and attempt.finished_at <= new.retry_eligibility_cutoff_at
              where quarantine.delivery_occurrence_id = occurrence.id
                and quarantine.organization_id = occurrence.organization_id
                and quarantine.state = 'resolved'
                and quarantine.resolved_at <=
                  new.retry_eligibility_cutoff_at
            )
          )
        )
        and semantic.normalized_content_json ->> 'kind' = 'pull'
      order by semantic.source_record_id,
               semantic.effective_source_time desc,
               occurrence.id desc
    ) as expected
    left join public.source_relationship_confirmation_sets as confirmation
      on confirmation.organization_id = new.organization_id
     and confirmation.source_revision_id = new.source_revision_id
     and confirmation.semantic_observation_id =
       expected.semantic_observation_id
    where confirmation.id is null
  ) then
    raise exception 'source relationship confirmation coverage is incomplete';
  end if;
  return new;
end;
$$;

create trigger source_relationship_confirmation_backfills_monotonic
before update on public.source_relationship_confirmation_backfills
for each row execute function
  public.guard_source_relationship_confirmation_backfill();

create function public.protect_source_relationship_confirmation_backfill()
returns trigger
language plpgsql
as $$
begin
  raise exception 'source relationship confirmation backfill cannot be deleted'
    using errcode = '55000';
end;
$$;

create trigger source_relationship_confirmation_backfills_no_delete
before delete on public.source_relationship_confirmation_backfills
for each row execute function
  public.protect_source_relationship_confirmation_backfill();

create function public.guard_complete_source_relationship_delivery()
returns trigger
language plpgsql
as $$
begin
  if new.disposition in ('inserted', 'revised', 'duplicate')
     and new.normalized_contract_version =
       'packscout.provider-observation.v1'
     and exists (
       select 1
       from public.source_semantic_observations as semantic
       where semantic.id = new.semantic_observation_id
         and semantic.organization_id = new.organization_id
         and semantic.source_record_id = new.source_record_id
         and semantic.normalized_content_json ->> 'kind' = 'pull'
     )
     and not exists (
       select 1
       from public.source_relationship_confirmation_sets as confirmation
       where confirmation.organization_id = new.organization_id
         and confirmation.provider_id = new.provider_id
         and confirmation.source_instance_id = new.source_instance_id
         and confirmation.source_revision_id = new.source_revision_id
         and confirmation.source_record_id = new.source_record_id
         and confirmation.semantic_observation_id =
           new.semantic_observation_id
     ) then
    raise exception 'accepted V1 pull delivery lacks relationship confirmation';
  end if;
  return new;
end;
$$;

create constraint trigger source_delivery_occurrences_relationship_confirmed
after insert or update on public.source_delivery_occurrences
deferrable initially deferred
for each row execute function
  public.guard_complete_source_relationship_delivery();

-- A quarantined occurrence is immutable delivery evidence. Its later resolved
-- retry becomes accepted source-native meaning only when both ledgers are
-- terminal. Check that final transaction state so retries cannot cross the
-- frozen historical cutoff without materializing confirmation lineage.
create function public.guard_complete_source_relationship_quarantine_retry()
returns trigger
language plpgsql
as $$
declare
  p_quarantine_id uuid;
  p_organization_id uuid;
begin
  if tg_table_name = 'quarantine_records' then
    p_quarantine_id := new.id;
  else
    p_quarantine_id := new.quarantine_id;
  end if;
  p_organization_id := new.organization_id;

  if exists (
    select 1
    from public.quarantine_records as quarantine
    join public.source_delivery_occurrences as occurrence
      on occurrence.id = quarantine.delivery_occurrence_id
     and occurrence.organization_id = quarantine.organization_id
    join public.source_semantic_observations as semantic
      on semantic.id = occurrence.semantic_observation_id
     and semantic.organization_id = occurrence.organization_id
     and semantic.source_record_id = occurrence.source_record_id
    where quarantine.id = p_quarantine_id
      and quarantine.organization_id = p_organization_id
      and quarantine.state = 'resolved'
      and occurrence.disposition = 'quarantined'
      and occurrence.normalized_contract_version =
        'packscout.provider-observation.v1'
      and semantic.normalized_content_json ->> 'kind' = 'pull'
      and exists (
        select 1
        from public.quarantine_attempts as attempt
        where attempt.quarantine_id = quarantine.id
          and attempt.organization_id = quarantine.organization_id
          and attempt.state = 'succeeded'
      )
      and not exists (
        select 1
        from public.source_relationship_confirmation_sets as confirmation
        where confirmation.organization_id = occurrence.organization_id
          and confirmation.provider_id = occurrence.provider_id
          and confirmation.source_instance_id = occurrence.source_instance_id
          and confirmation.source_revision_id = occurrence.source_revision_id
          and confirmation.source_record_id = occurrence.source_record_id
          and confirmation.semantic_observation_id =
            occurrence.semantic_observation_id
      )
  ) then
    raise exception 'resolved V1 pull retry lacks relationship confirmation';
  end if;
  return new;
end;
$$;

create constraint trigger quarantine_records_relationship_confirmed
after insert or update on public.quarantine_records
deferrable initially deferred
for each row execute function
  public.guard_complete_source_relationship_quarantine_retry();

create constraint trigger quarantine_attempts_relationship_confirmed
after insert or update on public.quarantine_attempts
deferrable initially deferred
for each row execute function
  public.guard_complete_source_relationship_quarantine_retry();

create function public.protect_source_relationship_confirmation()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'source relationship confirmations are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger source_relationship_confirmation_sets_immutable
before update or delete on public.source_relationship_confirmation_sets
for each row execute function
  public.protect_source_relationship_confirmation();

create trigger source_relationship_confirmations_immutable
before delete on public.source_relationship_confirmations
for each row execute function
  public.protect_source_relationship_confirmation();

-- Confirmation identity remains immutable. The only permitted update is the
-- exact one-time Heat settlement derived inside the canonical relationship's
-- resolution trigger; direct writes cannot manufacture this transition.
create function public.guard_source_relationship_confirmation_heat_freeze(
  p_organization_id uuid,
  p_effective_public_change_sequence bigint
)
returns void
language plpgsql
as $$
declare
  heat_phase text;
  heat_target_public_change_sequence bigint;
begin
  if p_effective_public_change_sequence is null
     or to_regclass(
       'public.normalized_heat_relationship_backfills'
     ) is null then
    return;
  end if;

  -- The Heat checkpoint is introduced by the following migration. Dynamic
  -- SQL keeps this confirmation migration independently deployable. The share
  -- lock serializes item materialization with Heat's checkpoint lock, which is
  -- acquired before it freezes and counts its indexed source set.
  execute
    'select phase, target_public_change_sequence
       from public.normalized_heat_relationship_backfills
      where organization_id = $1
      for share'
    into heat_phase, heat_target_public_change_sequence
    using p_organization_id;

  if heat_phase in ('relationships', 'catalog_order')
     and p_effective_public_change_sequence <=
       heat_target_public_change_sequence then
    raise exception 'source relationship confirmation crosses frozen Heat coverage'
      using errcode = '55000';
  end if;
end;
$$;

create function public.guard_source_relationship_confirmation_settlement()
returns trigger
language plpgsql
as $$
declare
  expected_confirmation_sequence bigint;
  expected_effective_sequence bigint;
begin
  select confirmation.public_change_sequence,
         case
           when relationship.resolved_public_change_sequence is null
             then null
           else greatest(
             confirmation.public_change_sequence,
             relationship.resolved_public_change_sequence
           )
         end
    into expected_confirmation_sequence, expected_effective_sequence
  from public.source_relationship_confirmation_sets as confirmation
  join public.canonical_relationships as relationship
    on relationship.id = new.canonical_relationship_id
   and relationship.organization_id = new.organization_id
  where confirmation.id = new.confirmation_set_id
    and confirmation.organization_id = new.organization_id;

  if not found
     or new.confirmation_public_change_sequence is distinct from
       expected_confirmation_sequence
     or new.heat_effective_public_change_sequence is distinct from
       expected_effective_sequence then
    raise exception 'source relationship confirmation settlement is invalid'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    perform public.guard_source_relationship_confirmation_heat_freeze(
      new.organization_id,
      new.heat_effective_public_change_sequence
    );
    return new;
  end if;

  if pg_trigger_depth() < 2
     or (
       new.confirmation_set_id, new.organization_id,
       new.canonical_relationship_id, new.source_entity_id,
       new.relationship_kind, new.target_platform_key,
       new.target_record_kind, new.target_external_id,
       new.confirmation_public_change_sequence, new.created_at
     ) is distinct from (
       old.confirmation_set_id, old.organization_id,
       old.canonical_relationship_id, old.source_entity_id,
       old.relationship_kind, old.target_platform_key,
       old.target_record_kind, old.target_external_id,
       old.confirmation_public_change_sequence, old.created_at
     )
     or old.heat_effective_public_change_sequence is not null
     or new.heat_effective_public_change_sequence is null then
    raise exception 'source relationship confirmations are immutable'
      using errcode = '55000';
  end if;
  perform public.guard_source_relationship_confirmation_heat_freeze(
    new.organization_id,
    new.heat_effective_public_change_sequence
  );
  return new;
end;
$$;

create trigger source_relationship_confirmations_settlement_monotonic
before insert or update on public.source_relationship_confirmations
for each row execute function
  public.guard_source_relationship_confirmation_settlement();

create function public.materialize_source_relationship_confirmation_resolution()
returns trigger
language plpgsql
as $$
begin
  if old.resolved_public_change_sequence is null
     and new.resolved_public_change_sequence is not null then
    update public.source_relationship_confirmations as item
    set heat_effective_public_change_sequence = greatest(
          item.confirmation_public_change_sequence,
          new.resolved_public_change_sequence
        )
    where item.organization_id = new.organization_id
      and item.canonical_relationship_id = new.id
      and item.heat_effective_public_change_sequence is null;
  end if;
  return new;
end;
$$;

create trigger canonical_relationships_materialize_confirmation_resolution
after update of resolved_public_change_sequence
on public.canonical_relationships
for each row execute function
  public.materialize_source_relationship_confirmation_resolution();

create function public.validate_source_relationship_confirmation_set(
  p_confirmation_set_id uuid,
  p_confirmation_organization_id uuid
)
returns void
language plpgsql
as $$
declare
  confirmation record;
  semantic_content jsonb;
  provider_platform_key text;
  source_external_id text;
  source_record_external_id text;
  cause_kind public.public_change_kind;
  cause_source_key text;
  cause_source_revision_key text;
  cause_metadata jsonb;
  cause_transaction_id text;
  cause_occurred_at timestamp with time zone;
  impact_platform_keys text[];
  declared_count integer;
  item_count integer;
begin
  select confirmation_set.*
    into confirmation
  from public.source_relationship_confirmation_sets as confirmation_set
  where confirmation_set.id = p_confirmation_set_id
    and confirmation_set.organization_id = p_confirmation_organization_id;

  if not found then
    raise exception 'source relationship confirmation scope is invalid';
  end if;

  select semantic.normalized_content_json,
         provider.platform_key,
         source_entity.external_id,
         source_record.provider_record_id,
         cause.change_kind,
         cause.source_key,
         cause.source_revision_key,
         cause.metadata_json,
         cause.authoritative_transaction_id,
         cause.occurred_at,
         impact.provider_platform_keys
    into semantic_content,
         provider_platform_key,
         source_external_id,
         source_record_external_id,
         cause_kind,
         cause_source_key,
         cause_source_revision_key,
         cause_metadata,
         cause_transaction_id,
         cause_occurred_at,
         impact_platform_keys
  from public.source_relationship_confirmation_sets as confirmation_set
  join public.provider_sources as provider
    on provider.id = confirmation_set.provider_id
   and provider.organization_id = confirmation_set.organization_id
  join public.provider_source_revisions as source_revision
    on source_revision.id = confirmation_set.source_revision_id
   and source_revision.organization_id = confirmation_set.organization_id
   and source_revision.provider_id = confirmation_set.provider_id
   and source_revision.source_instance_id = confirmation_set.source_instance_id
   and source_revision.normalized_contract_version =
     confirmation_set.normalized_contract_version
  join public.source_record_identities as source_record
    on source_record.id = confirmation_set.source_record_id
   and source_record.organization_id = confirmation_set.organization_id
   and source_record.provider_id = confirmation_set.provider_id
   and source_record.source_instance_id = confirmation_set.source_instance_id
  join public.source_semantic_observations as semantic
    on semantic.id = confirmation_set.semantic_observation_id
   and semantic.organization_id = confirmation_set.organization_id
   and semantic.source_record_id = confirmation_set.source_record_id
   and semantic.normalized_contract_version =
     confirmation_set.normalized_contract_version
  join public.canonical_entities as source_entity
    on source_entity.id = confirmation_set.source_entity_id
   and source_entity.organization_id = confirmation_set.organization_id
   and source_entity.platform_key = provider.platform_key
   and source_entity.record_kind = 'pull'
  join public.canonical_revisions as canonical_revision
    on canonical_revision.id = confirmation_set.source_canonical_revision_id
   and canonical_revision.entity_id = confirmation_set.source_entity_id
   and canonical_revision.organization_id = confirmation_set.organization_id
   and canonical_revision.content_hash =
     confirmation_set.source_canonical_content_hash
   and canonical_revision.source_updated_at =
     semantic.effective_source_time
   and canonical_revision.public_change_sequence <=
     confirmation_set.public_change_sequence
  join public.public_change_causes as cause
    on cause.organization_id = confirmation_set.organization_id
   and cause.sequence = confirmation_set.public_change_sequence
  join public.public_change_catalog_impacts as impact
    on impact.organization_id = cause.organization_id
   and impact.cause_sequence = cause.sequence
  where confirmation_set.id = confirmation.id
    and confirmation_set.organization_id = confirmation.organization_id;

  if not found then
    raise exception 'source relationship confirmation scope is invalid';
  end if;

  if semantic_content ->> 'kind' <> 'pull'
     or semantic_content -> 'providerRecordIdentity'
          ->> 'recordIdScopeKey' <> 'pull-v1'
     or semantic_content -> 'providerRecordIdentity'
          ->> 'providerRecordId' <> source_external_id
     or source_record_external_id <> source_external_id
     or confirmation.semantic_effective_at is distinct from
       (semantic_content ->> 'effectiveAt')::timestamp with time zone
     or cause_source_key is distinct from provider_platform_key
     or cause_source_revision_key is distinct from
       confirmation.source_revision_id::text
     or cause_metadata ->> 'semanticObservationId' is distinct from
       confirmation.semantic_observation_id::text
     or cause_metadata ->> 'sourceCanonicalRevisionId' is distinct from
       confirmation.source_canonical_revision_id::text
     or cause_metadata ->> 'sourceCanonicalContentHash' is distinct from
       confirmation.source_canonical_content_hash
     or cause_metadata ->> 'relationshipDeclarationHash' is distinct from
       confirmation.declaration_hash
     or cause_metadata ->> 'relationshipCount' is distinct from
       confirmation.relationship_count::text
     or cause_occurred_at is distinct from confirmation.confirmed_at
     or impact_platform_keys is distinct from array[provider_platform_key]::text[]
     or source_record_external_id is null
     or not exists (
       select 1
       from public.source_delivery_occurrences as occurrence
       where occurrence.organization_id = confirmation.organization_id
         and occurrence.provider_id = confirmation.provider_id
         and occurrence.source_instance_id = confirmation.source_instance_id
         and occurrence.source_revision_id = confirmation.source_revision_id
         and occurrence.source_record_id = confirmation.source_record_id
         and occurrence.semantic_observation_id =
           confirmation.semantic_observation_id
         and occurrence.normalized_contract_version =
           confirmation.normalized_contract_version
         and (
           occurrence.disposition in ('inserted', 'revised', 'duplicate')
           or (
             occurrence.disposition = 'quarantined'
             and exists (
               select 1
               from public.quarantine_records as quarantine
               join public.quarantine_attempts as attempt
                 on attempt.quarantine_id = quarantine.id
                and attempt.organization_id = quarantine.organization_id
                and attempt.state = 'succeeded'
               where quarantine.delivery_occurrence_id = occurrence.id
                 and quarantine.organization_id = occurrence.organization_id
                 and quarantine.state = 'resolved'
             )
           )
         )
     ) then
    raise exception 'source relationship confirmation lineage is invalid';
  end if;

  declared_count := jsonb_array_length(
    semantic_content -> 'relationships'
  );
  select count(*)::integer
    into item_count
  from public.source_relationship_confirmations as item
  where item.confirmation_set_id = confirmation.id
    and item.organization_id = confirmation.organization_id;

  if declared_count <> confirmation.relationship_count
     or item_count <> confirmation.relationship_count
     or exists (
       select 1
       from public.source_relationship_confirmations as item
       join public.canonical_relationships as relationship
         on relationship.id = item.canonical_relationship_id
        and relationship.organization_id = item.organization_id
       where item.confirmation_set_id = confirmation.id
         and item.organization_id = confirmation.organization_id
         and (
           item.source_entity_id <> confirmation.source_entity_id
           or item.target_platform_key <> provider_platform_key
           or item.confirmation_public_change_sequence <>
             confirmation.public_change_sequence
           or item.heat_effective_public_change_sequence is distinct from
             case
               when relationship.resolved_public_change_sequence is null
                 then null
               else greatest(
                 confirmation.public_change_sequence,
                 relationship.resolved_public_change_sequence
               )
             end
           or not exists (
             select 1
             from jsonb_array_elements(
               semantic_content -> 'relationships'
             ) as declared(value)
             where declared.value ->> 'relationship' =
               item.relationship_kind
               and declared.value -> 'target' ->> 'providerRecordId' =
                 item.target_external_id
               and declared.value -> 'target' ->> 'recordIdScopeKey' =
                 case item.relationship_kind
                   when 'pack' then 'catalog-pack-v1'
                   when 'card' then 'catalog-card-v1'
                 end
           )
         )
     ) then
    raise exception 'source relationship confirmation declarations are invalid';
  end if;

  if confirmation.confirmation_mode = 'adopted' then
    if cause_kind <> 'relationship_confirmation' then
      raise exception 'source relationship adoption cause is invalid';
    end if;
  elsif confirmation.confirmation_mode = 'native' then
    if cause_kind <> 'relationship_resolution'
       or not exists (
         select 1
         from public.source_relationship_confirmations as item
         join public.canonical_relationships as relationship
           on relationship.id = item.canonical_relationship_id
          and relationship.organization_id = item.organization_id
         where item.confirmation_set_id = confirmation.id
           and item.organization_id = confirmation.organization_id
           and relationship.created_public_change_sequence =
             confirmation.public_change_sequence
       )
       or exists (
         select 1
         from public.source_relationship_confirmations as item
         join public.canonical_relationships as relationship
           on relationship.id = item.canonical_relationship_id
          and relationship.organization_id = item.organization_id
         where item.confirmation_set_id = confirmation.id
           and item.organization_id = confirmation.organization_id
           and relationship.created_public_change_sequence >
             confirmation.public_change_sequence
       )
       or exists (
         select 1
         from public.source_relationship_confirmations as item
         join public.canonical_relationships as relationship
           on relationship.id = item.canonical_relationship_id
          and relationship.organization_id = item.organization_id
         join public.public_change_causes as item_cause
           on item_cause.organization_id = relationship.organization_id
          and item_cause.sequence =
            relationship.created_public_change_sequence
         where item.confirmation_set_id = confirmation.id
           and item.organization_id = confirmation.organization_id
           and (
             item_cause.change_kind <> 'relationship_resolution'
             or item_cause.source_key is distinct from provider_platform_key
             or item_cause.source_revision_key is distinct from
               confirmation.source_revision_id::text
             or item_cause.authoritative_transaction_id is distinct from
               cause_transaction_id
             or item_cause.metadata_json ->> 'semanticObservationId'
               is distinct from confirmation.semantic_observation_id::text
             or item_cause.metadata_json ->> 'sourceCanonicalRevisionId'
               is distinct from
                 confirmation.source_canonical_revision_id::text
             or item_cause.metadata_json ->> 'sourceCanonicalContentHash'
               is distinct from confirmation.source_canonical_content_hash
             or item_cause.metadata_json ->> 'relationshipDeclarationHash'
               is distinct from confirmation.declaration_hash
             or item_cause.metadata_json ->> 'relationshipCount'
               is distinct from confirmation.relationship_count::text
           )
       ) then
      raise exception 'source relationship native confirmation cause is invalid';
    end if;
  else
    raise exception 'source relationship confirmation mode is invalid';
  end if;
end;
$$;

create function public.source_relationship_confirmation_set_guard()
returns trigger
language plpgsql
as $$
begin
  perform public.validate_source_relationship_confirmation_set(
    coalesce(new.id, old.id),
    coalesce(new.organization_id, old.organization_id)
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function public.source_relationship_confirmation_item_guard()
returns trigger
language plpgsql
as $$
begin
  perform public.validate_source_relationship_confirmation_set(
    coalesce(new.confirmation_set_id, old.confirmation_set_id),
    coalesce(new.organization_id, old.organization_id)
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create constraint trigger source_relationship_confirmation_sets_valid
after insert or update on public.source_relationship_confirmation_sets
deferrable initially deferred
for each row execute function
  public.source_relationship_confirmation_set_guard();

create constraint trigger source_relationship_confirmations_valid
after insert or update or delete on public.source_relationship_confirmations
deferrable initially deferred
for each row execute function
  public.source_relationship_confirmation_item_guard();
