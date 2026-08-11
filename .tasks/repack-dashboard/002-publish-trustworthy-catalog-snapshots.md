# Task: Publish Trustworthy Catalog Snapshots

**ID:** repack-dashboard/002
**Depends on:** repack-dashboard/001
**Blocks:** repack-dashboard/003, repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 6–10 days for one builder, including backfill, recovery, and reconciliation verification
**Status:** blocked

## Start Here

Write one complete `CatalogSnapshotV1` example for two platforms, including one estimated pack, one unavailable estimate, one sold-out pack, and one missing-image fallback.

## Objective

Publish a versioned, frontend-safe catalog snapshot from canonical PackScout data so every public view reads one rebuildable source with truthful metrics and freshness.

## Context

Canonical PostgreSQL history remains authoritative for provider evidence, revisions, relationships, and PackScout Estimated EV. Convex is the approved frontend read database. It stores only denormalized public data and frontend-safe configuration; it is not a second canonical source and never writes back to the pipeline.

The current data-pipeline PR has no public publisher, listing query, platform display configuration, promo code, affiliate link, or assembled top-chase record. This task establishes that handoff after the live provider contract in `repack-dashboard/001` is locked.

## Requirements

### Snapshot Identity and Lifecycle

- Give every snapshot a stable schema version, publication ID, source watermark, content hash, creation/completion time, and separately tracked last-successful-observation freshness metadata.
- Stage bounded batches without exposing them until the expected record count and hash reconcile.
- Activate one complete snapshot at a time and keep the previous complete snapshot available for recovery.
- Skip content publication when canonical inputs and public configuration have not changed, but record a new successful observation and refresh freshness metadata without rewriting immutable snapshot rows.
- Remove expired inactive snapshots through a bounded retention policy without affecting the active snapshot.

### Snapshot Retention

- Keep the active and previous complete snapshots unconditionally so normal rollback remains available.
- Keep at most three additional complete inactive snapshots for seven days.
- Remove abandoned staging and failed snapshots after 24 hours.
- Delete at most 100 snapshot-owned documents per retention mutation and reschedule until the inactive snapshot reconciles to zero.
- Never delete data referenced by the active or previous pointer; a cursor for a removed snapshot returns `CURSOR_EXPIRED` and resets coherently.

### Manifest Safety Blocks

- Keep canonical manifest fingerprint block/release state authoritative in PostgreSQL; Convex stores a rebuildable enforcement mirror only.
- Reserve the PostgreSQL block before confirmed rollback/clear and keep pending state conservative until an exact Convex terminal receipt activates it.
- Synchronize and hash-reconcile the authoritative block set before a new/replaced Convex deployment accepts publication.
- Reject a blocked fingerprint at both publication start and finalize even when it arrives under a new publication ID; confirmed clear retains the block.
- Release a fingerprint only through a separately permissioned, typed-confirmation operation with exact terminal receipts in PostgreSQL and Convex.

### Public Pack Record

- Publish a stable public pack ID, platform key/display name/logo, category, pack name, description, availability, and source timestamps.
- Publish price in integer minor units and currency, buyback percent, approved pack imagery, and one deterministic primary image.
- Publish PackScout Gross EV, EV return percentage, calculation time, coverage, public limitations, and unavailability reason codes.
- Publish one deterministic top chase with name, value, currency, approved image, and evidence provenance when available.
- Publish sold-out records with their status; exclude disabled records from the public snapshot.

### Comparison Projection

- Materialize Gross EV, signed EV dollars, and signed EV percentage as validated sortable fields; never require a public query to reinterpret the pipeline percentage.
- Store available comparison money in canonical USD integer minor units and percentages in integer basis points with explicit semantic state.
- Keep original supported display currency evidence separate from nullable USD comparison values; the publisher performs no exchange-rate conversion.
- Choose Top Chase by highest eligible representative USD value, then stable public asset ID; if none is comparable, choose the lowest stable public asset ID and classify no value as `CHASE_UNAVAILABLE` versus numeric unsupported-currency evidence as `CURRENCY_UNSUPPORTED`.
- Give every optional sort field an explicit availability rank so unavailable values sort last in both ascending and descending order.

### Public Action Configuration

