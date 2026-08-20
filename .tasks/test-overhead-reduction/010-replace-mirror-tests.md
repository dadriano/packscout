# Task: Replace mirror tests with invariant assertions

**ID:** test-overhead-reduction/010
**Depends on:** none
**Blocks:** test-overhead-reduction/012
**Estimated scope:** medium
**Status:** done

## Objective

Tests that copy their source module's contents verbatim are rewritten to assert the properties that actually matter, so editing user-facing copy stops breaking the build while the real guarantees stay proven.

## Context

Two frontend test files transcribe the entire contents of the module they test into the test as a literal expected value and compare with a deep equality assertion. A test constructed this way cannot detect a defect — the assertion passes if and only if the source is unchanged, so it detects *edits*, not *bugs*.

These files are the direct cause of all 7 currently-failing frontend tests, out of 158. The branch changed user-facing copy; the mirrors did not change with it.

The duplication compounds. The metric vocabulary test mirrors all 15 glossary entries. The learn content test mirrors three guide records *and re-mirrors* several of the same glossary strings the first file already asserts. Changing one word of a definition therefore requires three synchronized edits across two test files and one source file, with a failing build as the only reminder.

Critically, these files are not worthless — one assertion inside them is genuinely load-bearing. The metric vocabulary test proves that no public-facing message ever contains its own internal reason code, checked across every entry in the reason map. That is a real invariant protecting the fail-closed reason mapping from leaking internals to users, and it must survive this task.

The distinction to apply: assert properties that must hold for any correct value, not the specific values themselves. "Every glossary entry has a non-empty label and definition" is a test. "The glossary equals this exact 15-element array I copied from the source" is a change detector.

## Requirements

- No test asserts equality against a literal transcription of a source constant.
- The invariants those tests should have been proving are asserted instead, covering at least: every entry has the required non-empty fields; the set of keys matches the canonical field set the application relies on; entries that must link to supporting documentation do so; and no public-facing message contains its internal reason code.
- The internal-reason-leak check is preserved with equal or broader coverage than today.
- Editing user-facing copy does not fail these tests, but removing a required field, dropping an entry the application depends on, or leaking an internal code still does.
- The same strings are not re-asserted across multiple test files.
- All 7 currently-failing frontend tests pass, and no other frontend test regresses.

## User-Facing Behavior

A developer editing product copy runs the frontend tests and they pass, because copy wording is not what those tests are for. A developer who accidentally removes a glossary entry the comparison table depends on sees a failure.

## Interface Contract

The source modules under test keep their current exported names and shapes — this task changes tests, not the modules they cover. Task 012 cites the rewritten files as the reference example when codifying the rule, so the resulting tests should read as a clear model of the pattern.

## Acceptance Criteria

- [x] Neither test file compares against a literal copy of a source constant.
- [x] The internal-reason-leak invariant is still proven across every reason entry.
- [x] Required-field, canonical-key-set, and documentation-link invariants are proven.
- [x] Changing the wording of a definition does not fail the tests.
- [x] Removing a required entry or field does fail the tests.
- [x] The frontend test lane passes in full (157 tests). See the divergence note below regarding the "158 including the 7 failing" wording.
- [x] The same assertions are not duplicated across the two files.

## Verification

Run the frontend test lane and confirm all tests pass, including the 7 currently failing. Then make two temporary edits in sequence: reword a glossary definition and confirm the tests still pass; delete a required glossary entry and confirm the tests fail. This proves the tests now detect defects rather than edits.

## Spec Compliance

- Related specs reviewed: none (no `tech-*.md` or `ux-*.md` companion specs exist for this feature)
- Alignment: implemented as specified. Both files now assert invariants instead of transcribing source constants.

### What replaced the mirrors

The key insight during implementation was that the repository already exposes the
real contracts at runtime, so nothing needed restating in the tests:

- `ALL_REPACKS_HEADERS` (`lib/all-repacks-table.ts`) enumerates every comparison
  table column. Resolving each one through `getGlossaryDefinition` proves the
  cross-module contract — a missing glossary entry breaks a column at runtime and
  now fails a test.
- `LEARN_GUIDE_SLUGS` is the routing contract for `/learn/[slug]`. Comparing it
  against the published guides proves both directions: no slug without a guide,
  no guide without a slug.
- `EXPECTED_VALUE_METRIC_KEYS` resolves through the glossary, proving Learn and
  the Dashboard cannot describe the same metric differently — which is what the
  old duplicated copy block was trying and failing to guarantee.
- The internal-reason-leak check was **broadened**, not preserved as-is. It now
  matches any SCREAMING_SNAKE token in any public string, so a leak from any
  boundary is caught rather than only a reason leaking its own name.

### Divergences

