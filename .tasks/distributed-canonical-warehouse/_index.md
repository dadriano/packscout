# Feature: Distributed Canonical Warehouse

## Start Here

Open task `distributed-canonical-warehouse/022` and port the authoritative
port-5101 `apps/admin` baseline to the new central/provider ownership model.
Do not use the simplified distributed-branch shell as compatibility evidence.

**Progress:** 12/23 tasks complete; distributed publication foundations are
complete while Admin parity, provider imports, and rollout certification remain
in progress

## Current Build Checkpoint

Complete the live checkpoint already in progress. The authoritative admin is
running on the central/provider topology; Canonical Data now routes directly to
each isolated provider database. Task 023's ClutchPacks dataset is the frozen
publication input. Task 021 is importing Courtyard to source head with one
provider-local run, lease, cursor, and database while preserving the independent
queued ClutchPacks command.

The operator subsequently approved two explicit extensions to the earlier
checkpoint: publish the stable ClutchPacks snapshot to local Convex and prove the
frontend reads it, and activate/import Collector Crypt and Phygitals after each
passes its own live source-admission check. These lanes run in parallel. An
uninstalled or unproven integration must still return
`PROVIDER_SOURCE_ADAPTER_UNAVAILABLE` without mutation. Heat remains deferred.

### Local ClutchPacks publication proof

The local review snapshot at provider promotion sequence `78502` contains 17
active packs, 6,655 active collectibles, and no pack-content or central identity
correlations. The one-shot local publisher therefore exposes exactly 17 repacks
and no fabricated categories, collectibles, or chases. Signed provider release
`c24e324f-397c-57af-8ecf-f8c3f8316909` is selected by active manifest
`bcc99f7e-13ce-5f09-9298-fbc9c4c240fb`; the current frontend's V3 release is
`9acfbde2-3aaf-8b7e-8564-4570f998d997`. Both public query paths return the same 17
pack IDs, and the live `/packs` UI shows `1–17 of 17` for ClutchPacks.

The dedicated publication agent also hardened temporary signing-authority
cleanup: all owned keys are attempted, absence is verified before reporting
ready, and secret values use stdin rather than command-line arguments. The
26 focused publication tests pass, including partial installation, failed or
uncertain cleanup, changed ownership, pipe-drain readback, and missing snapshot
configuration/worker rows.

This is a local proof utility, not completion of Tasks 015–016 or a production
dual-publication design. The exact compatibility shape is the existing
frontend `publicRepacksV3` read model, assembled from the same frozen provider
snapshot only after the signed provider manifest is read back as active. The
integration task owns this temporary local bridge. Remove it when Task 016
serves the frontend directly from the manifest-native contract; reset the local
derived Convex data at that transition rather than carrying both paths into
production. It introduces no PostgreSQL compatibility schema, dual canonical
writes, fake correlations, or auth bypass.

### Remaining checkpoint boundaries

Courtyard and Collector Crypt are importing concurrently with zero quarantines
at their latest audited milestones; neither is claimed to have reached source
head. Phygitals config v4 passed its immutable native-card adapter/replay gate
and is also importing independently: its 47,400-record checkpoint stored
45,530 new cards while preserving the previous 741 cards and all historical
quarantines. Sampled remaining rejects lack a reviewed card name. See Task 021
for the exact evidence and the distinction between repeated-quarantine
duplicates and canonical duplicates. Current admin Canonical Data and
provider-qualified run detail are wired; Background Work, Compare, and
quarantine detail/retry remain uncompleted Task 022 parity work.

The 2026-08-29 integrated checkpoint passed `npm run verify:framework`, including
schema checks, standards ratchet, workspace lint/typechecks/tests, tooling, and
frontend/admin production builds. The local previews remained healthy after
the builds. This is not a claim of source-head completion or full feature
acceptance; Tasks 021 and 022 remain in progress.

The later process handoff is recorded in Task 021: Courtyard and Phygitals
resumed their exact durable checkpoints through normal fenced recovery, and
Collector Crypt moved to a detached process while retaining its run/fence.
All three now run independently of agent tool sessions. The empty-provider
overview review fix is covered by focused regressions. Migration deployment is
supported only through the explicit central/single-provider CLI; the legacy
ops-panel migration action and Task010 deploy path now refuse safely pending
a role-aware ops-panel port. A full `npm run verify:framework` rerun passed for
these review changes, including 319 contract tests, 493 admin tests, 543
ops-panel tests, 493 tooling tests, and both production builds. Existing
environment-gated skips remain explicitly reported; no standards baseline was
weakened. The bounded review watch produced these two follow-ups but no
approval; import monitoring continues every ten minutes.

### Incoming main integration

Newer `main` commit `7911a6c` introduces configurable request sizes and conflicts
with this branch in five files. Integrating it requires more than marker
cleanup: preserve immutable distributed 100/2,000-record source profiles,
populate its new `recordsPerRequest` projections, and retain independently
scoped Prisma commands. Its broader EV/Convex changes also require a fresh
integration proof. The local checkpoint remains isolated; the PR is not
merge-ready until that separate integration is completed.

