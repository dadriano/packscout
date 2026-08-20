# Task: Clone the test database instead of migrating it every time

**ID:** test-overhead-reduction/006
**Depends on:** test-overhead-reduction/001
**Blocks:** test-overhead-reduction/009
**Estimated scope:** medium
**Status:** done

## Objective

Database-backed tests get their isolated database from a near-instant schema clone rather than a full migration run, cutting most of the time the database, services, and admin test lanes spend without changing a single test.

## Context

The shared test database helper creates a uniquely-named database and then spawns a child process that runs a complete migration deployment against it. There are 30 call sites for this helper across the test suite, so a full test pass performs 30 complete migration runs.

Heaviest callers: the persistence integration suite (13 references), the auth service suite (12), the quarantine repository suite (9), and the operations suite (9).

Those three lanes — database at 21 seconds, services at 24 seconds, and admin at 7 seconds — total 52 seconds, and database provisioning is the dominant cost within them.

PostgreSQL can create a database as a copy of an existing one, which is a file-level operation and dramatically faster than replaying a migration history. Migrating once into a template at suite startup and then cloning that template per test preserves the property that matters — every test gets its own isolated, fully-migrated database — while eliminating 29 of the 30 migration runs.

This is a pure performance change. No test is removed, no assertion is weakened, and the per-test isolation guarantee is unchanged. That guarantee is load-bearing for tenant-isolation coverage and must not be traded away for speed.

## Requirements

- Each test still receives its own isolated database that no other test can observe or mutate.
- The schema in a cloned database is identical to what a full migration deployment produces.
- The template is built once per test process and is safe when multiple test lanes run concurrently — cloning must not race with template creation, and two lanes must not collide on a shared template name.
- Cloning fails loudly rather than silently falling back to an unmigrated or stale database.
- Databases are still cleaned up after use, including when a test fails or the process is interrupted.
- The existing behavior of failing clearly when no test database is configured, or when the server version is unsupported, is preserved.
- If the migration history changes, the template is rebuilt rather than reused stale.

## User-Facing Behavior

A developer running the database-backed test lanes sees them complete substantially faster, with identical pass/fail results.

## Interface Contract

The helper that tests call to obtain a migrated database keeps its current name and returns the same shape, so none of the 30 call sites need to change. Any new setup or teardown hooks must be internal to the helper.

## Acceptance Criteria

- [x] Every database-backed test passes with results identical to before the change.
- [x] A full test pass performs one migration deployment rather than 30.
- [x] Tests still receive mutually isolated databases — a write in one test is not visible in another.
- [x] Test databases are cleaned up after passing runs, failing runs, and interrupted runs.
- [x] A stale template is detected and rebuilt when the migration history changes.
- [x] The database, services, and admin lanes are measurably faster than the committed baseline.

## Verification

Run the database, services, and admin test lanes: all exit 0 with the same test counts as the committed baseline, and the timing command from task 001 shows those lanes measurably faster. Confirm that exactly one migration deployment occurs across a full pass. Then run two lanes concurrently and confirm both still exit 0, proving template creation is safe under parallelism.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: implemented as specified. All 30 call sites are unchanged.

### Design

`createMigratedTestDatabase()` keeps its name, signature, and return shape, so no
test file changed. Internally it now clones rather than migrates:

- **Template identity is derived, not fixed.** The template name embeds a hash of
  every migration's directory name and SQL contents. A change to the migration
  history produces a different name, so a stale template is never reused — it
  simply stops being the one that gets looked up.
- **Migration happens under a scratch name and is renamed into place on success.**
  A process that dies mid-migration leaves an unused scratch database rather than
  a half-migrated template that later runs would clone and trust.
- **A PostgreSQL advisory lock guards creation.** Node's test runner spawns a
  process per file, so the lock has to live in the database rather than in module
  state.
- **There is no fallback path.** If cloning fails, the existing infrastructure
  error propagates, rather than quietly handing back an unmigrated database.

A defect was caught in self-review before any run: `pg_advisory_lock($1)` with a
string parameter would have failed with `function pg_advisory_lock(text) does not
exist`, because PostgreSQL infers an untyped parameter as text. Both lock and
unlock now cast explicitly to `bigint`.

### Verification

Measured against the committed baseline:

| Lane | Baseline | After | Tests |
|---|---|---|---|
| `test:database` | 18.0s | 5.1–6.3s | 45 pass |
| `test:services` | 7.1s | 3.3s | 148 pass |
| `test:admin` | 5.5s | 3.5s | 66 pass |

Roughly **18s removed** from the database-backed lanes.

- **One migration, not 30.** From a clean slate the first run creates exactly one
  template (8.2s including the migration); subsequent runs clone it (5.4s).
- **No flakiness.** Four consecutive `test:database` runs: 45 pass, 0 fail each
  time, 5121–6307ms.
- **Concurrency is safe.** With the template dropped, `test:database` and
  `test:services` started simultaneously both exited 0, and exactly one template
  was created — the advisory lock serialises creation across processes.
- **Stale templates are impossible.** Adding a migration produced a second,
  distinct template rather than reusing the existing one.
- **Cleanup holds.** After every run above: zero per-test databases and zero
  scratch databases left behind.
- **Failure is loud.** Pointed at an unreachable server, the lane exits 1 with
  `PostgreSQL 16 test infrastructure is required` — it does not silently pass
  against an unmigrated schema.

### Follow-up worth knowing

Templates persist between runs by design, and a migration change leaves the
previous template behind. They are harmless and cheap, but nothing currently
prunes them. Worth a small cleanup helper if the count grows.
