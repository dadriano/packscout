-- Task 011: independent provider publication lanes and one serialized manifest lane.
-- The legacy promotion_* tables remain the Heat ledger only.

create function public.promotion_v2_platform_key_valid(value text)
returns boolean language sql immutable strict as $$
  select char_length(value) between 1 and 128
    and value = btrim(value)
    and value ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'
$$;

create function public.promotion_v2_deployment_key_valid(value text)
returns boolean language sql immutable strict as $$
  select char_length(value) between 1 and 128
    and value = btrim(value)
    and value ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
$$;

create function public.promotion_v2_sha256_valid(value text)
returns boolean language sql immutable strict as $$
  select value ~ '^[0-9a-f]{64}$'
$$;

create table public.provider_promotion_lanes (
  organization_id uuid not null,
  deployment_key text not null,
  platform_key text not null,
  next_evaluation_sequence bigint not null default 0,
  requested_evaluation_sequence bigint not null default 0,
  requested_at timestamp(6) with time zone,
  latest_checkpoint_body text,
  latest_checkpoint_sha256 text,
  settled_checkpoint bigint not null default 0,
  settled_at timestamp(6) with time zone,
  source_head_checkpoint bigint not null default 0,
  source_head_at timestamp(6) with time zone,
  confirmed_evaluation_sequence bigint not null default 0,
  completed_checkpoint bigint not null default 0,
  completed_at timestamp(6) with time zone,
  completed_public_provider_release_id uuid,
  completed_provider_release_fingerprint text,
  completed_head_body text,
  completed_head_sha256 text,
  completed_terminal_operation_kind text,
  completed_terminal_operation_id text,
  completed_terminal_receipt_sha256 text,
  completed_attempt_id uuid,
  next_retry_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint provider_promotion_lanes_pkey
    primary key (organization_id, deployment_key, platform_key),
  constraint provider_promotion_lanes_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint provider_promotion_lanes_key_check check (
    public.promotion_v2_deployment_key_valid(deployment_key)
    and public.promotion_v2_platform_key_valid(platform_key)
  ),
  constraint provider_promotion_lanes_sequence_check check (
    next_evaluation_sequence >= 0
    and requested_evaluation_sequence between 0 and next_evaluation_sequence
    and confirmed_evaluation_sequence between 0 and requested_evaluation_sequence
    and settled_checkpoint >= 0
    and source_head_checkpoint >= settled_checkpoint
    and completed_checkpoint >= 0
    and completed_checkpoint <= settled_checkpoint
  ),
  constraint provider_promotion_lanes_requested_shape_check check (
    (requested_evaluation_sequence = 0) = (requested_at is null)
    and (requested_evaluation_sequence = 0) = (latest_checkpoint_body is null)
    and (latest_checkpoint_body is null) = (latest_checkpoint_sha256 is null)
    and (latest_checkpoint_sha256 is null
      or public.promotion_v2_sha256_valid(latest_checkpoint_sha256))
    and (latest_checkpoint_body is null
      or octet_length(latest_checkpoint_body) between 2 and 65536)
  ),
  constraint provider_promotion_lanes_settlement_shape_check check (
    (settled_checkpoint = 0) = (settled_at is null)
    and (source_head_checkpoint = 0) = (source_head_at is null)
  ),
  constraint provider_promotion_lanes_completed_shape_check check (
    (
      completed_checkpoint = 0
      and completed_at is null
      and completed_public_provider_release_id is null
      and completed_provider_release_fingerprint is null
      and completed_head_body is null
      and completed_head_sha256 is null
      and completed_terminal_operation_kind is null
      and completed_terminal_operation_id is null
      and completed_terminal_receipt_sha256 is null
      and completed_attempt_id is null
    ) or (
      completed_checkpoint > 0
      and completed_at is not null
      and completed_public_provider_release_id is not null
      and public.promotion_v2_sha256_valid(completed_provider_release_fingerprint)
      and octet_length(completed_head_body) between 2 and 65536
      and public.promotion_v2_sha256_valid(completed_head_sha256)
      and completed_terminal_operation_kind in ('finalize', 'confirmReuse')
      and completed_terminal_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      and public.promotion_v2_sha256_valid(completed_terminal_receipt_sha256)
      and completed_attempt_id is not null
    )
  )
);

create table public.provider_promotion_evaluations (
  organization_id uuid not null,
  deployment_key text not null,
  platform_key text not null,
  evaluation_sequence bigint not null,
  checkpoint_body text not null,
  checkpoint_sha256 text not null,
  settled_checkpoint bigint not null,
  source_head_checkpoint bigint not null,
  requested_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint provider_promotion_evaluations_pkey primary key (
    organization_id, deployment_key, platform_key, evaluation_sequence
  ),
  constraint provider_promotion_evaluations_lane_fk foreign key (
    organization_id, deployment_key, platform_key
  ) references public.provider_promotion_lanes (
    organization_id, deployment_key, platform_key
  ),
  constraint provider_promotion_evaluations_value_check check (
    evaluation_sequence > 0
    and settled_checkpoint >= 0
    and source_head_checkpoint >= settled_checkpoint
    and octet_length(checkpoint_body) between 2 and 65536
    and public.promotion_v2_sha256_valid(checkpoint_sha256)
  )
);

