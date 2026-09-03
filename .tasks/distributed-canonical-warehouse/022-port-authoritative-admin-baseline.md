# Task: Port the Authoritative Admin Baseline

**ID:** distributed-canonical-warehouse/022
**Depends on:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003, distributed-canonical-warehouse/005, distributed-canonical-warehouse/007, distributed-canonical-warehouse/009, distributed-canonical-warehouse/010
**Blocks:** distributed-canonical-warehouse/020, distributed-canonical-warehouse/021
**Estimated scope:** large
**Estimated effort:** 8–12 days for one builder, including schema ownership, current route parity, source/worker adaptation, and end-to-end verification
**Status:** in progress

## Start Here

Treat `apps/admin` at commit `225f9a1` on
`codex/complete-clutchpacks-v3-cutover`—the application currently served on
local port 5101—as the authoritative UI, route, API, and behavior baseline.
Inventory every dependency before replacing a repository or runtime. The
simplified admin shell originally built on the distributed branch is not an
acceptable baseline and must not be used as parity evidence.

## Objective

Run the exact current PackScout admin experience against the new central
`packscout` database and independently routed `packscout_<provider_key>`
databases without retaining the legacy combined operational schema.

## Context

The distributed implementation began from an obsolete admin shell. The current
admin has materially more functionality: operator invitations and password
recovery; product users, allowlist, and message delivery; provider and source
configuration; import runs, background work, worker fleet, alerts, and
quarantine; and canonical, published, and comparison data inspection.

This is a contract-preserving port, not a new admin redesign. Browser components,
route paths, accessibility behavior, and safe DTOs remain recognizable. Server
runtimes and persistence repositories move to the new ownership boundaries.
There are no compatibility reads, dual writes, legacy database fallbacks, or
browser-selected database connections.

## Ownership Matrix

### Central `packscout`

- Organizations, operators, memberships, sessions, authentication rate limits,
  invitations/password-link state, and central audit events.
- Provider registry, public/config versions, encrypted credential versions,
  database topology, connection tests, and provider ownership.
- Central worker presence and configuration because runners are centralized.
- Email message intents, attempts, and link-token metadata used by the current
  Operators, Messages, invitation, and password-reset workflows.
- Provider-independent activity events for global conditions such as no live
  workers; provider-scoped observations continue to identify their provider.
- Best-effort provider activity observations, durable health, alerts, and
  publication/manifest control-plane state.
- Shared global category and collectible catalog.

### Provider `packscout_<provider_key>`

- Provider source identity/config snapshots required to execute that provider,
  source cursor/runtime/schedule state, run leases, and provider-local runtime.
- Packs, collectibles, instances, pack contents, accounts, pulls, pull items,
  market events, promotion changes, and immutable release assembly.
- Run pages, quarantine and retry attempts, local retention/recomputation work,
  local audit, activity outbox, and provider publication state.

### Existing external boundary

- Product-user directory, saved items, beta allowlist, and published catalog
  reads continue through the current server-owned Convex/directory HTTP boundary.
  The browser receives only the existing safe admin projections and never a
  directory token or Convex credential.
- Preserve the active commit-`225f9a1` Convex/frontend contract, including
  product users, beta allowlist entries, saved items, provider-catalog releases
  and reconciliation, global catalog manifests, Data Release V3 tables, and
  their existing admin HTTP endpoints. Older distributed publication tables
  cannot replace this baseline.

## Requirements

### Exact application baseline

- Preserve the current protected shell and these navigation destinations:
  `/`, `/operators`, `/users`, `/allowlist`, `/messages`, `/operations`,
  `/providers`, `/source-configuration`, `/runs`, `/background-work`,
  `/workers`, `/alerts`, `/quarantine`, `/data/canonical`,
  `/data/published`, and `/data/compare`.
- Preserve current detail, create/edit, invitation, forgot-password, reset, and
  not-found routes declared by the authoritative `App.tsx` and route catalog.
- Preserve the active behavior that retired historical provider-configuration
  mutations return `410` and current configuration is managed through Sources.
