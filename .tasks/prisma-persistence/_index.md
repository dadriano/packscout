# Feature: Prisma Persistence

**Progress:** 5/8 tasks complete

## Context

PackScout currently persists authentication, provider configuration, ingestion history, canonical records, worker coordination, quarantine, retention, and operational state through Drizzle. The product is still early enough to replace that foundation without preserving any existing database data or replaying the seven Drizzle migrations.

This feature establishes Prisma as PackScout's only ORM and migration system. PostgreSQL remains the canonical system of record, and the cutover must preserve the current database contract and observable behavior rather than redesigning the product. The current contract contains 28 tables, 18 enums, 322 columns, 44 indexes, 19 unique constraints, 119 foreign keys, and 55 check constraints. Those constraints protect tenant isolation, immutable history, active-work exclusivity, lease ownership, and safe state transitions.

The completed result starts from an empty PostgreSQL database, applies one clean Prisma migration history, runs every repository and application runtime through Prisma, and contains no executable Drizzle persistence path.

## Resolved Decisions

### Cutover model

- Start every target database from an empty schema; preserving data from a Drizzle-managed database is not required.
- Replace Drizzle in one completed cutover. PackScout never operates with dual reads, dual writes, or two active migration systems.
- Create a clean Prisma migration history rather than translating or replaying the seven Drizzle migrations.
- Remove the old persistence implementation only after the Prisma path satisfies the same behavioral and verification contract.

### Data and behavior

- PostgreSQL remains authoritative for durable application state and database-enforced invariants.
- Preserve the existing tables, fields, enum values, relationships, defaults, constraints, indexes, and tenant boundaries without a domain-model redesign.
- Preserve repository outcomes, service interfaces, API behavior, worker state machines, admin behavior, and operational evidence.
- Keep provider-reported EV and PackScout Estimated EV distinct, with their existing provenance and recomputation behavior unchanged.

### Reliability and safety

- Preserve atomic page commits, cursor advancement, immutable evidence, canonical revision history, idempotent replay, and relationship reconciliation.
- Preserve exclusive and disjoint work claims, lease recovery, stale-owner rejection, active-work uniqueness, retry limits, and restart safety.
- PostgreSQL-native locking and set-based behavior remain inside the persistence boundary when generated ORM operations cannot preserve those guarantees.
- Keep organization scope mandatory, keep secrets and protected evidence server-side, and retain stable sanitized error outcomes.
- Run actual Prisma migrations in isolated integration tests; do not weaken concurrency, constraint, rollback, or large-page performance coverage to accommodate the new test foundation.

## Success Signals

- A clean PostgreSQL 16+ database can be provisioned entirely through the Prisma migration workflow.
- Database inspection proves parity for all 28 tables and their recorded columns, enums, constraints, relationships, defaults, and indexes.
- Admin, worker, services, local runtime, repository tests, and migration tests use the Prisma persistence boundary successfully.
- Tenant, authentication, secret, concurrency, ingestion, quarantine, retention, EV, and operational regressions preserve their current outcomes.
- The canonical repository verifier passes with no executable Drizzle dependency, schema export, migration command, or runtime import remaining.

## Out of Scope

- Preserving, upgrading, or importing data from an existing Drizzle-managed database
- Redesigning the PackScout domain schema, repository contracts, APIs, provider feeds, calculations, admin experience, or frontend experience
- Adding a compatibility layer, staged dual-ORM operation, dual reads, or dual writes
- Changing PostgreSQL to another canonical database or moving frontend publication into this persistence layer
- Deploying against or deleting a live database as part of this planning artifact

## Tasks: Foundation

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 001 | [Establish the clean Prisma data model](001-establish-clean-prisma-data-model.md) | large | done | none |
| 002 | [Establish the Prisma runtime and test foundation](002-establish-prisma-runtime-and-test-foundation.md) | large | done | 001 |

## Tasks: Persistence Domains

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 003 | [Preserve identity and provider controls](003-preserve-identity-and-provider-controls.md) | large | done | 002 |
| 004 | [Preserve import coordination and worker queues](004-preserve-import-coordination-and-worker-queues.md) | large | done | 002 |
| 005 | [Preserve ingestion and canonical history](005-preserve-ingestion-and-canonical-history.md) | large | done | 002 |
| 006 | [Preserve quarantine, retention, and operations](006-preserve-quarantine-retention-and-operations.md) | large | todo | 003, 004, 005 |

## Tasks: Cutover

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 007 | [Cut over PackScout runtimes](007-cut-over-packscout-runtimes.md) | large | todo | 003, 004, 005, 006 |
| 008 | [Remove Drizzle and prove the clean cutover](008-remove-drizzle-and-prove-clean-cutover.md) | large | todo | 007 |

## Build Order

1. Complete `001` to lock the clean Prisma database contract.
2. Complete `002` to give every later task one runtime, transaction, migration, and integration-test foundation.
3. Build `003`, `004`, and `005` in parallel against that frozen foundation.
4. Complete `006` against the converted control, coordination, ingestion, and canonical domains.
5. Complete `007`, then `008`, so Drizzle is removed only after the Prisma runtime is proven end to end.

## Parallel Groups

| Group | Ready when | Tasks |
|---|---|---|
| A | immediately | 001 |
| B | 001 complete | 002 |
| C | 002 complete | 003, 004, 005 |
| D | 003–005 complete | 006 |
| E | 006 complete | 007, then 008 |

## Research Unknowns and Risks

- **Product decisions remaining:** None required to begin implementation.
- **Data-loss boundary:** The approved clean start intentionally excludes existing database preservation; execution must still identify and reset only the intended disposable environment.
- **Schema-parity risk:** Some database invariants are not represented by ordinary ORM models, so migration and database-inspection evidence must prove them directly.
- **Concurrency risk:** Queue claims, locks, partial uniqueness, and batch commits must retain their current atomic outcomes under real PostgreSQL contention.
- **Shared-foundation risk:** Tasks `003`–`005` may run in parallel only after `002` stabilizes the shared schema, client, migration, fixture, and transaction contracts; shared runtime wiring remains owned by `007`.

## Next Action

Run `/tasks-to-tech-specs prisma-persistence` to map these outcomes onto the repository's Prisma schema, migration, repository, runtime, and test boundaries before implementation.