create table public.provider_promotion_attempts (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  deployment_key text not null,
  platform_key text not null,
  evaluation_sequence bigint not null,
  bootstrap_proof_revision bigint not null,
  bootstrap_provider_set_sha256 text not null,
  target_checkpoint bigint not null,
  state text not null default 'assembling',
  prepared_classification text,
  prepared_summary_body text,
  prepared_summary_sha256 text,
  public_provider_release_id uuid,
  provider_release_fingerprint text,
  expected_completed_head_sha256 text,
  prepared_at timestamp(6) with time zone,
  claim_owner text,
  claim_token uuid,
  claim_expires_at timestamp(6) with time zone,
  last_heartbeat_at timestamp(6) with time zone,
  claim_count integer not null default 0,
  retry_count integer not null default 0,
  retry_at timestamp(6) with time zone,
  failure_class text,
  failure_code text,
  cas_error_body text,
  cas_error_sha256 text,
  terminal_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint provider_promotion_attempts_pkey primary key (id),
  constraint provider_promotion_attempts_tenant_unique unique (
    id, organization_id, deployment_key, platform_key
  ),
  constraint provider_promotion_attempts_evaluation_unique unique (
    organization_id, deployment_key, platform_key, evaluation_sequence
  ),
  constraint provider_promotion_attempts_evaluation_fk foreign key (
    organization_id, deployment_key, platform_key, evaluation_sequence
  ) references public.provider_promotion_evaluations (
    organization_id, deployment_key, platform_key, evaluation_sequence
  ),
  constraint provider_promotion_attempts_state_check check (state in (
    'assembling', 'ready', 'in_progress', 'retry_wait',
    'published', 'reused', 'superseded', 'cas_lost', 'failed'
  )),
  constraint provider_promotion_attempts_target_check check (
    target_checkpoint >= 0 and bootstrap_proof_revision > 0
    and public.promotion_v2_sha256_valid(bootstrap_provider_set_sha256)
  ),
  constraint provider_promotion_attempts_prepared_check check (
    (
      prepared_classification is null
      and prepared_summary_body is null
      and prepared_summary_sha256 is null
      and public_provider_release_id is null
      and provider_release_fingerprint is null
      and expected_completed_head_sha256 is null
      and prepared_at is null
    ) or (
      prepared_classification in ('publish', 'reuse')
      and octet_length(prepared_summary_body) between 2 and 65536
      and public.promotion_v2_sha256_valid(prepared_summary_sha256)
      and public_provider_release_id is not null
      and public.promotion_v2_sha256_valid(provider_release_fingerprint)
      and public.promotion_v2_sha256_valid(expected_completed_head_sha256)
      and prepared_at is not null
    )
  ),
  constraint provider_promotion_attempts_claim_check check (
    claim_count >= 0 and retry_count >= 0 and (
      (claim_owner is null and claim_token is null and claim_expires_at is null
        and last_heartbeat_at is null)
      or
      (claim_owner = btrim(claim_owner) and char_length(claim_owner) between 1 and 128
        and claim_token is not null and claim_expires_at is not null
        and last_heartbeat_at is not null and claim_count > 0)
    )
  ),
  constraint provider_promotion_attempts_retry_check check (
    (state = 'retry_wait') = (retry_at is not null)
  ),
  constraint provider_promotion_attempts_failure_check check (
    (failure_class is null and failure_code is null) or (
      failure_class in ('technical', 'deterministic', 'reconciliation', 'bootstrap')
      and failure_code ~ '^[A-Z0-9_]{1,128}$'
    )
  ),
  constraint provider_promotion_attempts_cas_check check (
    (state = 'cas_lost') = (cas_error_body is not null)
    and (cas_error_body is null) = (cas_error_sha256 is null)
    and (cas_error_body is null or (
      octet_length(cas_error_body) between 2 and 65536
      and public.promotion_v2_sha256_valid(cas_error_sha256)
    ))
  ),
  constraint provider_promotion_attempts_terminal_check check (
    (state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and terminal_at is null)
    or
    (state in ('published', 'reused') and terminal_at is not null
      and prepared_classification is not null and failure_class is null
      and failure_code is null and claim_owner is null and claim_token is null
      and claim_expires_at is null and last_heartbeat_at is null and retry_at is null)
    or
    (state = 'superseded' and terminal_at is not null
      and failure_class is null and failure_code is null
      and claim_owner is null and claim_token is null
      and claim_expires_at is null and last_heartbeat_at is null and retry_at is null)
    or
    (state = 'cas_lost' and terminal_at is not null
      and failure_class = 'reconciliation' and failure_code is not null
      and claim_owner is null and claim_token is null
      and claim_expires_at is null and last_heartbeat_at is null and retry_at is null)
    or
    (state = 'failed' and terminal_at is not null and failure_class is not null
      and failure_code is not null and claim_owner is null and claim_token is null
      and claim_expires_at is null and last_heartbeat_at is null and retry_at is null)
  )
);

create unique index provider_promotion_attempts_one_active_lane
  on public.provider_promotion_attempts (organization_id, deployment_key, platform_key)
  where state in ('assembling', 'ready', 'in_progress', 'retry_wait');

create index provider_promotion_evaluations_digest_idx
  on public.provider_promotion_evaluations (
    organization_id, deployment_key, platform_key, checkpoint_sha256,
    evaluation_sequence desc
  );

create index provider_promotion_attempts_claimable_idx
  on public.provider_promotion_attempts
    (organization_id, deployment_key, platform_key, retry_at, claim_expires_at)
  where state in ('assembling', 'ready', 'in_progress', 'retry_wait');

create table public.provider_promotion_operations (
  id uuid not null default gen_random_uuid(),
  attempt_id uuid not null,
  organization_id uuid not null,
  deployment_key text not null,
  platform_key text not null,
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
  canonical_receipt_body text,
  receipt_sha256 text,
  exact_response_body text,
  response_sha256 text,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint provider_promotion_operations_pkey primary key (id),
  constraint provider_promotion_operations_attempt_index_unique
    unique (attempt_id, operation_index),
  constraint provider_promotion_operations_attempt_operation_unique
    unique (attempt_id, operation_id),
  constraint provider_promotion_operations_lane_operation_unique
    unique (organization_id, deployment_key, platform_key, operation_id),
  constraint provider_promotion_operations_attempt_fk foreign key (
    attempt_id, organization_id, deployment_key, platform_key
  ) references public.provider_promotion_attempts (
    id, organization_id, deployment_key, platform_key
  ),
  constraint provider_promotion_operations_index_check
    check (operation_index between 0 and 4097),
  constraint provider_promotion_operations_identity_check check (
    operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and operation_kind in ('start', 'applyBatch', 'finalize', 'confirmReuse', 'block')
    and char_length(request_path) between 2 and 512
    and request_path ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/-]+$'
    and octet_length(canonical_request_body) between 2 and 131072
    and public.promotion_v2_sha256_valid(request_sha256)
  ),
  constraint provider_promotion_operations_state_check
    check (state in ('pending', 'sent', 'acknowledged')),
  constraint provider_promotion_operations_delivery_check check (
    send_count >= 0 and (
      (state = 'pending' and send_count = 0 and last_sent_at is null
        and acknowledged_at is null and canonical_receipt_body is null
        and receipt_sha256 is null and exact_response_body is null
        and response_sha256 is null)
      or
      (state = 'sent' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is null and canonical_receipt_body is null
        and receipt_sha256 is null and exact_response_body is null
        and response_sha256 is null)
      or
      (state = 'acknowledged' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is not null
        and octet_length(canonical_receipt_body) between 2 and 393216
        and public.promotion_v2_sha256_valid(receipt_sha256)
        and (exact_response_body is null) = (response_sha256 is null)
        and (exact_response_body is null or (
          octet_length(exact_response_body) between 2 and 524288
          and public.promotion_v2_sha256_valid(response_sha256)
        )))
    )
  )
);

