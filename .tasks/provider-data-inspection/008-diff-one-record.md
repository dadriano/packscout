# Task: Diff One Record Across the Boundary

**ID:** provider-data-inspection/008
**Depends on:** provider-data-inspection/002, provider-data-inspection/004
**Blocks:** provider-data-inspection/009
**Estimated scope:** medium

## Objective

For a single record, the admin server can say exactly which fields differ between what the pipeline holds canonically and what the product serves — by projecting the canonical record through the same public projection the promotion path uses, then comparing that against the published document field by field.

## Context

This is the finest grain of the compare tool, and it has one trap that makes a naive implementation wrong: **the two sides do not share a shape.** A canonical revision's `content_json` is the internal canonical form. A published document is that content run through the public projection the promotion path applies before shipping — renamed and reshaped fields, derived values, money and identifier normalization, and deliberate omissions. Diffing raw canonical content against a published document produces a page of differences that are all expected, which is worse than no diff at all.

The correct comparison is: take the canonical record's current revision, project it through the *same* public projection promotion uses, and compare the result against the published document. Then a reported difference means the published document does not match what promotion would produce today — which is the actual question an operator has.

Reusing the real projection rather than reimplementing it is the requirement. A second, drifting copy of the projection would silently produce false differences the moment the real one changed.

The bridge between the two records is the governed identity mapping that turns a canonical record's natural key into its public entity ID, the same mapping task 007 reconciles on.

## Requirements

- A single-record diff for one provider and one publishable record, addressable from either side: by canonical natural key (`platform_key`, `record_kind`, `external_id`) or by public entity ID.
- The canonical side is projected through the same public projection the promotion path uses. The projection is reused, not reimplemented or approximated.
- The comparison reports differing field paths with the value from each side, and collapses equal fields rather than listing them, so a diff of a mostly-matching record is short.
- Arrays whose elements carry identity are compared by that identity, so a reordering is not reported as a content change. Where element order is itself meaningful, an ordering difference is reported explicitly as an ordering difference, distinct from a value difference.
- Four situations are each reported as their own outcome, never as a diff:
  - the canonical record has no public identity mapping, so it has no published counterpart to compare against;
  - the canonical record projects to nothing because it is not publishable;
  - a published document exists with no canonical counterpart;
  - the projection failed — the reason is reported, and no diff is fabricated.
- The published side is read at a named release; the response states which `publicProviderReleaseId` it compared against, so a diff can be interpreted after a later promotion.
- The redaction rule from task 002 applies to everything this returns: no credential-shaped value from canonical provenance appears in a diff, at any nesting depth.
- Read-only and org-scoped. The diff computes a projection in memory and writes nothing to either side.
- Bounded output: a very large record's diff is capped with an explicit statement of how much was omitted rather than returning an unbounded payload.

## User-Facing Behavior

None directly — task 009 renders this.

## Interface Contract

- Consumes task 002's single-entity read for the canonical content and task 004's single-document read for the published document, plus the governed identity mapping to connect them.
- Task 009 opens a diff from a reconciliation divergence (by public ID) or from a record chosen while browsing (by natural key), so both addressing modes are required.
- The four non-diff outcomes are a closed set that task 009 renders with distinct wording; they are part of the contract, not internal states.
- The response names the release it compared against and whether output was truncated.

## Acceptance Criteria

- [ ] A canonical record whose published document matches what the projection produces reports no differences.
- [ ] A record whose published document is stale reports exactly the fields that differ, with both values, and does not list matching fields.
- [ ] Reordering an identity-keyed array does not produce a value difference; where order is meaningful, it produces an explicit ordering difference.
- [ ] Missing identity mapping, not-publishable, published-without-canonical, and projection-failed each return their own outcome rather than a diff.
- [ ] The response names the `publicProviderReleaseId` it compared against.
- [ ] No credential-shaped value from provenance appears anywhere in the output.
- [ ] An oversized diff is truncated with an explicit statement of what was omitted.
- [ ] The projection used is the promotion path's own; no second copy of it exists.

## Verification

Tests over the diff prove the matching case reports nothing, a stale document reports exactly the differing fields, identity-keyed array reordering is not a value difference, each of the four non-diff outcomes is returned distinctly, redaction holds at depth, and truncation is stated. A test asserts the promotion path's projection is the one invoked, so a divergent second copy fails the build. The services and admin test suites plus the workspace typecheck exit 0.
