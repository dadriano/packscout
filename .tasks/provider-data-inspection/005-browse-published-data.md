# Task: Browse Published Provider Data in the Admin

**ID:** provider-data-inspection/005
**Depends on:** provider-data-inspection/001, provider-data-inspection/004
**Blocks:** provider-data-inspection/010
**Estimated scope:** medium

## Objective

The Published destination in the admin's Data section shows, for a chosen provider, which catalog release the product actually serves right now, what that release contains, and what any single published document looks like — with the "no active release" and "backend unreachable" cases stated plainly instead of shown as zero.

## Context

This is the second of the Data section's three surfaces, and the mirror of task 003. Where Canonical answers "what did the pipeline land?", Published answers "what does the product actually serve?"

The published model is release-scoped and provider-scoped. The active manifest selects at most one catalog release per provider; that release carries a public release ID, a lifecycle state, a fingerprint, a content hash, per-entity-kind counts, and a `dataAsOf` timestamp. Its entities — vendors, categories, repacks, collectibles, and repack chases — belong to that release and are addressed by public entity IDs.

Three situations are normal and must read differently: there is no active manifest at all; there is an active manifest that does not reference this provider; and there is a release, but its lifecycle is `staging`, `failed`, or `retired` rather than `complete`. Task 004 keeps these distinguishable, and this page must keep them distinguishable too. A provider with nothing published must never render as a provider with zero records.

The published side holds only the publishable subset of the canonical model. Pulls, sales, EV inputs, and quarantine records have no published counterpart. The page states that rather than implying those kinds are missing.

Read-only throughout: nothing here republishes, retries, or retires anything.

## Requirements

- A provider picker sharing the same roster and `platform_key` identity the Canonical surface uses, so the two surfaces name providers identically.
- A release identity panel for the selected provider: public release ID, lifecycle, `dataAsOf`, provider release fingerprint, content hash, batch count, and completion metadata — with the fingerprint and hashes presented so they can be read and copied, since they are what task 009's parity verdict turns on.
- Per-entity-kind counts for the release as the backend reports them.
- A cursor-paged listing per entity kind — vendors, categories, repacks, collectibles, repack chases — showing each entity's public ID and enough identifying detail to recognize it.
- A document detail view showing the stored published document for one public entity ID, read-only.
- Explicit, distinct treatments for: no active manifest, active manifest that does not reference this provider, a release whose lifecycle is not `complete`, and the product backend being unreachable. None of these renders as an empty table or a zero count.
- A stated scope note naming which canonical kinds have published counterparts and which do not, so an operator does not read the absence of pulls or sales as a fault.
- Deep-linkable state: selected provider, entity kind, and page position live in the URL and survive a reload.
- Every state is represented and worded truthfully: loading, the four cases above, no entities of this kind in the release, invalid cursor, permission withdrawn mid-session, and read failed. A failed read keeps prior safe results visible.
- The page uses the admin's existing shell, tokens, tables, and empty states, declares no palette values in feature styles, and meets the project's UI layout standard for keyboard and screen-reader use.

## User-Facing Behavior

An operator opens Data → Published and picks Courtyard. The top of the page states which release the product is serving: its public release ID, that it is complete, when its data is as of, and its fingerprint. Counts follow — how many vendors, categories, repacks, collectibles, and chases the release holds — with a note that pulls, sales, and EV inputs are pipeline-only and have no published form. A paged table lists published repacks by public ID; selecting one shows the exact document the product serves. Picking a provider that the active manifest does not reference replaces all of it with a plain statement that nothing is published for this provider and that the pipeline may not have promoted it yet.

## Interface Contract

- Consumes task 004's active-release read, entity listing, and single-document read through the admin server. The browser never holds the backend's deployment secret and never calls the backend directly.
- Consumes task 002's provider roster for the picker, so both browse surfaces agree on the provider list.
- Its route lives under `/data/published` as fixed by task 001, and its server routes carry task 001's permission.
- The public entity IDs shown here are the same identifiers task 007 reconciles and task 008 diffs; this page displays them in a form an operator can copy into those views.

## Acceptance Criteria

- [ ] Selecting a provider with an active release shows that release's identity, lifecycle, `dataAsOf`, fingerprint, hashes, and counts.
- [ ] Selecting a provider not referenced by the active manifest shows the distinct "nothing published" treatment, not an empty table or zero counts.
- [ ] No active manifest at all, and the product backend being unreachable, each render their own distinct treatment.
- [ ] A release whose lifecycle is `staging`, `failed`, or `retired` is labelled with that lifecycle rather than presented as the served release without qualification.
- [ ] Paging an entity listing forward then backward returns to the same first page, and an invalid cursor produces a stated error rather than silently restarting.
- [ ] Opening a published entity shows its stored document read-only.
- [ ] The scope note names the canonical kinds that have no published counterpart.
- [ ] Reloading a deep link restores the same provider, entity kind, and page position.

## Verification

Component and route tests drive provider selection, paging, and document detail, and assert that no-manifest, provider-not-referenced, non-complete lifecycle, backend-unreachable, invalid-cursor, forbidden, and empty-kind each render their own distinct treatment rather than collapsing into an empty table. The admin test suite, lint, and the workspace typecheck exit 0.
