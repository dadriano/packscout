# Task: Assemble Complete Deterministic Pack Snapshots

**ID:** pack-version-publication/003
**Depends on:** pack-version-publication/001, pack-version-publication/002
**Blocks:** pack-version-publication/006, pack-version-publication/011
**Delivery phase:** P03
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder after P01, including deterministic fixtures, boundary validation, and protected-data scanning
**Status:** in_progress

## Current cookie-authentication review repair — 2026-09-05

PR114 P1comment3941536315/threadPRRT_kwDOTplTZc6flkf3 is repaired in runtime `8f2a4d841fc7033b8bf24db87654f0bfec15f116` on main b96b4369. Explicit Cookie/Set-Cookie structured fields are protected; unquoted header labels require a cookie name/value pair, even one-character credentials. Cookie-related prose, empty labels, ordinary product paths and Bearer-only text stay public. Existing bounded fragment traversal now checks the same prose assignments. No new parser, dependency, budget or token heuristic.

Complete five-file matrix passes 126/126, zero skips (`/tmp/packscout-p03-cookie-complete-focused-20260905.log`); owning pure123 and services lint/types/ratchet0 pass. Independent147 cookie probes plus1,538 previous boundary probes pass at guard SHA-256 b2ceb2dd3f60f8a21d2dfc7db97dc10f9ec5b90e842cf751a3ac79e3cfbb7af3, with six real-assembler normalization/composition controls passing. Initial cookie regressions failed before repair. Full local session43601 is running in `/tmp/packscout-p03-cookie-framework-20260905.log`; publication/current-head CI and the fixing-SHA reply remain. Previous main122 full session34014 was intentionally stopped143 for this new finding, not counted as a pass. No public activation.

## Current raw-path and relative-URL repair — 2026-09-05

New PR114 findings 3941339525/3941339526 on 9e5c9a8e cover zero/one-slash HTTP raw-path evidence and scheme-relative userinfo in prose. Both are reproduced and repaired in the same two guard/test files. Original-text URL discovery preserves control-delimited boundaries; complete raw authority inspection rejects userinfo through quotes before prose tokenization; differing original query/fragment components traverse under the same counters as their parsed values. Public split-card names, path emails, independent OAuth links and quoted public IPv6 controls remain valid. No new parser, dependency, schema, bound or Bearer-only heuristic.

Final runtime `8057bcd53516223b9effbfa45b2ea043598f17f8` is restacked on main b96b4369 after PR122; all 21 source patches replay identically from `codex/p03-before-main122-20260905` (cbedce27), with byte-identical services. Before this parent-only restack, the complete five-file matrix passed 124/124, zero skips, including 8,000-member full/lifecycle/reuse and actual private PostgreSQL handoff (`/tmp/packscout-p03-relative-final-complete-focused-20260905.log`). Owning pure tests pass 121/121; services lint/types and zero-finding ratchet pass. Independent review passes 1,538/1,538 probes at frozen guard SHA-256 9fdaf1f89ed57a041476c1dde137dde515d21e56f1e28179429fcfc413c8871b, plus six real-assembler confirmations. Its 44 expectation adjustments reflect existing absolute-URL, normalization-stage and byte-limit contracts, not relaxed security checks. Explicit schemes parse without a relative base, punctuated public IPv6 authorities retain their closing bracket, and query/fragment JSON closing delimiters are preserved. No existing assertion changed. Fresh current-parent full certification remains required.

Scoped existing limitation: optional whole prose containing a quoted nested URL with raw JSON still fails closed. Six probes reproduce that same behavior on published base 9e5c9a8e (`/tmp/packscout-p03-existing-nested-quoted-base-probe-20260905.log`); this repair does not claim arbitrary nested prose compatibility or introduce a new parser. Direct optionally quoted links and nested unquoted valid components are covered. Fresh full certification, publication and fixing-SHA replies remain. Published 9e5c9a8e full CI33979360663 passed at17:17:32UTC, but does not certify this newer runtime. Its earlier local full failure and successful isolated rerun remain accurately recorded in the handoff.

## Earlier prose-prefixed JSON repair — 2026-09-05

Latest three-finding repair: `d53d0be14a1f8276518bc74627f5d4b29d1b79b3` on main `f852a166cca88008eb2eb419a6a555c7ff794597` rejects literal private URL hosts and protected raw/decoded pathname pairs, including dot-segment-erased evidence and encoded separators. Numeric bracket prose stays public without relaxing recognized JSON syntax. Decoded JSON/form prose reuses the same embedded-URL traversal and existing budgets; no DNS, dependency, API, schema or Bearer-only policy change. Root114/114 complete focused tests pass0skip, including8,000-member capacity/lifecycle/reuse and private PostgreSQL handoff (`/tmp/packscout-p03-host-path-main120-focused-20260905.log`); services lint/types and ratchet0 pass. Agent111 pure tests and independent138 probes pass with no remaining finding in this scope. Full local gate is running in `/tmp/packscout-p03-host-path-main120-framework-20260905.log`; fresh publication/CI and replies to3941202241/3941202247/3941202250 remain. Previous aa62d3d8 local full and1f954697 CI33976721907 passed, but do not certify this new repair.