- **"All 158 frontend tests pass, including the 7 that fail today" could not be
  met as written.** Those 7 failing tests do not exist at `HEAD`, which is where
  this worktree branched. They exist only in the uncommitted working tree of
  `codex/frontend-catalog-polish`, which added 7 tests that fail against edited
  copy. At `HEAD` the lane was 151 tests, all passing; after this task it is 157,
  all passing. The structural cause of those 7 failures is exactly the mirror
  pattern removed here, so rebasing that branch onto this work should resolve
  them — but that could not be verified from this worktree and is not claimed.
- **The estimated line saving did not materialise.** The task context predicted
  "~262 lines become ~60". Actual: 262 → 281 lines. The rewrite trades literal
  transcription for more granular tests (13 versus 8) with per-entry failure
  messages and comments explaining each invariant. The win is decoupling from
  copy, not line count. The plan's line-saving estimate for this task was wrong
  and should not be carried into task 012's expectations.

### Verification

- `npm run test:frontend` — 157 tests, 157 pass, 0 fail
- Copy-edit probe: reworded a glossary definition and a guide title → 157/157 still pass
- Deletion probe: removed the `topChase` glossary entry → 2 failures, in both the
  column-contract test and the cross-module Learn test
- `npm run typecheck:frontend` — exit 0
- `npm run lint:frontend` — exit 0
- Source modules confirmed unmodified (`git diff` empty for both)

## Update after merging origin/main

`main` advanced substantially while this branch was in flight (PR #12, "Publish
source-backed Learn articles"). The merge changed this task's outcome in two
opposite directions, both worth recording.

### The learn-content half was superseded and must be redone

`learn-content.ts` was rewritten: `LEARN_GUIDE_SLUGS`,
`EXPECTED_VALUE_METRIC_KEYS`, `getLearnMetricDefinitions`, and
`PACKSCOUT_EV_METHOD` no longer exist, and the guide shape changed to
`cardTitle` / `summary` / `intro` / `sections[].blocks` across four articles.

The invariant rewrite of `learn-content.test.ts` referenced four deleted exports,
so `main`'s version was taken wholesale rather than guessed at. That version
carries real, load-bearing coverage this branch must not weaken — source-fidelity
checks, minimum word counts, and required regulatory phrases including the
problem-gambling helpline. It also still contains a mirror block
(`assert.deepEqual` over slug, `cardTitle`, and `readingTimeMinutes`).

**Re-applying the invariant treatment to the new `learn-content.test.ts` is
outstanding work**, and should be folded into task 012's scope or a follow-up.
It was not attempted here because inventing content requirements for articles
this branch did not author would be guesswork.

### The metric-vocabulary half survived, and `main` proved the point

Every contract that rewrite depends on — `COMPARISON_GLOSSARY`,
`PUBLIC_REASON_COPY`, `METRIC_TRUST_COPY`, `getGlossaryDefinition`,
`ALL_REPACKS_HEADERS` — still exists, so the invariant tests were kept.

More usefully, `main`'s own change to the old `metric-vocabulary.test.ts` is a
textbook demonstration of the problem: **10 insertions and 10 deletions, every
one a copy edit transcribed into the test.** Someone reworded
`"PackScout Gross EV minus Repack Price"` to `"Gross EV minus Repack Price"` in
the source and had to make the identical edit in the test. That is the coupling
this task removes, evidenced from the repository's own history rather than
argued from principle.

### A correction to my own work

The merge exposed an over-strict assertion I had written:

```
dashboardDisclaimer.includes(estimateLabel)
```

`main` changed the label to `"Estimated EV"` and the disclaimer to
`"EV · Estimated · Not financial advice."`. Both still express the same thing,
but the label is no longer a contiguous substring, so the assertion failed. It
was a copy assertion wearing an invariant's clothes — precisely the mistake this
task exists to prevent, committed while fixing it. It now asserts that both
strings name the metric and that the disclaimer signals estimation, which is the
property that actually matters.

### The deliberate exception: compliance copy stays pinned

One containment assertion was kept strict on purpose: the dashboard disclaimer
must contain `financialDisclaimer` verbatim. That is compliance text, not
product prose, and pinning one short legally-meaningful string is worth the
friction — rewording it should require a deliberate test change.

The resulting policy is coherent and verified:

- Editing **content** copy — three glossary definitions reworded — passes 175/175.
- Editing **compliance** copy — the financial disclaimer — fails, by design.
- Deleting a glossary entry the comparison table depends on still fails.

### Verification after merge

- `npm run test:frontend` — 49 files, 175 tests, 0 failures.
- `npm run test:tooling` — 22 files, 194 tests, 0 failures.
- Content-copy probe passes; compliance-copy and deletion probes fail as intended.
- Source modules confirmed unmodified after every probe.
