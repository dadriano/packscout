-- The central manifest-promotion daemon uses a durable provider keyset so one
-- pass performs only a fixed number of index seeks. Archived providers remain
-- eligible because the cursor is driven by retained projection truth, not the
-- active roster.
-- Protected manifest rows consume the same 50,000-row cap as unprotected rows,
-- so the rank index must cover every terminal summary.
drop index public.manifest_reconciliation_job_invocations_retention_idx;
create index manifest_reconciliation_job_invocations_retention_idx
  on public.manifest_reconciliation_job_invocations
    (finished_at desc, run_id desc)
  where lifecycle_state = 'terminal';

create table public.provider_promotion_projection_retention_state (
  singleton_key boolean primary key default true,
  after_provider_id uuid,
  row_version bigint not null default 1,
  updated_at timestamptz(6) not null default now(),
  constraint provider_promotion_projection_retention_singleton_check
    check (singleton_key = true),
  constraint provider_promotion_projection_retention_version_check
    check (row_version >= 1)
);

insert into public.provider_promotion_projection_retention_state
  (singleton_key) values (true);

create trigger provider_promotion_projection_retention_version_guard
  before update on public.provider_promotion_projection_retention_state
  for each row execute function public.packscout_enforce_row_version();

create index provider_promotion_invocation_projections_retention_age_idx
  on public.provider_promotion_invocation_projections (finished_at, id);

create index provider_promotion_invocation_projections_retention_rank_idx
  on public.provider_promotion_invocation_projections
    (provider_id, finished_at desc, id desc);