Final natural-caption refinement: `aa62d3d86565e91bb2043e2c21f2289366a6af7b` on current main `f852a166cca88008eb2eb419a6a555c7ff794597`. Nested [1/1], brace labels and quoted names now share direct-text recognition; actually recognized containers remain strict and escaped standalone strings are inspected. Root108/108 complete focused tests pass0skip, including8,000-member full/lifecycle/reuse and private PostgreSQL handoff (`/tmp/packscout-p03-natural-caption-main120-focused-20260905.log`); fresh npm ci, services lint/types and ratchet0 pass. All19 source patches replay identically from backup `codex/p03-before-main120-20260905` (d46cbc30). Full local gate is running in `/tmp/packscout-p03-natural-caption-main120-framework-20260905.log`. Publication/fixing-SHA reply/fresh CI remain; old runtime evidence below is historical.

PR114 P1comment3940424235/threadPRRT_kwDOTplTZc6fit5c is repaired at `9af6b81d2127fb18459a69fb99c6f643cca457c3` on merged121 parent `0ea6145470a276807a0e9590d759d9fad85e9226`. Existing bounded token inspection now finds structured payloads after ordinary prose in content names, titles, aliases, decoded values and bare fragments. Independent direct roots keep independent OAuth contexts; nested URL/form payloads retain their enclosing context. Ordinary Bearer text and natural braces, brackets and quotes remain accepted. No new parser, dependency or policy limit is introduced.

Agent98/98 pure guard/assembler/boundary tests pass0skip with services lint/types and ratchet0; explicit prose-prefix/fragment/context regressions failed before repair. Root verified all18 source patches replay identically from `codex/p03-before-main121-20260905` (679b61f7). Root capacity/private-PostgreSQL focused tests and exact-runtime full certification are still pending. Prior fullCI33962882450 certified b9d4cc44 only. User has authorized merge after current checks/review are clear; no public writer activates here.

## Earlier account/direct-JSON repair — 2026-09-05 11:12UTC

PR114 P1s3940334067/3940334070 are repaired in `8dd10dbf912a6fe595d3bbabd0b5c653333ee8b0` on mainf6785251. Explicit colon fields use the full existing protected-name policy; unquoted Actor is a credit label and Host is private only with connection-shaped values. Quoted/URL/JSON keys stay strict. Direct public JSON uses the existing bounded token scanner, inspecting escaped, duplicate, nested and adjacent root fields before parse; absolute offsets and one source charge avoid quadratic suffix traversal. URL payloads retain strict whole-document parsing. Ordinary Bearer prose, JSON plus aliases, bracketed edition/fraction labels and encoded Actor labels remain accepted.

Root independently reviewed and ran96/96 complete assembler tests with zero skips, including8,000-member full/lifecycle/reuse and real private PostgreSQL handoff (`/tmp/packscout-p03-account-json-root-focused-20260905.log`). Agent76 focused tests, services lint/types and ratchet0 pass. The existing16-depth/650k-node/48MB limits are unchanged. Latest local `npm run verify:framework` exited7 during the inherited database suite after its connection dropped; the owned PostgreSQL log records No space left on device and the host had257MiB free (`/tmp/packscout-p03-account-json-framework-20260905.log`). This is NOT a passing full gate. No test/timeout was weakened and no user files were removed; fresh GitHub full CI owns certification. Published19ecb8a9 contains this runtime plus delivery-only records. Replies3940403867/3940403908 cite the repair and both P1 threads are resolved. Keep003 in_progress until full CI succeeds; prior28343b85 CI33961320156 and d00d9a43 local full passes certify only the earlier runtime.

## Earlier short-credential and prose-assignment review

Colon repair committed `d00d9a4384a0f4549a22aa8e51eb6c9e6b6055ea` on mainf6785251. Root92/92 complete assembler/capacity/private-PG tests pass, zero skips (`/tmp/packscout-p03-colon-context-root-focused-20260905.log`); agent72 direct/boundary tests, services lint/types and ratchet0 pass. Explicit unquoted colon credentials use the existing normalized six-name family and require an actual value; quoted names use structural protected-field validation. The whole-candidate test proves bare `Authorization:` and separate Bearer alias pass preflight, then the joined projection rejects. Full local framework gate is running against d00d9a43 (`/tmp/packscout-p03-colon-context-framework-20260905.log`); publish/fresh CI/review reply remain before readiness.

