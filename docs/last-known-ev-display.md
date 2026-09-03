# Last-known PackScout EV display

Status: implemented user-authorized presentation policy. Final verification results belong in the task handoff.

A pack's last valid PackScout EV remains visible when its evidence ages or a newer calculation is unavailable. Age reduces displayed confidence; it does not erase a previously valid value. Only a pack that has never had a valid published PackScout EV has no value to display.

## Calculation and presentation boundaries

- Keep the immutable V3 calculation, evidence, publication, method-version, and confidence-policy contracts unchanged. An expired or failed calculation remains expired or failed in that record.
- Define a separately versioned, derived presentation policy. It selects the last valid published calculation and describes its current confidence and historical status without rewriting the calculation as current.
- Preserve the selected calculation's metrics, calculation-price basis, `calculatedAt`, source observation time, and identity. Publication, refresh, and rendering must not replace those timestamps with the current clock.
- A changed current pack price does not silently reprice retained metrics, profit, or return percentages. Show the original basis alongside last-known/as-of context where needed to avoid presenting historical returns as current returns.
- A genuinely newer unavailable published calculation preserves the last valid value and sets its displayed confidence to zero. Advancing the read clock alone is not a new failed calculation; it follows the age decay below.
- Missing, malformed, unsupported, or positive-EV-guarded attempts never become valid values. Never substitute vendor-reported EV. The existing positive-EV publication and opportunity-selection policies remain unchanged; retention alone does not establish a current positive opportunity.
- Restocking does not make an EV frozen at sellout actionable. Keep that retained value visible with its sold-out provenance, but exclude it from EV rankings, opportunity selection, and EV aggregates until a newer valid calculation clears the sold-out history.

## Confidence decay

Use the selected calculation's original oldest essential observation time and a validated read clock. Compute age in milliseconds; do not round age to whole minutes before applying the boundaries.

Start at 10,000 basis points, subtract 2,000 if the calculation uses a closed-range midpoint, and subtract 1,500 if it uses platform-published odds. Reconstruct this base from the calculation's validated limitations rather than subtracting age twice from its previously displayed score.

| Source age | Age penalty, basis points |
| --- | ---: |
| 0 through 15 minutes, inclusive | 0 |
| More than 15 through 30 minutes, inclusive | 1,000 |
| More than 30 through 60 minutes, inclusive | 2,500 |
| More than 60 minutes | `min(10000, 2500 + floor(2500 * (ageMs - 3600000) / 3600000))` |

Displayed confidence is `max(0, 10000 - midpointPenalty - platformOddsPenalty - agePenalty)`. A newer failed calculation overrides that result to zero. A score of zero remains a valid displayed confidence and does not remove the EV. Invalid or future read-clock relationships must not improve confidence or refresh evidence.

For a midpoint calculation using platform-published odds, confidence is 6,500 basis points at 15 minutes, 5,500 at 30 minutes, 4,000 at 60 minutes, and 1,500 at 120 minutes. EV metrics remain identical throughout.

## Durable retention and identity

- Store the last valid calculation durably under the authoritative provider and pack identity, independently of the currently active publication and any release-cleanup window.
- Advance retention only from a validated, accepted publication for that exact identity. Staged, rejected, malformed, or cross-provider records cannot seed or replace it. A replay or older publication cannot regress the retained calculation.
- Publishing a newer unavailable result, removing a pack from a publication, or pruning an old release does not delete its retained last valid calculation. Removal still controls catalog visibility: retention must not resurrect a removed listing. The retained value can be reused if the same pack identity returns.
- Provider changes and replacement products must not inherit another identity's value. Native-key reuse requires explicit identity handling; matching display names or URLs is insufficient.
- Selection and retention must remain consistent across publication activation, retries, concurrent publications, and process restarts. A browser cache or a scan limited to recent releases does not satisfy durability.

This change does not fetch source data, reset cursors, start imports, alter scheduling, or weaken immutable-fact conflict handling.

## Derived projection and initialization

The approved implementation stages compact EV facts in the same transaction as each validated repack batch. Those facts preserve the immutable estimate, provider and pack identity, calculation price, and their binding to the original search projection. They do not advance global retained history until activation succeeds. Activation and its retention journal share the existing publication transaction and predecessor check; rollback restores the corresponding history as well as the active release.

