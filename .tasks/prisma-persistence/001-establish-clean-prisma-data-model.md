# Task: Establish the Clean Prisma Data Model

**ID:** prisma-persistence/001  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** none  
**Blocks:** [prisma-persistence/002](002-establish-prisma-runtime-and-test-foundation.md), [prisma-persistence/008](008-remove-drizzle-and-prove-clean-cutover.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout can create its complete PostgreSQL data model from an empty database through one clean Prisma migration history, with every current database-enforced invariant preserved.

## Context

The existing persistence contract spans 28 tables, 18 enums, 322 columns, 44 indexes, 19 unique constraints, 119 foreign keys, and 55 check constraints. It protects organization isolation, scoped relationships, immutable source and canonical history, active-session and active-work uniqueness, valid lease ownership, and legal lifecycle transitions.

No current database data needs to survive. This task therefore defines a clean Prisma starting point rather than an upgrade path from the seven Drizzle migrations. The target is behavioral and structural parity, not a schema redesign.

## Requirements

### Structural parity

- Reproduce all current tables, fields, enum values, database names, data types, defaults, nullability, unique constraints, indexes, and relationships from an empty PostgreSQL database.
- Preserve organization-scoped composite relationships so invalid cross-organization references fail at the database boundary.
- Preserve cyclic scoped pointers such as active provider configuration and current canonical revision without relaxing their referential guarantees.
- Preserve models that use composite identity or required-field uniqueness without inventing a new database identity that changes semantics.
- Produce a reviewable parity manifest that accounts for every object in the current schema snapshot.

### Database-enforced invariants

- Preserve every check constraint governing normalization, numeric bounds, state-dependent fields, ownership, cursor shape, completion, and alert linkage.
- Preserve partial uniqueness for active sessions, active provider imports, and running quarantine retries.
- Preserve deletion restrictions, timestamp behavior, UUID generation, JSON evidence, and encrypted binary secret storage.
- Reject invalid state combinations and cross-organization relationships without depending only on application validation.

### Clean migration contract

- Provision the complete schema through the Prisma migration workflow on an empty PostgreSQL 16+ database.
- Leave no requirement to recognize, replay, or upgrade a database previously managed by Drizzle.
- Fail visibly when migration application or schema validation is incomplete; a partially provisioned database is not accepted as ready.
- Make the generated Prisma data model valid and usable for every persistence domain that depends on this task.

## User-Facing Behavior

None. Product, admin, worker, and API behavior must remain unchanged.

## Interface Contract

This task delivers the authoritative Prisma data model, clean migration history, and parity evidence consumed by `prisma-persistence/002` through `prisma-persistence/008`. Later tasks may add repository behavior against this model, but they do not redesign its object names, tenant boundaries, lifecycle constraints, or persistence semantics.

The supported provisioning input is an empty PostgreSQL 16+ database. The output is a fully migrated schema and generated Prisma model. An existing Drizzle-managed database is explicitly not a supported input.

## Acceptance Criteria

- [x] A fresh PostgreSQL 16+ database reaches the complete target schema using only the Prisma migration workflow.
- [x] Automated inspection accounts for all 28 tables, 18 enums, 322 columns, 44 indexes, 19 unique constraints, 119 snapshot-managed foreign keys, two reviewed native scoped foreign keys, and 55 check constraints.
- [x] Direct tests reject representative cross-organization references, illegal state combinations, and duplicate active-work rows at the database boundary.
- [x] Defaults, timestamps, JSON evidence, encrypted secret bytes, cyclic scoped references, and deletion restrictions match the current persistence contract.
- [x] Migration failure and incomplete schema state fail safely without being reported as a ready PackScout database.

## Verification

- Apply the Prisma migrations to a newly created PostgreSQL 16+ database and compare the resulting catalog with the committed parity manifest.
- Run focused constraint tests for tenant scope, state transitions, active-work uniqueness, defaults, and referential deletion behavior.
- Run Prisma schema validation and generation checks through repository scripts reached by `npm run verify:framework`.

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented the approved empty-database Prisma baseline and preserved the complete PostgreSQL catalog contract
- Divergences: the deployed catalog contains 121 foreign keys because two required cyclic scoped constraints live outside the legacy snapshot's 119 managed foreign keys; the parity manifest records both native extensions explicitly
- Verification: Prisma validate and generate, four migration/parity and database-rejection tests on PostgreSQL 16.14, framework standards ratchet, and diff check
