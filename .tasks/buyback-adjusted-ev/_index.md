# Feature: Buyback-Adjusted PackScout EV

## Start Here

Open `buyback-adjusted-ev/001`, encode the approved formulas and fail-closed evidence rules as one versioned calculation contract, and finish with the `$100 outcome EV / 85% buyback / $100 price` example producing `$85`, `85%`, `-$15`, and `-15%`.

**Progress:** 5/13 tasks complete

## Context

PackScout currently calculates Gross EV before buyback by weighting platform-provided value buckets, then compares that value with Pack Price. The approved PackScout Methodology changes the economic meaning of Gross EV: it is now the probability-weighted final guaranteed buyback payout. A platform-wide rate may be applied only when the platform documents that it governs every eligible outcome; exact outcome-specific terms take priority.

This is a clean pre-launch replacement, not a compatibility migration. Existing pre-buyback results remain identifiable as historical calculations under their original method version, but no new public release may present them under the buyback-adjusted labels. The calculator, persistence model, publisher, Convex release, rankings, public UI, glossary, Learn content, tests, and methodology disclosures move together.

## Source Authority

1. This feature PRD and its numbered tasks govern the approved buyback-adjusted behavior.
2. `PackScout_Methodology.docx` supplies the business definitions, platform-data limitations, and responsible-play intent.
3. `repack-dashboard/005` and the Repack Dashboard V1 index remain historical context; this feature supersedes their pre-buyback Gross EV formulas.
4. Repository framework, engineering, BDD, accessibility, and Convex standards govern implementation and verification.

## Resolved Decisions

### Metric model

- `Underlying Outcome EV = sum(probability × supported stated value) × the approved draw multiplier` and remains protected calculation evidence.
- `Gross EV $ = sum(probability × final guaranteed buyback payout) × the approved draw multiplier`.
- `Gross EV % = Gross EV $ ÷ Pack Price × 100`.
- `EV $ = Gross EV $ − Pack Price`.
- `EV % = Gross EV % − 100 percentage points`.

### Buyback policy

- No documented buyback makes PackScout Gross EV unavailable; PackScout never assumes a 100% rate.
- Exact outcome-specific terms take priority; a product-wide rate is valid only when documented as uniform.
- An explicitly ineligible outcome contributes zero buyback payout; unknown eligibility makes the estimate unavailable.
- Mandatory fees, caps, floors, and fixed offers follow the approved payout order and are reflected in the final guaranteed payout.
- A source value already expressed as final buyback payout is not discounted again.

### Odds and value evidence

- Complete current remaining-inventory odds take priority for a finite pool.
- Complete current platform-published odds are the fallback.
- Material odds conflict, partial probability coverage, or a non-atomic observation makes the estimate unavailable.
- Exact stated values are preferred; a closed platform range uses its midpoint with a confidence limitation.
- Missing, inverted, or open-ended ranges make the estimate unavailable.

### Price, currency, and pulls

- Pack Price is the current public listed price before personalized, membership, or promo discounts.
- A universally applied discount qualifies only when it is already reflected in the public listing price.
- Calculations normalize canonical USD or an approved USD-equivalent stablecoin at documented parity to rational USD cents before weighting; mixed unnormalized money and live FX are unavailable.
- Recent pulls affect EV only when they deterministically update verified remaining inventory.
- Recent realized hit frequency never estimates future odds or PackScout Gross EV.

### Availability and confidence

- Complete price, currency, probability, value, eligibility, buyback, draw, provenance, and observation evidence is required.
- Essential missing evidence produces unavailable, never a partial or normalized estimate.
- Available estimates start at 10,000 confidence basis points and use only the approved penalties.
- Confidence bands are Low `0–4,999`, Medium `5,000–7,999`, and High `8,000–10,000`.
- Confidence describes evidence reliability and freshness, not return, profitability, or certainty.

### Freshness and lifecycle

- Evidence age uses the oldest essential source observation, and evidence at most 15 minutes old has no freshness penalty.
- Evidence over 15 and at most 30 minutes old receives a 1,000-point confidence penalty.
- Evidence over 30 and at most 60 minutes old receives a 2,500-point confidence penalty.
- Evidence older than 60 minutes makes an active PackScout EV unavailable and excludes the repack from EV rankings.
- A sold-out repack freezes the last estimate that was valid at sellout as an explicit historical state with its original confidence; it never ranks or exposes an outbound action.

## Confidence Policy V1

An available estimate starts at 10,000 basis points. Penalties are additive and the score is bounded at zero.