Public reads use compact facts and retained values for ranking and aggregate metrics, then load full details only for selected results. They verify selected details against the staged facts and original search rows before returning them. Capacity remains 1,000 packs per release even with valid maximum-length descriptions; historical retention is addressed by identity rather than a scan capped at 1,000 identities.

Existing complete releases receive a one-time, generic internal backfill in bounded batches before the retained-EV reader is enabled. Backfill derives and validates the same compact facts from immutable stored details and records resumable progress. Sealing facts alone does not enable the reader: the active release and its previous release must be complete, and retention initialization must succeed. New publication batches initialize their own projection automatically.

### Temporary migration boundary

PR #51's rollout fix supports exactly the pre-feature shape: a complete V3 release without the derived `evFactsRequired` marker, with neither retention pointer field present, and without a staging-owned EV fact set or an existing retention journal for that release. That release continues to serve its immutable published snapshot during migration. Queries rank compact search rows and hydrate only selected details, verifying their original binding; they never scan every full detail. A request does not mix partially backfilled facts into that snapshot. Published EV values and timestamps stay unchanged, including after their original expiry; confidence remains the published snapshot confidence until initialization enables decay and durable retention together.

New releases set `evFactsRequired: true` when created. Initialization stamps the same derived marker on the migrated active and previous releases in its transaction. Missing or damaged facts on these releases, a partial retention pointer, or an invalid transition fail closed rather than returning to the snapshot reader. This marker is derived migration metadata, not an input to immutable release fingerprints.

Owner: the PackScout EV/publication maintainers, through PR #51. This is a temporary migration design for existing complete releases, not a permanent alternate data source. Remove the snapshot reader and optional legacy shape after every supported deployment has verified initialized active/previous releases and no old staging release remains. Until then the migration command and regression tests own that boundary.

### Local rollout command

1. Drain in-flight V3 publication before deployment. A partially staged release from the old code has no complete compact fact set and cannot resume through the new staging path. Inspect this on the actual target; earlier local inventories are not rollout authority.
2. Deploy this additive schema/functions build to the intended local Convex target using the normal deployment workflow. Existing legacy public reads remain available in snapshot mode; deployment itself does not run a backfill or publish a release.
3. Run `npm run migrate:convex-last-known-ev:local -- --check-only`. It reads internal migration readiness independently of public predecessor reads. Exit 0 means ready; exit 2 means migration required; exit 1 means invalid configuration, failed proof, or an unavailable command. Check-only performs no backfill, initialization, deployment, or source writes.
4. Run `npm run migrate:convex-last-known-ev:local`. It pins generation and active/previous IDs once, backfills the previous release then the active release in resumable pages (at most 32 rows / 4 MiB each), and initializes retained history in one transaction. Interruptions can be resumed with the same command; each invocation refuses pointer drift rather than adopting later progress as new authority.
5. Require `ready` output before publishing. The command verifies unchanged generation and full immutable release pointers, validates retention readiness, checks a clocked public read, and rechecks the pointers. The local distributed promoter runs the same read-only prerequisite before installing publication authority or writing any provider release or catalog manifest.

Initialization verifies the terminal activation receipt before creating the rollback journal. A legacy rollback or ambiguous terminal operation is refused so a displaced future release cannot seed history. Only derived facts, history/journal records, and the migration marker change; publication generation, identity, fingerprints, calculation/observation times, and completion timestamps remain unchanged. Empty and already-initialized deployments need no backfill. A sealed-but-uninitialized deployment is not ready.

The command accepts only an explicit `local:` or `anonymous:` deployment with matching HTTP loopback URLs and rejects cloud/deploy/self-hosted credential overrides. It reads the existing deployment configuration, verifies the saved port and running instance name, and calls that pinned loopback API directly. It does not invoke the Convex CLI, load deferred `.env` selection overrides, or start a stopped backend. Credentials never enter command arguments or diagnostics; redirects are refused. It never pushes code, resets data, starts workers, changes provider cursors, or recalculates EV. Do not use it for a remote target. Remote rollout needs its own environment-scoped operator entry point with the same staged protocol; this PR does not silently target a cloud deployment.

## Acceptance map

The named tests automate the acceptance criteria, including capacity and backfill. Record the full framework gate and local browser verification in the task handoff.

