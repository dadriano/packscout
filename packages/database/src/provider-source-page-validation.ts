import { createHash } from "node:crypto";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  canonicalKindByLaunchScope,
  launchProviderKeySchema,
  normalizedObservationSemanticCanonicalJson,
  normalizedObservationSemanticContent,
  normalizedProviderObservationPageSchema,
  opaqueCursorEnvelopeSchema,
  providerSourceExpectedCanonicalRelationships,
  providerSourceCanonicalCatalogAssetContentV1Schema,
  providerSourceCanonicalEvInputContentV1Schema,
  providerSourceCanonicalMarketEventContentV1Schema,
  providerSourceCanonicalPackContentV1Schema,
  providerSourceCanonicalPullContentV1Schema,
  type ProviderSourceCanonicalProjectionPlan,
  type LaunchProviderKey,
  type NormalizedObservationSemanticContent,
  type ProviderSourcePageCommitPins,
  type ProviderSourcePagePlan,
} from "@packscout/contracts";
import { hashJson } from "./security.ts";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_REASON_CODE_PATTERN =
  /^[a-z0-9](?:[a-z0-9:._-]{0,254}[a-z0-9])?$/u;
const REGISTRATION_KEY_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_PROTECTED_RAW_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ProviderSourceAtomicPagePersistenceErrorCode =
  | "idempotency_conflict"
  | "invalid_page_plan"
  | "invalid_page_pins";

export class ProviderSourceAtomicPagePersistenceError extends Error {
  constructor(readonly code: ProviderSourceAtomicPagePersistenceErrorCode) {
    super(`provider_source_atomic_page.${code}`);
    this.name = "ProviderSourceAtomicPagePersistenceError";
  }
}

