# Task: Teach the EV Methodology and Limitations

**ID:** buyback-adjusted-ev/011
**Depends on:** buyback-adjusted-ev/010
**Blocks:** buyback-adjusted-ev/013
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including glossary, Learn content, responsible-play review, and content verification
**Status:** done

## Start Here

Write the shared `$100 stated Outcome EV × 85% buyback = $85 Gross EV` explanation and its positive, neutral, negative, and unavailable companion examples.

## Objective

Buyers can understand what PackScout Gross EV means, how buyback changes it, why it can be unavailable, what confidence measures, and which economic factors PackScout does not model.

## Context

The methodology uses platform-provided price, odds, inventory, value, and buyback data. PackScout does not independently value collectibles at launch, and recent pulls do not predict the next pack. Education must use the same terminology and rendered examples as the comparison UI.

## Requirements

### Formula education

- Explain Underlying Outcome EV as protected intermediate stated value and Gross EV as expected guaranteed buyback payout.
- Explain Gross EV %, signed EV $, signed EV %, Pack Price, and the 100% break-even point distinctly.
- Include exact positive, neutral, negative, valid-zero, unavailable, and `$100 / 85%` worked examples through shared presentation behavior.
- Explain uniform versus outcome-specific terms, ineligibility, fixed offers, fees, caps, floors, and no double-discounting; show Buyback % only for a uniform rate.
- State that EV is a long-run expectation and never guarantees one opening.

### Evidence and limitations

- Explain current remaining-inventory odds priority, published-odds fallback, material conflict, complete-coverage requirements, and non-atomic rejection.
- Explain exact values, midpoint limitations, stale evidence, confidence penalties, and why missing essential evidence is unavailable rather than low confidence.
- Explain that recent pulls affect EV only through deterministic remaining inventory and that hot or cold streaks do not estimate future odds.
- Explain vendor-reported EV as a separate source that never fills or changes PackScout EV.
- Explain excluded liquidity, shipping, resale fees, taxes, personalized prices, unsupported FX, and independent market valuation.

### Trust and responsible play

- Label platform-derived claims and observation times without overstating verification or independence.
- State that confidence measures evidence reliability, not the likelihood of profit.
- Use `Not financial or gambling advice` anywhere the compact methodology promise appears.
- Verify and use the current official National Council on Problem Gambling call, text, and help-link information at release time.
- Keep the official contact review as a release check so a stale document number is never treated as permanent source truth.

## User-Facing Behavior

Glossary and Learn use the same words, numbers, states, and reasons as the catalog. A reader can tell why a Gross EV % of 85% is 15% below break-even and why no-buyback evidence means unavailable rather than 100% or zero by assumption.

## Interface Contract

Education consumes the task 010 presentation examples and bounded public limitation vocabulary. It does not duplicate formulas in separately maintained hard-coded numbers.

The content registry exposes one canonical definition for every EV term and one approved responsible-play resource block for all Learn and glossary surfaces.

## Acceptance Criteria

- [x] Glossary and Learn accurately explain all four metrics, buyback application, break-even, evidence priority, confidence, freshness, and unavailable behavior.
- [x] Positive, neutral, negative, zero, unavailable, and `$100 / 85%` examples match the shared presentation values exactly.
- [x] Platform provenance, vendor-EV separation, non-predictive pulls, excluded costs, and model non-goals are explicit.
- [x] Responsible-play and disclaimer copy use the verified current official resource and pass content-owner review.
- [x] Content tests prevent terminology, example, reason, link, and accessible-help drift across public surfaces.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — Learn/glossary rewritten to the buyback-adjusted method with a canonical example registry whose six worked examples (positive, neutral, negative, valid-zero, unavailable, $100 x 85% = $85) are contract-parsed estimates rendered through the shared task-010 presentation boundary (no typed final numbers); evidence priority, confidence/freshness/unavailable semantics, vendor separation, non-predictive pulls, and excluded costs all taught with drift-prevention tests (definition identity between glossary and Learn, verbatim limitation vocabulary, pinned example strings).
- Divergences: (1) the no-recalculation source guard now allowlists the example registry as a second approved raw-numerics constructor (contract-parsed, boundary-rendered — invariant unchanged); (2) responsible-play contact is 1-800-MY-RESET / 1800myreset.org verified 2026-08-19 against official NCPG pages — the methodology docx's 1-800-522-4700 and the older 1-800-GAMBLER are stale (NCPG lost 1-800-GAMBLER by court order 2025-09-29); sources and verification date recorded in lib/responsible-play.ts and its release-check test; (3) corrected the what-is-a-repack Buyback % paragraph and a method point that contradicted the fail-closed policy; removed the stale hard-coded $108 example.
- OPEN FOR RELEASE GATE: content-owner review of terminology, examples, and the responsible-play block is a human sign-off recorded at task 013 — not self-certified here.
- Verification: npm run test:frontend (219 pass), typecheck:frontend, root typecheck, lint:frontend, ratchet 0 new findings, plus a live dev-server smoke of all four Learn routes at desktop and 375px — frontend suite and ratchet independently re-run by the orchestrator. Task file predates a ## Verification anchor; the frontend suite is the fallback anchor.
