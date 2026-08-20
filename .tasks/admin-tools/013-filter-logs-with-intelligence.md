# Task: Filter Logs with Intelligence

**ID:** admin-tools/013
**Depends on:** admin-tools/011
**Blocks:** admin-tools/012
**Estimated scope:** large
**Status:** todo

## Objective

Operators can cut the log stream down to what matters — by text, pattern, and severity — with the panel understanding lines well enough to classify levels, extract timestamps, fold stack traces, and point at which services are erroring right now.

## Context

This ports the reference panel's filtering and line-intelligence layer. Logs are plain text (the panel is deliberately not JSON-log-aware); intelligence is heuristic and must degrade gracefully. The reference behaviors to replicate:

- composable filtering: a live draft term that matches as typed, plus committed chips, each independently include or exclude, literal or regular expression, case-sensitive or not; all includes must match, any exclude vetoes, and the severity facet must admit the line;
- regex safety: bounded pattern length and a compile-time complexity probe that rejects catastrophically slow patterns with a clear message; invalid patterns error inline without breaking the view;
- line intelligence: severity classification (error/warn/info/debug/unknown) tolerant of symbols and prefixes; timestamp extraction from common formats with plausibility bounds, falling back to arrival time marked approximate; continuation-line detection folding stack traces into collapsible groups under their head line, the head carrying the group's maximum severity, a group visible when any member matches;
- the filter state is shareable: the whole view (focused service, filter, surface) is URL-addressable, and an undecodable filter in a pasted URL degrades to unfiltered with a dismissible notice.

## Requirements

- Filter bar with draft-as-you-type matching, committed chips, per-chip include/exclude, literal/regex, and case toggles; a live "N of M lines" match count; match highlighting in rendered rows, correct even within color-styled text; recently used searches offered for reuse, bounded and persisted per browser.
- Severity facet with per-level toggles and a one-click errors preset (errors + warnings); severity classification, timestamp extraction, and continuation grouping as described in Context, implemented as pure, unit-tested logic.
- Collapsible continuation groups: collapsed by default under their head with a member count, expandable in place; expanding shows which members matched; per-row copy (admin-tools/012) copies whole groups.
- The regex guards from Context, with inline, non-blocking error presentation.
- Source rail: every discovered service listed with a liveness indicator (actively writing, quiet, stale), file size, relative last-write time, an observed lines-per-minute rate, and a recent-error count chip that, when clicked, focuses that service with the errors preset applied; per-service visibility checkboxes; rates and error counts derive only from lines observed while the panel is open — no fabricated history.
- URL-addressable state for surface, focused service, and filter, with browser history behaving sanely (view changes push, filter edits replace, back/forward re-apply); bounded per-browser persistence for preferences (hidden services, display settings, recent searches) with a single reset that clears them all after confirmation; transient run-state (pause, scroll position) is never persisted.
- Keyboard shortcuts for the core loop — focus filter, pause/resume, jump to live, previous/next service, all services, toggle wrap, help — guarded against firing while typing, with a discoverable help dialog and a framework later bindings can register into (admin-tools/012 adds jump-to-start).

## User-Facing Behavior

An operator types "quarantine" and the stream thins as they type; they commit it, add an exclude chip for a noisy poller, and switch on the errors preset — the count reads "37 of 12,405 lines". A stack trace occupies one collapsible row with its worst severity, expanding to show the frames and which matched. The worker's rail entry shows a red 12-error chip; clicking it jumps straight to that service's errors. They copy the URL into team chat, and a teammate opens the same filtered view.

## Interface Contract

- Filtering and intelligence operate on the canonical plain-text line form and row model from admin-tools/011, and deep history search (admin-tools/012) reuses the same compiled filter semantics so live filtering and history search can never disagree about what matches.
- Classification, grouping, filter compilation, and URL codec are framework-free modules other surfaces can reuse.

## Acceptance Criteria

- [ ] Chips, draft term, case/regex/include-exclude toggles, severity facet, and errors preset compose with the documented semantics, with live match counts and correct highlighting.
- [ ] A catastrophically slow or invalid pattern is rejected inline without degrading the stream.
- [ ] Stack traces fold into groups with head severity, group-level match visibility, and in-place expansion.
- [ ] The source rail shows liveness, size, last write, line rate, and error chips, and the error chip jumps to that service's errors view.
- [ ] A shared URL reproduces surface, focus, and filter; an undecodable filter degrades gracefully; preference reset clears everything persisted; shortcuts work and stay out of text inputs.

## Verification

Pure-logic test suites prove filter compilation semantics (include/exclude/case/regex composition), both regex guards, severity/timestamp/continuation classification, group folding and visibility, and the URL state codec round-trip including the undecodable-filter fallback; the panel test suite and workspace typecheck exit 0.
