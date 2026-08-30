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

Existing complete releases receive a one-time, generic internal backfill in bounded batches before the new read path is enabled. Backfill derives and validates the same compact facts from immutable stored details, records resumable progress, and marks a release ready only when its expected records are complete. It must preserve every original calculation and observation timestamp and leave release fingerprints unchanged. There is no lasting fallback that reads a second representation or scans all full details. New publication batches initialize their own projection automatically. This initialization and the compact path remain subject to focused coverage and the full framework gate.

Deployment must first drain any in-flight V3 staging release. A partially staged release from the old code has no compact fact set and cannot resume through the new staging path. The local cutover inventory contains only two complete releases, each with 17 accepted and expected packs; no staging release needs migration.

After both sets are ready, initialize retained history from the recorded previous and active releases in one transaction. Verify the unchanged generation and the terminal activation receipt before creating the rollback journal; a legacy rollback or ambiguous terminal operation is refused so a displaced future release cannot seed history. Initialization changes only derived retention metadata, not publication generation, identity, fingerprints, or timestamps. The local terminal operation is a verified activation at generation 2.

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
| LK-10 | Given a complete release created before compact facts existed, when interrupted backfill resumes, then readiness appears only after complete verified initialization, without changing timestamps, fingerprints, active-release identity, or source state. Initialization retains a valid previous EV when the active calculation is unavailable and refuses a legacy rollback branch. Newly published releases require no separate initialization. | `convex/dataReleaseV3EvFactsBackfill.test.ts` |

Run focused contract, Convex, and frontend checks, then `npm run verify:framework`. Browser verification must cover the dashboard, list, and pack detail at a stale age and after refresh. Report any remaining acceptance gaps explicitly.
