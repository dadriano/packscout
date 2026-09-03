alter table public.source_connection_test_jobs
  add column queued_at timestamptz;

update public.source_connection_test_jobs
set queued_at = created_at
where queued_at is null;

alter table public.source_connection_test_jobs
  alter column queued_at set not null,
  alter column queued_at set default clock_timestamp();

alter table public.provider_source_test_jobs
  add column queued_at timestamptz;

update public.provider_source_test_jobs
set queued_at = created_at
where queued_at is null;

alter table public.provider_source_test_jobs
  alter column queued_at set not null,
  alter column queued_at set default clock_timestamp();

drop index public.source_connection_test_jobs_queue_idx;
drop index public.provider_source_test_jobs_queue_idx;

create index source_connection_test_jobs_runtime_queue_idx
  on public.source_connection_test_jobs (organization_id, state, queued_at);
create index provider_source_test_jobs_runtime_queue_idx
  on public.provider_source_test_jobs (organization_id, state, queued_at);

alter table public.source_supervisor_epochs
  add column maximum_execution_slots integer not null default 4,
  add column active_execution_slots integer not null default 0,
  add column capacity_state text not null default 'available',
  add column capacity_safe_code text,
  add column capacity_checked_at timestamptz,
  add column snapshot_updated_at timestamptz,
  add constraint source_supervisor_epochs_execution_capacity_check
    check (
      maximum_execution_slots between 1 and 64
      and active_execution_slots between 0 and maximum_execution_slots
    ),
  add constraint source_supervisor_epochs_capacity_state_check
    check (capacity_state in ('available', 'blocked', 'probe_failed')),
  add constraint source_supervisor_epochs_capacity_code_check
    check (
      (capacity_state = 'available' and capacity_safe_code is null)
      or (
        capacity_state <> 'available'
        and capacity_safe_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
      )
    );

create table public.source_supervisor_profile_states (
  id uuid primary key default gen_random_uuid(),
  supervisor_epoch_id uuid not null,
  organization_id uuid not null,
  connection_profile_id uuid not null,
  approved_request_limit integer not null,
  active_request_permits integer not null default 0,
  waiting_operations integer not null default 0,
  updated_at timestamptz not null,
  constraint source_supervisor_profile_states_epoch_fk
    foreign key (supervisor_epoch_id)
    references public.source_supervisor_epochs(id)
    on delete cascade,
  constraint source_supervisor_profile_states_profile_fk
    foreign key (connection_profile_id, organization_id)
    references public.source_connection_profiles(id, organization_id),
  constraint source_supervisor_profile_states_capacity_check
    check (
      approved_request_limit between 1 and 64
      and active_request_permits between 0 and approved_request_limit
      and waiting_operations between 0 and 2147483647
    ),
  constraint source_supervisor_profile_states_scope_unique
    unique (supervisor_epoch_id, organization_id, connection_profile_id)
);

create index source_supervisor_profile_states_profile_idx
  on public.source_supervisor_profile_states
  (organization_id, connection_profile_id, updated_at);

create unique index import_runs_runtime_scope_unique
  on public.import_runs (
    id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  );

-- Terminal request proof retains immutable run/source/connection identity, but
-- must not keep mutable lease owner/token columns alive after a safe turn or
-- recovery finalizer clears the claim. Admission still compares those claim
-- fields before inserting the attempt; historical FKs bind the durable scope.
alter table public.source_request_attempts
  drop constraint source_request_attempts_run_fk,
  add constraint source_request_attempts_run_fk
  foreign key (
    run_id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) references public.import_runs (
    id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) on delete restrict on update no action;

alter table public.compact_source_request_attempts
  drop constraint compact_source_request_attempts_run_fk,
  add constraint compact_source_request_attempts_run_fk
  foreign key (
    run_id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) references public.import_runs (
    id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) on delete restrict on update no action;

-- Terminal request proof also retains immutable test-job identity without
-- pinning the mutable claim columns. This permits an expired, terminally
-- captured request/result gap to be reclaimed only after its old lease ends.
alter table public.source_request_attempts
  drop constraint source_request_attempts_connection_job_fk,
  add constraint source_request_attempts_connection_job_fk
  foreign key (
    connection_test_job_id,
    organization_id,
    connection_profile_id,
    connection_revision_id
  ) references public.source_connection_test_jobs (
    id,
    organization_id,
    connection_profile_id,
    connection_revision_id
  ) on delete restrict on update no action,
  drop constraint source_request_attempts_source_job_fk,
  add constraint source_request_attempts_source_job_fk
  foreign key (
    source_test_job_id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) references public.provider_source_test_jobs (
    id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) on delete restrict on update no action;

