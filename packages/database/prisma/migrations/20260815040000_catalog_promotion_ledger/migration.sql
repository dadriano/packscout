-- Task 004: durable, lease-safe promotion lanes, attempts, and operations.

create table public.promotion_lanes (
  organization_id uuid not null,
  deployment_key text not null,
  lane_key text not null,
  bootstrap_state text not null default 'unverified',
  bootstrap_verified_at timestamp(6) with time zone,
  settled_watermark bigint not null default 0,
  settled_at timestamp(6) with time zone,
  requested_watermark bigint not null default 0,
  requested_at timestamp(6) with time zone,
  confirmed_watermark bigint not null default 0,
  confirmed_publication_identity text,
  confirmed_receipt_sha256 text,
  last_activated_watermark bigint not null default 0,
  last_activated_at timestamp(6) with time zone,
  last_unchanged_watermark bigint,
  last_unchanged_observed_at timestamp(6) with time zone,
  next_retry_at timestamp(6) with time zone,
  delayed_vendor_count integer not null default 0,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint promotion_lanes_pkey
    primary key (organization_id, deployment_key, lane_key),
  constraint promotion_lanes_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint promotion_lanes_keys_check check (
    deployment_key = btrim(deployment_key)
    and deployment_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and lane_key = btrim(lane_key)
    and lane_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint promotion_lanes_bootstrap_state_check
    check (bootstrap_state in ('unverified', 'verified_empty', 'verified_local')),
  constraint promotion_lanes_watermarks_check check (
    settled_watermark >= 0
    and requested_watermark >= 0
    and requested_watermark <= settled_watermark
    and confirmed_watermark >= 0
    and last_activated_watermark >= 0
    and last_activated_watermark <= confirmed_watermark
    and (last_unchanged_watermark is null or last_unchanged_watermark >= 0)
  ),
  constraint promotion_lanes_bootstrap_shape_check check (
    (bootstrap_state = 'unverified' and bootstrap_verified_at is null)
    or
    (bootstrap_state = 'verified_empty'
      and bootstrap_verified_at is not null
      and confirmed_watermark = 0
      and confirmed_publication_identity is null
      and confirmed_receipt_sha256 is null)
    or
    (bootstrap_state = 'verified_local'
      and bootstrap_verified_at is not null
      and confirmed_watermark > 0
      and confirmed_publication_identity is not null
      and confirmed_receipt_sha256 ~ '^[0-9a-f]{64}$')
  ),
  constraint promotion_lanes_confirmed_identity_check check (
    confirmed_publication_identity is null
    or (
      confirmed_publication_identity = btrim(confirmed_publication_identity)
      and char_length(confirmed_publication_identity) between 1 and 256
    )
  ),
  constraint promotion_lanes_delayed_vendor_count_check
    check (delayed_vendor_count between 0 and 100000),
  constraint promotion_lanes_activated_time_check check (
    (last_activated_watermark = 0) = (last_activated_at is null)
  ),
  constraint promotion_lanes_unchanged_time_check check (
    (last_unchanged_watermark is null) =
      (last_unchanged_observed_at is null)
  )
);

create index promotion_lanes_requested_idx
  on public.promotion_lanes
  (deployment_key, lane_key, requested_at, organization_id)
  where bootstrap_state <> 'unverified';

create function public.promotion_public_vendor_keys_valid(keys text[])
returns boolean
language plpgsql
immutable
strict
as $$
declare
  current_key text;
  previous_key text := null;
begin
  if cardinality(keys) > 128 then
    return false;
  end if;
  foreach current_key in array keys loop
    if current_key is null
       or current_key <> btrim(current_key)
       or char_length(current_key) not between 1 and 128
       or current_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
       or (previous_key is not null and current_key <= previous_key) then
      return false;
    end if;
    previous_key := current_key;
  end loop;
  return true;
end;
$$;

create table public.promotion_attempts (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  deployment_key text not null,
  lane_key text not null,
  target_watermark bigint not null,
  state text not null default 'assembling',
  content_identity text,
  publication_identity text,
  expected_predecessor_identity text,
  prepared_classification text,
  observation_sequence integer,
  public_config_hash text,
  repack_search_index_hash text,
  public_vendor_keys text[] not null default array[]::text[],
  prepared_at timestamp(6) with time zone,
  claim_owner text,
  claim_token uuid,
  claim_expires_at timestamp(6) with time zone,
  last_heartbeat_at timestamp(6) with time zone,
  claim_count integer not null default 0,
  retry_count integer not null default 0,
  retry_at timestamp(6) with time zone,
  delayed_vendor_count integer not null default 0,
  failure_class text,
  failure_code text,
  terminal_receipt_body text,
  terminal_receipt_sha256 text,
  terminal_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint promotion_attempts_pkey primary key (id),
  constraint promotion_attempts_tenant_unique
    unique (id, organization_id, deployment_key, lane_key),
  constraint promotion_attempts_target_unique
    unique (organization_id, deployment_key, lane_key, target_watermark),
  constraint promotion_attempts_content_unique
    unique (organization_id, deployment_key, lane_key, target_watermark, content_identity),
  constraint promotion_attempts_lane_fk
    foreign key (organization_id, deployment_key, lane_key)
    references public.promotion_lanes(organization_id, deployment_key, lane_key),
  constraint promotion_attempts_target_check check (target_watermark > 0),
  constraint promotion_attempts_state_check check (
    state in (
      'assembling', 'ready', 'in_progress', 'retry_wait',
      'published', 'unchanged', 'failed', 'rolled_back'
    )
  ),
  constraint promotion_attempts_hashes_check check (
    (content_identity is null or content_identity ~ '^[0-9a-f]{64}$')
    and (public_config_hash is null or public_config_hash ~ '^[0-9a-f]{64}$')
    and (repack_search_index_hash is null
      or repack_search_index_hash ~ '^[0-9a-f]{64}$')
    and (terminal_receipt_sha256 is null
      or terminal_receipt_sha256 ~ '^[0-9a-f]{64}$')
  ),
  constraint promotion_attempts_prepared_check check (
    (prepared_classification is null
      or prepared_classification in ('publish', 'refresh_unchanged'))
    and (observation_sequence is null
      or observation_sequence between 1 and 2147483647)
    and public.promotion_public_vendor_keys_valid(public_vendor_keys)
  ),
  constraint promotion_attempts_identities_check check (
    (publication_identity is null or (
      publication_identity = btrim(publication_identity)
      and char_length(publication_identity) between 1 and 256
    ))
    and (expected_predecessor_identity is null or (
      expected_predecessor_identity = btrim(expected_predecessor_identity)
      and char_length(expected_predecessor_identity) between 1 and 256
    ))
  ),
  constraint promotion_attempts_claim_shape_check check (
    claim_count >= 0 and retry_count >= 0
    and (
      (claim_owner is null and claim_token is null
        and claim_expires_at is null and last_heartbeat_at is null)
      or
      (claim_owner is not null and claim_token is not null
        and claim_expires_at is not null and last_heartbeat_at is not null
        and claim_owner = btrim(claim_owner)
        and char_length(claim_owner) between 1 and 128
        and claim_count > 0)
    )
  ),
  constraint promotion_attempts_failure_shape_check check (
    (failure_class is null and failure_code is null)
    or (
      failure_class in ('technical', 'deterministic', 'reconciliation', 'bootstrap')
      and failure_code ~ '^[A-Z0-9_]{1,128}$'
    )
  ),
  constraint promotion_attempts_terminal_shape_check check (
    (
      state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and terminal_at is null
      and terminal_receipt_body is null
      and terminal_receipt_sha256 is null
    )
    or
    (
      state in ('published', 'unchanged', 'rolled_back')
      and terminal_at is not null
      and terminal_receipt_body is not null
      and terminal_receipt_sha256 is not null
      and claim_owner is null and claim_token is null
      and claim_expires_at is null and last_heartbeat_at is null
      and retry_at is null
    )
    or
    (
      state = 'failed'
      and terminal_at is not null
      and failure_class is not null and failure_code is not null
      and claim_owner is null and claim_token is null
      and claim_expires_at is null and last_heartbeat_at is null
      and retry_at is null
    )
  ),
  constraint promotion_attempts_retry_shape_check check (
    (state = 'retry_wait') = (retry_at is not null)
  ),
  constraint promotion_attempts_delayed_vendor_count_check
    check (delayed_vendor_count between 0 and 100000),
  constraint promotion_attempts_receipt_size_check
    check (
      (terminal_receipt_body is null) = (terminal_receipt_sha256 is null)
      and (terminal_receipt_body is null
        or octet_length(terminal_receipt_body) <= 262144)
    )
);

create unique index promotion_attempts_one_active_lane
  on public.promotion_attempts (organization_id, deployment_key, lane_key)
  where state in ('assembling', 'ready', 'in_progress', 'retry_wait');

create index promotion_attempts_claimable_idx
  on public.promotion_attempts
  (organization_id, deployment_key, lane_key, retry_at, claim_expires_at)
  where state in ('assembling', 'ready', 'in_progress', 'retry_wait');

create table public.promotion_operations (
  id uuid not null default gen_random_uuid(),
  attempt_id uuid not null,
  organization_id uuid not null,
  deployment_key text not null,
  lane_key text not null,
  operation_index integer not null,
  operation_id text not null,
  operation_kind text not null,
  request_path text not null,
  canonical_request_body text not null,
  request_sha256 text not null,
  state text not null default 'pending',
  send_count integer not null default 0,
  last_sent_at timestamp(6) with time zone,
  acknowledged_at timestamp(6) with time zone,
  receipt_body text,
  receipt_sha256 text,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint promotion_operations_pkey primary key (id),
  constraint promotion_operations_attempt_index_unique
    unique (attempt_id, operation_index),
  constraint promotion_operations_attempt_operation_unique
    unique (attempt_id, operation_id),
  constraint promotion_operations_lane_operation_unique
    unique (organization_id, deployment_key, lane_key, operation_id),
  constraint promotion_operations_attempt_fk
    foreign key (attempt_id, organization_id, deployment_key, lane_key)
    references public.promotion_attempts(id, organization_id, deployment_key, lane_key),
  constraint promotion_operations_index_check
    check (operation_index between 0 and 4097),
  constraint promotion_operations_identity_check check (
    operation_id = btrim(operation_id)
    and operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and operation_kind = btrim(operation_kind)
    and operation_kind ~ '^[A-Za-z][A-Za-z0-9._:-]{0,63}$'
    and request_path = btrim(request_path)
    and char_length(request_path) between 2 and 512
    and request_path ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/-]+$'
  ),
  constraint promotion_operations_request_check check (
    request_sha256 ~ '^[0-9a-f]{64}$'
    and octet_length(canonical_request_body) between 2 and 131072
  ),
  constraint promotion_operations_state_check
    check (state in ('pending', 'sent', 'acknowledged')),
  constraint promotion_operations_delivery_shape_check check (
    send_count >= 0
    and (
      (state = 'pending' and send_count = 0 and last_sent_at is null
        and acknowledged_at is null and receipt_body is null and receipt_sha256 is null)
      or
      (state = 'sent' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is null and receipt_body is null and receipt_sha256 is null)
      or
      (state = 'acknowledged' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is not null and receipt_body is not null
        and receipt_sha256 ~ '^[0-9a-f]{64}$')
    )
  ),
  constraint promotion_operations_receipt_size_check
    check (receipt_body is null or octet_length(receipt_body) <= 262144)
);

