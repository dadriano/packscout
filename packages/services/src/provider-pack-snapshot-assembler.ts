import {
  PACK_CATALOG_V1, PACK_SNAPSHOT_HASH_DOMAIN, compareCanonicalStrings, hashPackCatalogValue,
  normalizePackCatalogSearchText, normalizePublicPackSnapshotPayload, packCatalogCanonicalJson,
  publicPackContentSchema, publicPackEvResultSchema, publicPackSnapshotSchema, publicPackSummaryCore,
  publicProfileSnapshotIdSchema, type ProviderPackBuildInputs, type ProviderPackReadiness, type PublicPackContent,
} from "@packscout/contracts";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { capturePackAssemblyInput, freezePackAssembly } from "./pack-snapshot-assembly-input.ts";
import { sealPackAssembly } from "./pack-snapshot-assembly-seal.ts";
import { PackSnapshotAssemblyError, requireAssembly,
  type AssembleProviderPackSnapshotInput, type BuiltPublicPackSnapshot } from "./pack-snapshot-assembly-types.ts";

const equal = (left: unknown, right: unknown) => packCatalogCanonicalJson(left) === packCatalogCanonicalJson(right);

function topChase(contents: PublicPackContent[]) {
  const eligible = contents.filter(row => row.eligibleForChase && row.valuation.status === "available");
  eligible.sort((left, right) => {
    if (left.valuation.status !== "available" || right.valuation.status !== "available") return 0;
    return right.valuation.amount.minorUnits - left.valuation.amount.minorUnits || compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId);
  });
  const winner = eligible[0];
  return winner?.valuation.status === "available" ? { publicCollectibleId: winner.publicCollectibleId,
    valuationIdentity: winner.valuation.valuationIdentity, amount: winner.valuation.amount } : null;
}

async function fullPayload(inputs: ProviderPackBuildInputs, readiness: ProviderPackReadiness) {
  const contents = inputs.contents.map(row => publicPackContentSchema.parse(row));
  const chase = topChase(contents), ev = publicPackEvResultSchema.parse(inputs.ev);
  const economicsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { price: inputs.price, records: contents,
    probabilityInputsSha256: readiness.probabilityInputsSha256, valuationsSha256: readiness.valuationInputsSha256,
    topChase: chase, evInputsSha256: readiness.evInputsSha256, ev });
  const core = { schemaVersion: PACK_CATALOG_V1, snapshotKind: "full" as const, providerId: inputs.providerId,
    publicRepackId: inputs.publicRepackId, providerProfileSnapshotId: publicProfileSnapshotIdSchema.parse(inputs.providerProfileSnapshotId),
    collectibleProfileSnapshotIds: contents.map(row => row.collectibleProfileSnapshotId).sort(compareCanonicalStrings),
    dataAsOf: inputs.dataAsOf, title: inputs.title, imageUrl: inputs.imageUrl, category: inputs.category, price: inputs.price,
    lifecycle: inputs.lifecycle, contents, contentCount: contents.length, probabilityTotalMicros: 1_000_000 as const,
    probabilityInputsSha256: readiness.probabilityInputsSha256,
    valuationDependencyIdentities: contents.filter(row => row.eligibleForChase).map(row => row.valuation.valuationIdentity).sort(compareCanonicalStrings),
    valuationsSha256: readiness.valuationInputsSha256, topChase: chase, evMethodIdentity: inputs.evMethodIdentity,
    evPolicyIdentity: inputs.evPolicyIdentity, evInputsSha256: readiness.evInputsSha256, ev, economicsSha256,
    lifecycleFreeze: null, actions: inputs.actions };
  return normalizePublicPackSnapshotPayload({ ...core, summaryProjection: publicPackSummaryCore(core), searchProjection: {
    publicRepackId: inputs.publicRepackId, aliases: inputs.aliases,
    normalizedText: normalizePackCatalogSearchText([inputs.title, ...contents.map(row => row.displayName), ...inputs.aliases].join(" ")),
    categoryIds: [...new Set([inputs.category.publicCategoryId, ...contents.map(row => row.category.publicCategoryId)])].sort(compareCanonicalStrings),
  } });
}

