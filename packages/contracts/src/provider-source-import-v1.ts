import type {
  LaunchProviderKey,
  LaunchRecordIdScopeKey,
  OpaqueCheckpointEnvelope,
  ProviderCanonicalKind,
} from "./provider-source-contract-v1.ts";
import type {
  NormalizedObservationSemanticContent,
  NormalizedProviderObservation,
  NormalizedProviderObservationPage,
} from "./provider-source-observation-v1.ts";
import { canonicalJson } from "./data-release-v2-canonical.ts";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export const PROVIDER_SOURCE_PAGE_COMMIT_DIGEST_VERSION =
  "packscout.provider-source-page-commit.v1" as const;

/**
 * Crypto-free, versioned preimage shared by request terminalization and atomic
 * persistence. It binds the durable successful-capture receipt to the exact
 * protected bytes and safe request measurements later committed as a page.
 */
export function providerSourceSuccessfulCaptureCanonicalJson(input: Readonly<{
  protectedRawResponseSha256: string;
  responseBytes: number;
  durationMilliseconds: number;
}>): string {
  if (
    !sha256Pattern.test(input.protectedRawResponseSha256) ||
    !Number.isSafeInteger(input.responseBytes) ||
    input.responseBytes < 0 ||
    !Number.isSafeInteger(input.durationMilliseconds) ||
    input.durationMilliseconds < 0
  ) {
    throw new TypeError("Provider source successful capture is invalid.");
  }
  return JSON.stringify([
    "packscout.provider-source-successful-capture.v1",
    input.protectedRawResponseSha256,
    input.responseBytes,
    input.durationMilliseconds,
  ]);
}

/** Retained replay preimage for normalized effects and retryable evidence. */
export function providerSourcePageCommitCanonicalJson(input: Readonly<{
  plan: ProviderSourcePagePlan;
  protectedNativeEvidence: readonly Readonly<{
    reference: string;
    value: Readonly<Record<string, unknown>>;
  }>[];
}>): string {
  return canonicalJson({
    digestVersion: PROVIDER_SOURCE_PAGE_COMMIT_DIGEST_VERSION,
    plan: input.plan,
    protectedNativeEvidence: input.protectedNativeEvidence,
  });
}

/**
 * Source-neutral mapper output handed to the atomic page repository. Transport
 * and delivery lineage deliberately stay outside canonical content.
 */
export interface ProviderSourceCanonicalRelationshipPlan {
  readonly relationship: "pack" | "card" | "supports_pack";
  readonly targetRecordIdScopeKey: LaunchRecordIdScopeKey;
  readonly targetCanonicalKind: "pack" | "catalog_asset";
  readonly targetProviderRecordId: string;
}

/**
 * The normalized observation owns relationship lineage. Mappers may project
 * content, but they may not retarget a pull, trade, or derived EV input.
 */
export function providerSourceExpectedCanonicalRelationships(input: Readonly<{
  semanticContent: NormalizedObservationSemanticContent;
  projectionKind: "primary" | "derived_ev_input";
}>): readonly ProviderSourceCanonicalRelationshipPlan[] {
  if (input.projectionKind === "derived_ev_input") {
    if (
      input.semanticContent.kind !== "catalog" ||
      input.semanticContent.entity !== "pack" ||
      input.semanticContent.providerRecordIdentity.recordIdScopeKey !==
        "catalog-pack-v1"
    ) {
      throw new TypeError("provider_source.derived_relationship_invalid");
    }
    return Object.freeze([Object.freeze({
      relationship: "supports_pack" as const,
      targetRecordIdScopeKey: "catalog-pack-v1" as const,
      targetCanonicalKind: "pack" as const,
      targetProviderRecordId:
        input.semanticContent.providerRecordIdentity.providerRecordId,
    })]);
  }
  if (input.semanticContent.kind === "catalog") return Object.freeze([]);
  return Object.freeze(input.semanticContent.relationships.map((relationship) =>
    Object.freeze({
      relationship: relationship.relationship,
      targetRecordIdScopeKey: relationship.target.recordIdScopeKey,
      targetCanonicalKind: relationship.relationship === "pack"
        ? "pack" as const
        : "catalog_asset" as const,
      targetProviderRecordId: relationship.target.providerRecordId,
    })
  ));
}

export interface ProviderSourceCanonicalProjectionPlan {
  readonly projectionKind: "primary" | "derived_ev_input";
  readonly platformKey: LaunchProviderKey;
  readonly recordKind: ProviderCanonicalKind;
  readonly providerRecordId: string;
  readonly recordIdScopeKey: LaunchRecordIdScopeKey;
  readonly effectiveAt: string;
  readonly contentFingerprint: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly relationships: readonly ProviderSourceCanonicalRelationshipPlan[];
  readonly affectedPackProviderRecordId: string | null;
  readonly evInputStatus: "ready" | "unavailable" | "not_applicable";
}

export interface ProviderSourceMapperWarningPlan {
  readonly code: string;
  readonly fieldPath: string;
}

export type ProviderSourcePlannedOutcome =
  | Readonly<{
      kind: "adapter_invalid";
      recordIndex: number;
      protectedNativeEvidenceRef: string;
      reasonCode: string;
      fieldPaths: readonly string[];
    }>
  | Readonly<{
      kind: "semantic";
      recordIndex: number;
      observation: NormalizedProviderObservation;
      semanticContent: NormalizedObservationSemanticContent;
      normalizedContentHash: string;
      protectedNativeEvidenceRef: string;
      protectedTransactionEvidenceRef: string | null;
      warnings: readonly ProviderSourceMapperWarningPlan[];
      mapping:
        | Readonly<{
            status: "mapped";
            projections: readonly ProviderSourceCanonicalProjectionPlan[];
          }>
        | Readonly<{
            status: "quarantined";
            reasonCode: string;
          }>;
    }>;

export interface ProviderSourcePagePlan {
  readonly normalizedPage: NormalizedProviderObservationPage;
  readonly outcomes: readonly ProviderSourcePlannedOutcome[];
  readonly counts: Readonly<{
    catalog: number;
    pulls: number;
    trades: number;
    adapterInvalid: number;
    mapperQuarantined: number;
    warnings: number;
  }>;
}

/**
 * Immutable run/page ownership supplied by task 007 after one request has been
 * durably captured and terminalized. Task 006 commits it as one transaction.
 */
export interface ProviderSourcePageCommitPins {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly connectionHealthGeneration: bigint;
  readonly requestAttemptId: string;
  readonly requestLeaseId: string;
  readonly supervisorEpochId: string;
  readonly singletonFencingEpoch: number;
  readonly supervisorOwnerKey: string;
  readonly supervisorLeaseToken: string;
  readonly runId: string;
  readonly runTrigger: "scheduled" | "manual" | "continuation" | "recovery";
  readonly runLeaseOwner: string;
  readonly runLeaseToken: string;
  readonly runClaimLeaseId: string;
  readonly pageId: string;
  readonly pageNumber: number;
  readonly checkpointCodecVersion: string;
  readonly checkpointGeneration: bigint;
  readonly requestedCheckpoint: OpaqueCheckpointEnvelope;
  readonly requestedCheckpointFingerprint: string | null;
}
