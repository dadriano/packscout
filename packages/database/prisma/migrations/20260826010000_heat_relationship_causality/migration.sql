-- Latest provider-source V1 stores pull/card/pack relationships as canonical
-- edges. Heat must therefore be able to attribute an observation to the exact
-- exact durable V1 confirmation and eventual relationship-resolution cause,
-- rather than pretending the edge existed at the source canonical revision's
-- earlier causal sequence.

alter table public.canonical_relationships
  add constraint canonical_relationships_id_organization_unique
  unique (id, organization_id);

create index source_relationship_confirmation_sets_heat_latest_idx
  on public.source_relationship_confirmation_sets(
    organization_id, source_entity_id, semantic_effective_at desc,
    public_change_sequence desc, id desc
  );

alter table public.normalized_heat_observations
  add column source_relationship_id uuid;

alter table public.normalized_heat_observation_outcomes
  add column source_relationship_id uuid;

alter table public.normalized_heat_observations
  drop constraint normalized_heat_observations_revision_fk,
  add constraint normalized_heat_observations_revision_fk
    foreign key (canonical_revision_id, organization_id)
    references public.canonical_revisions(id, organization_id)
    on update no action on delete restrict,
  add constraint normalized_heat_observations_source_relationship_fk
    foreign key (source_relationship_id, organization_id)
    references public.canonical_relationships(id, organization_id)
    on update no action on delete restrict;

alter table public.normalized_heat_observation_outcomes
  drop constraint normalized_heat_observation_outcomes_revision_fk,
  add constraint normalized_heat_observation_outcomes_revision_fk
    foreign key (canonical_revision_id, organization_id)
    references public.canonical_revisions(id, organization_id)
    on update no action on delete restrict,
  add constraint normalized_heat_observation_outcomes_source_relationship_fk
    foreign key (source_relationship_id, organization_id)
    references public.canonical_relationships(id, organization_id)
    on update no action on delete restrict;

create function public.normalized_heat_source_causality_guard()
returns trigger
language plpgsql
as $$
declare
  revision_entity_id uuid;
  revision_sequence bigint;
  revision_record_kind public.canonical_record_kind;
  revision_platform_key text;
  relationship_source_entity_id uuid;
  relationship_kind text;
  relationship_target_entity_id uuid;
  relationship_target_platform_key text;
  relationship_target_kind public.canonical_record_kind;
  relationship_target_external_id text;
  relationship_created_sequence bigint;
  relationship_resolved_sequence bigint;
  relationship_resolved_at timestamp with time zone;
  confirmation_revision_id uuid;
  confirmation_sequence bigint;
  effective_sequence bigint;
  target_identity_matches boolean;
  cause_kind public.public_change_kind;
  cause_provider_impact_matches boolean;
begin
  select revision.entity_id, revision.public_change_sequence,
         entity.record_kind, entity.platform_key
    into revision_entity_id, revision_sequence, revision_record_kind,
         revision_platform_key
  from public.canonical_revisions as revision
  join public.canonical_entities as entity
    on entity.id = revision.entity_id
   and entity.organization_id = revision.organization_id
  where revision.id = new.canonical_revision_id
    and revision.organization_id = new.organization_id;

  if not found then
    raise exception 'normalized Heat source revision is invalid';
  end if;

  if new.source_relationship_id is null then
    if new.public_change_sequence <> revision_sequence then
      raise exception 'normalized Heat revision cause is invalid';
    end if;
    return new;
  end if;

  select relationship.source_entity_id, relationship.relationship_kind,
         relationship.target_entity_id, relationship.target_platform_key,
         relationship.target_record_kind, relationship.target_external_id,
         relationship.created_public_change_sequence,
         relationship.resolved_public_change_sequence,
         relationship.resolved_at,
         first_confirmation.source_canonical_revision_id,
         first_confirmation.confirmation_sequence,
         exists (
           select 1
           from public.canonical_entities as target
           where target.id = relationship.target_entity_id
             and target.organization_id = relationship.organization_id
             and target.platform_key = relationship.target_platform_key
             and target.record_kind = relationship.target_record_kind
             and target.external_id = relationship.target_external_id
         )
    into relationship_source_entity_id, relationship_kind,
         relationship_target_entity_id, relationship_target_platform_key,
         relationship_target_kind, relationship_target_external_id,
         relationship_created_sequence,
         relationship_resolved_sequence, relationship_resolved_at,
         confirmation_revision_id, confirmation_sequence,
         target_identity_matches
  from public.canonical_relationships as relationship
  join lateral (
    select confirmation.source_canonical_revision_id,
           confirmation.public_change_sequence as confirmation_sequence
    from public.source_relationship_confirmations as item
    join public.source_relationship_confirmation_sets as confirmation
      on confirmation.id = item.confirmation_set_id
     and confirmation.organization_id = item.organization_id
    where item.organization_id = relationship.organization_id
      and item.canonical_relationship_id = relationship.id
      and confirmation.source_canonical_revision_id =
        new.canonical_revision_id
      and greatest(
        confirmation.public_change_sequence,
        relationship.resolved_public_change_sequence
      ) = new.public_change_sequence
    order by confirmation.public_change_sequence asc,
             confirmation.id asc
    limit 1
  ) as first_confirmation on true
  where relationship.id = new.source_relationship_id
    and relationship.organization_id = new.organization_id;

  if not found then
    raise exception 'normalized Heat relationship source is invalid';
  end if;

  if revision_record_kind <> 'pull'
     or relationship_source_entity_id <> revision_entity_id
     or relationship_target_entity_id is null
     or relationship_target_external_id is null
     or relationship_resolved_at is null
     or relationship_target_platform_key <> revision_platform_key
     or confirmation_revision_id <> new.canonical_revision_id
     or revision_sequence > confirmation_sequence
     or not target_identity_matches then
    raise exception 'normalized Heat relationship cause is invalid';
  end if;

  if relationship_kind = 'pack' then
    if relationship_target_kind <> 'pack'::public.canonical_record_kind then
      raise exception 'normalized Heat pack relationship target is invalid';
    end if;
  elsif relationship_kind = 'card' then
    if relationship_target_kind <> 'catalog_asset'::public.canonical_record_kind then
      raise exception 'normalized Heat card relationship target is invalid';
    end if;
  else
    raise exception 'normalized Heat relationship kind is invalid';
  end if;

  effective_sequence := greatest(
    confirmation_sequence,
    relationship_resolved_sequence
  );
  if relationship_resolved_sequence is null
     or relationship_resolved_sequence < relationship_created_sequence
     or confirmation_sequence < relationship_created_sequence
     or revision_sequence > effective_sequence
     or effective_sequence <> new.public_change_sequence then
    raise exception 'normalized Heat relationship sequence is invalid';
  end if;

  select cause.change_kind,
         exists (
           select 1
           from public.public_change_catalog_impacts as impact
           where impact.organization_id = cause.organization_id
             and impact.cause_sequence = cause.sequence
             and revision_platform_key = any(impact.provider_platform_keys)
         )
    into cause_kind, cause_provider_impact_matches
  from public.public_change_causes as cause
  where cause.organization_id = new.organization_id
    and cause.sequence = new.public_change_sequence;

  if cause_kind is null
     or cause_kind not in (
       'relationship_resolution', 'relationship_confirmation'
     )
     or cause_provider_impact_matches is distinct from true then
    raise exception 'normalized Heat relationship public cause is invalid';
  end if;
  return new;
