# Feature: Data Pipeline

**Progress:** 18/18 tasks complete

## Context

PackScout needs a reliable boundary between external data providers and its database. Operators must configure one active provider for each supported platform, choose the adapter that understands that provider, validate the connection, and run imports automatically or manually. The first adapter calls an HTTP endpoint with a platform and opaque cursor and receives the `catalog`, `pulls`, and `sales` payload families represented in the supplied `packscout-data` samples.

The repository currently has independent frontend and admin foundations but no authentication, persistence, shared service layer, or ingestion runtime. This feature therefore establishes those real boundaries without coupling browser code to database or provider code. The initial rollout covers Beezie, ClutchPacks, Collector Crypt, Courtyard, GameStop, Phygitals, Stadium Vault, and Trove.

### Product and operation decisions

- Provider configurations are versioned, and each platform has exactly one active configuration at a time.
- Imports run on a configurable schedule that defaults to five minutes; administrators and data operators can also start or retry work manually.
- A new configuration imports all history exposed by the provider, then resumes incrementally from a durable opaque cursor.
- A provider has its own stale threshold, defaulting to fifteen minutes, and freshness is tracked separately from data-quality warnings.
- Configurations must pass validation and a non-importing connection test before activation; disabling or archiving prevents new runs while allowing an active run to finish.

### Data and calculation decisions

- Every fetched page is retained as replayable raw source data for ninety days, while canonical history and current projections are retained indefinitely.
- Canonical projections cover platforms, purchasable packs, supporting catalog or inventory assets, pulls, and sales; unresolved relationships remain recoverable until their related records arrive.
- Valid records import immediately, invalid records enter quarantine for independent retry, and the provider cursor advances after the raw page and record outcomes are durable.
- Provider-reported EV remains distinct from PackScout Estimated EV. PackScout uses probability-bucket midpoints and never labels the V1 calculation exact.
- Estimated gross EV and EV percentage are calculated only from USD or verified USD-stablecoin values and expose methodology, coverage, source time, calculation time, and an unavailable reason when inputs are insufficient.

### Security and ownership decisions

- The admin is single-organization and invite-only, using administrator-provisioned email/password accounts modeled on the approved reference admin login and session behavior.
- Administrators manage accounts, provider settings, secrets, lifecycle, and roles; data operators view status and start or retry imports.
- Provider secrets stay server-side and masked, while canonical actor identities are pseudonymous and omit source usernames and raw wallet addresses.
- Admin alerts, structured logs, and metrics use an abstract notification boundary; email, webhook, and other external channels are not implemented in V1.
- Full raw payloads are never returned to the browser; operator diagnostics use bounded, sanitized evidence linked to protected server-side source records.

## Resolved Decisions

- The adapter request is an HTTP GET with `platform` and, after the first page, `cursor`; authentication mode is `none` or a server-side bearer token.
- A response contains `catalog`, `pulls`, `sales`, `next_cursor`, and `has_more`; an empty first cursor starts the full available-history backfill.
- Catalog sources may contain packs, parent collections, variants, cards, price records, and inventory assets. Each independently purchasable option becomes a canonical pack; supporting records remain related catalog assets.
- Repeated source identities are idempotent. Changed content creates a canonical revision, unchanged content does not, and current projections point to the latest accepted revision.
- A pack stays visible when EV inputs are insufficient; PackScout EV is unavailable with a reason, while a provider-reported EV may still be shown separately.

## Out of Scope

- Calling PackScout Estimated EV exact or presenting it as independently verified market value
- Independent market-price collection, live foreign-exchange conversion, or non-USD EV calculation
- Multiple active providers or automatic multi-provider merging for one platform
- Public comparison-dashboard pages, buyer accounts, referrals, promotions, or public API design
- External notification delivery, self-service registration, emailed invitations, and self-service password recovery

## Tasks

