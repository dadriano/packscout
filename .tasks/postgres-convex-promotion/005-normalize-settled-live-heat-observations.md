# Task: Normalize Settled Live Heat Observations

**ID:** postgres-convex-promotion/005
**Depends on:** postgres-convex-promotion/001
**Blocks:** postgres-convex-promotion/006
**Estimated scope:** medium
**Estimated effort:** 1–3 days for one builder, including mapping and idempotency fixtures
**Status:** todo

## Start Here

Map one settled pull and one settled catalog-availability change into the existing Heat calculator input contract and prove replay creates no duplicate observation.

## Objective

Persist the minimal normalized, public-safe observation stream required to calculate live Repack Heat from settled PostgreSQL facts.

## Context

The Heat calculator and simulated publisher already exist, but canonical projections do not currently provide every normalized pull-return, value-multiple, catalog sequence, availability, and outcome key needed by that calculator. Heat cannot be productionized by sending raw events to Convex or by guessing missing fields at publish time.

## Requirements

- Define a bounded normalized Heat observation contract for pull activity and catalog availability/supply changes using stable public repack identity and integer basis-point values.
- Create observations from authoritative canonical writes with the originating public-change sequence and organization scope.
- Persist observation creation idempotently in the same causal workflow as its source change; replay or provider retry cannot double-count activity.
- Record enough event time and deterministic sequence data to order equal-time observations without relying on ingestion wall-clock order.
- Represent unavailable return/value evidence as null with bounded semantics rather than zero.
- Derive only calculator inputs supported by canonical evidence; unsupported or malformed source evidence is rejected/quarantined before it can affect Heat.
- Exclude raw payloads, provider actor/user identity, credentials, tenant selectors, and quarantine details.
- Make only settled observations eligible for aggregation. An observation whose causal sequence is above the settled watermark is invisible to Heat calculation.
- Support bounded time-window reads for the existing 15-minute current and 24-hour baseline windows.
- Retain enough normalized history for the Heat baseline and recovery while keeping retention independent from Convex.

## User-Facing Behavior

No raw activity becomes public. Once settled, supported activity may change the existing Repack Heat label and evidence text; missing inputs produce the existing unavailable behavior.

## Interface Contract

The normalized repository provides the existing Heat calculator with:

- pull observations: public repack ID, occurred-at time, causal sequence, nullable realized-return basis points, and nullable value-multiple basis points;
- catalog observations: public repack ID, occurred-at time, deterministic sequence, available-chase count, and bounded outcome keys;
- a bounded query by approved organization, inclusive time window, and maximum settled causal sequence.

No Convex client or public DTO is part of this boundary.

## Acceptance Criteria

- [ ] Supported canonical pull and catalog changes create calculator-compatible observations with stable public identities and causal sequence.
- [ ] Replaying the same canonical source creates no duplicate observation or Heat contribution.
- [ ] Unsettled observations are excluded until their sequence is within the settled watermark.
- [ ] Equal-time observations order deterministically and yield repeatable calculator output.
- [ ] Missing numeric evidence remains null and malformed/unsupported evidence cannot enter aggregation.
- [ ] Bounded 15-minute/24-hour reads return only the approved organization's normalized, settled observations.
- [ ] Protected provider, actor, tenant, and raw fields cannot enter the observation contract.

## Verification

`npm run test:database && npm run test:services`
