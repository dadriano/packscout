# Reviewed peer processes during a provider head control

The default head-control process guard refuses recognized import, control and
promotion writers. An operator may allow existing workers for other providers
without stopping them, using an explicit, short-lived proof. This does not grant
permission to resume or modify those providers.

Set both `PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_FILE` and
`PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_SHA256`, or neither. The file must be private,
owned by the current user, nonsymlinked, and match the reviewed SHA256. Its strict
schema binds the protected provider and operation, with at most three peers and
a validity window no longer than 120 seconds. Partial, unknown or expired scope
fails closed; it never falls back to accepting an unproved writer.

Each peer requires the exact clean source revision, environment and launch plist
hashes, successful framework verification evidence, and fresh database identity,
route, authority, operation and import-lease evidence. The operator must derive
these records from verified observations, not fill them with assumed values.
Evidence is local operational material, not a replacement for database fencing.

The accepted process shape is a continuous poller bootstrapping its reviewed
backfill and its direct manual-import child. Validate PID, parent PID, start time,
working directory and exact command. The verified supervisor supplies the child's
provider and lease identity through its closed environment construction; do not
dump process environments. A resident with no child requires an unowned lease.
A child requires the matching execution claim and unexpired import lease. This
scope does not infer later polling-cycle ownership from an earlier bootstrap.

Recheck process identities, source and file pins, scope freshness and every peer's
lease evidence before accepting. Reject the protected provider, duplicate peers,
unknown writers, orphan children, changed commands, reused PIDs and expired
evidence. A refusal requires new evidence or coordination; it is not permission
to kill another provider's worker or broaden the allowlist.

Use `verifyProviderHeadPeerProcessScope` for the optional shared check. The normal
head-control database guards remain unchanged and continue to validate the
protected provider's exact history, configuration, checkpoint and fenced lease.

## Acceptance map

| Behavior | Coverage |
| --- | --- |
| Exact foreign bootstrap tree is accepted; protected or unknown writers are refused | Automated: `scripts/local/provider-head-process-scope-inventory.test.mjs` |
| PID, parent, start time, command, directory and source drift are refused | Automated: the inventory tests and `scripts/local/provider-head-process-scope.test.mjs` |
| Private-file hash, schema, evidence, lease and expiry checks fail closed | Automated: `scripts/local/provider-head-process-scope.test.mjs` |
| No-option controls retain the existing conservative process guard | Automated: head-control tests; unchanged default branch |
| Current peer process and database evidence matches a live launch | Operational: private timestamped operator proof before each control |

Run focused tooling checks and the unchanged `npm run verify:framework` before
deploying this control path. No production source requests are part of its tests.
