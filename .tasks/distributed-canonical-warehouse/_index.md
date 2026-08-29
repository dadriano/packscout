# Feature: Distributed Canonical Warehouse

## Start Here

Open task `distributed-canonical-warehouse/022` and port the authoritative
port-5101 `apps/admin` baseline to the new central/provider ownership model.
Do not use the simplified distributed-branch shell as compatibility evidence.

**Progress:** 11/22 tasks complete

## Current Build Checkpoint

Finish the work already in progress, then complete Task 022 by porting the
authoritative `apps/admin` baseline at commit `225f9a1` to only the new
central/provider topology. The simplified admin shell currently present on this
branch is not parity evidence. After the full route shell and supporting admin
workflows are preserved, complete Task 021's parallel ClutchPacks and Courtyard
captured-feed import proof. Run now must return
`PROVIDER_SOURCE_ADAPTER_UNAVAILABLE` without mutation for an uninstalled
integration. After both installed providers can be triggered and ingest into
separate databases concurrently, pause to realign priorities before starting
Tasks 015–020. No Convex manifest activation or frontend gate work proceeds at
this checkpoint.

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

- Provider-specific fetchers, adapters, parsers, mappings, raw payload storage, replay archives, and unresolved source-record staging.
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
| 002 | Preserve organization and admin access | large | 3–5 days | done | 001 |
| 003 | Register and route providers safely | large | 4–6 days | done | 001, 002 |
| 004 | Give each provider a canonical warehouse | large | 4–6 days | done | 001 |
| 005 | Keep provider execution state local | large | 4–6 days | done | 003, 004 |

### Catalog and provider operations

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 006 | Maintain one shared global catalog | large | 4–6 days | done | 002, 003, 004 |
| 007 | Complete one mixed-response provider run | large | 4–6 days | in progress | 005 |
| 008 | Operate provider runs from admin | large | 3–5 days | in progress | 002, 003, 005, 007 |
| 009 | Diagnose and recover provider work | large | 3–5 days | done | 005, 007, 008 |
| 010 | Observe provider health and alerts | large | 3–5 days | done | 002, 003, 005, 007 |

### Diagnostics and publication

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 011 | Preserve the Data Feed Lab | small | 1–2 days | done | 002, 003 |
| 012 | Publish shared catalog versions safely | large | 3–5 days | done | 006 |
| 013 | Assemble immutable provider releases | large | 5–7 days | done | 006, 007, 012 |
| 014 | Publish provider releases safely | large | 4–6 days | in progress | 013 |
| 015 | Advance provider manifest gates independently | large | 4–6 days | not started | 012, 014 |

### Delivery and proof

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 016 | Serve the frontend from active provider gates | large | 3–5 days | not started | 015 |
| 017 | Reconcile and retain publication state | large | 3–5 days | not started | 012, 014, 015 |
| 018 | Prove distributed security and failure isolation | large | 3–5 days | not started | 005, 006, 012, 014, 015 |
| 019 | Publish the system overview and ERDs | medium | 2–3 days | not started | 006, 015, 016, 018 |
| 020 | Certify the distributed warehouse | large | 5–8 days | not started | 008, 009, 010, 011, 016, 017, 018, 019 |

### Authoritative admin compatibility

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 022 | Port the authoritative admin baseline | large | 8–12 days | in progress | 002, 003, 005, 007, 009, 010 |

### Provider integration checkpoint

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 021 | Prove two provider imports in parallel | large | 4–7 days | not started | 007, 008, 022 |

Total estimated builder effort is 77–120 days, including focused verification in every task. The dependency critical path is approximately 50–76 builder days; independent tasks reduce elapsed time when built in parallel.

## Build Order

1. Complete task 001, then establish central admin ownership in task 002 and the provider canonical template in task 004.
2. Complete task 003, then build provider runtime task 005 and shared catalog task 006 in parallel.
3. Complete the mixed provider run in task 007 while tasks 010–012 use their satisfied boundaries; follow with admin run and recovery tasks 008–009.
4. Assemble and publish provider releases through tasks 013–014, then join them with catalog publication task 012 at the per-provider manifest gate in task 015.
5. Port the authoritative admin baseline in task 022, then prove ClutchPacks and Courtyard imports through that UI in task 021.
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
| P | 007, 008, and 022 complete | 021 |

## Next Action

Open `022-port-authoritative-admin-baseline.md` and inventory every route,
runtime, repository, and supporting table in the commit-`225f9a1` admin before
changing the current UI or wiring either provider integration.
