-- Task 013: durable PostgreSQL barrier and exact local cleanup journal for
-- catalog-manifest/provider-release retention. Convex remains authoritative for
-- artifact selection; PostgreSQL only removes the exact selected provider graph.

create table public.catalog_promotion_retention_barriers (
  organization_id uuid not null,
  deployment_key text not null,
  barrier_generation bigint not null default 0,
  barrier_token uuid,
  state text not null default 'inactive',
  retention_generation bigint not null default 0,
  next_operation_index integer not null default 0,
  manifest_phase_complete boolean not null default false,
  snapshot_body text,
  snapshot_digest text,
  activated_at timestamp(6) with time zone,
  completed_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint catalog_promotion_retention_barriers_pkey primary key (
    organization_id, deployment_key
  ),
  constraint catalog_promotion_retention_barriers_organization_fk foreign key (
    organization_id
  ) references public.organizations(id),
  constraint catalog_promotion_retention_barriers_key_check check (
    public.promotion_v2_deployment_key_valid(deployment_key)
  ),
  constraint catalog_promotion_retention_barriers_sequence_check check (
    barrier_generation >= 0
    and retention_generation between 0 and 9007199254740991
    and next_operation_index between 0 and 2147483647
  ),
  constraint catalog_promotion_retention_barriers_state_check check (
    state in ('inactive', 'active')
    and (
      (state = 'inactive' and barrier_token is null
        and snapshot_body is null and snapshot_digest is null)
      or
      (state = 'active' and barrier_generation > 0 and barrier_token is not null
        and octet_length(snapshot_body) between 2 and 262144
        and public.promotion_v2_sha256_valid(snapshot_digest)
        and activated_at is not null and completed_at is null)
    )
  )
);

create table public.catalog_promotion_retention_operations (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  deployment_key text not null,
  barrier_generation bigint not null,
  operation_index integer not null,
  operation_id text not null,
  idempotency_key text not null,
  operation_kind text not null,
  phase text not null,
  platform_key text,
  expected_retention_generation bigint not null,
  canonical_request_body text not null,
  request_sha256 text not null,
  state text not null default 'pending',
  send_count integer not null default 0,
  last_sent_at timestamp(6) with time zone,
  acknowledged_at timestamp(6) with time zone,
  canonical_receipt_body text,
  receipt_sha256 text,
  exact_response_body text,
  response_sha256 text,
  terminal_state text,
  has_more boolean,
  selected_platform_key text,
  selected_public_provider_release_id uuid,
  selected_provider_release_fingerprint text,
  postgres_cleanup_complete boolean not null default false,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint catalog_promotion_retention_operations_pkey primary key (id),
  constraint catalog_promotion_retention_operations_scope_unique unique (
    organization_id, deployment_key, operation_id
  ),
  constraint catalog_promotion_retention_operations_index_unique unique (
    organization_id, deployment_key, barrier_generation, operation_index
  ),
  constraint catalog_promotion_retention_operations_generation_unique unique (
    organization_id, deployment_key, expected_retention_generation
  ),
  constraint catalog_promotion_retention_operations_barrier_fk foreign key (
    organization_id, deployment_key
  ) references public.catalog_promotion_retention_barriers (
    organization_id, deployment_key
  ),
  constraint catalog_promotion_retention_operations_identity_check check (
    barrier_generation > 0 and operation_index between 0 and 2147483647
    and operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and idempotency_key = operation_id
    and operation_kind in ('retainManifests', 'retainProviderReleases')
    and phase in ('manifests', 'provider_releases')
    and (operation_kind = 'retainManifests') = (phase = 'manifests')
    and (phase = 'manifests') = (platform_key is null)
    and (platform_key is null or
      public.promotion_v2_platform_key_valid(platform_key))
    and expected_retention_generation between 0 and 9007199254740991
    and octet_length(canonical_request_body) between 2 and 262144
    and public.promotion_v2_sha256_valid(request_sha256)
  ),
  constraint catalog_promotion_retention_operations_state_check check (
    state in ('pending', 'sent', 'acknowledged') and send_count >= 0 and (
      (state = 'pending' and send_count = 0 and last_sent_at is null
        and acknowledged_at is null and canonical_receipt_body is null
        and receipt_sha256 is null and exact_response_body is null
        and response_sha256 is null and terminal_state is null
        and has_more is null and selected_platform_key is null
        and selected_public_provider_release_id is null
        and selected_provider_release_fingerprint is null
        and postgres_cleanup_complete = false)
      or
      (state = 'sent' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is null and canonical_receipt_body is null
        and receipt_sha256 is null and exact_response_body is null
        and response_sha256 is null and terminal_state is null
        and has_more is null and selected_platform_key is null
        and selected_public_provider_release_id is null
        and selected_provider_release_fingerprint is null
        and postgres_cleanup_complete = false)
      or
      (state = 'acknowledged' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is not null
        and octet_length(canonical_receipt_body) between 2 and 393216
        and public.promotion_v2_sha256_valid(receipt_sha256)
        and octet_length(exact_response_body) between 2 and 524288
        and public.promotion_v2_sha256_valid(response_sha256)
        and terminal_state in ('complete', 'continuation_required')
        and has_more = (terminal_state = 'continuation_required'))
    )
  ),
  constraint catalog_promotion_retention_operations_selection_check check (
    (selected_platform_key is null) =
      (selected_public_provider_release_id is null)
    and (selected_platform_key is null) =
      (selected_provider_release_fingerprint is null)
    and (selected_platform_key is null or (
      phase = 'provider_releases'
      and selected_platform_key = platform_key
      and public.promotion_v2_platform_key_valid(selected_platform_key)
      and public.promotion_v2_sha256_valid(
        selected_provider_release_fingerprint
      )
    ))
    and (
      (state <> 'acknowledged' and postgres_cleanup_complete = false
        and selected_platform_key is null)
      or
      (state = 'acknowledged'
        and (postgres_cleanup_complete or selected_platform_key is not null))
    )
  )
);

