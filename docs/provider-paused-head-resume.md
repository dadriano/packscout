# Reviewed resume from an intentionally paused source head

This local operator utility adopts one already successful, reconciled source-head run under a **new operation and freshly validated remote authority**. It implements an explicitly requested Resume after a migration without reusing historical authority receipts or replaying import history. It does not apply migrations, change configuration, queue runs, call a provider source, start services, or promote to Convex.

A user release is a prerequisite. A prior recovery grant does not release an intentional pause. Other provider holds remain independent. This procedure cannot adopt a failed, incomplete, running, quarantined, or unreconciled parent; those states require their own reviewed procedures.

## Review boundary

Prepare a private, owner-readable JSON review matching `pausedHeadReviewSchema` in `scripts/local/provider-paused-head-policy.mts`. Never include credentials, provider payloads, or raw source cursors. Its fields bind:

- Exact clean committed checkout and an absolute migration handoff artifact path with its SHA256. A changed or untracked source tree fails closed.
- Explicit remote runtime mode; exact central and provider host, port5432, logical database names, and verified TLS. `verify-full` is the semantic review pin; native `sslmode=require&sslaccept=strict` is also accepted by the existing strict-TLS runtime policy. Duplicate or weaker TLS options are refused.
- Organization, provider key/identity, operator membership, active configuration ID/number, exact authority digest and fresh new operation pins. The new initial run is the latest successful head run. Historical operation IDs may not be reused.
- Original continuous-operation receipt digest, completed Pause command ID/digest, paused generation, runtime row version and released import fence.
- Latest parent digest, complete head-reconciliation proof digest, and exact checkpoint hash. The complete cursor is validated in memory against the parent and its hash; it is not printed or added to the new receipt.

The maintenance owner must independently review migration evidence, verify all required schema/index/constraint state, and verify all old resident jobs are stopped/inhibited. The utility checks the handoff artifact's bytes; a file digest alone is not proof of database readiness or user authorization.

## Control sequence

Use the verified isolated checkout. Do not modify a serving checkout or reuse an old local-runtime operation receipt. Keep all historical jobs inhibited throughout adoption. With the private review outside Git:

```sh
node --import tsx scripts/local/provider-paused-head-resume.mts --review-file /absolute/private/review.json --check-only
```

Check-only performs bounded read-only central/provider checks with local ten-second statement timeouts and emits a sanitized `reviewDigest`. Read transactions and custom adoption transactions use the shared transaction-draining helper; a timeout never closes owned resources before the callback settles. It acquires no worker lease, creates no residency claim, makes no source requests and writes no database records. It refuses active source/import/promotion processes, active or actionable database work, foreign leases, wrong authority and checkpoint/history drift. Known generic worker/source entrypoints are refused conservatively; an ambiguous `src/index.ts` process requires operator investigation.

After reviewing that exact digest:

```sh
node --import tsx scripts/local/provider-paused-head-resume.mts --review-file /absolute/private/review.json --apply --review-digest REVIEW_DIGEST
```

Apply takes the existing per-provider local residency lock and repeatedly checks process/central authority. It locks the normal import lease, parent and runtime in a serializable transaction, validates the reviewed state and writes one immutable adoption receipt. It then acquires a normal fenced import lease and records that claim in the same serializable transaction using the public transaction-bound lease helper. A failed audit insert rolls back the acquisition and fence advance.

Resume uses the public command repository's optional `expectedRuntimeGuard`. This caller-requested security guard checks the live held lease/fence, at least a full command-transaction budget remaining on the lease and the caller’s ephemeral deadline, exact paused generation/row version/configuration, full checkpoint, completed Pause provenance and latest run **inside the same transaction as the normal audited Resume**. A mismatch returns `RUNTIME_RESUME_GUARD_CONFLICT` before command or runtime writes. A fresh database clock after evidence reads checks the remaining admission budget; a slow preflight cannot extend it. The CLI bounds this deadline by the outer gateway budget as well as the callback start. Ordinary command callers retain their existing semantics; no provider-specific branch or retry was added.

The utility verifies idle state, generation and runtime row version advanced once, unchanged checkpoint/history, and a completed deterministic Resume command. It writes one immutable completion receipt and releases its own lease. The original parent, pages, audits, quarantine and promotion ledger are unchanged.

## Handoff and crash recovery

Successful adoption ends at idle, before any queued work. Do **not** issue a bare Run-now. The existing continuous poller must start with the exact new operation pins, the reviewed successful head as `initialRunId`, and `bootstrap=false`. Its existing fresh-cycle audit and fenced queue admission own the next independent scheduled run. Do not copy polling behavior into the adoption utility. Maintenance separately validates actual durable progress, reconciliation and subsequent scheduled polling; adoption itself proves none of those later outcomes.

An interruption after the adoption receipt or after Resume is replayable only with the identical review/receipt and unchanged boundary. A new fenced lease may be used, but the semantic guard audit, deterministic Resume command and history must match. No duplicate Resume, run or completion receipt is created. An expired lease can only be reacquired for this same operation with the reviewed/audited fence provenance. A live lease, unknown fence, foreign receipt or later operator control fails closed. Do not retry an unknown refusal repeatedly.

Acquisition and the claim audit commit together. A failure before commit leaves the prior released fence intact; a committed acquisition always has its matching claim receipt. Only the exact last audited fence can be released or reacquired after expiration. The utility does not repair lease state by SQL.

Once the poller has advanced run/history/runtime state, this utility is no longer applicable and fails the exact review boundary. Its previous completion evidence remains historical; it must not become a new resume/replay authorization.

## Acceptance map

| Behavior | Coverage |
| --- | --- |
| Read-only review; single audited Resume; no queue/source/history mutation | Automated: `scripts/local/provider-paused-head-control.test.mjs` |
| Atomic acquisition/claim rollback; receipt-before-Resume and Resume-before-completion crash recovery | Automated: same test file, crash-gap scenario |
| Pause/config/authority/parent/cursor/history/live-lease drift | Automated: same test file, preflight refusal matrix |
| Lease expiry/fence/cursor/config/pause/latest-run race at command transaction entry | Automated: same test file, direct public command repository scenario |
| Exact guard-audit replay under new lease; later Pause remains authoritative | Automated: same test file, guarded replay and later Pause scenarios |
| Strict native TLS, exact remote destinations, CLI action grammar | Automated: `scripts/local/provider-paused-head-resume.test.mjs` |
| Process exclusion, private permissions, symlink and size rejection | Automated: same CLI test file |
| Private-file foreign ownership | Manual gap: enforcement checks UID; changing file ownership is not available in the unprivileged fixture |
| Fresh real database identities, migration/schema validity, exclusive process proof and user release | Operational evidence required from maintenance owner; no test fixture proves live readiness |
| Actual future source import, reconciliation, promotion and next polling cycle | Separate operational validation after an authorized launch; not performed by this utility |

Run focused tests while changing this utility, then `npm run test:tooling` and the canonical `npm run verify:framework` before deployment. Never weaken the gate or historic local-only utility guards to activate this path.
