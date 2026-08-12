# Technical Spec: Provider Mappings and Launch Verification

**Spec ID:** tech-006  
**Related tasks:** [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Depends on tech specs:** [tech-002](tech-002-provider-feed-storage-and-history.md), [tech-003](tech-003-ingestion-orchestration-and-reliability.md), [tech-004](tech-004-canonical-projections-and-estimated-ev.md), [tech-005](tech-005-admin-api-and-operability.md)  
**Spec status:** draft

## Purpose

Turn the eight supplied provider samples into isolated, testable mapping modules and define the backfill, reconciliation, security, failure, and operability proof required before enabling incremental production schedules.

## Current System Context

- Samples exist for Beezie, ClutchPacks, Collector Crypt, Courtyard, GameStop, Phygitals, Stadium Vault, and Trove.
- Every sample has catalog, pull, and sale arrays; GameStop, Stadium Vault, and Trove currently have empty sale arrays.
- Outer records are similar, while nested provider data ranges from detailed item attributes to odds buckets, pack tiers, provider EV, and sparse asset history.
- No provider mapping code, golden fixtures, backfill environment, or production launch scorecard exists.
- The repository's existing Collector Crypt fetch script solves a separate reporting problem and must not become an implicit compatibility path.

## Proposed Implementation

### Provider module contract

Create one module directory per platform under `packages/services/src/providers`. Each directory exports a mapper that implements the generic interface, a stable platform key, supported record kinds, mapping version, and provider-specific validation helpers.

The registry is the only generic location that names provider modules. Generic import, persistence, projection, scheduler, API, and UI code must not branch on platform keys.

### Mapping ownership by provider

- Beezie: map claw/pack price, odds/ranges, stock evidence, grails, pulls, and sale/swap events without assuming missing pack links.
- ClutchPacks: map pack price, price-bucket odds, series hits, card pulls, and transaction events.
- Collector Crypt: map collectible identity/value/listing context, machine-linked pulls, and nullable sale/transfer details.
- Courtyard: map asset price-history catalog evidence, pack-linked reveals, FMV estimates, and on-chain sales.

### Remaining provider ownership

- GameStop: map level price/rarity definitions and asset pulls; treat empty sales as supported absence.
- Phygitals: map variants, rarity distribution, provider EV, mint price, per-voucher draws, pulls, and sales.
- Stadium Vault: map effective odds tiers, price, possible-pull evidence, and pack-linked pulls; treat empty sales as supported absence.
- Trove: map tiers, tier-range semantics, supply/availability, cards per pack, grails, and nested pull collectible data.

### Fixture and drift strategy

Check sanitized fixture slices into a test-fixture directory with documented source hashes. Golden expectations assert the canonical commands, warnings, and EV limitations for representative records.

Unknown provider fields are tolerated and preserved in raw evidence. Missing or changed fields that affect required mappings produce a quarantine or page-contract result and a schema-drift operational event; they do not silently disappear.

### Launch progression

Roll out one platform at a time through four gates: fixture proof, isolated backfill, reconciliation approval, then incremental enablement. A platform can pause or roll back independently without disabling other providers.

## Code Changes

### Mapping modules

- Add eight provider directories with catalog, pull, sale, value-evidence, and helper modules as needed.
- Add registry tests proving each stored platform key resolves exactly one mapper and unsupported keys fail closed.
- Add fixture builders and golden result snapshots under server-only test directories.
- Add a mapping-version manifest so changed normalization behavior can schedule deliberate reprojection.

### Launch tooling

- Add explicit `scripts/preproduction` commands for fixture validation, bounded backfill, reconciliation report generation, and incremental dry run.
- Add explicit `scripts/live` commands only for non-destructive status checks and approved enable/pause operations.
- Require organization, provider, cursor range, and dry-run/execute mode as explicit validated arguments.
- Never expose a universal reset, truncate, or unscoped reimport command.

## Database / Schema Changes

### Mapping and launch evidence

Add `mapper_versions(platform_key, version, source_hash, deployed_at)` and record `mapper_version` on source projection outcomes and canonical revisions.

Create `launch_validations(id, organization_id, provider_id, config_revision_id, mapper_version, mode, state, cursor_start, cursor_end, source_counts_json, canonical_counts_json, quarantine_counts_json, reconciliation_json, security_checks_json, started_at, completed_at, approved_by, approved_at)`.

### Reprojection control

Create `reprojection_jobs(id, organization_id, provider_id, mapper_version_from, mapper_version_to, state, cursor_after_source_record_id, counters_json, requested_by_actor_key, created_at, completed_at)` only when a mapping change needs canonical regeneration.

Reprojection reads retained source records; evidence older than 90 days may be unavailable and must be reported rather than reconstructed from guesses.

## Interfaces, APIs, Endpoints

### Mapping manifest

```ts
interface ProviderMapperManifest {
  platformKey: PlatformKey;
  version: string;
  supportedKinds: readonly RecordKind[];
  mapper: ProviderRecordMapper;
}
```

The registry rejects duplicate platform keys and validates that the configuration platform matches the mapper manifest.

### Launch service operations

- `validateFixtures(platformKey)` returns contract, mapping, EV, and drift results.
- `requestBackfill(providerId, cursorRange, actor)` creates an audited bounded run.
- `buildReconciliation(validationId)` compares source, canonical, quarantine, unresolved, and EV outcomes.
- `approveLaunch(validationId, actor)` is admin-only and requires every mandatory gate to pass.
- `enableIncremental(providerId, actor)` activates the tested schedule without modifying mapping code or config history.

## Data Flow

1. Fixture tests validate the generic page contract and provider mapper outputs in CI.
2. Preproduction backfill imports through the same adapter, persistence, mapper, and projection path used by incremental runs.
3. The launch service aggregates counts, samples quarantines, checks unresolved relationships, and validates EV explanations.
4. An admin reviews and approves the immutable launch validation record.
5. Incremental scheduling is enabled for that provider; health, alerts, and rollback controls continue independently.

## Error Handling and Edge Cases

- Empty supported record arrays are successful with zero counts; a missing required top-level array fails the page contract.
- A mapper version change never mutates prior revisions in place; it creates an explicit reprojection job or applies only to new source records.
- Backfill page failures resume from the last committed cursor and retain the failed validation state for review.
- High quarantine rate, unresolved relationship backlog, unsupported EV currency/unit, or count mismatch blocks launch approval.
- Credential, authorization, tenant-isolation, or raw-data leakage failures are release blockers regardless of reconciliation counts.

## Testing and Verification

### Provider proof

- Run contract and golden mapping tests for all eight platform samples, including each nested odds/inventory form.
- Cover nullable fields, empty sale feeds, absent pack IDs, variant relationships, probability ranges, provider EV, and unknown extra fields.
- Prove mapping failures quarantine only affected records and preserve safe page progress.
- Prove every canonical field and EV input points to source record and mapper version evidence.
- Mutation-test key required fields in fixtures to prove schema drift fails visibly.

### Launch scorecard

- Reconcile per-kind source counts to imported, deduplicated, quarantined, and skipped outcomes with no unexplained remainder.
- Verify replay idempotency, cursor resume, no-overlap, cross-organization denial, credential redaction, retention, and pseudonymization.
- Verify admin permission, loading, empty, partial, failure, stale, and recovery states against the same preproduction data.
- Exercise pause, failed-run recovery, quarantine retry, alert acknowledgment, mapper-version change, and independent provider rollback.
- Require focused package checks plus `npm run verify:framework` before approval.

## Open Questions and Risks

- Fresh upstream payloads may differ from the static samples; a test endpoint response must be captured and compared before launch.
- Reprojection after 90-day raw expiry cannot recreate mappings from deleted evidence; retain canonical provenance and document the limitation.
- Provider rate limits and backfill cursor semantics need confirmation per configured endpoint.
- Production approval thresholds for quarantine rate and unresolved relationships must be numeric before the first launch gate.

## Handoff Notes

Start with one provider to prove the full generic path, then add the remaining modules without altering generic orchestration. Treat the launch validation record—not a successful HTTP request—as the production readiness artifact.
