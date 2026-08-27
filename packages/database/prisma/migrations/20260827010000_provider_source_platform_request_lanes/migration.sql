-- Supervisor capacity rows are an ephemeral projection owned by the current
-- runtime epoch. Replace that projection in place; durable runs, cursors,
-- claims, and request attempts are intentionally untouched.
delete from public.source_supervisor_profile_states;

alter table public.source_supervisor_profile_states
  rename to source_supervisor_request_lane_states;

alter table public.source_supervisor_request_lane_states
  rename constraint source_supervisor_profile_states_pkey
  to source_supervisor_request_lane_states_pkey;

drop index public.source_supervisor_profile_states_profile_idx;

alter table public.source_supervisor_request_lane_states
  drop constraint source_supervisor_profile_states_scope_unique,
  drop constraint source_supervisor_profile_states_epoch_fk,
  drop constraint source_supervisor_profile_states_profile_fk,
  drop constraint source_supervisor_profile_states_capacity_check,
  add column request_scope text not null,
  add column provider_id uuid,
  add column lane_key text not null,
  add constraint source_supervisor_request_lane_states_epoch_fk
    foreign key (supervisor_epoch_id)
    references public.source_supervisor_epochs(id)
    on delete cascade,
  add constraint source_supervisor_request_lane_states_profile_fk
    foreign key (connection_profile_id, organization_id)
    references public.source_connection_profiles(id, organization_id),
  add constraint source_supervisor_request_lane_states_provider_fk
    foreign key (provider_id, organization_id)
    references public.provider_sources(id, organization_id),
  add constraint source_supervisor_request_lane_states_capacity_check
    check (
      approved_request_limit between 1 and 2
      and active_request_permits between 0 and approved_request_limit
      and waiting_operations between 0 and 2147483647
    ),
  add constraint source_supervisor_request_lane_states_identity_check
    check (
      (
        request_scope = 'platform'
        and provider_id is not null
        and lane_key = provider_id::text
      )
      or (
        request_scope = 'connection_test'
        and provider_id is null
        and lane_key = 'connection_test'
      )
    ),
  add constraint source_supervisor_request_lane_states_scope_unique
    unique (
      supervisor_epoch_id,
      organization_id,
      connection_profile_id,
      lane_key
    );

create index source_supervisor_request_lane_states_profile_idx
  on public.source_supervisor_request_lane_states
  (organization_id, connection_profile_id, lane_key, updated_at);

-- Rename the durable admission reason in place. Runtime progress and retry
-- budgets remain untouched; only the source-neutral diagnostic vocabulary
-- changes from an aggregate profile to the exact request lane.
alter table public.provider_source_runtime_states
  drop constraint provider_source_runtime_states_wait_reason_check;

update public.provider_source_runtime_states
set wait_reason = 'request_lane_capacity'
where wait_reason = 'profile_capacity';

alter table public.provider_source_runtime_states
  add constraint provider_source_runtime_states_wait_reason_check
  check (
    wait_reason is null
    or wait_reason in (
      'not_due', 'request_lane_capacity', 'execution_capacity',
      'capacity_blocked', 'connection_blocked', 'paused',
      'retry_backoff', 'action_required', 'supervisor_offline',
      'graceful_shutdown', 'source_lane_busy'
    )
  );
