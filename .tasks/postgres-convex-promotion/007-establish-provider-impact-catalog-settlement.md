# Task: Establish Provider-Impact Catalog Settlement

**ID:** postgres-convex-promotion/007
**Depends on:** postgres-convex-promotion/001
**Blocks:** postgres-convex-promotion/008
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including migration and concurrency verification
**Status:** done

## Start Here

Model one settled change for platform A, one technically blocked change for platform B, and one approved public-configuration change, then write the expected provider checkpoints and shared configuration epoch for that sequence.

## Objective

Give each configured platform an independent, causally safe catalog checkpoint while retaining the organization-global settlement boundary for Heat and audit ordering.

## Context

The completed settlement ledger advances one highest contiguous organization sequence. That boundary is correct for organization-wide Heat and audit work, but it makes an unrelated provider failure block every catalog release. Provider-owned immutable releases need an impact-aware checkpoint that follows only the causes and derivations capable of changing that platform's public projection. Approved shared public configuration still needs one epoch barrier so a manifest can never mix incompatible provider releases.

## Requirements

### Impact and ordering

- Give every public-affecting cause an immutable catalog impact: a canonical sorted set of affected `platformKey` values, a shared-configuration impact, a manifest-lifecycle impact, or no catalog impact.
- Derive each platform's highest causally settled checkpoint from only the causes and obligations that affect that platform; later settled work cannot skip an earlier affected cause.
- Keep the organization-global contiguous settled checkpoint from `001` as the Heat and audit boundary. Catalog release assembly must consume provider-impact checkpoints instead.
- Propagate an originating cause and impact through retries, replacement work, relationship resolution, Estimated EV, quarantine correction, and approved manual correction without duplicate obligations.
- Commit impact classification, obligations, and authoritative PostgreSQL changes transactionally, with stale-lease rejection and idempotent terminal acknowledgement.

### Configuration and lifecycle

- Define one immutable shared public-configuration epoch from the approved PostgreSQL public configuration. Every provider release referenced by one manifest must declare that same epoch.
- Treat a new shared configuration epoch as a barrier: no manifest for that epoch is eligible until every enabled platform has a complete compatible provider release.
- Define an enabled platform as one present in the approved public configuration whose causally settled provider lifecycle is `active`; settled `disabled` or `archived` platforms are excluded. Public or Convex callers cannot supply an organization, provider, or platform selector.
- Reject public-configuration approval when more than the eight registered launch platforms would be enabled. Increasing that bound requires a versioned manifest/search contract and hosted performance evidence.
- Let a provider-specific technical failure block only that provider's checkpoint. Surface the blocked impact safely without advancing it or exposing protected provider payloads.
- Record manifest-lifecycle readiness separately so disabling a platform can be expressed by a later manifest without requiring a replacement release for the platform being removed.

## User-Facing Behavior

No public shape or UI changes. After initial launch, a delayed provider can remain on its prior active release while unaffected providers continue to advance. A new shared configuration epoch remains invisible until all enabled providers are compatible with it.

## Interface Contract

`ProviderCatalogCheckpoint` supplies downstream tasks with the server-bound organization, stable `platformKey`, shared configuration epoch, highest affected settled sequence, provider source head, settlement time, and safe blocked state.

`ManifestEligibilitySnapshot` supplies the current shared configuration epoch, canonical enabled-platform set, lifecycle decision sequence, and each enabled platform's checkpoint. It is read atomically from PostgreSQL and contains no provider payload, credential, actor, or caller-selected tenant value.

The existing organization-global `SettledPublicWatermark` remains the only settlement input for Heat and audit work.

## Acceptance Criteria

### Provider independence

- [x] A technical failure affecting platform B does not stop platform A's checkpoint from advancing through its own settled changes.
- [x] An unsettled obligation affecting platform A prevents A from skipping that cause even when later A changes are terminal.
- [x] A cross-platform cause blocks every platform in its recorded impact set and no platform outside that set.
- [x] Replayed causes, replacement work, stale claims, and repeated acknowledgements cannot duplicate impact or regress a checkpoint.

### Epoch and lifecycle safety

- [x] A shared configuration change creates one new epoch and does not permit a mixed-epoch manifest.
- [x] Enabled-platform resolution is server-owned, causally settled, and tenant-isolated.
- [x] Approval of a ninth enabled public platform fails with a stable bounded-configuration error while eight enabled platforms remain valid.
- [x] A disable decision becomes manifest-eligible without requiring a new release for the removed platform.
- [x] The organization-global checkpoint and its Heat/audit behavior remain intact and directly tested.

## Verification

`npm run test:database && npm run test:services && npm run test:worker`

## Spec Compliance

- Related technical specs: none.
- Related UX specs: none.
- Implemented directly from this task PRD; no companion specs were present.
