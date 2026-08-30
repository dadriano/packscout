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
  type PackScoutBuybackEvEvidenceDraftV1,
} from "../buyback-ev-evidence.ts";
import { fingerprintCanonicalProviderCandidate } from
  "../../provider-observation-mapper.ts";
import { clutchpacksProviderObservationMapper } from "./mapper.ts";
import {
  clutchpacksNormalizedBuybackEvDraftV1,
  clutchpacksProbabilityMatchesCountV1,
} from "./normalized-buyback-ev-evidence.ts";

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

function contentWithCanonicalDerivedProbabilities(
  content: ClutchpacksPackSemanticContentV1,
): ClutchpacksPackSemanticContentV1 {
  const evInputFact = content.providerFacts.evInput;
  if (evInputFact.state !== "present") return content;
  const evInput = evInputFact.value;
  const totalQuantity = evInput.totalQuantity;
  if (
    totalQuantity === null ||
    !Number.isSafeInteger(totalQuantity) ||
    totalQuantity <= 0 ||
    evInput.buckets.length === 0 ||
    evInput.buckets.some(
      (bucket) =>
        bucket.quantity === null ||
        !Number.isSafeInteger(bucket.quantity) ||
        bucket.quantity <= 0 ||
        !clutchpacksProbabilityMatchesCountV1(
          bucket.probability,
          bucket.quantity,
          totalQuantity,
        ),
    ) ||
    evInput.buckets.reduce(
      (sum, bucket) => sum + (bucket.quantity ?? 0),
      0,
    ) !== totalQuantity
  ) {
    return content;
  }
  return {
    ...content,
    providerFacts: {
      ...content.providerFacts,
      evInput: {
        state: "present",
        value: {
          ...evInput,
          // The ClutchPacks adapter derives every probability from these
          // integer counts. Recreate that value after JSONB persistence so a
          // storage codec's shorter decimal cannot change canonical lineage.
          buckets: evInput.buckets.map((bucket) => ({
            ...bucket,
            probability: (bucket.quantity ?? 0) / totalQuantity,
          })),
        },
      },
    },
  };
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
    const canonicalContent = contentWithCanonicalDerivedProbabilities(content);
    mapped = clutchpacksProviderObservationMapper.map({
      organizationId,
      providerId,
      provider: CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY,
      mapperKey: observation.pins.mapperKey,
      mapperVersion: observation.pins.mapperVersion,
      normalizedContractVersion: observation.pins.normalizedContractVersion,
      identityNamespaceKey: observation.pins.identityNamespaceKey,
      observation: {
        ...canonicalContent,
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

async function evidenceDraft(
  product: ClutchpacksCanonicalV3BuybackEvProductObservationV1,
  observation: ClutchpacksCanonicalV3BuybackEvObservationV1,
  content: ClutchpacksPackSemanticContentV1,
): Promise<PackScoutBuybackEvEvidenceDraftV1> {
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
  return clutchpacksNormalizedBuybackEvDraftV1({
    facts: content.providerFacts,
    product: { productKey: product.productKey, productRevisionId: product.productRevisionId },
    normalizedContentHash: observation.normalizedContentHash,
    observationId: observation.semanticObservationId,
    observation: {
      providerKey: CLUTCHPACKS_CANONICAL_V3_PLATFORM_KEY,
      sourceRevisionId: `delivery:${observation.deliveryOccurrenceId}`,
      sourceManifestSha256: observation.normalizedContentHash,
      observedAt: observation.collectedAt,
      coherence: { kind: "guarded_collection", collectionGuardSha256: guard },
    },
  });
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
          // Bind the delivery identity to the independently retained semantic
          // bytes while preserving the semantic observation reference above.
          sourceManifestSha256: observation.normalizedContentHash,
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
