# Provider pulse acceptance map

The admin Status page (`/operations`) summarizes the registered provider sources.
The Providers page keeps its existing configuration and operations view.

## Measurement definitions

- **Stored rows** is the exact sum of categories, packs, collectibles, name aliases,
  collectible instances, pack contents, provider accounts, pulls, pull items, and
  market events. Retired rows remain stored. Operational tables, release history,
  and promotion history are excluded. This is not a count of unique collectibles.
- **Records processed / accepted** covers all retained import runs, including
  repeated source records across runs. Accepted records are not inserted rows.
- **Recent rate** appears for an in-progress run and uses the change in its
  processed-record count between displayed status snapshots, over up to 60
  seconds of observations. It is separate from the lifetime run average and does
  not count new stored rows. Sampling starts after at least five seconds; gaps,
  failures, pauses, and run changes reset the observation window. No extra
  database query is required.
- **Last committed page** comes from committed page evidence, not a run heartbeat.
  Page history and quarantine aggregates share a snapshot cached for up to 60
  seconds. Newer committed pages or quarantine changes may exist after that read.
- **Worker lease** describes the database lease at its measurement time. A valid
  lease alone does not verify an operating-system process or prove data is moving.
- Exact counts and retained-run totals share a snapshot and are cached for 60
  seconds. Runtime and lease evidence refresh every 5 seconds while the page is
  visible. History and lease checks expose separate measurement times. Concurrent
  authorized requests share in-flight history scans and successful cached results;
  failed reads retry on the next refresh. Up to four provider reads run in parallel.
  Missing measurements remain unavailable and incomplete totals remain marked.

## Scenarios and coverage

| Given / When / Then | Coverage |
| --- | --- |
| Given canonical rows and operational history, when totals are read, then only the ten canonical tables contribute and all retained runs contribute to processed/accepted totals. | Automated: `packages/database/src/provider-pulse-metrics-repository.integration.test.ts` and contracts tests. |
| Given a provider, tenant, configuration, or database route change, when measurements are requested, then current authorization/routing applies and the old scoped cache is not reused. | Automated: `apps/admin/server/provider-pulse-measurements.test.ts` and existing authenticated operations route tests. |
| Given repeated or concurrent Status requests, when page and quarantine history is already measured, then the aggregate scan is reused for up to 60 seconds while lease states refresh independently; timestamps disclose the difference. | Automated: measurement reader, repository, and provider pulse page tests. |
| Given a running provider, when fresh progress snapshots arrive, then its card shows recent records/sec; sampling, real zero progress, run changes, stopped runs, and unavailable or stale evidence remain distinct. | Automated: recent-rate helper and Status page tests; browser smoke with changing fixture counters. |
| Given an unavailable database or failed exact scan, when Status loads, then other providers and available runtime evidence remain visible; missing counts are never rendered as zero. | Automated: provider pulse presentation/page tests and measurement reader tests. |
| Given running, paused, failed, stale, and unconfigured providers, when Status renders, then state meanings remain distinct, problems appear first, and secondary facts remain under Details. | Automated: provider pulse presentation/page tests. |
| Given pointer, keyboard, or touch input, when an indicator is activated, then its explanation appears, remains hoverable, and can be dismissed; desktop/mobile layout remains readable. | Automated: `apps/admin/src/components/IndicatorTooltip.test.tsx`. Browser smoke: desktop and mobile, light/dark, Details, refresh pause, partial/empty/failure states. |

## Verification anchor

Run the focused tests above, inspect the Status browser flow at 1440px and 390px
viewport widths, and require `npm run verify:framework` to exit zero. Browser
fixtures do not mutate live providers; database integration tests prove the real
read queries independently. No source import, pause/resume, or publication is
performed against live services during this verification.
