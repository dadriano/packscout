import type {
  CanonicalEvInputCandidate,
  CanonicalProviderCandidate,
  CanonicalProviderIdentity,
  CanonicalRelationshipKey,
} from "./provider-observation-mapper.ts";
import { fingerprintCanonicalProviderCandidate } from "./provider-observation-mapper.ts";
import { decideProviderSourceCanonicalLifecycle } from "@packscout/contracts";

export interface CanonicalRevisionState {
  readonly contentFingerprint: string;
  readonly effectiveAt: string;
}

export interface CanonicalSourceBinding {
  readonly recordIdScopeKey: CanonicalProviderCandidate["recordIdScopeKey"];
  readonly canonicalKind: CanonicalProviderCandidate["candidateKind"];
}

export type CanonicalProjectionDisposition =
  | {
      readonly disposition: "inserted" | "revised";
      readonly contentFingerprint: string;
      readonly becomesCurrent: boolean;
    }
  | {
      readonly disposition: "duplicate";
      readonly contentFingerprint: string;
      readonly becomesCurrent: false;
    }
  | {
      readonly disposition: "quarantined";
      readonly reasonCode: "identity_kind_conflict" | "immutable_content_conflict";
      readonly contentFingerprint: string;
      readonly becomesCurrent: false;
    };

/**
 * Pure lifecycle decision used by the atomic importer. Catalog history is
 * revisioned; pulls and market events are immutable once their stable identity
 * has been observed.
 */
export function decideCanonicalProjection(input: {
  readonly candidate: CanonicalProviderCandidate;
  readonly existingBinding: CanonicalSourceBinding | null;
  readonly revisions: readonly CanonicalRevisionState[];
}): CanonicalProjectionDisposition {
  const contentFingerprint = fingerprintCanonicalProviderCandidate(
    input.candidate,
  );
  const decision = decideProviderSourceCanonicalLifecycle({
    recordIdScopeKey: input.candidate.recordIdScopeKey,
    canonicalKind: input.candidate.candidateKind,
    contentFingerprint,
    effectiveAt: input.candidate.effectiveAt,
    existingBinding: input.existingBinding,
    revisions: input.revisions,
  });
  return { ...decision, contentFingerprint } as CanonicalProjectionDisposition;
}

/** Derived EV input follows catalog revision semantics and retains its pack key. */
export function decideEvInputProjection(input: {
  readonly candidate: CanonicalEvInputCandidate;
  readonly revisions: readonly CanonicalRevisionState[];
}): Extract<
  CanonicalProjectionDisposition,
  { readonly disposition: "inserted" | "revised" | "duplicate" }
> {
  const contentFingerprint = fingerprintCanonicalProviderCandidate(
    input.candidate,
  );
  const decision = decideProviderSourceCanonicalLifecycle({
    recordIdScopeKey: input.candidate.recordIdScopeKey,
    canonicalKind: input.candidate.candidateKind,
    contentFingerprint,
    effectiveAt: input.candidate.effectiveAt,
    existingBinding: null,
    revisions: input.revisions,
  });
  if (decision.disposition === "quarantined") {
    throw new Error("provider_projection.ev_input_lifecycle_invalid");
  }
  return { ...decision, contentFingerprint };
}

export function canonicalProviderIdentityKey(
  identity: CanonicalProviderIdentity,
): string {
  return JSON.stringify([
    identity.organizationId,
    identity.providerId,
    identity.provider,
    identity.canonicalKind,
    identity.providerRecordId,
  ]);
}

export interface ResolvedCanonicalRelationship {
  readonly relationship: CanonicalRelationshipKey["relationship"];
  readonly target: CanonicalProviderIdentity;
}

export interface CanonicalRelationshipResolution {
  readonly resolved: readonly ResolvedCanonicalRelationship[];
  readonly unresolved: readonly CanonicalRelationshipKey[];
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
}

function relationshipIdentity(
  source: CanonicalProviderIdentity,
  relationship: CanonicalRelationshipKey,
): CanonicalProviderIdentity {
  return {
    organizationId: source.organizationId,
    providerId: source.providerId,
    provider: source.provider,
    canonicalKind: relationship.targetCanonicalKind,
    providerRecordId: relationship.targetProviderRecordId,
  };
}

/** Scope-qualified keys remain durable until their exact canonical target exists. */
export function reconcileCanonicalRelationships(input: {
  readonly source: CanonicalProviderIdentity;
  readonly relationships: readonly CanonicalRelationshipKey[];
  readonly knownCanonicalIdentityKeys: ReadonlySet<string>;
}): CanonicalRelationshipResolution {
  const seen = new Set<string>();
  const resolved: ResolvedCanonicalRelationship[] = [];
  const unresolved: CanonicalRelationshipKey[] = [];
  for (const relationship of input.relationships) {
    const target = relationshipIdentity(input.source, relationship);
    const targetKey = canonicalProviderIdentityKey(target);
    const edgeKey = JSON.stringify([relationship.relationship, targetKey]);
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    if (input.knownCanonicalIdentityKeys.has(targetKey)) {
      resolved.push(Object.freeze({ relationship: relationship.relationship, target }));
    } else {
      unresolved.push(Object.freeze({ ...relationship }));
    }
  }
  return Object.freeze({
    resolved: Object.freeze(resolved),
    unresolved: Object.freeze(unresolved),
    resolvedCount: resolved.length,
    unresolvedCount: unresolved.length,
  });
}