end;
$$;

create constraint trigger normalized_heat_observations_source_causality
after insert or update on public.normalized_heat_observations
deferrable initially immediate
for each row execute function public.normalized_heat_source_causality_guard();

create constraint trigger normalized_heat_observation_outcomes_source_causality
after insert or update on public.normalized_heat_observation_outcomes
deferrable initially immediate
for each row execute function public.normalized_heat_source_causality_guard();

-- Existing normalized Heat rows are retained, but their append-order catalog
-- sequence cannot order relationship causes that predate this migration. A
-- separately populated causal order stays null until the bounded backfill has
-- processed the frozen relationship watermark. Public reads never fall back
-- to the legacy append-order value.
alter table public.normalized_heat_observations
  add column catalog_order_sequence integer,
  add constraint normalized_heat_observations_catalog_order_check
    check (
      (catalog_order_sequence is null
        or catalog_order_sequence between 1 and 2147483647)
      and (observation_kind = 'catalog_snapshot'
        or catalog_order_sequence is null)
    );

create unique index normalized_heat_observations_catalog_order_unique
  on public.normalized_heat_observations(
    organization_id, catalog_order_sequence
  );

create index normalized_heat_observations_catalog_order_backfill_idx
  on public.normalized_heat_observations(
    organization_id, public_change_sequence, observation_key collate "C"
  )
  include (id)
  where observation_kind = 'catalog_snapshot'
    and catalog_order_sequence is null;

-- One source-neutral authority for identifying relationships declared by a
-- completed provider-observation V1 run. It deliberately does not depend on a
-- canonical revision or relationship creation origin: an exact physical edge
-- may have been retained from the legacy projector when V1 later declared the
-- same identity. Consumers select the latest occurrence for one pull and
-- source revision before exact-matching these declarations to physical edges.
create view public.provider_v1_pull_relationship_declarations as
select occurrence.organization_id,
       occurrence.provider_id,
       provider.platform_key,
       occurrence.source_instance_id,
       occurrence.source_revision_id,
       occurrence.run_id,
       occurrence.id as delivery_occurrence_id,
       semantic.id as semantic_observation_id,
       semantic.effective_source_time as semantic_effective_at,
       occurrence.collected_at as delivery_collected_at,
       run.finished_at as run_finished_at,
       identity.provider_record_id as pull_external_id,
       declaration.ordinality as declaration_ordinal,
       declaration.value ->> 'relationship' as relationship_kind,
       case declaration.value ->> 'relationship'
         when 'pack' then 'pack'::public.canonical_record_kind
         when 'card' then 'catalog_asset'::public.canonical_record_kind
       end as target_record_kind,
       declaration.value -> 'target' ->> 'providerRecordId'
         as target_external_id
