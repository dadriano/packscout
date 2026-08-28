import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  normalizedObservationSemanticContentSchema,
  sha256CanonicalJson,
  type NormalizedPackProviderFacts,
  type NormalizedObservationSemanticContent,
} from "@packscout/contracts";
import type {
  PackScoutBuybackEvBackfillEvidenceSourceV1,
} from "../../buyback-adjusted-ev-backfill-reconciliation.ts";
import type {
  PackScoutBuybackEvRecomputationCommandV1,
} from "../../buyback-adjusted-ev-recomputation-contracts.ts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  type PackScoutBuybackEvEvidenceDraftV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvUniformRateClaimV1,
} from "../buyback-ev-evidence.ts";
import { fingerprintCanonicalProviderCandidate } from
  "../../provider-observation-mapper.ts";
import { clutchpacksProviderObservationMapper } from "./mapper.ts";

export const CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY = "clutchpacks" as const;
export const CLUTCHPACKS_CANONICAL_V3_SOURCE_TYPE_KEY =
  "dataforrest-events-v1" as const;
export const CLUTCHPACKS_CANONICAL_V3_SOURCE_ADAPTER_VERSION =
  "dataforrest-events-adapter-v3" as const;
export const CLUTCHPACKS_CANONICAL_V3_MAPPER_KEY =
  "clutchpacks-provider-observation" as const;
export const CLUTCHPACKS_CANONICAL_V3_MAPPER_VERSION = "1" as const;
export const CLUTCHPACKS_CANONICAL_V3_IDENTITY_NAMESPACE_KEY =
  "dataforrest-clutchpacks-records-v1" as const;
export const CLUTCHPACKS_CANONICAL_V3_CURSOR_CODEC_VERSION =
  "dataforrest-cursor-v1" as const;

const COLLECTION_GUARD_HASH_DOMAIN =
  "packscout.clutchpacks.canonical-v3.collection-guard.v1";
const BUCKET_HOMOGENEITY_HASH_DOMAIN =
  "packscout.clutchpacks.canonical-v3.bucket-homogeneity.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9][0-9]*$/u;

type CatalogSemanticContentV1 = Extract<
  NormalizedObservationSemanticContent,
  { kind: "catalog" }
>;
type ClutchpacksPackSemanticContentV1 = Omit<
  CatalogSemanticContentV1,
  "entity" | "providerFacts"
> & Readonly<{
  entity: "pack";
  providerFacts: NormalizedPackProviderFacts;
}>;

export interface ClutchpacksCanonicalV3BuybackEvSourcePinsV1 {
  readonly providerSourceRevisionId: string;
  readonly sourceInstanceId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly configurationHash: string;
}

export interface ClutchpacksCanonicalV3BuybackEvObservationV1 {
  readonly semanticObservationId: string;
  readonly originSemanticObservationId: string;
  readonly sourceRecordId: string;
  readonly providerRecordId: string;
  readonly normalizedContentHash: string;
  readonly hashVersion: string;
  readonly normalizedContent: unknown;
  readonly effectiveSourceTime: string;
  readonly deliveryOccurrenceId: string;
  readonly collectedAt: string;
  readonly pins: ClutchpacksCanonicalV3BuybackEvSourcePinsV1;
}

export interface ClutchpacksCanonicalV3BuybackEvProductObservationV1 {
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly canonicalContentHash: string;
  readonly canonicalProvenanceHash: string;
  readonly canonicalPublicChangeSequence: string;
  readonly evInputStatus: "ready" | "unavailable";
  readonly evInputRevision: Readonly<{
    readonly revisionId: string;
    readonly canonicalContentHash: string;
    readonly canonicalProvenanceHash: string;
    readonly canonicalPublicChangeSequence: string;
  }> | null;
  readonly observation: ClutchpacksCanonicalV3BuybackEvObservationV1 | null;
}

export interface ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1 {
  readonly organizationId: string;
  readonly platformKey: "clutchpacks";
  readonly providerId: string | null;
  readonly readAt: string;
  readonly throughSequence: string;
  readonly products: readonly ClutchpacksCanonicalV3BuybackEvProductObservationV1[];
}

export interface ClutchpacksCanonicalV3BuybackEvObservationSourceV1 {
  loadSnapshot(input: {
    readonly readAt: string;
  }): Promise<ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1>;
}

export type ClutchpacksCanonicalV3BuybackEvEvidenceErrorCode =
  | "SNAPSHOT_SCOPE_MISMATCH"
  | "SNAPSHOT_IDENTITY_INVALID"
  | "SOURCE_NATIVE_OBSERVATION_UNAVAILABLE"
  | "SOURCE_NATIVE_LINEAGE_INVALID"
  | "SOURCE_NATIVE_CONTRACT_INVALID";