- Publish only approved listing URLs, listing-host metadata, referral parameters, and public promo codes.
- Preserve existing listing query parameters and provide one data-driven PackScout referral parameter set per platform.
- Publish platform display configuration independently from provider secrets and operational settings.
- Reject non-HTTP(S) listing URLs and images from hosts outside the platform’s approved public allowlist.
- Omit action fields when approval or source data is absent.

### Configuration Authority

- Store public platform display names, logos, listing hosts, referral parameters, promo codes, and currency policy in versioned PostgreSQL configuration owned by the shared service boundary.
- Record configuration revision, approval state, approver role, approval time, and content hash; only an approved revision may enter a public snapshot.
- Include the approved configuration revision, content hash, and exact frontend image-origin-set hash in snapshot identity so configuration-only changes publish deterministically and CSP deployment can fail closed.
- Treat Convex configuration as a snapshot copy that is rebuilt from PostgreSQL, never as its sole durable authority or an operator editing surface.
- Require Product-owner approval for public partner copy and Engineering-owner approval for host, referral, and currency-policy enforcement through separate permissions and distinct authenticated actors.

### Configuration Operator Workflow

- Provide a protected admin proposal/review surface backed by the shared service; browser code never writes PostgreSQL or imports server modules.
- A proposal shows its immutable revision, current-versus-proposed field diff, expected current revision, approval state, and audit history before submission.
- Product approval controls only partner-facing display/logo/promo copy; Engineering approval controls exact hosts, referrals, currency policy, and origin-set hash.
- Prevent one actor from supplying both approvals, explain the remaining required owner, and return stable permission/revision/CSRF errors without discarding the draft.
- Mark a revision current/exportable only after both approvals; rejection or replacement preserves the immutable audit trail.

### Safety and Privacy

- Exclude raw payloads, actor keys, wallets, usernames, tenant identifiers, provider credentials, internal run IDs, and quarantine details.
- Resolve the approved PackScout organization server-side; no public record or request accepts a tenant selector.
- Represent missing financial fields as null plus a public reason code, never as zero.
- Keep provider-reported EV distinct and never substitute it for PackScout Estimated EV.
- Exclude Net EV, fees, shipping, bookmarks, and user preference data.

### Public Availability Vocabulary

- Constrain metric reasons to `ESTIMATE_INPUT_INCOMPLETE`, `PRICE_UNAVAILABLE`, `CURRENCY_UNSUPPORTED`, `BUYBACK_UNAVAILABLE`, and `CHASE_UNAVAILABLE`.
- Map protected canonical reasons into that vocabulary before publication and reject any unrecognized reason at the snapshot boundary.
- Keep missing action configuration out of metric reasons; absent or unapproved Promo and Pack Link fields are omitted.
- Keep delayed publication at snapshot level rather than marking every pack metric unavailable.
- Publish public limitation copy separately from the stable reason code.

### Reliability and Freshness

- Publication is idempotent by snapshot ID, public pack ID, canonical revision, and content hash.
- Retries cannot duplicate records, regress a newer snapshot, or expose a partially completed snapshot.
- A full rebuild produces the same active public catalog as incremental publication from the same canonical state.
- Public freshness aggregates source-head status without exposing internal provider failures or identifiers.
- Publication failure leaves the last complete snapshot readable and marks it delayed.

### Publication Ledger Evidence

- PostgreSQL records every publication/refresh attempt through a terminal state and can reconcile a lost local acknowledgement from an authenticated Convex status receipt.

## User-Facing Behavior

The public UI sees only complete snapshots. Fresh snapshots can update reactively; delayed publication keeps the last complete data visible with an amber status. Missing metrics and media render as unavailable rather than invented content. Separately, authorized admin operators can propose, diff, approve, reject, and audit public configuration; Product and Engineering approvals require two distinct actors before export.

## Interface Contract

`CatalogSnapshotV1` exposes four public shapes:

| Shape | Required content |
|---|---|
| `SnapshotMetadata` | Version, publication ID, completed time, data-as-of time, last-successful-observation time, freshness, delayed-source count |
| `PackSummary` | Stable identity, platform/category/name/status, price, EV summary, buyback, primary image, top-chase summary, action availability |
| `PackDetail` | Summary fields plus description, evidence coverage/limitations, all approved action configuration, and top-chase detail |
| `CatalogFacets` | Platform/category values and public counts for the active snapshot |

Every money value uses integer minor units with an explicit currency. Every optional metric uses a value-or-unavailable contract. `repack-dashboard/003` consumes these shapes without accessing canonical storage.

