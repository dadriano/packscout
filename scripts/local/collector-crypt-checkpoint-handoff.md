# Local Collector Crypt 100 → 1,000-record checkpoint handoff

This is a reviewed, one-provider local transition from Collector configuration 2
(`dataforrest-launch-distributed-adapter-v1`, 100 records) to a new immutable
configuration 3 (`dataforrest-collector-crypt-distributed-adapter-v1`, 1,000 records).
The 8 MiB response ceiling, endpoint/platform, source/database credentials, mapper,
identity namespace, codec and opaque continuation value remain unchanged. Only
the cursor envelope's adapter identity and source revision change. No replay,
deletion, generic synchronization, command consumption or process launch occurs.

Scope/removal: this is not a generic configuration compatibility path. Remove the
local transition utility after this review deployment has migrated and its
checkpoint evidence has been retained. Generic higher-revision reset semantics
are deliberately unchanged. Do not use it for a different provider or revision.

## Preconditions

- Run from this worktree with `NODE_ENV=development` and no process/file
  `PACKSCOUT_DATA_API_TOKEN`. The safe root `.env` holds only the existing central
  127.0.0.1:55431 database bootstrap and credential keyring. The bounded gateway
  resolves the provider database credentials centrally and admits only Collector's
  exact 127.0.0.1:55434 node/database/credential/topology tuple.
- An authenticated organization admin must approve the operation. The utility
  verifies the original configuration author's current active admin membership.
  That operator attests the freshly observed Collector worker PID and database
  lease owner. PID existence/absence is extra evidence, not provider identity.
- Choose one operation UUID and reuse it for every phase/retry. Freshly determine
  the old worker PID and exact lease owner; do not copy historical PIDs.
- Keep the normal supervisor and all new Collector workers stopped until the
  final explicit resume/queue succeeds. Do not stop other providers. Do not click
  ordinary Run now during the handoff, and never invoke generic config sync.

## Reviewed phases

Every command uses this prefix (placeholders are nonsecret, not literal values):

```bash
env -u PACKSCOUT_DATA_API_TOKEN NODE_ENV=development node --import tsx \
  scripts/local/handoff-collector-crypt-page-profile.mts MODE \
  --operation-id OPERATION_UUID --old-worker-pid FRESH_PID \
  --expected-worker-owner FRESH_LEASE_OWNER
```

1. Run `MODE=--check-only`. This performs no source HTTP or writes. Review the
   `pause_review` run ID/fence/generation and hash. Run `--pause` with the same
   arguments plus `--review-digest HASH`. It persists the exact run/lease/generation
   intent then uses the authoritative admin pause command. Pages may finish
   naturally; the utility does not kill processes or rewrite a run terminal.
2. Let the owned old process exit normally. A successful preparation requires
   the exact paused run to be either incomplete/`PROVIDER_IMPORT_RUNTIME_UNAVAILABLE`
   or failed/`PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING`, its original lease cleared,
   no active run/actionable command/other SQL transaction, and a committed `more`
   cursor matching runtime + final run + last page. Reaching source head or an
   unrelated failure refuses this transition. Run `--check-only` again and review
   the stable `previous_prepare_review` checkpoint hash.
3. Run `--prepare --review-digest HASH`. It performs one authenticated, bounded
   **saved-cursor** source request at limit 1,000 and verifies exact status 200,
   strict Collector wire records, 1,000 records, `more`, and ≤8 MiB. The proof is
   wire/continuation compatibility, **not canonical mapping or import success**.
   No returned page is committed. Protected body bytes are erased and the token
   reference is dropped; JavaScript strings cannot be reliably zeroized.
4. Preparation stages an inactive central revision plus truthful source/paused-DB
   proof; acquires the normal import lease; locks lease → old run → runtime;
   atomically updates only cached configuration and re-envelopes the cursor while
   paused; then activates central with exact CAS **last**, while holding those
   provider locks again. Old run/page/quarantine/canonical history is untouched.
5. Run `--check-only`, review `resume_review`, then explicitly run
   `--resume --review-digest HASH`. This uses the authoritative resume and manual
   Run now repositories with deterministic command/run IDs. It creates one new
   run carrying the re-enveloped saved cursor. Only then launch the dedicated
   single-provider Collector worker. Verify actual first 1,000-record commits,
   IDs/cursor lineage, accepted/duplicate/quarantine counts and page latency.

## Interruption and failure behavior

- A caught preparation failure never resumes the provider. Central staged/local
  old, or central old/local prepared, are recoverable with the same operation.
  Re-run `--check-only` for a fresh review hash, then `--prepare`. Local prepared /
  central old deliberately makes ordinary sync reject a downgrade instead of
  clearing progress. Do not repair it with direct SQL or ordinary Run now.
- If the preparation process dies holding its utility lease, only that exact
  operation's expired lease may be fenced through the existing lease repository,
  and only with intact pause + staged checkpoint receipts. A live lease or another
  owner's lease refuses. Nothing clears or steals the original runner's lease.
  This also applies if central activation committed before the process died:
  check-only first exposes preparation cleanup, then resume review after release.
  Acquisition uses the existing repository's expired-lease fencing semantics,
  not an atomic expected-owner-CAS API. The no-new-workers precondition matters;
  subsequent locked receipt/ledger/cursor checks refuse unexpected concurrent work.
- Resume and queue are separate existing repository transactions. A crash after
  resume but before queue leaves **idle**, with a durable resume receipt and no
  utility-started worker. Repeat the same `--resume` operation: it revalidates the
  unchanged cursor and queues once using the original post-resume generation.
  Do not issue a second resume or start a worker before queue acknowledgement.
- After queue acknowledgement (even if output was lost or the worker has started),
  the same operation recognizes only its exact command/run/config/requested-cursor
  hash and returns `already_queued`. It does not create another attempt.
- Any changed authority, wrong generation/cursor/fence, unexpected native response,
  nonlocal route, config expiry, head, or malformed proof fails closed. Output is
  bounded IDs, counts, status codes and hashes, never credentials, payloads or raw
  cursors. There is no automatic fallback, origin reset or source retry loop.

## Verification

```bash
node --test scripts/local/collector-crypt-checkpoint-handoff-*.test.mjs \
  scripts/local/handoff-collector-crypt-page-profile.test.mjs
npx tsc --noEmit --strict --allowJs --module nodenext --moduleResolution nodenext \
  --target es2023 --esModuleInterop --allowImportingTsExtensions --skipLibCheck \
  scripts/local/handoff-collector-crypt-page-profile.mts
npm run scan:framework-standards:ratchet
```

These tests use synthetic/fake boundaries, not live activation evidence. Root
integration owns the full `npm run verify:framework` and separately approved live
execution. The implementation lane must not invoke a live phase while testing.