Follow-up P1comment3940282168/threadPRRT_kwDOTplTZc6fiWR3 on599aafc8 identifies explicit colon credential assignments (`Documentation api_key: …`, `password: …`). p03_review owns the narrow P03 correction; root owns matching normalized/quoted colon coverage in P04. Colon recognition must preserve unquoted Actor/Host/Bolt labels and the no-Bearer-heuristic policy. The prior two P1 threads are replied3940269784/3940269845 and resolved, but this new finding keeps003 in_progress.

Final contextual repair committed `c42a9f58282e6e0912dd99dd0909206a8ad66968` on mainf6785251. Quoted-key cross-review correction uses complete names without truncation and the same protected-field normalizer/charge. After that correction root independently reran all five suites:89/89 pass, zero skips, including8,000-member full/lifecycle/reuse and actual private PostgreSQL handoff (`/tmp/packscout-p03-auth-context-root-focused-20260905.log`). Direct quoted-name regressions were red, final69 direct/boundary tests and services lint/types/ratchet0 pass. Publishing to existing PR114 for fresh full CI; no pending product-policy question or new scope.

Root independently reviewed the three-file repair and reran all five assembler suites:87/87 passed, zero skips, including8,000-member full/lifecycle/reuse and actual private PostgreSQL persistence (`/tmp/packscout-p03-auth-context-root-focused-20260905.log`). Agent84 direct/boundary tests and services lint/types/ratchet0 also pass. New and existing Basic/URI/JSON/OAuth/limit controls remain intact. Source is ready for commit/publication and fresh full verification, not yet recertified done.

Resolved by user: Bearer or an opaque-looking following token alone is not credential evidence. Explicit authorization syntax and protected assignments/fields establish context, regardless of credential length. Preserve `Bearer` plus `Scout pack`, `Bearer of the Heavens`, and all existing benign-success assertions. Old Bearer-only negative fixtures now include explicit Authorization context; no replacement word/length/digit heuristic. Agent p04_profiles owns the existing P03 guard/two test files; root owns analogous004 separately. Published runtime c5c6782e/head8d723c2a passed fullCI33945377367, but does not certify the new repair. The following original review report is historical and its suggested Bearer-only heuristic is superseded.

New PR114 P1comments3939489239/3939489244 on8d723c2a reopen short Bearer credentials and protected assignments in ordinary public prose (for example `Bearer abc123` and `Documentation api_key=sk_live_private_marker`). The20-character Bearer floor is not a valid syntax guarantee. The agent owns narrow guard/test repairs in P03 and analogous P04 boundary; root owns publication and final proof. Protected-value acceptance is reopened below. Existing valid-label and prior credential/JSON/OAuth corrections must remain intact; no guard budget, test or gate is weakened. FullCI33945377367 cannot certify the forthcoming repair.

## Earlier public-label false-positive repair

PR114 P2comment3939429737/threadPRRT_kwDOTplTZc6fgKpt is fixed in `c5c6782eef9d8e1b6709f0e4e38f933959a07744` on mainf6785251. Ordinary spaced/no-space Bolt/Pulsar/MySQL/SQLite labels remain public; contiguous path, endpoint, userinfo, port, query, encoded-target and SQLite memory syntax remains private. Constant-width lookahead returns at the first marker rather than repeatedly scanning a long suffix. Existing Basic/Bearer/OAuth/JSON guards and bounds are unchanged.

Root reviewed the two-file diff and reran all five assembler suites:84/84 passed, zero skips, including8,000-member full/lifecycle/reuse and real private PostgreSQL handoff (`/tmp/packscout-p03-public-label-root-focused-20260905.log`). Agent64 direct guard/boundary tests, services lint/types and ratchet0 pass (`/tmp/packscout-p03-prose-label-linear-final-focused-static-20260905.log`). Direct label and encoded-target regressions were red before repair. Benign-label acceptance is reverified. Push/reply and the exact repaired-runtime full gate remain required; previousCI33944270898 does not certify this change.

Published at8d723c2a; reply3939475068 cites c5c6782e and the label thread is resolved. Current fullCI33945377367 follows the repaired head. No unresolved finding is known at this checkpoint; query live review state before readiness.

## Earlier follow-up review and main118

PR114 review5119684049 findings3939374805/4808/4811 are fixed at runtime `57805ed8` on current main `f678525141a55f4d7acbd82487a1871a94632096`. Basic canonical base64 credentials, standard Bearer alphabet, contextual OAuth callback/marker codes and PKCE verifiers, and known private database/broker URI schemes (including single-slash/+driver forms) reject; ordinary Basic prose, product/coupon codes, public challenge/state, FTP and email remain valid. Nested forms/JSON retain bounded context; independent URLs do not inherit unrelated OAuth state. Shared depth/node/byte bounds remain unchanged.