| Evidence condition | Penalty | Public limitation |
|---|---:|---|
| Complete platform-published odds used because verified current-pool odds are unavailable | 1,500 | Published odds used |
| At least one supported outcome uses a closed-range midpoint | 2,000 | Midpoint value ranges used |
| Source age is over 15 and at most 30 minutes | 1,000 | Source data delayed |
| Source age is over 30 and at most 60 minutes | 2,500 | Source data delayed |

No other V1 penalty is permitted. Missing essential evidence does not reduce confidence; it makes the estimate unavailable.

## User Promise

- Buyers see Gross EV $, Gross EV %, EV $, and EV % together.
- Default opportunity ranking uses signed buyback-adjusted EV $.
- PackScout identifies the estimate as calculated from platform-provided data.
- Platform-reported EV remains separate and never substitutes for a PackScout calculation.
- Every unavailable estimate has a stable public reason, source age when known, an explicit unknown-time state otherwise, and recovery-safe presentation.

## Out of Scope

### Calculation scope

- Independent collectible valuations, external sales comps, or proprietary valuation models at launch.
- Realized EV inferred from recent pulls, hot streaks, wallets, or historical hit frequency.
- Net EV after shipping, resale fees, liquidity, taxes, or user-specific costs.
- Live FX conversion or unsupported currency comparison.
- Personalized, membership, or promo-code pricing.

### Product scope

- A new Recent Pulls page, pull history, or public realized-EV leaderboard.
- A new Remaining Inventory interface; remaining inventory is calculation evidence only in this feature.
- Median outcome, chance of loss, volatility-adjusted EV, or VGEV.
- A new standalone Methodology route; existing glossary and Learn surfaces carry the approved explanation.
- Reinterpreting any historical pre-buyback value as if it used this method.

## Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Establish the versioned EV contract | medium | 1–2 days | done | none |
| 002 | Calculate deterministic buyback-adjusted EV | medium | 2–3 days | done | 001 |
| 003 | Score evidence confidence and freshness | medium | 1–2 days | done | 001 |
| 004 | Normalize launch-provider evidence | large | 4–6 days | done | 001 |
| 005 | Preserve immutable EV revisions | medium | 2–3 days | todo | 002, 003 |
| 006 | Recompute when pack economics change | medium | 2–3 days | todo | 004, 005 |
| 007 | Define the replacement public EV contract | medium | 2–3 days | done | 001, 003 |
| 008 | Publish one coherent public release | large | 4–6 days | todo | 006, 007 |
| 009 | Simulate production-faithful EV changes | medium | 2–3 days | todo | 006, 008 |
| 010 | Present comparable EV metrics | large | 3–5 days | todo | 008, 009 |
| 011 | Teach the methodology and limitations | medium | 1–2 days | todo | 010 |
| 012 | Prove backfill and operational readiness | medium | 2–4 days | todo | 006, 008, 010 |
| 013 | Certify the complete launch flow | medium | 2–4 days | todo | 009, 010, 011, 012 |

## Build Order

1. Complete `001`, then run calculator `002`, confidence `003`, provider evidence `004`, and public contract `007` in parallel.
2. Complete persistence `005`, recomputation `006`, then publication `008`.
3. Run full-path simulation `009` through the completed canonical and public boundaries.
4. Complete presentation `010`, then run education `011` and operations proof `012` in parallel.
5. Complete launch certification `013` after simulation, presentation, education, and operations proof.

## Parallel Groups

- Group A: `001`.
- Group B after Group A: `002`, `003`, `004`, `007`.
- Group C as prerequisites land: `005`, then `006`.
- Group D after Group C and `007`: `008`, then `009`.
- Group E after `008` and `009`: `010`; then run `011` and `012` in parallel before final gate `013`.

## External Dependencies

- Each launch provider must supply enough sanitized source evidence to establish price, odds or remaining inventory, stated values, buyback terms, eligibility, and observation time.
- The canonical PostgreSQL-to-Convex publisher and routing-level maintenance gate must exist before a live clean cutover can prove browser provenance.
- Platform configuration must approve canonical USD or USD-equivalent currency treatment and public vendor identity.
- Product and Engineering owners must approve the preproduction calculation evidence and clean cutover.
- Responsible-play copy must use the current official National Council on Problem Gambling contact at launch.

## Next Action

Open `001-establish-buyback-adjusted-ev-contract.md` and encode the four public metrics, complete-evidence gate, exact unavailable outcomes, and confidence policy as one strict versioned contract.