from public.source_delivery_occurrences as occurrence
join public.source_semantic_observations as semantic
  on semantic.id = occurrence.semantic_observation_id
 and semantic.organization_id = occurrence.organization_id
 and semantic.source_record_id = occurrence.source_record_id
 and semantic.normalized_contract_version =
   'packscout.provider-observation.v1'
 and semantic.hash_version = 'packscout.provider-observation-hash.v1'
join public.source_record_identities as identity
  on identity.id = semantic.source_record_id
 and identity.organization_id = semantic.organization_id
 and identity.provider_id = occurrence.provider_id
 and identity.source_instance_id = occurrence.source_instance_id
 and identity.record_id_scope_key = 'pull-v1'
 and identity.record_kind = 'pull'
 and identity.record_discriminator = 'pull'
join public.provider_source_revisions as source_revision
  on source_revision.id = occurrence.source_revision_id
 and source_revision.organization_id = occurrence.organization_id
 and source_revision.provider_id = occurrence.provider_id
 and source_revision.source_instance_id = occurrence.source_instance_id
 and source_revision.connection_profile_id = occurrence.connection_profile_id
 and source_revision.source_type_key = occurrence.source_type_key
 and source_revision.source_adapter_version = occurrence.source_adapter_version
 and source_revision.normalized_contract_version =
   occurrence.normalized_contract_version
 and source_revision.mapper_key = occurrence.mapper_key
 and source_revision.mapper_version = occurrence.mapper_version
 and source_revision.identity_namespace_key = occurrence.identity_namespace_key
 and source_revision.cursor_codec_version = occurrence.cursor_codec_version
join public.provider_source_instances as source_instance
  on source_instance.id = source_revision.source_instance_id
 and source_instance.organization_id = source_revision.organization_id
 and source_instance.provider_id = source_revision.provider_id
join public.provider_sources as provider
  on provider.id = source_revision.provider_id
 and provider.organization_id = source_revision.organization_id
join public.import_runs as run
  on run.id = occurrence.run_id
 and run.organization_id = occurrence.organization_id
 and run.provider_id = occurrence.provider_id
 and run.source_instance_id = occurrence.source_instance_id
 and run.source_revision_id = occurrence.source_revision_id
 and run.source_type_key = occurrence.source_type_key
 and run.source_adapter_version = occurrence.source_adapter_version
 and run.normalized_contract_version = occurrence.normalized_contract_version
 and run.mapper_key = occurrence.mapper_key
 and run.mapper_version = occurrence.mapper_version
 and run.identity_namespace_key = occurrence.identity_namespace_key
 and run.connection_profile_id = occurrence.connection_profile_id
 and run.connection_revision_id = occurrence.connection_revision_id
 and run.cursor_codec_version = occurrence.cursor_codec_version
 and run.state = 'succeeded'
 and run.reached_provider_head
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(semantic.normalized_content_json -> 'relationships') =
      'array'
    then semantic.normalized_content_json -> 'relationships'
    else '[]'::jsonb
  end
) with ordinality as declaration(value, ordinality)
where occurrence.disposition in ('inserted', 'revised', 'duplicate')
  and occurrence.normalized_contract_version =
    'packscout.provider-observation.v1'
  and semantic.normalized_content_json ->> 'kind' = 'pull'
  and semantic.normalized_content_json -> 'providerRecordIdentity'
        ->> 'recordIdScopeKey' = 'pull-v1'
  and semantic.normalized_content_json -> 'providerRecordIdentity'
        ->> 'providerRecordId' = identity.provider_record_id
  and declaration.value ->> 'relationship' in ('pack', 'card')
  and declaration.value -> 'target' ->> 'recordIdScopeKey' =
    case declaration.value ->> 'relationship'
      when 'pack' then 'catalog-pack-v1'
      when 'card' then 'catalog-card-v1'
    end
  and nullif(
    declaration.value -> 'target' ->> 'providerRecordId',
    ''
  ) is not null;

