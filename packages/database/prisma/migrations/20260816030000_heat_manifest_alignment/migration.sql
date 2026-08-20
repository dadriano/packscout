-- Task 012: retain the exact Task 011 manifest/provider source proof used to
-- prepare every immutable Heat attempt. The proof is audit evidence only and
-- deliberately does not participate in Heat frame/content identity.

alter table public.promotion_attempts
  add column manifest_source_proof_body text,
  add column manifest_source_proof_sha256 text,
  add constraint promotion_attempts_manifest_source_proof_shape_check check (
    (
      manifest_source_proof_body is null
      and manifest_source_proof_sha256 is null
    ) or (
      lane_key = 'heat'
      and manifest_source_proof_body is not null
      and manifest_source_proof_sha256 is not null
      and octet_length(manifest_source_proof_body) between 2 and 4194304
      and public.promotion_v2_sha256_valid(manifest_source_proof_sha256)
    )
  ),
  add constraint promotion_attempts_heat_prepared_source_proof_check check (
    lane_key <> 'heat'
    or content_identity is null
    or (
      manifest_source_proof_body is not null
      and manifest_source_proof_sha256 is not null
    )
  );

create function public.protect_heat_manifest_source_proof()
returns trigger
language plpgsql
as $$
begin
  if old.manifest_source_proof_body is not null and (
    new.manifest_source_proof_body is distinct from
      old.manifest_source_proof_body
    or new.manifest_source_proof_sha256 is distinct from
      old.manifest_source_proof_sha256
  ) then
    raise exception 'heat manifest source proof is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger promotion_attempts_manifest_source_proof_immutable
before update on public.promotion_attempts
for each row execute function public.protect_heat_manifest_source_proof();
