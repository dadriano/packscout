# Task: Stream Live Logs with Faithful Tailing

**ID:** admin-tools/011
**Depends on:** admin-tools/010
**Blocks:** admin-tools/012, admin-tools/013
**Estimated scope:** large
**Status:** done

## Objective

The operations panel shows PackScout's service logs live: a unified, virtualized stream across all services (or any subset) that follows new output in real time, survives log rotation and restarts honestly, and never lies about gaps.

## Context

This ports the reference panel's live-log core. Its distinguishing quality is truthfulness under file churn: dev processes restart, log files truncate, rotate, disappear and reappear, and lines arrive half-written. The reference behavior to replicate:

- follow semantics across truncation, file replacement, and disappear/reappear, with each such event surfacing as an inline marker (log restarted, file disappeared — waiting, file appeared) rather than silent continuation;
- line identity that is stable and monotonic per file generation, shared between live tailing and history reads, so the initial window and the live stream can be merged without duplicates or gaps;
- unterminated trailing lines held briefly rather than split, force-flushed on a bounded timer or size;
- bounded IO: per-tick read caps, bounded backward alignment scans, file handles held only while there are bytes to read, and passive identity-only tracking when no viewer is attached.

Delivery is one server-sent-events connection carrying all services' lines; the client filters visibility locally so toggling services never drops the connection. On reconnect the client resets, refetches initial windows, and shows a "connection restored" marker instead of pretending nothing was missed.

## Requirements

- Tail every discovered source (admin-tools/010) with the semantics above; expose an initial-window read (bounded line count) plus the shared live stream, both using the same line-identity scheme.
- Client-side buffer with: identity-based deduplication across initial/live/history merges; bounded eviction that is softer while following and stricter while scrolled back so text being read never shifts away; pause with bounded buffering and an explicit "N lines skipped while paused" marker when the bound is exceeded.
- Unified view across all services and a focused per-service view; per-service visibility toggles that filter locally without reconnecting; each service gets a stable, deterministic color badge not dependent on a hardcoded service list.
- Virtualized, bottom-anchored rendering that stays smooth at tens of thousands of buffered lines: exact row virtualization when wrapping is off, measured rows when wrapping is on.
- Follow behavior: following is inferred from scroll position; while scrolled back, a pill shows the count of new lines and returns to live on demand; a status chip states the connection/viewing state (live, connecting, reconnecting, paused, browsing history).
- Terminal color (ANSI) rendering with a toggle, tolerant of malformed sequences, producing a canonical plain-text form that is the single source for copying, filtering, and export; display preferences for wrap, absolute/relative timestamps, and text size, persisted per browser.
- Reconnection is honest: buffer reset, refetched windows, and an inline reconnection marker.
- Heartbeats keep idle connections alive through proxies; disconnecting viewers releases tail resources (reference-counted), returning tailers to passive mode.

## User-Facing Behavior

An operator opens Logs and watches all services stream in one interleaved view, each line badged by service with its timestamp (severity badges arrive with admin-tools/013). Restarting a dev process shows a "log restarted" divider, then fresh output. Scrolling up stops following and a pill counts new arrivals until they jump back to live. Pausing holds the view; resuming either replays the held lines or admits it skipped N. Toggling a noisy service off hides it instantly without touching the connection.

## Interface Contract

- The line record carries: service, generation, stable sequence identity, timestamp metadata, and raw text — the same shape history reads (admin-tools/012) return, so merges are identity-based.
- Marker events (restart, disappear, appear, skipped, reconnected) flow through the same stream and render inline; admin-tools/012's history browsing and admin-tools/013's filtering operate on the same buffer and row model this task establishes.

## Acceptance Criteria

- [x] Live output appears across truncation, rotation/replacement, and disappear/reappear with the correct inline markers and no duplicated or silently dropped lines (verified by identity).
- [x] Initial window plus live stream merge without duplicates; reconnect resets, refetches, and marks the seam.
- [x] Pause honors its buffering bound and reports skips; follow/pill/status behaviors match the states described above.
- [x] Rendering stays virtualized and responsive with a full buffer in both wrap modes; ANSI-styled lines render correctly and copy as plain text.
- [x] With no viewer attached, tailers do not read file content (passive mode), and viewer disconnect releases resources.

## Verification

Pure-logic test suites prove the tail engine's truncate/rotate/reappear/unterminated-line/alignment behaviors and the buffer's dedupe, two-tier eviction, and pause-skip accounting; the panel test suite and workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: Ports the reference panel's live-log core as specified — one SSE connection for all services with local visibility filtering, a byte-derived line identity shared by the initial-window read and the live tail, inline markers for every discontinuity, bounded IO with reference-counted passive tailing, and a two-tier client buffer behind bottom-anchored virtualized rendering.
- Divergences: none in behavior. Two design decisions worth recording for admin-tools/012 and /013: (1) the initial window is defined to end exactly at the tail cursor, which the server aligns when the first viewer attaches, so window and live output abut rather than overlap — deduplication by identity remains the safety net for reconnects and history merges; (2) a truncation is detected by the file shrinking, so a process that truncates and then writes past its previous size between two ticks is not detectable — this bound is documented in `server/core/log-tail.ts` rather than papered over. No dependency was added; virtualization is implemented in-repo (`src/logs/virtual-window.ts`).
- Verification: `npm run test:ops-panel` exit 0 (169 tests, 169 pass), `npm run typecheck` exit 0, `npm run lint` exit 0, `npm run scan:framework-standards:ratchet` exit 0 (0 current findings, 0 new, 0 grown modules; largest new module 314 lines). Browser smoke pass against a temporary log directory confirmed: truncate, rotate, disappear and reappear each rendering their marker inline and in order; ANSI colour rendering; a service toggle hiding output with no new `/api/logs/stream` or `/api/logs/window` request; the status chip moving live -> reconnecting -> live across a server restart; 501 buffered rows rendering 37 mounted DOM rows over a 10020px canvas; scrolling back holding `scrollTop` and the top row fixed while a "7 new lines — jump to live" pill counted arrivals; the pill returning to live at the newest line; and wrap mode measuring rows at 60px with no horizontal overflow and the preference persisted to `localStorage`. The reconnect seam decision (reset, refetch, mark) is proved by `src/logs/stream-session.test.ts` rather than in the browser, because the Vite dev server forces a full page reload when it restarts, which produces a fresh mount instead of a pure EventSource reconnect.
