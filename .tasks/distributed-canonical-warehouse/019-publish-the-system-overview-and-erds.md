# Task: Publish the System Overview and ERDs

**ID:** distributed-canonical-warehouse/019
**Depends on:** distributed-canonical-warehouse/006, distributed-canonical-warehouse/015, distributed-canonical-warehouse/016, distributed-canonical-warehouse/018
**Blocks:** distributed-canonical-warehouse/020
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including diagram synchronization, interactive visual QA, and publication review
**Status:** not started

## Start Here

Create a one-page ownership hierarchy for `packscout`, `packscout_<provider_key>`, and Convex, then compare every existing ERD table and relationship against that hierarchy before editing documentation.

## Objective

Publish a concise system overview and accurate interactive ERDs that make the clean distributed warehouse easy to understand, navigate, and verify.

## Context

The existing ERD explorer still contains legacy platform terminology, central stream controls, provider-local streams, and older physical database separation. The approved architecture combines central control and catalog in `packscout`, combines provider canonical and runtime data in each `packscout_<provider_key>`, and uses one mixed provider run.

The viewer must also correct prior usability problems: inconsistent diagram sizing, low-contrast text, black-on-black cells, wasted viewport space, and fixed navigation. The local artifact and the published visualization must describe the same reviewed model.

## Requirements

### System documentation

- Document the physical database hierarchy, authoritative owners, soft references, transaction boundaries, allowed failure directions, and independent scale boundaries.
- Include a canonical provider glossary and remove internal `platform`, `site`, stream, and product-normalization terminology from the new model.
- Document central admin and provider registry, shared catalog and correlation, provider canonical data, provider runtime and mixed runs, publication, manifest activation, and frontend reads.
- Include concise sequences for page commit, asynchronous correlation, admin direct control, catalog publication, provider release, manifest activation, retry, and unreachable-provider behavior.
- State the deferred source adapters, raw staging, Heat, product normalization, catalog-governance UI, migration, cutover, dual path, and production activation work explicitly.

### ERD correctness

- Visibly separate the central `packscout` model, the reusable provider-database model, and the Convex read model.
- Show provider-local category, pack, collectible, instance, content, account, pull, pull-item, market-event, promotion, runtime, run, command, quarantine, retention, and audit relationships.
- Show central organization, admin, provider, configuration, credential, database-node, test, observation, alert, global category, global collectible, correlation, suggestion, alias, catalog-version, and checkpoint relationships.
- Show immutable catalog versions, provider releases, the one manifest with per-provider entries, public artifacts, aliases, and saved-item logical references in Convex.
- Render cross-database relationships as labelled soft references distinct from database-enforced foreign keys.

### Interactive viewer

- Make the viewer use the maximum available width and height while preserving readable controls and responsive layout.
- Provide pan, zoom, fit, reset, and resize behavior so users can navigate every diagram without clipping.
- Use consistent entity sizing, legible typography, and comparable default scale across diagrams rather than mixing tiny and oversized ERDs.
- Fix light and dark theme contrast so no white-on-light-gray, black-on-black, or low-contrast table cell remains.
- Keep search, diagram filtering, keyboard navigation, visible focus, legends, and an accessible text relationship hierarchy.

### Data dictionary and publication

- Record key enums, lifecycle states, checks, uniqueness, indexes, immutable tables, timestamps, row versions, retention, pseudonymization, and public alias behavior.
- Name the one provider run, one cursor, one schedule, and one import worker authority; show no per-data-kind stream tables or controls.
- Explain how `updated_at`, `row_version`, promotion changes, independent consumer checkpoints, immutable releases, and manifest receipts relate.
- Verify every diagram against the implemented schema and public contracts before publishing the updated artifact.
- Update the existing visualization publication only after the reviewed local artifact passes content, accessibility, viewport, and contrast checks.

## User-Facing Behavior

A reader opens the ERD explorer and immediately sees the three physical ownership areas and a succinct relationship hierarchy. The diagram fills the available window, can be resized, panned, zoomed, fitted, searched, and navigated by keyboard, and remains readable in light and dark themes.

## Interface Contract

Canonical Markdown documentation and the HTML explorer use the same database names, table names, relationship labels, lifecycle vocabulary, and non-goals. Each cross-database edge states source authority, target identity, reconciliation owner, and failure behavior.

The published artifact is derived from the reviewed local artifact without injecting instructions or weakening its sandbox, iframe isolation, or content-security policy.

## Acceptance Criteria

### Documentation acceptance

- [ ] System overview, data dictionary, sequences, PostgreSQL ownership, Convex manifest, and HTML ERDs describe one consistent architecture.
- [ ] Central, provider, and Convex table inventories match the implemented schemas and contracts.
- [ ] Soft references and transaction boundaries are visibly distinct from foreign keys and local transactions.
- [ ] Provider terminology is canonical, and no stream-control or product-normalization model remains in the new diagrams.
- [ ] Every deferred area is named without adding migration or production instructions.

### Viewer acceptance

- [ ] Every diagram opens at a comparable readable scale and uses the maximum available viewer width and height.
- [ ] Pan, zoom, fit, reset, resize, search, filter, and keyboard navigation work without clipping or trapping focus.
- [ ] Automated and visual checks find no low-contrast, white-on-light, black-on-black, or unreadably small text state.
- [ ] The accessible text hierarchy and legends communicate the same relationships without relying on the visual canvas.
- [ ] The reviewed local and published artifacts match and preserve sandbox and content-security protections.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Documentation and diagrams are generated from the verified central, provider, and Convex schemas rather than the historical ERD.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
