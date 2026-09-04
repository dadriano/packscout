import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveProviderPackInputDigests, normalizePackCatalogSearchText, type ProviderPackBuildInputs } from "@packscout/contracts";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture, publicationHash } from "./provider-pack-publication.test-support.ts";

test("Provider-local planning and persistence crash matrix: deterministic readiness", async context => {
  const evaluator = new ProviderPackReadinessEvaluator();
  const { inputs, built } = await freshPublicationFixture();
  const evaluatedAt = new Date().toISOString();
  const evaluate = (candidate: ProviderPackBuildInputs) => evaluator.evaluate({ candidate, evaluatedAt });
  const ready = await evaluate(inputs);
  assert.equal(ready.readiness.outcome, "ready");
  assert.equal(ready.readiness.desiredStateSha256, await publicationHash(ready.inputs));
  assert.equal(ready.readiness.evInputsSha256, inputs.evInputsSha256);
  const cases: Array<[string, (candidate: ProviderPackBuildInputs) => void, string, string]> = [
    ["partial contents wait", value => { value.contentsComplete = false; }, "waiting", "INCOMPLETE_CONTENTS"],
    ["invalid odds block", value => { value.contents[0]!.probabilityMicros -= 1; }, "blocked", "INVALID_PROBABILITIES"],
    ["duplicate native member blocks", value => { value.contents[1] = value.contents[0]!; }, "blocked", "INVALID_PROBABILITIES"],
    ["missing initial profiles wait", value => { value.contents[0]!.collectibleProfileSnapshotId = null; }, "waiting", "PROFILE_HEAD_MISSING"],
    ["technical EV failure waits", value => { value.evFailure = "technical"; }, "waiting", "EV_TECHNICAL_RETRY"],
    ["absent EV waits", value => { value.ev = null; }, "waiting", "EV_INPUTS_PENDING"],
    ["mismatched EV identity waits", value => { value.evInputsSha256 = "f".repeat(64); }, "waiting", "EV_INPUTS_PENDING"],
    ["permanently invalid domain blocks", value => { value.evFailure = "invalid_domain"; }, "blocked", "INVALID_DOMAIN_DATA"],
    ["stale dependency waits", value => { value.expectedDependencies = [{ kind: "valuation", identity: value.contents[0]!.publicCollectibleId, contentSha256: "f".repeat(64) }]; }, "waiting", "EV_INPUTS_PENDING"],
    ["missing lifecycle baseline waits", value => { value.snapshotKind = "lifecycle_only"; }, "waiting", "INCOMPLETE_CONTENTS"],
    ["action eligibility is sealed", value => { value.actions[0]!.enabled = false; value.actions[0]!.disabledReason = "PACK_UNAVAILABLE"; }, "blocked", "INVALID_DOMAIN_DATA"],
    ["duplicate action identities block", value => { value.actions = [value.actions[0]!, { ...value.actions[0]! }]; }, "blocked", "INVALID_DOMAIN_DATA"],
    ["duplicate member profile identities block", value => { value.contents[1]!.collectibleProfileSnapshotId = value.contents[0]!.collectibleProfileSnapshotId; }, "blocked", "INVALID_DOMAIN_DATA"],
    ["duplicate eligible valuation identities block", value => { value.contents[1]!.eligibleForChase = true;
      value.contents[1]!.valuation.valuationIdentity = value.contents[0]!.valuation.valuationIdentity; }, "blocked", "INVALID_DOMAIN_DATA"],
  ];
  for (const [name, mutate, outcome, reasonCode] of cases) await context.test(name, async () => {
    const candidate = structuredClone(inputs); mutate(candidate);
    const result = await evaluate(candidate);
    assert.equal(result.readiness.outcome, outcome); assert.equal(result.readiness.reasonCode, reasonCode);
  });
  await context.test("domain EV unavailable is ready, but expired evidence waits", async () => {
    const candidate = structuredClone(inputs);
    candidate.ev = { status: "unavailable", reason: "NO_CALCULABLE_VALUE", evaluatedAt: inputs.ev!.evaluatedAt, validUntil: inputs.ev!.validUntil };
    assert.equal((await evaluate(candidate)).readiness.outcome, "ready");
    candidate.ev.evaluatedAt = "2020-01-01T00:00:00.000Z";
    candidate.ev.validUntil = "2020-01-02T00:00:00.000Z";
    assert.equal((await evaluate(candidate)).readiness.outcome, "waiting");
  });
  await context.test("lifecycle baseline is pinned and cannot change economics", async () => {
    const candidate = { ...inputs, snapshotKind: "lifecycle_only" as const, lifecycleProvenanceIdentity: "lifecycle:2" };
    const result = await evaluator.evaluate({ candidate, evaluatedAt, previousSnapshot: built.snapshot });
    assert.equal(result.readiness.outcome, "ready");
    assert.deepEqual(result.inputs.lifecycleBaseline, built.snapshot);
    assert.equal((await evaluator.evaluate({ candidate: { ...candidate, price: { currency: "USD", minorUnits: 1 } },
      evaluatedAt, previousSnapshot: built.snapshot })).readiness.outcome, "blocked");
  });
  await context.test("equivalent input ordering and exact represented identity coalesce", async () => {
    const result = await evaluate({ ...inputs, contents: [...inputs.contents].reverse(), aliases: [...inputs.aliases].reverse(), actions: [...inputs.actions].reverse() });
    assert.deepEqual(result, ready);
    assert.equal((await evaluator.evaluate({ candidate: inputs, evaluatedAt, representedDigest: ready.readiness.desiredStateSha256 })).readiness.outcome, "no_change");
  });
  await context.test("lifecycle-only freezes metadata, profiles, aliases, policy and action definitions", async () => {
    const changes: Array<(value: ProviderPackBuildInputs) => void> = [
      value => { value.title = "Changed"; }, value => { value.imageUrl = "https://example.com/changed.jpg"; },
      value => { value.category.label = "Changed"; }, value => { value.providerProfileSnapshotId = `ppfs_${"e".repeat(64)}`; },
      value => { value.contents[0]!.collectibleProfileSnapshotId = `ppfs_${"e".repeat(64)}`; },
      value => { value.aliases = ["changed"]; }, value => { value.evMethodIdentity = "changed"; },
      value => { value.evPolicyIdentity = "changed"; }, value => { value.actions[0]!.label = "Changed"; },
    ];
    for (const change of changes) {
      const candidate = structuredClone(inputs); candidate.snapshotKind = "lifecycle_only"; candidate.lifecycleProvenanceIdentity = "lifecycle:3";
      change(candidate);
      assert.equal((await evaluator.evaluate({ candidate, evaluatedAt, previousSnapshot: built.snapshot })).readiness.outcome, "blocked");
    }
    const candidate = structuredClone(inputs); candidate.snapshotKind = "lifecycle_only"; candidate.lifecycleProvenanceIdentity = "sold-out:3";
    candidate.lifecycle = { ...candidate.lifecycle, availability: "sold_out", availabilityEvidence: { kind: "explicit_sold_out", sourceIdentity: "sold-out:3" } };
    candidate.actions = candidate.actions.map(action => ({ ...action, enabled: false, disabledReason: "PACK_UNAVAILABLE" }));
    assert.equal((await evaluator.evaluate({ candidate, evaluatedAt, previousSnapshot: built.snapshot })).readiness.outcome, "ready");
  });
  await context.test("only public-contract-sized unique aliases can become ready", async () => {
    assert.equal((await evaluate({ ...inputs, aliases: ["a".repeat(120)] })).readiness.outcome, "ready");
    for (const aliases of [["a".repeat(121)], ["same", "same"], ["same", " same "]]) {
      await assert.rejects(evaluate({ ...inputs, aliases }));
    }
  });
  await context.test("complete search text must fit without dropping members or aliases", async () => {
    for (const [lastAliasLength, outcome] of [[106, "ready"], [107, "blocked"]] as const) {
      const candidate = structuredClone(inputs);
      candidate.title = "t".repeat(200);
      candidate.contents.forEach(row => { row.displayName = "m".repeat(200); });
      candidate.aliases = ["a".repeat(104), "b".repeat(104), "c".repeat(104), "d".repeat(lastAliasLength)];
      assert.equal(normalizePackCatalogSearchText([candidate.title, ...candidate.contents.map(row => row.displayName),
        ...candidate.aliases].join(" ")).length, lastAliasLength === 106 ? 1_024 : 1_025);
      const result = await evaluate(candidate);
      assert.equal(result.readiness.outcome, outcome);
      assert.equal(result.readiness.reasonCode, outcome === "ready" ? null : "INVALID_DOMAIN_DATA");
    }
  });
  await context.test("aggregate member search limits include the pack category", async () => {
    for (const [count, longNames, outcome] of [[6, true, "blocked"], [99, false, "ready"], [100, false, "blocked"]] as const) {
      const candidate = structuredClone(inputs);
      candidate.title = "pack"; candidate.aliases = [];
      candidate.contents = Array.from({ length: count }, (_, index) => ({ ...structuredClone(inputs.contents[0]!),
        publicCollectibleId: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
        collectibleProfileSnapshotId: `ppfs_${(index + 1).toString(16).padStart(64, "0")}`,
        displayName: longNames ? "m".repeat(200) : "m", eligibleForChase: false,
        category: { ...inputs.category, publicCategoryId: `00000000-0000-4000-9000-${(index + 1).toString().padStart(12, "0")}` },
        probabilityMicros: Math.floor(1_000_000 / count) + (index === 0 ? 1_000_000 % count : 0),
      }));
      candidate.evInputsSha256 = (await deriveProviderPackInputDigests(candidate)).evInputsSha256;
      const result = await evaluate(candidate);
      assert.equal(result.readiness.outcome, outcome, `${count} members, long names: ${longNames}`);
      assert.equal(result.readiness.reasonCode, outcome === "ready" ? null : "INVALID_DOMAIN_DATA");
    }
  });
  await context.test("unknown protected fields and credential-bearing URLs cannot be captured", async () => {
    await assert.rejects(evaluate({ ...inputs, authorization: "Bearer secret" } as ProviderPackBuildInputs));
    await assert.rejects(evaluate({ ...inputs, imageUrl: "https://user:password@example.com/a.jpg" }));
  });
});
