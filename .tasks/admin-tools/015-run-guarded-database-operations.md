# Task: Run Guarded Database Operations

**ID:** admin-tools/015
**Depends on:** admin-tools/014
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

Operators can run exactly three blessed database workflows from the panel — apply migrations, seed, and reset — with guardrails proportionate to their danger, live streamed output, and an audit trail, while a non-local database makes all of them structurally unavailable.

## Context

This ports the reference panel's data operations. The design constraint is that convenience must never widen the blast radius:

- only pre-registered workflows exist — apply-migrations, seed, and reset — and there is no free-form command execution. The workspace already defines a canonical migrate-deploy workflow to reuse; canonical seed and reset workflows for the relational store do not exist yet, so this task defines them. Two repository realities shape that: the script-safety check requires destructive scripts to carry environment-qualified names, and the only existing seed targets the product's document backend — the wrong datastore — so a relational seed must be authored, not borrowed;
- confirmations are tiered: disruptive operations (migrate, seed) confirm intent; the destructive one (reset) requires typing the database name as acknowledgment;
- guards evaluate at execution time, not request time: locality is re-verified when the operation actually starts, and the target database is re-verified to still be the one the operator acknowledged — catching environment drift while an operation waited its turn;
- one operation runs at a time: a shared lock serializes the registered operations against each other (log streaming is unaffected by it);
- output streams live to an operation pane this task introduces, with a bounded line cap and an overall timeout, and a panel restart mid-operation reports "outcome unknown" afterward rather than silently forgetting.

## Requirements

- Offer exactly three operations against the local relational database: apply pending migrations (reusing the workspace's existing canonical migrate-deploy workflow), run the seed, and reset (drop, re-migrate, re-seed). Where a canonical workflow is missing (seed and reset), define it as a workspace script with an environment-qualified name that satisfies the repository's script-safety check, then have the panel invoke that script — the panel never embeds a private reimplementation.
- Tiered confirmation UI: migrate and seed confirm with stated consequences; reset demands the operator type the target database's name, and the typed acknowledgment is validated against the actual current target at execution time — a mismatch (including drift since the dialog opened) refuses with an explanation.
- Every operation re-checks the fail-closed locality classification (admin-tools/014) at execution time and refuses non-local targets server-side; with a non-local target the UI replaces the operations region with an explanation rather than showing disabled buttons.
- A single-operation lock serializes the registered operations; a second request while one runs receives a clear busy outcome identifying what's running. Log streaming and other panel reads are not gated by this lock.
- Operation output streams live into the operation pane (introduced by this task): color codes stripped, auto-scrolling, close disabled while running; server-side the stream has a bounded output cap and an overall timeout, both surfaced honestly when hit.
- An interrupted panel (restart mid-operation) subsequently reports the operation's outcome as unknown, visibly, instead of losing it.
- Every attempt — succeeded, failed, refused (non-local, drift, busy, bad acknowledgment) — is audited via admin-tools/010's trail; all three operations are origin-guarded mutations.
- Migration state and status (admin-tools/014) visibly refresh after an operation completes so the operator sees the result without manual reloads.

## User-Facing Behavior

After pulling a branch with new migrations, an operator opens Data, sees "2 pending", clicks apply, confirms, and watches the migration output stream by; the status card flips to current. Resetting a scrambled local database demands they type its name; the run streams through drop, migrate, and seed, and the tables list repopulates. A teammate pointing their environment at a shared database sees the whole operations area replaced by "disabled — this database is not local", and nothing they do in the UI can run anything against it.

## Interface Contract

- The mutation contract accepts a named registered operation (plus the typed acknowledgment for reset) and returns either an operation handle whose output/status stream the pane consumes, or a stable refusal (non-local, busy, acknowledgment mismatch, drift).
- Current/most-recent operation state is queryable so a reopened panel can reattach to a running operation's stream or report the unknown-outcome case.
- Locality and target identity come from admin-tools/014's exposed server-side facts — never re-derived client-side.

## Acceptance Criteria

- [x] Migrate reuses the existing canonical workflow; seed and reset run through newly defined, environment-qualified workspace workflows that pass the repository's script-safety check — all three with live streamed output and post-completion status refresh.
- [x] Reset requires a typed database-name acknowledgment validated at execution time; mismatch and drift both refuse with explanations.
- [x] Non-local targets make all three operations unavailable in the UI and refused server-side; concurrent requests serialize with a clear busy outcome.
- [x] Output cap and timeout bound every run and are reported when hit; a panel restart mid-run yields a visible unknown-outcome report.
- [x] Every attempt, including refusals, appears in the audit trail; none of the endpoints accept caller-supplied commands or SQL.

## Verification

Guard tests prove execution-time refusals (non-local, acknowledgment mismatch, target drift, busy lock) and that only the three registered operations are invocable; streaming tests prove the output cap, timeout, and interrupted-run unknown-outcome reporting. The panel test suite and workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: The three registered operations delegate to workspace scripts (`db:prisma:migrate:deploy`, the new `db:seed:local`, the new `db:reset:local`), and every guard — locality, the single-operation lock, target drift, and the typed acknowledgment — is evaluated by the supervisor at the moment the operation starts, against a target re-resolved from the environment right then.
- Divergences: none in scope. One environmental note: `prisma migrate reset` carries its own AI-agent safety guard, so the destructive step of `db:reset:local` could not be executed to completion during verification — it refused with that guard's message, and the panel reported the failure honestly (marker written, output streamed, run settled as `failed` with the exit code named). Migrate and seed were exercised end to end against a real local PostgreSQL database through the panel's own spawn adapter.
- Verification: `npm run test:ops-panel` (EXIT 0, 447 tests passing), `npm run typecheck` (EXIT 0), `npm run lint` (EXIT 0), `npm run check:scripts` (EXIT 0, 8 package.json files scanned), `npm run scan:framework-standards:ratchet` (EXIT 0, 0 new findings, 0 grown modules). Additionally `npm run check:framework` (EXIT 0) and `npm run test:tooling` (EXIT 0, 205 + 2 tests) for the new workspace scripts. Live checks against a scratch database: migrate and seed streamed to success through the runner, the seed proved idempotent, both scripts refused unset, unparseable, and non-loopback targets, and a mistyped acknowledgment refused the reset without writing an in-flight marker.