create index promotion_operations_resume_idx
  on public.promotion_operations (attempt_id, operation_index)
  where state <> 'acknowledged';

create function public.protect_promotion_operation_identity()
returns trigger
language plpgsql
as $$
begin
  if new.attempt_id <> old.attempt_id
     or new.organization_id <> old.organization_id
     or new.deployment_key <> old.deployment_key
     or new.lane_key <> old.lane_key
     or new.operation_index <> old.operation_index
     or new.operation_id <> old.operation_id
     or new.operation_kind <> old.operation_kind
     or new.request_path <> old.request_path
     or new.canonical_request_body <> old.canonical_request_body
     or new.request_sha256 <> old.request_sha256 then
    raise exception 'promotion operation request identity is immutable'
      using errcode = '55000';
  end if;
  if old.state = 'acknowledged'
     or (old.state = 'sent' and new.state = 'pending')
     or new.send_count < old.send_count then
    raise exception 'promotion operation delivery state cannot regress'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger promotion_operations_request_immutable
before update on public.promotion_operations
for each row execute function public.protect_promotion_operation_identity();

create function public.protect_promotion_attempt_identity()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.deployment_key <> old.deployment_key
     or new.lane_key <> old.lane_key
     or new.target_watermark <> old.target_watermark
     or new.expected_predecessor_identity is distinct from old.expected_predecessor_identity
     or (old.content_identity is not null
       and new.content_identity is distinct from old.content_identity)
     or (old.publication_identity is not null
       and new.publication_identity is distinct from old.publication_identity) then
    raise exception 'promotion attempt identity is immutable'
      using errcode = '55000';
  end if;
  if old.state in ('published', 'unchanged', 'failed', 'rolled_back') then
    raise exception 'terminal promotion attempts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger promotion_attempts_identity_immutable
before update on public.promotion_attempts
for each row execute function public.protect_promotion_attempt_identity();

create function public.protect_promotion_lane_watermarks()
returns trigger
language plpgsql
as $$
begin
  if new.settled_watermark < old.settled_watermark
     or new.requested_watermark < old.requested_watermark
     or new.confirmed_watermark < old.confirmed_watermark
     or new.last_activated_watermark < old.last_activated_watermark
     or (old.last_unchanged_watermark is not null and (
       new.last_unchanged_watermark is null
       or new.last_unchanged_watermark < old.last_unchanged_watermark
     )) then
    raise exception 'promotion lane watermark cannot regress'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger promotion_lanes_watermarks_monotonic
before update on public.promotion_lanes
for each row execute function public.protect_promotion_lane_watermarks();