export interface ProviderSourceProtectedNativeEvidence {
  readonly reference: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ProviderSourceAtomicPagePersistenceInput {
  readonly pins: ProviderSourcePageCommitPins;
  readonly plan: ProviderSourcePagePlan;
  readonly protectedRawResponse: Uint8Array;
  readonly protectedRawResponseSha256: string;
  readonly protectedNativeEvidence: readonly ProviderSourceProtectedNativeEvidence[];
  readonly nextCursorFingerprint: string | null;
  readonly committedAt: Date;
}

function invalidPlan(): never {
  throw new ProviderSourceAtomicPagePersistenceError("invalid_page_plan");
}

function invalidPins(): never {
  throw new ProviderSourceAtomicPagePersistenceError("invalid_page_pins");
}

function isNonblankBoundedString(
  value: unknown,
  maximum = 256,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function validatePins(pins: unknown): asserts pins is ProviderSourcePageCommitPins {
  if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
    invalidPins();
  }
  const value = pins as Partial<
    Record<keyof ProviderSourcePageCommitPins, unknown>
  >;
  const uuidFields = [
    "organizationId",
    "providerId",
    "sourceInstanceId",
    "sourceRevisionId",
    "connectionProfileId",
    "connectionRevisionId",
    "requestAttemptId",
    "requestLeaseId",
    "supervisorEpochId",
    "supervisorLeaseToken",
    "runId",
    "runLeaseToken",
    "runClaimLeaseId",
    "pageId",
  ] as const;
  const registrationFields = [
    "sourceTypeKey",
    "sourceAdapterVersion",
    "normalizedContractVersion",
    "mapperKey",
    "mapperVersion",
    "identityNamespaceKey",
    "cursorCodecVersion",
  ] as const;
  if (
    uuidFields.some(
      (field) =>
        typeof value[field] !== "string" ||
        !UUID_PATTERN.test(value[field] as string),
    ) ||
    registrationFields.some(
      (field) =>
        typeof value[field] !== "string" ||
        !REGISTRATION_KEY_PATTERN.test(value[field] as string),
    ) ||
    !launchProviderKeySchema.safeParse(value.provider).success ||
    !["scheduled", "manual", "continuation", "recovery"].includes(
      value.runTrigger as string,
    ) ||
    !isNonblankBoundedString(value.supervisorOwnerKey) ||
    !isNonblankBoundedString(value.runLeaseOwner) ||
    typeof value.connectionHealthGeneration !== "bigint" ||
    value.connectionHealthGeneration < 0n ||
    value.connectionHealthGeneration > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof value.cursorGeneration !== "bigint" ||
    value.cursorGeneration < 1n ||
    value.cursorGeneration > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof value.singletonFencingEpoch !== "number" ||
    !Number.isSafeInteger(value.singletonFencingEpoch) ||
    value.singletonFencingEpoch < 0 ||
    typeof value.pageNumber !== "number" ||
    !Number.isSafeInteger(value.pageNumber) ||
    value.pageNumber < 1
  ) {
    invalidPins();
  }

  const cursor = opaqueCursorEnvelopeSchema.safeParse(
    value.requestedCursor,
  );
  if (
    !cursor.success ||
    cursor.data.sourceInstanceId !== value.sourceInstanceId ||
    cursor.data.sourceRevisionId !== value.sourceRevisionId ||
    cursor.data.sourceTypeKey !== value.sourceTypeKey ||
    cursor.data.adapterVersion !== value.sourceAdapterVersion ||
    cursor.data.cursorCodecKey !== value.cursorCodecVersion ||
    cursor.data.cursorGeneration !==
      Number(value.cursorGeneration) ||
    (cursor.data.value === null) !==
      (value.requestedCursorFingerprint === null) ||
    (value.requestedCursorFingerprint !== null &&
      (typeof value.requestedCursorFingerprint !== "string" ||
        !SHA_256_PATTERN.test(value.requestedCursorFingerprint)))
  ) {
    invalidPins();
  }
}

function assertProjection(
  provider: LaunchProviderKey,
  semanticContent: NormalizedObservationSemanticContent,
  projection: ProviderSourceCanonicalProjectionPlan,
): void {
  const identity = semanticContent.providerRecordIdentity;
  const expectedPrimaryKind =
    canonicalKindByLaunchScope[identity.recordIdScopeKey];
  const primary = projection.projectionKind === "primary";
  const derivedEvInput =
    projection.projectionKind === "derived_ev_input" &&
    identity.recordIdScopeKey === "catalog-pack-v1" &&
    projection.recordIdScopeKey === "catalog-pack-v1" &&
    projection.recordKind === "ev_input";
  const expectedAffectedPack =
    projection.recordKind === "pack" || projection.recordKind === "ev_input"
      ? identity.providerRecordId
      : null;
  const validEvInputStatus =
    projection.projectionKind === "derived_ev_input"
      ? projection.evInputStatus === "ready"
      : projection.recordKind === "pack"
        ? projection.evInputStatus === "ready" ||
          projection.evInputStatus === "unavailable"
        : projection.evInputStatus === "not_applicable";
  const validContentKind =
    projection.recordKind === "pack"
      ? providerSourceCanonicalPackContentV1Schema.safeParse(
          projection.content,
        ).success
      : projection.recordKind === "catalog_asset"
        ? providerSourceCanonicalCatalogAssetContentV1Schema.safeParse(
            projection.content,
          ).success
        : projection.recordKind === "ev_input"
          ? providerSourceCanonicalEvInputContentV1Schema.safeParse(
              projection.content,
            ).success &&
            projection.content.packExternalId === identity.providerRecordId
          : projection.recordKind === "pull"
            ? providerSourceCanonicalPullContentV1Schema.safeParse(
                projection.content,
              ).success
            : providerSourceCanonicalMarketEventContentV1Schema.safeParse(
                projection.content,
              ).success;
  const validPackEvInputStatus =
    projection.recordKind !== "pack" ||
    (projection.content as { readonly evInputStatus?: unknown })
      .evInputStatus === projection.evInputStatus;
  if (
    projection.platformKey !== provider ||
    projection.providerRecordId !== identity.providerRecordId ||
    projection.recordIdScopeKey !== identity.recordIdScopeKey ||
    projection.effectiveAt !== semanticContent.effectiveAt ||
    !SHA_256_PATTERN.test(projection.contentFingerprint) ||
    hashJson(projection.content) !== projection.contentFingerprint ||
    !validContentKind ||
    !validPackEvInputStatus ||
    (primary && projection.recordKind !== expectedPrimaryKind) ||
    (!primary && !derivedEvInput) ||
    projection.affectedPackProviderRecordId !== expectedAffectedPack ||
    !validEvInputStatus
  ) {
    invalidPlan();
  }
  for (const relationship of projection.relationships) {
    const expectedTargetKind =
      canonicalKindByLaunchScope[relationship.targetRecordIdScopeKey];
    if (
      !["pack", "card", "supports_pack"].includes(
        relationship.relationship,
      ) ||
      relationship.targetCanonicalKind !== expectedTargetKind ||
      !relationship.targetProviderRecordId.trim()
    ) {
      invalidPlan();
    }
  }
  let expectedRelationships: readonly ProviderSourceCanonicalProjectionPlan["relationships"][number][];
  try {
    expectedRelationships = providerSourceExpectedCanonicalRelationships({
      semanticContent,
      projectionKind: projection.projectionKind,
    });
  } catch {
    invalidPlan();
  }
  const relationshipKey = (
    relationship: ProviderSourceCanonicalProjectionPlan["relationships"][number],
  ) => JSON.stringify([
    relationship.relationship,
    relationship.targetRecordIdScopeKey,
    relationship.targetCanonicalKind,
    relationship.targetProviderRecordId,
  ]);
  const actualKeys = projection.relationships.map(relationshipKey).sort();
  const expectedKeys = expectedRelationships.map(relationshipKey).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    invalidPlan();
  }
}

