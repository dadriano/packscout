# Clutchpacks chase-card backfill plan

Status: investigation and implementation design. The saved-capture findings below describe the original read-only investigation. Current official-source evidence and the implemented, bounded workflow are documented in [Clutchpacks chase-card backfill](clutchpacks-chase-card-backfill.md); live rollout remains a separate verified step.

The required outcome is to display cards that the provider actually associates with each pack, with accurate evidence labels. Add a current-inventory snapshot capability, reconcile supported relationships into provider `pack_contents`, and publish them through the governed distributed catalog projection. Do not use historical pulls as proof of current stock.

## Established code paths and missing evidence

| Source or component | What the checked-in code supports | What it does not establish |
| --- | --- | --- |
| Clutchpacks capture adapter | Reads card identities and display fields from `catalog[].data.series_hits`, `price_bucket_odds[].preview_cards`, and `price_bucket_odds[].pool_cards`; also extracts card evidence from pulls and trades. | Whether current payloads contain the same arrays, whether they are complete, whether an item is still drawable, or whether a series-level hit belongs to every pack. Saved coverage is recorded below. Current extraction emits standalone card evidence without preserving its catalog membership. |
| Aggregate pack EV evidence | Retains price-bucket quantities, values, and odds for promotion-time EV. | Individual card identity, current card membership, or an individual card's probability. |
| Legacy asset-to-pack association reader | Resolves confirmed card/pack pairs from a pull relationship set. | Current inventory. A past draw establishes a historical association only. |
| Provider `pack_contents` | Stores pack, collectible and optional instance references, quantity, role, probability, value, evidence, source observation time, lifecycle, and row version. Repository methods support material upserts, retirement, and promotion ledger changes. | Complete-snapshot reconciliation, an authoritative source-age guard, or a unique active membership constraint. Existing lookup indexes are not a concurrency guarantee. |
| Correlation and public contracts | Bounded promotion-ledger correlation processing, governed collectible identities including stable provisional IDs, and existing collectible/chase publication shapes. | Permission to merge cards by name alone, bypass correlation decisions, or publish unapproved asset origins. |
| Distributed local publisher | Builds a pack-only bootstrap release and checks its predecessor and source boundary. | Populated inventory/catalog publication: it requires zero active pack contents, rejects existing correlations/global catalog entries, and emits empty collectible/chase arrays. |

Source references: [capture adapter](../apps/worker/src/providers/clutchpacks-capture-integration.ts), [provider schema](../packages/database/prisma/provider/schema.prisma), [canonical repository](../packages/database/src/provider-canonical-repository.ts), [legacy relationship reader](../packages/database/src/provider-v1-asset-pack-association-reader.ts), [correlation source](../packages/database/src/provider-correlation-source.ts), [global catalog repository](../packages/database/src/global-catalog-repository.ts), [publication plan](../scripts/local/distributed-clutchpacks-publication-plan.mts), and [publisher](../scripts/local/promote-distributed-clutchpacks-to-local-convex.mts).

## Verified saved-capture coverage

A bounded read validated the existing protected `clutchpacks.json` against the repository-pinned SHA-256 on 2026-08-30. The saved catalog contains 14 pack records observed August 3–4, 2026. All 14 include `preview_cards` and `pool_cards` in price buckets. Four packs have at least one bucket with `has_more: true`; therefore the flag's exact semantics must be established before treating any of those lists as complete. Preview and pool entries contain native IDs, titles, and image URLs, but not item probabilities or item valuations. `current_price` appears only on the series-hit entries in this capture.

A repeatable-read, read-only canonical check at 2026-08-30T20:49:24.513Z found:

| Evidence | Result |
| --- | ---: |
| Current active canonical packs | 17 |
| Active canonical pack-content relationships | 0 |
| Saved pack identities matching current canonical keys | 14 of 14 |
| Unique saved pool-card IDs matching canonical collectible keys | 890 of 890 |
| Unique saved preview-card IDs matching canonical collectible keys | 870 of 870 |
| Unique series-hit IDs | 3, repeated across all 14 packs |
| Referenced canonical cards with images | 893 of 893, including the three series hits |
| Referenced canonical cards with a USD valuation | 853 of 893 |
| Matched packs whose canonical source evidence is newer than this capture | 14 of 14 |

