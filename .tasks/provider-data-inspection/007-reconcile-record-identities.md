# Task: Reconcile Record Identities Across the Boundary

**ID:** provider-data-inspection/007
**Depends on:** provider-data-inspection/006
**Blocks:** provider-data-inspection/009
**Estimated scope:** large

## Objective

When a provider's parity verdict says something is wrong, the admin server can name the specific records involved — which public IDs exist canonically but are not published, and which are published without a canonical counterpart — through a bounded, resumable walk that never claims completeness it did not achieve.

## Context

This is the deep path of the compare tool. Task 006 answers "is this provider off?" cheaply from fingerprints and counts. This task answers "which records?", and it is expensive: a provider's release can hold millions of entities, and neither side will return them all in one query.

The comparison happens on **public identifiers**, not internal ones. Canonical entities are keyed by `(organization_id, platform_key, record_kind, external_id)` and use internal UUIDs; published entities are keyed by public entity IDs within a release. The bridge is the governed identity mapping: `public_repack_identity_mappings` maps `(organization_id, platform_key, pack_external_id)` to a `public_repack_id` at an approved configuration and change sequence. A canonical record with no identity mapping has no public identity at all — that is a distinct and important finding, not a match failure.

Two hazards drive the design. First, a walk that takes many requests can straddle a promotion: if the active release changes mid-walk, results that mix two releases are worse than no results. Second, a partial walk that renders as if it were complete will convince an operator that a provider is clean when only its first page was checked. Both must be structurally impossible, not merely discouraged.

Only publishable kinds can be reconciled. Task 006 already returns the out-of-scope kind list; asking to reconcile `pull`, `sale`, `ev_input`, `estimated_ev`, or quarantine is a refusal with a stated reason, not an empty result.

## Requirements

- A reconciliation walk scoped to one provider and one publishable entity kind, producing three classifications by public ID: present on both sides, canonical-only (has a public identity, is not in the published release), and published-only (in the release, with no canonical counterpart).
- Canonical records with **no** public identity mapping are reported as their own fourth category with their natural key, distinct from canonical-only. A record that was never granted a public identity has a different cause than one that was granted one and never shipped.
- Each request performs bounded work and returns an opaque cursor plus honest progress: how many identities have been examined on each side so far, and whether the walk is complete or still partial. A partial result is labelled partial in the payload itself, so no consumer can render it as complete by omission.
- Deterministic total ordering on both sides, so a resumed walk cannot skip an identity or count one twice.
- Release pinning: the walk records the `publicProviderReleaseId` it started against, and every continuation verifies the active manifest still serves that release. If it changed, the walk terminates with an "invalidated by a new release" outcome naming the old and new release IDs, and is not silently restarted or continued against the new release.
- A server-enforced cap on reported divergences per category, with an explicit count of how many were found beyond the cap so a truncated list never reads as the whole list.
- A request for an out-of-scope kind is refused with a stated reason naming the kind and why it has no published counterpart.
- Honest failure and degradation: if either side becomes unreadable mid-walk, the walk stops and reports how far it got and which side failed. Partial progress already established is returned, not discarded and not extrapolated.
- Every read is org-scoped and read-only; the walk mutates nothing on either side.

## User-Facing Behavior

None directly — task 009 drives this and renders its progress and results.

## Interface Contract

- Consumes task 006 for the provider's verdict and the published release ID to pin, and task 004's identity-only ID page for the published side. Canonical public identities come from the governed identity mapping.
- Task 009 starts a walk, polls it with the returned cursor, renders progress, and lists the divergences. The payload's completeness flag, the per-category caps with their beyond-cap counts, and the invalidation outcome are all part of what task 009 must render — they are not internal details.
- Divergences are reported as public IDs (plus the canonical natural key where one exists), which is exactly what task 008 needs to diff one of them.

## Acceptance Criteria

- [ ] For a provider whose sides differ, the walk classifies identities into present-on-both, canonical-only, published-only, and canonical-without-public-identity, and each divergent ID appears in exactly one category.
- [ ] Resuming with a returned cursor visits every identity exactly once across the whole walk — none skipped, none counted twice.
- [ ] A walk that has not finished reports itself as partial in its payload; only a walk that covered both sides fully reports complete.
- [ ] When the active manifest changes mid-walk, the continuation terminates with the invalidation outcome naming both release IDs, and does not continue against the new release.
- [ ] Divergence lists respect the server-side cap and report how many were found beyond it.
- [ ] Requesting an out-of-scope kind is refused with a stated reason rather than returning an empty result.
- [ ] If one side becomes unreadable mid-walk, the walk reports its progress so far and names the failing side.

## Verification

Tests over the walk prove exactly-once coverage across a multi-page resume, that a partial walk is labelled partial and only a full walk is labelled complete, that a release change mid-walk produces the invalidation outcome instead of mixed results, that the per-category cap reports its beyond-cap count, and that an out-of-scope kind is refused. The services and admin test suites plus the workspace typecheck exit 0.