create index provider_promotion_operations_resume_idx
  on public.provider_promotion_operations (attempt_id, operation_index)
  where state <> 'acknowledged';

create table public.provider_release_artifacts (
  organization_id uuid not null,
  deployment_key text not null,
  platform_key text not null,
  public_provider_release_id uuid not null,
  provider_release_fingerprint text not null,
  immutable_proof_body text not null,
  immutable_proof_sha256 text not null,
  publish_attempt_id uuid not null,
  completed_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint provider_release_artifacts_pkey primary key (
    organization_id, deployment_key, platform_key, public_provider_release_id
  ),
  constraint provider_release_artifacts_fingerprint_unique unique (
    organization_id, deployment_key, platform_key, provider_release_fingerprint
  ),
  constraint provider_release_artifacts_publish_attempt_unique unique (
    publish_attempt_id, organization_id, deployment_key, platform_key
  ),
  constraint provider_release_artifacts_exact_identity_unique unique (
    publish_attempt_id, organization_id, deployment_key, platform_key,
    public_provider_release_id, provider_release_fingerprint
  ),
  constraint provider_release_artifacts_publish_attempt_fk foreign key (
    publish_attempt_id, organization_id, deployment_key, platform_key
  ) references public.provider_promotion_attempts (
    id, organization_id, deployment_key, platform_key
  ),
  constraint provider_release_artifacts_proof_check check (
    public.promotion_v2_sha256_valid(provider_release_fingerprint)
    and octet_length(immutable_proof_body) between 2 and 131072
    and public.promotion_v2_sha256_valid(immutable_proof_sha256)
  )
);

alter table public.provider_promotion_lanes
  add constraint provider_promotion_lanes_completed_attempt_fk foreign key (
    completed_attempt_id, organization_id, deployment_key, platform_key
  ) references public.provider_promotion_attempts (
    id, organization_id, deployment_key, platform_key
  );

