# Task: Cut Over and Certify Distributed Hybrid Promotion

**ID:** convex-promotion-jobs/009
**Depends on:** convex-promotion-jobs/005, convex-promotion-jobs/006, convex-promotion-jobs/007, convex-promotion-jobs/008, distributed-canonical-warehouse/017, distributed-canonical-warehouse/018
**Blocks:** distributed-canonical-warehouse/020
**Status:** blocked
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Replace the legacy composite promotion authority with provider-local jobs and
the central manifest coordinator, then certify safety, isolation, timeliness,
observability, and recovery on the exact launch commit.

## Requirements

### Clean authority switch

- Capture a target-bound roster timeline:
  1. old composite provider/manifest loops stopped and every legacy attempt
     terminal or drained;
  2. split schema/readiness, inert endpoints, and least-authority credentials
     proven;
  3. dynamic provider schedules/immediate delivery and central manifest schedule
     enabled from the exact roster digest;
  4. first evaluator success records eligible provider count plus one;
  5. external detector armed only after that success.
- Old and new authorities never overlap. New mode does not recover a legacy
  attempt, clear Convex, reset canonical PostgreSQL, migrate legacy promotion
  rows, or introduce dual reads/writes.
- Rehearse stop-first rollback. After the first distributed mutation, rollback
  uses signed manifest rollback or a known-good distributed deploy and never
  re-enables legacy composite loops.

### Canary and failure matrix

- First run exactly one provider-local job with only its provider credential,
  then separately run the central manifest job with only manifest authority.
- Prove the selected provider entry changes and every unrelated manifest entry
  remains byte-for-byte identical.
- Repeat with at least two independently addressable provider databases; make
  one unavailable and prove the other publishes/activates.
- Certify explicit `add | advance | remove | rollback`, compatible complete
  release/catalog pairing, CAS conflict, lost receipt, restart, lease loss,
  target drift, status recovery, and prior-active preservation.
- Drop immediate delivery, overlap all trigger kinds, force 50-second
  continuation, pause/resume one provider schedule, and prove replay/tombstone
  bounds.
- Provider disablement never auto-removes its manifest entry.

### Liveness, monitoring, and performance

- Schedule/evaluator expected counts derive from the captured roster and fail on
  drift.
- Prove two missed windows overdue, three one deduplicated condition, exact
  recovery, alert open/recover delivery retry, and independent evaluator
  watchdog fire/recover.
- Verify live/last-known/unavailable Admin states, authorization, structured
  errors, no mutations, redaction, accessibility, narrow/desktop layouts, and
  same-scope stale retention.
- Record at least 20 successful settled-provider-change-to-active-entry samples
  for every active launch provider; each provider p95 is below 60 seconds with
  zero partial activations.
- Run current public list/search/filter/detail/cursor/freshness/delayed/
  unavailable/no-safe-manifest contract regressions unchanged.

### Evidence package

Record exact commit, central/provider identity and schema/parity digests, roster
digest/count, hashed topology proof, schedule registration/check-ins, wake loss,
continuation/replay/tombstones, release and activation receipt digests,
unrelated-entry preservation, outage isolation, credential role/rotation,
watchdog evidence, timing distribution, redaction audit, safe commands, and
verifier result.

Never record raw organization/provider UUID, database target, credential/key,
claim token, request/response/receipt body, tenant/actor field, raw canonical
row, or protected source evidence.

## Acceptance Criteria

- [ ] Timestamped evidence proves no old/new scheduling overlap.
- [ ] One-provider canary uses split credentials and exact provider then manifest
  phases.
- [ ] At least two provider databases prove publication/activation isolation
  under one-provider outage.
- [ ] Add/advance/remove/rollback preserve unrelated entries and prior active
  state on every injected failure.
- [ ] Lost immediate delivery, trigger overlap, continuation, crash, lease,
  retry, status, and CAS recovery converge without duplicate or partial data.
- [ ] Dynamic schedule/liveness counts, alert recovery, and watchdog behavior
  pass without fixed roster assumptions.
- [ ] Retention protects active/previous/in-flight/blocked/rollback artifacts,
  current health, compact detail, and 30-day tombstones.
- [ ] Every active provider has at least 20 zero-error samples and p95 under one
  minute.
- [ ] Admin/public/security/redaction/credential-rotation evidence passes.
- [ ] Focused suites and `npm run verify:framework` pass on the exact evidence
  commit.
- [ ] Distributed Task 020 records this task as a dependency and consumes the
  evidence before certification closes.

## Verification

Run the full two-provider/central integration and failure matrix, browser
acceptance, public contracts, package checks, then
`npm run verify:framework` on the exact launch commit.

## Spec Compliance

Existing ClutchPacks scripts and legacy readiness certifiers are pattern sources
only. They are not distributed cutover evidence and their combined-runtime,
fixed-eight, global-barrier, Heat/reset, or clear assumptions must not ship.

## Blocker

Repository implementation is complete through Task 008. Certification requires
completion of distributed Tasks 017 and 018 for recovery, retention, security,
and failure-isolation evidence. It then requires an authorized preproduction
environment with one central and at least two provider databases, the target
Convex deployment and split signing roles, deployed provider/manifest/relay/
liveness processes, and approval to drain the old authority and execute canary,
fault-injection, rollback, and timing samples. Those prerequisite proofs,
credentials, databases, services, and rollout authority are not available in
this checkout and cannot be replaced with fabricated local evidence.
