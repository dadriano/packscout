# Local Phygitals native-card review

This is local review evidence, not a production migration or a general reset tool.
Provider databases and credentials remain registered centrally. No Phygitals DSN,
source bearer, or plaintext credential is added to an environment file.

## Immutable contracts

The original shared `dataforrest-launch-distributed-adapter-v1` is unchanged.
The first Phygitals-only profile, `dataforrest-phygitals-distributed-adapter-v1`,
uses 100-record pages and the existing 8 MiB response limit. Its exact card facts
reader accepts `chase.name` or `asset.name`; conflicting wrappers and malformed
names remain mapping quarantines. The envelope `record_id` remains the canonical
identity. Nested IDs, owners, addresses, metadata, and FMV without explicit
reviewed currency evidence are not canonical facts. Valuation remains unavailable.

The production normalizer, provider-observation mapper, projection validation,
and mixed-page record validation are reused. No generic validation was weakened.

## Guarded v2 to v3 preparation

`prepare-phygitals-card-replay.mts` accepts `--verify` or `--apply` and requires
`NODE_ENV=development`. It reads only the protected local central URL and provider
cipher keyring. A process/file DataForrest token is forbidden. The already-owned
Phygitals source credential is decrypted only in memory for bounded live admission;
the response bytes are zeroed and the token reference is discarded immediately.

The utility pins the exact provider/org, local database node/credential/topology,
old config, stopped run, cursor hash, 133 pages, 13,300 expired mapping quarantines,
and zero canonical/promotion changes. It refuses extra runs, actionable commands,
identity/hash drift, and any different history. A fresh 100-record source probe
must return HTTP 200 and pass the actual card mapping path for both native wrappers.

Only after source and fresh central-gateway database proofs succeed does apply
acquire the provider-local import lease. The new immutable central config and
truthful activation attestation commit atomically. The existing runtime
`synchronizeConfiguration` contract clears the configuration-scoped cursor in
its own guarded serializable transaction. The utility never directly deletes or
rewrites the cursor, run, quarantine, or canonical tables. It can resume if central
activation succeeded but local synchronization was interrupted, provided the exact
approved checkpoint still matches. It does not create an import command.

The exact recovery utility is intentionally unusable after subsequent import work.
Do not loosen its historical guards to prepare a later revision.

## Evidence at the first replay stop

The original config-v2 run `b3f721f8-37fb-4961-8756-ee11819a66ec` stopped incomplete
at 2026-08-30T01:08:36.882Z: 133 pages, 13,300 catalog records, all quarantined,
zero canonical changes. Its final cursor hash is
`26dafbeaea75906df5a56d9f6bcf51816c771ce0237991b23ed832c3d8741f0a`.

Fresh v3 admission at 2026-08-30T01:21:46.940Z returned HTTP 200, 509,098 bytes,
100 valid collectibles (29 `chase`, 71 `asset`), and zero mapping quarantines.
Config `1359d83b-6c95-57cf-9a60-06bad470b3b4` and activation evidence
`06c65e50-82f3-5508-a3dd-47ef5ccee81a` were committed. The real central/admin
manual-import contract created command `c8d886fe-242a-45dd-8e9a-2ca0e41cc977`
and replay run `d5f84568-9a2c-4fdc-a11f-b5858e97e278` from an origin cursor.

| Durable replay checkpoint | Records | Accepted | Duplicate | Quarantined |
| --- | ---: | ---: | ---: | ---: |
| Page 1 | 100 | 100 | 0 | 0 |
| Pages 1–10 | 1,000 | 719 | 281 | 0 |
| Pages 1–100 | 10,000 | 728 | 9,272 | 0 |
| Stopped at page 151 | 15,100 | 741 | 12,567 | 1,792 |

The replay was stopped promptly when later pages became wholly quarantined.
Run v3 is incomplete at 2026-08-30T01:24:22.377Z, its import lease is released,
and its final cursor hash is
`e0ec8b27a3e68d70e77190d7ea948a855f137ad07dddaf76e88db476ed848eeb`.
741 collectible rows remain; the original 13,300 quarantines and new 1,792
quarantines are preserved separately. Source head has **not** been reached.

Read-only 100-record probes at pages 134, 140, and 151 found additional native
card shapes: `inventory.title`, `nft.name`, and co-present `inventory`/`nft` names
that disagree. These are outside v1's approved interpretation. A further immutable
profile and a newly reviewed nonzero-canonical replay guard are required before
continuing. No precedence between conflicting names is inferred here.

Courtyard, Collector Crypt, queued ClutchPacks, local Convex ports 3210/3211, and
frontend port 5100 were not stopped or mutated by this recovery.

## Reviewed v4 continuation

The new immutable `dataforrest-phygitals-distributed-adapter-v2` retains the exact
original `chase`/`asset` behavior. When neither is present, it selects
`inventory.title` before `nft.name`. Different descriptive labels do not change
the envelope identity. An inventory-selected record gets no image because no
direct inventory image field was evidenced; an NFT-selected record can use its
own validated HTTPS `image`. Unselected labels/fields are not copied into a new
schema or guessed attributes. Prior adapter versions remain unchanged.

`prepare-phygitals-native-card-v4-replay.mts` is a separate guarded recovery:
the old zero-canonical utility is not relaxed. It binds the exact stopped v3
run/fence/cursor, both histories, 741 retained canonical rows and promotion changes,
15,092 expired quarantines, and the retained canonical ID/key/row-version digest.
It uses the same atomic central activation and existing immutable configuration
synchronization; there is no direct cursor rewrite or deletion.

Before activation, the new production normalizer/mapper/mixed-record validator
accepted all 400 fresh records from the origin and the previously failing pages
134, 140, and 151, with zero format quarantines. Selected wrappers across those
probes were 29 chase, 77 asset, 244 inventory, and 50 NFT. All responses were HTTP
200, each within the unchanged response cap. Apply repeats those proofs freshly.

The ignored, read-only review helper at
`.tmp/local-review/inspect-phygitals-review-import.mjs` reports the current latest
run, entity counts, recent durable page counters, lease state, and preserved
history. Run from this worktree with:

```sh
env -u PACKSCOUT_DATA_API_TOKEN NODE_ENV=development node --import tsx .tmp/local-review/inspect-phygitals-review-import.mjs
```

It neither queues nor consumes commands. The current-task progress heartbeat is
responsible for subsequent monitoring; the helper makes no scheduling changes.
