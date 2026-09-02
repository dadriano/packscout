import { createHash } from "node:crypto";
import {
  canonicalJson,
  globalCatalogProviderActiveObservationV1Schema,
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
  providerReleaseCompletedHeadV1Schema,
  verifyProviderCatalogReleasePlanV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseCompletedHeadV1,
} from "@packscout/contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

/** Contract maximum, including envelope overhead around every bounded batch. */
export const MAX_PROVIDER_COMPLETION_PLAN_CACHE_BYTES = 256 * 1_024 * 1_024;

export type ProviderCompletionTerminalOperationKind =
  | "finalize"
  | "confirmReuse";

/**
 * Public-only proof reconstructed and verified inside the provider authority.
 * The activity event remains bounded; this object is carried beside it and is
 * accepted only in the same central transaction as that event and its gate.
 */
export interface ProviderCompletedPublishPlanRelayProof {
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerReleaseId: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly catalogVersionId: string;
  readonly catalogContentHash: string;
  readonly providerReleaseContentHash: string;
  readonly completedThroughChangeSequence: bigint;
  readonly artifactAttemptId: string;
  readonly terminalOperationKind: ProviderCompletionTerminalOperationKind;
  readonly terminalOperationId: string;
  readonly terminalReceiptSha256: string;
  readonly plan: ProviderCatalogReleasePublishPlanV1;
  readonly completedHead: ProviderReleaseCompletedHeadV1;
  readonly activeObservation: GlobalCatalogProviderActiveObservationV1;
}

export interface VerifiedProviderCompletedPublishPlanRelayProof
  extends ProviderCompletedPublishPlanRelayProof {
  readonly canonicalPlanBody: string;
  readonly planSha256: string;
  readonly canonicalCompletedHeadBody: string;
  readonly completedHeadSha256: string;
  readonly canonicalActiveObservationBody: string;
  readonly activeObservationSha256: string;
}

export type ProviderCompletionPlanProofFailureCode =
  | "PROVIDER_COMPLETION_PLAN_PROOF_INVALID"
  | "PROVIDER_COMPLETION_PLAN_PROOF_TOO_LARGE";

export class ProviderCompletionPlanProofError extends Error {
  constructor(readonly code: ProviderCompletionPlanProofFailureCode) {
    super(`Provider completion plan proof failed safely (${code}).`);
    this.name = "ProviderCompletionPlanProofError";
  }
}

