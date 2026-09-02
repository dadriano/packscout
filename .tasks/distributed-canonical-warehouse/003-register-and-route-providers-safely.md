# Task: Register and Route Providers Safely

**ID:** distributed-canonical-warehouse/003
**Depends on:** distributed-canonical-warehouse/001, distributed-canonical-warehouse/002
**Blocks:** distributed-canonical-warehouse/005, distributed-canonical-warehouse/006, distributed-canonical-warehouse/008, distributed-canonical-warehouse/011
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including provider UI parity, credential safety, topology routing, and failure verification
**Status:** not started

## Start Here

Write the provider lifecycle and configuration revision matrix from draft creation through tested activation, disablement, and archival, including the exact central and provider-local authority used at each transition.

## Objective

Let authorized administrators register, configure, test, activate, disable, and archive providers while safely resolving each provider's isolated database and keeping all credentials out of the browser.

## Context

Provider identity and topology live in `packscout`, while provider runtime state lives in `packscout_<provider_key>`. The current `/providers`, `/providers/new`, `/providers/:id`, and `/providers/:id/edit` experiences remain. Provider keys are immutable after creation and are the canonical internal vocabulary; no new contract exposes `platformKey`, `siteId`, or `providerSourceId` aliases.

The central database stores one provider's source and database credentials as versioned encrypted records. Encryption keys live outside PostgreSQL. Admin server operations validate organization ownership before resolving or testing a provider connection.

## Requirements

### Provider registry

- Store organization-owned `PROVIDERS` with an immutable globally unique `provider_key` matching `^[a-z][a-z0-9_]{0,52}$`, display name, lifecycle `draft | active | disabled | archived`, active configuration pointer, and optimistic row version.
- Store immutable `PROVIDER_CONFIG_VERSIONS` with provider-wide schedule and runtime configuration, version number, and nullable expiration that defaults to no expiration. There is no separate approval state.
- Store versioned encrypted `PROVIDER_CREDENTIAL_VERSIONS`, `PROVIDER_DATABASE_NODES`, and append-only `PROVIDER_CONNECTION_TESTS` centrally.
- Permit one enabled primary database node for a provider and reject topology that resolves outside the provider's approved database authority.
- Keep runtime desired state, cursor, lease, run state, and failure counters out of the central registry.

### Configuration lifecycle

- Create providers as drafts and create every edit as a new immutable configuration version.
- Test the exact configuration and credential versions that will be activated; a passing test for another version cannot unlock activation.
- Activate only a non-expired configuration that passed an `activation` test for that exact configuration, credential, topology, and database-node version combination.
- Require disablement before archival and leave already-running provider work free to reach its provider-local terminal state.
- Detect stale edits and lifecycle commands with row versions and return a conflict without overwriting newer state.

### Credential and routing safety

- Encrypt every provider credential before central persistence and resolve decryption keys from a secret authority outside PostgreSQL.
- Return masked credential metadata only; never send credential material, database connection strings, or upstream error bodies to the browser.
- Validate organization ownership and the active topology version before opening a provider database connection.
- Bound connection tests and direct database probes by destination policy, timeout, response size, and sanitized failure classification.
- Represent an unreachable provider as an explicit isolated outcome without changing its saved configuration or blocking another provider.

### Admin parity

- Preserve provider list, filtering, create, detail, edit, exact-version test, activation, disable, archive, and links to run and quarantine views; show operational health as `not_initialized` until a provider-local observation exists.
- Administrators may mutate provider state; data operators receive masked read-only provider views.
- Preserve unsaved-change warnings, destructive confirmations, loading, empty, filtered-empty, forbidden, conflict, unreachable, and success states.
- Use `providerId` and `providerKey` atomically across new admin contracts and UI behavior without a compatibility alias.
- Record central audit events for configuration, credential, connection-test, lifecycle, and topology actions with a shared correlation ID.
- Use the shared admin error compatibility matrix for provider validation, conflict, lifecycle, connection, permission, rate-limit, and unavailable responses.

## User-Facing Behavior

The current provider screens remain recognizable. An administrator creates a draft, saves immutable revisions, tests the exact revision, and activates it. Credentials stay masked. A data operator can inspect but cannot edit. An unreachable database produces a bounded provider-specific message and mitigation hint without implying that saved configuration changed.

## Interface Contract

The safe provider projection includes `providerId`, `organizationId`, `providerKey`, display name, lifecycle, active configuration metadata, masked credential metadata, database-node metadata, latest connection-test outcome, and optimistic row version.

The provider database gateway returns `reachable` with safe data and `observedAt`, or `unreachable` with `providerId`, a sanitized `failureCode`, `observedAt`, and a bounded retry hint. It never returns connection details or raw database errors.

## Acceptance Criteria

### Lifecycle acceptance

- [ ] Provider create, list, detail, edit, test, activate, disable, and archive flows preserve current role and UI behavior.
- [ ] Only the exact tested, non-expired configuration, credential, topology, and database-node version combination can become active.
- [ ] Credential rotation creates a new encrypted version and never exposes its plaintext after submission.
- [ ] Stale mutations return conflicts without losing entered changes or overwriting newer state.
- [ ] Disabling before archival is enforced, and disabling does not rewrite provider-local run history.

### Routing acceptance

- [ ] Organization ownership and topology version are validated before every connection or test.
- [ ] One provider can be unreachable while another provider's test and detail view succeed.
- [ ] Browser responses, logs, alerts, and audits contain no credentials, connection strings, or raw upstream bodies.
- [ ] All new internal and admin contracts use canonical provider terminology without dual fields.
- [ ] Provider configuration tests cover `403`, `404`, `409`, `422`, `429`, and `503` outcomes.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Configuration lifecycle is immutable revision → exact activation test → activation; no approval column or workflow is introduced.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
