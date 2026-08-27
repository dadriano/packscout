# 001 — Persist and pin the source setting

**Status:** in_progress

## Done when

- Source creation stores 500 by default or the supplied integer from 1 through
  5,000.
- Existing schedule revisions migrate with 250, preserving their prior implicit
  request size until an administrator saves another value.
- A guarded admin save changes only this operational setting; it does not create
  a source test or change lifecycle, cursor, checkpoint, or active work.
- Every new scheduled, manual, continuation, or recovery run pins the setting.
- Every new source-test job pins the setting. Connection-test jobs do not.
- Existing queued and running rows retain their original value after a save.
- Database constraints, service contracts, route validation, and audit evidence
  reject invalid values and preserve organization/source isolation.

## Test map

- Contract boundary tests for default, minimum, maximum, fractional, and
  out-of-range values.
- Repository integration tests for create, revise, run pinning, test pinning,
  migration preservation, and old-work retention.
- Admin route behavior tests for authorization and invalid input.