`SnapshotMetadata` also carries the approved public-configuration revision and content hash. `PackSummary` and `PackDetail` carry nullable USD comparison fields, original display-money evidence when supported, public availability reason codes, and deterministic null-rank fields.

## Acceptance Criteria

### Publication Evidence

- [ ] An initial build publishes a complete snapshot containing estimated, unavailable, active, and sold-out examples.
- [ ] Replaying the same publication changes no public record and creates no duplicate.
- [ ] A changed canonical revision produces one new public value with traceable snapshot provenance.
- [ ] A failed staged publication leaves the previous complete snapshot active.
- [ ] Full rebuild and incremental publication reconcile to the same public content hash.

### Observation and Recovery Evidence

- [ ] An unchanged successful reconciliation advances observation/data-as-of freshness and its stale guard without changing immutable snapshot rows or pointers.
- [ ] Every PostgreSQL ledger row reaches `published`, `unchanged`, `failed`, or `rolled_back`, including recovery through a signed Convex status receipt after a lost acknowledgement.
- [ ] Confirmed rollback never retains the unsafe outgoing snapshot as previous; a validated safe target activates or an explicitly confirmed clear yields `SNAPSHOT_UNAVAILABLE`.
- [ ] The unsafe manifest fingerprint stays blocked across a new publication ID and confirmed clear; only a corrected fingerprint or separately confirmed/audited unblock can make publication eligible.

### Safety and Product Evidence

- [x] Public records contain no raw payload, tenant identifier, actor data, credential, internal run ID, or quarantine detail.
- [x] Promo, referral, logo, and listing-host configuration is frontend-safe and data-driven.
- [x] Missing EV, price, chase, image, promo, and link data uses explicit unavailable behavior.
- [ ] Disabled packs are absent; sold-out packs remain labeled and non-actionable.
- [x] Freshness can report fresh, delayed, and unavailable initial-snapshot states.

### Comparison and Configuration Evidence

- [x] Signed EV $, signed EV %, money minor units, basis points, and null ranks match canonical fixtures exactly.
- [ ] Chase selection uses only supported representative USD values and deterministic ties.
- [ ] Unknown public reason codes or unapproved configuration revisions fail staging before activation.
- [ ] A configuration-only change produces one new deterministic snapshot, and a rebuild restores the same approved public configuration.
- [ ] Convex contains no configuration value that cannot be regenerated from the versioned PostgreSQL authority.

### Configuration Workflow Evidence

- [ ] Proposal/review routes enforce admin authentication, organization scope, CSRF, optimistic revision, and stable structured errors.
- [ ] Product and Engineering permissions expose only their owned fields/actions, and the same actor cannot satisfy both approvals.
- [ ] The admin UI preserves a rejected/conflicted draft, shows the immutable diff/audit state, and clearly identifies the remaining approval.
- [ ] Only a dual-approved current revision is exportable; rejection/replacement and concurrent proposals cannot bypass the audit trail.

## Build Status

- Implemented: strict browser-safe `CatalogSnapshotV1`/public DTO schemas, a synthetic two-platform fixture covering estimated, unavailable, sold-out, and missing-image records, protected-field scanning, exact materialized metric validation, approved-host/action validation, and fresh/delayed/unavailable read-state contracts.
- Verified: contracts tests prove protected fields are rejected, sold-out Pack Links are invalid, money/basis-point consistency is exact, public reason codes are bounded, and action/media hosts must match the copied approved configuration.
- Blocked: task `001` has not produced an adopted V2 canonical handoff. There is no dual-approved PostgreSQL public configuration, publication ledger/manifest-block authority, cloud Convex deployment, HMAC key set, publisher, activation lifecycle, recovery path, or real publication evidence.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-001, repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-005
- Alignment: the implemented runtime-neutral snapshot contract follows the specified public-only identities, money/reason vocabulary, action/media allowlisting, immutable metadata, and safe frontend shape.
- Divergences: none in the contract slice; publication, PostgreSQL configuration approval, Convex lifecycle/authentication, retention, rollback, and admin workflow remain unimplemented rather than being simulated locally.
- Verification: `@packscout/contracts` snapshot/public-catalog tests and the local Convex/read-model suites recorded green; no cloud publication or real-backend evidence exists.