## Context

PackScout needs a simple PostgreSQL warehouse that can hold provider catalogs, repacks, collectibles, pulls, and market activity without carrying forward the current single-database canonical revision graph. The new system separates failure and scale boundaries while keeping the current admin application and frontend-serving contracts recognizable.

The central `packscout` database is the control plane and shared identity space. Every provider owns one isolated `packscout_<provider_key>` database on its own PostgreSQL instance or cluster. Provider databases remain authoritative for their canonical data and execution state; the central database observes them and stores durable administrative state.

This feature is a clean pre-launch implementation. It does not migrate or dual-run the current schema. Source-specific fetching and mapping are deliberately deferred so the warehouse, control plane, and publication boundaries can be built first.

## Success Signals

- A clean environment can provision `packscout` plus at least two isolated provider databases and verify each schema independently.
- Two providers can run concurrently, and an unreachable or failed provider cannot block the other provider's run, admin view, or publication.
- The authoritative current admin route catalog and fixed roles work against the new central and provider-local ownership model without per-data-type stream controls.
- Convex serves only immutable provider releases selected by one manifest with an independently gated version and catalog version for each provider.
- The documented ERDs match the implemented ownership boundaries, and the repository verification gate passes without a bypass.

## Resolved Decisions

### Ownership and naming

- `provider` is the canonical internal term. New schemas, contracts, services, and admin responses use `provider`, `provider_id`, and `provider_key` without `platform` or `site` aliases.
- `packscout` contains organizations, admin access, provider registry and topology, encrypted provider credentials, central observations and alerts, and one shared global catalog.
- Each provider has one physical `packscout_<provider_key>` database containing its canonical catalog, transactions, runtime, runs, quarantine, local audit, and promotion state.
- The PostgreSQL instance or cluster identifies the environment; database names do not gain environment suffixes. Each database has one PackScout application schema.
- Cross-database identifiers are validated soft references. There are no cross-database foreign keys, joins that pretend to be foreign keys, or distributed transactions.

### Provider data and execution

- Provider categories form trees. Packs contain many collectibles, and collectible identities remain separate from exact collectible instances.
- A completed pull opens one pack and yields one or more pull items. Pulls, pull items, and market events are immutable historical facts.
- Mutable entities expose `created_at`, `updated_at`, and `row_version`. A material change and its promotion-change record commit in the same authoritative transaction.
- One provider run processes the mixed catalog, pull, and market-event response with one cursor, schedule, worker lease, and run history. Different providers run concurrently.
- `PROVIDER_RUNTIME` uses a general operating state, reason, and append-only transition history. Emergency stopping is represented by the ordinary stopped state plus a reason.

### Shared catalog and publication

- The global category and collectible catalog is shared across organizations; provider configuration, admin access, runs, and alerts remain organization-scoped.
- Unmatched provider collectibles receive provisional global identities immediately. Only deterministic correlations apply automatically; ambiguous matches remain suggestions.
- `publicCollectibleId` is the global collectible ID. Merges preserve retired IDs through permanent aliases so saved references continue to resolve.
- A provider promotion builds a complete immutable release from a stable provider checkpoint and a pinned global catalog version. Mutable rows are never published incrementally into a visible release.
- One Convex manifest gates the active release and catalog version independently per provider. Updating one provider leaves every unrelated provider entry unchanged.

### Compatibility and safety

- The current port-5101 admin route set, fixed `admin | data_operator` roles, session security, provider/source configuration, run inspection, worker fleet, quarantine recovery, alerts, user/allowlist/message workflows, and canonical/published/compare inspection remain behaviorally compatible.
- Admin control validates organization ownership centrally, resolves credentials server-side, and then connects directly to the selected provider database. Unreachable providers return explicit isolated failures.
- Current public repack and collectible DTOs, search behavior, cursor safety, unavailable-value semantics, and saved public IDs remain stable across release activation.
- Provider-local and central activity propagation is best effort; alert acknowledgement and resolution remain durable in `packscout`.
- Pack economics remain provider-local and preserve the current public EV and buyback fields. This feature does not redesign EV methodology.

## Out of Scope

### Deferred data features

- Provider-specific integrations beyond the four approved DataForrest launch
  providers: ClutchPacks, Courtyard, Collector Crypt, and Phygitals. Raw payload
  storage, replay archives, and unresolved source-record staging remain
  deferred.
- Product normalization, a global pack identity layer, and global catalog governance screens in the admin application.
- Heat storage, calculation, publication, or frontend redesign. Catalog availability must not depend on Heat.
- Publication of exact collectible instances, provider accounts, credentials, raw pulls, raw market-event histories, quarantine evidence, or runtime state to Convex.
- A new EV formula or independent valuation methodology.

### Deferred rollout work

