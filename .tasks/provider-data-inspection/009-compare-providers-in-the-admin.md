# Task: Compare Providers in the Admin

**ID:** provider-data-inspection/009
**Depends on:** provider-data-inspection/001, provider-data-inspection/006, provider-data-inspection/007, provider-data-inspection/008
**Estimated scope:** large

## Objective

The Compare destination shows every provider's canonical-versus-published state in one table, lets an operator drill into a suspect provider to see the numbers behind its verdict, run a reconciliation to name the specific records involved, and open any one of them to see exactly which fields differ — all read-only, with remediation handed off to the surfaces that already own it.

## Context

This is the surface the whole feature exists for. Tasks 006, 007, and 008 supply three escalating levels of answer, and this page is where an operator walks down them:

1. **Overview** — every provider, one verdict each, cheap enough to open any time.
2. **Provider detail** — the counts, checkpoints, fingerprints, and timestamps the verdict rests on, plus what is out of comparison scope.
3. **Reconciliation and diff** — which specific public IDs diverge, and for any one of them, which fields differ.

Two things about this page are load-bearing:

**It must not overstate.** A reconciliation walk is bounded and resumable; a partial result must read as partial, a capped divergence list must say how many were found beyond the cap, and a walk invalidated by a promotion must say so rather than showing stale rows. An operator using this page to decide whether a provider is safe will be misled by any of those rendered optimistically.

**It stays read-only.** Nothing here republishes, retries, retires, or re-promotes. Where an operator needs to act, the page links to the existing surfaces that own the action — the provider's configuration and health, its import runs, and the background-work and promotion surfaces. That keeps this feature free of new mutations, new audit obligations, and new failure modes.

The out-of-comparison-scope rule from task 006 must be visible, not buried: pulls, sales, EV inputs, estimated EV, and quarantine records have no published counterpart, and an operator must not read their absence as loss.

## Requirements

- An all-providers overview table: one row per configured provider showing its verdict (`in_sync`, `behind`, `drifted`, `unpublished`, `unknown`), a plain-language reason, canonical and published counts, and `dataAsOf` on both sides. Rows are sortable or groupable so problem providers surface without hunting.
- A provider detail view showing the full evidence behind the verdict: canonical counts per publishable kind against published counts per entity kind, checkpoints on both sides, fingerprints on both sides, `dataAsOf` on both sides, and the named list of out-of-scope kinds.
- A control that starts a reconciliation walk for a provider and entity kind, showing live progress — how much of each side has been examined — and whether the result so far is partial or complete.
- Divergence lists rendered per category: canonical-only, published-only, and canonical-without-a-public-identity, each showing the identifiers and each stating how many were found beyond the display cap.
- Opening any divergent record shows the field-level diff between the projected canonical record and the published document, including the release it was compared against, and renders each of the four non-diff outcomes with its own wording.
- A partial reconciliation is unmistakably labelled partial wherever its results appear, including in any summary count. A walk invalidated by a new release states that, names the release that replaced the pinned one, and offers to start again rather than showing stale results as current.
- Requesting reconciliation for an out-of-scope kind is not offered; if reached anyway, it explains why the kind has no published counterpart.
- Cross-links per provider to its existing admin surfaces — provider configuration and health, import runs, quarantine, and the background-work and promotion views — so remediation continues where it already lives. No control on this page mutates anything.
- Honest degradation: with the product backend unreachable, the overview still renders the canonical side and marks every published side unknown, stating the cause once rather than per row. Prior safe results stay visible when a refresh fails.
- Every state is represented: loading, no providers configured, walk not yet run, walk running, walk partial, walk complete, walk invalidated, capped results, out-of-scope kind, permission withdrawn mid-session, and each side unreadable.
- Deep-linkable state: selected provider and entity kind live in the URL. A reconciliation cursor is transient and is not restored from a link, because a resumed walk's pinned release may no longer be current.
- The page uses the admin's existing shell, tokens, tables, and empty states, declares no palette values in feature styles, and meets the project's UI layout standard for keyboard and screen-reader use — including announcing walk progress and completion to assistive technology.

## User-Facing Behavior

An operator opens Data → Compare and sees four rows. Three read "In sync" with matching fingerprints. Courtyard reads "Drifted — published fingerprint does not match the last completed promotion." Opening Courtyard shows canonical counts beside published counts, both checkpoints, both fingerprints, both timestamps, and a note that pulls, sales, and EV inputs are pipeline-only. The operator starts a reconciliation on repacks; progress climbs, and the result lists 812 public IDs present canonically but not published, capped at the first 200 with the remaining count stated. Opening one shows the projected canonical record beside the published document with the two differing fields highlighted and the release ID it compared against. A link beside the provider goes to its import runs, where the operator can see the run that stalled.

## Interface Contract

- Consumes task 006 for the overview and provider detail, task 007 for the reconciliation walk and its progress, and task 008 for the record diff. It computes no verdicts, classifications, or diffs of its own.
- Verdict values, reason codes, the four non-diff outcomes, and the reconciliation categories are the closed sets defined by tasks 006, 007, and 008. This task maps them to wording and does not extend them.
- Its route lives under `/data/compare` as fixed by task 001, and its server routes carry task 001's permission.
- Provider identity is `platform_key` throughout, matching the Canonical and Published surfaces.

## Acceptance Criteria

- [ ] The overview renders one row per provider with its verdict, reason, both sides' counts, and both `dataAsOf` values.
- [ ] Provider detail shows counts, checkpoints, fingerprints, and timestamps for both sides plus the named out-of-scope kinds.
- [ ] Starting a reconciliation shows progress, and its results render in the four categories with per-category beyond-cap counts.
- [ ] A partial walk is labelled partial everywhere its results appear, including in summary counts.
- [ ] A walk invalidated by a new release states that, names the replacing release, and does not present its stale rows as current.
- [ ] Opening a divergent record shows the field diff and the compared release ID, and each of the four non-diff outcomes renders with its own wording.
- [ ] With the product backend unreachable, the canonical side still renders, published reads unknown, and the cause is stated once.
- [ ] No control on the page mutates anything, and the per-provider cross-links reach the existing provider, run, quarantine, and background-work surfaces.
- [ ] Every listed state renders its own distinct treatment, and walk progress and completion are announced to assistive technology.

## Verification

Component and route tests drive the overview, a provider drill-down, a reconciliation from start through partial to complete, an invalidated walk, a capped divergence list, and a record diff, asserting that partial results are labelled partial, capped lists state their beyond-cap counts, the invalidated walk refuses to show stale rows as current, and the backend-unreachable case still renders the canonical side. A test asserts the page issues no mutating request. The admin test suite, lint, and the workspace typecheck exit 0.