create table public.manifest_promotion_lanes (
  organization_id uuid not null,
  deployment_key text not null,
  bootstrap_state text not null default 'unverified',
  bootstrap_verified_at timestamp(6) with time zone,
  bootstrap_provider_set_body text,
  bootstrap_provider_set_sha256 text,
  current_bootstrap_proof_revision bigint,
  next_evaluation_sequence bigint not null default 0,
  requested_evaluation_sequence bigint not null default 0,
  requested_at timestamp(6) with time zone,
  confirmed_evaluation_sequence bigint not null default 0,
  active_generation bigint not null default 0,
  active_state_body text,
  active_state_sha256 text,
  active_state_receipt_body text,
  active_state_receipt_sha256 text,
  active_state_response_body text,
  active_state_response_sha256 text,
  active_public_release_id uuid,
  active_manifest_fingerprint text,
  active_provider_reference_set_hash text,
  active_configuration_epoch_sequence bigint,
  active_terminal_receipt_sha256 text,
  delayed_provider_count integer not null default 0,
  last_activated_at timestamp(6) with time zone,
  last_reconciled_at timestamp(6) with time zone,
  next_retry_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint manifest_promotion_lanes_pkey primary key (organization_id, deployment_key),
  constraint manifest_promotion_lanes_organization_fk
    foreign key (organization_id) references public.organizations(id),
  constraint manifest_promotion_lanes_key_check
    check (public.promotion_v2_deployment_key_valid(deployment_key)),
  constraint manifest_promotion_lanes_bootstrap_check check (
    bootstrap_state in (
      'unverified', 'verified_empty', 'verified_cleared', 'verified_active'
    )
    and ((bootstrap_state = 'unverified') = (bootstrap_verified_at is null))
    and (bootstrap_provider_set_body is null) =
      (bootstrap_provider_set_sha256 is null)
    and (
      (bootstrap_state = 'unverified' and bootstrap_provider_set_body is null)
      or (bootstrap_state <> 'unverified'
        and octet_length(bootstrap_provider_set_body) between 2 and 32768
        and public.promotion_v2_sha256_valid(bootstrap_provider_set_sha256))
    )
    and ((bootstrap_state = 'unverified'
      and current_bootstrap_proof_revision is null)
      or (bootstrap_state <> 'unverified'
        and current_bootstrap_proof_revision is not null
        and current_bootstrap_proof_revision > 0))
  ),
  constraint manifest_promotion_lanes_sequence_check check (
    next_evaluation_sequence >= 0
    and requested_evaluation_sequence between 0 and next_evaluation_sequence
    and confirmed_evaluation_sequence between 0 and requested_evaluation_sequence
    and active_generation >= 0
    and (active_configuration_epoch_sequence is null
      or active_configuration_epoch_sequence > 0)
  ),
  constraint manifest_promotion_lanes_active_shape_check check (
    (
      bootstrap_state = 'unverified' and active_generation = 0
      and active_state_body is null
      and active_state_sha256 is null and active_state_receipt_body is null
      and active_state_receipt_sha256 is null and active_state_response_body is null
      and active_state_response_sha256 is null and active_public_release_id is null
      and active_manifest_fingerprint is null
      and active_provider_reference_set_hash is null
      and active_configuration_epoch_sequence is null
      and active_terminal_receipt_sha256 is null and delayed_provider_count = 0
      and last_activated_at is null and last_reconciled_at is null
    ) or (
      bootstrap_state = 'verified_empty' and active_generation = 0
      and octet_length(active_state_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(active_state_sha256)
      and octet_length(active_state_receipt_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(active_state_receipt_sha256)
      and (active_state_response_body is null) =
        (active_state_response_sha256 is null)
      and (active_state_response_body is null or (
        octet_length(active_state_response_body) between 2 and 524288
        and public.promotion_v2_sha256_valid(active_state_response_sha256)
      ))
      and active_public_release_id is null
      and active_manifest_fingerprint is null
      and active_provider_reference_set_hash is null
      and active_configuration_epoch_sequence is null
      and active_terminal_receipt_sha256 is null
      and delayed_provider_count = 0 and last_activated_at is null
      and last_reconciled_at is not null
    ) or (
      bootstrap_state = 'verified_cleared' and active_generation > 0
      and octet_length(active_state_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(active_state_sha256)
      and octet_length(active_state_receipt_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(active_state_receipt_sha256)
      and (active_state_response_body is null) = (active_state_response_sha256 is null)
      and (active_state_response_body is null or (
        octet_length(active_state_response_body) between 2 and 524288
        and public.promotion_v2_sha256_valid(active_state_response_sha256)
      ))
      and public.promotion_v2_sha256_valid(active_terminal_receipt_sha256)
      and active_public_release_id is null
      and active_manifest_fingerprint is null
      and active_provider_reference_set_hash is null
      and active_configuration_epoch_sequence is null
      and delayed_provider_count = 0 and last_reconciled_at is not null
    ) or (
      bootstrap_state = 'verified_active' and active_generation > 0
      and octet_length(active_state_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(active_state_sha256)
      and octet_length(active_state_receipt_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(active_state_receipt_sha256)
      and (active_state_response_body is null) =
        (active_state_response_sha256 is null)
      and (active_state_response_body is null or (
        octet_length(active_state_response_body) between 2 and 524288
        and public.promotion_v2_sha256_valid(active_state_response_sha256)
      ))
      and public.promotion_v2_sha256_valid(active_terminal_receipt_sha256)
      and active_public_release_id is not null
      and public.promotion_v2_sha256_valid(active_manifest_fingerprint)
      and public.promotion_v2_sha256_valid(active_provider_reference_set_hash)
      and active_configuration_epoch_sequence > 0
      and delayed_provider_count between 0 and 8
      and last_activated_at is not null and last_reconciled_at is not null
    )
  )
);

create table public.manifest_promotion_evaluations (
  organization_id uuid not null,
  deployment_key text not null,
  evaluation_sequence bigint not null,
  cause text not null,
  cause_identity text not null,
  cause_sha256 text not null,
  requested_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint manifest_promotion_evaluations_pkey primary key (
    organization_id, deployment_key, evaluation_sequence
  ),
  constraint manifest_promotion_evaluations_cause_unique unique (
    organization_id, deployment_key, cause_sha256
  ),
  constraint manifest_promotion_evaluations_lane_fk foreign key (
    organization_id, deployment_key
  ) references public.manifest_promotion_lanes (organization_id, deployment_key),
  constraint manifest_promotion_evaluations_value_check check (
    evaluation_sequence > 0
    and cause in ('provider_completed', 'provider_reused', 'lifecycle_settled',
      'configuration_settled', 'observation_succeeded', 'cas_lost',
      'retry_exhausted', 'bootstrap_reconcile')
    and cause_identity = btrim(cause_identity)
    and char_length(cause_identity) between 1 and 256
    and public.promotion_v2_sha256_valid(cause_sha256)
  )
);

create table public.manifest_promotion_attempts (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  deployment_key text not null,
  evaluation_sequence bigint not null,
  bootstrap_proof_revision bigint not null,
  bootstrap_provider_set_sha256 text not null,
  state text not null default 'assembling',
  prepared_operation_kind text,
  prepared_summary_body text,
  prepared_summary_sha256 text,
  evaluation_snapshot_body text,
  evaluation_snapshot_sha256 text,
  expected_active_state_sha256 text,
  public_release_id uuid,
  manifest_fingerprint text,
  prepared_at timestamp(6) with time zone,
  claim_owner text,
  claim_token uuid,
  claim_expires_at timestamp(6) with time zone,
  last_heartbeat_at timestamp(6) with time zone,
  claim_count integer not null default 0,
  retry_count integer not null default 0,
  retry_at timestamp(6) with time zone,
  failure_class text,
  failure_code text,
  cas_error_body text,
  cas_error_sha256 text,
  terminal_at timestamp(6) with time zone,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint manifest_promotion_attempts_pkey primary key (id),
  constraint manifest_promotion_attempts_tenant_unique unique (
    id, organization_id, deployment_key
  ),
  constraint manifest_promotion_attempts_evaluation_unique unique (
    organization_id, deployment_key, evaluation_sequence
  ),
  constraint manifest_promotion_attempts_evaluation_fk foreign key (
    organization_id, deployment_key, evaluation_sequence
  ) references public.manifest_promotion_evaluations (
    organization_id, deployment_key, evaluation_sequence
  ),
  constraint manifest_promotion_attempts_state_check check (state in (
    'assembling', 'ready', 'in_progress', 'retry_wait',
    'activated', 'refreshed', 'rolled_back', 'cleared', 'blocked',
    'no_change', 'superseded', 'cas_lost', 'failed'
  ) and bootstrap_proof_revision > 0
    and public.promotion_v2_sha256_valid(bootstrap_provider_set_sha256)),
  constraint manifest_promotion_attempts_prepared_check check (
    (
      prepared_operation_kind is null and prepared_summary_body is null
      and prepared_summary_sha256 is null and expected_active_state_sha256 is null
      and public_release_id is null and manifest_fingerprint is null
      and prepared_at is null
    ) or (
      prepared_operation_kind in (
        'activateManifest', 'refreshActiveState', 'rollback', 'block', 'no_change'
      )
      and octet_length(prepared_summary_body) between 2 and 65536
      and public.promotion_v2_sha256_valid(prepared_summary_sha256)
      and public.promotion_v2_sha256_valid(expected_active_state_sha256)
      and (manifest_fingerprint is null
        or public.promotion_v2_sha256_valid(manifest_fingerprint))
      and prepared_at is not null
    )
  ),
  constraint manifest_promotion_attempts_snapshot_check check (
    (evaluation_snapshot_body is null) = (evaluation_snapshot_sha256 is null)
    and (evaluation_snapshot_body is null or (
      octet_length(evaluation_snapshot_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(evaluation_snapshot_sha256)
    ))
    and (prepared_summary_body is null or evaluation_snapshot_body is not null)
  ),
  constraint manifest_promotion_attempts_claim_check check (
    claim_count >= 0 and retry_count >= 0 and (
      (claim_owner is null and claim_token is null and claim_expires_at is null
        and last_heartbeat_at is null)
      or
      (claim_owner = btrim(claim_owner) and char_length(claim_owner) between 1 and 128
        and claim_token is not null and claim_expires_at is not null
        and last_heartbeat_at is not null and claim_count > 0)
    )
  ),
  constraint manifest_promotion_attempts_retry_check
    check ((state = 'retry_wait') = (retry_at is not null)),
  constraint manifest_promotion_attempts_failure_check check (
    (failure_class is null and failure_code is null) or (
      failure_class in ('technical', 'deterministic', 'reconciliation', 'bootstrap')
      and failure_code ~ '^[A-Z0-9_]{1,128}$'
    )
  ),
  constraint manifest_promotion_attempts_cas_check check (
    (state <> 'cas_lost' or cas_error_body is not null)
    and (cas_error_body is null or state in ('in_progress', 'retry_wait', 'cas_lost'))
    and (cas_error_body is null) = (cas_error_sha256 is null)
    and (cas_error_body is null or (
      octet_length(cas_error_body) between 2 and 65536
      and public.promotion_v2_sha256_valid(cas_error_sha256)
    ))
  ),
  constraint manifest_promotion_attempts_terminal_check check (
    (state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and terminal_at is null)
    or (state in ('activated', 'refreshed', 'rolled_back', 'cleared', 'blocked',
      'no_change') and terminal_at is not null
      and failure_class is null and failure_code is null
      and claim_owner is null and claim_token is null and claim_expires_at is null
      and last_heartbeat_at is null and retry_at is null)
    or (state = 'superseded' and terminal_at is not null
      and failure_class is null and failure_code is null
      and claim_owner is null and claim_token is null and claim_expires_at is null
      and last_heartbeat_at is null and retry_at is null)
    or (state = 'cas_lost' and terminal_at is not null
      and failure_class = 'reconciliation' and failure_code is not null
      and claim_owner is null and claim_token is null and claim_expires_at is null
      and last_heartbeat_at is null and retry_at is null)
    or (state = 'failed' and terminal_at is not null
      and failure_class is not null and failure_code is not null
      and claim_owner is null and claim_token is null and claim_expires_at is null
      and last_heartbeat_at is null and retry_at is null)
  )
);

create unique index manifest_promotion_attempts_one_active_lane
  on public.manifest_promotion_attempts (organization_id, deployment_key)
  where state in ('assembling', 'ready', 'in_progress', 'retry_wait');

create table public.manifest_promotion_operations (
  id uuid not null default gen_random_uuid(),
  attempt_id uuid not null,
  organization_id uuid not null,
  deployment_key text not null,
  operation_index integer not null default 0,
  operation_id text not null,
  operation_kind text not null,
  request_path text not null,
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
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint manifest_promotion_operations_pkey primary key (id),
  constraint manifest_promotion_operations_attempt_unique unique (attempt_id),
  constraint manifest_promotion_operations_operation_unique unique (
    organization_id, deployment_key, operation_id
  ),
  constraint manifest_promotion_operations_attempt_fk foreign key (
    attempt_id, organization_id, deployment_key
  ) references public.manifest_promotion_attempts (
    id, organization_id, deployment_key
  ),
  constraint manifest_promotion_operations_identity_check check (
    operation_index = 0
    and operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and operation_kind in ('activateManifest', 'refreshActiveState', 'rollback', 'block')
    and char_length(request_path) between 2 and 512
    and request_path ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/-]+$'
    and octet_length(canonical_request_body) between 2 and 131072
    and public.promotion_v2_sha256_valid(request_sha256)
  ),
  constraint manifest_promotion_operations_state_check
    check (state in ('pending', 'sent', 'acknowledged')),
  constraint manifest_promotion_operations_delivery_check check (
    send_count >= 0 and (
      (state = 'pending' and send_count = 0 and last_sent_at is null
        and acknowledged_at is null and canonical_receipt_body is null
        and receipt_sha256 is null and exact_response_body is null
        and response_sha256 is null)
      or
      (state = 'sent' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is null and canonical_receipt_body is null
        and receipt_sha256 is null and exact_response_body is null
        and response_sha256 is null)
      or
      (state = 'acknowledged' and send_count > 0 and last_sent_at is not null
        and acknowledged_at is not null
        and octet_length(canonical_receipt_body) between 2 and 262144
        and public.promotion_v2_sha256_valid(receipt_sha256)
        and (exact_response_body is null) = (response_sha256 is null)
        and (exact_response_body is null or (
          octet_length(exact_response_body) between 2 and 524288
          and public.promotion_v2_sha256_valid(response_sha256)
        )))
    )
  )
);

create table public.manifest_active_provider_selections (
  organization_id uuid not null,
  deployment_key text not null,
  platform_key text not null,
  active_generation bigint not null,
  manifest_public_release_id uuid not null,
  provider_public_release_id uuid not null,
  provider_release_fingerprint text not null,
  selected_checkpoint bigint not null,
  selection_body text not null,
  selection_sha256 text not null,
  provider_terminal_operation_id text not null,
  provider_terminal_receipt_sha256 text not null,
  publish_artifact_attempt_id uuid not null,
  activated_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  updated_at timestamp(6) with time zone not null default current_timestamp,
  constraint manifest_active_provider_selections_pkey primary key (
    organization_id, deployment_key, platform_key
  ),
  constraint manifest_active_provider_selections_lane_fk foreign key (
    organization_id, deployment_key
  ) references public.manifest_promotion_lanes (organization_id, deployment_key),
  constraint manifest_active_provider_selections_provider_lane_fk foreign key (
    organization_id, deployment_key, platform_key
  ) references public.provider_promotion_lanes (
    organization_id, deployment_key, platform_key
  ),
  constraint manifest_active_provider_selections_artifact_fk foreign key (
    publish_artifact_attempt_id, organization_id, deployment_key, platform_key,
    provider_public_release_id, provider_release_fingerprint
  ) references public.provider_release_artifacts (
    publish_attempt_id, organization_id, deployment_key, platform_key,
    public_provider_release_id, provider_release_fingerprint
  ),
  constraint manifest_active_provider_selections_value_check check (
    public.promotion_v2_platform_key_valid(platform_key)
    and active_generation > 0 and selected_checkpoint > 0
    and public.promotion_v2_sha256_valid(provider_release_fingerprint)
    and octet_length(selection_body) between 2 and 65536
    and public.promotion_v2_sha256_valid(selection_sha256)
    and provider_terminal_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and public.promotion_v2_sha256_valid(provider_terminal_receipt_sha256)
  )
);

create table public.catalog_promotion_bootstrap_proofs (
  organization_id uuid not null,
  deployment_key text not null,
  proof_revision bigint not null,
  proof_kind text not null,
  active_state_request_body text not null,
  active_state_request_sha256 text not null,
  active_state_receipt_body text not null,
  active_state_receipt_sha256 text not null,
  active_state_response_body text,
  active_state_response_sha256 text,
  manifest_definition_request_body text,
  manifest_definition_request_sha256 text,
  manifest_terminal_request_body text,
  manifest_terminal_request_sha256 text,
  manifest_receipt_body text,
  manifest_receipt_sha256 text,
  manifest_response_body text,
  manifest_response_sha256 text,
  active_state_body text not null,
  active_state_sha256 text not null,
  verified_at timestamp(6) with time zone not null,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint catalog_promotion_bootstrap_proofs_pkey
    primary key (organization_id, deployment_key, proof_revision),
  constraint catalog_promotion_bootstrap_proofs_lane_fk foreign key (
    organization_id, deployment_key
  ) references public.manifest_promotion_lanes (organization_id, deployment_key),
  constraint catalog_promotion_bootstrap_proofs_kind_check
    check (proof_revision > 0 and proof_kind in ('empty', 'cleared', 'active')),
  constraint catalog_promotion_bootstrap_proofs_body_check check (
    octet_length(active_state_request_body) between 2 and 131072
    and public.promotion_v2_sha256_valid(active_state_request_sha256)
    and octet_length(active_state_receipt_body) between 2 and 262144
    and public.promotion_v2_sha256_valid(active_state_receipt_sha256)
    and octet_length(active_state_body) between 2 and 262144
    and public.promotion_v2_sha256_valid(active_state_sha256)
    and (active_state_response_body is null) = (active_state_response_sha256 is null)
    and (active_state_response_body is null or (
      octet_length(active_state_response_body) between 2 and 524288
      and public.promotion_v2_sha256_valid(active_state_response_sha256)
    ))
  ),
  constraint catalog_promotion_bootstrap_proofs_manifest_shape_check check (
    (proof_kind = 'empty' and manifest_definition_request_body is null
      and manifest_definition_request_sha256 is null
      and manifest_terminal_request_body is null
      and manifest_terminal_request_sha256 is null
      and manifest_receipt_body is null
      and manifest_receipt_sha256 is null
      and manifest_response_body is null
      and manifest_response_sha256 is null)
    or
    (proof_kind = 'cleared' and manifest_definition_request_body is null
      and manifest_definition_request_sha256 is null
      and octet_length(manifest_terminal_request_body) between 2 and 131072
      and public.promotion_v2_sha256_valid(manifest_terminal_request_sha256)
      and octet_length(manifest_receipt_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(manifest_receipt_sha256)
      and (manifest_response_body is null) = (manifest_response_sha256 is null)
      and (manifest_response_body is null or (
        octet_length(manifest_response_body) between 2 and 524288
        and public.promotion_v2_sha256_valid(manifest_response_sha256)
      )))
    or
    (proof_kind = 'active'
      and octet_length(manifest_definition_request_body) between 2 and 131072
      and public.promotion_v2_sha256_valid(
        manifest_definition_request_sha256
      )
      and octet_length(manifest_terminal_request_body) between 2 and 131072
      and public.promotion_v2_sha256_valid(manifest_terminal_request_sha256)
      and octet_length(manifest_receipt_body) between 2 and 262144
      and public.promotion_v2_sha256_valid(manifest_receipt_sha256)
      and (manifest_response_body is null) = (manifest_response_sha256 is null)
      and (manifest_response_body is null or (
        octet_length(manifest_response_body) between 2 and 524288
        and public.promotion_v2_sha256_valid(manifest_response_sha256)
      )))
  )
);

alter table public.manifest_promotion_lanes
  add constraint manifest_promotion_lanes_current_bootstrap_proof_fk
  foreign key (
    organization_id, deployment_key, current_bootstrap_proof_revision
  ) references public.catalog_promotion_bootstrap_proofs (
    organization_id, deployment_key, proof_revision
  );

alter table public.provider_promotion_attempts
  add constraint provider_promotion_attempts_bootstrap_proof_fk foreign key (
    organization_id, deployment_key, bootstrap_proof_revision
  ) references public.catalog_promotion_bootstrap_proofs (
    organization_id, deployment_key, proof_revision
  );

alter table public.manifest_promotion_attempts
  add constraint manifest_promotion_attempts_bootstrap_proof_fk foreign key (
    organization_id, deployment_key, bootstrap_proof_revision
  ) references public.catalog_promotion_bootstrap_proofs (
    organization_id, deployment_key, proof_revision
  );

create table public.catalog_promotion_bootstrap_provider_proofs (
  organization_id uuid not null,
  deployment_key text not null,
  proof_revision bigint not null,
  platform_key text not null,
  ordinal integer not null,
  public_provider_release_id uuid,
  provider_release_fingerprint text,
  provider_terminal_operation_id text,
  provider_terminal_receipt_body text,
  provider_terminal_receipt_sha256 text,
  provider_terminal_response_body text,
  provider_terminal_response_sha256 text,
  publish_artifact_attempt_id uuid,
  completed_head_request_body text not null,
  completed_head_request_sha256 text not null,
  completed_head_receipt_body text not null,
  completed_head_receipt_sha256 text not null,
  completed_head_response_body text,
  completed_head_response_sha256 text,
  remote_completed_head_body text not null,
  remote_completed_head_sha256 text not null,
  local_completed_attempt_id uuid,
  local_completed_public_provider_release_id uuid,
  local_completed_provider_release_fingerprint text,
  local_completed_terminal_receipt_sha256 text,
  created_at timestamp(6) with time zone not null default current_timestamp,
  constraint catalog_promotion_bootstrap_provider_proofs_pkey primary key (
    organization_id, deployment_key, proof_revision, platform_key
  ),
  constraint catalog_promotion_bootstrap_provider_proofs_ordinal_unique unique (
    organization_id, deployment_key, proof_revision, ordinal
  ),
  constraint catalog_promotion_bootstrap_provider_proofs_parent_fk foreign key (
    organization_id, deployment_key, proof_revision
  ) references public.catalog_promotion_bootstrap_proofs (
    organization_id, deployment_key, proof_revision
  ),
  constraint catalog_promotion_bootstrap_provider_proofs_artifact_fk foreign key (
    publish_artifact_attempt_id, organization_id, deployment_key, platform_key,
    public_provider_release_id, provider_release_fingerprint
  ) references public.provider_release_artifacts (
    publish_attempt_id, organization_id, deployment_key, platform_key,
    public_provider_release_id, provider_release_fingerprint
  ),
  constraint catalog_promotion_bootstrap_provider_proofs_local_attempt_fk
    foreign key (
      local_completed_attempt_id, organization_id, deployment_key, platform_key
    ) references public.provider_promotion_attempts (
      id, organization_id, deployment_key, platform_key
    ),
  constraint catalog_promotion_bootstrap_provider_proofs_value_check check (
    proof_revision > 0 and ordinal between 0 and 127
    and public.promotion_v2_platform_key_valid(platform_key)
    and octet_length(completed_head_request_body) between 2 and 131072
    and public.promotion_v2_sha256_valid(completed_head_request_sha256)
    and octet_length(completed_head_receipt_body) between 2 and 393216
    and public.promotion_v2_sha256_valid(completed_head_receipt_sha256)
    and (completed_head_response_body is null) =
      (completed_head_response_sha256 is null)
    and (completed_head_response_body is null or (
      octet_length(completed_head_response_body) between 2 and 524288
      and public.promotion_v2_sha256_valid(completed_head_response_sha256)
    ))
    and octet_length(remote_completed_head_body) between 2 and 131072
    and public.promotion_v2_sha256_valid(remote_completed_head_sha256)
    and (
      (public_provider_release_id is null
        and provider_release_fingerprint is null
        and provider_terminal_operation_id is null
        and provider_terminal_receipt_body is null
        and provider_terminal_receipt_sha256 is null
        and provider_terminal_response_body is null
        and provider_terminal_response_sha256 is null
        and publish_artifact_attempt_id is null)
      or
      (public_provider_release_id is not null
        and public.promotion_v2_sha256_valid(provider_release_fingerprint)
        and provider_terminal_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and octet_length(provider_terminal_receipt_body) between 2 and 393216
        and public.promotion_v2_sha256_valid(provider_terminal_receipt_sha256)
        and (provider_terminal_response_body is null) =
          (provider_terminal_response_sha256 is null)
        and (provider_terminal_response_body is null or (
          octet_length(provider_terminal_response_body) between 2 and 524288
          and public.promotion_v2_sha256_valid(provider_terminal_response_sha256)
        ))
        and publish_artifact_attempt_id is not null)
    )
    and (
      (local_completed_attempt_id is null
        and local_completed_public_provider_release_id is null
        and local_completed_provider_release_fingerprint is null
        and local_completed_terminal_receipt_sha256 is null)
      or
      (local_completed_attempt_id is not null
        and local_completed_public_provider_release_id is not null
        and public.promotion_v2_sha256_valid(
          local_completed_provider_release_fingerprint
        )
        and public.promotion_v2_sha256_valid(
          local_completed_terminal_receipt_sha256
        ))
    )
    and (provider_terminal_response_body is null) =
      (provider_terminal_response_sha256 is null)
    and (provider_terminal_response_body is null or (
      octet_length(provider_terminal_response_body) between 2 and 524288
      and public.promotion_v2_sha256_valid(provider_terminal_response_sha256)
    ))
  )
);

create function public.protect_provider_promotion_operation_identity()
returns trigger language plpgsql as $$
begin
  if new.attempt_id <> old.attempt_id
     or new.organization_id <> old.organization_id
     or new.deployment_key <> old.deployment_key
     or new.platform_key <> old.platform_key
     or new.operation_index <> old.operation_index
     or new.operation_id <> old.operation_id
     or new.operation_kind <> old.operation_kind
     or new.request_path <> old.request_path
     or new.canonical_request_body <> old.canonical_request_body
     or new.request_sha256 <> old.request_sha256 then
    raise exception 'provider promotion operation identity is immutable'
      using errcode = '55000';
  end if;
  if old.state = 'acknowledged'
     or (old.state = 'sent' and new.state = 'pending')
     or new.send_count < old.send_count then
    raise exception 'provider promotion delivery state cannot regress'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger provider_promotion_operations_immutable
before update on public.provider_promotion_operations
for each row execute function public.protect_provider_promotion_operation_identity();

create function public.protect_manifest_promotion_operation_identity()
returns trigger language plpgsql as $$
begin
  if new.attempt_id <> old.attempt_id
     or new.organization_id <> old.organization_id
     or new.deployment_key <> old.deployment_key
     or new.operation_index <> old.operation_index
     or new.operation_id <> old.operation_id
     or new.operation_kind <> old.operation_kind
     or new.request_path <> old.request_path
     or new.canonical_request_body <> old.canonical_request_body
     or new.request_sha256 <> old.request_sha256 then
    raise exception 'manifest promotion operation identity is immutable'
      using errcode = '55000';
  end if;
  if old.state = 'acknowledged'
     or (old.state = 'sent' and new.state = 'pending')
     or new.send_count < old.send_count then
    raise exception 'manifest promotion delivery state cannot regress'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger manifest_promotion_operations_immutable
before update on public.manifest_promotion_operations
for each row execute function public.protect_manifest_promotion_operation_identity();

create function public.protect_provider_release_artifact()
returns trigger language plpgsql as $$
begin
  raise exception 'provider release artifacts are immutable' using errcode = '55000';
end;
$$;

create trigger provider_release_artifacts_immutable
before update or delete on public.provider_release_artifacts
for each row execute function public.protect_provider_release_artifact();

create function public.protect_promotion_v2_attempt()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'provider_promotion_attempts' then
    if new.id <> old.id or new.organization_id <> old.organization_id
       or new.deployment_key <> old.deployment_key
       or new.platform_key <> old.platform_key
       or new.evaluation_sequence <> old.evaluation_sequence
       or new.bootstrap_proof_revision <> old.bootstrap_proof_revision
       or new.bootstrap_provider_set_sha256 <>
         old.bootstrap_provider_set_sha256
       or new.target_checkpoint <> old.target_checkpoint
       or (old.prepared_summary_sha256 is not null
         and new.prepared_summary_sha256 is distinct from old.prepared_summary_sha256) then
      raise exception 'provider promotion attempt identity is immutable'
        using errcode = '55000';
    end if;
    if old.state in ('published', 'reused', 'superseded', 'cas_lost', 'failed') then
      raise exception 'terminal provider promotion attempt is immutable'
        using errcode = '55000';
    end if;
  else
    if new.id <> old.id or new.organization_id <> old.organization_id
       or new.deployment_key <> old.deployment_key
       or new.evaluation_sequence <> old.evaluation_sequence
       or new.bootstrap_proof_revision <> old.bootstrap_proof_revision
       or new.bootstrap_provider_set_sha256 <>
         old.bootstrap_provider_set_sha256
       or (old.prepared_summary_sha256 is not null
         and new.prepared_summary_sha256 is distinct from old.prepared_summary_sha256)
       or (old.prepared_summary_sha256 is not null
         and new.evaluation_snapshot_sha256 is distinct from
           old.evaluation_snapshot_sha256) then
      raise exception 'manifest promotion attempt identity is immutable'
        using errcode = '55000';
    end if;
    if old.state in ('activated', 'refreshed', 'rolled_back', 'cleared',
      'blocked', 'no_change', 'superseded', 'cas_lost', 'failed') then
      raise exception 'terminal manifest promotion attempt is immutable'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger provider_promotion_attempts_immutable
before update on public.provider_promotion_attempts
for each row execute function public.protect_promotion_v2_attempt();

create trigger manifest_promotion_attempts_immutable
before update on public.manifest_promotion_attempts
for each row execute function public.protect_promotion_v2_attempt();

create function public.protect_provider_promotion_lane_monotonic()
returns trigger language plpgsql as $$
begin
  if new.next_evaluation_sequence < old.next_evaluation_sequence
     or new.requested_evaluation_sequence < old.requested_evaluation_sequence
     or new.confirmed_evaluation_sequence < old.confirmed_evaluation_sequence
     or new.settled_checkpoint < old.settled_checkpoint
     or new.source_head_checkpoint < old.source_head_checkpoint
     or new.completed_checkpoint < old.completed_checkpoint then
    raise exception 'provider promotion lane cannot regress' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger provider_promotion_lanes_monotonic
before update on public.provider_promotion_lanes
for each row execute function public.protect_provider_promotion_lane_monotonic();

create function public.protect_manifest_promotion_lane_monotonic()
returns trigger language plpgsql as $$
begin
  if new.next_evaluation_sequence < old.next_evaluation_sequence
     or new.requested_evaluation_sequence < old.requested_evaluation_sequence
     or new.confirmed_evaluation_sequence < old.confirmed_evaluation_sequence
     or new.active_generation < old.active_generation then
    raise exception 'manifest promotion lane cannot regress' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger manifest_promotion_lanes_monotonic
before update on public.manifest_promotion_lanes
for each row execute function public.protect_manifest_promotion_lane_monotonic();

create function public.protect_catalog_promotion_bootstrap_proof()
returns trigger language plpgsql as $$
begin
  raise exception 'catalog promotion bootstrap proof is immutable'
    using errcode = '55000';
end;
$$;

create trigger catalog_promotion_bootstrap_proofs_immutable
before update or delete on public.catalog_promotion_bootstrap_proofs
for each row execute function public.protect_catalog_promotion_bootstrap_proof();

create trigger catalog_promotion_bootstrap_provider_proofs_immutable
before update or delete on public.catalog_promotion_bootstrap_provider_proofs
for each row execute function public.protect_catalog_promotion_bootstrap_proof();

create function public.prepare_catalog_configuration_provider_set_change(
  target_organization_id uuid,
  next_configuration jsonb,
  changed_at timestamp(6) with time zone
)
returns text language plpgsql as $$
declare
  prior_configuration jsonb;
  prior_platform_keys text[];
  next_platform_keys text[];
  removed_platform_keys text[];
begin
  perform 1
  from public.organizations
  where id = target_organization_id
  for update;

  select configuration_json
  into prior_configuration
  from public.approved_public_catalog_configurations
  where organization_id = target_organization_id
  order by public_change_sequence desc, revision desc
  limit 1;

  if prior_configuration is null then
    return 'allowed';
  end if;

  select coalesce(
    array_agg(platform_key order by platform_key collate "C"),
    array[]::text[]
  )
  into prior_platform_keys
  from (
    select entry->>'platformKey' as platform_key
    from jsonb_array_elements(prior_configuration->'platforms') as entry
  ) as prior_platforms;

  select coalesce(
    array_agg(platform_key order by platform_key collate "C"),
    array[]::text[]
  )
  into next_platform_keys
  from (
    select entry->>'platformKey' as platform_key
    from jsonb_array_elements(next_configuration->'platforms') as entry
  ) as next_platforms;

  select coalesce(
    array_agg(platform_key order by platform_key collate "C"),
    array[]::text[]
  )
  into removed_platform_keys
  from unnest(prior_platform_keys) as platform_key
  where not (platform_key = any(next_platform_keys));

  if cardinality(removed_platform_keys) = 0 then
    return 'allowed';
  end if;

  if exists (
    select 1
    from public.manifest_active_provider_selections as selection
    where selection.organization_id = target_organization_id
      and selection.platform_key = any(removed_platform_keys)
  ) or exists (
    select 1
    from public.provider_promotion_attempts as attempt
    where attempt.organization_id = target_organization_id
      and attempt.platform_key = any(removed_platform_keys)
      and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and exists (
        select 1
        from public.provider_promotion_operations as operation
        where operation.attempt_id = attempt.id
          and operation.send_count > 0
      )
  ) or exists (
    select 1
    from public.manifest_promotion_attempts as attempt
    where attempt.organization_id = target_organization_id
      and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and exists (
        select 1
        from public.manifest_promotion_operations as operation
        where operation.attempt_id = attempt.id
          and operation.send_count > 0
      )
      and (
        attempt.prepared_summary_body is null
        or jsonb_typeof(
          attempt.prepared_summary_body::jsonb->'providerSelections'
        ) is distinct from 'array'
        or exists (
          select 1
          from jsonb_array_elements(
            attempt.prepared_summary_body::jsonb->'providerSelections'
          ) as selection
          where selection->>'platformKey' = any(removed_platform_keys)
        )
      )
  ) then
    return 'promotion_recovery_required';
  end if;

  update public.provider_promotion_attempts as attempt
  set state = 'superseded', terminal_at = changed_at,
      claim_owner = null, claim_token = null, claim_expires_at = null,
      last_heartbeat_at = null, retry_at = null, updated_at = changed_at
  where attempt.organization_id = target_organization_id
    and attempt.platform_key = any(removed_platform_keys)
    and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
    and not exists (
      select 1
      from public.provider_promotion_operations as operation
      where operation.attempt_id = attempt.id and operation.send_count > 0
    );

  update public.provider_promotion_lanes
  set next_retry_at = null, updated_at = changed_at
  where organization_id = target_organization_id
    and platform_key = any(removed_platform_keys);

  update public.manifest_promotion_attempts as attempt
  set state = 'superseded', terminal_at = changed_at,
      claim_owner = null, claim_token = null, claim_expires_at = null,
      last_heartbeat_at = null, retry_at = null, updated_at = changed_at
  where attempt.organization_id = target_organization_id
    and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
    and not exists (
      select 1
      from public.manifest_promotion_operations as operation
      where operation.attempt_id = attempt.id and operation.send_count > 0
    );

  update public.manifest_promotion_lanes
  set next_retry_at = null, updated_at = changed_at
  where organization_id = target_organization_id;

  return 'allowed';
end;
$$;

create function public.guard_catalog_configuration_provider_set_change()
returns trigger language plpgsql as $$
begin
  if public.prepare_catalog_configuration_provider_set_change(
    new.organization_id, new.configuration_json, new.approved_at
  ) <> 'allowed' then
    raise exception 'public configuration promotion recovery required'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger approved_public_catalog_configurations_promotion_guard
before insert on public.approved_public_catalog_configurations
for each row execute function
  public.guard_catalog_configuration_provider_set_change();