| ID | Given / when / then | Automated coverage |
| --- | --- | --- |
| LK-01 | Given a valid published EV, when time crosses 15, 30, 60, 120, and 240 minutes, then metrics and original timestamps persist and confidence follows the exact inclusive boundaries and zero floor. Check one millisecond on either side of each discontinuity. | `packages/contracts/src/data-release-v3-last-known-ev.test.ts` |
| LK-02 | Given an aged value, when only the read clock advances, then confidence decays without changing immutable calculation status, fabricating a newer calculation, or dropping the value. | Contract test above; `convex/publicRepacksV3.test.ts`; `convex/dataReleaseV3RetainedEv.test.ts` |
| LK-03 | Given a last valid value, when a newer calculation is unavailable, then that value remains with confidence zero and the newer failure remains distinguishable. Given no valid history, then the value remains empty. | Contract test above; `convex/dataReleaseV3RetainedEv.test.ts` |
| LK-04 | Given a newer valid accepted publication, when activation completes, then it replaces retained history for that identity; replayed, older, staged, rejected, and malformed publications cannot replace it. | `convex/dataReleaseV3RetainedEv.test.ts`; `convex/dataReleaseV3Lifecycle.test.ts` |
| LK-05 | Given retained history, when a pack is removed, releases are cleaned up, and the same identity returns, then history survives but the removed listing never reappears solely because history exists. Provider or pack identity mismatches cannot reuse it. | `convex/dataReleaseV3RetainedEv.test.ts` |
| LK-06 | Given a changed current pack price, when historical EV is displayed, then retained metrics and original calculation-price basis agree and the historical basis is understandable. | `apps/frontend/lib/packscout-ev-presentation.test.ts`; `apps/frontend/components/catalog/catalog-surfaces-ev.test.tsx` |
| LK-07 | Given an aged or zero-confidence value, when a page refreshes or its confidence clock advances, then the value stays visible with updated confidence and last-known/as-of context, without a stale-response loop. A backward browser clock cannot raise confidence. | `apps/frontend/lib/packscout-ev-clock.client.test.ts`; `apps/frontend/lib/packscout-ev-presentation.test.ts`; `apps/frontend/packscout-ev-no-recalculation.source.test.ts` |
| LK-08 | Given vendor EV or a failed positive-EV calculation, when no valid PackScout history exists, then no substitute value appears and existing opportunity eligibility remains enforced. | `packages/contracts/src/data-release-v3-last-known-ev.test.ts`; `apps/frontend/lib/packscout-ev-presentation.test.ts` |
| LK-09 | Given 1,000 active packs with maximum-length descriptions and more than 1,000 retained historical identities, when activation and public reads run, then valid releases remain supported within bounded database IO; selected detail hydration remains bounded. | `convex/dataReleaseV3RetentionBounds.test.ts`; `convex/dataReleaseV3EvFactsBackfill.test.ts` |
| LK-10 | Given a complete release created before compact facts existed, when interrupted backfill resumes, then its published snapshot remains readable and retained-EV readiness appears only after complete verified initialization, without changing timestamps, fingerprints, active-release identity, or source state. Initialization retains a valid previous EV when the active calculation is unavailable and refuses a legacy rollback branch. Newly published releases require no separate initialization and cannot fall back on missing facts. | `convex/dataReleaseV3EvFactsBackfill.test.ts`; `convex/dataReleaseV3EvMigrationState.test.ts`; `scripts/local/local-convex-ev-migration.test.mjs` |
| LK-11 | Given a retained sold-out EV, when the pack returns as available with an unavailable calculation, then its values and sold-out provenance remain visible but its EV fields sort in the null tail and do not contribute to opportunities or EV aggregates. A newer valid calculation clears that history and restores ranking eligibility. | `convex/dataReleaseV3RetainedEv.test.ts` |
| LK-12 | Given a target needing EV initialization, when local promotion is requested, then it refuses before publication side effects; check-only never mutates, interruptions resume safely, pointer drift fails, and secrets/remote targets cannot enter command execution. The public readback verifier also excludes restocked sold-out history until a newer valid calculation. | `scripts/local/local-convex-ev-migration.test.mjs`; `scripts/local/local-convex-ev-migration-client.test.mjs`; `scripts/local/distributed-clutchpacks-public-readback.test.mjs` |

Run focused contract, Convex, and frontend checks, then `npm run verify:framework`. Browser verification must cover the dashboard, list, and pack detail at a stale age and after refresh. Report any remaining acceptance gaps explicitly.
