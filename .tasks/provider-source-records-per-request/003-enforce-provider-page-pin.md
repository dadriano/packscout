# 003 — Enforce the provider page pin

**Status:** todo

## Done when

- Source-test and page-read operations use their durable pin as the requested
  provider limit. Profile-only connection tests do not gain a source pin.
- The generic adapter operation remains source-neutral and supports values from
  1 through 5,000 without changing shared concurrency accounting.
- A response with fewer or exactly the pinned number of records is accepted.
- A response over the pin becomes a fatal source page failure with safe
  diagnostics and no page, cursor/checkpoint, canonical, or EV writes.
- An over-limit failure in one source lane does not stop a sibling lane.
- Capacity admission reserves the largest legal 5,000-record/maximum-byte page
  while initial-backfill page overhead still reflects existing sources' 250
  records-per-request migration value.

## Test map

- Adapter URL and interpretation tests for minimum, default, maximum, fewer,
  exact, and over-limit responses.
- Worker executor/runtime tests proving the pinned value flows end to end and
  over-limit work fails locally without sibling interruption or atomic writes.
- Capacity artifact and memory tests for the maximum request envelope without
  understating the preserved 250-record initial backfill.
