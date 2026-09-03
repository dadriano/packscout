# Task: Prove Distributed Security and Failure Isolation

**ID:** distributed-canonical-warehouse/018
**Depends on:** distributed-canonical-warehouse/005, distributed-canonical-warehouse/006, distributed-canonical-warehouse/012, distributed-canonical-warehouse/014, distributed-canonical-warehouse/015
**Blocks:** distributed-canonical-warehouse/019, distributed-canonical-warehouse/020
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including threat-focused tests, outage injection, and resource-bound evidence
**Status:** not started

## Start Here

Build a trust-boundary matrix for browser, admin server, central database, provider database, correlator, runner, publisher, Convex, and secret authority, naming the credential and permitted operations at each edge.

## Objective

Prove that central tenancy, physical provider isolation, secret custody, public allowlisting, and bounded failure behavior prevent one actor or provider from exposing, corrupting, or blocking another.

## Context

The architecture increases the number of connection and network boundaries. Security depends on validating organization and provider ownership before routing, using server-owned targets and least-privilege credentials, fencing stale workers, treating soft references as untrusted until reconciled, and exposing only explicit public fields.

Reliability is part of this proof. A central, provider, Convex, or network outage must produce a bounded isolated result rather than an indefinite request, false success, partial public activation, or cross-provider resource exhaustion.

## Requirements

### Authorization and routing

- Test organization ownership and fixed permissions before every central read, provider target resolution, direct provider command, catalog operation, and publication operation.
- Reject malicious, malformed, unknown, archived, cross-organization, and cross-provider IDs before they influence a database name, host, connection, query, or Convex operation.
- Use distinct least-privilege roles for central admin access, provider runtime, admin direct provider reads and commands, correlation, catalog publication, and provider publication.
- Restrict every provider role to one provider database and restrict every central role to its required central tables and operations.
- Require TLS and bounded pools, connection attempts, query time, concurrent fan-out, and publication request size.

### Secret and privacy boundaries

- Keep encryption keys outside PostgreSQL and store provider credential material only as encrypted versioned central records.
- Prevent credential ciphertext, usable key references, database URLs, authorization values, raw runtime cursors, provider payloads, and upstream error bodies from entering browser responses, Convex documents, logs, alerts, or diagnostics; the bounded authorized Data Feed Lab raw response is the sole transient payload exception.
- Keep provider accounts pseudonymous and provider-scoped without building cross-provider account identity.
- Allowlist public provider, repack, category, collectible, chase, economics, availability, freshness, media, and action fields before publication.
- Bound and validate UUIDs, enums, timestamps, money and currency pairs, quantities, probabilities, JSON fields, URLs, pagination, and response sizes at public boundaries.

### Concurrency and integrity

- Test lease fences, expected generations, idempotency keys, immutable digests, monotonic sequences, independent consumer checkpoints, and compare-and-swap manifest activation under concurrency.
- Reject stale runtime, page, correlation, publication, retention, and manifest owners without partial effect.
- Test soft-reference reconciliation for missing, stale, cross-provider, wrong-type, retired, and alias-cycle cases.
- Ensure no central, provider, catalog, publication, or admin path opens a distributed transaction or trusts a browser-selected connection target.
- Protect destructive operations with explicit environment scope, ownership proof, active-root discovery, authorization, and audit.

### Failure and resource isolation

- Inject central-down, one-provider-down, Convex-down, DNS, TLS, connection timeout, query timeout, response timeout, duplicate delivery, lost receipt, and restart faults independently.
- Prove that every fault has a numeric timeout, concurrency, queue, retry, or body bound and a stable sanitized outcome.
- Prove one provider cannot consume another provider's connection capacity, worker lease, retry budget, publication checkpoint, or manifest entry.
- Preserve valid provider commits and prior active public data through every external outage.
- Emit metrics and audit evidence for authorization refusal, routing failure, pool pressure, timeout, stale fence, retry, ambiguous receipt, and recovery without secrets.

## User-Facing Behavior

Unauthorized and cross-organization requests fail without revealing target existence. Operators receive provider-specific safe errors rather than database details. Healthy providers remain usable during another provider's outage. Public users continue reading the prior active manifest during publication or infrastructure failure.

## Interface Contract

Every privileged operation carries validated environment, organization, provider, actor or worker, permission, version or generation, correlation, idempotency, and bounded request context. Browser input never supplies secret material or a routable infrastructure target.

Every failure crossing a trust boundary becomes a stable safe code, retry classification, observation time, and bounded guidance. Raw infrastructure and upstream failures remain server-only.

## Acceptance Criteria

### Security acceptance

- [ ] Central tenant authorization and physical provider isolation prevent cross-organization and cross-provider access under malicious IDs.
- [ ] Least-privilege roles restrict central, runtime, admin-direct, correlation, catalog, and publication operations to their exact authorities.
- [ ] Secret, credential, database, cursor, payload, actor, and upstream-body scanning finds no exposure in browser, Convex, logs, alerts, or diagnostics.
- [ ] Public allowlists and strict bounded validation reject unknown or oversized fields at every external contract.
- [ ] Destructive operations refuse to act without environment, ownership, authorization, and protected-root proof.

### Isolation acceptance

- [ ] Central, provider, Convex, network, timeout, duplicate, lost-receipt, and restart faults produce bounded safe outcomes.
- [ ] One provider cannot block or consume another provider's connection, worker, retry, checkpoint, release, or manifest capacity.
- [ ] Stale leases, generations, digests, checkpoints, and manifest revisions fail with zero partial effect.
- [ ] Valid local commits and prior active public data survive every injected external outage.
- [ ] Security, timeout, pool, retry, receipt, and recovery evidence is measurable without exposing protected values.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Security verification covers central tenancy, physical provider isolation, server-owned routing, secret custody, public allowlists, and bounded faults.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
