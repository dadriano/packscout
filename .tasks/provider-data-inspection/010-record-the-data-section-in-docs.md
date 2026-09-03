# Task: Record the Data Section in the Canonical Docs

**ID:** provider-data-inspection/010
**Depends on:** provider-data-inspection/003, provider-data-inspection/005, provider-data-inspection/009
**Estimated scope:** small

## Objective

The repository's canonical documentation describes the Data section as it was actually built: what the three surfaces show, the permission that gates them, the read-only boundary, the server-to-server read path into the product backend, and which canonical kinds have no published counterpart.

## Context

This repository treats a specific set of documents as canonical and checks them in the verification gate: the architecture overview, the engineering rules, the framework standards and their adoption audit, the technical layout, the frontend and admin feature baselines, the UI layout standard, and the shift-left testing rules. The two data-model documents — the PostgreSQL model and the product backend's frontend data model — describe what each store holds and is authoritative for.

This feature changes facts those documents record. It adds a third admin sidebar section, a new named permission, a second server-to-server read path into the product backend alongside the product-user directory integration, and a comparison boundary that only holds for the publishable subset of the canonical model. A future contributor reading only the docs would not know any of that.

The comparison-scope rule is the most valuable thing to write down, because it is the one an outsider will get wrong: the product backend holds vendors, categories, repacks, collectibles, chases, and search rows; pulls, sales, EV inputs, estimated EV, and quarantine records are pipeline-only and have no published counterpart. Anyone extending the compare tool without knowing that will report the pipeline-only kinds as data loss.

## Requirements

- The architecture overview describes the Data section as an admin surface, names its three destinations, and states that it is read-only.
- The admin feature baseline records the new named permission alongside the existing vocabulary and the read-only boundary the section holds to.
- The documentation of the read path into the product backend records that the admin reaches published catalog data through an authenticated server-to-server surface, that no browser holds the backend secret, and that these reads mutate nothing — described in the same place the existing product-user directory integration is described.
- The comparison-scope rule is written down once, in the document that owns the data model boundary, naming which canonical kinds have published counterparts and which do not.
- Documentation states what was built. Anything a task deferred or dropped is recorded as deferred rather than described as present.
- No document introduces a copied product name or a stale application path — the repository's documentation check enforces both.

## User-Facing Behavior

None.

## Interface Contract

None. This task consumes the finished state of tasks 003, 005, and 009 and produces no runtime interface.

## Acceptance Criteria

- [ ] The architecture overview names the Data section, its three destinations, and its read-only boundary.
- [ ] The admin feature baseline records the new permission and the read-only boundary.
- [ ] The server-to-server read path into the product backend is documented beside the existing admin integration.
- [ ] The comparison-scope rule names both the publishable kinds and the pipeline-only kinds.
- [ ] Every documented behavior matches what shipped; deferrals are recorded as deferrals.

## Verification

The repository's documentation check and the full verification gate exit 0.
