# Task: Establish the Prisma Runtime and Test Foundation

**ID:** prisma-persistence/002  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/001](001-establish-clean-prisma-data-model.md)  
**Blocks:** [prisma-persistence/003](003-preserve-identity-and-provider-controls.md), [prisma-persistence/004](004-preserve-import-coordination-and-worker-queues.md), [prisma-persistence/005](005-preserve-ingestion-and-canonical-history.md)  
**Estimated scope:** large  
**Status:** todo

## Objective

Every PackScout persistence task can use one production-ready Prisma client, transaction boundary, migration workflow, and isolated PostgreSQL integration-test foundation.

## Context

The current database package exposes a Drizzle database factory, schema exports, transaction types, migration scripts, and an in-process migrated test database. Seventeen database, service, admin, worker, and local-runtime test files depend on that foundation. Several tests exercise real constraints, competing workers, atomic rollback, and a bounded large-page statement count.

Replacing only repository queries would leave production lifecycle, migration validation, test isolation, and performance evidence unresolved. This task creates the shared foundation before domain repositories migrate so parallel builders do not invent incompatible clients, transactions, or fixtures.

## Requirements

### Runtime foundation

- Provide one server-only Prisma persistence boundary with explicit startup, connection, transaction, and graceful-shutdown behavior.
- Preserve repository-facing domain outcomes and keep browser packages unable to import database or server-only modules.
- Keep organization identity mandatory at persistence entry points and support atomic operations spanning multiple repository writes.
- Map expected database conflicts and ownership failures into the stable outcomes already consumed by services and runtimes.

### Test foundation

- Give each integration test an isolated PostgreSQL state created through the actual Prisma migration history.
- Support fixture creation and safe database inspection without requiring tests to import ORM schema internals.
- Preserve real concurrency, locking, constraint, rollback, and restart behavior rather than replacing those tests with mocks.
- Preserve statement-count instrumentation or an equally strict automated large-page persistence budget.
- Clean up test clients and isolated databases reliably after success or failure.

### Tooling contract

- Provide repeatable commands for client generation, schema validation, clean migration application, drift or parity checking, and focused database tests.
- Ensure a clean dependency install can generate the client before any package that consumes it typechecks or builds.
- Route migration and generation failures into the repository's canonical verification gate.
- Keep shared persistence enums and domain record types independent of Drizzle-specific exports.

## User-Facing Behavior

None. This task changes persistence infrastructure only.

## Interface Contract

Tasks `003` through `005` receive one stable Prisma client and transaction contract, one repository error vocabulary, one clean-migration command, and one integration-test harness. Those tasks may own domain queries and parameterized PostgreSQL operations, but they do not create separate client lifecycles, migration systems, or test databases. Task `006` uses the same foundation after the core domains are converted.

Task `007` receives explicit runtime startup and shutdown behavior plus supported composition hooks for admin, worker, services tests, and the embedded local runtime.

## Acceptance Criteria

- [ ] A clean install can generate and validate the Prisma client before database consumers typecheck or build.
- [ ] Production and test clients connect, transact, close, and surface startup failures predictably without leaking connection details.
- [ ] Integration tests apply the real clean migrations in isolated PostgreSQL state and prove constraint, transaction, contention, and rollback behavior.
- [ ] Test fixtures and shared domain types no longer require Drizzle schema or query-helper imports.
- [ ] Prisma generation, migration validation, focused persistence tests, and lifecycle checks are reached by `npm run verify:framework`.

## Verification

- Exercise client startup, successful transaction, rollback, connection failure, and graceful shutdown through direct tests.
- Run representative database, service, admin, and worker integration tests through the new isolated PostgreSQL harness.
- Run the migration, generation, boundary, dependency, lint, and typecheck checks included by `npm run verify:framework`.