create table public.normalized_heat_relationship_backfills (
  organization_id uuid primary key,
  phase text not null default 'awaiting_confirmations',
  target_public_change_sequence bigint not null,
  processed_through_public_change_sequence bigint not null default 0,
  processed_through_confirmation_public_change_sequence bigint not null
    default 0,
  processed_through_confirmation_set_id uuid,
  processed_through_relationship_id uuid,
  next_catalog_order_sequence bigint not null default 1,
  target_relationship_source_count bigint not null,
  relationship_source_count bigint not null default 0,
  initial_catalog_observation_count bigint not null,
  target_catalog_observation_count bigint,
  catalog_observation_count bigint not null default 0,
  failure_code text,
  started_at timestamp(6) with time zone,
  completed_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint normalized_heat_relationship_backfills_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint normalized_heat_relationship_backfills_phase_check
    check (phase in (
      'awaiting_confirmations', 'relationships', 'catalog_order',
      'complete', 'failed'
    )),
  constraint normalized_heat_relationship_backfills_cursor_check
    check (
      target_public_change_sequence >= 0
      and processed_through_public_change_sequence between 0
        and target_public_change_sequence
      and processed_through_confirmation_public_change_sequence between 0
        and processed_through_public_change_sequence
      and (processed_through_public_change_sequence > 0
        or (processed_through_confirmation_set_id is null
          and processed_through_relationship_id is null))
      and (
        (processed_through_confirmation_public_change_sequence = 0) =
          (processed_through_confirmation_set_id is null)
      )
      and (
        (processed_through_confirmation_set_id is null) =
          (processed_through_relationship_id is null)
      )
      and next_catalog_order_sequence between 1 and 2147483648
    ),
  constraint normalized_heat_relationship_backfills_count_check
    check (
      target_relationship_source_count >= 0
      and relationship_source_count between 0
        and target_relationship_source_count
      and initial_catalog_observation_count >= 0
      and (target_catalog_observation_count is null
        or target_catalog_observation_count >= initial_catalog_observation_count)
      and catalog_observation_count >= 0
      and (target_catalog_observation_count is null
        or catalog_observation_count <= target_catalog_observation_count)
    ),
  constraint normalized_heat_relationship_backfills_failure_check
    check (
      (phase = 'failed' and failure_code ~ '^[A-Z][A-Z0-9_]{0,127}$')
      or (phase <> 'failed' and failure_code is null)
    ),
  constraint normalized_heat_relationship_backfills_shape_check
    check (
      (phase = 'awaiting_confirmations'
        and target_public_change_sequence = 0
        and processed_through_public_change_sequence = 0
        and processed_through_confirmation_public_change_sequence = 0
        and processed_through_confirmation_set_id is null
        and processed_through_relationship_id is null
        and target_relationship_source_count = 0
        and relationship_source_count = 0
        and target_catalog_observation_count is null
        and catalog_observation_count = 0
        and completed_at is null)
      or (phase = 'relationships'
        and target_catalog_observation_count is null
        and completed_at is null)
      or (phase = 'catalog_order'
        and target_catalog_observation_count is not null
        and completed_at is null)
      or (phase = 'complete'
        and processed_through_public_change_sequence =
          target_public_change_sequence
        and relationship_source_count = target_relationship_source_count
        and target_catalog_observation_count is not null
        and catalog_observation_count = target_catalog_observation_count
        and next_catalog_order_sequence = catalog_observation_count + 1
        and completed_at is not null)
      or phase = 'failed'
    ),
  constraint normalized_heat_relationship_backfills_timestamp_check
    check (
      date_trunc('milliseconds', created_at) = created_at
      and date_trunc('milliseconds', updated_at) = updated_at
      and (started_at is null
        or date_trunc('milliseconds', started_at) = started_at)
      and (completed_at is null
        or date_trunc('milliseconds', completed_at) = completed_at)
    )
);

-- Confirmation discovery can allocate adoption causes, so the Heat watermark
-- cannot be frozen in the migration transaction. Startup first completes the
-- durable confirmation repair, then atomically freezes the current public head
-- and confirmation-set-item count before leaving this phase.
insert into public.normalized_heat_relationship_backfills (
  organization_id, phase, target_public_change_sequence,
  processed_through_public_change_sequence,
  processed_through_relationship_id, next_catalog_order_sequence,
  target_relationship_source_count, relationship_source_count,
  initial_catalog_observation_count, target_catalog_observation_count,
  catalog_observation_count, created_at, updated_at
)
select organization.id,
       'awaiting_confirmations',
       0,
       0,
       null,
       1,
       0,
       0,
       catalog_observations.observation_count,
       null,
       0,
       date_trunc('milliseconds', current_timestamp),
       date_trunc('milliseconds', current_timestamp)
from public.organizations as organization
cross join lateral (
  select count(*)::bigint as observation_count
  from public.normalized_heat_observations as observation
  where observation.organization_id = organization.id
    and observation.observation_kind = 'catalog_snapshot'
) as catalog_observations;

-- Organizations created after this migration have no pre-migration Heat and
-- therefore start complete. The first canonical writer can immediately assign
-- authoritative causal catalog order.
create function public.initialize_normalized_heat_relationship_backfill()
returns trigger
language plpgsql
as $$
declare
  initialized_at timestamp(6) with time zone :=
    date_trunc('milliseconds', current_timestamp);
begin
  insert into public.normalized_heat_relationship_backfills (
    organization_id, phase, target_public_change_sequence,
    processed_through_public_change_sequence,
    processed_through_relationship_id, next_catalog_order_sequence,
    target_relationship_source_count, relationship_source_count,
    initial_catalog_observation_count, target_catalog_observation_count,
    catalog_observation_count, started_at, completed_at, created_at, updated_at
  ) values (
    new.id, 'complete', 0, 0, null, 1, 0, 0, 0, 0, 0,
    initialized_at, initialized_at, initialized_at, initialized_at
  );
  return new;
end;
$$;

create trigger organizations_initialize_normalized_heat_relationship_backfill
after insert on public.organizations
for each row execute function
  public.initialize_normalized_heat_relationship_backfill();

