import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticCanonicalJson,
  type NormalizedPackProviderFacts,
  type NormalizedObservationSemanticContent,
} from "@packscout/contracts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "../../buyback-adjusted-ev-recomputation-service.ts";
import { InMemoryBuybackEvRevisionPort } from "../../buyback-adjusted-ev-recomputation.test-support.ts";
import {
  PackScoutBuybackEvRevisionStore,
  type PersistBuybackEvRevisionPortInput,
} from "../../buyback-adjusted-ev-revision-store.ts";
import { fingerprintCanonicalProviderCandidate } from
  "../../provider-observation-mapper.ts";
import {
  ClutchpacksCanonicalV3BuybackEvEvidenceSourceV1,
  type ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1,
  type ClutchpacksCanonicalV3BuybackEvObservationSourceV1,
} from "./canonical-v3-buyback-ev-evidence.ts";
import { clutchpacksProviderObservationMapper } from "./mapper.ts";

const ORGANIZATION_ID = "61000000-0000-4000-8000-000000000001";
const PROVIDER_ID = "61000000-0000-4000-8000-000000000002";
const PROVIDER_SOURCE_REVISION_ID =
  "61000000-0000-4000-8000-000000000003";
const SOURCE_INSTANCE_ID = "61000000-0000-4000-8000-000000000004";
const READ_AT = "2026-08-27T18:55:00.000Z";
const COLLECTED_AT = "2026-08-27T18:50:00.000Z";
const MIXTAPE_LEGENDS_PRODUCT_ID = "d2ff231e-f014-4ca1-82f6-475a703e3007";

type CatalogContent = Extract<
  NormalizedObservationSemanticContent,
  { kind: "catalog" }
>;
type PackCatalogContent = Omit<
  CatalogContent,
  "entity" | "providerFacts"
> & Readonly<{
  entity: "pack";
  providerFacts: NormalizedPackProviderFacts;
}>;