The three original defects and analogous alphabet/relative-context/single-slash cases have direct red/green logs. Root's full74/74 focused assembler tests pass with zero skips, including8,000-member full/lifecycle/reuse and actual private PostgreSQL handoff; services lint/types, ratchet0 and docs pass: `/tmp/packscout-p03-main118-focused-20260905.log`. All29 phase patches replay identically from backup `codex/p03-before-main118-20260905` (61091595). Privacy acceptance is reverified. Exact repaired-head full CI and final review replies remain required. Previous full CI33943108405 passed00d4b366 but does not certify this new runtime/parent. JSON finding3939079908 was already replied3939361499 and resolved. No publication activated.

## Current structured-JSON review repair

Full framework CI33937669871 passed at35b0ab10 on mainef3c73e8. Later PR114 comment3939079908 (threadPRRT_kwDOTplTZc6ffRgA) exposed protected keys in percent-encoded JSON URL values. Repair `efa1935a` uses the bounded component traversal to inspect JSON containers, escaped keys, every duplicate-key value, and nested JSON/form/URL strings with the existing shared counters; malformed recognized structured payloads fail closed. Red regressions: `/tmp/packscout-p03-structured-json-red-20260904.log`.46 direct tests, services lint/types and ratchet pass in `/tmp/packscout-p03-structured-json-focused-static-20260904.log`; root's complete66/66 assembler suite including8,000-member full/lifecycle/reuse and actual private PostgreSQL handoff passes with zero skips in `/tmp/packscout-p03-json-full-focused-20260905.log`. Privacy acceptance is reverified; exact-head full gate and review reply remain required. The older CI pass does not certify this new runtime.

## Current main116 review repair

Corrected runtime `29de9847`; checkpoint `6ae32c9e5daa0a51e1be95de800ec09f2a54ad43`; exact parent main `ef3c73e8bb61ade6907dc2abd67751523ae026bd`. All25 phase patches replayed identically from saved backup `codex/p03-before-main116-restack-20260904` (f4ba51b9). All61 focused assembler tests pass with zero skips, including the8,000-member full/lifecycle/reuse case and real private PostgreSQL handoff. Services lint/types, zero-finding ratchet and317-file docs pass. Log: `/tmp/packscout-p03-main116-five-review-focused-20260904.log`.

The five follow-up findings below have direct red/green repairs. Generic and special URI authorities, embedded protected parameters, nested form keys (including whitespace/encoding) and authorization-code keys fail closed through shared bounded traversal. Reuse schema/scope validation remains, but equality compares the synchronous captured candidate before normalization. Same-ID noncanonical bytes reject instead of falsely returning reused. Benign encoded values/email and all earlier guards remain tested. Full exact-head CI and final publication/review records are pending; task003 remains in_progress. P05A remains paused until the corrected parent is fully certified.

## Historical reopened review findings

PR114 has five additional findings beyond the ten earlier resolved threads: non-HTTP URI userinfo (3938955423), embedded HTTP query/fragment credentials (3938967853), nested decoded form payloads (3938967855), OAuth authorization-code keys (3939005491), and reuse comparison after schema normalization (3939005494). Privacy and exact supplied-byte reuse acceptance are reopened below. Repair the owning input/assembler boundaries with direct red/green regressions, then restack onto current main and rerun focused/full verification. P05A remains paused. Main advanced again through PR116 to ef3c73e8; do not call the current bdec16dd/8616 parent certified.

## Historical main117 recertification checkpoint

Main advanced through PR117 to `8616bfd5041f490a0334ca4beef2a2e4f26ed88e`. P03 is cleanly restacked: runtimea2e307c5, checkpointe820eecd; all22 phase patches match the previous parent exactly. Backup `codex/p03-before-main117-restack-20260904` retains44e2f193. All ten privacy findings remain fixed/replied/resolved, but the new parent requires a fresh full gate. Task is in_progress for recertification, not a reopened privacy defect. Prior main70bbae98 full success below is historical. Use PR114's unchanged GitHub gate because local disk is constrained.

## Historical certified review repair — main70bbae98

Runtime `ca9dd678baf79ff807bd11fb50b0d75f8f55c0f7`, verified checkpoint `6c7217beed3c963be32b3400d3707c71def3fde0`, direct parent `70bbae98a35b16dde20a5b152bab5a371aebeeae`. All48 focused assembler tests pass with zero skips, including the PostgreSQL seam; services lint/types, zero-finding ratchet and316-file docs check pass. Log: `/tmp/packscout-p03-main115-review-focused-20260904.log`.

The complete `npm run verify:framework` PASSED with exit0, including all product/tooling lanes, the unchanged maximum shared-delivery transaction and both production builds: `/tmp/packscout-p03-main115-framework-20260904.log`. Independent review passed22 guard and6 assembly probes with linear scan timing. All20 restacked patches match their pre-restack versions; backup `codex/p03-before-main115-restack-20260904` retains12a69043.

The two latest P1 findings reproduced before repair. Recognized malformed nested targets now fail closed. Every public text value scans complete HTTP authorities, including WHATWG TAB/LF/CR removal inside userinfo. Ambiguous control-joined URL/email text rejects; ordinary space/prose-separated email and benign path/query values remain valid. No limits, formulas or publication authority changed.