create index catalog_promotion_retention_operations_resume_idx
  on public.catalog_promotion_retention_operations (
    organization_id, deployment_key, barrier_generation, operation_index
  ) where state <> 'acknowledged' or postgres_cleanup_complete = false;

create function public.catalog_promotion_retention_delete_authorized(
  target_organization_id uuid,
  target_deployment_key text
)
returns boolean language sql stable as $$
  select exists (
    select 1
    from public.catalog_promotion_retention_barriers as barrier
    where barrier.organization_id = target_organization_id
      and barrier.deployment_key = target_deployment_key
      and barrier.state = 'active'
      and barrier.barrier_token::text = current_setting(
        'packscout.catalog_retention_delete_token', true
      )
  )
$$;

create function public.guard_catalog_promotion_retention_barrier()
returns trigger language plpgsql as $$
declare
  target_organization_id uuid;
  target_deployment_key text;
  active_token uuid;
  delete_identity jsonb;
  delete_row jsonb;
  delete_proof_revision bigint;
  delete_evaluation_sequence bigint;
begin
  if tg_op = 'INSERT' then
    target_organization_id := new.organization_id;
    target_deployment_key := new.deployment_key;
  else
    target_organization_id := old.organization_id;
    target_deployment_key := old.deployment_key;
  end if;

  perform 1 from public.organizations
  where id = target_organization_id for share;

  select barrier_token into active_token
  from public.catalog_promotion_retention_barriers
  where organization_id = target_organization_id
    and deployment_key = target_deployment_key
    and state = 'active';

  if active_token is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' and public.catalog_promotion_retention_delete_authorized(
    target_organization_id, target_deployment_key
  ) then
    delete_row := to_jsonb(old);
    begin
      delete_identity := current_setting(
        'packscout.catalog_retention_delete_identity', true
      )::jsonb;
    exception when others then
      delete_identity := null;
    end;
    begin
      delete_proof_revision := nullif(current_setting(
        'packscout.catalog_retention_delete_proof_revision', true
      ), '')::bigint;
    exception when others then
      delete_proof_revision := null;
    end;
    begin
      delete_evaluation_sequence := nullif(current_setting(
        'packscout.catalog_retention_delete_evaluation_sequence', true
      ), '')::bigint;
    exception when others then
      delete_evaluation_sequence := null;
    end;

    if tg_table_name = 'provider_release_artifacts' and
       delete_row->>'platform_key' = delete_identity->>'platformKey' and
       delete_row->>'public_provider_release_id' =
         delete_identity->>'publicProviderReleaseId' and
       delete_row->>'provider_release_fingerprint' =
         delete_identity->>'providerReleaseFingerprint' then
      return old;
    elsif tg_table_name = 'provider_promotion_attempts' and
       delete_row->>'platform_key' = delete_identity->>'platformKey' and
       delete_row->>'public_provider_release_id' =
         delete_identity->>'publicProviderReleaseId' and
       delete_row->>'provider_release_fingerprint' =
         delete_identity->>'providerReleaseFingerprint' then
      return old;
    elsif tg_table_name = 'provider_promotion_operations' and exists (
      select 1 from public.provider_promotion_attempts as attempt
      where attempt.id::text = delete_row->>'attempt_id'
        and attempt.organization_id = target_organization_id
        and attempt.deployment_key = target_deployment_key
        and attempt.platform_key = delete_identity->>'platformKey'
        and attempt.public_provider_release_id::text =
          delete_identity->>'publicProviderReleaseId'
        and attempt.provider_release_fingerprint =
          delete_identity->>'providerReleaseFingerprint'
    ) then
      return old;
    elsif tg_table_name = 'provider_promotion_evaluations' and
       delete_row->>'platform_key' = delete_identity->>'platformKey' and
       delete_row->>'evaluation_sequence' = delete_evaluation_sequence::text then
      return old;
    elsif tg_table_name = 'catalog_promotion_bootstrap_provider_proofs' and
       delete_row->>'proof_revision' = delete_proof_revision::text and
       delete_row->>'platform_key' = delete_identity->>'platformKey' and
       delete_row->>'public_provider_release_id' =
         delete_identity->>'publicProviderReleaseId' and
       delete_row->>'provider_release_fingerprint' =
         delete_identity->>'providerReleaseFingerprint' then
      return old;
    elsif tg_table_name = 'catalog_promotion_bootstrap_proofs' and
       delete_row->>'proof_revision' = delete_proof_revision::text and not exists (
         select 1 from public.catalog_promotion_bootstrap_provider_proofs
         where organization_id = target_organization_id
           and deployment_key = target_deployment_key
           and proof_revision = delete_proof_revision
       ) and not exists (
         select 1 from public.provider_promotion_attempts
         where organization_id = target_organization_id
           and deployment_key = target_deployment_key
           and bootstrap_proof_revision = delete_proof_revision
       ) and not exists (
         select 1 from public.manifest_promotion_attempts
         where organization_id = target_organization_id
           and deployment_key = target_deployment_key
           and bootstrap_proof_revision = delete_proof_revision
       ) then
      return old;
    end if;
  end if;

  raise exception 'catalog promotion retention barrier is active'
    using errcode = '55000';
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'provider_promotion_lanes',
    'provider_promotion_evaluations',
    'provider_promotion_attempts',
    'provider_promotion_operations',
    'provider_release_artifacts',
    'manifest_promotion_lanes',
    'manifest_promotion_evaluations',
    'manifest_promotion_attempts',
    'manifest_promotion_operations',
    'manifest_active_provider_selections',
    'catalog_promotion_bootstrap_proofs',
    'catalog_promotion_bootstrap_provider_proofs',
    'promotion_lanes',
    'promotion_attempts',
    'promotion_operations'
  ] loop
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      || 'for each row execute function '
      || 'public.guard_catalog_promotion_retention_barrier()',
      table_name || '_retention_barrier', table_name
    );
  end loop;