export class ClutchpacksCanonicalV3BuybackEvEvidenceError extends Error {
  constructor(readonly code: ClutchpacksCanonicalV3BuybackEvEvidenceErrorCode) {
    super("ClutchPacks canonical V3 buyback EV evidence was refused.");
    this.name = "ClutchpacksCanonicalV3BuybackEvEvidenceError";
  }
}

function fail(
  code: ClutchpacksCanonicalV3BuybackEvEvidenceErrorCode,
): never {
  throw new ClutchpacksCanonicalV3BuybackEvEvidenceError(code);
}

function canonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function validatePins(pins: ClutchpacksCanonicalV3BuybackEvSourcePinsV1): void {
  if (
    !UUID_PATTERN.test(pins.providerSourceRevisionId) ||
    !UUID_PATTERN.test(pins.sourceInstanceId) ||
    pins.sourceTypeKey !== CLUTCHPACKS_CANONICAL_V3_SOURCE_TYPE_KEY ||
    pins.sourceAdapterVersion !==
      CLUTCHPACKS_CANONICAL_V3_SOURCE_ADAPTER_VERSION ||
    pins.normalizedContractVersion !== PROVIDER_OBSERVATION_CONTRACT_VERSION ||
    pins.mapperKey !== CLUTCHPACKS_CANONICAL_V3_MAPPER_KEY ||
    pins.mapperVersion !== CLUTCHPACKS_CANONICAL_V3_MAPPER_VERSION ||
    pins.identityNamespaceKey !==
      CLUTCHPACKS_CANONICAL_V3_IDENTITY_NAMESPACE_KEY ||
    pins.cursorCodecVersion !== CLUTCHPACKS_CANONICAL_V3_CURSOR_CODEC_VERSION ||
    !HEX_64_PATTERN.test(pins.configurationHash)
  ) {
    fail("SOURCE_NATIVE_LINEAGE_INVALID");
  }
}

function validateObservationIdentity(
  product: ClutchpacksCanonicalV3BuybackEvProductObservationV1,
  observation: ClutchpacksCanonicalV3BuybackEvObservationV1,
  readAt: string,
  throughSequence: string,
): void {
  validatePins(observation.pins);
  const evInputRevision = product.evInputRevision;
  const evInputLineageInvalid = product.evInputStatus === "ready"
    ? evInputRevision === null ||
      !UUID_PATTERN.test(evInputRevision.revisionId) ||
      evInputRevision.revisionId === product.productRevisionId ||
      !HEX_64_PATTERN.test(evInputRevision.canonicalContentHash) ||
      !HEX_64_PATTERN.test(evInputRevision.canonicalProvenanceHash) ||
      !POSITIVE_INTEGER_TEXT_PATTERN.test(
        evInputRevision.canonicalPublicChangeSequence,
      )
    : product.evInputStatus === "unavailable"
      ? evInputRevision !== null
      : true;
  if (
    !UUID_PATTERN.test(product.productRevisionId) ||
    evInputLineageInvalid ||
    !UUID_PATTERN.test(observation.semanticObservationId) ||
    !UUID_PATTERN.test(observation.originSemanticObservationId) ||
    !UUID_PATTERN.test(observation.sourceRecordId) ||
    !HEX_64_PATTERN.test(product.canonicalContentHash) ||
    !HEX_64_PATTERN.test(product.canonicalProvenanceHash) ||
    !HEX_64_PATTERN.test(observation.normalizedContentHash) ||
    observation.hashVersion !== PROVIDER_OBSERVATION_HASH_VERSION ||
    !POSITIVE_INTEGER_TEXT_PATTERN.test(product.canonicalPublicChangeSequence) ||
    !POSITIVE_INTEGER_TEXT_PATTERN.test(observation.deliveryOccurrenceId) ||
    !canonicalTimestamp(observation.effectiveSourceTime) ||
    !canonicalTimestamp(observation.collectedAt) ||
    Date.parse(observation.effectiveSourceTime) > Date.parse(observation.collectedAt) ||
    Date.parse(observation.collectedAt) > Date.parse(readAt)
  ) {
    fail("SOURCE_NATIVE_LINEAGE_INVALID");
  }
  if (
    BigInt(product.canonicalPublicChangeSequence) > BigInt(throughSequence) ||
    (evInputRevision !== null &&
      BigInt(evInputRevision.canonicalPublicChangeSequence) >
        BigInt(throughSequence))
  ) {
    fail("SOURCE_NATIVE_LINEAGE_INVALID");
  }
}