- Do not carry `/data-api-tester` forward: it belongs to the obsolete
  distributed shell and is not an authoritative current-admin route.
- Preserve current styling, responsive layout, theme, breadcrumbs, navigation,
  permissions, focus management, live regions, empty states, partial failures,
  and stable browser-safe errors.
- Remove the obsolete distributed-branch shell only after the authoritative
  components and route tests are present and passing.

### Central supporting workflows

- Add clean central models and migrations for current admin support state that
  is not already represented, especially email intent/attempt/link records and
  centralized worker presence/configuration plus provider-independent global
  activity.
- Preserve operator invitation lifecycle with `pending`, `active`, `disabled`,
  and `cancelled` states and the authoritative permission vocabulary.
- Keep product-user and allowlist source-of-truth data outside Postgres as in the
  current admin; store only bounded PackScout audit and delivery state centrally.
- Adapt operator invitation, account-created notice, password reset, Messages,
  worker fleet, provider registry/configuration, health, and alert runtimes to
  the central database client.
- Start the admin with `PACKSCOUT_CONTROL_DATABASE_URL` plus server-owned routing
  and external service configuration; do not require
  `PACKSCOUT_DATABASE_URL` or instantiate the legacy Prisma client.

### Provider-scoped workflows

- Adapt Operations, Runs, Background Work, Quarantine, Canonical, and Compare
  reads to require validated provider context and route directly to one provider
  database after central authorization.
- Add the provider-local recomputation queue required by the existing Background
  Work page; do not leave that route backed by the legacy database.
- Preserve bounded cross-provider views by merging typed per-provider results;
  one unreachable provider remains one explicit unavailable result.
- Adapt Source Configuration and Workers to the hybrid model: centralized
  runners and credentials/configuration, provider-local schedules, cursors,
  leases, runtime, and run history.
- Keep one platform-level Run now action. Catalog, pulls, and market events are
  counters from the same response, not individually managed streams.
- Map an uninstalled integration to
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE`, render it accessibly, and create no
  provider command or run.

### Safety and migration discipline

- Preserve the authoritative admin's public HTTP validation, fixed roles,
  origin/CSRF controls, session behavior, structured errors, and secret
  redaction tests.
- Keep `frontend` and `admin` independent and prevent browser code from
  importing database, service, worker, or server modules.
- Do not merge the old schema into the new schemas, emulate legacy tables,
  dual-read, dual-write, or add a legacy database fallback.
- Port current source adapter and supervisor behavior through explicit new
  central/provider repositories; provider-specific mapping remains outside
  generic orchestration code.
- Port provider-release publication behind the active Convex manifest and V3
  release contracts. Do not replace `convex/schema.ts` with the older
  distributed schema or remove active frontend/admin directory tables.

## User-Facing Behavior

Opening the new preview looks and navigates like the current port-5101 admin.
Every existing destination remains present subject to the same permissions.
ClutchPacks and Courtyard appear as independently reachable providers. An
operator can trigger one run per provider and inspect its source, run,
quarantine, worker, canonical, and comparison state without learning which
database connection was used.

## Acceptance Criteria

### Current live checkpoint — 2026-08-29

- The authoritative preview runs at `http://127.0.0.1:5111` with all four
  centrally registered provider databases. Canonical Data is now backed by
  real routed canonical repositories, including row expansion and isolated
  unavailable-provider results.
- Run detail carries `providerId` alongside the existing run path. Central
  organization authorization selects the exact provider database; newly queued
  or running records do not depend on an activity relay to discover ownership.
  The live Collector Crypt run detail was opened from the Runs ledger and
  displayed 330,600 committed records while its import continued.
- The new run schema measures accepted, duplicate, quarantined, and combined
  material changes, not separate inserted/revised counts. The existing admin
  projections now use explicit unavailable insert/update counts and render
  that limitation instead of mislabeling all material changes as revisions.
