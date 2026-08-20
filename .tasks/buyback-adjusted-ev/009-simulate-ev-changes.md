# Task: Simulate Production-Faithful EV Changes

**ID:** buyback-adjusted-ev/009
**Depends on:** buyback-adjusted-ev/006, buyback-adjusted-ev/008
**Blocks:** buyback-adjusted-ev/010, buyback-adjusted-ev/013
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including full-path deterministic scenarios, local guards, replay, and cleanup verification
**Status:** done

## Start Here

Generate the `$100 / 85%` example and one state transition from a sanitized provider-like source revision through normalization, calculation, persistence, recomputation, and publication.

## Objective

Local development can demonstrate realistic buyback-adjusted EV values and transitions while real integration is pending, using the same normalized evidence, calculator, confidence, revision, recomputation, publication, and public-read boundaries as production.

## Context

Hard-coded public metrics drift from business logic and direct calculator fixtures bypass lifecycle risks. Simulation creates bounded synthetic source revisions in memory, drives the complete post-ingestion production path, and stores only canonical revisions plus sanitized local aggregate releases.

## Requirements

### Scenario coverage

- Cover positive, neutral, negative, valid zero-payout, unavailable, delayed, expired, and sold-out historical states.
- Cover uniform and outcome-specific buyback, fixed payout, ineligibility, range midpoint, published odds, and current-pool odds.
- Cover price, buyback, value, pull-driven remaining inventory, restock, and source-age transitions.
- Cover per-pack, per-draw, supported stablecoin parity, no-buyback, odds conflict, and incomplete evidence.
- Make at least two repacks visibly transition between successive frames without changing event time into the future.

### Determinism and provenance

- Derive each frame directly from explicit seed, scenario version, start time, frame index, and clock controls.
- Produce byte-equivalent source revision, normalized evidence, fingerprint, canonical revision, calculation output, confidence, and public hash for identical controls.
- Label every public simulation result and release as simulated without exposing synthetic observation arrays.
- Reuse the exact provider normalization, calculator, confidence, persistence, recomputation, publisher, query, and public schemas with no simulation-only business branch.
- Keep synthetic raw observations ephemeral and persist only the same canonical protected revisions and sanitized aggregate data permitted in the real path.

### Local safety

- Require explicit local-only enablement, loopback services, mock active release, and exact supported protocol versions before writes.
- Refuse cloud, canonical release, unknown product, sequence gap, replay conflict, malformed hash, and disabled-state mutation.
- Make one-shot the default and loop playback explicit, bounded, stoppable, and replayable.
- Clean temporary enablement on success, failure, and interruption without touching catalog freshness or unrelated processes.
- Document the resolved seed, times, run identity, frame, release, and cleanup state for reproduction.

## User-Facing Behavior

Developers and reviewers can watch representative EV states update locally. Simulated provenance is always visible, and no simulated value can be mistaken for canonical provider data.

## Interface Contract

The simulator creates bounded sanitized provider-like revisions, passes them through tasks 004, 002, 003, 005, 006, and 008, then reads the exact task 007 public result from the local aggregate release.

It has no production scheduler, cloud deployment option, provider credential access, or raw-event persistence path.

## Acceptance Criteria

- [x] Identical controls replay byte-equivalent frames while seed, frame, clock, price, pool, or buyback changes produce the expected new result.
- [x] Every approved available, unavailable, confidence, freshness, sold-out, and transition state passes the production contracts.
- [x] Simulated inputs traverse normalization, calculation, confidence, persistence, recomputation, publication, and queries; no hard-coded final metric can drift from the formula.
- [x] Local, cloud, canonical-release, sequence, hash, lifecycle, interruption, and cleanup guards have behavioral tests.
- [x] Raw synthetic observations never enter public results, Convex aggregate storage, logs, or telemetry.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — 13 versioned scenarios minting synthetic source revisions in the exact typed shapes of five real provider modules, driven through the unmodified production path (004 -> 002/003 via 006 -> 005 -> 008) with byte-equivalent replay under explicit seed/frame/clock controls, independent-recompute proof that no public metric is hard-coded, simulated labeling inside existing task-007 fields (5eeded UUID namespace, [Simulated] naming, fingerprint-tied run identity), loopback-only write guards with temporary-key cleanup on success/failure/interruption, and a bounded stoppable loop mode.
- Divergences: (1) no package.json script alias — invocation documented in the script header (write scope); (2) test:convex not run — zero Convex files touched; heat-unavailable-on-v3 pinned at the view layer and live read-back; (3) canonical revisions persist to an in-memory adapter behind the real task-005 store for per-run lifetime — the persistence port is the sanctioned seam and the durable local artifact is the sanitized aggregate release; (4) scenario-map updates recorded here rather than in scenario files (write scope).
- Verification: 34 focused tests (21 services + 13 script), services suite 563+1, root tests 192+2, root typecheck, lint, ratchet 0 new findings, check:framework — orchestrator re-ran focused suites and ratchet independently. Task file predates a ## Verification anchor; the focused suites are the fallback anchor.
