# Task: Judge Published-Versus-Canonical Parity per Provider

**ID:** provider-data-inspection/006
**Depends on:** provider-data-inspection/002, provider-data-inspection/004
**Blocks:** provider-data-inspection/007, provider-data-inspection/009
**Estimated scope:** medium
**Status:** done

## Objective

For every configured provider, the admin server can state in one cheap read whether what the product serves matches what the pipeline landed — in sync, behind, drifted, unpublished, or unknown — with a machine-readable reason and the side-by-side numbers the verdict rests on.

## Context

This is the fast path of the compare tool, and it exists because a full record-by-record walk over roughly 14.5 million records is far too expensive to run every time an operator opens a page.

Both sides already carry cryptographic identity for a provider's published state:

- In PostgreSQL, `provider_promotion_lanes` tracks, per organization, deployment, and `platform_key`: the settled canonical checkpoint, the source head checkpoint, the completed checkpoint, and the `completed_public_provider_release_id` with its `completed_provider_release_fingerprint`. `provider_release_artifacts` records the published artifact for a completed release, and `manifest_active_provider_selections` records which provider release the active manifest selected, with its fingerprint and checkpoint.
- In the product backend, `providerCatalogReleases` carries the same `providerReleaseFingerprint`, plus `contentHash`, `entityHashes`, `counts`, and `dataAsOf`, and the active manifest state names the live release per platform.

When the fingerprints on both sides agree, the published payload is identical by construction and no walk is needed. When they disagree, or when the canonical checkpoint has moved past what was published, something is genuinely off and the expensive path (task 007) is worth running. Encoding that distinction is the point of this task.

One scope rule governs the whole comparison: the product backend holds only the publishable subset — vendors, categories, repacks, collectibles, repack chases, and search rows. The canonical kinds `pull`, `market_event`, `ev_input`, and `estimated_ev`, along with quarantine records, have no published counterpart. Those are out of comparison scope and must be reported as such. Reporting them as missing downstream would be false.

## Requirements

- A per-provider verdict drawn only from cheap reads, taking one of five values, each with a machine-readable reason code and a human-readable explanation:
  - **in_sync** — the fingerprint of the release the active manifest serves equals the completed provider release fingerprint recorded on the promotion lane, and the lane's completed checkpoint has caught up with its settled canonical checkpoint.
  - **behind** — the fingerprints agree with the last completed release, but canonical has settled further than what was published; the lane's settled or source-head checkpoint is ahead of its completed checkpoint.
  - **drifted** — the fingerprints disagree, or the counts disagree, or the active manifest serves a release the promotion record does not recognize.
  - **unpublished** — the provider holds canonical data but the active manifest references no release for it.
  - **unknown** — one side could not be read. The response must name which side failed and why; it must never substitute zero for an unread value.
- Side-by-side figures backing each verdict: canonical counts per publishable kind and published counts per entity kind, `dataAsOf` on both sides, the checkpoints on both sides, and the fingerprints on both sides.
- An out-of-comparison-scope list naming the canonical kinds that have no published counterpart, returned with the verdict so consumers do not have to hard-code it.
- An all-providers summary shaped for a single overview table, produced without reading any individual record on either side and without a per-record round trip.
- The summary stays responsive at production scale. If a canonical count can only be produced approximately at that size, it is labelled approximate and a count difference that falls within the approximation's uncertainty is not reported as drift.
- Degradation is honest and partial: if the product backend is unreachable, the canonical side still returns its figures and the published side reads as unknown for every provider, with the reason stated once. The whole summary must not fail because one side did.
- A provider configured in PostgreSQL but never imported, and a published release with no corresponding provider configuration, are both representable rather than crashes.
- Every read is org-scoped and read-only.

## User-Facing Behavior

None directly — task 009 renders this.

## Interface Contract

- Consumes task 002 for canonical counts, freshness, and the provider roster, and task 004 for the published release identity, counts, and `dataAsOf`. Both sides are keyed by `platform_key`.
- Task 009 renders the all-providers summary and the per-provider detail. Task 007 reads the per-provider result to know which published release ID a reconciliation walk should pin itself to, and to refuse to walk out-of-scope kinds.
- The verdict values and reason codes are a closed, stable set defined here. Task 009 maps them to wording; it does not invent new ones.
- The response distinguishes "no active manifest at all" from "active manifest does not reference this provider", carrying task 004's distinction through rather than collapsing it.

## Acceptance Criteria

- [x] Matching fingerprints with a caught-up completed checkpoint yield `in_sync`; matching fingerprints with canonical settled further yield `behind`.
- [x] Disagreeing fingerprints, disagreeing counts, and a manifest referencing an unrecognized release each yield `drifted` with their own reason code.
- [x] A provider with canonical data and no referenced release yields `unpublished`.
- [x] With the product backend unreachable, every provider reads `unknown` on the published side, the canonical figures still return, and no unread value is reported as zero.
- [x] The out-of-scope kind list is returned with the verdict and names the canonical kinds with no published counterpart.
- [x] A count difference within the stated uncertainty of an approximate count is not reported as drift.
- [x] The all-providers summary performs no per-record reads on either side.

## Verification

Pure-logic tests over the verdict rule cover every branch — the two matching-fingerprint cases, each drift cause, unpublished, and each unknown cause — including that an unread side yields `unknown` rather than zero and that an approximate-count difference within its uncertainty does not read as drift. An integration test proves the all-providers summary returns with the product backend unreachable. The services and admin test suites plus the workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented as specified. The five verdicts and their reason codes are a closed set reached from fingerprints, checkpoints, and counts only — no per-record read on either side. Side-by-side figures, both checkpoints, both fingerprints, and both `dataAsOf` values travel with every verdict, as does the out-of-scope kind list. An unread side is `unknown` with the failing side named, never zero.
- Count comparison: a canonical count that stopped at its bound is a floor, and a floor establishes disagreement in one direction only. "At least 10" against 12 published is not drift; "at least 50,000" against 40 published is. Both directions are covered by tests.
- Additional case: a manifest naming a release the backend no longer holds is its own reason code (`MANIFEST_SERVES_MISSING_RELEASE`) rather than being collapsed into "not referenced", and a release whose lifecycle is not `complete` is drift rather than being served silently.
- Configuration: the parity surface needs the catalog deployment key, because promotion lanes are keyed by deployment and reading another deployment's lane would produce confident, wrong verdicts. Without it the routes report themselves unconfigured rather than guessing.
- Verification: `npm run test --workspace=@packscout/services` (807 pass, including 14 new tests covering every verdict branch, both floor directions, each drift cause, both unknown causes, and that out-of-scope kinds never appear among the compared figures), `npm run test:admin` (376 pass), `npm run typecheck` (0 errors), `npm run lint` (clean), `npm run scan:framework-standards:ratchet` (0 new findings).