/** Revalidates mapper output again at a non-page persistence boundary. */
export function validateProviderSourceCanonicalProjections(input: Readonly<{
  provider: LaunchProviderKey;
  semanticContent: NormalizedObservationSemanticContent;
  projections: readonly ProviderSourceCanonicalProjectionPlan[];
}>): void {
  if (input.projections.length < 1 || input.projections.length > 2) {
    invalidPlan();
  }
  input.projections.forEach((projection) =>
    assertProjection(input.provider, input.semanticContent, projection),
  );
  const primary = input.projections.filter(
    ({ projectionKind }) => projectionKind === "primary",
  );
  const derived = input.projections.filter(
    ({ projectionKind }) => projectionKind === "derived_ev_input",
  );
  if (
    primary.length !== 1 ||
    derived.length > 1 ||
    (derived.length === 1 &&
      (primary[0]?.recordKind !== "pack" ||
        primary[0].evInputStatus !== "ready")) ||
    (primary[0]?.recordKind === "pack" &&
      (primary[0].evInputStatus === "ready") !== (derived.length === 1))
  ) {
    invalidPlan();
  }
}

/** Revalidates the complete public persistence command before any DB call. */
export function validateProviderSourceAtomicPageInput(
  input: ProviderSourceAtomicPagePersistenceInput,
): void {
  validatePins(input.pins);
  const parsedPage = normalizedProviderObservationPageSchema.safeParse(
    input.plan.normalizedPage,
  );
  const rawHash =
    input.protectedRawResponse instanceof Uint8Array
      ? createHash("sha256").update(input.protectedRawResponse).digest("hex")
      : null;
  if (
    !parsedPage.success ||
    parsedPage.data.provider !== input.pins.provider ||
    parsedPage.data.normalizedContractVersion !==
      input.pins.normalizedContractVersion ||
    input.pins.normalizedContractVersion !==
      PROVIDER_OBSERVATION_CONTRACT_VERSION ||
    !(input.committedAt instanceof Date) ||
    !Number.isFinite(input.committedAt.getTime()) ||
    input.protectedRawResponse.byteLength < 1 ||
    input.protectedRawResponse.byteLength >
      MAXIMUM_PROTECTED_RAW_RESPONSE_BYTES ||
    parsedPage.data.measurements.responseBytes !==
      input.protectedRawResponse.byteLength ||
    !SHA_256_PATTERN.test(input.protectedRawResponseSha256) ||
    rawHash !== input.protectedRawResponseSha256 ||
    input.plan.outcomes.length !== parsedPage.data.outcomes.length
  ) {
    invalidPlan();
  }

  const nextValue = parsedPage.data.nextCursor.value;
  if (
    parsedPage.data.nextCursor.sourceInstanceId !==
      input.pins.sourceInstanceId ||
    parsedPage.data.nextCursor.sourceRevisionId !==
      input.pins.sourceRevisionId ||
    parsedPage.data.nextCursor.sourceTypeKey !== input.pins.sourceTypeKey ||
    parsedPage.data.nextCursor.adapterVersion !==
      input.pins.sourceAdapterVersion ||
    parsedPage.data.nextCursor.cursorCodecKey !==
      input.pins.cursorCodecVersion ||
    parsedPage.data.nextCursor.cursorGeneration !==
      Number(input.pins.cursorGeneration) ||
    (nextValue === null) !== (input.nextCursorFingerprint === null) ||
    (input.nextCursorFingerprint !== null &&
      !SHA_256_PATTERN.test(input.nextCursorFingerprint))
  ) {
    invalidPins();
  }

  const evidence = new Map<string, Readonly<Record<string, unknown>>>();
  for (const item of input.protectedNativeEvidence) {
    if (
      !item.reference.trim() ||
      evidence.has(item.reference) ||
      typeof item.value !== "object" ||
      item.value === null ||
      Array.isArray(item.value)
    ) {
      invalidPlan();
    }
    hashJson(item.value);
    evidence.set(item.reference, item.value);
  }
  const referencedEvidence = new Set<string>();
  const recomputedCounts = {
    catalog: 0,
    pulls: 0,
    trades: 0,
    adapterInvalid: 0,
    mapperQuarantined: 0,
    warnings: 0,
  };
  for (const [index, outcome] of input.plan.outcomes.entries()) {
    const pageOutcome = parsedPage.data.outcomes[index];
    if (
      outcome.recordIndex !== index ||
      !evidence.has(outcome.protectedNativeEvidenceRef)
    ) {
      invalidPlan();
    }
    referencedEvidence.add(outcome.protectedNativeEvidenceRef);
    if (outcome.kind === "adapter_invalid") {
      recomputedCounts.adapterInvalid += 1;
      if (
        pageOutcome?.status !== "invalid" ||
        pageOutcome.reasonCode !== outcome.reasonCode ||
        pageOutcome.protectedNativeEvidenceRef !==
          outcome.protectedNativeEvidenceRef ||
        hashJson(pageOutcome.fieldPaths) !== hashJson(outcome.fieldPaths) ||
        !SAFE_REASON_CODE_PATTERN.test(outcome.reasonCode)
      ) {
        invalidPlan();
      }
      continue;
    }
    if (
      pageOutcome?.status !== "valid" ||
      hashJson(pageOutcome.observation) !== hashJson(outcome.observation) ||
      normalizedObservationSemanticCanonicalJson(
        normalizedObservationSemanticContent(outcome.observation),
      ) !== normalizedObservationSemanticCanonicalJson(outcome.semanticContent) ||
      outcome.normalizedContentHash !==
        createHash("sha256")
          .update(
            normalizedObservationSemanticCanonicalJson(
              outcome.semanticContent,
            ),
          )
          .digest("hex")
    ) {
      invalidPlan();
    }
    if (outcome.observation.kind === "catalog") recomputedCounts.catalog += 1;
    else if (outcome.observation.kind === "pull") recomputedCounts.pulls += 1;
    else recomputedCounts.trades += 1;
    recomputedCounts.warnings += outcome.warnings.length;
    if (
      outcome.protectedTransactionEvidenceRef !== null &&
      !evidence.has(outcome.protectedTransactionEvidenceRef)
    ) {
      invalidPlan();
    }
    if (outcome.protectedTransactionEvidenceRef !== null) {
      referencedEvidence.add(outcome.protectedTransactionEvidenceRef);
    }
    if (outcome.mapping.status === "quarantined") {
      recomputedCounts.mapperQuarantined += 1;
      if (!SAFE_REASON_CODE_PATTERN.test(outcome.mapping.reasonCode)) {
        invalidPlan();
      }
    } else {
      validateProviderSourceCanonicalProjections({
        provider: input.pins.provider,
        semanticContent: outcome.semanticContent,
        projections: outcome.mapping.projections,
      });
    }
  }
  if (
    referencedEvidence.size !== evidence.size ||
    hashJson(recomputedCounts) !== hashJson(input.plan.counts)
  ) {
    invalidPlan();
  }
}
