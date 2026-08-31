# Local development against Neon

This change keeps the distributed topology: one central database and one isolated
database per provider. It does not convert the legacy single-database runtime,
change source request settings, or authorize imports.

## Runtime configuration

Keep `NODE_ENV=development`. Set `PACKSCOUT_DATABASE_MODE=remote` explicitly.
Absent that setting, development continues to accept only the existing local
review destinations; production requires remote mode.

The ignored workspace `.env` supplies these server-only values:

| Variable | Purpose |
| --- | --- |
| `PACKSCOUT_CONTROL_DATABASE_URL` | Distributed admin central application connection |
| `PACKSCOUT_CENTRAL_DATABASE_URL` | Import supervisor central application connection |
| `PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS` | Exact approved central host |
| `PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS` | Comma-separated exact approved provider hosts |
| `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64` | Existing provider credential decryption key; do not rotate during routing cutover |
| `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION` | Existing encryption-key version |

Preserve existing admin session, actor, and source-credential keys. Never expose
database URLs or keys through browser-public variables or commit them. Scripts
and admin have explicit workspace `.env` loading; shell environment overrides
must also be checked. No legacy `PACKSCOUT_DATABASE_URL` fallback is introduced.

Remote connections use port 5432 and verified TLS. Registry records retain
`ssl_mode=verify-full`. At the native Prisma 6 boundary this is encoded as
`sslmode=require&sslaccept=strict`: the pinned engine does not understand the
libpq spelling and would otherwise silently use weaker defaults. Native tests
exercise plaintext refusal, untrusted certificates, incorrect hostname, and a
trusted matching certificate. Do not remove strict acceptance or substitute a
pooler without reviewing session/transaction assumptions.

## Guarded route transition

The local-only migration utility is `scripts/local/neon-routing-cutover.mts`.
It accepts private JSON files outside the checkout, requires development plus
explicit remote mode, and never contacts a provider source API.

1. `prepare` reads the selected Neon central using the restricted application
   role, pins organization/provider/configuration/credential/topology identity,
   and checks each real provider destination using verified TLS. Each provider
   must be paused, with no active run, actionable command, or owned lease.
2. Review the prepared plan digest and migration equivalence evidence. Check
   the independent stopped-process hold immediately before applying.
3. `apply` requires that exact digest and a fresh private recovery receipt. A
   serializable central-only transaction locks and compares old authority,
   changes existing primary node host/port/TLS/region, and lets normal triggers
   advance topology versions. It never rewrites provider data or credentials.
4. New activation/audit records explicitly describe infrastructure-only
   revalidation. Source evidence retains its original activation ID, timestamp,
   and digest; no fresh source request or HTTP success is claimed.
5. Read back normal gateway routing, database identity/schema readiness, paused
   state, checkpoint/history preservation, and the committed route provenance.
   An uncertain commit requires readback, never a blind retry.

The independently held processes are essential: separate provider database
reads cannot lock out an outside operator resuming an import. Keep all launchers
stopped throughout preparation, apply, and verification.

## Continuation and rollback boundaries

Old backfill, continuous, resident, and restart receipts include route/config
authority. They remain immutable historical evidence. A Neon route changes that
authority even when provider IDs and checkpoints are unchanged. Existing
receipts must refuse continuation; never silently recompute their pins, restore
local routes to satisfy them, or reuse an unverified checkpoint.

Import resumption requires a separate explicit user release and reviewed new
continuation provenance. Environment completion is not permission to resume.
Keep candidate launch plans outside `Library/LaunchAgents`; installing an
unloaded `RunAtLoad` plan can still enable a future login start. Frozen/legacy
checkouts and their environment files remain historical, not the new runtime.

Retain local databases and private backups. Do not run schema provisioning,
reset, or legacy activation utilities against Neon. Reversing routes after any
new target writes would require a separate data reconciliation plan.

## Acceptance map

| Scenario | Evidence |
| --- | --- |
| Local remains local unless remote mode is explicit; exact hosts, database name, port, and TLS are enforced before connecting | Automated: `packages/database/src/database-runtime-policy.test.ts` |
| Native Prisma cannot silently weaken verify-full | Automated: `packages/database/src/native-prisma-tls.test.ts`, `native-prisma-tls.integration.test.ts`, lifecycle and gateway tests |
| Admin and supervisor/worker paths use the approved policy without a legacy fallback | Automated: admin runtime/factory tests; `provider-backfill-database-environment.test.mjs`; worker database-configuration tests |
| A route transition fails closed on authority, identity, TLS, schema, state, or compare-and-swap drift | Automated: cutover tooling tests using disposable fixtures |
| Real migrated data and checkpoints equal the selected source snapshots | Operational evidence: private migration catalog, table fingerprints, sequence comparisons, and post-cutover readback; not reproduced against live databases by the test suite |
| Imports stay held and historical receipts are not repinned | Operational evidence: process census and migration handoff; no startup or resume performed |
| User-facing visual behavior | Not applicable: no UI change or service startup |

Run `npm run verify:framework` with disposable test infrastructure before
handoff. Keep real source and Neon credentials out of the verification process.