async function lifecyclePayload(inputs: ProviderPackBuildInputs) {
  requireAssembly(inputs.lifecycleBaseline, "INCOMPLETE_CONTENTS");
  const previous = await publicPackSnapshotSchema.parseAsync(inputs.lifecycleBaseline);
  requireAssembly(equal((await sealPackAssembly(previous.payload)).snapshot, previous));
  const payload = { ...previous.payload, snapshotKind: "lifecycle_only" as const, dataAsOf: inputs.dataAsOf,
    lifecycle: inputs.lifecycle, actions: inputs.actions, lifecycleFreeze: {
      previousSnapshotId: previous.identity.publicPackSnapshotId, retainedEconomicsSha256: previous.payload.economicsSha256,
      provenanceIdentity: inputs.lifecycleProvenanceIdentity,
    } };
  return normalizePublicPackSnapshotPayload({ ...payload, summaryProjection: publicPackSummaryCore(payload) });
}

/** Pure consumer of a fenced request's captured bytes. The supplied requestedAt
 * is the immutable evidence-validation time; live lease/head checks remain P02/P06. */
export class ProviderPackSnapshotAssembler {
  async assemble(raw: AssembleProviderPackSnapshotInput): Promise<BuiltPublicPackSnapshot> {
    try {
      const { inputs, request, existingSnapshot } = capturePackAssemblyInput(raw);
      requireAssembly(request.providerId === inputs.providerId && request.publicRepackId === inputs.publicRepackId &&
        request.evidence.sourceRevisionIdentity === inputs.sourceRevisionIdentity &&
        equal(request.evidence.sharedDependencies, inputs.expectedDependencies));
      const requestedAt = Date.parse(request.requestedAt);
      requireAssembly(Date.parse(inputs.dataAsOf) <= requestedAt && inputs.contents.every(row =>
        row.valuation.status !== "available" || Date.parse(row.valuation.observedAt) <= requestedAt));
      const { readiness } = await new ProviderPackReadinessEvaluator().evaluate({ candidate: inputs, evaluatedAt: request.requestedAt });
      requireAssembly(readiness.outcome === "ready", readiness.reasonCode ?? "INVALID_DOMAIN_DATA");
      for (const key of ["desiredStateSha256", "contentsSha256", "probabilityInputsSha256", "valuationInputsSha256", "evInputsSha256"] as const) {
        requireAssembly(request[key] === readiness[key]);
      }
      requireAssembly(equal(request.requiredProfileSnapshotIds, readiness.requiredProfileSnapshotIds), "PROFILE_HEAD_MISSING");
      const payload = inputs.snapshotKind === "lifecycle_only" ? await lifecyclePayload(inputs) : await fullPayload(inputs, readiness);
      const artifact = await sealPackAssembly(payload);
      let disposition: BuiltPublicPackSnapshot["disposition"] = "created";
      if (existingSnapshot !== null) {
        const existing = await publicPackSnapshotSchema.parseAsync(existingSnapshot);
        requireAssembly(existing.identity.providerId === inputs.providerId && existing.identity.publicRepackId === inputs.publicRepackId);
        if (existing.identity.publicPackSnapshotId === artifact.snapshot.identity.publicPackSnapshotId) {
          requireAssembly(equal(existing, artifact.snapshot));
          disposition = "reused";
        }
      }
      return freezePackAssembly({ ...artifact, evidence: request.evidence, disposition });
    } catch (error) {
      if (error instanceof PackSnapshotAssemblyError) throw error;
      // Zod, URL, and hashing diagnostics can contain rejected values. Never forward them.
      throw new PackSnapshotAssemblyError();
    }
  }
}

export { PackSnapshotAssemblyError, packSnapshotAssemblyLimits } from "./pack-snapshot-assembly-types.ts";
export type { AssembleProviderPackSnapshotInput, BuiltPublicPackSnapshot } from "./pack-snapshot-assembly-types.ts";
