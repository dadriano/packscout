# Task: Remove Drizzle and Prove the Clean Cutover

**ID:** prisma-persistence/008  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/007](007-cut-over-packscout-runtimes.md)  
**Blocks:** none  
**Estimated scope:** large  
**Status:** todo

## Objective

PackScout ships one complete Prisma persistence foundation with no executable Drizzle path and with clean-provisioning, behavioral-parity, and framework evidence ready for review.

## Context

The cutover is complete only when a clean checkout can install dependencies, generate the Prisma client, create an empty PostgreSQL database, apply the new migration history, start the real runtimes, and pass the full repository verifier. Leaving Drizzle packages, schemas, migrations, exports, commands, generated metadata, or runtime aliases would preserve two sources of truth and make future schema changes unsafe.

Existing database data is intentionally disposable for this feature. This task validates the approved empty-database path; it does not claim or construct an upgrade path for a Drizzle-managed environment.

## Requirements

### Single persistence system

- Remove executable Drizzle dependencies, schema exports, database factories, configuration, migration history, generated metadata, package scripts, and runtime imports.
- Remove transitional names and compatibility aliases that imply both persistence implementations remain supported.
- Keep Prisma as the only ORM, generated client, schema model, and migration workflow selected by package manifests and repository commands.
- Keep historical planning context accurate without presenting the removed Drizzle path as deployable.

### Clean delivery proof

- Prove dependency installation, Prisma generation, schema validation, empty-database migration, typechecking, tests, and builds from a clean checkout state.
- Compare the provisioned database with the parity contract from `001` and fail on missing or weakened objects.
- Run the complete tenant, security, secret, concurrency, ingestion, quarantine, retention, EV, operations, lifecycle, and performance regression matrix.
- Prove repeated migration checks are stable and do not attempt destructive changes against the clean target schema.
- Pass the canonical `npm run verify:framework` gate without weakening or baselining a new finding.

### Handoff and safety

- Document that the supported cutover starts from an empty PostgreSQL 16+ database and does not preserve a Drizzle-managed database.
- Identify the explicit clean-provisioning command sequence and the evidence required before pointing an application runtime at the new database.
- Require explicit approval of the exact disposable database target before any reset or replacement operation.
- Keep credentials, connection strings, raw payloads, source identities, and protected evidence out of committed verification output.

## User-Facing Behavior

No product behavior changes. The persistence implementation and provisioning workflow change, while admin, worker, service, and frontend outcomes remain stable.

## Interface Contract

The final database package exposes only the supported Prisma-backed server persistence surface and test utilities. A clean deployment supplies PostgreSQL 16+ connectivity, generates the client, applies the checked-in Prisma migrations, validates readiness, and then starts PackScout runtimes.

No interface is supplied for upgrading an existing Drizzle database, operating both ORMs, or reverting live writes into the old migration history.

## Acceptance Criteria

- [ ] No executable source, package manifest, lockfile selection, export, script, configuration, schema module, migration artifact, or runtime import retains Drizzle.
- [ ] A clean checkout installs, generates Prisma artifacts, provisions an empty database, validates parity, starts real runtimes, and completes their smoke flows.
- [ ] The full behavioral matrix preserves tenant, security, transaction, contention, replay, retention, EV, operations, lifecycle, and statement-budget outcomes.
- [ ] Reset and provisioning documentation clearly excludes existing-data preservation and requires an explicitly confirmed disposable target.
- [ ] `npm run verify:framework` passes with no new exception, skipped critical regression, compatibility path, or weakened repository rule.

## Verification

- Search executable source, manifests, exports, scripts, configuration, and migration directories for remaining Drizzle implementation references.
- Rehearse install, generation, clean migration, parity inspection, runtime startup, smoke flows, repeated migration validation, and shutdown from a clean checkout.
- Run all focused persistence and runtime suites followed by `npm run verify:framework` and record only sanitized evidence.