function parseSemanticContent(
  product: ClutchpacksCanonicalV3BuybackEvProductObservationV1,
  observation: ClutchpacksCanonicalV3BuybackEvObservationV1,
): ClutchpacksPackSemanticContentV1 {
  const parsed = normalizedObservationSemanticContentSchema.safeParse(
    observation.normalizedContent,
  );
  if (
    !parsed.success ||
    parsed.data.kind !== "catalog" ||
    parsed.data.entity !== "pack" ||
    parsed.data.providerFacts.kind !== "pack" ||
    parsed.data.effectiveAt !== observation.effectiveSourceTime ||
    parsed.data.providerRecordIdentity.recordIdScopeKey !== "catalog-pack-v1" ||
    parsed.data.providerRecordIdentity.providerRecordId !== product.productKey ||
    observation.providerRecordId !== product.productKey
  ) {
    fail("SOURCE_NATIVE_CONTRACT_INVALID");
  }
  return parsed.data as ClutchpacksPackSemanticContentV1;
}

function validateCanonicalProjection(
  product: ClutchpacksCanonicalV3BuybackEvProductObservationV1,
  observation: ClutchpacksCanonicalV3BuybackEvObservationV1,
  content: ClutchpacksPackSemanticContentV1,
  organizationId: string,
  providerId: string,
): void {
  let mapped: ReturnType<typeof clutchpacksProviderObservationMapper.map>;
  try {
    mapped = clutchpacksProviderObservationMapper.map({
      organizationId,
      providerId,
      provider: CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY,
      mapperKey: observation.pins.mapperKey,
      mapperVersion: observation.pins.mapperVersion,
      normalizedContractVersion: observation.pins.normalizedContractVersion,
      identityNamespaceKey: observation.pins.identityNamespaceKey,
      observation: {
        ...content,
        collectedAt: observation.collectedAt,
        protectedNativeEvidenceRef:
          "source-native:clutchpacks:buyback-ev-evidence",
      },
    });
  } catch {
    fail("SOURCE_NATIVE_CONTRACT_INVALID");
  }
  if (
    mapped.status !== "mapped" ||
    mapped.candidate.candidateKind !== "pack" ||
    mapped.candidate.identity.organizationId !== organizationId ||
    mapped.candidate.identity.providerId !== providerId ||
    mapped.candidate.identity.providerRecordId !== product.productKey ||
    mapped.evInputStatus !== product.evInputStatus ||
    fingerprintCanonicalProviderCandidate(mapped.candidate) !==
      product.canonicalContentHash
  ) {
    fail("SOURCE_NATIVE_LINEAGE_INVALID");
  }
  if (product.evInputStatus === "ready") {
    if (
      mapped.evInputCandidate === null ||
      product.evInputRevision === null ||
      fingerprintCanonicalProviderCandidate(mapped.evInputCandidate) !==
        product.evInputRevision.canonicalContentHash
    ) {
      fail("SOURCE_NATIVE_LINEAGE_INVALID");
    }
    return;
  }
  if (mapped.evInputCandidate !== null || product.evInputRevision !== null) {
    fail("SOURCE_NATIVE_LINEAGE_INVALID");
  }
}

function productUniformRate(
  content: ClutchpacksPackSemanticContentV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  const facts = content.providerFacts;
  const evInput = facts.evInput.state === "present"
    ? facts.evInput.value
    : null;
  const rootAbsent = facts.buybackPercent.state === "absent";
  const inputAbsent = evInput !== null && evInput.buybackPercent === null;
  if (rootAbsent && inputAbsent) return { kind: "none_documented" };
  if (
    facts.buybackPercent.state === "present" &&
    facts.buybackPercent.value === 90 &&
    evInput?.buybackPercent === 90
  ) {
    return {
      kind: "documented",
      scope: "every_eligible_outcome",
      terms: {
        rateBasisPoints: 9_000,
        percentageFeeBasisPoints: 0,
        fixedFee: null,
        floor: null,
        cap: null,
      },
    };
  }
  return { kind: "unsupported_terms" };
}

function probabilityMatchesCount(
  probability: number | null,
  quantity: number,
  totalQuantity: number,
): boolean {
  return probability !== null &&
    Number.isFinite(probability) &&
    Math.abs(probability - quantity / totalQuantity) <= Number.EPSILON * 8;
}

