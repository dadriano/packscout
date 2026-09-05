# Task: Preserve Every Frontend Data Point in Pack Catalog V1

**ID:** pack-version-publication/011
**Depends on:** pack-version-publication/003, pack-version-publication/004, pack-version-publication/005, pack-version-publication/013
**Blocks:** pack-version-publication/006, pack-version-publication/007
**Delivery phase:** P05A
**Estimated scope:** large
**Status:** in_progress

## Active build — 2026-09-04

Current boundary: task013/P05B's neutral calculation/public-value extraction is merged through PR121, and the native frontend foundation012 is merged through PR120. Current main is f852a166cca88008eb2eb419a6a555c7ff794597. P05A still waits for003/004's current review fixes to be verified and merged;005/013 already belong to main. Its two incomplete native economics files remain preserved, not completed. Recreate P05A from the merged prerequisites; the old directory/dependencies moved safely to P05B. All current frontend datapoints and unchanged formulas remain required. Older path/parent notes below are historical preservation evidence, not a request to recreate the already-completed013 extraction.

The move is complete. Full immutable backup: `961f20694651e80c2e665f555bbce1e347dcc143`, including all ten source files and task records. Original P05A branch remains at44e2f193, now without a checked-out directory. Its directory/dependencies are reused by `.worktrees/pack-version-publication-p05b-ev-core` on an independent mainef3c73e8 branch. Only the eight013 files are restored there; the incomplete economics schema/test remain recoverable from this stash's untracked tree. No source or prior backup was deleted.

Owning worktree: `.worktrees/pack-version-publication-p05a-frontend-data`; branch `codex/pack-version-publication-p05a-frontend-data`; saved parent `44e2f193fd73ee5fc89eca05495787233d2e38bd` (P03/main115). Main117 requires fresh parent certification, so implementation is paused. Ten partial source files totaling2,337 changed lines are preserved: the original four plus neutral calculator/confidence extraction, exports and a direct neutral-boundary test. The two native economics files remain incomplete. Stash `2cf6c11510983c0e84acc3c77e5c9bd77ce43d5d` retains the original four files/metadata; the six later files are not in that stash. Preserve them before any restack. Root is reviewing a safe standalone neutral-core/value boundary; no extra phase/task exists yet. Native evidence wiring, query/aggregate and visible frontend work must wait for the measured boundary and verified prerequisites.

## Verified resume map — 2026-09-05

### Query-capacity evidence from the parallel feasibility check

The existing native read model declares8,000 active packs, separately from2,000 list-scan/desired-candidate budgets and50 returned rows. Merely raising those scan constants is not sufficient. The existing desired lookup performs approximately three index ranges per candidate; a representative rich head after replacement is2,502 JSON bytes (about20MB across8,000, an estimate rather than Convex metering). A complete native projection needs explicit maximum-size read/write/range tests, not just an overflow test.

