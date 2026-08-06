# Task: Manage Provider Configurations

**ID:** data-pipeline/004  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/001](001-protect-data-operations.md), [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/003](003-persist-source-and-canonical-history.md)  
**Blocks:** [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/011](011-manage-providers-in-admin.md), [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md)  
**Estimated scope:** large  
**Status:** done

## Objective

Administrators can safely define, test, activate, replace, disable, and archive the one provider configuration that owns each platform's imports.

## Context

Provider behavior must be data-driven. A configuration selects a registered adapter and supplies platform, endpoint, authentication mode, schedule, stale threshold, and lifecycle state. Generic orchestration cannot branch on platform names. Configuration changes are versioned so an import run always identifies the exact settings that produced its data.

The initial HTTP adapter supports authentication mode `none` or `bearer`. Bearer secrets are server-only and masked in reads. Schedules are configurable per provider and default to five minutes. Stale thresholds are independently configurable and default to fifteen minutes. A provider cannot be enabled until its settings validate and a connection test accepts a contract-valid page without importing it or moving the durable cursor.

## Requirements

### Configuration and activation

- Define provider configuration fields for platform key, adapter key, endpoint, authentication mode, bearer secret reference, schedule interval, stale threshold, state, and version metadata.
- Validate platform and adapter identities, HTTPS endpoint policy outside local development, authentication requirements, positive schedule and stale durations, and adapter-specific configuration at the owning boundary.
- Enforce exactly one enabled configuration for a platform. Replacing it creates a new revision and preserves prior revisions, runs, source provenance, and cursor history.
- Run a bounded non-importing connection test that requests the initial page, validates status, JSON, provider page shape, platform agreement, cursor rules, and configured authentication without persisting raw data or changing a checkpoint.
- Permit activation only after the current revision passes a connection test; record test time, outcome, bounded sanitized evidence, and actor.

### Permissions and lifecycle

- Allow administrators to create revisions, set or rotate bearer secrets, test, enable, disable, and archive. Allow data operators to read masked configuration and test or runtime status without changing settings or secrets.
- Stop scheduling new runs immediately after disablement or archival. Allow an already-running import to finish against its recorded configuration revision.
- Never hard-delete configurations, revisions, cursor history, or run provenance. Never return secret values after they are accepted.
- Return stable structured errors for unknown adapter, invalid configuration, duplicate active platform, failed connection, forbidden role, stale revision, and lifecycle conflict.

## User-Facing Behavior

Downstream admin UI can render a provider as draft, connection-tested, enabled, disabled, or archived. A masked secret indicator distinguishes configured from missing without revealing the token. Connection testing has clear pending, success, contract-failure, authentication-failure, timeout, and unreachable outcomes. Enablement remains unavailable until the current revision passes.

## Interface Contract

Configuration reads return identity, platform, adapter, endpoint, authentication mode, `has_bearer_secret`, schedule interval, stale threshold, state, version, last test summary, and audit timestamps. Writes use optimistic revision identity so an administrator cannot overwrite a newer change.

The adapter resolver receives an enabled configuration revision and a server-only credential reference. Schedulers and importers use immutable revision IDs. Connection tests return a fixed verdict, latency, response status when available, page counts, returned cursor metadata, checked time, and sanitized evidence; they return no raw payload or credential material.

## Acceptance Criteria

- [x] Configuration validation rejects unknown adapters, invalid endpoints, invalid timing values, missing bearer secrets, and conflicting active configurations with stable errors.
- [x] A successful connection test validates the first page without creating raw data, canonical data, a run, or a cursor checkpoint; failed tests cannot enable the revision.
- [x] Enabling a replacement version preserves prior configuration and run provenance and leaves exactly one enabled configuration for the platform.
- [x] Disabling or archiving stops future scheduling, lets an active revision-bound run finish, and never reveals or deletes the bearer secret history improperly.
- [x] Administrator and data-operator permissions, tenant scope, secret masking, optimistic conflicts, and audit behavior have direct boundary tests.

## Spec Compliance

- Strict public DTOs and stable service errors validate adapter/platform identities, endpoint policy, authentication decisions, timing bounds, lifecycle commands, and optimistic revision IDs.
- Credentials use AES-256-GCM with organization/provider/revision-bound authenticated data and a versioned keyring; reads expose only `hasBearerSecret`, while retired immutable revision credentials remain available to already-bound runtime work.
- The configuration repository preserves immutable revisions, serializes replacement races, records bounded connection-test evidence, activates only the exact currently tested revision, retains cursor/run provenance, and stops future scheduling on disable/archive.
- Connection testing resolves the registered transport, derives one exact allowed host, uses bounded time/body limits, and proves it creates no run, cursor, raw page, source record, or canonical revision.
- Direct integration tests cover admin/data-operator roles, tenant hiding, unsafe endpoints, unknown adapters, duplicate platforms, failed/repeated tests, optimistic conflicts, replacements, running prior revisions, lifecycle transitions, secret masking, and audit safety. Focused contracts/services/database checks and the append-only migration gate pass.
