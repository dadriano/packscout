import {
  PACK_SNAPSHOT_HASH_DOMAIN, assertPublicPackCatalogBytes, compareCanonicalStrings,
  hashPackCatalogValue, packCatalogCanonicalByteCount, packCatalogCanonicalJson,
  packCatalogTimestampSchema, packPublicationLimits, providerPackBuildInputsSchema, preservesPackLifecycleBaseline,
  publicPackContentSchema, publicPackSnapshotSchema,
  type ProviderPackBuildInputs, type ProviderPackReadiness, type PublicPackSnapshot,
} from "@packscout/contracts";

/** No clock, network, or EV calculation: evaluate only the captured identities. */
export class ProviderPackReadinessEvaluator {
  async evaluate(input: {
    candidate: ProviderPackBuildInputs;
    evaluatedAt: string;
    previousSnapshot?: PublicPackSnapshot | null;
    representedDigest?: string | null;
  }): Promise<{ inputs: ProviderPackBuildInputs; readiness: ProviderPackReadiness }> {
    const inputs = providerPackBuildInputsSchema.parse(input.candidate);
    const now = Date.parse(packCatalogTimestampSchema.parse(input.evaluatedAt));
    if (inputs.snapshotKind === "lifecycle_only") inputs.lifecycleBaseline = input.previousSnapshot ?? inputs.lifecycleBaseline;
    inputs.contents.sort((a, b) => compareCanonicalStrings(a.publicCollectibleId, b.publicCollectibleId));
    inputs.aliases.sort(compareCanonicalStrings);
    inputs.actions.sort((a, b) => compareCanonicalStrings(a.actionId, b.actionId));
    assertPublicPackCatalogBytes(inputs);
    if (packCatalogCanonicalByteCount(inputs) > packPublicationLimits.maximumInputBytes) {
      throw new TypeError("pack.inputs_too_large");
    }
    const hash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);
    const probabilityInputsSha256 = await hash(inputs.contents.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros })));
    const valuationInputsSha256 = await hash(inputs.contents.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation })));
    const evInputsSha256 = await hash({ price: inputs.price, probabilityInputsSha256,
      valuationsSha256: valuationInputsSha256, evMethodIdentity: inputs.evMethodIdentity, evPolicyIdentity: inputs.evPolicyIdentity });
    const readiness: ProviderPackReadiness = {
      outcome: "ready", reasonCode: null,
      desiredStateSha256: await hash(inputs), contentsSha256: await hash(inputs.contents),
      probabilityInputsSha256, valuationInputsSha256, evInputsSha256,
      requiredProfileSnapshotIds: [...new Set([inputs.providerProfileSnapshotId,
        ...inputs.contents.map(row => row.collectibleProfileSnapshotId)].filter((id): id is string => id !== null))].sort(compareCanonicalStrings),
    };
    const result = (outcome: ProviderPackReadiness["outcome"], reasonCode: ProviderPackReadiness["reasonCode"]) =>
      ({ inputs, readiness: { ...readiness, outcome, reasonCode } });
    if (inputs.evFailure === "invalid_domain") return result("blocked", "INVALID_DOMAIN_DATA");
    if (inputs.snapshotKind === "lifecycle_only") {
      if (!inputs.lifecycleBaseline) return result("waiting", "INCOMPLETE_CONTENTS");
      const previous = await publicPackSnapshotSchema.parseAsync(inputs.lifecycleBaseline);
      if (!preservesPackLifecycleBaseline(inputs, previous)) {
        return result("blocked", "INVALID_DOMAIN_DATA");
      }
    }
    if (!inputs.contentsComplete || inputs.contents.length === 0) return result("waiting", "INCOMPLETE_CONTENTS");
    if (new Set(inputs.contents.map(row => row.publicCollectibleId)).size !== inputs.contents.length ||
      inputs.contents.reduce((total, row) => total + row.probabilityMicros, 0) !== 1_000_000) {
      return result("blocked", "INVALID_PROBABILITIES");
    }
    if (!inputs.providerProfileSnapshotId || inputs.contents.some(row => !row.collectibleProfileSnapshotId)) {
      return result("waiting", "PROFILE_HEAD_MISSING");
    }
    if (inputs.contents.some(row => !publicPackContentSchema.safeParse(row).success)) return result("blocked", "INVALID_DOMAIN_DATA");
    const actionable = inputs.lifecycle.availability === "available" && inputs.lifecycle.retirement === "active";
    const disabledReason = inputs.lifecycle.retirement === "retired" ? "PACK_RETIRED" : actionable ? null : "PACK_UNAVAILABLE";
    if (inputs.actions.some(action => action.enabled !== actionable || action.disabledReason !== disabledReason) ||
      inputs.contents.some(row => row.valuation.status === "available" && row.valuation.amount.currency !== inputs.price.currency) ||
      (inputs.ev?.status === "available" && inputs.ev.amount.currency !== inputs.price.currency)) return result("blocked", "INVALID_DOMAIN_DATA");
    if (packCatalogCanonicalJson(inputs.expectedDependencies) !== packCatalogCanonicalJson(inputs.observedDependencies)) {
      return result("waiting", "EV_INPUTS_PENDING");
    }
    if (inputs.evFailure === "technical") return result("waiting", "EV_TECHNICAL_RETRY");
    if (!inputs.ev || inputs.evFailure === "pending" || inputs.evInputsSha256 !== evInputsSha256 ||
      Date.parse(inputs.ev.evaluatedAt) > now || Date.parse(inputs.ev.validUntil) <= now) {
      return result("waiting", "EV_INPUTS_PENDING");
    }
    if (input.representedDigest === readiness.desiredStateSha256) return result("no_change", null);
    return { inputs, readiness };
  }
}