- Migrating, backfilling, reconciling, deleting, or decommissioning the current `packscout_dev` schema.
- Compatibility reads, dual reads, dual writes, legacy stream shims, or a live production cutover.
- Production source population and production manifest activation.
- A durable central queue of offline commands for unreachable provider databases.

## Tasks

### Foundations and ownership

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Establish distributed database ownership | large | 4–6 days | done | none |
| 002 | Preserve organization and admin access | large | 3–5 days | in progress | 001 |
| 003 | Register and route providers safely | large | 4–6 days | not started | 001, 002 |
| 004 | Give each provider a canonical warehouse | large | 4–6 days | done | 001 |
| 005 | Keep provider execution state local | large | 4–6 days | done | 003, 004 |

### Catalog and provider operations

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 006 | Maintain one shared global catalog | large | 4–6 days | done | 002, 003, 004 |
| 007 | Complete one mixed-response provider run | large | 4–6 days | in progress | 005 |
| 008 | Operate provider runs from admin | large | 3–5 days | in progress | 002, 003, 005, 007 |
| 009 | Diagnose and recover provider work | large | 3–5 days | done | 005, 007, 008 |
| 010 | Observe provider health and alerts | large | 3–5 days | done | 005 |

### Diagnostics and publication

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 011 | Exclude the obsolete Data Feed Lab | small | <1 day | done | 002, 003 |
| 012 | Publish shared catalog versions safely | large | 3–5 days | done | 006 |
| 013 | Assemble immutable provider releases | large | 5–7 days | done | 006, 007, 012 |
| 014 | Publish provider releases safely | large | 4–6 days | done | 013 |
| 015 | Advance provider manifest gates independently | large | 4–6 days | done | 012, 014 |

### Delivery and proof

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 016 | Serve the frontend from active provider gates | large | 3–5 days | not started | 015 |
| 017 | Reconcile and retain publication state | large | 3–5 days | not started | 012, 014, 015 |
| 018 | Prove distributed security and failure isolation | large | 3–5 days | not started | 005, 006, 012, 014, 015 |
| 019 | Publish the system overview and ERDs | medium | 2–3 days | not started | 006, 015, 016, 018 |
| 020 | Certify the distributed warehouse | large | 5–8 days | not started | 008, 009, 010, 011, 016, 017, 018, 019, convex-promotion-jobs/009 |

### Authoritative admin compatibility

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 022 | Port the authoritative admin baseline | large | 8–12 days | in progress | 002, 003, 005, 007, 009, 010 |

### Provider integration checkpoint

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 023 | Run ClutchPacks end to end first | large | 2–4 days | done | 007, 008, 022 |
| 021 | Prove two provider imports in parallel | large | 2–4 days | in progress | 007, 008, 022, 023 |

Total estimated builder effort is 77–121 days, including focused verification in every task. The dependency critical path is approximately 50–77 builder days; independent tasks reduce elapsed time when built in parallel.

## Build Order

1. Complete task 001, then establish central admin ownership in task 002 and the provider canonical template in task 004.
2. Complete task 003, then build provider runtime task 005 and shared catalog task 006 in parallel.
3. Complete the mixed provider run in task 007 while tasks 010–012 use their satisfied boundaries; follow with admin run and recovery tasks 008–009.
4. Assemble and publish provider releases through tasks 013–014, then join them with catalog publication task 012 at the per-provider manifest gate in task 015.
5. Port the authoritative admin baseline in task 022, prove ClutchPacks alone in task 023, then add Courtyard and prove concurrent isolation in task 021.
6. Complete frontend, reconciliation, security, and documentation tasks 016–019, then run certification task 020.

## Parallel Groups

### Foundation groups

| Group | Ready when | Tasks |
|---|---|---|
| A | immediately | 001 |
| B | 001 complete | 002, 004 |
| C | 002 complete | 003 |
| D | 003 and 004 complete | 005, 006 |
| E | 002 and 003 complete | 011 |

### Operations and publication groups

| Group | Ready when | Tasks |
|---|---|---|
| F | 005 complete | 007, 010 |
| G | 006 complete | 012 |
| H | 007 complete | 008 |
| H2 | 007 and 012 complete | 013 |
| I | 008 complete | 009 |
| J | 013 complete | 014 |

### Delivery groups

| Group | Ready when | Tasks |
|---|---|---|
| K | 012 and 014 complete | 015 |
| L | 015 complete | 016, 017, 018 |
| M | 016 and 018 complete | 019 |
| N | 008–019 complete | 020 |
| O | 002, 003, 005, 007, 009, and 010 complete | 022 |
| P | 007, 008, and 022 complete | 023 |
| Q | 007, 008, 022, and 023 complete | 021 |

## Next Action

Keep the independently running Courtyard, Collector Crypt, and Phygitals
imports monitored to source head, then freeze terminal counts and verify replay
and isolated failure evidence. The local ClutchPacks Convex/frontend proof is
complete; do not consume its independent queued command. Complete the remaining
Task 022 admin parity before claiming the full admin port or feature is done.
