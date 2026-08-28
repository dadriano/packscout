-- Move buyback-adjusted EV persistence onto the source-native provider
-- lifecycle. The old configuration revision cannot be mapped truthfully to a
-- provider-source revision, so this migration is intentionally fail-closed:
-- derived EV rows must be empty and recomputed from canonical evidence after
-- the code and schema are deployed together.

do $$
begin
  if exists (select 1 from public.buyback_ev_revisions) then
    raise exception using
      errcode = '55000',
      message = 'buyback_ev_revisions must be empty before adopting provider-source revision persistence';
  end if;
end;
$$;

alter table public.buyback_ev_revisions
  drop constraint buyback_ev_revisions_configuration_fk,
  drop constraint buyback_ev_revisions_configuration_tenant_fk;

alter table public.buyback_ev_revisions
  rename column configuration_revision_id to provider_source_revision_id;

alter table public.buyback_ev_revisions
  add column source_instance_id uuid not null,
  add constraint buyback_ev_revisions_provider_source_revision_fk
    foreign key (provider_source_revision_id)
    references public.provider_source_revisions(id)
    on delete restrict,
  add constraint buyback_ev_revisions_provider_source_revision_scope_fk
    foreign key (
      provider_source_revision_id,
      organization_id,
      provider_id,
      source_instance_id
    )
    references public.provider_source_revisions(
      id,
      organization_id,
      provider_id,
      source_instance_id
    )
    on delete restrict;