function fail(code: ProviderCompletionPlanProofFailureCode): never {
  throw new ProviderCompletionPlanProofError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function immutableRelease(plan: ProviderCatalogReleasePublishPlanV1) {
  return {
    platformKey: plan.platformKey,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    dataAsOf: plan.dataAsOf,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
  };
}

function exactTopLevelShape(input: ProviderCompletedPublishPlanRelayProof): boolean {
  const expected = [
    "activeObservation",
    "artifactAttemptId",
    "catalogContentHash",
    "catalogVersionId",
    "completedHead",
    "completedThroughChangeSequence",
    "plan",
    "providerId",
    "providerKey",
    "providerReleaseContentHash",
    "providerReleaseFingerprint",
    "providerReleaseId",
    "publicProviderReleaseId",
    "terminalOperationId",
    "terminalOperationKind",
    "terminalReceiptSha256",
  ];
  return canonicalJson(Object.keys(input).sort()) === canonicalJson(expected);
}

/** Re-verifies every public hash and every local-to-public binding. */
export async function verifyProviderCompletedPublishPlanRelayProof(
  input: ProviderCompletedPublishPlanRelayProof,
): Promise<VerifiedProviderCompletedPublishPlanRelayProof> {
  if (
    input === null || typeof input !== "object" ||
    !exactTopLevelShape(input) ||
    !UUID_PATTERN.test(input.providerId) ||
    !UUID_PATTERN.test(input.providerReleaseId) ||
    !UUID_PATTERN.test(input.publicProviderReleaseId) ||
    !UUID_PATTERN.test(input.catalogVersionId) ||
    !UUID_PATTERN.test(input.artifactAttemptId) ||
    !PROVIDER_KEY_PATTERN.test(input.providerKey) ||
    input.providerKey.length > 53 ||
    !SHA256_PATTERN.test(input.providerReleaseFingerprint) ||
    !SHA256_PATTERN.test(input.catalogContentHash) ||
    !SHA256_PATTERN.test(input.providerReleaseContentHash) ||
    !SHA256_PATTERN.test(input.terminalReceiptSha256) ||
    input.completedThroughChangeSequence < 1n ||
    input.completedThroughChangeSequence > MAX_SIGNED_INT64 ||
    (input.terminalOperationKind !== "finalize" &&
      input.terminalOperationKind !== "confirmReuse")
  ) fail("PROVIDER_COMPLETION_PLAN_PROOF_INVALID");

  let plan: ProviderCatalogReleasePublishPlanV1;
  let completedHead: ProviderReleaseCompletedHeadV1;
  let activeObservation: GlobalCatalogProviderActiveObservationV1;
  try {
    const verifiedPlan = await verifyProviderCatalogReleasePlanV1(input.plan);
    if (verifiedPlan.classification !== "publish") {
      fail("PROVIDER_COMPLETION_PLAN_PROOF_INVALID");
    }
    plan = verifiedPlan;
    completedHead = providerReleaseCompletedHeadV1Schema.parse(
      input.completedHead,
    );
    activeObservation = globalCatalogProviderActiveObservationV1Schema.parse(
      input.activeObservation,
    );
  } catch (error) {
    if (error instanceof ProviderCompletionPlanProofError) throw error;
    fail("PROVIDER_COMPLETION_PLAN_PROOF_INVALID");
  }

  const completionSequence = input.completedThroughChangeSequence.toString();
  if (
    plan.platformKey !== input.providerKey ||
    plan.publicProviderReleaseId !== input.publicProviderReleaseId ||
    plan.providerReleaseFingerprint !== input.providerReleaseFingerprint ||
    plan.sharedConfigurationEpoch.configurationKey !==
      `catalog-version:${input.catalogVersionId.toLowerCase()}` ||
    plan.sharedConfigurationEpoch.configurationHash !== input.catalogContentHash ||
    canonicalJson(completedHead.release) !== canonicalJson(immutableRelease(plan)) ||
    completedHead.platformKey !== input.providerKey ||
    completedHead.providerCheckpoint.settledSequence !== completionSequence ||
    completedHead.terminalReceiptSha256 !== input.terminalReceiptSha256 ||
    activeObservation.platformKey !== input.providerKey ||
    activeObservation.publicProviderReleaseId !== input.publicProviderReleaseId ||
    activeObservation.terminalOperationKind !== input.terminalOperationKind ||
    activeObservation.terminalOperationId !== input.terminalOperationId ||
    activeObservation.terminalReceiptSha256 !== input.terminalReceiptSha256 ||
    canonicalJson(activeObservation.selectedProviderCheckpoint) !==
      canonicalJson(completedHead.providerCheckpoint) ||
    activeObservation.selectedDataAsOf !== completedHead.release.dataAsOf ||
    activeObservation.latestAffectedSettledSequence !== completionSequence ||
    activeObservation.latestAffectedSourceHeadSequence !==
      completedHead.observation.sourceHeadSequence ||
    activeObservation.lastSuccessfulObservationAt !==
      completedHead.observation.lastSuccessfulObservationAt ||
    activeObservation.staleAt !== completedHead.observation.staleAt ||
    activeObservation.settledSourceFreshness !==
      completedHead.observation.freshness ||
    !activeObservation.initialBackfillComplete ||
    !activeObservation.affectedDerivationsSettled
  ) fail("PROVIDER_COMPLETION_PLAN_PROOF_INVALID");

  const canonicalPlanBody = canonicalJson(plan);
  const canonicalCompletedHeadBody = canonicalJson(completedHead);
  const canonicalActiveObservationBody = canonicalJson(activeObservation);
  if (
    Buffer.byteLength(canonicalPlanBody, "utf8") >
      MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES ||
    Buffer.byteLength(canonicalCompletedHeadBody, "utf8") > 256 * 1_024 ||
    Buffer.byteLength(canonicalActiveObservationBody, "utf8") > 256 * 1_024
  ) fail("PROVIDER_COMPLETION_PLAN_PROOF_TOO_LARGE");

  return Object.freeze({
    ...input,
    providerId: input.providerId.toLowerCase(),
    providerReleaseId: input.providerReleaseId.toLowerCase(),
    publicProviderReleaseId: input.publicProviderReleaseId.toLowerCase(),
    catalogVersionId: input.catalogVersionId.toLowerCase(),
    artifactAttemptId: input.artifactAttemptId.toLowerCase(),
    plan,
    completedHead,
    activeObservation,
    canonicalPlanBody,
    planSha256: sha256(canonicalPlanBody),
    canonicalCompletedHeadBody,
    completedHeadSha256: sha256(canonicalCompletedHeadBody),
    canonicalActiveObservationBody,
    activeObservationSha256: sha256(canonicalActiveObservationBody),
  });
}
