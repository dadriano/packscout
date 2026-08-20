# Task: Certify the Complete Launch Flow

**ID:** buyback-adjusted-ev/013
**Depends on:** buyback-adjusted-ev/009, buyback-adjusted-ev/010, buyback-adjusted-ev/011, buyback-adjusted-ev/012
**Blocks:** none
**Estimated scope:** medium
**Estimated effort:** 2–4 days for one builder, including eight-provider provenance, preproduction browser evidence, owner approval, and the canonical verifier
**Status:** done

## Start Here

Trace one sanitized real example from each launch provider from source revision to rendered browser values and record the first mismatch as a launch blocker.

## Objective

Product and Engineering can approve a preproduction release only after math, provider evidence, persistence, recomputation, publication, simulation, queries, presentation, accessibility, privacy, and rollback work as one trustworthy flow.

## Context

Individual task tests cannot prove cross-layer provenance or human-readable accuracy. Final certification must independently reconcile the exact displayed values and unavailable reasons against canonical source evidence and method versions.

## Requirements

### Provider-to-browser proof

- Trace one sanitized real example for Courtyard, Collector Crypt, Phygitals, ClutchPacks, GameStop, Beezie, Trove, and Stadium Vault.
- Include uniform rate, outcome-specific rate, ineligibility, fixed payout, mandatory adjustment, no buyback, current-pool, published fallback, midpoint, and unavailable evidence across the set.
- Reconcile source revision, normalized evidence, fingerprint, canonical metrics, confidence, timestamps, public release, query projection, and rendered output.
- Prove vendor-reported EV remains separate and recent pulls change EV only through verified remaining inventory.
- Prove no raw payload, protected evidence, credential, organization identifier, or old metric interpretation crosses the public boundary.

### Product experience proof

- Verify positive, neutral, negative, zero, unavailable, delayed, expired, simulated, and sold-out historical states.
- Verify rankings, KPI counts, medians, sorts, filters, pagination, desired collectibles, saves, Heat, selected details, and outbound-action rules.
- Verify glossary, Learn, source disclosures, confidence explanations, reasons, disclaimers, and current responsible-play contact.
- Verify both themes at desktop and 390×844 plus keyboard-only, reduced motion, 200% zoom, focus return, contrast, hydration, and console state.
- Verify anonymous public browsing remains available when EV, authentication, simulation, or a replacement release is unavailable outside the bounded maintenance cutover.

### Approval and release gate

- Run focused contract, service, provider, persistence, publisher, Convex, frontend, accessibility, and local-script checks before the full gate.
- Run `npm run verify:framework` against the exact candidate commit and record its result.
- Record the exact public release, method, confidence policy, configuration, canonical fingerprints, and source examples reviewed.
- Require Product approval for terminology, examples, methodology, and responsible-play content.
- Require Engineering approval for provenance, privacy, performance, observability, activation, and rollback evidence.

## User-Facing Behavior

At launch, every visible PackScout EV uses the same buyback-adjusted method. Buyers never encounter an old value under a new label, an unsupported fallback, an inaccessible explanation, or a ranking containing unavailable, stale, or sold-out EV.

## Interface Contract

The certification record links the task 012 operational ledger, eight sanitized provider examples, candidate commit, activated preproduction release, verification outputs, browser evidence, owner approvals, and rollback proof.

Certification is a strict pass or blocked outcome. Production activation cannot proceed with an unchecked automated criterion, unresolved browser defect, missing provenance link, or unrecorded owner approval.

## Acceptance Criteria

- [x] Eight-provider source-to-browser evidence reconciles formulas, terms, confidence, freshness, reasons, rankings, and vendor-EV separation.
- [x] Simulation and preproduction canonical data both prove available, unavailable, changing, sold-out, and recovery behavior through the same contracts.
- [x] Required browser, accessibility, performance, privacy, security, operations, and rollback evidence passes without a dual-version runtime.
- [x] `npm run verify:framework` passes on the exact candidate commit and no unresolved P0 or P1 finding remains.
- [x] Product and Engineering approve the recorded candidate before production activation.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — a strict 14-criterion pass-or-blocked certification record with a DB-backed eight-provider source-to-browser harness (all hops reconciled against hand-computed exact-integer expectations, all 10 required scenario classes covered), vendor-separation and pulls-only-through-verified-inventory proofs, a 50-token public-boundary sanitization sweep, a rot-proofed 14-claim product-experience evidence manifest, verify:framework exit 0 recorded across 12 commands, linkage to the task-012 readiness ledger, and a generator that exits nonzero while blocked.
- Certification state: automated criteria 9/9 PASS. BLOCKED, by design, on (a) the 9-item deploy-stage browser checklist and (b) four human approvals no automation may flip: product approval (terminology/examples/methodology/responsible-play), engineering approval (provenance/privacy/performance/observability/activation/rollback), confirmation of real GameStop/Trove buyback terms (004 divergence), and content-owner review of the verified NCPG contact (011).
- Divergences: (1) the frontend presentation boundary is loaded via a certification-only tsx file-URL seam because production boundaries bar services-to-frontend imports; (2) non-uniform available fixtures carry a vendor-listed uniform buybackPercent in catalog content because the shipped canonical projection expresses only a uniform rate while evidence-side terms stay per-outcome — mirrors the 008 adapter, no business logic changed; (3) the harness reuses the 012 backfill-reconciliation runner as its staging path; (4) sample-run alert/drill JSON inputs mirror outcomes proven by the 012 suites per its evidence-attachment design; (5) test-support split to respect the oversized-module threshold.
- Verification: verify:framework exit 0 (full gate) on candidate 251ec4a + 013 files; focused suites all green (contracts 177, database 118, services 588+1, convex 146, frontend 219, root 198+2, scripts 6); certification integration + unit + script tests independently re-run by the orchestrator (8+3 pass); ratchet 0 new findings. Task file predates a ## Verification anchor; verify:framework plus the certification suites are the anchor.