alter table public.compact_source_request_attempts
  drop constraint compact_source_request_attempts_connection_job_fk,
  add constraint compact_source_request_attempts_connection_job_fk
  foreign key (
    connection_test_job_id,
    organization_id,
    connection_profile_id,
    connection_revision_id
  ) references public.source_connection_test_jobs (
    id,
    organization_id,
    connection_profile_id,
    connection_revision_id
  ) on delete restrict on update no action,
  drop constraint compact_source_request_attempts_source_job_fk,
  add constraint compact_source_request_attempts_source_job_fk
  foreign key (
    source_test_job_id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) references public.provider_source_test_jobs (
    id,
    organization_id,
    provider_id,
    source_instance_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id
  ) on delete restrict on update no action;

create table public.provider_source_runtime_states (
  source_instance_id uuid primary key,
  organization_id uuid not null,
  provider_id uuid not null,
  source_revision_id uuid not null,
  connection_profile_id uuid not null,
  connection_revision_id uuid not null,
  supervisor_epoch_id uuid,
  phase text not null,
  activity text not null,
  wait_reason text,
  action_required_code text,
  current_run_id uuid,
  run_lease_acquired_at timestamptz,
  run_lease_expires_at timestamptz,
  retry_attempt integer not null default 0,
  retry_not_before timestamptz,
  pages_committed integer not null default 0,
  records_committed integer not null default 0,
  run_started_at timestamptz,
  last_progress_at timestamptz,
  cursor_fingerprint text,
  continuation_kind public.source_continuation_kind,
  continuation_minimum_delay_seconds integer,
  next_due_at timestamptz,
  blocking_episode_id uuid,
  blocking_health_generation bigint,
  queued_at timestamptz,
  updated_at timestamptz not null,
  constraint provider_source_runtime_states_source_fk
    foreign key (source_instance_id, organization_id, provider_id)
    references public.provider_source_instances(id, organization_id, provider_id),
  constraint provider_source_runtime_states_revision_fk
    foreign key (
      source_revision_id,
      organization_id,
      provider_id,
      source_instance_id
    ) references public.provider_source_revisions(
      id,
      organization_id,
      provider_id,
      source_instance_id
    ),
  constraint provider_source_runtime_states_profile_fk
    foreign key (connection_profile_id, organization_id)
    references public.source_connection_profiles(id, organization_id),
  constraint provider_source_runtime_states_connection_revision_fk
    foreign key (
      connection_revision_id,
      organization_id,
      connection_profile_id
    ) references public.source_connection_revisions(
      id,
      organization_id,
      connection_profile_id
    ),
  constraint provider_source_runtime_states_epoch_fk
    foreign key (supervisor_epoch_id)
    references public.source_supervisor_epochs(id),
  constraint provider_source_runtime_states_run_fk
    foreign key (
      current_run_id,
      organization_id,
      provider_id,
      source_instance_id,
      source_revision_id,
      connection_profile_id,
      connection_revision_id
    ) references public.import_runs(
      id,
      organization_id,
      provider_id,
      source_instance_id,
      source_revision_id,
      connection_profile_id,
      connection_revision_id
    ),
  constraint provider_source_runtime_states_episode_fk
    foreign key (
      blocking_episode_id,
      organization_id,
      connection_profile_id,
      connection_revision_id
    ) references public.source_connection_health_episodes(
      id,
      organization_id,
      connection_profile_id,
      connection_revision_id
    ),
  constraint provider_source_runtime_states_phase_check
    check (phase in (
      'idle', 'due', 'queued', 'claimed', 'requesting', 'validating',
      'committing', 'retry_wait', 'waiting', 'paused', 'action_required',
      'reached_head', 'terminal'
    )),
  constraint provider_source_runtime_states_activity_check
    check (activity in (
      'inactive', 'queued', 'running', 'waiting', 'paused', 'action_required'
    )),
  constraint provider_source_runtime_states_wait_reason_check
    check (
      wait_reason is null
      or wait_reason in (
        'not_due', 'profile_capacity', 'execution_capacity',
        'capacity_blocked', 'connection_blocked', 'paused',
        'retry_backoff', 'action_required', 'supervisor_offline',
        'graceful_shutdown', 'source_lane_busy'
      )
    ),
  constraint provider_source_runtime_states_action_code_check
    check (
      action_required_code is null
      or action_required_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
    ),
  constraint provider_source_runtime_states_cursor_check
    check (
      cursor_fingerprint is null
      or cursor_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  constraint provider_source_runtime_states_counts_check
    check (
      retry_attempt between 0 and 2147483647
      and pages_committed between 0 and 2147483647
      and records_committed between 0 and 2147483647
      and (blocking_health_generation is null or blocking_health_generation >= 0)
      and (
        continuation_minimum_delay_seconds is null
        or continuation_minimum_delay_seconds between 0 and 86400
      )
    ),
  constraint provider_source_runtime_states_continuation_check
    check (
      (continuation_kind = 'poll_after'::public.source_continuation_kind
        and continuation_minimum_delay_seconds is not null)
      or (continuation_kind = 'continue'::public.source_continuation_kind
        and continuation_minimum_delay_seconds is null)
      or (continuation_kind is null
        and continuation_minimum_delay_seconds is null)
    ),
  constraint provider_source_runtime_states_wait_shape_check
    check (
      (activity = 'waiting' and wait_reason is not null)
      or (activity <> 'waiting' and wait_reason is null)
    ),
  constraint provider_source_runtime_states_action_shape_check
    check (
      (activity = 'action_required' and action_required_code is not null)
      or (activity <> 'action_required' and action_required_code is null)
    ),
  constraint provider_source_runtime_states_block_shape_check
    check (
      (blocking_episode_id is null and blocking_health_generation is null)
      or (blocking_episode_id is not null and blocking_health_generation is not null)
    ),
  constraint provider_source_runtime_states_scope_unique
    unique (
      source_instance_id,
      organization_id,
      provider_id,
      source_revision_id,
      connection_profile_id,
      connection_revision_id
    )
);

create index provider_source_runtime_states_activity_idx
  on public.provider_source_runtime_states
  (organization_id, activity, updated_at);

create index provider_source_runtime_states_epoch_idx
  on public.provider_source_runtime_states
  (supervisor_epoch_id, updated_at);

insert into public.provider_source_runtime_states (
  source_instance_id,
  organization_id,
  provider_id,
  source_revision_id,
  connection_profile_id,
  connection_revision_id,
  phase,
  activity,
  wait_reason,
  cursor_fingerprint,
  next_due_at,
  updated_at
)
select
  source.id,
  source.organization_id,
  source.provider_id,
  source.active_revision_id,
  source.connection_profile_id,
  connection_revision.id,
  case source.state
    when 'active' then 'idle'
    when 'paused' then 'paused'
    else 'terminal'
  end,
  case source.state
    when 'active' then 'inactive'
    when 'paused' then 'paused'
    else 'inactive'
  end,
  null,
  cursor.cursor_fingerprint,
  schedule.next_due_at,
  clock_timestamp()
from public.provider_source_instances as source
join public.provider_source_cursors as cursor
  on cursor.source_instance_id = source.id
 and cursor.organization_id = source.organization_id
 and cursor.provider_id = source.provider_id
left join public.provider_source_schedules as schedule
  on schedule.source_instance_id = source.id
 and schedule.organization_id = source.organization_id
 and schedule.provider_id = source.provider_id
join lateral (
  select revision.id
  from public.source_connection_revisions as revision
  where revision.organization_id = source.organization_id
    and revision.connection_profile_id = source.connection_profile_id
  order by
    (revision.id = (
      select profile.active_revision_id
      from public.source_connection_profiles as profile
      where profile.id = source.connection_profile_id
        and profile.organization_id = source.organization_id
    )) desc,
    revision.revision_number desc,
    revision.id
  limit 1
) as connection_revision on true
where source.active_revision_id is not null;

create or replace function public.sync_provider_source_runtime_lifecycle()
returns trigger
language plpgsql
as $$
declare
  lifecycle_changed boolean := true;
  pins_changed boolean := true;
  pinned_connection_revision_id uuid;
begin
  if tg_op = 'UPDATE' then
    lifecycle_changed := old.state is distinct from new.state;
  end if;
  if new.active_revision_id is null then
    return new;
  end if;

  select coalesce(
    profile.active_revision_id,
    (
      select revision.id
      from public.source_connection_revisions as revision
      where revision.organization_id = new.organization_id
        and revision.connection_profile_id = new.connection_profile_id
      order by revision.revision_number desc, revision.id
      limit 1
    )
  )
  into pinned_connection_revision_id
  from public.source_connection_profiles as profile
  where profile.id = new.connection_profile_id
    and profile.organization_id = new.organization_id;

  if pinned_connection_revision_id is null then
    return new;
  end if;

  select
    runtime.source_revision_id <> new.active_revision_id
    or runtime.connection_profile_id <> new.connection_profile_id
    or runtime.connection_revision_id <> pinned_connection_revision_id
  into pins_changed
  from public.provider_source_runtime_states as runtime
  where runtime.source_instance_id = new.id;
  pins_changed := coalesce(pins_changed, true);

  insert into public.provider_source_runtime_states (
    source_instance_id,
    organization_id,
    provider_id,
    source_revision_id,
    connection_profile_id,
    connection_revision_id,
    phase,
    activity,
    wait_reason,
    updated_at
  ) values (
    new.id,
    new.organization_id,
    new.provider_id,
    new.active_revision_id,
    new.connection_profile_id,
    pinned_connection_revision_id,
    case new.state
      when 'active' then 'idle'
      when 'paused' then 'paused'
      else 'terminal'
    end,
    case new.state
      when 'active' then 'inactive'
      when 'paused' then 'paused'
      else 'inactive'
    end,
    null,
    clock_timestamp()
  )
  on conflict (source_instance_id) do update
  set source_revision_id = excluded.source_revision_id,
      connection_profile_id = excluded.connection_profile_id,
      connection_revision_id = excluded.connection_revision_id,
      phase = case
        when not pins_changed
          and provider_source_runtime_states.activity = 'action_required'
          and new.state in ('active', 'paused')
          then provider_source_runtime_states.phase
        when pins_changed or lifecycle_changed then excluded.phase
        else provider_source_runtime_states.phase
      end,
      activity = case
        when not pins_changed
          and provider_source_runtime_states.activity = 'action_required'
          and new.state in ('active', 'paused')
          then provider_source_runtime_states.activity
        when pins_changed or lifecycle_changed then excluded.activity
        else provider_source_runtime_states.activity
      end,
      wait_reason = case
        when not pins_changed
          and provider_source_runtime_states.activity = 'action_required'
          and new.state in ('active', 'paused')
          then provider_source_runtime_states.wait_reason
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.wait_reason
      end,
      action_required_code = case
        when not pins_changed
          and provider_source_runtime_states.activity = 'action_required'
          and new.state in ('active', 'paused')
          then provider_source_runtime_states.action_required_code
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.action_required_code
      end,
      supervisor_epoch_id = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.supervisor_epoch_id
      end,
      current_run_id = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.current_run_id
      end,
      run_lease_acquired_at = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.run_lease_acquired_at
      end,
      run_lease_expires_at = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.run_lease_expires_at
      end,
      retry_attempt = case
        when pins_changed or lifecycle_changed then 0
        else provider_source_runtime_states.retry_attempt
      end,
      retry_not_before = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.retry_not_before
      end,
      blocking_episode_id = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.blocking_episode_id
      end,
      blocking_health_generation = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.blocking_health_generation
      end,
      queued_at = case
        when pins_changed or lifecycle_changed then null
        else provider_source_runtime_states.queued_at
      end,
      updated_at = clock_timestamp();

  return new;
end;
$$;

create trigger provider_source_runtime_lifecycle_sync_trigger
after insert or update of active_revision_id, state
on public.provider_source_instances
for each row execute function public.sync_provider_source_runtime_lifecycle();

create or replace function public.sync_provider_source_runtime_connection()
returns trigger
language plpgsql
as $$
begin
  if new.active_revision_id is null
    or new.active_revision_id is not distinct from old.active_revision_id then
    return new;
  end if;

  update public.provider_source_runtime_states
  set connection_revision_id = new.active_revision_id,
      updated_at = clock_timestamp()
  where organization_id = new.organization_id
    and connection_profile_id = new.id
    and current_run_id is null
    and run_lease_acquired_at is null
    and not exists (
      select 1
      from public.provider_source_test_jobs as job
      where job.organization_id = provider_source_runtime_states.organization_id
        and job.source_instance_id = provider_source_runtime_states.source_instance_id
        and job.connection_profile_id = provider_source_runtime_states.connection_profile_id
        and job.state in (
          'queued'::public.source_test_job_state,
          'running'::public.source_test_job_state
        )
    );

  return new;
end;
$$;

create trigger provider_source_runtime_connection_sync_trigger
after update of active_revision_id
on public.source_connection_profiles
for each row execute function public.sync_provider_source_runtime_connection();