-- The checkpoint is an append-only state machine. Shape checks constrain each
-- row in isolation; this trigger also prevents cursor/count regression and
-- forged terminal states across updates.
create function public.protect_normalized_heat_relationship_backfill()
returns trigger
language plpgsql
as $$
declare
  authoritative_relationship_count bigint;
  authoritative_effective_sequence bigint;
  authoritative_confirmation_sequence bigint;
  authoritative_confirmation_set_id uuid;
  authoritative_relationship_id uuid;
  authoritative_catalog_count bigint;
  authoritative_ordered_catalog_count bigint;
  authoritative_min_catalog_order integer;
  authoritative_max_catalog_order integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'normalized Heat relationship backfill cannot be deleted'
      using errcode = '55000';
  end if;
  if new.organization_id <> old.organization_id
     or new.created_at <> old.created_at
     or new.updated_at < old.updated_at
     or (
       new.started_at is distinct from old.started_at
       and not (old.started_at is null and new.started_at is not null)
     )
     or (
       new.completed_at is distinct from old.completed_at
       and not (
         old.completed_at is null
         and new.completed_at is not null
         and new.phase = 'complete'
       )
     ) then
    raise exception 'normalized Heat relationship backfill metadata is immutable'
      using errcode = '55000';
  end if;
  if old.phase in ('complete', 'failed') then
    raise exception 'normalized Heat relationship backfill is terminal'
      using errcode = '55000';
  end if;

  if new.phase = 'failed' then
    if old.phase not in (
         'awaiting_confirmations', 'relationships', 'catalog_order'
       )
       or old.failure_code is not null
       or new.failure_code is null
       or new.target_public_change_sequence <>
         old.target_public_change_sequence
       or new.processed_through_public_change_sequence <>
         old.processed_through_public_change_sequence
       or new.processed_through_confirmation_public_change_sequence <>
         old.processed_through_confirmation_public_change_sequence
       or new.processed_through_confirmation_set_id is distinct from
         old.processed_through_confirmation_set_id
       or new.processed_through_relationship_id is distinct from
         old.processed_through_relationship_id
       or new.next_catalog_order_sequence <>
         old.next_catalog_order_sequence
       or new.target_relationship_source_count <>
         old.target_relationship_source_count
       or new.relationship_source_count <> old.relationship_source_count
       or new.initial_catalog_observation_count <>
         old.initial_catalog_observation_count
       or new.target_catalog_observation_count is distinct from
         old.target_catalog_observation_count
       or new.catalog_observation_count <> old.catalog_observation_count
       or new.started_at is distinct from old.started_at
       or new.completed_at is distinct from old.completed_at then
      raise exception 'normalized Heat relationship backfill failure is invalid'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if new.failure_code is not null then
    raise exception 'normalized Heat relationship backfill failure is invalid'
      using errcode = '55000';
  end if;

  if old.phase = 'awaiting_confirmations' then
    if new.phase = 'awaiting_confirmations' then
      if new.target_public_change_sequence <>
           old.target_public_change_sequence
         or new.processed_through_public_change_sequence <>
           old.processed_through_public_change_sequence
         or new.processed_through_confirmation_public_change_sequence <>
           old.processed_through_confirmation_public_change_sequence
         or new.processed_through_confirmation_set_id is distinct from
           old.processed_through_confirmation_set_id
         or new.processed_through_relationship_id is distinct from
           old.processed_through_relationship_id
         or new.next_catalog_order_sequence <>
           old.next_catalog_order_sequence
         or new.target_relationship_source_count <>
           old.target_relationship_source_count
         or new.relationship_source_count <> old.relationship_source_count
         or new.initial_catalog_observation_count <>
           old.initial_catalog_observation_count
         or new.target_catalog_observation_count is distinct from
           old.target_catalog_observation_count
         or new.catalog_observation_count <> old.catalog_observation_count
         or new.completed_at is distinct from old.completed_at then
        raise exception 'normalized Heat confirmation wait state is immutable'
          using errcode = '55000';
      end if;
      return new;
    end if;
    if new.phase = 'relationships' then
      if new.started_at is null
         or new.processed_through_public_change_sequence <>
           old.processed_through_public_change_sequence
         or new.processed_through_confirmation_public_change_sequence <>
           old.processed_through_confirmation_public_change_sequence
         or new.processed_through_confirmation_set_id is distinct from
           old.processed_through_confirmation_set_id
         or new.processed_through_relationship_id is distinct from
           old.processed_through_relationship_id
         or new.next_catalog_order_sequence <>
           old.next_catalog_order_sequence
         or new.relationship_source_count <> old.relationship_source_count
         or new.initial_catalog_observation_count <>
           old.initial_catalog_observation_count
         or new.target_catalog_observation_count is distinct from
           old.target_catalog_observation_count
         or new.catalog_observation_count <> old.catalog_observation_count
         or new.started_at is distinct from old.started_at
         or new.completed_at is distinct from old.completed_at then
        raise exception 'normalized Heat relationship freeze is invalid'
          using errcode = '55000';
      end if;
      return new;
    end if;
    raise exception 'normalized Heat relationship backfill phase is invalid'
      using errcode = '55000';
  end if;

  if old.phase = 'relationships' then
    if new.target_public_change_sequence <>
         old.target_public_change_sequence
       or new.target_relationship_source_count <>
         old.target_relationship_source_count
       or new.initial_catalog_observation_count <>
         old.initial_catalog_observation_count
       or new.started_at is distinct from old.started_at
       or new.completed_at is distinct from old.completed_at then
      raise exception 'normalized Heat relationship target is immutable'
        using errcode = '55000';
    end if;
    if new.phase = 'relationships' then
      if new.next_catalog_order_sequence <>
           old.next_catalog_order_sequence
         or new.target_catalog_observation_count is distinct from
           old.target_catalog_observation_count
         or new.catalog_observation_count <> old.catalog_observation_count
         or new.relationship_source_count < old.relationship_source_count then
        raise exception 'normalized Heat relationship cursor is invalid'
          using errcode = '55000';
      end if;
      if new.relationship_source_count = old.relationship_source_count then
        if new.processed_through_public_change_sequence <>
             old.processed_through_public_change_sequence
           or new.processed_through_confirmation_public_change_sequence <>
             old.processed_through_confirmation_public_change_sequence
           or new.processed_through_confirmation_set_id is distinct from
             old.processed_through_confirmation_set_id
           or new.processed_through_relationship_id is distinct from
             old.processed_through_relationship_id then
          raise exception 'normalized Heat relationship cursor is invalid'
            using errcode = '55000';
        end if;
      elsif new.processed_through_confirmation_set_id is null
         or new.processed_through_relationship_id is null
         or (
           old.processed_through_confirmation_set_id is not null
           and (
             new.processed_through_public_change_sequence,
             new.processed_through_confirmation_public_change_sequence,
             new.processed_through_confirmation_set_id,
             new.processed_through_relationship_id
           ) <= (
             old.processed_through_public_change_sequence,
             old.processed_through_confirmation_public_change_sequence,
             old.processed_through_confirmation_set_id,
             old.processed_through_relationship_id
           )
         ) then
        raise exception 'normalized Heat relationship cursor is invalid'
          using errcode = '55000';
      end if;
      return new;
    end if;
    if new.phase = 'catalog_order' then
      select count(*)::bigint
        into authoritative_relationship_count
      from public.source_relationship_confirmations as item
      where item.organization_id = old.organization_id
        and item.heat_effective_public_change_sequence is not null
        and item.heat_effective_public_change_sequence <=
          old.target_public_change_sequence;
      select item.heat_effective_public_change_sequence,
             item.confirmation_public_change_sequence,
             item.confirmation_set_id,
             item.canonical_relationship_id
        into authoritative_effective_sequence,
             authoritative_confirmation_sequence,
             authoritative_confirmation_set_id,
             authoritative_relationship_id
      from public.source_relationship_confirmations as item
      where item.organization_id = old.organization_id
        and item.heat_effective_public_change_sequence is not null
        and item.heat_effective_public_change_sequence <=
          old.target_public_change_sequence
      order by item.heat_effective_public_change_sequence desc,
               item.confirmation_public_change_sequence desc,
               item.confirmation_set_id desc,
               item.canonical_relationship_id desc
      limit 1;
      if authoritative_relationship_count <>
           old.target_relationship_source_count
         or old.relationship_source_count <>
           old.target_relationship_source_count
         or (
           authoritative_relationship_count = 0
           and (
             old.processed_through_public_change_sequence <> 0
             or old.processed_through_confirmation_public_change_sequence <> 0
             or old.processed_through_confirmation_set_id is not null
             or old.processed_through_relationship_id is not null
           )
         )
         or (
           authoritative_relationship_count > 0
           and (
             old.processed_through_public_change_sequence is distinct from
               authoritative_effective_sequence
             or old.processed_through_confirmation_public_change_sequence
               is distinct from authoritative_confirmation_sequence
             or old.processed_through_confirmation_set_id is distinct from
               authoritative_confirmation_set_id
             or old.processed_through_relationship_id is distinct from
               authoritative_relationship_id
           )
         )
         or new.relationship_source_count <> old.relationship_source_count
         or new.processed_through_public_change_sequence <>
           new.target_public_change_sequence
         or new.processed_through_confirmation_public_change_sequence <> 0
         or new.processed_through_confirmation_set_id is not null
         or new.processed_through_relationship_id is not null
         or new.target_catalog_observation_count is null
         or new.catalog_observation_count <> 0
         or new.next_catalog_order_sequence <> 1 then
        raise exception 'normalized Heat catalog order freeze is invalid'
          using errcode = '55000';
      end if;
      return new;
    end if;
    raise exception 'normalized Heat relationship backfill phase is invalid'
      using errcode = '55000';
  end if;

  if old.phase = 'catalog_order' then
    if new.target_public_change_sequence <>
         old.target_public_change_sequence
       or new.processed_through_public_change_sequence <>
         old.processed_through_public_change_sequence
       or new.processed_through_confirmation_public_change_sequence <>
         old.processed_through_confirmation_public_change_sequence
       or new.processed_through_confirmation_set_id is distinct from
         old.processed_through_confirmation_set_id
       or new.processed_through_relationship_id is distinct from
         old.processed_through_relationship_id
       or new.target_relationship_source_count <>
         old.target_relationship_source_count
       or new.relationship_source_count <> old.relationship_source_count
       or new.initial_catalog_observation_count <>
         old.initial_catalog_observation_count
       or new.target_catalog_observation_count is distinct from
         old.target_catalog_observation_count
       or new.started_at is distinct from old.started_at then
      raise exception 'normalized Heat catalog order target is immutable'
        using errcode = '55000';
    end if;
    if new.phase = 'catalog_order' then
      if new.completed_at is distinct from old.completed_at
         or new.catalog_observation_count < old.catalog_observation_count
         or new.next_catalog_order_sequence <
           old.next_catalog_order_sequence
         or (
           new.catalog_observation_count - old.catalog_observation_count
         ) <> (
           new.next_catalog_order_sequence - old.next_catalog_order_sequence
         )
         or new.next_catalog_order_sequence <>
           new.catalog_observation_count + 1 then
        raise exception 'normalized Heat catalog order cursor is invalid'
          using errcode = '55000';
      end if;
      return new;
    end if;
    if new.phase = 'complete' then
      select count(*)::bigint,
             count(observation.catalog_order_sequence)::bigint,
             min(observation.catalog_order_sequence),
             max(observation.catalog_order_sequence)
        into authoritative_catalog_count,
             authoritative_ordered_catalog_count,
             authoritative_min_catalog_order,
             authoritative_max_catalog_order
      from public.normalized_heat_observations as observation
      where observation.organization_id = old.organization_id
        and observation.observation_kind = 'catalog_snapshot';
      if authoritative_catalog_count <>
           old.target_catalog_observation_count
         or authoritative_ordered_catalog_count <>
           authoritative_catalog_count
         or (
           authoritative_catalog_count = 0
           and (
             authoritative_min_catalog_order is not null
             or authoritative_max_catalog_order is not null
           )
         )
         or (
           authoritative_catalog_count > 0
           and (
             authoritative_min_catalog_order <> 1
             or authoritative_max_catalog_order <>
               authoritative_catalog_count
           )
         )
         or new.next_catalog_order_sequence <>
           old.next_catalog_order_sequence
         or new.catalog_observation_count <> old.catalog_observation_count
         or new.catalog_observation_count <>
           new.target_catalog_observation_count
         or new.completed_at is null then
        raise exception 'normalized Heat relationship completion is invalid'
          using errcode = '55000';
      end if;
      return new;
    end if;
  end if;
  raise exception 'normalized Heat relationship backfill phase is invalid'
    using errcode = '55000';