- A provider-source overview with no active providers is now a valid empty
  response, not a `503`. Focused regressions preserve the 50-provider bound,
  authentication, organization scoping, and zero unnecessary provider calls.
- Full admin parity is **not complete**. Background Work/recomputation,
  Compare/parity, and provider-local quarantine detail/retry still need their
  distributed implementations. These remain explicit Task 022 work; route
  presence or a safe unavailable response is not acceptance evidence.

### Baseline parity

- [x] The authoritative route catalog and protected shell are present with no
  simplified-shell route or visual substitution.
- [ ] Existing current-admin component and route behavior tests pass after their
  API implementations move to distributed repositories.
- [ ] Login, invitations, password recovery, operators, users, allowlist,
  messages, providers, source configuration, workers, and data inspection retain
  their current success, loading, empty, forbidden, and failure behavior.
- [x] Active product-user, allowlist, saved-item, provider-catalog, global
  manifest, and Data Release V3 Convex contracts remain present and their
  focused tests continue to pass.
- [ ] The preview is visually checked against port 5101 at desktop and narrow
  widths before it is shown as the replacement admin.

### Distributed ownership

- [ ] Admin startup uses only the central database URL, validated provider
  routing, and existing server-owned external service configuration.
- [ ] Central supporting tables cover message/link and centralized worker state;
  provider runtime, runs, cursors, quarantine, and canonical data remain local.
- [ ] Provider-independent activity and provider-local recomputation work support
  the current Overview, Workers, Alerts, and Background Work states.
- [ ] Operations, Runs, Background Work, Quarantine, Canonical, and Compare never
  scan databases to discover ownership and never expose a connection string.
- [ ] One unreachable provider does not prevent healthy provider reads or
  controls, and every partial result identifies its observation time.
- [ ] No runtime query or mutation touches the legacy combined schema.

### Checkpoint readiness

- [x] Run now from the authoritative Providers/Operations experience reaches
  the new provider-level command path.
- [x] An uninstalled provider fails before mutation with
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE` in an accessible error state.
- [ ] ClutchPacks and Courtyard can be configured through the current admin
  workflow without per-data-type management controls.
- [x] Focused tests, admin production build, distributed schema checks, and
  `npm run verify:framework` pass.

## Spec Compliance

- Schema authority remains `tech-001-database-schema-contract.md`; this task
  adds the previously omitted supporting-admin ownership needed to satisfy the
  user's explicit compatibility requirement.
- The authoritative UI/behavior baseline is commit `225f9a1`; the distributed
  schema and no-legacy-runtime rules remain authoritative for persistence.
- Any current admin workflow that cannot map cleanly to those boundaries must be
  recorded as a design blocker instead of being silently dropped or backed by a
  compatibility shim.
- Verification on 2026-08-29: `npm run verify:framework` passed end to end,
  including distributed schema validation, the unchanged standards ratchet,
  workspace lint/typechecks/tests, tooling tests, and frontend/admin production
  builds. The admin suite passed 491/491; Convex passed 336/336. Independent
  focused runs also passed 64 provider-qualified run-detail cases and 15
  counter-contract/projection/rendering cases. The live Collector Crypt detail
  continued polling committed progress after the production builds, and the
  frontend still showed all 17 locally published ClutchPacks repacks.
- A passing verifier certifies this checkpoint, not the unimplemented
  Background Work, Compare, and quarantine detail/retry parity described above.
- The prior full-gate result applies to checkpoint `5e280fb`. The empty-overview
  and migration-control review follow-ups also passed a complete
  `npm run verify:framework` rerun on 2026-08-29, including both production
  builds. Updated suites passed 319 contract tests, 493 admin tests, 543
  ops-panel tests, and 493 tooling tests (three environment-gated tooling skips
  plus three passing isolated embedded-admin tests). All remaining suite
  counts and protected skips matched the prior checkpoint.
- The optional follow-up browser recheck was blocked by the Browser URL policy;
  no alternate browser or HTTP workaround was attempted. The successful live
  UI evidence above remains evidence for `5e280fb`, not a new browser pass.
