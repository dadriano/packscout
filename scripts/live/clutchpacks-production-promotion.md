# ClutchPacks production promotion

This boundary publishes the ClutchPacks provider database in Neon to the V3
catalog served by `https://shiny-newt-310.convex.cloud`. It does not deploy
frontend code, fetch the provider API, alter source controls, publish a local
preview, or modify the older provider/global-manifest publication families.

The production operator owns publication. The existing import resident owns
source requests and import scheduling. Only one of them may hold the normal
fenced import lease. The sequencing contract is:

1. Finish an import successfully, prove its own source-head page and completed
   reconciliation, drain the worker and release its lease.
2. Pin the central tenant, operator, configuration, verified Neon route, exact
   successful run, checkpoint, runtime generation and row version.
3. Prepare one immutable production bundle. Persist its read clock, operation
   ID, source fingerprint, approved configuration, complete V3 plan and active
   predecessor. Capture every current production pack and collectible ID and
   the approved categories against that same predecessor. Persist this fresh
   inventory in the bundle. A retry uses the same bundle and EV read clock.
4. Acquire the normal import lease, validate the source again, publish through
   the existing signed V3 protocol, and validate all public API surfaces and
   the signed retained-EV witness. Immediately before activation, persist a fresh
   observation attempt; a stale source head refuses activation. Release the
   exact owned lease afterward.
5. Record the verified publication receipt before allowing the next import
   tick. An unknown outcome blocks automatic progression; it does not create
   a new bundle or restart publication with new operation IDs.

## Source and identity authority

The initial source scope is the active ClutchPacks configuration v4. The live
policy names its exact tenant, provider and configuration. Configuration
changes require a reviewed policy successor; no local-target guard is relaxed.
PostgreSQL connections require the exact configured Neon hosts and verified
TLS. Read-only repeatable-read snapshots include the complete active card
catalog, current membership evidence, categories and aliases. A full snapshot
is checked before staging, activation and final verification. Each sequential
batch and finalization checks a conservative monotonic lease deadline and any
latched failure immediately before dispatch. The deadline starts before the
queued lease request, consumes response latency and reserves a 15-second
margin. Every 30 seconds, renewal revalidates source controls, authority and
the exact fence. A response cannot revive an expired proof. Immutable staging
does not reread the active pointer; visible publication boundaries validate the
source first and then fetch the current pointer before proceeding.

Public identity uses the recovered original UUIDv5 namespace and bare provider
UUIDs. The new `pack:` and `card:` prefixes are storage keys, and never become
part of the public UUIDv5 name. The original approved configuration and a
hash-pinned original production proof establish the namespace authority. Each
bundle also includes a fresh complete inventory of its current predecessor,
including safe vendor and checkout references. Missing retained pack/collectible
IDs, changed checkout URLs, or changed approved categories refuse promotion.
There is no fuzzy matching or fallback to provisional IDs.

Successor configuration key `clutchpacks-neon-production-v1` uses the settled
provider promotion sequence as its revision. This is a scoped replacement of
the retired local canary publisher, not a second live catalog authority.
All active collectibles remain searchable, including those with no current
pack membership. Only retained current inventory snapshots create chases;
historical pulls do not imply that a card remains in inventory.

## EV and publication safety

The current V3 assembler and canonical EV presenter remain the calculation
authority. Both current and retained displayed positive signed EV are refused
under the existing nonpositive policy. Missing sold-out history is not invented.
The legacy active/previous releases must first have their EV facts initialized
through the existing backend migration API. The dedicated live initializer
pins both pointers, generation, terminal activation ancestry and global manifest
state, and verifies public reads before and after each bounded migration.

V3 publication uses the existing isolated signing authority. Secrets remain in
memory and never enter arguments, bundles, receipts or logs. A moved pointer,
lost lease, changed source, rejected signature or mismatched readback fails
closed. Rollback is allowed only if the exact candidate and retained predecessor
remain at the expected generation. The existing wire protocol atomically
compares the active release ID; the client additionally checks generation and
fingerprint immediately before activation. Publication owners must remain
exclusive because the wire protocol does not atomically compare generation.
Before acquiring the import lease, the command durably records the exact
generated owner, request and intent in a private attempt file. Uncertain
acquisition and unconfirmed cleanup remain distinct failures, with no retry or
invented lease ownership. Background lease loss is checked again immediately
before each cloud write.

Quality observations preserve source quarantine counts and the exact source
quality, including `unknown`, `degraded` and `unhealthy`.
Successful import or publication does not resolve an immutable-fact conflict.
Source freshness derives from the actual completed head and the configured
staleness limit; publication must not extend a stale head indefinitely. The
observation clock is separate from the pinned EV read clock so staging time
cannot expire the observation before activation. Every observation request is
written exclusively to a private attempt file before it is sent. Unknown
outcomes retain that exact request for reconciliation.

## Validation and retirement

The two promotion phases take absolute paths. Source configuration contains
hash-pinned paths to the frozen environment, identity proof and approved
baseline, plus explicit nonsecret source pins. Environment bytes are never
copied into the bundle. Existing bundle destinations are not overwritten.

```sh
NODE_ENV=production npm run promote:data-release-v3:clutchpacks:live -- --prepare /absolute/source-config.json /absolute/publication-bundle.json
NODE_ENV=production npm run promote:data-release-v3:clutchpacks:live -- --publish /absolute/publication-bundle.json
```

The recurring resident awaits `publishClutchpacksProductionPostHead` from
`clutchpacks-production-post-head.mts` between a completed import and its next
cycle. The hook requires a pinned clean publisher commit, hash-pinned private
base source configuration, expected resident authority digest and exact safe
head summary. It updates only the successful run, checkpoint, generation and
runtime row version. The resident's mandatory callback fingerprint must bind
these fixed settings and its bounded timeout in the operation and cycle audits.
The resident wrapper remains head-only; it cannot bootstrap a source while
using this production callback.

Each head has immutable private configuration, bundle and receipt evidence.
An exclusively owned, durably recorded pending marker survives failure or
process death and blocks subsequent heads. Another invocation never alters an
existing marker. Verified reentry runs only `--publish` with the original
bundle and repeats full verification; it never recalculates the EV plan clock.
Cancellation waits for the child process to terminate and its private output
to drain. A failed or uncertain attempt requires reconciliation before the
resident can import again. The configured polling interval is a minimum wait;
an awaited publication can make the complete cycle take longer.

The initializer supports `--inspect`, `--check-only /absolute/manifest.json`
and `--apply /absolute/manifest.json`. It additionally requires the production
catalog read token in its private process environment. Obtain credentials
through the existing authenticated deployment authority; never print them or
put them on a command line. All commands refuse alternate Convex selectors.

Run focused source, publication, identity, readback and migration boundary tests,
then `npm run verify:framework` before operating this live path. Test mutations
must not target production. Production acceptance includes the current release
receipt, all pack detail pages, full list, dashboard ordering/economics,
collectible search, desired-card membership and stable retained-EV witnesses.

The production operator owns the one-time EV initialization entrypoint. Remove
it with the approved legacy EV reader once all supported retained heads are
initialized. The old local and canary scripts keep their original restrictions;
they are not a recovery path for this live publisher.