end;
$$;

create trigger normalized_heat_relationship_backfills_monotonic
before update or delete on public.normalized_heat_relationship_backfills
for each row execute function
  public.protect_normalized_heat_relationship_backfill();

-- Keep observations append-only. The sole exception is the one-way fill of
-- the new causal order while the durable checkpoint is in catalog_order.
create or replace function public.protect_normalized_heat_observation()
returns trigger
language plpgsql
as $$
declare
  heat_phase text;
begin
  if tg_op = 'INSERT' then
    select backfill.phase
      into heat_phase
    from public.normalized_heat_relationship_backfills as backfill
    where backfill.organization_id = new.organization_id
    for share;
    if heat_phase = 'catalog_order' then
      raise exception 'normalized Heat catalog order is frozen'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if tg_table_name = 'normalized_heat_observations'
       and old.catalog_order_sequence is null
       and new.catalog_order_sequence is not null
       and new.observation_kind = 'catalog_snapshot'
       and (to_jsonb(new) - 'catalog_order_sequence') =
         (to_jsonb(old) - 'catalog_order_sequence')
       and exists (
         select 1
         from public.normalized_heat_relationship_backfills as backfill
         where backfill.organization_id = old.organization_id
           and backfill.phase = 'catalog_order'
       ) then
      return new;
    end if;
    raise exception 'normalized Heat observations are append-only'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    begin
      select backfill.phase
        into heat_phase
      from public.normalized_heat_relationship_backfills as backfill
      where backfill.organization_id = old.organization_id
      for share nowait;
    exception
      when lock_not_available then
        raise exception 'normalized Heat catalog order transition is in progress'
          using errcode = '55000';
    end;
    if heat_phase = 'catalog_order' then
      raise exception 'normalized Heat catalog order is frozen'
        using errcode = '55000';
    end if;
    if old.retained_until > current_timestamp then
      raise exception 'normalized Heat observation retention has not elapsed'
        using errcode = '55000';
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger normalized_heat_observations_append_only
  on public.normalized_heat_observations;
