# Buyback-Adjusted EV Operational Readiness

Status: task `buyback-adjusted-ev/012` operational boundary — inventory, backfill reconciliation, monitoring, failure drills, and the strict readiness ledger for the clean V2-to-V3 cutover.

The readiness result is strict **pass or blocked**. A blocked result cannot waive a criterion or activate a mixed release; every criterion is recomputed from raw evidence on every evaluation (`evaluatePackScoutBuybackEvReadinessV1`), and the ledger carries a sha-256 digest over its canonical body so recorded evidence cannot be swapped under a previously computed digest.

## Cutover inventory

`packages/services/src/buyback-adjusted-ev-cutover-inventory.ts` is the machine-readable manifest of every pre-buyback calculator, projection, public field, sort, KPI, fixture, glossary term, example, and telemetry label affected by the semantic change. Each item carries exactly one disposition:

| Disposition | Meaning |
| --- | --- |
| `replaced_by_v3` | Active pre-cutover surface replaced by a named V3 surface at the clean cutover; no alias, dual read, dual write, or mixed-version bridge in between. |
| `historical_only` | Immutable stored results or committed fixtures that keep their original pre-buyback identity and never enter a new release under buyback-adjusted labels. |
| `retired` | Pre-buyback vocabulary deliberately not carried into any new-method contract. |

`buyback-adjusted-ev-cutover-inventory.test.ts` enforces the manifest: every referenced file must exist, every non-test source file spelling a pre-buyback token (`estimated-ev` variants, `modelVersion`, the V2 reason vocabulary, the mock model version) must be inventoried, and no V3/new-method surface (buyback-adjusted modules, `data_release_v3` contracts and adapters, `convex/dataReleaseV3*`, `convex/publicRepacksV3*`) may spell any pre-buyback token. The V2 runtime path legitimately remains inventoried as `replaced_by_v3` until task 013 retires it after certification.

## Backfill reconciliation

`PackScoutBuybackEvBackfillReconciliationRunnerV1` (`packages/services/src/buyback-adjusted-ev-backfill-reconciliation.ts`) runs one reconciliation:

1. Enumerates every repack in the canonical store at one settled release read clock through the real `data_release_v3` canonical adapter.
2. Drives each supplied unit of provider-normalized evidence through the real task-006 recomputation boundary (`created`, `unchanged`, and `superseded` converge; `rejected` or `unbindable` work blocks the run).
3. Classifies every repack as `recomputed_available`, `deterministic_unavailable` with its bounded public reason, or `sold_out_historical`, with counts, method and confidence-policy versions, confidence-band distribution, and a source-age distribution.
4. Stages — never activates — the assembled `data_release_v3` publish plan and reconciles two independent derivations: the classification predicted from the publication-eligibility read, and the public EV state the assembler actually emitted. Repack-set differences, state or reason disagreements, mixed versions, staging divergence, or any movement of the active release pointer block the run.

The runnable driver is `scripts/local/backfill-buyback-ev.mjs`:

```bash
node --import tsx scripts/local/backfill-buyback-ev.mjs \
  --organization <uuid> --read-at <iso-utc> \
  [--evidence-module <path>] [--verification-json <path>] [--alerts-json <path>] \
  [--drill-json <path>] [--gated-at <iso> --reopened-at <iso>]
```

The script refuses any non-loopback PostgreSQL host, publishes nothing externally, never touches the active release pointer, writes the generated ledger to the gitignored `docs/evidence/buyback-adjusted-ev-readiness-ledger.json`, and exits nonzero when the ledger is blocked.

## Monitoring and alert mapping

`PackScoutBuybackEvOperationalMonitorV1` (`packages/services/src/buyback-adjusted-ev-operational-monitor.ts`) reports bounded labels, counts, and ages only, through the existing `OperationalObservability` port and the durable notification channel. A string-scan tripwire refuses any event carrying money spellings, raw payload markers, credentials, or personal identity markers, and telemetry failures never change a pipeline outcome.

Monitored dimensions map onto the existing bounded metric vocabulary:

| Dimension | Metric | Outcome codes |
| --- | --- | --- |
| Method-version distribution | `record_count` | sanitized version code (e.g. `PACKSCOUT_BUYBACK_ADJUSTED_EV_V1`) |
| Availability | `calculation_availability_total` | `AVAILABLE` / `UNAVAILABLE` |
| Unavailable reasons | `record_count` | the bounded public reason codes |
| Confidence bands | `record_count` | `CONFIDENCE_BAND_LOW/MEDIUM/HIGH` |
| Source conflicts | `record_count` | `SOURCE_CONFLICT` (rejected identity/result conflicts) |
| Recomputation age | `freshness_age_seconds` | `BUYBACK_ADJUSTED_EV` |
| Queue lag | `cursor_lag_proxy` | `BUYBACK_EV_QUEUE` |
| Stale EV / source age | `record_count` | `SOURCE_AGE_*` buckets |
| Publication outcome | `run_outcome_total` | `STAGED` / `PUBLICATION_BLOCKED` |