end;
$$;

create or replace function public.protect_provider_release_artifact()
returns trigger language plpgsql as $$
declare
  delete_identity jsonb;
begin
  if tg_op = 'DELETE' and public.catalog_promotion_retention_delete_authorized(
    old.organization_id, old.deployment_key
  ) then
    begin
      delete_identity := current_setting(
        'packscout.catalog_retention_delete_identity', true
      )::jsonb;
    exception when others then
      delete_identity := null;
    end;
    if old.platform_key = delete_identity->>'platformKey'
       and old.public_provider_release_id::text =
         delete_identity->>'publicProviderReleaseId'
       and old.provider_release_fingerprint =
         delete_identity->>'providerReleaseFingerprint' then
      return old;
    end if;
  end if;
  raise exception 'provider release artifacts are immutable'
    using errcode = '55000';
end;
$$;

create or replace function public.protect_catalog_promotion_bootstrap_proof()
returns trigger language plpgsql as $$
declare
  delete_proof_revision bigint;
begin
  if tg_op = 'DELETE' and public.catalog_promotion_retention_delete_authorized(
    old.organization_id, old.deployment_key
  ) then
    begin
      delete_proof_revision := nullif(current_setting(
        'packscout.catalog_retention_delete_proof_revision', true
      ), '')::bigint;
    exception when others then
      delete_proof_revision := null;
    end;
    if old.proof_revision = delete_proof_revision then
      return old;
    end if;
  end if;
  raise exception 'catalog promotion bootstrap proof is immutable'
    using errcode = '55000';
