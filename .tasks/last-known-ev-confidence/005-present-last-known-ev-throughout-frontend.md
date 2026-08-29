# Task: Present Last-Known EV Throughout the Frontend

**ID:** last-known-ev-confidence/005
**Depends on:** last-known-ev-confidence/003, last-known-ev-confidence/004
**Blocks:** last-known-ev-confidence/006
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder, including responsive and accessible browser coverage
**Status:** done

## Start Here

Add a shared presentation fixture for one old healthy estimate and one old delayed-provider estimate, then make the catalog row, card, inspector, overview, and Learn explanation agree.

## Objective

Every buyer-facing EV surface communicates last-known age, decayed confidence, and informational provider status consistently without treating age as missing data.

## Context

The frontend currently maps post-deadline evidence to unavailable and uses release freshness language for provider health. Both behaviors must consume the new public contract instead of recreating policy in browser code.

## Requirements

- Show `Last-known estimate` and the exact source-observed time for `last_known` EV.
- Show the server-derived confidence score, band, limitations, and evaluation time without client-side rescore.
- Keep last-known estimates visible and sortable in catalog and detail surfaces.
- Keep otherwise eligible rows in Top Opportunities regardless of provider status and explain delayed status separately.
- Update overview coverage, glossary, and Learn copy to say age alone never makes a calculable estimate unavailable.

## User-Facing Behavior

Rows, cards, inspectors, summaries, and education use these exact concepts: `Last-known estimate`, `Source evidence last observed …`, `Provider feed delayed; displaying the latest available data.`, and `Unavailable means required supported inputs are missing. Age alone does not make an estimate unavailable.`

## Interface Contract

The browser consumes presentation state, server-derived confidence, source time, the separately server-derived confidence and provider-health evaluation times, limitations, and informational provider health. It formats values, schedules a refresh from the trusted provider-health clock pair, and renders accessible explanations but never recalculates policy.

## Acceptance Criteria

- [x] Current and last-known estimates display all four EV metrics across table, cards, inspector, and overview.
- [x] Current and last-known estimates may rank regardless of informational provider status.
- [x] Median and coverage include known last-known EV and label the included population accurately.
- [x] Exact timestamps use semantic time markup; confidence changes do not create noisy live-region announcements.
- [x] Both themes, keyboard use, reduced motion, narrow screens, and 200% zoom remain usable.

## Verification

Completed verification:

- Frontend suite: 458 tests passed; typecheck, lint, and production build passed through `npm run verify:framework`.
- Light and dark themes rendered last-known state, source time, confidence, and provider-delay copy consistently in table, cards, overview, and inspector.
- Keyboard inspection and Escape dismissal passed without focus-trap or console errors.
- A 390×844 viewport and a 200%-equivalent 728×719 CSS viewport preserved usable filters, cards, and freshness explanations; reduced-motion behavior is covered by the frontend source and component checks.
- Learn verification found the exact age/unavailable rule and the confidence-decay explanation.
- Screenshot proof was captured as task artifacts for overview, cards, inspector, mobile, 200%-equivalent reflow, and methodology views.

## Spec Compliance

The frontend consumes only server-derived presentation and provider-health state. It does not recalculate age, confidence, availability, or Top Opportunities ranking in browser code. Known last-known EV remains visible and sortable, while provider delay is disclosed without gating any view.
