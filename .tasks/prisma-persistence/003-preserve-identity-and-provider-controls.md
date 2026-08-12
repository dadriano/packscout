# Task: Preserve Identity and Provider Controls

**ID:** prisma-persistence/003  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/002](002-establish-prisma-runtime-and-test-foundation.md)  
**Blocks:** [prisma-persistence/006](006-preserve-quarantine-retention-and-operations.md), [prisma-persistence/007](007-cut-over-packscout-runtimes.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout's authentication, authorization, audit, setup, provider configuration, and secret persistence retain their current secure and transactional behavior through Prisma.

## Context

The protected control plane stores organizations, operators, memberships, sessions, login throttles, provider identities, immutable configuration revisions, connection-test evidence, versioned encrypted secrets, and audit events. These repositories enforce the last-administrator rule, immediate session revocation, authoritative role checks, one active configuration revision, credential masking, and tenant-scoped history.

This is a behavior-preservation task. Login, operator management, provider setup, configuration lifecycle, connection testing, and audit responses remain unchanged while their durable implementation moves to the shared Prisma foundation.

## Requirements

### Identity and sessions

- Preserve normalized operator identity, secure password records, organization membership, role enforcement, disabled-account behavior, and generic authentication failures.
- Preserve server-side session creation, rotation, lookup, expiry, revocation, and immediate invalidation after security-sensitive account changes.
- Preserve durable login-attempt limiting and its bounded retry outcomes without weakening atomic updates under concurrent attempts.
- Prevent concurrent mutations from disabling, demoting, or removing the final active administrator.
- Keep passwords, hashes, session tokens, CSRF material, and rate-limit internals out of responses, logs, and audit payloads.

### Provider configuration and secrets

- Preserve provider identity, lifecycle, immutable configuration revisions, connection-test evidence, and exactly one active revision per provider.
- Preserve atomic activation and archival outcomes when configuration state changes concurrently.
- Preserve versioned encrypted secrets, masked reads, rotation history, and deletion restrictions without exposing plaintext through the Prisma client boundary.
- Keep organization scope on every provider, revision, test, secret, and setup operation.
- Preserve stable conflict, validation, permission, missing-record, and stale-revision outcomes consumed by services.

### Audit and evidence

- Commit the protected mutation and its audit evidence atomically whenever the current contract requires both.
- Retain actor, target, action, outcome, and bounded safe metadata while excluding credentials, raw secrets, and protected provider payloads.
- Preserve setup and protected-evidence lookups without broadening which roles or runtimes can read sensitive material.

## User-Facing Behavior

Administrators and data operators see the same login, account-management, provider-configuration, connection-test, permission, conflict, and masked-secret behavior as before. No labels, flows, roles, or error meanings change.

## Interface Contract

Authentication, setup, and provider services continue using their existing persistence ports and stable domain outcomes. This task supplies Prisma-backed implementations for those ports without exposing ORM models, database clients, password records, or secret ciphertext to browser code.

Task `007` may compose these implementations into application runtimes after their focused security and transaction regressions pass. It does not need a compatibility adapter for Drizzle implementations.

## Acceptance Criteria

- [x] Login, logout, session rotation, account disablement, role recheck, throttling, and final-administrator protection match the existing direct and integration-test outcomes.
- [x] Provider creation, revisioning, connection tests, activation, disablement, archival, secret rotation, and stale-revision conflicts remain organization-scoped and atomic.
- [x] Concurrent identity and configuration mutations cannot bypass final-administrator, active-revision, session-revocation, or audit guarantees.
- [x] Responses, logs, errors, and audit records contain no password, token, plaintext secret, ciphertext, or unbounded protected evidence.
- [x] Existing service and HTTP contracts pass without a user-visible compatibility layer.

## Verification

- Run focused repository and service tests for authentication, sessions, rate limiting, setup, provider configuration, connection testing, secret handling, and audit.
- Run direct cross-organization, concurrent-final-administrator, concurrent-activation, stale-revision, session-revocation, and secret-leakage regressions.
- Run affected admin and service lint, typecheck, boundary, and integration checks through `npm run verify:framework`.

## Spec Compliance

- Related specs reviewed: none
- Alignment: converted identity, sessions, durable login throttling, provider configuration, encrypted-secret history, audit, and protected-evidence access to the shared Prisma client and transaction contract
- Divergences: public repository class names are retained temporarily so task `007` can cut runtime composition over without changing service ports; task `008` removes transitional persistence naming
- Verification: three real PostgreSQL identity, contention, tenant, session, and evidence tests; two provider configuration service integration tests; database and service lint; secret-safe audit assertions