This establishes a recoverable historical pack/card identity seed for 14 current packs, without a name-based join. It does not establish drawable stock today or coverage for the other three current packs. The same three `series_hits` repeating across all 14 packs reinforces that they must not automatically become every pack's current top chase. Existing card valuations can supply display evidence only with their own observation times and governing validation; a missing valuation must stay unknown.

The immediate implementation prerequisite is now specific: obtain an authoritative fresh pack-membership snapshot for the 17 active packs, preserving the already-proven IDs and marking completeness explicitly. Use the saved capture for regression fixtures and a historical dry-run seed, not as a current-stock overwrite. No event cursor needs to be reset. Sanitized count-only audit artifacts were saved locally; native payloads, credentials, card IDs, and source file locations were not copied into this document.

## 1. Establish the truthful backfill scope

Inventory saved native payloads using bounded, read-only queries. If payloads were not retained, a response hash is not reconstructible evidence. Do not claim a historical replay is possible from hashes alone. Assess whether a bounded catalog-only source fetch is needed after identifying the native endpoint and response contract; do not restart event ingestion to discover catalog coverage.

Produce a coverage manifest for each candidate pack containing:

- Provider and native pack identity; exact source field path and native card/instance identities.
- Source adapter, mapper, and schema versions; source effective time, collection time, and canonical payload digest.
- Evidence classification: complete current inventory, partial featured/preview list, explicit delta, historical-only association, or unknown.
- Evidence supporting that classification, including pagination/completion markers and item availability/removal semantics.
- Known card count, unresolved or conflicting identity count, payload location, and replay eligibility reason.

Prove the pack/card relationship from the provider's explicit fields and semantics. A card nested in a pack envelope is a candidate association, not automatic proof that it is in the current pool. In particular, verify whether `series_hits` is historical, series-wide, or a current pack feature. Verify whether `pool_cards` is exhaustive or paginated, and whether `preview_cards` is illustrative. A missing array means unknown, not an authoritative empty inventory.

The resulting coverage report determines which packs can be populated honestly. No target count or promise of coverage for every pack is justified until this step finishes. Preserve historical-only data separately; do not label it as `vendor_inventory` or a currently available chase.

## 2. Add a bounded, versioned inventory capability

Keep native extraction inside Clutchpacks provider modules. Extend the normalized source contract with a generic inventory capability rather than adding a provider branch to shared ingestion. Reuse the existing `pack_content` candidate path where appropriate, but make snapshot completeness and reconciliation explicit.

The versioned evidence must bind provider/pack identity, adapter/mapper versions, effective and collected timestamps, payload digest, completeness, and ordered membership items. Each item carries its native collectible/instance reference, role, optional quantities, source-specific availability/removal evidence, optional item probability, valuation evidence, and relationship observation time. Validate identifiers, duplicates, numeric ranges, timestamps, byte size, item count, and cross-provider/pack/instance consistency at the boundary.

Declare finite page, snapshot, item, and byte limits with capacity tests. Accumulate oversized complete inventories in resumable staging pages, then reconcile only after the full manifest and digest validate. An interrupted page sequence must never be treated as an empty or complete inventory. Missing/malformed snapshot data must not erase existing membership or EV evidence.

## 3. Reconcile inventory without replaying events

Reuse `pack_contents` as the current relationship projection. Add durable per-pack snapshot identity, provenance, ordering, and reconciliation state. Use transactional serialization and an active relationship uniqueness constraint, or an equivalently proven guarantee, for `(pack, collectible, optional instance)`.

Apply these rules atomically with promotion-ledger changes:

