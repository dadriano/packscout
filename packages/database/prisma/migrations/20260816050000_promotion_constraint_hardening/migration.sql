-- Harden publication/retention state checks against PostgreSQL's rule that a
-- CHECK constraint accepts both TRUE and NULL. The preceding migrations used
-- STRICT validators such as promotion_v2_sha256_valid and nullable bodies in
-- several state branches, so a missing required value could make the complete
-- predicate NULL instead of FALSE.
--
-- Legacy populated-upgrade residual: this append-only migration cannot run
-- before 20260815010000_public_change_settlement. An installation upgrading
-- from the pre-settlement baseline must still preflight (a) relationships whose
-- source entity has no canonical revision and (b) non-null historical
-- estimated_ev_recomputation_requests.failure_code values that do not match
-- ^[A-Za-z][A-Za-z0-9_]{0,127}$. Either condition can make that earlier applied
-- migration fail before control reaches this migration. Fresh databases and
-- databases whose application tables were emptied before the full deploy do
-- not carry that legacy risk.

begin;

do $promotion_constraint_hardening$
declare
  target record;
  predicate text;
  invalid_rows_present boolean;
begin
  for target in
    select *
    from (values
      ('public_derivation_obligations',
        'public_derivation_obligations_outcome_consistency'),
      ('promotion_lanes', 'promotion_lanes_bootstrap_shape_check'),
      ('promotion_attempts', 'promotion_attempts_failure_shape_check'),
      ('promotion_attempts', 'promotion_attempts_terminal_shape_check'),
      ('promotion_operations', 'promotion_operations_delivery_shape_check'),
      ('provider_promotion_lanes',
        'provider_promotion_lanes_completed_shape_check'),
      ('provider_promotion_attempts',
        'provider_promotion_attempts_prepared_check'),
      ('provider_promotion_attempts',
        'provider_promotion_attempts_claim_check'),
      ('provider_promotion_attempts',
        'provider_promotion_attempts_failure_check'),
      ('provider_promotion_attempts',
        'provider_promotion_attempts_cas_check'),
      ('provider_promotion_attempts',
        'provider_promotion_attempts_terminal_check'),
      ('provider_promotion_operations',
        'provider_promotion_operations_delivery_check'),
      ('manifest_promotion_lanes', 'manifest_promotion_lanes_bootstrap_check'),
      ('manifest_promotion_lanes',
        'manifest_promotion_lanes_active_shape_check'),
      ('manifest_promotion_attempts',
        'manifest_promotion_attempts_prepared_check'),
      ('manifest_promotion_attempts',
        'manifest_promotion_attempts_snapshot_check'),
      ('manifest_promotion_attempts',
        'manifest_promotion_attempts_claim_check'),
      ('manifest_promotion_attempts',
        'manifest_promotion_attempts_failure_check'),
      ('manifest_promotion_attempts',
        'manifest_promotion_attempts_cas_check'),
      ('manifest_promotion_attempts',
        'manifest_promotion_attempts_terminal_check'),
      ('manifest_promotion_operations',
        'manifest_promotion_operations_delivery_check'),
      ('catalog_promotion_bootstrap_proofs',
        'catalog_promotion_bootstrap_proofs_manifest_shape_check'),
      ('catalog_promotion_bootstrap_provider_proofs',
        'catalog_promotion_bootstrap_provider_proofs_value_check'),
      ('catalog_promotion_retention_barriers',
        'catalog_promotion_retention_barriers_state_check'),
      ('catalog_promotion_retention_operations',
        'catalog_promotion_retention_operations_state_check'),
      ('catalog_promotion_retention_operations',
        'catalog_promotion_retention_operations_selection_check')
    ) as hardened(table_name, constraint_name)
  loop
    select pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    into predicate
    from pg_constraint as constraint_row
    join pg_class as table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relname = target.table_name
      and constraint_row.conname = target.constraint_name
      and constraint_row.contype = 'c';

    if predicate is null then
      raise exception 'promotion constraint hardening prerequisite is missing: %.%',
        target.table_name, target.constraint_name
        using errcode = '55000';
    end if;

    execute format(
      'select exists (select 1 from public.%I where (%s) is not true)',
      target.table_name,
      predicate
    ) into invalid_rows_present;

    if invalid_rows_present then
      raise exception 'promotion constraint hardening preflight failed: %.%',
        target.table_name, target.constraint_name
        using errcode = '23514';
    end if;

    execute format(
      'alter table public.%I drop constraint %I',
      target.table_name,
      target.constraint_name
    );
    execute format(
      'alter table public.%I add constraint %I check ((%s) is true)',
      target.table_name,
      target.constraint_name,
      predicate
    );
  end loop;
end;
$promotion_constraint_hardening$;

-- Guarded promotion-table writes take FOR SHARE on organizations. Activation
-- takes the conflicting FOR UPDATE lock on that same row, so every write that
-- observed the inactive barrier commits before the active state becomes
-- visible. Direct insertion of an already-active barrier follows the same
-- protocol and cannot bypass serialization.
create function public.lock_catalog_promotion_retention_activation()
returns trigger
language plpgsql
as $$
declare
  activation_requested boolean := false;
begin
  if tg_op = 'INSERT' then
    activation_requested := new.state = 'active';
  elsif tg_op = 'UPDATE' then
    activation_requested := old.state <> 'active' and new.state = 'active';
  end if;

  if activation_requested then
    perform 1
    from public.organizations
    where id = new.organization_id
    for update;
    if not found then
      raise exception 'catalog retention barrier organization is unavailable'
        using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

create trigger catalog_promotion_retention_barriers_activation_lock
before insert or update on public.catalog_promotion_retention_barriers
for each row execute function
  public.lock_catalog_promotion_retention_activation();

commit;
