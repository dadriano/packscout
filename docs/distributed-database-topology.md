# Distributed Database Topology

Status: implementation contract for the clean PackScout warehouse

PackScout uses one central PostgreSQL database and one physically isolated
PostgreSQL database per provider. PostgreSQL 16 or newer is required. The
database name identifies the role; the selected PostgreSQL instance or cluster
identifies the environment.

## Ownership matrix

| Authority | Exact database | Owns | Must not own |
|---|---|---|---|
| Central control and catalog | `packscout` | Organizations, admin principals and sessions, provider registry and topology, encrypted credential versions, connection-test history, observed activity and alerts, shared categories and collectibles, temporal provider correlations, catalog versions, and manifest coordination | Provider cursors, schedules, leases, runs, quarantine, canonical packs, pulls, market events, or a durable offline command queue |
| One provider | `packscout_<provider_key>` | That provider's categories, packs, collectibles and instances, pack contents, pseudonymous accounts, immutable pulls and market events, promotion changes, runtime, one mixed run stream, commands, quarantine, local audit and activity outbox, provider releases, publication receipts, and local retention state | Admin identities, another provider's records, the shared catalog, central alerts, credentials, source adapters, raw payload archives, or frontend saves |
| Frontend read model | Convex | Immutable catalog versions and provider releases, manifest revisions and materialized public lookups, the active-manifest pointer, publication receipts, and durable user saves | Provider runtime, credentials, raw source data, pulls, market-event history, quarantine evidence, or PostgreSQL authority |

The reusable provider schema is identical for every provider database. A
provider key matches `^[a-z][a-z0-9_]{0,52}$`, is immutable, and produces the
exact database name `packscout_<provider_key>`. Browser input never supplies a
database name, URL, host, credential, or provider key as routing authority.

## Identity and readiness

Every database has one `database_identity` singleton. Readiness compares all of
the following before exposing repositories:

1. `current_database()` and the expected exact database name;
2. the database role and independently deployed schema version;
3. for a provider database, the central provider UUID and immutable key; and
4. the validated central topology descriptor used to open the connection.

A mismatch is a provider-specific unavailable result, not a partially usable
client. Diagnostics contain only the role, database name, schema version,
provider identity, observation time, and a stable sanitized failure code.

## Cross-database boundary

All same-database relationships use ordinary PostgreSQL foreign keys and local
transactions. Cross-database relationships use globally unique soft IDs plus
the authority and version needed to reject stale evidence. No foreign key,
join, lock, lease, cursor, or transaction crosses database authorities.

| Source | Soft target | Reconciliation owner |
|---|---|---|
| Provider identity/runtime | Central provider | Provider gateway validates UUID, key, database name, topology version, and schema before use |
| Central correlations | Provider category or collectible | Correlator validates provider ID, local row ID/version, type, and retained promotion sequence |
| Central activity/alerts | Provider run or quarantine | Admin carries `providerId` with the local ID and represents unreachable or retained-away targets explicitly |
| Provider release | Central catalog/profile/correlation boundary | Assembler pins complete descriptors and canonical hashes before opening its local repeatable-read snapshot |
| Manifest operation | Provider release and Convex manifest | Activator validates the complete release/catalog pair, expected predecessor, exact digest, and receipt |

## Transaction and outage behavior

- One mixed provider page commits canonical rows, immutable facts, quarantine,
  page and run counters, the single cursor, promotion changes, local audit, and
  safe activity-outbox events in one provider transaction.
- Correlation, activity relay, release publication, and manifest activation are
  asynchronous, idempotent steps with independent checkpoints and exact
  receipts. Failure never rolls back an already committed provider page.
- One unreachable provider returns one bounded unavailable result. Central
  readiness and every healthy provider remain independently usable.
- Central activity is observational. Central loss does not reset provider
  runtime state or create an offline command queue.
- A process already holding unexpired local authority may finish or start work
  using configuration and credentials held in memory during a central outage.
  A restarted process waits for central credential access; provider databases
  never persist credential material.
- The prior active Convex manifest remains readable until a compare-and-swap
  activation is durably confirmed.

## Schema lifecycle

Central and provider schemas have separate Prisma roots, migration histories,
generated clients, parity manifests, deploy commands, and readiness signatures.
Migration deployment is an explicit release action. Application startup only
checks readiness and never mutates schema state.

This is a clean pre-launch replacement. It does not migrate, query, modify, or
delete `packscout_dev`; it has no dual read, dual write, compatibility schema,
legacy generic canonical graph, provider stream, product normalization, raw
source staging, or Heat persistence.
