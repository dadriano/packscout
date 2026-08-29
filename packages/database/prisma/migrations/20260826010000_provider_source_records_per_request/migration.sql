alter table public.provider_source_schedule_revisions
  add column records_per_request integer not null default 500,
  add constraint provider_source_schedule_revisions_records_per_request_check
    check (records_per_request between 1 and 5000);

alter table public.provider_source_test_jobs
  add column records_per_request integer not null default 500,
  add constraint provider_source_test_jobs_records_per_request_check
    check (records_per_request between 1 and 5000);

alter table public.provider_source_test_jobs
  alter column records_per_request drop default;

alter table public.import_runs
  add column records_per_request integer;

update public.import_runs
set records_per_request = 500
where source_instance_id is not null;

alter table public.import_runs
  add constraint import_runs_records_per_request_check
    check (
      (source_instance_id is null and records_per_request is null)
      or
      (
        source_instance_id is not null
        and records_per_request is not null
        and records_per_request between 1 and 5000
      )
    );

create or replace function public.enforce_import_run_source_pin_immutability()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.source_instance_id is not null
    and (
      new.organization_id is distinct from old.organization_id
      or new.provider_id is distinct from old.provider_id
      or new.source_instance_id is distinct from old.source_instance_id
      or new.source_revision_id is distinct from old.source_revision_id
      or new.source_type_key is distinct from old.source_type_key
      or new.source_adapter_version is distinct from old.source_adapter_version
      or new.normalized_contract_version is distinct from old.normalized_contract_version
      or new.mapper_key is distinct from old.mapper_key
      or new.mapper_version is distinct from old.mapper_version
      or new.identity_namespace_key is distinct from old.identity_namespace_key
      or new.connection_profile_id is distinct from old.connection_profile_id
      or new.connection_revision_id is distinct from old.connection_revision_id
      or new.cursor_codec_version is distinct from old.cursor_codec_version
      or new.cursor_generation is distinct from old.cursor_generation
      or new.requested_cursor is distinct from old.requested_cursor
      or new.requested_cursor_fingerprint is distinct from old.requested_cursor_fingerprint
      or new.requested_cursor_key is distinct from old.requested_cursor_key
      or new.records_per_request is distinct from old.records_per_request
    )
  then
    raise exception 'source-owned import run pins are immutable'
      using errcode = '23514',
            constraint = 'import_runs_source_pins_immutable_guard';
  end if;

  return new;
end;
$$;

drop trigger import_run_source_pins_immutable_guard on public.import_runs;

create trigger import_run_source_pins_immutable_guard
before update of
  organization_id,
  provider_id,
  source_instance_id,
  source_revision_id,
  source_type_key,
  source_adapter_version,
  normalized_contract_version,
  mapper_key,
  mapper_version,
  identity_namespace_key,
  connection_profile_id,
  connection_revision_id,
  cursor_codec_version,
  cursor_generation,
  requested_cursor,
  requested_cursor_fingerprint,
  requested_cursor_key,
  records_per_request
on public.import_runs
for each row
execute function public.enforce_import_run_source_pin_immutability();

create function public.enforce_source_test_records_per_request_immutability()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.records_per_request is distinct from old.records_per_request then
    raise exception 'source-test records-per-request pin is immutable'
      using errcode = '23514',
            constraint = 'provider_source_test_jobs_records_per_request_immutable_guard';
  end if;

  return new;
end;
$$;

create trigger provider_source_test_jobs_records_per_request_immutable_guard
before update of records_per_request
on public.provider_source_test_jobs
for each row
execute function public.enforce_source_test_records_per_request_immutability();
