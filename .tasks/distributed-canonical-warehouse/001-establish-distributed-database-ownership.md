# Task: Establish Distributed Database Ownership

**ID:** distributed-canonical-warehouse/001
**Depends on:** none
**Blocks:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003, distributed-canonical-warehouse/004
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including clean provisioning, isolation tests, and readiness verification
**Status:** in progress

## Start Here

Inventory the current database bootstrap, routing, migration, and readiness boundaries, then write one ownership matrix showing which approved records belong in `packscout` and which belong in `packscout_<provider_key>`.

## Objective

Make the distributed warehouse topology executable so every later task targets an explicit database authority, connection boundary, and schema lifecycle without relying on the legacy single-database model.

## Context

The clean architecture uses one central database plus one isolated database per provider. `packscout` is the administrative control plane and shared catalog. A `packscout_<provider_key>` database is authoritative for one provider's canonical data and runtime. Provider databases may live on different PostgreSQL instances and must be able to scale or fail independently.

PackScout is pre-launch. This task provisions fresh schemas and does not migrate, modify, or remove the existing development database. The provider key is a stable identity, not an unchecked string for constructing connection targets.

## Requirements

### Database roles

- Define the central database name as exactly `packscout` and each provider database name as exactly `packscout_<provider_key>`.
- Keep environment identity in the selected PostgreSQL instance or cluster rather than adding an environment suffix to a database name.
- Give each database one PackScout application schema and an independently verifiable schema version; every provider database also carries an immutable local role, provider ID, provider key, and schema marker that must match the central registry before use.
- Support at least two provider databases on independently addressable PostgreSQL instances or clusters without a shared transaction, connection pool, or readiness result.
- Treat PostgreSQL 16 or newer as the supported clean-bootstrap baseline.

### Routing and identity

- Use `provider`, `provider_id`, and `provider_key` as the canonical internal vocabulary across database roles and shared contracts.
- Require provider keys to match `^[a-z][a-z0-9_]{0,52}$` so `packscout_<provider_key>` remains an exact safe PostgreSQL name; validate the key against the central registry before resolving a connection.
- Use globally unique IDs for cross-database references, plus explicit authority and version fields when stale references would change behavior.
- Represent every cross-database relationship as a soft reference with reconciliation status; no database declares a foreign key to another database.
- Prevent a provider-scoped connection from reading or writing the central database or another provider database.

### Lifecycle and reliability

- Bootstrap, migrate, verify, and report readiness independently for `packscout` and every provider database.
- A failed or incompatible provider schema returns a provider-specific unavailable result while healthy database roles remain ready.
- Schema deployment remains a separate release action from application startup, and startup never mutates a non-ready schema implicitly.
- Non-production and CI environments can start a central database and multiple provider databases with deterministic test identities.
- Database role, schema version, provider identity, and sanitized failure code appear in diagnostics without credentials or connection strings.

## User-Facing Behavior

Operators do not see database URLs or credentials. When one provider database is unavailable or not ready, admin surfaces identify only that provider as unavailable and continue showing healthy providers.

## Interface Contract

Every database target resolves to a bounded descriptor containing `databaseRole`, `databaseName`, `schemaVersion`, and, for provider databases, `providerId` and `providerKey`. A readiness result is `ready` with the observed schema version or `unavailable` with a stable sanitized failure code and observation time.

Central callers supply a validated provider ID to the provider locator. The locator never accepts a browser-supplied database name, endpoint, credential, or organization ID as authority.

## Acceptance Criteria

### Topology acceptance

- [ ] A clean environment provisions and verifies one `packscout` database and at least two `packscout_<provider_key>` databases.
- [ ] Each database reports its own role and schema version, and a provider mismatch fails closed.
- [ ] Environment selection changes the PostgreSQL instance or cluster without changing the approved database names.
- [ ] No schema contains a cross-database foreign key or assumes a transaction can span database authorities.
- [ ] The existing development database remains untouched.

### Isolation acceptance

- [x] A malformed, unknown, or cross-organization provider key cannot select a database target.
- [x] Making one provider database unreachable leaves central readiness and another provider's readiness successful.
- [ ] A provider-scoped credential cannot access another provider or the central database.
- [x] Diagnostics contain stable sanitized failures and never reveal connection strings or credentials.
- [x] Clean bootstrap and repeated readiness verification pass in local and CI environments.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- The approved central-outage policy is used: an already-running process may use unexpired configuration and credentials already in memory, while a restarted process waits for central credential access.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.

## Completion Evidence

- Central and provider Prisma schemas validate independently and the static
  contract suite freezes their exact role inventories and soft-reference
  boundaries.
- Live PostgreSQL 16 migration/invariant tests pass for both roles, including
  promotion coupling, immutable history, receipt gates, monotonic checkpoints,
  and stale lease fences.
- The guarded exact-topology test provisioned `packscout`, `packscout_alpha`,
  and `packscout_beta`, verified role-scoped credentials and isolated readiness,
  repeated migrations, and removed only its own targets.
- Provider lookup derives the key, database name, topology, node, and credential
  version from the authenticated organization/provider registry row; caller
  input cannot select a host, database, provider key, or credential.

## Remediation In Progress

- Integration audit found that the guarded topology test proves distinct roles and revoked cross-database access, but the canonical provisioning workflow does not yet require or automate those grants. Completion is reopened until the documented/reusable provisioning path enforces the same physical isolation.