Current [Convex transaction limits](https://docs.convex.dev/production/state/limits) are16MiB read/written,32,000 scanned documents,4,096 index ranges (including point reads),16,000 written documents, and1MiB per document. Local `convex/_generated/ai/guidelines.md` requires the aggregate component for indexed counts/sums/ranks/ranges, updated in the source mutation; arbitrary intersecting filters still need a bounded complete-candidate strategy.

Implementation direction to validate, not completed work: separate rich hydration from a compact snapshot-bound filter/aggregate projection; update projection/aggregate state atomically in normal and retained-head activation. Derive totals, medians and contextual facets from the complete declared population and hydrate only returned page display. For desired matches, avoid per-candidate point queries: use a compact unique collectible/pack candidate index and compare snapshot pointers against the compact active-head map, including stale/retained candidates. Stage inert references before activation; account for all replacement/rollback reads and writes, bounded provider joins, and stale-pointer retention. No global catalog barrier, extra public operation, delayed aggregate truth, new phase or reduced feature set is authorized by this note. Validate the actual byte/range ceiling before certifying the sketch.

Primary existing integration owners: `packHeadFields`, `applyBatch`, `finalize`, `activate`, `activateRetained`, all six native query handlers, `pagedHeads`, `packFilterMatches`, and sort/cursor helpers. Existing four neutral formula modules stay unchanged.

The read-only resume audit found no unresolved product policy. Add004 to the actual dependency set: its `public-profile-snapshot-assembler.ts` is absent from current main and must preserve the new provider/profile datapoints and descriptor search normalization. Resume after merged003/004/005/013. This is a dependency correction, not a new product decision or delivery phase.

1. Extend native public shapes in `packages/contracts/src/pack-catalog-domain.ts`, `pack-catalog-query.ts` and the incomplete native economics module; replace the reduced EV amount with the approved four metrics and evidence. Preserve all six operations, filters/sorts and honest unavailable states.
2. Extend `pack-build-inputs.ts` and `provider-pack-readiness-evaluator.ts` together. Bind canonical record/revision, price, draw semantics, governing buyback terms, method/policy and observed/effective times; replay task013's exact neutral functions. Private normalized economic evidence needs its own explicitly bounded input boundary; do not relax the sealed public-payload guard or treat private inputs as public strings.
3. Extend all explicit projections/equality/hash inputs in `provider-pack-snapshot-assembler.ts`, `pack-snapshot-assembly-seal.ts`, `pack-snapshot-assembly-input.ts`, P04's profile assembler and `packages/database/src/provider-pack-snapshot-repository.ts`. Preserve lifecycle freeze, exact-byte reuse, complete membership and whole-pack readiness.
4. Carry those values through Convex `schema.ts`, `packCatalogValidators.ts`, `packCatalogStoreSupport.ts`, `packSnapshotStore.ts`, `profileSnapshotStore.ts`, `packCatalogReadModel.ts` and `packCatalogV1.ts`. Complete aggregates must cover the declared population, not the2,000-row list limit or returned page. Preserve all eight accepted sorts, composable filters, exact selected collectible with zero matches, chase beyond the first content batch and match-confidence ordering.
5. Prepare bounded native owner-saved resolution in `convex/savedItems.ts`; coordinate the visible owner-read switch with007's atomic frontend cutover. Keep unavailable rows removable and ownership/refusals intact.

Reuse canonical `pack.attributes.evInputEvidence`, `providerPackEvEvidenceV1Schema` and the existing `providers/provider-promotion-ev-evidence.ts` boundary. Production transaction-local capture remains006. The remaining provider-derived arithmetic in `vendor-reported-gross-ev-v3.ts` must be reused/extracted exactly into neutral domain logic without importing its release DTO; do not adopt the saved draft's second inline calculation.

Verification proceeds from inventory-linked strict schemas and unchanged formula fixtures, through wrong-association/stale/incomplete captured inputs, P03 maximum/reuse/privacy/private-PG tests, Convex lifecycle and all six query/Watchlist paths, then two-pack update/rollback isolation and the full unchanged framework gate. Public routes remain dormant.

Scope forecast, not an approved new split:19 existing runtime files plus about16 fixture/test touchpoints before helpers/records. Measure the actual patch before crossing25files/2,500lines or the40file/5,000line hard stop. Immutable native data/admission and native query completeness are possible review boundaries only if measurement requires them; no new task or phase is created here. The saved economics schema/test total112 incomplete lines, not a finished implementation.

## Authorization and scope

Preservation update: all ten partial source files are backed up in immutable stash `cd88d5c6d4e2e0e4f8515a791ced820e86ba4b90`, reapplied to the same worktree without dropping the backup. This supersedes the four-file-only recovery limitation above; it does not claim native economics completion.

On 2026-09-04 the user requested all remaining builds, chose to preserve existing frontend features by extending V1, and clarified: "it should support all the datapoints in the frontend". This corrects the narrower initial contract before public cutover. Existing task IDs retain their meanings; P05A is one supplemental prerequisite, with further splits only if measured review limits require them.

## Objective

Carry every data point used by the current frontend through the native V1 source, captured input, immutable snapshot, active head, public query, and saved-item paths. Preserve existing formulas and supported query behavior while keeping each pack's published state complete and atomic.

## Boundaries

- Remain within the first and sole `pack_catalog_v1` contract.
- Preserve the established exclusion of Heat, which has no current catalog runtime consumer.
- Reuse existing domain calculation and evidence schemas where appropriate; do not translate old catalog responses or introduce fallback reads.
- Metrics must come from sealed evidence, never be reconstructed from a partial results page or fetched from an unrelated current profile.
- Missing legitimate source data stays explicitly unavailable; do not invent a number, category, image, promotion code, confidence value, or aggregate.
- Keep source details, credentials, operator state, and database topology outside public data.
- P04 continues to own durable central profile/fan-out persistence. P06 consumes the expanded pinned input contract and composes production processing. P07 owns the frontend switch.
- Public production routing and recurring publication remain unchanged during this correction.

## Resolved economic implementation constraints

These preserve existing domain behavior; they are not a formula or compatibility change.

- Replace the single `ev.amount` with explicit `metrics`: gross EV money, gross return basis points, signed net EV money, and signed net EV percentage basis points. Do not keep two competing representations.
- Carry confidence policy, score, band and bounded limitation codes; known/unknown source data time; calculation/evaluation time; valid-until evidence; and public unavailable reasons. Retries cannot renew stale evidence.
- Carry native display price independently from a discriminated USD comparison. Missing source amount is PRICE_UNAVAILABLE; a known unsupported currency is CURRENCY_UNSUPPORTED, even if the native display shape is null. No invented zero or exchange rate. Numeric EV requires its exact positive integer USD calculation price.
- Carry strict buyback display states: uniform rate, varies, fixed/final payout, not documented, or unavailable. Provider-reported EV retains source money, USD comparison, basis and observation time separately from the independent estimate.
- Publish provider-derived four-metric results only from reviewed underlying vendor evidence and applicable uniform buyback terms. Seal source/method/time attribution; the frontend does not recompute economics.
- Bind the complete normalized buyback/economic evidence to the exact canonical provider, pack record/revision, price, draw basis/count, method, confidence policy, and observed/effective evidence. Validate those associations, not just an array digest. Include the governing buyback evidence digest in `evInputsSha256`; only the aggregate digest enters public bytes.
- Preserve existing payout order: rate, percentage fee, fixed fee, clamp at zero, floor, cap. Exact final payout is direct; ineligible outcomes contribute zero without probability renormalization. Preserve draw multiplication, aggregate half-up cents, return half-up basis points, and net equals gross minus price.
- Preserve the existing public independent-EV policy for nonpositive net results without clamping permitted values. Separately attributed provider-derived results retain their existing semantics.
- Reuse browser-neutral domain definitions/calculation helpers where valid. No old-release DTO adapter, retained-release witness, dual path, or second schema.
- If a new capture is technically unready, retain the previous whole pack. Do not combine a current price with old EV or silently use a latest-unavailable fallback.

## Required field inventory

### Current-main source audit

PR117's presentation audit preserves every datapoint while moving evidence into confidence/source/value popovers and summary link titles. Provider logos now use stable vendor keys and approved local assets. No metric, formula or data requirement was removed. See the inventory's PR117 reconciliation. Main116's subsequent import-progress logging change adds no frontend datapoint. P03's new privacy/exact-byte review repairs pause this dependent work until corrected-parent verification.

PR115/main70bbae98 adds no new rendered data field, metric, filter or sort; the field inventory now pins that source baseline. Canonical `pack.attributes.evInputEvidence` reaches the current promotion-time provider boundary through `providers/provider-promotion-ev-evidence.ts`, with the existing pure calculation/public eligibility rules unchanged. Task006 owns adapting transaction-local canonical capture to V1; do not import a V3 public response or release-retention adapter.

Reviewed source odds include Courtyard `odds.buckets[].{oddsPercent,minValueUsd,maxValueUsd}` and Collector Crypt `weightMultipliers`, `tierRanges.*.{start,end}`, and `contains`, under their distributed-v4 source identity. Phygitals/Courtyard preserve exact percent-ratio recovery; Collector Crypt preserves direct ratio conversion. Provider-local source adapters keep these details outside generic V1 publication. Source observation, unknown counts, governing buyback evidence and separately advertised vendor EV remain distinct.

Membership receipt completeness and probability coverage are independent of EV bucket completeness. Preserve unknown coverage as null and never invent collectible identities or quantities. Complete EV evidence alone cannot satisfy full-contents V1 admission; an incomplete replacement leaves the previous whole pack active. Existing missing-valuation, collectible-type, image-fallback and vendor-reported valuation semantics are recorded in the inventory.

The initial inventory of current renderers, exact source properties, and native V1 gaps is in [_frontend-data-inventory.md](_frontend-data-inventory.md). It is supporting evidence, not a runnable task or a completed acceptance claim.

Before implementation, trace every current frontend field to its rendered owner, canonical source, V1 payload/projection, and verification. Include:

- Gross and net EV amounts and percentages, input coverage, confidence and associated evidence, buyback terms, vendor-reported values, lifecycle freeze/presentation states, and timestamps.
- Pack/provider/category/type identity, names, images, prices, inventory/availability/lifecycle, full contents, odds, chase identity/display/valuation, valuations, and provenance that is safe for public display.
- Purchase/promotion actions, eligibility reasons, provider promotions and any displayed/copyable promotion code.
- Current sanitized provider-feed status, source-observation timestamps, confidence/freshness presentation, source-currency money and USD-comparison unavailable states, collectible descriptors, and category hierarchy. The user's latest requirement extends the earlier omission of publicly displayed provider health; internal causes and operational records remain excluded.
- Dashboard counts, medians, highest chase, opportunity ranking, provider/category summaries, and contextual facets over the declared complete bounded head population.
- All currently accepted non-Heat filters, sorting, direction, page size, stable selection and desired-collectible intent.
- Watchlist row data, chased-collectible evidence, stable saved identities, and listing/detail behavior.
- Snapshot-pinned content paging and explicit head-advance evidence.
- Exact-ID selected collectible inspector display even with zero matches, with a distinct unknown-ID error. Preserve match-confidence descending order and stable pack-ID ties independently from main-catalog EV ordering.

The inventory must distinguish fields already represented, fields derivable without changing economics, and fields requiring additional sealed evidence.

## Acceptance Criteria

- [ ] Every current frontend data point has a source-to-V1 mapping and a named regression or an explicitly justified non-runtime classification.
- [ ] Strict browser-safe V1 schemas carry all required sealed public data without old-catalog adapters or another schema version.
- [ ] Pinned capture, assembly, summary/search projection, staging, finalization, and active-head validation preserve the added values and hashes together.
- [ ] Full and lifecycle-only updates preserve the established economics/formula behavior, and an update or rollback for pack A leaves pack B unchanged.
- [ ] Every supported list/search/dashboard filter, sort, facet, aggregate, and count uses complete declared bounded data, with honest unavailable/empty states.
- [ ] Chase and desired-collectible display/odds are resolved from the selected pack snapshot even when the matching member is outside the first content page.
- [ ] Watchlist listing and chase validation resolve V1 identities and evidence; resource saves remain stable and owner-scoped.
- [ ] Profile promotions and action eligibility preserve all currently displayed data safely.
- [ ] Existing V1 size, protected-data, authorization, replay, cursor, and isolation regressions pass without weakened gates.
- [ ] Full framework verification passes on the exact phase parent and implementation; public routes remain unexposed pending launch readiness.

## Verification

Named scenario: **Complete frontend data through one immutable pack** — capture production-shaped source fixtures with every current frontend field; assemble and publish two packs and their profiles; verify dashboard, list, detail, desired-collectible, search, and Watchlist outputs against the field inventory; update and roll back only one pack, page beyond its first content batch, and prove stable identities, complete data, formula parity, and independent heads.

## Spec Compliance

- Related specs reviewed: tech-001, tech-002, tech-003, tech-004, tech-005.
- Intentional extension: the user requires full current frontend data coverage beyond the initial reduced public schema. Existing technical companion files remain unchanged; this task records the approved correction.
- Implementation and verification: pending.
- Behavioral boundary: field parity does not permit publishing mixed current-price/old-EV data or weakening EV readiness/expiry. Preserve the prior entire complete pack when a newer capture is not ready; carry existing metrics and explicit historical/unavailable labels only with their sealed price, timestamps, method, policy, and provenance.