- An exact snapshot retry is inert: no duplicate relation, row-version increment, or new promotion sequence.
- Older effective evidence cannot overwrite current membership or restore a removed card. Equal ordering identity/time with different content is a conflict unless an explicit source revision contract orders it.
- Only a validated complete snapshot may retire members absent from that snapshot. Partial featured/preview lists do not prove removal of omitted items.
- Explicit item removal or zero remaining quantity removes current availability. Preserve the historical row and evidence according to the existing lifecycle model.
- A later proven reappearance creates the appropriate active relationship while preserving retired history. It cannot inherit a different card instance's identity.
- Missing referenced entities, malformed pages, or conflicting membership fail safely without partially replacing the active snapshot.

Use a separate backfill run and checkpoint. Freeze the scope manifest, source hashes, normalization versions, expected provider identity, and ordered pack IDs. Advance the backfill cursor in the same transaction that accepts a complete pack snapshot. Resume from that exact cursor after interruption. Keep dry-run proposed additions/updates/retirements and rejected identities reviewable before application.

Do not clear or reuse the live event cursor, replay pulls/trades, alter immutable-fact conflict rules, or delete quarantines. The existing `prepare-clutchpacks-dataforrest-replay-*` utilities require a cleared source cursor for their configuration replay workflow and are unsuitable for this inventory-only backfill unchanged.

## 4. Establish public identities and truthful odds

Process referenced collectibles and categories through the existing bounded correlation workflow through the selected promotion head. Use supported deterministic matches, otherwise stable provisional public identities with their uncertainty preserved. Do not create hardcoded per-card mappings or merge by display name alone. Freeze correlation and configuration versions for the publication snapshot; reject stale or cross-provider references.

Retain the current public pack identities. Populate public collectible title, image, category, grade/instance details, and value only from validated evidence and approved image origins. Bind relationship `observedAt` to the relationship evidence, not to a later card metadata update or publication clock.

Use `vendor_inventory` and `vendor_featured_chase` only for evidence that warrants those labels. Keep per-card probability unknown unless the source supports item-specific odds. Do not copy a bucket probability onto each card, or divide a bucket probability equally without explicit supporting source semantics. Validate the existing public probability representation without inventing precision.

The legacy central V3 projection must not be reused unchanged for current inventory: its association input comes from confirmed pulls, and its probability/timestamp mapping needs a separate current-inventory projection. Existing public collectible/chase contracts can be reused without treating that legacy relationship source as current stock.

## 5. Replace the empty-catalog bootstrap publication path

Backfilling `pack_contents` alone will make the current local bootstrap publisher refuse execution. Removing its zero-count/correlation guards is not a complete implementation. Build a reusable distributed catalog projection that reads packs, active memberships, referenced collectibles/instances, and governed correlation/configuration snapshots at an exact settled boundary.

The publication must populate collectibles, chase records, pack `topChase`, content summaries, search references, and counts together. Fingerprints must cover relationship content and versions, referenced collectible versions, and correlation/configuration versions; equal counts are not proof of equal content. Preserve the established public pack IDs and validate all cross-record references.

Use existing publication batching limits: at most 100 records and 48 KiB per provider batch, plus the existing total release and V3 constraints. Stage all required data, validate the complete release, and activate through the existing predecessor/generation compare-and-set and terminal receipt workflow. Keep the prior valid release available for rollback and verify rollback also restores consistent chase references.

The current publisher requires idle runtime, no active import lease, and source-head consistency. Catalog backfill changes made after a completed source run cannot be relabeled as that run's head. Introduce a governed catalog-only backfill completion boundary, or complete the corresponding supported run, before publication. A configuration revision must explicitly support the now-populated collectible/correlation projection.

## EV preservation and activation constraints

Chase inventory work must preserve normalized EV evidence, pack economics, retained EV metrics, calculation-price basis, and original source/calculation timestamps. A card relationship or metadata update must not manufacture fresher EV evidence. Promotion continues to use the existing EV calculation/publication policy; the chase feature does not introduce another calculator or use individual card values as an unapproved replacement for aggregate EV evidence.

Keep compact EV fact staging, durable retention, activation journals, and initialized read readiness intact. Follow [last-known EV display](last-known-ev-display.md): age reduces confidence without emptying a previously valid value; restocking does not make an EV frozen at sellout actionable until a newer valid calculation. Preserve the existing positive-EV publication and availability guards.

