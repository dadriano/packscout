# Task: Cut Over PackScout Runtimes

**ID:** prisma-persistence/007  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/003](003-preserve-identity-and-provider-controls.md), [prisma-persistence/004](004-preserve-import-coordination-and-worker-queues.md), [prisma-persistence/005](005-preserve-ingestion-and-canonical-history.md), [prisma-persistence/006](006-preserve-quarantine-retention-and-operations.md)  
**Blocks:** [prisma-persistence/008](008-remove-drizzle-and-prove-clean-cutover.md)  
**Estimated scope:** large  
**Status:** done

## Objective

The real admin, worker, service integration, and embedded local runtimes use the proven Prisma repositories and lifecycle without changing product or HTTP behavior.

## Context

At the start of this task, the admin server, provider worker, operational worker paths, EV worker, retention worker, and embedded local admin constructed a PostgreSQL pool and repositories from the prior persistence stack. Test compositions across database, services, admin, and worker packages also created that migrated database directly.

Tasks `003` through `006` prove each Prisma persistence domain in isolation. This task owns shared application composition and public database-package exports so parallel repository work does not create conflicting runtime wiring or transitional aliases.

## Requirements

### Production composition

- Compose every server runtime with the shared Prisma client, Prisma-backed repositories, and existing service ports.
- Preserve startup validation, dependency ownership, graceful shutdown, worker polling, signal handling, and bounded failure behavior.
- Prevent browser bundles and frontend packages from importing Prisma, database clients, repositories, secrets, or server-only code.
- Use one client lifecycle per runtime and release it after normal shutdown, startup failure, and test teardown.

### Behavioral continuity

- Preserve all admin HTTP contracts, authentication and authorization outcomes, provider operations, import operations, operational reads, and stable structured errors.
- Preserve worker adapter behavior, import orchestration, schedules, quarantine retries, retention, alerts, health, and EV recomputation.
- Preserve local embedded startup with explicitly local fixtures and no production credential assumptions.
- Keep service interfaces ORM-neutral; consumers receive domain records and stable outcomes rather than generated Prisma models.

### Integration coverage

- Move database-backed integration suites onto the shared Prisma migration and test foundation.
- Exercise real admin and worker composition against a clean migrated database rather than only repository-level doubles.
- Preserve direct permission, tenant, secret, contention, rollback, restart, and sanitized-error coverage at runtime boundaries.
- Make startup fail visibly when the Prisma client, generated artifacts, migration state, or database connection is unavailable.

## User-Facing Behavior

Administrators and data operators experience no change to login, navigation, provider management, import control, quarantine, alerts, health, or diagnostics. Workers produce the same durable outcomes and operational evidence.

## Interface Contract

Application compositions import the stable database package surface, create one Prisma persistence lifecycle, inject domain repository ports into existing services, and close the lifecycle during shutdown. Generated Prisma types and clients remain behind that server-only surface.

Task `008` receives a runtime that no longer executes Drizzle. It may then remove legacy dependencies, schema exports, migrations, scripts, and configuration without maintaining aliases.

## Acceptance Criteria

- [x] Admin, worker, operational, EV, retention, and embedded local compositions start from a clean Prisma-migrated database and close their client cleanly.
- [x] Existing service and HTTP contracts, permissions, state transitions, structured errors, and browser/server boundaries pass without compatibility endpoints or response changes.
- [x] Database-backed integration tests across database, services, admin, and worker packages use the shared Prisma test foundation.
- [x] Missing generation, invalid migration state, connection failure, startup failure, and shutdown paths fail predictably without hanging or leaking sensitive configuration.
- [x] No application runtime executes a Drizzle repository or migration path before cleanup begins.

## Verification

- Run real composition tests and smoke flows for login, provider configuration, manual import, scheduled work, quarantine retry, retention, alerts, health, and EV recomputation.
- Run package boundary, dependency, secret-leakage, lifecycle, signal, startup-failure, and graceful-shutdown regressions.
- Run all database-backed package suites plus lint, typecheck, and builds through `npm run verify:framework`.

## Spec Compliance

- Related specs reviewed: none
- Alignment: admin, worker, service integration, and embedded local compositions now start through the shared Prisma lifecycle and inject the Prisma-backed repositories while preserving ORM-neutral service and HTTP contracts
- Divergences: none; task `008` removed the temporary repository class names and all legacy executable artifacts after the runtime cutover
- Verification: Prisma schema and lifecycle checks pass; service typecheck, 134 tests, and lint pass; admin typecheck, 63 tests, and lint pass; worker typecheck, 19 tests, and lint pass; boundary and script checks pass; the embedded local admin starts successfully against a clean migrated database