async function evidenceDraft(
  product: ClutchpacksCanonicalV3BuybackEvProductObservationV1,
  observation: ClutchpacksCanonicalV3BuybackEvObservationV1,
  content: ClutchpacksPackSemanticContentV1,
): Promise<PackScoutBuybackEvEvidenceDraftV1> {
  const facts = content.providerFacts;
  const evInput = facts.evInput.state === "present"
    ? facts.evInput.value
    : null;
  const guard = await sha256CanonicalJson(COLLECTION_GUARD_HASH_DOMAIN, {
    productKey: product.productKey,
    productRevisionId: product.productRevisionId,
    canonicalContentHash: product.canonicalContentHash,
    canonicalProvenanceHash: product.canonicalProvenanceHash,
    canonicalPublicChangeSequence: product.canonicalPublicChangeSequence,
    evInputRevision: product.evInputRevision,
    semanticObservationId: observation.semanticObservationId,
    originSemanticObservationId: observation.originSemanticObservationId,
    sourceRecordId: observation.sourceRecordId,
    normalizedContentHash: observation.normalizedContentHash,
    deliveryOccurrenceId: observation.deliveryOccurrenceId,
    collectedAt: observation.collectedAt,
    pins: observation.pins,
  });
  const totalQuantity = evInput?.totalQuantity ?? null;
  const usableCounts =
    evInput !== null &&
    evInput.approved === true &&
    totalQuantity !== null &&
    Number.isSafeInteger(totalQuantity) &&
    totalQuantity > 0 &&
    evInput.buckets.length > 0 &&
    evInput.buckets.every((bucket) =>
      bucket.quantity !== null &&
      Number.isSafeInteger(bucket.quantity) &&
      bucket.quantity > 0 &&
      probabilityMatchesCount(
        bucket.probability,
        bucket.quantity,
        totalQuantity,
      )
    ) &&
    evInput.buckets.reduce((sum, bucket) => sum + (bucket.quantity ?? 0), 0) ===
      totalQuantity;
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = await Promise.all(
    (evInput?.buckets ?? []).map(async (bucket, index) => {
      const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
        bucket.bucketId,
        `bucket-${index + 1}`,
      );
      const quantity =
        bucket.quantity !== null &&
          Number.isSafeInteger(bucket.quantity) &&
          bucket.quantity > 0
          ? bucket.quantity
          : null;
      const homogeneityEvidenceSha256 = quantity === null
        ? null
        : await sha256CanonicalJson(BUCKET_HOMOGENEITY_HASH_DOMAIN, {
            normalizedContentHash: observation.normalizedContentHash,
            semanticObservationId: observation.semanticObservationId,
            productKey: product.productKey,
            bucket: {
              bucketId: bucket.bucketId,
              quantity,
              lowerValue: bucket.lowerValue,
              upperValue: bucket.upperValue,
            },
            productBuyback: {
              root: facts.buybackPercent,
              evInput: evInput?.buybackPercent ?? null,
            },
          });
      const lower = packScoutBuybackEvMoneyClaimFromNumberV1(
        bucket.lowerValue,
        evInput?.currency ?? "",
        2,
      );
      const upper = packScoutBuybackEvMoneyClaimFromNumberV1(
        bucket.upperValue,
        evInput?.currency ?? "",
        2,
      );
      return {
        outcomeKey,
        representation: {
          kind: "aggregate_bucket",
          memberCount: quantity,
          eligibilityHomogeneity:
            homogeneityEvidenceSha256 === null ? "unverified" : "verified_same",
          payoutFunctionHomogeneity:
            homogeneityEvidenceSha256 === null ? "unverified" : "verified_same",
          homogeneityEvidenceSha256,
        },
        valueBasis: "stated_collectible_value",
        statedValue:
          lower !== null && upper !== null
            ? { kind: "closed_range", lower, upper }
            : lower === null && upper === null
              ? { kind: "missing" }
              : { kind: "open_ended_range" },
        buyback: { kind: "defer_to_product_terms" },
      };
    }),
  );
  const unitBasis =
    evInput?.unitBasis === "per_pack" &&
      evInput.drawCount === 1 &&
      facts.drawCount.state === "present" &&
      facts.drawCount.value === 1
      ? { kind: "per_pack" as const }
      : { kind: "ambiguous" as const };
  return {
    observation: {
      providerKey: CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY,
      sourceRevisionId: `semantic:${observation.semanticObservationId}`,
      sourceManifestSha256: observation.normalizedContentHash,
      observedAt: observation.collectedAt,
      coherence: { kind: "guarded_collection", collectionGuardSha256: guard },
    },
    product: {
      productKey: product.productKey,
      productRevisionId: product.productRevisionId,
    },
    packPrice:
      facts.price.state === "present"
        ? packScoutBuybackEvMoneyClaimFromNumberV1(
            facts.price.value.amount,
            facts.price.value.currency,
            2,
          )
        : null,
    unitBasis,
    odds: {
      poolKind: "finite",
      currentPool:
        evInput === null
          ? null
          : {
              completeness: usableCounts ? "complete" : "partial",
              snapshotAtomicity: usableCounts
                ? "atomic"
                : "assembled_without_proof",
              countsStability: usableCounts
                ? "stable"
                : "changed_during_collection",
              remainingUnits: evInput.buckets.flatMap((bucket, index) =>
                bucket.quantity === null
                  ? []
                  : [{
                      outcomeKey: packScoutBuybackEvOutcomeKeyFromLabelV1(
                        bucket.bucketId,
                        `bucket-${index + 1}`,
                      ),
                      units: bucket.quantity,
                    }]
              ),
            },
      published: null,
    },
    uniformBuybackRate: productUniformRate(content),
    outcomes,
  };
}

