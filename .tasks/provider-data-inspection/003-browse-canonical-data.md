# Task: Browse Canonical Provider Data in the Admin

**ID:** provider-data-inspection/003
**Depends on:** provider-data-inspection/001, provider-data-inspection/002
**Blocks:** provider-data-inspection/010
**Estimated scope:** medium

## Objective

The Canonical destination in the admin's Data section lets an operator pick a provider, see what canonical data PostgreSQL holds for it, page through the records, and open one record to read its current content — with every empty, partial, and failed state worded honestly.

## Context

This is the first of the Data section's three surfaces. It answers "what did the pipeline actually land for this provider?" without an operator having to reach for a database client. It is strictly read-only: no field is editable, and no control mutates anything.

The canonical model is per-provider and per-kind. A provider is identified by its `platform_key`; its canonical records are entities of a fixed set of kinds (`platform`, `pack`, `catalog_asset`, `ev_input`, `pull`, `sale`, `estimated_ev`), each with a current revision carrying content, hashes, and source timestamps. Task 002 supplies all of that through a read capability; this task must consume it rather than query the database directly.

Scale matters to the design: a provider can hold millions of records, so the record list is cursor-paged and some summary counts arrive labelled as approximate. The page must present an approximate count as approximate — an operator using this surface to judge whether a feed is complete will be misled by a number that looks exact and is not.

The admin already owns its shell, tokens, tables, empty states, and error banners. This page uses them. Feature styles consume the existing token vocabulary and declare no palette values of their own.

## Requirements

- A provider picker listing every configured provider by display name with its `platform_key` and lifecycle state. The picker's selection drives the whole page.
- A per-kind summary for the selected provider: entity count per canonical record kind, and the newest and oldest source-collected and accepted timestamps. Counts that arrive approximate are shown as approximate, in the surface itself and not only in a tooltip.
- A record list for the selected provider and kind: cursor-paged forward and backward, with a bounded page size, showing each entity's `external_id`, current revision number, and the timestamps that let an operator judge freshness.
- Lookup by exact `external_id` and prefix search within the selected provider and kind.
- A record detail view showing the current revision's content, its revision number, content and provenance hashes, the three source timestamps, and the relationship edges declared from the record with their resolution state. Content is displayed read-only.
- Deep-linkable state: the selected provider, record kind, search term, and page position live in the URL, so an operator can send a colleague the exact view they are looking at and reloading returns to it.
- Cross-links from the selected provider to its existing admin surfaces — provider detail, its import runs, and its quarantine records — so an operator who spots a gap can move to the surface that explains it. No remediation happens on this page.
- Every state is represented and worded truthfully: loading, no providers configured, provider selected but no records of this kind, search matched nothing, cursor expired or invalid, permission withdrawn mid-session, and read failed. A failed read keeps prior safe results visible rather than blanking the page.
- The page is keyboard navigable and screen-reader legible per the project's UI layout standard, including the record list and the detail view.

## User-Facing Behavior

An operator opens Data → Canonical and picks Courtyard. A row of summary cards shows how many packs, catalog assets, EV inputs, pulls, sales, and estimated-EV records exist, with the oldest and newest collection times and any approximate count marked as such. Below, a paged table lists pack records by external ID with their revision numbers and timestamps. Typing a pack's external ID jumps straight to it. Selecting a row opens the record: its current canonical content, its hashes, when the provider reported it, when the pipeline collected it, when it was accepted, and what it points at. A link beside the provider name goes to that provider's configuration, its import runs, or its quarantine list.

## Interface Contract

- Consumes task 002's roster, summary, listing, and single-entity reads. It adds no queries of its own.
- Its route lives under `/data/canonical` as fixed by task 001, and its server routes carry task 001's permission.
- The URL state shape — provider, kind, search, cursor — is this task's own and is not depended on by other tasks.

## Acceptance Criteria

- [ ] Selecting a provider and kind lists that provider's records, and paging forward then backward returns to the same first page.
- [ ] An approximate count renders as approximate and an exact count renders without that qualification.
- [ ] Exact-ID lookup finds a known record, and a search matching nothing shows an empty state rather than an error.
- [ ] Opening a record shows its current content, revision number, hashes, timestamps, and declared relationships, all read-only.
- [ ] Reloading a deep link restores the same provider, kind, search, and page position.
- [ ] Loading, no-providers, no-records, no-matches, invalid-cursor, forbidden, and read-failed states each render distinctly, and a failed read leaves previously loaded results on screen.
- [ ] The provider cross-links reach the existing provider, import-run, and quarantine surfaces for the selected provider.

## Verification

Component and route tests drive provider and kind selection, forward and backward paging, exact-ID lookup, an empty search, and the record detail view, and assert each of the loading, empty, forbidden, and failure states renders its own treatment. The admin test suite, lint, and the workspace typecheck exit 0.
