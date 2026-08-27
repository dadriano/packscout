# Feature: Provider-source records per request

## Outcome

Administrators can configure how many records each provider source requests per
page. Each newly created source run or source-test job pins the value that was
current when it was created, so later saves do not change queued or running work.

## Progress

**0/3 tasks complete**

| ID | Task | Status | Depends on |
|---|---|---|---|
| 001 | Persist and pin the source setting | in_progress | none |
| 002 | Add the approved admin UX and copy | todo | 001 |
| 003 | Enforce the pin at the provider boundary | todo | 001 |

Tasks 002 and 003 may run in parallel after task 001.

## Fixed decisions

- One setting per provider source, independent of the shared request-concurrency cap.
- Whole number from 1 through 5,000; default 500 for newly created sources.
- Existing source schedules migrate with 250, matching the prior implicit
  runtime value, so deployment alone does not change their next run.
- Existing queued or running work keeps its pin. The next newly created run uses
  the saved value, as do all later runs until the next save.
- Source tests pin the current value when their job is created. A profile-only
  connection test has no source setting.
- Fewer returned records are valid. More than the pin is a fatal page failure;
  that page writes no page, checkpoint, or canonical state, and sibling sources
  continue independently.
- Administrators edit. Data operators may view. There is no global, profile,
  public, per-run, automatic, or inline-overview override.

## Verification

- Focused contract, database, service, worker, admin route, and admin component tests.
- `npm run verify:framework` before handoff.