end;
$$;

create function public.protect_catalog_promotion_retention_operation()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.organization_id <> old.organization_id
     or new.deployment_key <> old.deployment_key
     or new.barrier_generation <> old.barrier_generation
     or new.operation_index <> old.operation_index
     or new.operation_id <> old.operation_id
     or new.idempotency_key <> old.idempotency_key
     or new.operation_kind <> old.operation_kind
     or new.phase <> old.phase
     or new.platform_key is distinct from old.platform_key
     or new.expected_retention_generation <>
       old.expected_retention_generation
     or new.canonical_request_body <> old.canonical_request_body
     or new.request_sha256 <> old.request_sha256 then
    raise exception 'catalog retention operation identity is immutable'
      using errcode = '55000';
  end if;
  if old.state = 'acknowledged' and (
       new.state <> old.state or new.send_count <> old.send_count
       or new.last_sent_at is distinct from old.last_sent_at
       or new.acknowledged_at is distinct from old.acknowledged_at
       or new.canonical_receipt_body is distinct from old.canonical_receipt_body
       or new.receipt_sha256 is distinct from old.receipt_sha256
       or new.exact_response_body is distinct from old.exact_response_body
       or new.response_sha256 is distinct from old.response_sha256
       or new.terminal_state is distinct from old.terminal_state
       or new.has_more is distinct from old.has_more
       or new.selected_platform_key is distinct from old.selected_platform_key
       or new.selected_public_provider_release_id is distinct from
         old.selected_public_provider_release_id
       or new.selected_provider_release_fingerprint is distinct from
         old.selected_provider_release_fingerprint
     ) then
    raise exception 'acknowledged catalog retention receipt is immutable'
      using errcode = '55000';
  end if;
  if (old.state = 'sent' and new.state = 'pending')
     or new.send_count < old.send_count
     or (old.postgres_cleanup_complete and
       not new.postgres_cleanup_complete) then
    raise exception 'catalog retention operation cannot regress'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger catalog_promotion_retention_operations_immutable
before update on public.catalog_promotion_retention_operations
for each row execute function
  public.protect_catalog_promotion_retention_operation();

create function public.protect_catalog_promotion_retention_barrier()
returns trigger language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.deployment_key <> old.deployment_key
     or new.barrier_generation < old.barrier_generation
     or new.retention_generation < old.retention_generation
     or (new.next_operation_index < old.next_operation_index and not (
       old.state = 'inactive' and new.state = 'active'
       and new.barrier_generation > old.barrier_generation
     )) then
    raise exception 'catalog retention barrier cannot regress'
      using errcode = '55000';
  end if;
  if old.state = 'active' and new.state = 'active' and (
       new.barrier_generation <> old.barrier_generation
       or new.barrier_token <> old.barrier_token
       or new.snapshot_body is distinct from old.snapshot_body
       or (old.snapshot_digest is not null and
         new.snapshot_digest is distinct from old.snapshot_digest)
       or new.activated_at is distinct from old.activated_at
     ) then
    raise exception 'active catalog retention barrier is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger catalog_promotion_retention_barriers_monotonic
before update on public.catalog_promotion_retention_barriers
for each row execute function public.protect_catalog_promotion_retention_barrier();
