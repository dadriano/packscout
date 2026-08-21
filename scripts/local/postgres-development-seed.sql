-- PackScout local development seed.
--
-- This is the workspace's canonical relational seed: the minimum spine a
-- developer needs after a fresh migrate, and nothing more. It is deliberately
-- small, because a seed that invents catalog data would compete with the
-- provider imports as a source of truth.
--
-- Every statement is idempotent. Running the seed twice adds nothing, so it is
-- safe on a database that already has data as well as on an empty one, and it
-- never deletes anything: destroying data is the reset workflow's job, under a
-- typed acknowledgement.

insert into organizations (id, slug, name)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'packscout-local',
  'PackScout Local Development'
)
on conflict (slug) do nothing;

insert into provider_sources (id, organization_id, platform_key, display_name, state)
select
  seed.id::uuid,
  organizations.id,
  seed.platform_key,
  seed.display_name,
  'draft'::provider_state
from organizations
cross join (
  values
    ('00000000-0000-4000-8000-000000000011', 'beezie', 'Beezie (local development)'),
    ('00000000-0000-4000-8000-000000000012', 'courtyard', 'Courtyard (local development)'),
    ('00000000-0000-4000-8000-000000000013', 'gamestop', 'GameStop (local development)')
) as seed (id, platform_key, display_name)
where organizations.slug = 'packscout-local'
on conflict (organization_id, platform_key) do nothing;
