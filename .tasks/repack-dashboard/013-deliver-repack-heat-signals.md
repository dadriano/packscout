# Task: Deliver Repack Heat Signals

**ID:** repack-dashboard/013
**Depends on:** repack-dashboard/003, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008
**Blocks:** repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including aggregate contracts, local simulation, UI integration, and evidence
**Status:** blocked

## Start Here

Create a public-safe heat aggregate that compares a repack's recent activity with its own baseline, then render deterministic simulated frames through the same Convex read path the real aggregate publisher will use.

## Objective

Help buyers notice meaningful short-term activity changes without presenting heat as EV, profitability, certainty, or a recommendation.

## Context

Heat is useful only when its basis is explicit. PackScout already separates vendor-reported EV, PackScout EV confidence, and desired-chase match confidence. Heat is a fourth, independent signal: a recent-versus-baseline activity summary built from post-processed pull, return, hit, chase, and pool observations. Raw provider events and proprietary model inputs remain outside Convex.

The real provider stream is not ready. Development therefore needs a deterministic local simulator that creates synthetic observations outside Convex, reduces them to the same bounded public aggregate, and publishes only aggregate frames into a development-only Convex boundary.

## Requirements

### Public Heat Contract

- Define exact `hot`, `warm`, `normal`, `cold`, and `insufficient_data` states.
- Include a bounded score and confidence only when enough evidence exists.
- Keep activity, realized return, large-hit rate, chase movement, and pool-composition components independently available or unavailable.
- Include recent and baseline windows, public driver codes, public limitation codes, observation time, and expiry time.
- Distinguish `observed` from `simulated` sources and require visible simulated labeling.
- Never expose raw provider records, user/wallet identity, proprietary inputs, or arbitrary text.

### Convex Aggregate Model

- Store heat separately from immutable data-release entities and hashes.
- Bind every heat aggregate to one data release and one repack with exact indexed lookups.
- Keep active heat reads bounded to the visible Dashboard or All Repacks rows.
- Reject malformed, cross-release, duplicate, expired, or mismatched aggregates without exposing internal diagnostics.
- Preserve the immutable data release while heat frames update independently.

### Local Stream Simulation

- Generate deterministic synthetic measurements from an explicit seed, frame, and start time outside Convex.
- Reduce synthetic measurements through the same pure heat calculator intended for normalized real observations.
- Publish only validated aggregate frames through an internal, environment-gated mutation.
- Restrict the command to explicit local/anonymous loopback Convex deployments and reject deploy keys, production, self-hosted, and canonical releases.
- Support one-shot verification and a stoppable interval loop without leaving enable flags or child processes behind.

### User Experience

- Show compact text-first heat state in Dashboard opportunities and All Repacks rows.
- Show a detailed Recent Heat section in the inspector with score, confidence, windows, drivers, limitations, and component changes.
- State that heat compares recent activity with the repack's own baseline and is not a profit or +EV signal.
- Keep unavailable and insufficient-data states explicit; never substitute zero.
- Use text and shape in addition to color, support both themes, preserve table overflow behavior, and remain usable on narrow screens and with reduced motion.

## Acceptance Criteria

### Contract and Data

- [x] Strict public schemas reject extra/raw/proprietary fields and inconsistent state, score, confidence, window, driver, or timestamp combinations.
- [x] Convex stores only bounded aggregate heat records linked to the active data release and repack.
- [x] Dashboard and All Repacks return heat arrays aligned exactly with their visible repack arrays.
- [x] Missing or invalid heat never makes otherwise valid repack data unavailable.

### Simulation

- [x] A deterministic local command publishes repeatable heat frames for every seeded mock repack.
- [x] One-shot replay is idempotent and interval mode cleans up its temporary enable flag after success, failure, or interruption.
- [x] Local tooling refuses cloud keys, non-loopback targets, canonical releases, and unsafe runtime environments.
- [x] Simulated frames exercise hot, warm, normal, cold, and insufficient-data states.

### UI and Accessibility

- [x] Overview opportunities and All Repacks show the correct compact heat state for each row.
- [x] The selected-repack inspector explains the heat state, source, confidence, windows, drivers, component changes, limitations, and expiry.
- [x] Simulated data is visibly labeled and heat is never described as EV, profit, or a recommendation.
- [x] Light/dark desktop and narrow-screen browser checks show no page overflow, inaccessible color-only state, console error, or hydration warning.

### Verification and Handoff

- [x] Contract, service, Convex, script, frontend, and framework tests pass.
- [x] `npm run verify:framework` passes without a new baseline or weakened rule.
- [ ] Real observed heat remains blocked until normalized live observations, publication ownership, and preproduction evidence exist.

## Build Status

- Locally implemented: the strict public contract, release-bound aggregate schema, deterministic recent-versus-baseline calculator, guarded one-shot/loop simulator, Convex read integration, fail-closed expiry, and text-first Dashboard/table/inspector presentation.
- Automated evidence: 50 contract tests, 148 service tests, 18 Convex tests, 125 frontend tests, and 19 local-script tests pass; the repository-wide `npm run verify:framework` gate also passes end to end without a new baseline or weakened rule.
- Simulation evidence: the one-shot command returned `created` and then `unchanged` on identical replay; interval playback published deterministic frames through frame 98 and the browser showed a frame change through the production read path.
- Shutdown evidence: Ctrl+C exited with status 0; active frame sequence 2 was materialized with `freshness=expired`; `PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED` was absent from Convex environment state; ports 3210, 3211, and 5196 had no listeners. The unrelated pre-existing listener on port 5100 (PID 9544) remained untouched.
- Browser evidence: light and dark checks at 1536×1024 and 1440×1000, plus light and dark checks at 390×844, verified compact states, inspector explanations, internal-only table scrolling, modal-sheet focus return, live frame replacement, and a fresh console with zero warnings or errors.
- Blocked for live completion: normalized real observations, production aggregate publication ownership, retention-policy evidence, and preproduction proof that observed heat is release-bound, expires fail-closed, and contains no raw provider events. The simulated aggregate must not be labeled live.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-005.
- Alignment: preserves the aggregate-only Convex boundary, bounded public reads, explicit unavailable states, responsive table/inspector patterns, and public-safe copy.
- Intentional extension: the approved heat capability extends the original V1 scope; this task is the canonical implementation record until companion heat specs are requested.
- Verification: focused suites pass with 50 contract, 148 service, 18 Convex, 125 frontend, and 19 local-script tests; deterministic one-shot/replay, loop-through-frame-98, fail-closed shutdown, both-theme desktop/mobile browser evidence, and the complete canonical framework verifier pass are recorded above. All real-observation and preproduction evidence remains open.