Before any live application:

1. Verify actual source coverage, finish the dry run, and capture provider identity, configuration, event cursor hash, lease/runtime state, promotion head, EV evidence digest, and quarantine integrity baseline.
2. Coordinate a clean Clutchpacks writer pause and lease fence with the ingestion owner. No old task-owned writer may resume during the handoff.
3. Deploy the inventory-preserving normalized DataForrest path and reconciliation contract into the resident worker before resuming polling. The next ordinary poll must maintain the backfill rather than erase it.
4. Apply only the scoped backfill manifest, verify exact checkpoint and material changes, then settle the governed catalog boundary and correlation/configuration snapshot.
5. Stage and validate publication; verify its counts, references, EV invariants, and rollback evidence before activation. Use the same exact predecessor guard at activation, and run public readback and browser acceptance afterward.
6. Recheck EV evidence, source event cursor, configuration, quarantines, and other-provider state against the expected change scope. Any unexpected change blocks activation or resumes the existing recovery procedure; do not hide it by resetting state.

This plan does not authorize unrelated provider changes, a cloud deployment, deletion of old releases/quarantines, or bypassing existing publication/migration readiness checks. Coordinate concrete activation with the ingestion and publication owners once the implementation and evidence are reviewable.

## Acceptance map and implementation order

All coverage below is **planned, not yet implemented or verified for this feature**. Tests should be discovered by the repository runner; do not hand-register files.

| ID | Given / when / then | Required verification |
| --- | --- | --- |
| CH-01 | Given explicit current pack/card evidence, when normalized and published, then the correct named card, image, value, and evidence label appear for that pack. | Provider normalization fixtures, projection/contract tests, browser inspector and table/cards. |
| CH-02 | Given only a past pull, series-wide example, missing field, or unverifiable payload, when backfill runs, then it creates no invented current stock and reports the coverage limitation. | Source classification and dry-run tests. |
| CH-03 | Given an applied snapshot, when retried or resumed after interruption, then rows, versions, ledger sequence, and counts are unchanged by exact replay. | Real disposable PostgreSQL integration test, including transactional checkpoint failure. |
| CH-04 | Given current inventory, when older, partial, malformed, or incomplete paginated evidence arrives, then it cannot delete valid members or restore removed members. | Ordering, completeness, paging, conflict, and concurrency tests. |
| CH-05 | Given a complete inventory removal or proven restock, when reconciled and promoted, then every public surface and search agrees without losing retired history. | Database lifecycle, complete-release/reference validation, activation and rollback tests. |
| CH-06 | Given missing per-card odds or only bucket odds, when projected, then card probability remains unknown; no bucket probability is copied onto each card. | Probability and valuation contract tests. |
| CH-07 | Given cross-provider/pack/instance mismatches, duplicate identities, stale correlation versions, or unapproved images, when processed, then the boundary refuses them without partial writes. | Direct database/service/publication security and integrity tests. |
| CH-08 | Given existing valid or retained EV, when chase-only data changes, then original EV evidence and retained metrics/timestamps remain intact, with existing confidence and eligibility rules. | Worker preservation, real database before/after digest checks, Convex retention/readback regressions. |
| CH-09 | Given bounded maximum-size inventory and a concurrent source/publication change, when staged, then limits remain enforced and exact-boundary activation refuses the race safely. | Capacity, settled-head, terminal receipt, and compare-and-set tests. |

Implement in dependency order: coverage report → normalized inventory contract → transactional reconciliation and isolated backfill runner → correlation/configuration projection → publication/readback → worker handoff and controlled activation. Keep this feature separate from the current EV review fixes.

Run focused tests at each layer, then the required `npm run verify:framework`. Browser acceptance must cover dashboard chase content, all-packs table/cards, pack inspector, chase search, and a refresh after activation. Report native coverage gaps and any manual acceptance gaps explicitly rather than claiming all packs are complete.