### Foundation

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 001 | [Protect data operations](001-protect-data-operations.md) | large | done | none |
| 002 | [Establish the provider feed contract](002-establish-provider-feed-contract.md) | medium | done | none |
| 003 | [Persist source and canonical history](003-persist-source-and-canonical-history.md) | large | done | 002 |
| 004 | [Manage provider configurations](004-manage-provider-configurations.md) | large | done | 001, 002, 003 |
| 005 | [Import cursor pages idempotently](005-import-cursor-pages-idempotently.md) | large | done | 002, 003, 004 |

### Projection and reliability

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 006 | [Quarantine and retry invalid records](006-quarantine-and-retry-invalid-records.md) | medium | done | 005 |
| 007 | [Project catalog and inventory data](007-project-catalog-and-inventory-data.md) | large | done | 002, 003, 005 |
| 008 | [Project pulls and sales](008-project-pulls-and-sales.md) | large | done | 002, 003, 005 |
| 009 | [Calculate PackScout Estimated EV](009-calculate-estimated-ev.md) | large | done | 003, 007 |
| 010 | [Schedule imports and track freshness](010-schedule-imports-and-track-freshness.md) | large | done | 003, 004, 005 |

### Operator experience and operations

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 011 | [Manage providers in the admin](011-manage-providers-in-admin.md) | large | done | 001, 004, 010 |
| 012 | [Operate imports in the admin](012-operate-imports-in-admin.md) | large | done | 001, 005, 006, 010 |
| 013 | [Enforce retention and operational notifications](013-enforce-retention-and-operational-notifications.md) | large | done | 003, 005, 006, 010 |

### Provider mappings and launch

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 014 | [Map Beezie and ClutchPacks](014-map-beezie-and-clutchpacks.md) | large | done | 002, 005, 007, 008, 009 |
| 015 | [Map Collector Crypt and Courtyard](015-map-collector-crypt-and-courtyard.md) | large | done | 002, 005, 007, 008, 009 |
| 016 | [Map GameStop and Phygitals](016-map-gamestop-and-phygitals.md) | large | done | 002, 005, 007, 008, 009 |
| 017 | [Map Stadium Vault and Trove](017-map-stadium-vault-and-trove.md) | large | done | 002, 005, 007, 008, 009 |
| 018 | [Validate backfill and incremental launch](018-validate-backfill-and-incremental-launch.md) | large | done | 010–017 |

## Build Order

1. Build tasks 001 and 002 in parallel to establish the protected operator boundary and provider-page contract.
2. Complete the core chain 003 → 004 → 005 so PackScout can configure a provider and durably ingest cursor pages.
3. After 005, build 006, 007, 008, and 010 in parallel; start 009 as soon as 007 is complete.
4. Build the admin, retention, and four provider-mapping tracks as their dependencies clear.
5. Run task 018 after tasks 010–017 complete to prove all eight platforms through backfill, incremental updates, failure recovery, and framework verification.

## Parallel Groups

- **Group A — no dependencies:** data-pipeline/001, data-pipeline/002
- **Group B — core chain:** data-pipeline/003 → data-pipeline/004 → data-pipeline/005
- **Group C — after core ingestion:** data-pipeline/006, data-pipeline/007, data-pipeline/008, data-pipeline/010; then data-pipeline/009 after 007
- **Group D — operations and provider adoption:** data-pipeline/011 through data-pipeline/017 as their listed dependencies clear
- **Group E — launch proof:** data-pipeline/018

## Research Unknowns and Risks

- **Product decisions remaining:** None required to begin implementation.
- **Bounded research unknowns:** None; the supplied provider samples establish the initial mapping contracts.
- **Feed-change risk:** Provider payloads may evolve after launch; versioned adapters, raw-page retention, validation, and quarantine preserve evidence and recovery paths.
- **Calculation-quality risk:** Incomplete inventory or probability coverage keeps PackScout Estimated EV unavailable with a specific reason rather than producing an unsupported value.

## Next Action

Use `docs/data-pipeline-launch-scorecard.md` to provision preproduction, run the real-provider deployment gate, reconcile real counts, and obtain administrator launch approval.
