# Local Courtyard native-card checkpoint handoff

One approved transition: config1 `2b986eb0-3faf-50bc-a29b-56aaf60c75c0` → immutable config2
`dataforrest-courtyard-distributed-adapter-v1`, at the exact failed run
`714393a7-2610-49a4-89e6-34f00eb01e65` checkpoint. The failure remains
`PROVIDER_DATAFORREST_INVALID_RESPONSE` at `2026-08-30T03:41:16.245Z`, fence74,
8,073 committed pages, 807,129 accepted and171 quarantined records. All74 old
attempts, pages, canonical rows and quarantines remain untouched. There is no
origin replay; the171 historical quarantines are not retried by this transition.

The new profile retains100/page,8MiB,10s, endpoint/platform, credential ownership,
record_id identity, namespace/scopes and cursor codec/generation. Its reviewed
native-card readers support asset.title/reveal.title. Only adapter identity and
configuration revision change in the saved cursor envelope; the opaque value is
identical. No generic configuration synchronization/reset is invoked.

## Operation

Root/operator owns all live execution. Keep new Courtyard workers/supervisors
stopped until queue acknowledgment; do not use ordinary Run now/config sync during
handoff. Other providers are outside this utility's scope. The existing central
127.0.0.1:55431 bootstrap/keyring is used; provider location/credentials remain
central-only. Only the exact Courtyard127.0.0.1:55433 route is admitted. No
process/file bearer or unverified old-PID argument is accepted. The original
configuration author must still be an active organization admin.

Reuse this operation UUID across every phase and retry:

```bash
env -u PACKSCOUT_DATA_API_TOKEN NODE_ENV=development node --import tsx \
  scripts/local/handoff-courtyard-native-profile.mts --check-only \
  --operation-id 1dd59a1b-79c2-4b18-a881-edafe7b897dd
```

1. Review `terminal_failure_pause_review`. Repeat with `--pause` and the returned
   `--review-digest HASH`. A durable, generation/row-version/history-bound intent
   records that the failure **predates** this authorized error→paused command.
   This is not fabricated clean-pause provenance. Runtime becomes generation3.
2. Run `--check-only` again; review `previous_prepare_review`. Run `--prepare`
   with its digest. This is the only phase that calls the source: one bounded
   authenticated request at the saved cursor. It must return100 records, more,
   status200, ≤8MiB, and pass the exact production parser/normalizer/mapper plus
   collectible validation: at least80 canonical-valid cards, at most20 separately
   classified canonical missing-display-name rejects, and a total of exactly100.
   Each permitted reject must have neither asset nor reveal key on the same
   positionally bound envelope record, wholly absent normalized card facts, a
   null mapped display name, and exactly the production missing-name draft guard.
   Empty/null/malformed wrappers, other draft/validation errors, normalization,
   mapping and projection failures still refuse. `mapperQuarantined` stays zero;
   `canonicalMissingDisplayNameRejected` and `canonicalQuarantineClass` disclose
   this known canonical rejection separately, without claiming an import commit.
   This untrusted inspection grants no completed-request/page/native-evidence
   capability and commits no fetched record. Protected bytes are erased; the
   plaintext token reference is dropped (JS strings cannot reliably be zeroized).
3. Preparation stages inactive central config2 plus truthful proof; acquires the
   normal import lease and locks lease→oldrun→runtime; commits cached config2 and
   the re-enveloped cursor while paused; then activates central **last**, under
   a second exact provider lock and central row-version CAS. Whole-run-history,
   ledger and quarantine digests must still match. No old-run row is updated.
4. Run `--check-only`; review `resume_review`. Run `--resume` with its digest.
   The authoritative resume command reaches generation4; an atomic cursor-bound,
   no-other-active-run manual request queues exactly one deterministic new run.
   This utility starts no process. Root may now start only the Courtyard lane and
   verify actual committed pages, accepted/duplicate/quarantine counts and lineage.

## Interruption and refusal

- Preparation failures leave paused. Central-staged/local-old and local-prepared/
  central-old phases resume under the same operation. Central-last ordering makes
  ordinary sync reject the intermediate downgrade rather than clear progress.
- After a process dies with its utility lease, only the same operation's expired
  lease with intact stage/pause/history receipts may be reclaimed through the
  existing fenced lease repository. Live/foreign leases refuse. If activation
  committed before release, check-only exposes preparation cleanup before resume.
  This uses ordinary expired-lease acquisition, not an expected-owner-CAS API;
  the no-new-workers precondition and subsequent locked revalidation are required.
- Resume-before-queue interruption leaves idle with a durable resume receipt.
  Repeat the same reviewed resume; it queues using the original generation4 and
  exact cursor, without issuing another resume. Already queued/running/terminal
  operation-owned runs are recognized before paused guards and never duplicated.
- Changed config/credential/topology/operator authority, extra work, changed
  generation/history/cursor, source head or mapping failure refuses. No direct
  SQL cleanup, lease clearing, deletion, reset or fallback is provided.

## Checks and scope

```bash
node --test scripts/local/courtyard-checkpoint-handoff-*.test.mjs \
  scripts/local/handoff-courtyard-native-profile.test.mjs
```

Tests use fake transport/database boundaries; the central fixture mocks hashing
only for one synthetic old envelope so no protected live cursor is needed. Real
hashing and exact re-enveloping are tested separately. Actual source canary and
new-run commits remain live acceptance evidence, not unit-test claims. Root runs
the final `npm run verify:framework` after all lanes freeze.

Remove this narrow local transition after this deployment has migrated and its
evidence is retained. It is not a generic provider compatibility path. Output is
safe IDs/counts/hashes only; no credential values, raw bodies or cursor values.
