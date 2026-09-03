import assert from "node:assert/strict";
import { packBuildRequestSchema, type ProviderPackBuildInputs } from "@packscout/contracts";
import { createPackCatalogV1Fixture } from "@packscout/contracts/test-fixtures/pack-catalog";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { inputsFromPayload, publicationHash } from "./provider-pack-publication.test-support.ts";

const fixture = createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
export const ASSEMBLY_TIME = "2026-09-03T18:05:00.000Z";

export async function requestFor(inputs: ProviderPackBuildInputs, allowUnready = false) {
  const { buildRequest } = await fixture;
  const result = await new ProviderPackReadinessEvaluator().evaluate({ candidate: inputs, evaluatedAt: ASSEMBLY_TIME });
  if (!allowUnready) assert.equal(result.readiness.outcome, "ready");
  const readiness = result.readiness;
  return { inputs: result.inputs, request: packBuildRequestSchema.parse({
    ...buildRequest, providerId: inputs.providerId, publicRepackId: inputs.publicRepackId,
    desiredStateSha256: readiness.desiredStateSha256, contentsSha256: readiness.contentsSha256,
    probabilityInputsSha256: readiness.probabilityInputsSha256, valuationInputsSha256: readiness.valuationInputsSha256,
    evInputsSha256: readiness.evInputsSha256, requiredProfileSnapshotIds: readiness.requiredProfileSnapshotIds,
    requestedAt: ASSEMBLY_TIME, evidence: { ...buildRequest.evidence, providerId: inputs.providerId,
      publicRepackId: inputs.publicRepackId, sourceRevisionIdentity: inputs.sourceRevisionIdentity,
      sharedDependencies: inputs.expectedDependencies },
  }) };
}

export async function assemblyFixture(kind: "packA" | "packB" | "packAUpdate" = "packA") {
  const catalog = await fixture;
  const golden = structuredClone(catalog.packs[kind]);
  const inputs = inputsFromPayload(golden.snapshot.payload);
  if (kind === "packAUpdate") {
    inputs.lifecycleBaseline = structuredClone(catalog.packs.packA.snapshot);
    inputs.lifecycleProvenanceIdentity = golden.snapshot.payload.lifecycleFreeze!.provenanceIdentity;
  }
  return { golden, input: await requestFor(inputs) };
}

export async function refreshEvInputs(inputs: ProviderPackBuildInputs) {
  const records = [...inputs.contents].sort((a, b) => a.publicCollectibleId.localeCompare(b.publicCollectibleId));
  inputs.evInputsSha256 = await publicationHash({ price: inputs.price,
    probabilityInputsSha256: await publicationHash(records.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros }))),
    valuationsSha256: await publicationHash(records.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation }))),
    evMethodIdentity: inputs.evMethodIdentity, evPolicyIdentity: inputs.evPolicyIdentity });
}
