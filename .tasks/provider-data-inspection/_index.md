# Feature: Provider Data Inspection

## Start Here

Open `provider-data-inspection/001` and add the read-only data-inspection permission plus the "Data" sidebar section with its three destination shells. It unblocks all three UI tasks and is a session's work.

**Progress:** 2/10 tasks complete

## Context

PackScout's pipeline lands canonical records in PostgreSQL and promotes a published subset of them, per provider, into the product backend (Convex). Today an operator can see the *machinery* — provider configuration, import runs, quarantine, background work, workers, alerts — but not the *data*. There is no way to ask "what did Courtyard actually land?", "what is the product actually serving for Courtyard?", or "do those two agree?" without a database client and a Convex dashboard.

This feature adds a third admin sidebar section, **Data**, with three read-only surfaces:

- **Canonical** — what PostgreSQL holds per provider: per-kind counts and freshness, a paged record list, and one record's current canonical content.
- **Published** — what the product backend serves per provider: which catalog release the active manifest selects, its lifecycle, fingerprint, hashes and counts, paged entity listings, and one published document.
- **Compare** — every provider's canonical-versus-published state in one table, with a drill-down into the evidence, a bounded reconciliation that names the specific diverging records, and a field-level diff of any one of them.

### Resolved decisions

- **The admin console hosts it**, not the local operations panel. Promotion drift matters in production, and the ops panel is structurally loopback-only.
- **Browse depth is record detail**, not raw stored payloads: current canonical content and published documents, with provenance summarized and credential-shaped values redacted.
- **Compare escalates in three steps**: a cheap fingerprint-and-count verdict, then identity reconciliation naming the diverging public IDs, then a field-level diff on demand. A record-by-record sweep of the roughly 14.5-million-record baseline is never run to answer "is this provider off?".
- **Read-only throughout.** No task adds a mutation. Where drift needs fixing, the surfaces deep-link to the provider, import-run, quarantine, and background-work views that already own remediation.

### Two rules that govern the whole feature

**Comparison scope.** The product backend holds only the publishable subset — vendors, categories, repacks, collectibles, chases, search rows. The canonical kinds `pull`, `market_event`, `ev_input`, and `estimated_ev`, plus quarantine records, are pipeline-only and have no published counterpart. They are reported as out of scope, never as missing.

**Never overstate.** Counts that cannot be exact at production scale are labelled approximate. A bounded reconciliation walk that has not finished is labelled partial in its own payload. A capped divergence list states how many were found beyond the cap. A walk straddling a promotion is invalidated rather than mixed. An unread side reads "unknown", never zero.

## Tasks

### Foundation

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 001 | Open the Data section to operators | small | done | none |

### Canonical side (PostgreSQL)

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 002 | Read canonical provider data from PostgreSQL | medium | done | none |
| 003 | Browse canonical provider data in the admin | medium | todo | 001, 002 |

### Published side (product backend)

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 004 | Expose published provider catalog reads from the product backend | medium | todo | none |
| 005 | Browse published provider data in the admin | medium | todo | 001, 004 |

### Compare

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 006 | Judge published-versus-canonical parity per provider | medium | todo | 002, 004 |
| 007 | Reconcile record identities across the boundary | large | todo | 006 |
| 008 | Diff one record across the boundary | medium | todo | 002, 004 |
| 009 | Compare providers in the admin | large | todo | 001, 006, 007, 008 |

### Close-out

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 010 | Record the Data section in the canonical docs | small | todo | 003, 005, 009 |

## Build Order

1. **Start three tasks in parallel — they share no edges.** 001 (permission and nav shell), 002 (canonical reads), 004 (published reads from the product backend).
2. **When 001 and 002 are both in, start 003** (the Canonical page).
3. **When 001 and 004 are both in, start 005** (the Published page). It can run alongside 003.
4. **When 002 and 004 are both in, start 006 and 008 in parallel.** 006 is the cheap parity verdict; 008 is the record diff. Neither waits on the other.
5. **When 006 is in, start 007** (the reconciliation walk). It is the largest task in the feature — budget a full session for the exactly-once resume and release-pinning behavior alone.
6. **When 001, 006, 007, and 008 are all in, build 009** (the Compare page).
7. **When 003, 005, and 009 have all landed, do 010** (docs) and run the full verification gate.

Two independent tracks run side by side after step 1: the canonical track (002 → 003) and the published track (004 → 005). The compare track joins them and cannot start until both foundations exist.

## Parallel Groups

- Group A (no deps): 001, 002, 004
- Group B (after A): 003 (needs 001+002), 005 (needs 001+004), 006 (needs 002+004), 008 (needs 002+004)
- Group C (after B): 007 (needs 006)
- Group D (after C): 009 (needs 001+006+007+008)
- Group E (after D): 010 (needs 003+005+009)

## Out of Scope

- Any mutation from these surfaces: republishing, re-promoting, retrying, retiring a release, or editing a record. Remediation stays with the provider, import-run, and background-work surfaces that already own it.
- A SQL runner, a caller-supplied filter or sort expression, or a schema browser. Filters are a fixed enumerated set.
- Raw provider payload envelopes and unredacted provenance. Provenance is summarized; credential-shaped values are stripped.
- A scheduled or continuous full-content sweep across all providers. Reconciliation is operator-initiated, bounded, and resumable.
- Comparing the pipeline-only kinds (`pull`, `market_event`, `ev_input`, `estimated_ev`, quarantine) — they have no published counterpart.
- Repack heat snapshots and signals, saved items, product users, and the beta allowlist. This feature covers provider catalog data only.
- Exposing these reads in the local operations panel, or to any browser client other than the authenticated admin.
- Historical revision browsing beyond a record's current revision.