create trigger normalized_heat_observations_append_only
before insert or update or delete on public.normalized_heat_observations
for each row execute function public.protect_normalized_heat_observation();

-- Outcomes share the append-only and retention policy, but not the observation
-- row shape. Keep a table-specific trigger function so PL/pgSQL never resolves
-- observation-only fields against the outcome relation during an update.
create or replace function public.protect_normalized_heat_observation_outcome()
returns trigger
language plpgsql
as $$
declare
  heat_phase text;
begin
  if tg_op = 'INSERT' then
    select backfill.phase
      into heat_phase
    from public.normalized_heat_relationship_backfills as backfill
    where backfill.organization_id = new.organization_id
    for share;
    if heat_phase = 'catalog_order' then
      raise exception 'normalized Heat catalog order is frozen'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'normalized Heat observations are append-only'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    begin
      select backfill.phase
        into heat_phase
      from public.normalized_heat_relationship_backfills as backfill
      where backfill.organization_id = old.organization_id
      for share nowait;
    exception
      when lock_not_available then
        raise exception 'normalized Heat catalog order transition is in progress'
          using errcode = '55000';
    end;
    if heat_phase = 'catalog_order' then
      raise exception 'normalized Heat catalog order is frozen'
        using errcode = '55000';
    end if;
    if old.retained_until > current_timestamp then
      raise exception 'normalized Heat observation retention has not elapsed'
        using errcode = '55000';
    end if;
    return old;
  end if;
  return new;
