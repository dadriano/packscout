create table public.approved_public_catalog_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  configuration_key text not null,
  revision integer not null,
  configuration_json jsonb not null,
  configuration_hash text not null,
  approved_at timestamptz(6) not null,
  public_change_sequence bigint not null,
  created_at timestamptz(6) not null default current_timestamp,
  constraint approved_public_catalog_configurations_organization_fk
    foreign key (organization_id)
    references public.organizations(id)
    on update no action on delete restrict,
  constraint approved_public_catalog_configurations_public_change_fk
    foreign key (organization_id, public_change_sequence)
    references public.public_change_causes(organization_id, sequence)
    on update no action on delete restrict,
  constraint approved_public_catalog_configurations_key_bounded
    check (
      configuration_key = btrim(configuration_key)
      and char_length(configuration_key) between 1 and 128
      and configuration_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  constraint approved_public_catalog_configurations_revision_positive
    check (revision > 0),
  constraint approved_public_catalog_configurations_hash_valid
    check (configuration_hash ~ '^[0-9a-f]{64}$'),
  constraint approved_public_catalog_configurations_json_object
    check (jsonb_typeof(configuration_json) = 'object')
);

alter table public.approved_public_catalog_configurations
  add constraint approved_public_catalog_configurations_key_unique
    unique (organization_id, configuration_key),
  add constraint approved_public_catalog_configurations_revision_unique
    unique (organization_id, revision),
  add constraint approved_public_catalog_configurations_hash_unique
    unique (organization_id, configuration_hash),
  add constraint approved_public_catalog_configurations_mapping_source_unique
    unique (organization_id, configuration_key, public_change_sequence);

create index approved_public_catalog_configurations_change_idx
  on public.approved_public_catalog_configurations
    (organization_id, public_change_sequence);

create function public.reject_approved_public_catalog_configuration_mutation()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'approved public catalog configurations are immutable'
    using errcode = '55000';
end;
$function$;

create trigger approved_public_catalog_configurations_immutable
before update or delete on public.approved_public_catalog_configurations
for each row execute function
  public.reject_approved_public_catalog_configuration_mutation();