function uuid(sequence: number): string {
  return `62000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function normalizedPackContent(input: {
  productKey: string;
  buybackPercent?: 90 | null;
  rootBuybackPresent?: boolean;
  buckets?: readonly Readonly<{
    bucketId: string;
    quantity: number;
    lowerValue: number;
    upperValue: number;
  }>[];
}): PackCatalogContent {
  const buckets = input.buckets ?? [
    {
      bucketId: "common-range",
      quantity: 3,
      lowerValue: 50,
      upperValue: 100,
    },
    {
      bucketId: "chase-range",
      quantity: 1,
      lowerValue: 200,
      upperValue: 300,
    },
  ];
  const totalQuantity = buckets.reduce(
    (sum, bucket) => sum + bucket.quantity,
    0,
  );
  const empty = emptyNormalizedProviderFacts(
    "pack",
  ) as NormalizedPackProviderFacts;
  return {
    kind: "catalog",
    entity: "pack",
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: input.productKey,
    },
    effectiveAt: "2026-08-27T18:49:00.000Z",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    availability: "available",
    providerFacts: {
      ...empty,
      kind: "pack",
      displayName: { state: "present", value: "Fixture Pack" },
      price: {
        state: "present",
        value: { amount: 100, currency: "USD" },
      },
      buybackPercent: input.rootBuybackPresent === false
        ? { state: "absent" }
        : { state: "present", value: 90 },
      drawCount: { state: "present", value: 1 },
      evInput: {
        state: "present",
        value: {
          approved: true,
          currency: "USD",
          unitBasis: "per_pack",
          drawCount: 1,
          buybackPercent: input.buybackPercent === undefined
            ? 90
            : input.buybackPercent,
          totalQuantity,
          buckets: buckets.map((bucket) => ({
            ...bucket,
            label: null,
            probability: bucket.quantity / totalQuantity,
          })),
        },
      },
    },
    relationships: [],
  };
}

function canonicalProjection(content: PackCatalogContent, collectedAt: string) {
  const mapped = clutchpacksProviderObservationMapper.map({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    provider: "clutchpacks",
    mapperKey: "clutchpacks-provider-observation",
    mapperVersion: "1",
    normalizedContractVersion: "packscout.provider-observation.v1",
    identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
    observation: {
      ...content,
      collectedAt,
      protectedNativeEvidenceRef: "protected:fixture:record",
    },
  });
  assert.equal(mapped.status, "mapped");
  if (mapped.status !== "mapped" || mapped.candidate.candidateKind !== "pack") {
    throw new Error("fixture mapping must produce a pack");
  }
  assert.notEqual(mapped.evInputStatus, "not_applicable");
  return {
    evInputStatus: mapped.evInputStatus as "ready" | "unavailable",
    packContentHash: fingerprintCanonicalProviderCandidate(mapped.candidate),
    evInputContentHash: mapped.evInputCandidate === null
      ? null
      : fingerprintCanonicalProviderCandidate(mapped.evInputCandidate),
  };
}

function productObservation(input: {
  productKey: string;
  sequence: number;
  content?: PackCatalogContent;
  collectedAt?: string;
  deliveryOccurrenceId?: string;
}) {
  const content = input.content ?? normalizedPackContent({
    productKey: input.productKey,
  });
  const normalizedContentHash = createHash("sha256")
    .update(normalizedObservationSemanticCanonicalJson(content))
    .digest("hex");
  const collectedAt = input.collectedAt ?? COLLECTED_AT;
  const projection = canonicalProjection(content, collectedAt);
  const semanticObservationId = uuid(1_000 + input.sequence);
  return {
    productKey: input.productKey,
    productRevisionId: uuid(2_000 + input.sequence),
    canonicalContentHash: projection.packContentHash,
    canonicalProvenanceHash: "d".repeat(64),
    canonicalPublicChangeSequence: String(100 + input.sequence),
    evInputStatus: projection.evInputStatus,
    evInputRevision: projection.evInputContentHash === null
      ? null
      : {
          revisionId: uuid(2_500 + input.sequence),
          canonicalContentHash: projection.evInputContentHash,
          canonicalProvenanceHash: "b".repeat(64),
          canonicalPublicChangeSequence: String(200 + input.sequence),
        },
    observation: {
      semanticObservationId,
      originSemanticObservationId: semanticObservationId,
      sourceRecordId: uuid(3_000 + input.sequence),
      providerRecordId: input.productKey,
      normalizedContentHash,
      hashVersion: "packscout.provider-observation-hash.v1",
      normalizedContent: content,
      effectiveSourceTime: content.effectiveAt,
      deliveryOccurrenceId:
        input.deliveryOccurrenceId ?? String(4_000 + input.sequence),
      collectedAt,
      pins: {
        providerSourceRevisionId: PROVIDER_SOURCE_REVISION_ID,
        sourceInstanceId: SOURCE_INSTANCE_ID,
        sourceTypeKey: "dataforrest-events-v1",
        sourceAdapterVersion: "dataforrest-events-adapter-v3",
        normalizedContractVersion: "packscout.provider-observation.v1",
        mapperKey: "clutchpacks-provider-observation",
        mapperVersion: "1",
        identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
        cursorCodecVersion: "dataforrest-cursor-v1",
        configurationHash: "e".repeat(64),
      },
    },
  } as const;
}

function snapshot(
  products: ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1["products"],
  readAt = READ_AT,
): ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1 {
  return {
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    providerId: PROVIDER_ID,
    readAt,
    throughSequence: "999",
    products,
  };
}

class FixtureRepository
implements ClutchpacksCanonicalV3BuybackEvObservationSourceV1 {
  calls = 0;

  constructor(
    private readonly value: ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1,
  ) {}

  async loadSnapshot() {
    this.calls += 1;
    return this.value;
  }
}

class CapturingBuybackEvRevisionPort extends InMemoryBuybackEvRevisionPort {
  readonly inputs: PersistBuybackEvRevisionPortInput[] = [];

  override async persistCompletedRevision(
    input: PersistBuybackEvRevisionPortInput,
  ) {
    this.inputs.push(input);
    return super.persistCompletedRevision(input);
  }
}

function sourceFor(value: ClutchpacksCanonicalV3BuybackEvObservationSnapshotV1) {
  const repository = new FixtureRepository(value);
  return {
    repository,
    source: new ClutchpacksCanonicalV3BuybackEvEvidenceSourceV1({
      organizationId: ORGANIZATION_ID,
      repository,
    }),
  };
}

test("canonical V3 source emits all 17 ClutchPacks products and binds Mixtape Legends as missing buyback", async () => {
  const productKeys = [
    ...Array.from({ length: 16 }, (_, index) => uuid(10_000 + index)),
    MIXTAPE_LEGENDS_PRODUCT_ID,
  ];
  const products = productKeys.map((productKey, index) =>
    productObservation({
      productKey,
      sequence: index + 1,
      content: normalizedPackContent({
        productKey,
        buybackPercent:
          productKey === MIXTAPE_LEGENDS_PRODUCT_ID ? null : 90,
        rootBuybackPresent: productKey !== MIXTAPE_LEGENDS_PRODUCT_ID,
      }),
    })
  );
  const { repository, source } = sourceFor(snapshot(products));
  const commands = await Promise.all(productKeys.map((productKey) =>
    source.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    })
  ));
  assert.equal(repository.calls, 1);
  assert.equal(commands.filter(Boolean).length, 17);
  assert.equal(
    commands.filter((command) =>
      command?.evidence !== null &&
      typeof command?.evidence === "object" &&
      "status" in command.evidence &&
      command.evidence.status === "complete"
    ).length,
    16,
  );
  const mixtape = commands.at(-1);
  assert.ok(mixtape);
  assert.equal(mixtape.providerSourceRevisionId, PROVIDER_SOURCE_REVISION_ID);
  assert.equal(products.at(-1)?.evInputRevision, null);
  const mixtapeSourceRevisions = mixtape.sourceRevisions;
  assert.ok(mixtapeSourceRevisions);
  assert.equal(
    mixtapeSourceRevisions.some((sourceRevision) =>
      sourceRevision.sourceRevisionId.startsWith("canonical:") &&
      sourceRevision.canonicalRevisionId !== products.at(-1)!.productRevisionId
    ),
    false,
  );
  assert.deepEqual(
    mixtapeSourceRevisions.map(({ sourceRevisionId }) => sourceRevisionId),
    [
      `semantic:${products.at(-1)!.observation!.semanticObservationId}`,
      `delivery:${products.at(-1)!.observation!.deliveryOccurrenceId}`,
      `canonical:${products.at(-1)!.productRevisionId}`,
    ],
  );
  const mixtapeEvidence = mixtape.evidence as {
    status: string;
    internalReasons: readonly string[];
    publicPrimaryReason: string;
    product: unknown;
  };
  assert.equal(mixtapeEvidence.status, "unavailable");
  assert.deepEqual(mixtapeEvidence.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(mixtapeEvidence.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  assert.deepEqual(
    mixtapeEvidence.product,
    {
      state: "known",
      reference: {
        productKey: MIXTAPE_LEGENDS_PRODUCT_ID,
        productRevisionId: products.at(-1)!.productRevisionId,
      },
    },
  );
});

test("canonical V3 exact uniform 90% terms and normalized counts produce strict PR15 evidence", async () => {
  const productKey = uuid(20_000);
  const product = productObservation({ productKey, sequence: 1 });
  assert.ok(product.evInputRevision);
  const { source } = sourceFor(snapshot([
    product,
  ]));
  const command = await source.loadCommand({
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  });
  assert.ok(command);
  const evidence = command.evidence as {
    status: string;
    input: {
      product: unknown;
      uniformBuybackRate: unknown;
      observation: { coherenceKind: string; observedAt: string };
      oddsEvidence: unknown;
      outcomes: readonly {
        representation: { kind: string; homogeneityEvidenceSha256: string };
        buyback: unknown;
        probability: unknown;
      }[];
    };
  };
  assert.equal(evidence.status, "complete");
  assert.deepEqual(evidence.input.product, {
    productKey,
    productRevisionId: uuid(2_001),
  });
  assert.deepEqual(evidence.input.uniformBuybackRate, {
    scope: "every_eligible_outcome",
    terms: {
      rateBasisPoints: 9_000,
      percentageFeeBasisPoints: 0,
      fixedFee: {
        sourceAmount: { minorUnits: 0, currency: "USD", precision: 2 },
        canonicalUsdCents: { numerator: 0, denominator: 1 },
        normalization: { kind: "usd_direct" },
      },
      floor: null,
      cap: null,
    },
  });
  assert.equal(evidence.input.observation.coherenceKind, "guarded_collection");
  assert.equal(evidence.input.observation.observedAt, COLLECTED_AT);
  assert.deepEqual(evidence.input.oddsEvidence, {
    sourceKind: "current_remaining_inventory",
    poolKind: "finite",
    currentPoolCompleteness: "complete",
    probabilityCoverage: "complete",
    publishedOddsComparison: { status: "not_available" },
  });
  assert.deepEqual(
    evidence.input.outcomes.map(({ buyback, probability }) => ({
      buyback,
      probability,
    })),
    [
      {
        buyback: { eligibility: "eligible", payout: { kind: "product_uniform_rate" } },
        probability: { numerator: 1, denominator: 4 },
      },
      {
        buyback: { eligibility: "eligible", payout: { kind: "product_uniform_rate" } },
        probability: { numerator: 3, denominator: 4 },
      },
    ],
  );
  for (const outcome of evidence.input.outcomes) {
    assert.equal(outcome.representation.kind, "homogeneous_bucket");
    assert.match(outcome.representation.homogeneityEvidenceSha256, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(command.sourceRevisions, [
    {
      sourceRevisionId: `semantic:${product.observation.semanticObservationId}`,
      sourceManifestSha256: product.observation.normalizedContentHash,
    },
    {
      sourceRevisionId: `delivery:${product.observation.deliveryOccurrenceId}`,
      sourceManifestSha256: product.observation.normalizedContentHash,
    },
    {
      sourceRevisionId: `canonical:${product.productRevisionId}`,
      sourceManifestSha256: product.canonicalContentHash,
      canonicalRevisionId: product.productRevisionId,
    },
    {
      sourceRevisionId: `canonical:${product.evInputRevision.revisionId}`,
      sourceManifestSha256: product.evInputRevision.canonicalContentHash,
      canonicalRevisionId: product.evInputRevision.revisionId,
    },
  ]);
  assert.deepStrictEqual(
    command,
    await source.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
  );
});

test("canonical V3 does not invent a 90% default when only one normalized buyback fact supplies it", async () => {
  const productKey = uuid(30_000);
  const content = normalizedPackContent({
    productKey,
    rootBuybackPresent: false,
    buybackPercent: 90,
  });
  const { source } = sourceFor(snapshot([
    productObservation({ productKey, sequence: 1, content }),
  ]));
  const command = await source.loadCommand({
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  });
  assert.ok(command);
  assert.deepEqual(
    (command.evidence as { internalReasons: readonly string[] }).internalReasons,
    ["INVALID_BUYBACK_TERMS"],
  );
});

test("delivery identity replays exactly and advances for a newer coherent collection", async () => {
  const productKey = uuid(40_000);
  const product = productObservation({ productKey, sequence: 1 });
  const first = sourceFor(snapshot([product]));
  const replayed = sourceFor(snapshot([{
    ...product,
    observation: {
      ...product.observation,
      deliveryOccurrenceId: "99999",
      collectedAt: "2026-08-27T18:54:00.000Z",
    },
  }]));
  const commandInput = {
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  } as const;
  const before = await first.source.loadCommand(commandInput);
  const sameOccurrence = await first.source.loadCommand(commandInput);
  const after = await replayed.source.loadCommand(commandInput);
  assert.ok(before && sameOccurrence && after);
  const beforeInput = (before.evidence as {
    input: { observation: { observedAt: string; collectionGuardSha256: string } };
  }).input;
  const afterInput = (after.evidence as {
    input: { observation: { observedAt: string; collectionGuardSha256: string } };
  }).input;
  assert.equal(beforeInput.observation.observedAt, COLLECTED_AT);
  assert.equal(afterInput.observation.observedAt, "2026-08-27T18:54:00.000Z");
  assert.notEqual(
    beforeInput.observation.collectionGuardSha256,
    afterInput.observation.collectionGuardSha256,
  );
  assert.equal(
    before.sourceRevisions?.[0]?.sourceRevisionId,
    after.sourceRevisions?.[0]?.sourceRevisionId,
  );
  assert.notEqual(
    before.sourceRevisions?.[1]?.sourceRevisionId,
    after.sourceRevisions?.[1]?.sourceRevisionId,
  );

  const port = new InMemoryBuybackEvRevisionPort();
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(port),
  );
  assert.equal((await service.recompute(before)).outcome, "created");
  assert.equal((await service.recompute(sameOccurrence)).outcome, "unchanged");
  assert.equal((await service.recompute(after)).outcome, "created");
  assert.equal(port.rows.length, 2);
  assert.notEqual(port.rows[0]?.calculationKey, port.rows[1]?.calculationKey);
  assert.notEqual(
    port.rows[0]?.effectiveFingerprint,
    port.rows[1]?.effectiveFingerprint,
  );
  assert.equal(
    port.rows[0]?.sourceRevisionId,
    `delivery:${product.observation.deliveryOccurrenceId}`,
  );
  assert.equal(port.rows[1]?.sourceRevisionId, "delivery:99999");
});

test("a time-only semantic replay creates a fresh current EV revision while retaining the canonical origin", async () => {
  const productKey = uuid(45_000);
  const product = productObservation({ productKey, sequence: 1 });
  const replayEffectiveAt = "2026-08-27T18:53:00.000Z";
  const replayCollectedAt = "2026-08-27T18:54:00.000Z";
  const replayContent = {
    ...(product.observation.normalizedContent as PackCatalogContent),
    effectiveAt: replayEffectiveAt,
  };
  const replayHash = createHash("sha256")
    .update(normalizedObservationSemanticCanonicalJson(replayContent))
    .digest("hex");
  const replayedProduct = {
    ...product,
    observation: {
      ...product.observation,
      semanticObservationId: uuid(9_001),
      normalizedContentHash: replayHash,
      normalizedContent: replayContent,
      effectiveSourceTime: replayEffectiveAt,
      deliveryOccurrenceId: "99999",
      collectedAt: replayCollectedAt,
    },
  } as const;
  const commandInput = {
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  } as const;
  const beforeCommand = await sourceFor(snapshot([product])).source.loadCommand(
    commandInput,
  );
  const replayCommand = await sourceFor(snapshot([replayedProduct])).source
    .loadCommand(commandInput);
  assert.ok(beforeCommand && replayCommand);
  assert.equal(
    replayedProduct.observation.originSemanticObservationId,
    product.observation.semanticObservationId,
  );
  assert.notEqual(
    replayedProduct.observation.semanticObservationId,
    product.observation.semanticObservationId,
  );

  const port = new InMemoryBuybackEvRevisionPort();
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(port),
  );
  const before = await service.recompute(beforeCommand);
  const replay = await service.recompute(replayCommand);

  assert.equal(before.outcome, "created");
  assert.equal(replay.outcome, "created");
  assert.equal(port.rows.length, 2);
  assert.equal(port.rows[0]?.revisionNumber, 1);
  assert.equal(port.rows[1]?.revisionNumber, 2);
  assert.equal(port.rows[1]?.dataAsOf.observedAt, replayCollectedAt);
  assert.equal(port.rows[1]?.status, "available");
  assert.equal(
    port.rows[1]?.sourceRevisionId,
    `delivery:${replayedProduct.observation.deliveryOccurrenceId}`,
  );
  assert.equal(
    (await port.getCurrentCompletedRevision({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      methodVersion: port.rows[1]!.methodVersion,
    }))?.revisionId,
    port.rows[1]?.revisionId,
  );
});

test("a governed EV-input advance changes economics without replacing the canonical pack identity", async () => {
  const productKey = uuid(46_000);
  const product = productObservation({ productKey, sequence: 1 });
  const advancedEffectiveAt = "2026-08-27T18:53:00.000Z";
  const advancedCollectedAt = "2026-08-27T18:54:00.000Z";
  const advancedContent = {
    ...normalizedPackContent({
      productKey,
      buckets: [
        {
          bucketId: "common-range",
          quantity: 4,
          lowerValue: 20,
          upperValue: 40,
        },
        {
          bucketId: "chase-range",
          quantity: 1,
          lowerValue: 100,
          upperValue: 120,
        },
      ],
    }),
    effectiveAt: advancedEffectiveAt,
  };
  const advancedSemanticObservationId = uuid(9_101);
  const advancedProjection = canonicalProjection(
    advancedContent,
    advancedCollectedAt,
  );
  assert.equal(advancedProjection.evInputStatus, "ready");
  assert.ok(advancedProjection.evInputContentHash);
  assert.ok(product.evInputRevision);
  const advancedProduct = {
    ...product,
    evInputRevision: {
      revisionId: uuid(9_102),
      canonicalContentHash: advancedProjection.evInputContentHash,
      canonicalProvenanceHash: "2".repeat(64),
      canonicalPublicChangeSequence: "300",
    },
    observation: {
      ...product.observation,
      semanticObservationId: advancedSemanticObservationId,
      originSemanticObservationId: advancedSemanticObservationId,
      normalizedContentHash: createHash("sha256")
        .update(normalizedObservationSemanticCanonicalJson(advancedContent))
        .digest("hex"),
      normalizedContent: advancedContent,
      effectiveSourceTime: advancedEffectiveAt,
      deliveryOccurrenceId: "99998",
      collectedAt: advancedCollectedAt,
    },
  } as const;
  const commandInput = {
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  } as const;
  const firstCommand = await sourceFor(snapshot([product])).source.loadCommand(
    commandInput,
  );
  const advancedCommand = await sourceFor(snapshot([advancedProduct])).source
    .loadCommand(commandInput);
  assert.ok(firstCommand && advancedCommand);

  assert.equal(
    advancedProduct.productRevisionId,
    product.productRevisionId,
  );
  assert.notEqual(
    advancedProduct.evInputRevision.revisionId,
    product.evInputRevision.revisionId,
  );
  assert.deepEqual(advancedCommand.sourceRevisions?.slice(-2), [
    {
      sourceRevisionId: `canonical:${product.productRevisionId}`,
      sourceManifestSha256: product.canonicalContentHash,
      canonicalRevisionId: product.productRevisionId,
    },
    {
      sourceRevisionId:
        `canonical:${advancedProduct.evInputRevision.revisionId}`,
      sourceManifestSha256:
        advancedProduct.evInputRevision.canonicalContentHash,
      canonicalRevisionId: advancedProduct.evInputRevision.revisionId,
    },
  ]);

  const port = new CapturingBuybackEvRevisionPort();
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(port),
  );
  const first = await service.recompute(firstCommand);
  const advanced = await service.recompute(advancedCommand);

  assert.equal(first.outcome, "created");
  assert.equal(advanced.outcome, "created");
  assert.equal(port.rows.length, 2);
  assert.equal(port.rows[0]?.productRevisionId, product.productRevisionId);
  assert.equal(port.rows[1]?.productRevisionId, product.productRevisionId);
  assert.notDeepEqual(port.rows[1]?.metrics, port.rows[0]?.metrics);
  assert.equal(port.rows[1]?.dataAsOf.observedAt, advancedCollectedAt);
  assert.deepEqual(
    port.inputs[1]?.sourceReferences.filter(
      ({ canonicalRevisionId }) => canonicalRevisionId !== null,
    ),
    [
      {
        referenceIndex: 2,
        sourceRevisionId: `canonical:${product.productRevisionId}`,
        sourceManifestSha256: product.canonicalContentHash,
        canonicalRevisionId: product.productRevisionId,
      },
      {
        referenceIndex: 3,
        sourceRevisionId:
          `canonical:${advancedProduct.evInputRevision.revisionId}`,
        sourceManifestSha256:
          advancedProduct.evInputRevision.canonicalContentHash,
        canonicalRevisionId: advancedProduct.evInputRevision.revisionId,
      },
    ],
  );
});

test("a price-only advance binds the latest pack revision and retains the governed EV input", async () => {
  const productKey = uuid(46_100);
  const product = productObservation({ productKey, sequence: 1 });
  assert.ok(product.evInputRevision);
  const baseContent = normalizedPackContent({ productKey });
  const advancedEffectiveAt = "2026-08-27T18:53:00.000Z";
  const advancedCollectedAt = "2026-08-27T18:54:00.000Z";
  const advancedContent: PackCatalogContent = {
    ...baseContent,
    effectiveAt: advancedEffectiveAt,
    providerFacts: {
      ...baseContent.providerFacts,
      price: {
        state: "present",
        value: { amount: 125, currency: "USD" },
      },
    },
  };
  const projectedAdvance = productObservation({
    productKey,
    sequence: 2,
    content: advancedContent,
    collectedAt: advancedCollectedAt,
    deliveryOccurrenceId: "99997",
  });
  assert.ok(projectedAdvance.evInputRevision);
  assert.equal(
    projectedAdvance.evInputRevision.canonicalContentHash,
    product.evInputRevision.canonicalContentHash,
  );
  const advancedProduct = {
    ...projectedAdvance,
    evInputRevision: product.evInputRevision,
    observation: {
      ...projectedAdvance.observation,
      sourceRecordId: product.observation.sourceRecordId,
    },
  } as const;
  const commandInput = {
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  } as const;
  const before = await sourceFor(snapshot([product])).source.loadCommand(
    commandInput,
  );
  const advanced = await sourceFor(snapshot([advancedProduct])).source
    .loadCommand(commandInput);
  assert.ok(before && advanced);

  assert.notEqual(advancedProduct.productRevisionId, product.productRevisionId);
  assert.equal(
    advanced.sourceRevisions?.[2]?.canonicalRevisionId,
    advancedProduct.productRevisionId,
  );
  assert.equal(
    advanced.sourceRevisions?.[3]?.canonicalRevisionId,
    product.evInputRevision.revisionId,
  );

  const port = new InMemoryBuybackEvRevisionPort();
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(port),
  );
  assert.equal((await service.recompute(before)).outcome, "created");
  assert.equal((await service.recompute(advanced)).outcome, "created");
  assert.equal(port.rows.length, 2);
  assert.equal(
    port.rows[1]?.productRevisionId,
    advancedProduct.productRevisionId,
  );
  assert.notDeepEqual(port.rows[1]?.metrics, port.rows[0]?.metrics);
});

test("a ready-to-unavailable inventory transition emits deterministic unavailable evidence without historical EV input", async () => {
  const productKey = uuid(46_200);
  const readyProduct = productObservation({ productKey, sequence: 1 });
  assert.ok(readyProduct.evInputRevision);
  const readyContent = normalizedPackContent({ productKey });
  const readyEvInput = readyContent.providerFacts.evInput;
  assert.equal(readyEvInput.state, "present");
  if (readyEvInput.state !== "present") {
    throw new Error("fixture EV input must be present");
  }
  const unavailableEffectiveAt = "2026-08-27T18:53:00.000Z";
  const unavailableCollectedAt = "2026-08-27T18:54:00.000Z";
  const unavailableContent: PackCatalogContent = {
    ...readyContent,
    effectiveAt: unavailableEffectiveAt,
    providerFacts: {
      ...readyContent.providerFacts,
      evInput: {
        state: "present",
        value: {
          ...readyEvInput.value,
          // Live-shaped inventory drift: bucket quantities still total four,
          // while the provider's current aggregate total has advanced to five.
          totalQuantity: 5,
        },
      },
    },
  };
  const unavailableProjection = productObservation({
    productKey,
    sequence: 2,
    content: unavailableContent,
    collectedAt: unavailableCollectedAt,
    deliveryOccurrenceId: "99996",
  });
  assert.equal(unavailableProjection.evInputStatus, "unavailable");
  assert.equal(unavailableProjection.evInputRevision, null);
  const unavailableProduct = {
    ...unavailableProjection,
    observation: {
      ...unavailableProjection.observation,
      sourceRecordId: readyProduct.observation.sourceRecordId,
    },
  } as const;
  const commandInput = {
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt: READ_AT,
  } as const;
  const ready = await sourceFor(snapshot([readyProduct])).source.loadCommand(
    commandInput,
  );
  const unavailableSource = sourceFor(snapshot([unavailableProduct])).source;
  const unavailable = await unavailableSource.loadCommand(commandInput);
  assert.ok(ready && unavailable);
  assert.deepStrictEqual(
    unavailable,
    await unavailableSource.loadCommand(commandInput),
  );
  assert.equal(
    (unavailable.evidence as { status: string }).status,
    "unavailable",
  );
  assert.deepEqual(unavailable.sourceRevisions, [
    {
      sourceRevisionId:
        `semantic:${unavailableProduct.observation.semanticObservationId}`,
      sourceManifestSha256:
        unavailableProduct.observation.normalizedContentHash,
    },
    {
      sourceRevisionId:
        `delivery:${unavailableProduct.observation.deliveryOccurrenceId}`,
      sourceManifestSha256:
        unavailableProduct.observation.normalizedContentHash,
    },
    {
      sourceRevisionId: `canonical:${unavailableProduct.productRevisionId}`,
      sourceManifestSha256: unavailableProduct.canonicalContentHash,
      canonicalRevisionId: unavailableProduct.productRevisionId,
    },
  ]);

  const port = new InMemoryBuybackEvRevisionPort();
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(port),
  );
  assert.equal((await service.recompute(ready)).outcome, "created");
  const result = await service.recompute(unavailable);
  assert.equal(result.outcome, "created");
  assert.equal(result.status.availability, "UNAVAILABLE");
  assert.equal(port.rows[1]?.productRevisionId, unavailableProduct.productRevisionId);
});

test("a latest semantic observation that does not reproduce governed hashes fails closed", async () => {
  const productKey = uuid(47_000);
  const product = productObservation({ productKey, sequence: 1 });
  const driftBase = normalizedPackContent({ productKey });
  const driftContent: PackCatalogContent = {
    ...driftBase,
    effectiveAt: "2026-08-27T18:53:00.000Z",
    providerFacts: {
      ...driftBase.providerFacts,
      price: {
        state: "present",
        value: { amount: 101, currency: "USD" },
      },
    },
  };
  const latest = productObservation({
    productKey,
    sequence: 2,
    content: driftContent,
    collectedAt: "2026-08-27T18:54:00.000Z",
  });
  const misalignedProduct = {
    ...product,
    observation: {
      ...latest.observation,
      originSemanticObservationId:
        product.observation.originSemanticObservationId,
      sourceRecordId: product.observation.sourceRecordId,
    },
  } as const;
  const { source } = sourceFor(snapshot([misalignedProduct]));

  await assert.rejects(
    source.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SOURCE_NATIVE_LINEAGE_INVALID",
  );
});

test("a JSONB-shortened derived probability still validates its governed EV-input hash", async () => {
  const productKey = uuid(47_100);
  const content = normalizedPackContent({
    productKey,
    buckets: [
      {
        bucketId: "common-range",
        quantity: 3,
        lowerValue: 50,
        upperValue: 100,
      },
      {
        bucketId: "chase-range",
        quantity: 95,
        lowerValue: 200,
        upperValue: 300,
      },
    ],
  });
  const product = productObservation({
    productKey,
    sequence: 1,
    content,
  });
  assert.ok(product.evInputRevision);
  const evInputFact = content.providerFacts.evInput;
  assert.equal(evInputFact.state, "present");
  if (evInputFact.state !== "present") {
    throw new Error("fixture EV input must be present");
  }
  const persistedContent: PackCatalogContent = {
    ...content,
    providerFacts: {
      ...content.providerFacts,
      evInput: {
        state: "present",
        value: {
          ...evInputFact.value,
          buckets: evInputFact.value.buckets.map((bucket) => ({
            ...bucket,
            // Prisma's JSONB input codec persisted 3 / 98 with this shorter
            // decimal even though the canonical projection used the original
            // JavaScript quotient.
            probability: bucket.quantity === 3
              ? 0.03061224489795918
              : bucket.probability,
          })),
        },
      },
    },
  };
  const persistedProjection = canonicalProjection(
    persistedContent,
    COLLECTED_AT,
  );
  assert.notEqual(
    persistedProjection.evInputContentHash,
    product.evInputRevision.canonicalContentHash,
  );
  const persistedProduct = {
    ...product,
    observation: {
      ...product.observation,
      normalizedContent: persistedContent,
    },
  } as const;

  const command = await sourceFor(snapshot([persistedProduct])).source
    .loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    });

  assert.ok(command);
  assert.equal(
    command.sourceRevisions?.at(-1)?.sourceManifestSha256,
    product.evInputRevision.canonicalContentHash,
  );
});

test("a missing or mismatched governed EV input fails closed", async () => {
  const productKey = uuid(48_000);
  const product = productObservation({ productKey, sequence: 1 });
  assert.ok(product.evInputRevision);
  const missing = sourceFor(snapshot([{
    ...product,
    evInputRevision: null,
  }])).source;
  await assert.rejects(
    missing.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SOURCE_NATIVE_LINEAGE_INVALID",
  );

  const mismatched = sourceFor(snapshot([{
    ...product,
    evInputRevision: {
      ...product.evInputRevision,
      revisionId: product.productRevisionId,
    },
  }])).source;
  await assert.rejects(
    mismatched.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SOURCE_NATIVE_LINEAGE_INVALID",
  );
});

test("canonical revisions ahead of the settled snapshot and cross-product EV facts fail closed", async () => {
  const productKey = uuid(49_000);
  const product = productObservation({ productKey, sequence: 1 });
  assert.ok(product.evInputRevision);
  const aheadOfSnapshot = sourceFor(snapshot([{
    ...product,
    evInputRevision: {
      ...product.evInputRevision,
      canonicalPublicChangeSequence: "1000",
    },
  }])).source;
  await assert.rejects(
    aheadOfSnapshot.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SOURCE_NATIVE_LINEAGE_INVALID",
  );

  const crossProduct = sourceFor(snapshot([{
    ...product,
    observation: {
      ...product.observation,
      providerRecordId: uuid(49_001),
    },
  }])).source;
  await assert.rejects(
    crossProduct.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SOURCE_NATIVE_CONTRACT_INVALID",
  );
});

test("a complete but old canonical observation becomes SOURCE_DATA_STALE at the real recomputation boundary", async () => {
  const readAt = "2026-08-27T20:00:00.000Z";
  const productKey = uuid(50_000);
  const { source } = sourceFor(snapshot([
    productObservation({
      productKey,
      sequence: 1,
      collectedAt: "2026-08-27T18:50:00.000Z",
    }),
  ], readAt));
  const command = await source.loadCommand({
    organizationId: ORGANIZATION_ID,
    platformKey: "clutchpacks",
    productKey,
    readAt,
  });
  assert.ok(command);
  const port = new InMemoryBuybackEvRevisionPort();
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(port),
  );
  const result = await service.recompute(command);
  assert.equal(result.outcome, "created");
  assert.equal(result.status.publicReason, "SOURCE_DATA_STALE");
  assert.equal(result.status.availability, "UNAVAILABLE");
});

test("malformed source-native semantic content fails closed instead of falling back to raw or defaults", async () => {
  const productKey = uuid(60_000);
  const product = productObservation({ productKey, sequence: 1 });
  const { source } = sourceFor(snapshot([{
    ...product,
    observation: {
      ...product.observation,
      normalizedContent: {
        ...(product.observation.normalizedContent as object),
        providerFacts: {},
      },
    },
  }]));
  await assert.rejects(
    source.loadCommand({
      organizationId: ORGANIZATION_ID,
      platformKey: "clutchpacks",
      productKey,
      readAt: READ_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SOURCE_NATIVE_CONTRACT_INVALID",
  );
});
