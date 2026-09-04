# Task: Assemble Complete Deterministic Pack Snapshots

**ID:** pack-version-publication/003
**Depends on:** pack-version-publication/002
**Blocks:** pack-version-publication/006
**Delivery phase:** P03
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder after P01, including deterministic fixtures, boundary validation, and protected-data scanning
**Status:** blocked

## Current delivery checkpoint — 2026-09-04

The existing local assembler is preserved on `codex/pack-version-publication-p03-assembler`; it is not part of this P02 PR. It consumes P02's immutable capture contract. After PR95 merges, restack only child-owned commits from `8409143c8cca71e63602e097adf3e8ba45d86a12`, adopt P05's title/alias search and bounded wire header while retaining the full canonical hash header, then verify and publish separately. Historical checks are not current certification. P03 merge is not authorized.

## Start Here

Assemble the P01 pack fixture twice from identical pinned inputs presented in different orders, then record the identical canonical bytes, ordered batch hashes, aggregate hash, counts, snapshot identity, and projections.

## Objective

Produce one complete, bounded, deterministic `PublicPackSnapshot` from immutable pinned inputs without reading a database, mutable public state, or another pack. Invalid, partial, inconsistent, oversized, or protected input fails before any publication work can begin.

## Context

Atomic head activation is useful only when the selected snapshot already contains every pack-specific field needed for display and calculation. The assembler is a pure domain boundary: it converts one pinned desired pack state into canonical public bytes and evidence without owning persistence, scheduling, network calls, or head activation.

Snapshot identities represent domain-state revisions. Identical semantic inputs must yield identical bytes regardless of input order, process timing, or worker identity. All times, source identities, and policy identities that affect output are therefore supplied as immutable inputs rather than read during assembly.

Provider-wide profile fields remain outside pack bytes. Shared collectible, category, display, and valuation data required for this pack is copied into the snapshot so a later independent profile change cannot make the pack internally inconsistent.

## Delivery Context

P03 branches from merged P01 and is a sibling of P02, P04, and P05. Its review promise is a pure contract consumer with deterministic fixture verification and no database or network dependency. After merge, no runtime invokes the assembler and no public behavior changes; P06 integrates it with durable provider work and public publication.

## Requirements

### Complete snapshot

- Bind one stable pack identity, provider identity, pack metadata, price, mapped availability, retirement provenance, eligible actions, full active membership, odds, and pinned calculation inputs.
- Include immutable collectible and category display fields, every eligible member's valuation dependency, the selected top chase, matching EV result, and EV method and policy identities.
- Carry the existing native `publicRepackId` and `publicCollectibleId` values supplied by the request and never derive replacement public identities.
- Produce byte-equivalent summary, detail, search, desired-collectible, action, chase, and EV projections from the same complete snapshot.
- Exclude provider-wide profile fields and every field outside the P01 `PublicPackSnapshot` boundary.

### Chase, EV, and lifecycle

- Select the highest-valued eligible collectible as top chase with the P01 deterministic tie-break rule.
- Seal the full eligible-member valuation dependency set so a change to any candidate can produce a different snapshot and chase result.
- Carry explicit EV `unavailable` for a valid domain result, but reject absent, failed, expired, or input-mismatched calculation evidence.
- Bind numeric EV to the exact pack, contents, odds, valuation, method, and policy identities supplied by the build request.
- For lifecycle-only work, clone the complete prior sealed snapshot and change only lifecycle provenance, eligible actions, and deterministic EV presentation or freeze metadata; preserve contents, economic inputs, and numeric EV.

### Determinism and bounds

- Canonically order object fields, content members, dependencies, projections, and batches so input ordering cannot affect output.
- Derive the content hash and `publicPackSnapshotId` from the declared canonical hash domain and complete canonical public bytes.
- Partition the snapshot into bounded ordered batches whose individual hashes, counts, and aggregate hash validate against one descriptor.
- Keep provider change sequence and shared-dependency identities in `PackSnapshotEvidence` rather than using them as a combined order or including mutable worker state.
- Return `reused` only when the supplied existing snapshot identity and bytes match exactly; otherwise return a newly derived `created` result without performing persistence.

