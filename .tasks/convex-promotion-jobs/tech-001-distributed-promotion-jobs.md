+# Technical Spec: Distributed Convex Promotion Jobs
+
+**ID:** convex-promotion-jobs/tech-001
+**Related tasks:** convex-promotion-jobs/001–009, distributed-canonical-warehouse/013–018, distributed-canonical-warehouse/020
+**Status:** approved implementation contract
+
+## Purpose
+
+Replace the legacy composite promotion loop with independently invokable
+provider-local publication jobs and one central manifest coordinator. Canonical
+provider databases remain authoritative, Convex receives immutable release
+artifacts, and the central database coordinates one-provider manifest changes.
+
+This spec supersedes every fixed-eight, `platformKey`, same-database,
+shared-configuration-epoch, all-provider barrier, and manifest-`clear`
+assumption in the original feature task files.
+
+## Authoritative topology
+
+| Authority | Owns | Must not own |
+|---|---|---|
+| Provider database `packscout_<provider_key>` | Its canonical changes, release assembly, publication operations/receipts, completed head, provider job wake/schedule/invocations/tombstones, promotion lease, completion outbox | Another provider, central manifest state, admin identities, credentials, cross-database locks or transactions |
+| Central database `packscout` | Provider roster, completion relay inbox, per-provider manifest-gate intents, manifest operations/receipts, central job wake/schedule/invocations, schedule observations/conditions, evaluator state, alerts | Provider canonical rows, provider publication leases, provider credentials, offline commands to provider databases |
+| Convex | Immutable provider artifacts, immutable manifest revisions, active/previous pointer, exact signed receipts, public read projections | Canonical provider data, scheduler authority, credentials, raw payloads, claim tokens |
+
+No foreign key, join, lock, lease, cursor, or transaction crosses database
+authorities. Cross-database delivery is asynchronous, idempotent, and
+receipt/checkpoint based.
+
+## Job identities and roster
+
+- One provider-local job is identified internally by
+  `{ jobKind: "provider_publication", providerId }`.
+- One central job is identified by
+  `{ jobKind: "manifest_reconciliation" }`.
+- Provider IDs are trusted UUIDs. Provider keys are immutable display/routing
+  metadata returned by the central registry, never caller-selected authority.
+- The active roster is dynamic. Expected schedule count is the current eligible
+  provider count plus one central manifest schedule; it is never hardcoded.
+- Public Convex contracts may retain their existing `platformKey` field while
+  the port is behind the current frontend contract. New PostgreSQL schemas,
+  persistence, worker routing, monitoring identities, and commands use
+  `provider` terminology only.
+
+## Provider publication flow
+
+1. A provider canonical transaction writes material rows and
+   `promotion_changes`, then coalesces its singleton promotion wake generation
+   in that same provider transaction.
+2. Immediate delivery is best effort. A trusted one-minute reconciliation
+   schedule, manual command, or durable continuation enters the same
+   provider-local admission path.
+3. Admission verifies the provider identity, trigger evidence, delivery key,
+   schedule epoch/window or wake generation, and expiry before a check-in,
+   lease, invocation, or Convex request.
+4. The one-shot job acquires only the local promotion lease, assembles or reuses
+   a complete provider release, persists exact request bytes before dispatch,
+   reconciles ambiguous responses by signed status, and advances the completed
+   checkpoint only with an exact accepted receipt.
+5. Completion or reuse commits a typed `provider_release_completed` outbox
+   event in the same provider transaction as the completed head.
+6. The provider may complete while central is unavailable. Relay replay later
+   converges without changing provider publication truth.
+
+## Completion relay and central manifest flow
+
+1. The existing provider activity relay sends the immutable completion event
+   at least once. Central validates provider ownership and event digest.
+2. Central acceptance and one per-provider manifest-gate generation commit in
+   one central transaction. Duplicate events return the existing inbox result.
+3. One central manifest reconciler fairly claims a bounded pending provider
+   gate. An unavailable or failing provider stays pending and cannot block
+   another provider.
+4. The reconciler obtains exact provider completed-release/catalog proof through
+   the bounded provider gateway or its verified relay evidence, then applies
+   exactly one `advance | add | remove | rollback` operation.
+5. Convex compare-and-swap activation changes only the selected provider entry
+   and immutable manifest metadata. Every unrelated entry remains byte-for-byte
+   identical.
+6. Duplicate delivery, timeout, lost acknowledgement, restart, and stale CAS
+   reconcile from exact signed status/receipt evidence. Failure preserves the
+   prior active manifest.
+7. Provider disablement never unpublishes implicitly. Removal and rollback are
+   explicit central operations. There is no `clear`.
+
+## Trigger and replay contract
+
+Provider and central authorities each persist their own:
+
+- coalesced requested and acknowledged wake generations;
+- schedule lifecycle `pending_activation | active | paused`, monotonic epoch,
+  60-second cadence/baseline, admitted window and check-in;
+- invocations with trigger
+  `change_wake | reconciliation_cron | manual | continuation`;
+- terminal outcome
+  `caught_up | no_change | coalesced | continuation_required | deferred |
+  blocked | failed`;
+- scoped delivery-key digest and 30-day tombstone;
+- retained summary/detail snapshot and bounded failure evidence.
+
+Same-key replay is checked after trusted scope and fixed-expiry validation but
+before current generation/window freshness. It returns `existing` or
+`existing_pruned` without new work. A generation-N completion cannot
+acknowledge generation N+1.
+
+One-shot work is bounded to 50 seconds and 25 attempts. Remaining work creates
+continuation intent before the invocation closes. Trigger kind changes
+admission evidence only, never publication behavior or credential authority.
+
+## Liveness
+
+- Provider schedule/check-in truth is provider-local. Central schedule/check-in
+  truth is central.
+- A central evaluator snapshots the trusted roster and reads provider schedule
+  state through bounded-concurrency gateway calls. One unavailable provider is
+  a row-level unavailable observation, not an evaluator failure.
+- At `evaluatedAt`, a due window counts only when
+  `dueAt(window) < evaluatedAt`.
+- Zero or one missed window is healthy, two is overdue, and three or more is
+  alerting. Pending and paused schedules do not accrue misses.
+- Only a strictly newer trusted reconciliation check-in recovers a provider
+  schedule condition. Mere database reachability, manual work, wakes, or
+  continuation do not.
+- Provider missed conditions are tenant-scoped central alerts. The central
+  manifest schedule and evaluator watchdog use a distinct least-privilege
+  system/external condition sink and are never attributed to an arbitrary
+  organization.
+- Evaluator success records the roster digest, expected/reachable/unavailable
+  counts, manifest evaluation result, and evaluated-through time. Enumeration
+  or persistence failure marks prior judgments stale; it never reports a quiet
+  zero-provider success.
+
+## Monitoring boundary
+
+The server returns:
+
+- roster observation/digest/count and evaluator state;
+- one central manifest coordinator view;
+- one provider view per trusted roster entry;
+- merged keyset history backed by central manifest invocations and sanitized
+  provider invocation projections;
+- opaque, scope-bound detail IDs with at most 25 attempt snapshots and 25
+  recent operations per attempt.
+
+Each provider view separates:
+
+- evidence source `live | last_known | unavailable`;
+- schedule health;
+- local settled/completed publication state;
+- central active manifest selection and pending gate state;
+- lifecycle `draft | active | disabled | archived`.
+
+Browser code never selects organization, deployment, provider UUID, database,
+host, credential, or raw local invocation identity. It never derives
+checkpoint or liveness judgments. Responses exclude request/response/receipt
+bodies, credentials, key IDs, claim tokens, database topology, tenant/actor
+identifiers, raw canonical rows, and protected evidence.
+
+## Admin behavior
+
+- Route: `/promotion-jobs`; detail:
+  `/promotion-jobs/:monitoringId`.
+- Filter identity: `manifest` or `provider:<providerKey>`; omission means
+  all. Reject `all`, UUIDs, database names, aliases, and unprefixed keys.
+- Read-only through `providers:view`; no run, retry, cancel, schedule,
+  credential, configuration, rollback, remove, or activation controls.
+- Refresh every 15 seconds only while visible. Preserve last safe evidence only
+  for the exact same scope/filter/detail and mark it stale on refresh failure.
+- One provider outage, central manifest unavailability, stale evaluator,
+  disabled-but-still-active selection, and archived last-known evidence remain
+  distinct and do not blank healthy rows.
+
+## Cutover
+
+1. Prove all legacy composite provider/manifest attempts terminal or drained.
+2. Stop the old composite scheduling authority.
+3. Prove separate provider/central schema identity, inert endpoints, and
+   least-authority credentials.
+4. Activate provider schedules and central manifest schedule from an exact
+   roster digest.
+5. Record one successful evaluator pass for `eligible providers + 1`, then arm
+   the independent detector.
+
+Old and new authorities never overlap. Cutover does not clear Convex, reset
+canonical PostgreSQL, migrate legacy promotion rows, or add a dual path. Before
+the first distributed mutation, rollback may restore the old deploy only after
+stopping the new authority. After the first distributed mutation, rollback is
+stop/freeze plus a signed manifest rollback or a known-good distributed deploy;
+legacy composite loops are not re-enabled.
+
+## Task mapping
+
+| Task | Distributed implementation |
+|---|---|
+| 001 | Split provider-local and central invocation/wake/schedule/tombstone persistence |
+| 002 | Provider-only publication authority and manifest-only central authority |
+| 003 | One provider-local bounded publication job, built on distributed Task 014 |
+| 004 | One central fair per-provider manifest reconciler, built on distributed Task 015 |
+| 005 | Immediate delivery, schedules, manual admission, continuation, completion relay |
+| 006 | Dynamic-roster liveness evaluation, alerts, and external watchdog |
+| 007 | Central monitoring projection plus bounded provider-gateway reads |
+| 008 | Read-only Admin Promotion Jobs route and detail |
+| 009 | Clean authority cutover and distributed certification |
+
+The verified commits on
+`codex/convex-promotion-jobs-pre-distributed` are port sources only. They are
+not acceptance evidence for this topology.
+
+## Verification
+
+Focused verification must cover:
+
+- independent central/provider Prisma validation and migration invariants;
+- one central plus at least two provider databases;
+- provider commit plus local wake atomicity;
+- provider receipt plus completed head/outbox atomicity;
+- relay duplicate, lost-acknowledgement, outage, and restart recovery;
+- one-provider manifest mutation preserving unrelated entries exactly;
+- one provider outage while another publishes and activates;
+- dynamic roster add/disable/archive and evaluator pagination/capacity;
+- trigger forgery, cross-scope replay, pruning/tombstones, pause/resume, and
+  exact liveness boundaries;
+- monitoring authorization, cursor binding, bounded evidence, and redaction;
+- no fixed roster, legacy client fallback, cross-database transaction,
+  all-provider barrier, or `clear`.
+
+Before handoff, run `npm run verify:framework`.
+
