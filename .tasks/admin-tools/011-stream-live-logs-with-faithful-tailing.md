# Task: Stream Live Logs with Faithful Tailing

**ID:** admin-tools/011
**Depends on:** admin-tools/010
**Blocks:** admin-tools/012, admin-tools/013
**Estimated scope:** large
**Status:** todo

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

- [ ] Live output appears across truncation, rotation/replacement, and disappear/reappear with the correct inline markers and no duplicated or silently dropped lines (verified by identity).
- [ ] Initial window plus live stream merge without duplicates; reconnect resets, refetches, and marks the seam.
- [ ] Pause honors its buffering bound and reports skips; follow/pill/status behaviors match the states described above.
- [ ] Rendering stays virtualized and responsive with a full buffer in both wrap modes; ANSI-styled lines render correctly and copy as plain text.
- [ ] With no viewer attached, tailers do not read file content (passive mode), and viewer disconnect releases resources.

## Verification

Pure-logic test suites prove the tail engine's truncate/rotate/reappear/unterminated-line/alignment behaviors and the buffer's dedupe, two-tier eviction, and pause-skip accounting; the panel test suite and workspace typecheck exit 0.
