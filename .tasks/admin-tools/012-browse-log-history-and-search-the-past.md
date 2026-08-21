# Task: Browse Log History and Search the Past

**ID:** admin-tools/012
**Depends on:** admin-tools/011, admin-tools/013
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

Operators can move through a log's past as easily as its present: scroll back indefinitely, jump to the start of a log and read forward, search megabytes of history for a pattern, and export what they found.

## Context

This ports the reference panel's history and export features. The live stream (admin-tools/011) only holds a bounded buffer; diagnosing yesterday's failure means reading the file's earlier content. The reference behaviors to replicate:

- chunked history reads that page backward or forward from a cursor without ever reading the whole file, under a bounded per-request byte budget, returning oversized lines as bounded fragments whose cursors still progress;
- history and live share one line-identity scheme, so prepended history, the live buffer, and forward pages merge seamlessly;
- deep history search that scans backward through file content page by page with live progress, cancellation, and hard caps on matches and scanned bytes — ending with an honest note about where and why it stopped;
- search results that jump into surrounding unfiltered context, centered, so the match is read in situ.

## Requirements

- Scrolling near the top of the log view loads older pages for every visible service and preserves the reader's scroll anchor as content prepends; reaching a file's beginning states so instead of spinning.
- A generation change (rotation/truncation) during history browsing returns the view to live with a marker rather than mixing incompatible generations.
- Jump-to-start (single-service focus): enters a detached forward-browsing mode reading from the beginning, paging forward on demand, ignoring live arrivals until the operator returns to live; a truncation of the browsed service forces an honest return to live. A jump-to-start binding registers into the keyboard-shortcut framework admin-tools/013 provides.
- Deep history search over the currently selected services: runs against the active filter (admin-tools/013) or an entered term, shows live progress (bytes scanned, matches found), is cancelable, and stops at bounded match/byte caps with an explicit note; each result is clickable and loads bounded unfiltered context around the match, centered and highlighted.
- Export: download the currently visible (filtered) lines as a text file named by scope and time; download a service's raw log file as an attachment streamed by the server; per-row copy that copies a collapsed group as its whole group, service-prefixed in the unified view.
- All reads remain bounded and identity-consistent; no history path loads unbounded content into memory, server- or client-side.

## User-Facing Behavior

An operator investigating an overnight failure scrolls up and the log keeps filling in above, their reading position stable. They jump to the log's start to see how the process booted, page forward through the morning, then return to live. Searching "ECONNREFUSED" across two services streams progress, lands 14 matches, and clicking one shows the surrounding raw context centered on the hit. They download the filtered view as a text file for the issue report.

## Interface Contract

- History reads accept a service, direction, cursor, and bounded line count, and return rows in the exact line-record shape of admin-tools/011 plus continuation cursors and an at-boundary indicator.
- Deep search reports progress incrementally and returns match locations addressable by the same line identity, so jump-to-context is a cursor-anchored history read.
- Raw-file export is a server-streamed download; it never buffers the file in memory.

## Acceptance Criteria

- [x] Backward paging fills history for all visible services with stable scroll anchoring, correct merges (no duplicates or gaps by identity), and an explicit start-of-log state.
- [x] Jump-to-start and forward paging work in detached mode, and generation changes during any history browsing return to live with a marker.
- [x] Deep search streams progress, cancels cleanly, respects match/byte caps with an honest stop note, and jump-to-context centers bounded unfiltered context around the selected match.
- [x] Oversized lines return as bounded fragments whose cursors progress (no infinite loop, no unbounded payload).
- [x] Visible-lines export, raw-file download, and group-aware copy produce the expected content.

## Verification

Pure-logic tests prove the history reader's backward/forward chunking, byte budgets, oversized-line fragmenting, and boundary reporting, plus search cap/cancel/progress accounting; the panel test suite and workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: History pages are produced by the tail's own line splitter at the same byte offsets in the same generation, so `line:<service>:<generation>:<offset>` identity is shared across the initial window, the live stream, prepended scrollback, forward paging, and search results; every read is bounded by a byte budget and a line cap, and every returned cursor strictly progresses.
- Divergences: Deep search matching runs in the browser rather than on the server. The task requires the search to run against the *active compiled filter* and forbids a second matcher, and `compileFilter`/`readLineFacts` live in the client; the server therefore only serves bounded backward pages and the client applies the identical compiled filter, which removes any possibility of the search and the pane disagreeing. Bounding is unchanged — the scan is capped by matches, by total bytes, and by cancellation, and only the current page plus capped matches are ever held. The raw download is streamed by the server and never buffered there; the browser materialises the blob only to save it, because `/api/logs/download` is deliberately excluded from the EventSource header exemption and so cannot be a plain navigation. One adjacent fix was required for correctness: `logs/log-view.ts` now keeps panel-scope markers visible when a single service is focused, otherwise the return-to-live seam marker this task raises would be filtered away.
- Verification: `npm run test:ops-panel` -> EXIT 0 (513 tests, 513 pass); `npm run typecheck` -> EXIT 0; `npm run lint` -> EXIT 0; `npm run scan:framework-standards:ratchet` -> EXIT 0 (0 findings, 0 new, 0 grown modules). Additionally exercised against a running panel: backward paging to the true start of a 2,002-line log (0 duplicate rows, scroll anchor held the reader's row across each prepend), jump-to-start via the `g` binding, deep search with a live filter into unfiltered centred context, raw download headers and the 403 without the panel header, and a mid-browse truncation returning the view to live with the generation-change marker rendered inline.