/**
 * Provider-specific adapter from governed canonical V3 source observations to
 * the strict PR #15 recomputation command. The generic backfill runner remains
 * provider-neutral and receives this through its evidence source port.
 */
export class ClutchpacksCanonicalV3BuybackEvEvidenceSourceV1
implements PackScoutBuybackEvBackfillEvidenceSourceV1 {
  readonly #snapshots = new Map<
    string,
    Promise<ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1>
  >();

  constructor(private readonly dependencies: Readonly<{
    organizationId: string;
    repository: ClutchpacksCanonicalV3BuybackEvObservationSourceV1;
  }>) {}

  async loadCommand(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly readAt: string;
  }): Promise<PackScoutBuybackEvRecomputationCommandV1 | null> {
    if (
      input.organizationId !== this.dependencies.organizationId ||
      input.platformKey !== CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY
    ) {
      return null;
    }
    let snapshotPromise = this.#snapshots.get(input.readAt);
    if (snapshotPromise === undefined) {
      snapshotPromise = this.dependencies.repository.loadSnapshot({
        readAt: input.readAt,
      });
      this.#snapshots.set(input.readAt, snapshotPromise);
    }
    const snapshot = await snapshotPromise;
    if (
      snapshot.organizationId !== input.organizationId ||
      snapshot.platformKey !== CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY ||
      snapshot.readAt !== input.readAt
    ) {
      fail("SNAPSHOT_SCOPE_MISMATCH");
    }
    if (
      snapshot.providerId === null ||
      !UUID_PATTERN.test(snapshot.providerId) ||
      !POSITIVE_INTEGER_TEXT_PATTERN.test(snapshot.throughSequence)
    ) {
      fail("SNAPSHOT_IDENTITY_INVALID");
    }
    const matches = snapshot.products.filter(
      ({ productKey }) => productKey === input.productKey,
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1) fail("SNAPSHOT_IDENTITY_INVALID");
    const product = matches[0]!;
    const observation = product.observation;
    if (observation === null) {
      fail("SOURCE_NATIVE_OBSERVATION_UNAVAILABLE");
    }
    validateObservationIdentity(
      product,
      observation,
      input.readAt,
      snapshot.throughSequence,
    );
    const content = parseSemanticContent(product, observation);
    validateCanonicalProjection(
      product,
      observation,
      content,
      input.organizationId,
      snapshot.providerId,
    );
    const evInputRevision = product.evInputRevision;
    const draft = await evidenceDraft(product, observation, content);
    return {
      organizationId: input.organizationId,
      providerId: snapshot.providerId,
      providerSourceRevisionId: observation.pins.providerSourceRevisionId,
      evidence: finalizePackScoutBuybackEvEvidenceV1(draft, {
        evaluatedAt: input.readAt,
        stablecoinParityApprovals: [],
      }),
      calculatedAt: input.readAt,
      sourceRevisions: [
        {
          sourceRevisionId: `semantic:${observation.semanticObservationId}`,
          sourceManifestSha256: observation.normalizedContentHash,
        },
        {
          sourceRevisionId: `delivery:${observation.deliveryOccurrenceId}`,
        },
        {
          sourceRevisionId: `canonical:${product.productRevisionId}`,
          sourceManifestSha256: product.canonicalContentHash,
          canonicalRevisionId: product.productRevisionId,
        },
        ...(evInputRevision === null
          ? []
          : [{
              sourceRevisionId: `canonical:${evInputRevision.revisionId}`,
              sourceManifestSha256: evInputRevision.canonicalContentHash,
              canonicalRevisionId: evInputRevision.revisionId,
            }]),
      ],
    };
  }
}