PR114 is updated and non-draft. All ten known threads are replied and resolved: [malformed target reply](https://github.com/dadriano/packscout/pull/114#discussion_r3938944564), [embedded userinfo reply](https://github.com/dadriano/packscout/pull/114#discussion_r3938944595). GitHub CI and reviewer approval remain separate; no merge or public activation occurred. P05A may resume after root restacks its exact saved8f6b07b1 boundary onto the verified published parent.

## Verified prior nested-URL review repair — 2026-09-04

PR114's eighth finding3938512559 is fixed in `ab2e144623d9e84009b7a2dec6513cf59be146f7` on main parent `cd9c2da8c072942d4a1f64fb5c4982499d48f973`. The genuine red failed before the bounded structural fix. Independent review approved the final relative/absolute/form-fragment, malformed-percent, protected-name and userinfo matrix while preserving benign encoded values. The fresh complete `npm run verify:framework` PASSED, including all database/service/Convex/app/tooling checks and both production builds: `/tmp/packscout-p03-nested-url-framework-certified-20260904.log`. The previously timed-out maximum shared-delivery case also passes without changed limits. Runtime is committed and pushed; the eighth review has a fix reply. No public writer, head, or route was activated. P05A may restack onto this verified parent and resume.

## Verified derived-search review repair — 2026-09-04

PR114's seventh finding reproduced as a missing expected rejection: separately valid title and alias fields could synthesize credential text in the derived search projection. The complete normalized public payload now passes the same bounded protected-data guard before sealing. The direct regression preserves benign joined text and rejects synthesized credentials. All44 focused unit/capacity checks pass with zero skips; services lint/types and the zero-finding ratchet pass. The complete `npm run verify:framework` PASSED, including the PostgreSQL seam and both production builds. Log: `/tmp/packscout-p03-derived-credentials-framework-20260904.log`. An independent review found no actionable issue. No publisher or public head was activated.

## Prior checkpoints — 2026-09-04

Two further PR114 P1 findings reproduced as missing expected rejections in /tmp/packscout-p03-inline-fragment-credentials-review-red-20260904.log. The repair scans credential patterns anywhere in trimmed/NFC-normalized text and decoded URL query/fragment keys and values. The complete162-check focused matrix passes with zero skips, as do services lint/types and the zero-finding ratchet; log /tmp/packscout-p03-inline-fragment-credentials-review-focused-20260904.log. The full framework gate PASSED on `2ad492cd`, including both production builds; log /tmp/packscout-p03-inline-fragment-credentials-review-framework-20260904.log. No merge or publisher activation is authorized.

Main advanced through PR112 while the review repair was being certified. P03 is restacked onto `cd9c2da8c072942d4a1f64fb5c4982499d48f973`; the mapped review-repair runtime is `42cd1a9a18c0f5280cfdcd17441cfe78f5242e6a`, byte-identical under `packages/services` to pre-restack `57d20370`. The parent-sensitive162-check focused matrix, services lint/types, docs, and ratchet pass; log /tmp/packscout-p03-main112-restack-focused-20260904.log. The full framework gate PASSED on restack checkpoint `db49f84b`, including both production builds; log /tmp/packscout-p03-main112-restack-framework-20260904.log.

PR114 review follow-up: public text is trimmed and NFC-normalized before credential detection, and the generic signed-query key `sig` is rejected alongside named signature keys. Both findings reproduced as missing expected rejections in /tmp/packscout-p03-normalized-credentials-review-red-20260904.log. The repaired runtime passes 162 combined checks (44 assembler plus118 predecessor/interface), zero skips, services lint/types, and the zero-finding ratchet. Log: /tmp/packscout-p03-normalized-credentials-review-focused-20260904.log. The fresh full framework gate PASSED on `57d20370`, including both production builds; log /tmp/packscout-p03-normalized-credentials-review-framework-20260904.log. No P03 merge or publisher activation is authorized.

PR114 review follow-up: every URL field is parsed before protected-query scanning, and every existing candidate is byte-bounded before cloning/schema parsing. Both findings reproduced as missing rejections in /tmp/packscout-p03-url-reuse-review-red-20260904.log. The repaired runtime passes 161 combined checks (43 assembler plus118 predecessor/interface), zero skips, services lint/types, docs, and the zero-finding ratchet. Log: /tmp/packscout-p03-url-reuse-review-focused-20260904.log. The fresh full framework gate PASSED on `28ccbc61`, including both production builds; log /tmp/packscout-p03-url-reuse-review-framework-20260904.log. No P03 merge or publisher activation is authorized.

PR95 merged at 16:32 UTC as `631b9f38badf3233cf470d2108ff3ebdbb988d9f`, tree-identical to certified `bd5f3c64`. Full local framework verification and [CI33893274713](https://github.com/dadriano/packscout/actions/runs/33893274713) passed; all 35 review findings are resolved. The final P02 runtime is `b5482a96`: 118 focused checks, 30 schema checks, affected static gates, and 13 signed store checks pass. Publication remains dormant.

P03 implementation `2ad492cd9add49e5d0a8d78f9e7bc72eb01ac3be` on current main parent `cd9c2da8c072942d4a1f64fb5c4982499d48f973` passes **162 combined checks, zero skips** (44 assembler and 118 predecessor/interface checks), services lint/types, docs, and the zero-finding standards ratchet. Evidence: `/tmp/packscout-p03-inline-fragment-credentials-review-focused-20260904.log`. Full current-parent `npm run verify:framework` PASSED on `2ad492cd`, including both production builds; log `/tmp/packscout-p03-inline-fragment-credentials-review-framework-20260904.log`.

Task acceptance is committed. The original cc0963f0 branch remains backed up, and all latest task records were preserved through the three-commit restack. Published separately in [PR114](https://github.com/dadriano/packscout/pull/114), current CI pending; **do not merge P03** or activate publication.

## Start Here

Assemble the P01 pack fixture twice from identical pinned inputs presented in different orders, then record the identical canonical bytes, ordered batch hashes, aggregate hash, counts, snapshot identity, and projections.

## Objective

Produce one complete, bounded, deterministic `PublicPackSnapshot` from immutable pinned inputs without reading a database, mutable public state, or another pack. Invalid, partial, inconsistent, oversized, or protected input fails before any publication work can begin.

## Context

Atomic head activation is useful only when the selected snapshot already contains every pack-specific field needed for display and calculation. The assembler is a pure domain boundary: it converts one pinned desired pack state into canonical public bytes and evidence without owning persistence, scheduling, network calls, or head activation.

Snapshot identities represent domain-state revisions. Identical semantic inputs must yield identical bytes regardless of input order, process timing, or worker identity. All times, source identities, and policy identities that affect output are therefore supplied as immutable inputs rather than read during assembly.

Provider-wide profile fields remain outside pack bytes. Shared collectible, category, display, and valuation data required for this pack is copied into the snapshot so a later independent profile change cannot make the pack internally inconsistent.

## Delivery Context

P03 stacks on verified P02 (PR95), because P02 now owns the executable immutable captured-input contract and shared lifecycle-preservation rule. It does not duplicate those contracts or depend on a database at runtime. Its review promise remains pure snapshot assembly in one phase-only PR. P04 and P05 remain independent foundation phases. After merge, no runtime invokes the assembler and no public behavior changes; P06 integrates it with durable provider work and public publication.

## Requirements

### Complete snapshot

- Bind one stable pack identity, provider identity, pack metadata, price, mapped availability, retirement provenance, eligible actions, full active membership, odds, and pinned calculation inputs.
- Include immutable collectible and category display fields, every eligible member's valuation dependency, the selected top chase, matching EV result, and EV method and policy identities.
- Carry the existing native `publicRepackId` and `publicCollectibleId` values supplied by the request and never derive replacement public identities.
- Produce byte-equivalent summary, detail, search, desired-collectible, action, chase, and EV projections from the same complete snapshot.
- Exclude provider-wide profile fields and every field outside the P01 `PublicPackSnapshot` boundary.

### Chase, EV, and lifecycle

- Select the highest-valued eligible collectible as top chase with the P01 deterministic tie-break rule.
- Seal the full eligible-member valuation dependency set so a change to any candidate can produce a different snapshot and chase result.
- Carry explicit EV `unavailable` for a valid domain result, but reject absent, failed, expired, or input-mismatched calculation evidence.
- Bind numeric EV to the exact pack, contents, odds, valuation, method, and policy identities supplied by the build request.
- For lifecycle-only work, clone the complete prior sealed snapshot and change only lifecycle provenance, eligible actions, and deterministic EV presentation or freeze metadata; preserve contents, economic inputs, and numeric EV.

### Determinism and bounds

- Canonically order object fields, content members, dependencies, projections, and batches so input ordering cannot affect output.
- Derive the content hash and `publicPackSnapshotId` from the declared canonical hash domain and complete canonical public bytes.
- Partition the snapshot into bounded ordered batches whose individual hashes, counts, and aggregate hash validate against one descriptor.
- Keep provider change sequence and shared-dependency identities in `PackSnapshotEvidence` rather than using them as a combined order or including mutable worker state.
- Return `reused` only when the supplied existing snapshot identity and bytes match exactly; otherwise return a newly derived `created` result without performing persistence.

### Validation and privacy

- Reject missing or duplicate members, duplicate stable identities, cross-provider or cross-pack rows, invalid probability coverage, stale correlations, and missing dependency snapshots.
- Reject summary, detail, search, desired-collectible, action, chase, valuation, or EV projections that disagree with the complete snapshot.
- Reject runtime-generated time values, mutable handles, unpinned inputs, and a lifecycle-only request without a complete prior snapshot.
- Reject oversized fields, text, nesting depth, member counts, batch counts, batch bytes, and aggregate payload size before returning output.
- Scan recursively and reject credentials, accounts, connection topology, raw source evidence, quarantine details, exact collectible instances, user data, stack traces, and unbounded payloads.

## User-Facing Behavior

There is no direct user-facing change. The assembled artifact guarantees that any pack later selected by a public head presents metadata, lifecycle, contents, odds, chase, valuations, EV, and actions from one internally consistent domain snapshot.

## Interface Contract

`ProviderPackSnapshotAssembler.assemble` accepts `AssembleProviderPackSnapshotInput`: one fenced `PackBuildRequest`, immutable pack and full-content inputs or a permitted lifecycle source snapshot, all eligible-member dependency projections, matching EV evidence, provider change sequence, shared-dependency identities, and an existing byte-identical snapshot reference when present.

It returns `BuiltPublicPackSnapshot`, containing `PublicPackSnapshotDescriptor`, ordered `PublicPackSnapshotBatch` values, the complete `PublicPackSnapshot`, separate `PackSnapshotEvidence`, and a `created` or `reused` disposition. The canonical hash domain is `packscout.public-pack-snapshot.v1`.

The assembler performs no read, write, lease, schedule, network, credential, or head operation. Its output contains no database target, mutable-row handle, authorization material, source payload, provider-profile body, exact collectible instance, or user record.

## Acceptance Criteria

### Deterministic output

- [x] Reordered but semantically identical inputs produce identical canonical bytes, batches, counts, hashes, snapshot identity, and projections.
- [x] A later concurrent source change cannot alter a result assembled from pinned inputs.
- [x] An exact supplied snapshot match returns `reused`; any public-byte change produces a distinct `created` snapshot identity.
- [x] Summary, detail, search, desired-collectible, actions, chase, valuations, and EV all validate against the same snapshot identity.
- [x] Every batch and aggregate stays within declared count, document, and byte bounds, including maximum full/lifecycle/reuse inputs.

### Domain behavior

- [x] Raising a previously non-top eligible member's valuation updates top chase and the snapshot hash.
- [x] A deterministic valuation tie selects the P01-declared stable winner regardless of input order.
- [x] A valid EV-unavailable result assembles without a numeric value, while technical calculation failure is rejected.
- [x] An available-to-sold-out lifecycle snapshot records provenance and EV freeze metadata, disables actions, and preserves numeric economics and contents.
- [x] Provider-wide profile changes are absent from pack bytes and cannot alter the snapshot hash.

### Rejection and privacy

- [x] Partial contents, invalid odds, mismatched EV, stale dependencies, duplicate identities, and cross-provider records fail closed.
- [x] A lifecycle-only request without a complete prior snapshot fails closed.
- [x] Oversized or unbounded inputs fail before a `BuiltPublicPackSnapshot` is returned.
- [ ] Protected-field scanning rejects sensitive values at every nesting depth, including normalized derived projections and nested URLs.
- [x] Rejected assembly performs no persistence, head, receipt, or network operation.
- [ ] Valid public labels and promotion-code links remain accepted while recognizable credentials and private endpoints fail closed.

## Verification

Named scenario: **Complete deterministic pack snapshot suite** — assemble lifecycle, contents, odds, chase, valuation, EV, reuse, size-bound, protected-field, and concurrent-change fixtures twice and compare every canonical output.

## Spec Compliance

- `tech-001` contract/canonicalization/projection requirements and `tech-002` pure-assembler requirements are implemented against the executable V1 fixtures. Task 004 retains central fan-out/profile assembly, task 005 retains public storage/API, and task 006 retains runtime composition, publication authorization, and current-state fencing; those shared-spec sections are deliberately not activated here.
- `ProviderPackSnapshotAssembler` consumes P02's `{ request, inputs }` capture directly, plus an optional existing snapshot. It normalizes using the existing V1 schemas and re-evaluates the request's exact pinned hashes, dependencies, and profile prerequisites. There is no second input schema, legacy adapter, provider branch, or new contract version.
- Capture completes synchronously before the first hash await. Descriptor inspection rejects accessors, proxies, cycles, handles, extra fields, excessive depth, and protected field/query names before cloning. Every string is trimmed and NFC-normalized before credential detection, matching the public-text schema; credential patterns are scanned throughout the normalized value rather than only at its start. Every URL field is parsed, and decoded query and fragment keys and values are scanned, so uppercase/mixed-case schemes, leading whitespace, percent-encoded keys, generic signed-query `sig`, and fragment tokens cannot bypass protection. Every supplied reuse candidate receives its own16 MB canonical byte check before cloning/schema parsing, even when its ID differs. Output is recursively frozen; errors expose only a stable code/reason, not rejected values.
- Full assembly derives chase, summary, search, and action/EV projections from complete contents. Every valuation participates in the input digest. Lifecycle assembly verifies and clones the complete sealed baseline, retaining metadata, contents, search, numeric EV, and economics while changing lifecycle/action eligibility and provenance/freeze metadata.
- The fixed partition greedily fills canonical native-ID order up to 250 rows or 480,000 UTF-8 bytes, then starts the next batch. There is no caller-configurable chunk size. Batch counts are capped at 32, header/descriptor documents at 480,000 bytes, and complete/aggregate artifacts at 16,000,000 bytes. P02 independently caps the current capture and full lifecycle baseline at 16,000,000 bytes each. P03's pre-clone envelope remains 48,000,000 bytes with depth16; its measured node bound is650,000, accommodating about593,000 nodes for maximum contents, baseline/reuse, and10,000 dependencies without relaxing byte limits.
- The assembler now uses P05's shared `packSearchText(title, aliases)` and accepts exactly1,024 characters while independently refusing1,025 under a forged request. Full member names stay in complete contents. The document-size guard uses `packSnapshotHeaderFromPayload(payload).header`; the complete payload-minus-contents header remains the canonical hash/aggregate input. The8,000-member regression proves32 batches, full dependency vectors, exact hash, complete lifecycle freeze, and artifact reuse. No technical spec was rewritten.
- Validation uses the immutable request's `requestedAt`, never live time. P02/P06 own current lease, epoch, desired-state and publication-expiry checks; P03 cannot decide whether a finished artifact is still authorized for publication.
- P06 must project `{ snapshot, descriptor, batches }` into `ProviderPackSnapshotRepository.sealAndEnqueueActivation`. Returned evidence, canonical payload JSON, payload hash, and reuse disposition are separate assembly metadata, not additional fields in P02's strict publication envelope.
- The PostgreSQL seam test loads an actual fenced P02 request, rejects invalid assembly without persistence, assembles valid input without persistence, then explicitly seals the artifact and intent through P02. It verifies the head remains inactive and no publication operation or receipt exists. No processor, schedule, Convex deployment, or frontend behavior is enabled by P03; P06 owns runnable publication E2E proof.

### Historical evidence before parent review correction

- `provider-pack-snapshot-assembler.test.ts`: exact P01 golden bytes for two independent packs and lifecycle freeze; 32 ordering permutations; NFC/timestamp normalization; synchronous capture; operational sequence/time independence; exact reuse; profile-body independence; all-member chase updates and stable ties; domain EV-unavailable behavior.
- `provider-pack-snapshot-assembler-boundaries.test.ts`: invalid contents/odds/profile/EV/dependencies, cross-scope and forged requests, lifecycle baseline integrity, contradictory projections, protected fields at multiple depths, getters/proxies/handles, oversized values/counts/search, no live clock/network, and a 400-member three-batch fixture with independently recomputed UTF-8 counts and aggregate proofs.
- `provider-pack-snapshot-assembler.integration.test.ts`: real PostgreSQL P02 → P03 → artifact/intent seam with no head activation.
- Focused command: `node --import tsx --test packages/services/src/provider-pack-snapshot-assembler*.test.ts` — 40 tests passed, zero skipped.
- Predecessor command: `node --import tsx --test packages/services/src/provider-pack-readiness-evaluator.test.ts packages/services/src/provider-pack-publication.integration.test.ts` — 32 tests passed, zero skipped.
- Node's focused coverage report: 100% reported lines/functions and 99.25% branches across the four assembler runtime modules. Coverage supplements, rather than replaces, the acceptance scenarios.
- At that historical checkpoint, all remaining gate components passed independently: framework boundaries/docs/scripts/Prisma-only checks, zero-finding standards ratchet, Prisma schema/generation/lifecycle/setup checks, repository-wide lint and type-checks, all package/Convex tests, tooling tests, and frontend/admin production builds. It was not a successful `verify:framework` run because its required dependency audit was unverified. Existing bundler dependency/chunk-size warnings did not fail those builds; none of this certifies the next P03 restack.

## Historical published delivery checkpoint — superseded by active repair above

- Verified implementation: `ab2e144623d9e84009b7a2dec6513cf59be146f7`; direct parent: main `cd9c2da8c072942d4a1f64fb5c4982499d48f973`.
- Published, open, non-draft: [PR114](https://github.com/dadriano/packscout/pull/114). All eight known findings are fixed; latest [reply](https://github.com/dadriano/packscout/pull/114#discussion_r3938749670) cites the exact commit. Inspect live CI/review state; local passing gates are not reviewer approval.
- Full current-head framework log: `/tmp/packscout-p03-nested-url-framework-certified-20260904.log`; independent review and final targeted nested-URL regression pass.
- Delivery-only task records follow the certified runtime. No P03 merge is authorized without fresh approval; publication remains dormant.
- Current release/stack context: [_handoff.md](_handoff.md).