### Validation and privacy

- Reject missing or duplicate members, duplicate stable identities, cross-provider or cross-pack rows, invalid probability coverage, stale correlations, and missing dependency snapshots.
- Reject summary, detail, search, desired-collectible, action, chase, valuation, or EV projections that disagree with the complete snapshot.
- Reject runtime-generated time values, mutable handles, unpinned inputs, and a lifecycle-only request without a complete prior snapshot.
- Reject oversized fields, text, nesting depth, member counts, batch counts, batch bytes, and aggregate payload size before returning output.
- Scan recursively and reject credentials, accounts, connection topology, raw source evidence, quarantine details, exact collectible instances, user data, stack traces, and unbounded payloads.

## User-Facing Behavior

There is no direct user-facing change. The assembled artifact guarantees that any pack later selected by a public head presents metadata, lifecycle, contents, odds, chase, valuations, EV, and actions from one internally consistent domain snapshot.

## Interface Contract

`ProviderPackSnapshotAssembler.assemble` accepts `AssembleProviderPackSnapshotInput`: one fenced `PackBuildRequest`, immutable pack and full-content inputs or a permitted lifecycle source snapshot, all eligible-member dependency projections, matching EV evidence, provider change sequence, shared-dependency identities, and an existing byte-identical snapshot reference when present.

It returns `BuiltPublicPackSnapshot`, containing `PublicPackSnapshotDescriptor`, ordered `PublicPackSnapshotBatch` values, the complete `PublicPackSnapshot`, separate `PackSnapshotEvidence`, and a `created` or `reused` disposition. The canonical hash domain is `packscout.public-pack-snapshot.v1`.

The assembler performs no read, write, lease, schedule, network, credential, or head operation. Its output contains no database target, mutable-row handle, authorization material, source payload, provider-profile body, exact collectible instance, or user record.

## Acceptance Criteria

### Deterministic output

- [ ] Reordered but semantically identical inputs produce identical canonical bytes, batches, counts, hashes, snapshot identity, and projections.
- [ ] A later concurrent source change cannot alter a result assembled from pinned inputs.
- [ ] An exact supplied snapshot match returns `reused`; any public-byte change produces a distinct `created` snapshot identity.
- [ ] Summary, detail, search, desired-collectible, actions, chase, valuations, and EV all validate against the same snapshot identity.
- [ ] Every batch and aggregate stays within declared count, document, and byte bounds.

### Domain behavior

- [ ] Raising a previously non-top eligible member's valuation updates top chase and the snapshot hash.
- [ ] A deterministic valuation tie selects the P01-declared stable winner regardless of input order.
- [ ] A valid EV-unavailable result assembles without a numeric value, while technical calculation failure is rejected.
- [ ] An available-to-sold-out lifecycle snapshot records provenance and EV freeze metadata, disables actions, and preserves numeric economics and contents.
- [ ] Provider-wide profile changes are absent from pack bytes and cannot alter the snapshot hash.

### Rejection and privacy

- [ ] Partial contents, invalid odds, mismatched EV, stale dependencies, duplicate identities, and cross-provider records fail closed.
- [ ] A lifecycle-only request without a complete prior snapshot fails closed.
- [ ] Oversized or unbounded inputs fail before a `BuiltPublicPackSnapshot` is returned.
- [ ] Protected-field scanning rejects sensitive values at every nesting depth.
- [ ] Rejected assembly performs no persistence, head, receipt, or network operation.

## Verification

Named scenario: **Complete deterministic pack snapshot suite** — assemble lifecycle, contents, odds, chase, valuation, EV, reuse, size-bound, protected-field, and concurrent-change fixtures twice and compare every canonical output.
