# Buyback-Adjusted EV Launch Certification

Status: task `buyback-adjusted-ev/013` final gate — the certification record, the eight-provider provenance harness, the product-experience evidence manifest, and the strict pass-or-blocked verifier for production activation.

Certification is strict **pass or blocked**. `evaluatePackScoutBuybackEvLaunchCertificationV1` recomputes every automated criterion from raw evidence on every call, and every human criterion ships as an explicit `unrecorded` approval entry that only a recorded human decision (approver identity plus timestamp) can flip. There is no waiver, override, or partial pass; production activation cannot proceed on a blocked certification. The record carries a sha-256 digest over its canonical body.

## Provider-to-browser provenance

`runBuybackEvLaunchCertificationHarness` (`packages/services/src/buyback-adjusted-ev-launch-certification.test-support.ts`) traces one sanitized real example per launch provider — Courtyard, Collector Crypt, Phygitals, ClutchPacks, GameStop, Beezie, Trove, and Stadium Vault — through the unmodified production path:

sanitized source revision → real task-004 provider normalizer → recomputation fingerprint → immutable task-005 revision → canonical metrics and confidence → staged (never activated) `data_release_v3` plan through the real task-008 assembler → task-007 query projection (summary/detail byte-equivalence) → rendered output from the real frontend presentation boundary.

Across the set the examples cover: uniform rate, outcome-specific rate, ineligibility, fixed payout, mandatory adjustment (fee, floor, cap), no buyback, current-pool odds, published-odds fallback, closed-range midpoint, and unavailable evidence. Every hop is reconciled against independent plain-arithmetic expectations computed from the sanitized source numbers; the first disagreement is recorded as the trace's launch-blocking mismatch.

The harness additionally proves:

- **Vendor separation** — a vendor-reported EV rides beside the PackScout estimate, never equals it, never substitutes for it, and renders under the vendor source note.
- **Pulls through verified inventory only** — a pull ledger proven to belong to the same source revision deterministically updates remaining inventory and changes EV exactly as the arithmetic predicts; a pull ledger from an unproven revision changes nothing.
- **Public-boundary sanitization** — both staged releases and every rendered output are scanned against the forbidden-token list (raw payload markers, protected evidence spellings, credentials, organization and provider identifiers, source revision identifiers, configuration revisions, evidence digests, and the pre-buyback vocabulary) plus the contract tripwires.

The frontend presentation boundary is loaded through a runtime-resolved file URL under the tsx loader (`loadPackScoutEvPresentationBoundary`). Production code never crosses the services/frontend boundary; this certification-only seam exists so the exact displayed strings are reconciled against the staged release values.

`buyback-adjusted-ev-launch-certification.integration.test.ts` runs the harness DB-backed against a migrated PostgreSQL (16 at `127.0.0.1:5432`) on every services test run.

## Product-experience evidence manifest

`PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1` maps every launch claim — metric states, simulation coverage, rankings, KPIs, sorts, filters, pagination, desired collectibles, saves, Heat unavailability, selected details, outbound actions, glossary and Learn content, responsible-play contact, last-known EV retention and confidence decay, degraded anonymous browsing, and operational recovery — to the existing test files and exact test names that prove it. `buyback-adjusted-ev-launch-certification.test.ts` fails whenever a referenced file disappears or a named test is renamed, so the manifest cannot rot silently, and the generator re-verifies it at composition time.

## Certification criteria

| Criterion | Kind | Passes when |
| --- | --- | --- |
| `operational_readiness_linked` | automated | a composed task-012 ledger with readiness `pass` is linked by digest |
| `provider_traces_reconciled` | automated | all eight providers trace with zero mismatches and the ten scenario classes are jointly covered |
| `vendor_ev_separation_proven` | automated | the vendor-separation proof is recorded |
| `pulls_verified_inventory_only` | automated | the proven/unproven pulls proof is recorded |
| `public_boundary_sanitized` | automated | both scans ran with zero forbidden-token hits |
| `product_experience_manifest_verified` | automated | every manifest claim resolves to its named tests |
| `verification_gate_passed` | automated | recorded commands all exit 0, include `verify:framework`, and pin the candidate commit |
| `release_identity_recorded` | automated | the staged release identity, fingerprints, and configuration hash are recorded |
| `rollback_proof_recorded` | automated | the linked ledger carries the executed maintenance-gated rollback drill |
| `browser_evidence_closed` | automated | every deploy-stage browser checklist item is closed by a recorded live-deploy pass |
| `product_approval_recorded` | human | Product approves terminology, examples, methodology, and responsible-play content |
| `engineering_approval_recorded` | human | Engineering approves provenance, privacy, performance, observability, activation, and rollback |
| `gamestop_trove_terms_confirmed` | human | the real GameStop and Trove buyback terms are confirmed against product truth (task 004 divergence) |
| `ncpg_contact_review_recorded` | human | a content owner reviews the responsible-play contact recorded at task 011 |

The deploy-stage browser checklist (both themes, 390×844 and 200% zoom, keyboard-only walk with focus trap and return, live deadline flip, GlossaryHint positioning, reduced motion, live Learn routes, hydration and console state, and degraded anonymous browsing) ships as `pending_deploy` items sourced from the recorded task-010 and task-011 checklists plus this task; only the live-deploy pass closes them.

## Generating the record

```bash
node --import tsx scripts/local/certify-buyback-ev-launch.mjs \
  [--readiness-ledger docs/evidence/buyback-adjusted-ev-readiness-ledger.json] \
  [--verification-json <path>] [--application-commit <sha>] \
  [--out docs/evidence/buyback-adjusted-ev-launch-certification.json]
```

The generator executes the certification harness against a throwaway migrated loopback PostgreSQL database (created and dropped by the database test-support factory), verifies the manifest, links the task-012 readiness ledger, and writes the record to the gitignored `docs/evidence/` path. It exits nonzero while the certification is blocked. The expected pre-approval state is **blocked** on `browser_evidence_closed` and the four human approvals — the generator never records an approval and there is no automated path that can.

## Reproducing the evidence

PostgreSQL 16 at `127.0.0.1:5432` is required for the DB-backed lanes.

```bash
node --import tsx --test \
  packages/services/src/buyback-adjusted-ev-launch-certification.test.ts \
  packages/services/src/buyback-adjusted-ev-launch-certification.integration.test.ts
node --test scripts/local/certify-buyback-ev-launch.test.mjs
npm run typecheck
npm run lint:services
npm run scan:framework-standards:ratchet
```
