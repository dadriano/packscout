# Task: Establish the Local Operations Panel

**ID:** admin-tools/010
**Depends on:** none
**Blocks:** admin-tools/011, admin-tools/014
**Estimated scope:** medium
**Status:** done

## Objective

PackScout gains a local-only operations panel — a standalone workspace app a developer or operator starts on their machine — that discovers the local PackScout processes' log files and provides the foundation (access model, streaming conventions, audit trail) the log and database surfaces (admin-tools/011 through admin-tools/015) build on.

## Context

This ports the approved reference operations panel's foundation. Its defining property is independence: it shares no authentication, session, or runtime with the product or admin apps, so it works precisely when they are broken. Its security model is structural rather than account-based, and it is the template to follow:

- the server binds loopback only — never reachable from another machine (remote use is an SSH tunnel landing on that same loopback bind);
- mutations are origin-guarded: they require a custom request header a cross-origin page cannot set without a refused preflight, plus a loopback origin when one is present, and rejected attempts are audited;
- sensitive reads additionally require a loopback Host header to defeat DNS rebinding;
- every privileged attempt — succeeded, failed, or rejected — lands in a bounded, persisted, reverse-chronological audit trail viewable in the panel;
- there is no endpoint, parameter, or debug path that runs caller-supplied commands, paths, or SQL — by design, permanently.

The panel is scoped to two surfaces in this feature: logs and database. It is a local tool, never deployed to production infrastructure.

PackScout already has the seed of a per-service log-file convention: the repository's local service-supervision script redirects each supervised service's output (frontend, admin, worker) to per-service log files under the user's local log directory, while the plain concurrent dev command leaves everything on stdout. The panel adopts and formalizes that existing convention rather than inventing a competing one, and closes the gap so every locally run PackScout process can produce a discoverable per-service log file.

## Requirements

- Create the panel as a new workspace app following the repository's workspace conventions (root lockfile, a port within the 5100–5199 local range the architecture document reserves for PackScout services, standard lint/typecheck/test wiring).
- The server binds loopback only, with a friendly failure when the port is taken; in development one process serves API and UI together; production deployment is explicitly out of scope.
- Formalize the per-service log-file convention, starting from the existing supervised-service log files: all locally run PackScout processes (including the plain dev workflow) write, or are wrapped to write, per-service log files under one discoverable directory with a recognizable name pattern; service names derived from filenames are validated against a safe character set.
- The panel discovers log sources by polling that directory at a bounded interval, picking up files that appear, disappear, or change mid-session without restart, and exposes the discovered source list to the UI both as a fetch and as a live-updating stream.
- Server-push updates use server-sent events with uniform conventions: named events, client retry hints, periodic heartbeats, proxy-buffering disabled, and teardown that releases per-connection resources on close; the client budgets concurrent event streams per tab so browser connection caps are never exhausted.
- Implement the structural access model described in Context: loopback bind, origin guard on all mutating routes, rebinding-resistant guard on sensitive reads, and the persisted audit trail with a panel view listing recent privileged activity.
- Define the guard membership, binding on later tasks: sensitive reads are all log-content reads (tails, initial windows, history, deep search, raw downloads) and all database-status reads; privileged-and-audited actions are every mutation plus raw log-file downloads. Event-stream endpoints may relax the header requirement only as far as the browser's event-stream client requires, never the loopback checks.
- Non-trivial logic lives in framework-free modules with colocated unit tests, mirroring the panel's pure-logic discipline, so behavior is testable without a browser.

## User-Facing Behavior

A developer runs the panel's dev command, opens the loopback URL, and sees the panel shell: the log surface listing every discovered PackScout service log as it appears, an activity view showing recent privileged actions, and navigation stubs for the surfaces later tasks fill in. Another machine cannot reach it; a malicious web page open in the same browser cannot invoke its mutations.

## Interface Contract

- Source discovery exposes: service name, file identity, size, and last-write time, as a snapshot read and a change stream — consumed by admin-tools/011 (tailing) and admin-tools/012 (history).
- The origin-guard, read-guard, audit, and SSE conventions are shared infrastructure that admin-tools/011 through admin-tools/015 must use rather than reimplement, applying the guard membership defined above (log-content and database-status reads are sensitive; mutations and raw downloads are privileged and audited).
- The log-file convention (directory, naming pattern) is documented so future services join it by following the pattern.

## Acceptance Criteria

- [x] The panel starts locally, binds loopback only, and serves its UI and a liveness endpoint; a taken port produces a clear message.
- [x] Locally started PackScout processes produce per-service log files the panel discovers, including files that appear or disappear while the panel is running.
- [x] The origin-guard middleware rejects a mutation request lacking the custom header (or from a non-loopback origin) and records it in the audit trail as rejected — exercised via tests at this stage, since the first real mutating surface arrives with admin-tools/014.
- [x] The audit trail persists across panel restarts, is bounded, and is viewable in the panel.
- [x] Workspace lint, typecheck, and test wiring covers the new app and passes.

## Verification

The panel's test suite proves source discovery (appear/disappear/rename mid-session, name validation) and the guard behaviors (missing header rejected and audited, loopback checks) as pure-logic tests, and the workspace verification command passes with the new app included.

## Spec Compliance

- Related specs reviewed: none
- Alignment: Built `apps/ops-panel` on port 5110 (HMR 5111) with a loopback-only bind, the declared guard membership (`/api/logs`, `/api/database`, `/api/activity` are sensitive reads; mutations and `/api/logs/download` are privileged and audited), a bounded persisted audit trail, shared SSE conventions, and polled source discovery over the formalized `<service>.log` convention.
- Divergences: none. Production deployment is intentionally absent (the app refuses `NODE_ENV=production` and has no build script), matching the task's explicit scope.
- Post-review hardening: the EventSource header exemption originally applied to any non-mutating path ending in `/stream`, which would have let a raw download under `/api/logs/download/.../stream` (privileged, but a GET) skip the custom-header check — a cross-origin GET from an image or script tag sends no `Origin` and carries a loopback `Host`, so that header is the last remaining layer. Raw downloads are now excluded from the exemption, with a regression test asserting such a request is refused as `missing_panel_header`. No such route exists yet; this closes the hole before admin-tools/012 builds downloads on it. `npm run test:ops-panel` now 89/89.
- Verification: `npm run lint` (0), `npm run typecheck` (0), `npm run check:framework` (0), `npm run test:ops-panel` (88 tests, 88 pass — 12 discovered test files), `npm run test:root` (123 tests, 123 pass, includes the new local-wrapper tests), `npm run scan:framework-standards:ratchet` (0 findings, 0 new). Manual smoke: panel served `/api/health`, `/api/logs/sources`, the SSE stream, and its UI on `http://127.0.0.1:5110`; `lsof` confirmed a `127.0.0.1`-only listener; a second instance printed the friendly port-in-use message and exited 1; a file created mid-session appeared in the UI without a reload; a rejected mutation was recorded and still listed after a panel restart.