Engineering alerts reuse the existing operational notification kinds with buyback-EV-scoped dedupe and recovery keys, so each condition deduplicates independently and recovers on its own key:

| Condition | Kind | Severity | Dedupe key | Bounded evidence |
| --- | --- | --- | --- | --- |
| Recomputation backlog | `provider_stale` | warning | `buyback-ev:backlog:<providerId>` | `count`, `durationMs` |
| Method mismatch | `run_failed` | critical | `buyback-ev:method-mismatch:<organizationId>` | `failureCode` (sanitized version) |
| Publication rejection | `run_failed` | critical | `buyback-ev:publication:<organizationId>` | `failureCode` (stage + code) |
| Freshness expiry | `provider_stale` | warning | `buyback-ev:freshness:<providerId>` | `count`, `durationMs`, `reasonCode` |

## Failure and rollback drills

| Drill | Proven by | Fails closed as |
| --- | --- | --- |
| Partial evidence | `buyback-adjusted-ev-failure-drills.integration.test.ts` | `ODDS_UNAVAILABLE` |
| Source conflict | same | `ODDS_UNAVAILABLE` |
| Stale data | same | `SOURCE_DATA_STALE` |
| Invalid price | same | `PRICE_UNAVAILABLE` |
| Unsupported currency | same | `CURRENCY_UNSUPPORTED` |
| Ambiguous draws | same | `SOURCE_EVIDENCE_UNAVAILABLE` |
| Arithmetic overflow | same | `CALCULATION_UNAVAILABLE` |
| Recomputation failure | same (transient failure retries durably, converges without new history) | retry, then `unchanged` |
| Expiry | same (estimate leaves the release as `SOURCE_DATA_STALE` with `metrics: null`; the immutable revision row is byte-identical before and after) | never zero, never mutated |
| Publication interruption | same (`failNextApplyBatch`; the last coherent release stays active; the retry activates the identical release identity) | last coherent release readable |
| Malformed release projection | same (`PUBLIC_CONTRACT_INVALID` blocks assembly; the active release stays readable) | blocked plan |
| Replay / refresh / recovery | same plus `buyback-adjusted-ev-backfill-reconciliation.integration.test.ts` (full replays converge to `unchanged`/`superseded`, identical ledger rows, identical release identity) | no rewritten history |
| Maintenance-gated rollback | `buyback-adjusted-ev-cutover-runbook.test.ts` (V2 application restored, retained pointer active again, traffic reopened last, drill recorded in the ledger) | restore before reopen |

Backfill mismatch drills (`EVIDENCE_SCOPE_VIOLATION`, `PLAN_BLOCKED`, `ACTIVE_POINTER_MOVED`) are exercised in `buyback-adjusted-ev-backfill-reconciliation.integration.test.ts`; every canonical drill runs DB-backed against a migrated PostgreSQL through the real recomputation, revision, canonical-adapter, assembler, and publication-protocol boundaries.

## Readiness ledger

`composePackScoutBuybackEvReadinessLedgerV1` (`packages/services/src/buyback-adjusted-ev-readiness-ledger.ts`) records: candidate and prior release identities, application commit, method and confidence-policy versions, canonical revision counts and recomputation tallies, the staged public release id, the approved-configuration sha-256 fingerprint, the source-age distribution, every unavailable reason, maintenance timing, verification commands run, alert evidence, promotion outcome, and the rollback drill result — then evaluates these strict criteria:

| Criterion | Passes when |
| --- | --- |
| `inventory_dispositions_complete` | every inventory item carries a valid disposition and every replaced item names its V3 replacement |
| `backfill_reconciled` | the backfill ledger is `ready`, non-empty, row-complete, with zero rejected/unbindable work and zero blocked reasons |
| `versions_uniform` | exactly the approved method and confidence-policy versions appear |
| `staging_reconciled_without_activation` | the candidate release staged to `complete` with the pointer unmoved |
| `observability_alerts_mapped` | all four alert conditions delivered through the documented mapping |
| `alert_evidence_sanitized` | the recorded operational evidence passes the protected-content scan |
| `failure_drills_verified` | at least one verification command recorded and all exit 0 |
| `rollback_drill_recorded` | one executed drill restored V2 before reopening traffic |
| `maintenance_gated` | a coherent maintenance window plus a valid commit and configuration fingerprint |

## Reproducing the evidence

PostgreSQL 16 at `127.0.0.1:5432` is required for the DB-backed lanes.

```bash
node --import tsx --test \
  packages/services/src/buyback-adjusted-ev-cutover-inventory.test.ts \
  packages/services/src/buyback-adjusted-ev-operational-monitor.test.ts \
  packages/services/src/buyback-adjusted-ev-readiness-ledger.test.ts \
  packages/services/src/buyback-adjusted-ev-cutover-runbook.test.ts \
  packages/services/src/buyback-adjusted-ev-backfill-reconciliation.integration.test.ts \
  packages/services/src/buyback-adjusted-ev-failure-drills.integration.test.ts
node --test scripts/local/backfill-buyback-ev.test.mjs
npm run typecheck
npm run lint:services
npm run scan:framework-standards:ratchet
```