end;
$$;

-- A row trigger can prove that catalog order is a one-way fill, but it cannot
-- prove that a statement assigned the exact next causal ranks. Validate the
-- complete bounded batch before the repository advances its durable counter.
create function public.validate_normalized_heat_catalog_order_batch()
returns trigger
language plpgsql
as $$
declare
  batch_row_count bigint;
  batch_organization_count bigint;
  batch_organization_id uuid;
  checkpoint_phase text;
  checkpoint_next_sequence bigint;
  last_public_change_sequence bigint;
  last_observation_key text;
begin
  select count(*), count(distinct organization_id)
    into batch_row_count, batch_organization_count
  from new_catalog_order_rows;
  if batch_row_count = 0 then
    return null;
  end if;
  if batch_organization_count <> 1 then
    raise exception 'normalized Heat catalog order batch crosses organizations'
      using errcode = '55000';
  end if;
  select organization_id
    into batch_organization_id
  from new_catalog_order_rows
  limit 1;

  begin
    select backfill.phase, backfill.next_catalog_order_sequence
      into checkpoint_phase, checkpoint_next_sequence
    from public.normalized_heat_relationship_backfills as backfill
    where backfill.organization_id = batch_organization_id
    for share nowait;
  exception
    when lock_not_available then
      raise exception 'normalized Heat catalog order transition is in progress'
        using errcode = '55000';
  end;
  if checkpoint_phase is distinct from 'catalog_order'
     or checkpoint_next_sequence is null then
    raise exception 'normalized Heat catalog order batch is not active'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from (
      select old_row.observation_kind as old_observation_kind,
             old_row.catalog_order_sequence as old_catalog_order_sequence,
             new_row.catalog_order_sequence as new_catalog_order_sequence,
             row_number() over (
               order by old_row.public_change_sequence asc,
                        old_row.observation_key collate "C" asc
             ) as causal_rank
      from old_catalog_order_rows as old_row
      join new_catalog_order_rows as new_row
        on new_row.id = old_row.id
       and new_row.organization_id = old_row.organization_id
    ) as ranked
    where ranked.old_observation_kind <> 'catalog_snapshot'
       or ranked.old_catalog_order_sequence is not null
       or ranked.new_catalog_order_sequence is distinct from
         checkpoint_next_sequence + ranked.causal_rank - 1
  ) then
    raise exception 'normalized Heat catalog order batch rank is invalid'
      using errcode = '55000';
  end if;

  select old_row.public_change_sequence, old_row.observation_key
    into last_public_change_sequence, last_observation_key
  from old_catalog_order_rows as old_row
  order by old_row.public_change_sequence desc,
           old_row.observation_key collate "C" desc
  limit 1;
  if exists (
    select 1
    from public.normalized_heat_observations as observation
    where observation.organization_id = batch_organization_id
      and observation.observation_kind = 'catalog_snapshot'
      and observation.catalog_order_sequence is null
      and (
        observation.public_change_sequence,
        observation.observation_key collate "C"
      ) < (
        last_public_change_sequence,
        last_observation_key collate "C"
      )
    limit 1
  ) then
    raise exception 'normalized Heat catalog order batch skipped an earlier row'
      using errcode = '55000';
  end if;
  return null;
end;
$$;

create trigger normalized_heat_observations_catalog_order_batch
after update on public.normalized_heat_observations
referencing old table as old_catalog_order_rows
            new table as new_catalog_order_rows
for each statement execute function
  public.validate_normalized_heat_catalog_order_batch();

drop trigger normalized_heat_observation_outcomes_append_only
  on public.normalized_heat_observation_outcomes;
create trigger normalized_heat_observation_outcomes_append_only
before insert or update or delete on public.normalized_heat_observation_outcomes
for each row execute function
  public.protect_normalized_heat_observation_outcome();

-- Once a V1 pull edge is resolved, its identity and causal watermark are
-- immutable. Otherwise a later direct write could silently change evidence
-- already attributed to that relationship.
create function public.protect_resolved_pull_relationship()
returns trigger
language plpgsql
as $$
begin
  if old.resolved_public_change_sequence is not null
     and exists (
       select 1
       from public.canonical_entities as source_entity
       where source_entity.id = old.source_entity_id
         and source_entity.organization_id = old.organization_id
         and source_entity.record_kind = 'pull'
     )
     and (
       (old.relationship_kind = 'pack' and old.target_record_kind = 'pack')
       or (old.relationship_kind = 'card'
         and old.target_record_kind = 'catalog_asset')
     ) then
    raise exception 'resolved pull relationships are immutable'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger canonical_relationships_resolved_pull_immutable
before update or delete on public.canonical_relationships
for each row execute function public.protect_resolved_pull_relationship();
