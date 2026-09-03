import { z } from "zod";
import {
  PACK_CATALOG_V1,
  PACK_SNAPSHOT_HASH_DOMAIN,
  PROFILE_SNAPSHOT_HASH_DOMAIN,
  assertPublicPackCatalogBytes,
  compareCanonicalStrings,
  hashPackCatalogValue,
  normalizePackCatalogSearchText,
  packCatalogCanonicalByteCount,
  packCatalogCanonicalJson,
} from "./pack-catalog-v1.ts";
import {
  activeCollectibleProfileHeadSchema,
  activeProviderProfileHeadSchema,
  normalizePublicPackSnapshotPayload,
  publicCollectibleProfileSchema,
  publicPackLifecycleSchema,
  publicPackSnapshotBatchSchema,
  publicPackSnapshotDescriptorSchema,
  publicPackSnapshotIdentitySchema,
  publicPackSnapshotSchema,
  publicPackSummaryCore,
  publicProfileSnapshotBatchSchema,
  publicProfileSnapshotDescriptorSchema,
  publicProfileSnapshotIdentitySchema,
  publicProviderProfileSchema,
  type PublicPackSnapshotPayload,
} from "./pack-catalog-domain.ts";
import {
  activePackHeadSchema,
  packActivationIntentSchema,
  packBuildRequestSchema,
  type ActivePackHead,
} from "./pack-publication.ts";
import {
  issuePackCatalogCursor,
  packCatalogListPublicPacksResultSchema,
  type PackCatalogCursorBinding,
} from "./pack-catalog-query.ts";

export const packCatalogFixtureIds = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000001",
  providerId: "20000000-0000-4000-8000-000000000001",
  packA: "30000000-0000-4000-8000-000000000001",
  packB: "30000000-0000-4000-8000-000000000002",
  collectibleA: "40000000-0000-4000-8000-000000000001",
  collectibleB: "40000000-0000-4000-8000-000000000002",
  collectibleC: "40000000-0000-4000-8000-000000000003",
  category: "50000000-0000-4000-8000-000000000001",
});
const DATA_AS_OF = "2026-09-03T18:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

async function sealProviderProfile() {
  const body = {
    profileKind: "provider" as const,
    providerId: packCatalogFixtureIds.providerId,
    sourceIdentity: "provider-profile:42",
    dataAsOf: DATA_AS_OF,
    displayName: "Fixture Provider",
    brandAssets: [{ kind: "logo" as const, url: "https://cdn.packscout.test/provider.svg", alt: "Fixture Provider" }],
    promotions: [{ promotionId: "welcome", label: "Open provider", copy: "Browse this provider", url: "https://provider.test/" }],
  };
  const contentSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, body);
  const identity = publicProfileSnapshotIdentitySchema.parse({
    profileKind: body.profileKind,
    providerId: body.providerId,
    sourceIdentity: body.sourceIdentity,
    dataAsOf: body.dataAsOf,
    publicProfileSnapshotId: `ppfs_${contentSha256}`,
    contentSha256,
  });
  const profile = publicProviderProfileSchema.parse({ identity, displayName: body.displayName, brandAssets: body.brandAssets, promotions: body.promotions });
  const batchBody = { kind: "profile_batch", profile };
  const batchSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, batchBody);
  const batch = publicProfileSnapshotBatchSchema.parse({ publicProfileSnapshotId: identity.publicProfileSnapshotId, batchIndex: 0, recordCount: 1, byteCount: packCatalogCanonicalByteCount(batchBody), batchSha256, profile });
  const batchDescriptor = {
    publicProfileSnapshotId: batch.publicProfileSnapshotId,
    batchIndex: batch.batchIndex,
    recordCount: batch.recordCount,
    byteCount: batch.byteCount,
    batchSha256: batch.batchSha256,
  };
  return { profile, descriptor: publicProfileSnapshotDescriptorSchema.parse({ identity, batch: batchDescriptor, completionState: "complete" }), batch };
}

async function sealCollectibleProfile(input: { id: string; name: string; valuation: number; hash: string }) {
  const aliases = [input.name.toLocaleLowerCase("en-US")];
  const body = {
    profileKind: "collectible" as const,
    publicCollectibleId: input.id,
    sourceIdentity: `collectible-profile:${input.id}`,
    dataAsOf: DATA_AS_OF,
    displayName: input.name,
    imageUrl: `https://cdn.packscout.test/${input.id}.jpg`,
    category: { publicCategoryId: packCatalogFixtureIds.category, label: "Cards" },
    aliases,
    searchText: normalizePackCatalogSearchText([input.name, ...aliases].join(" ")),
    valuationDisplay: { status: "available" as const, amount: { currency: "USD", minorUnits: input.valuation }, valuationIdentity: input.hash, observedAt: DATA_AS_OF },
  };
  const contentSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, body);
  const identity = publicProfileSnapshotIdentitySchema.parse({ profileKind: body.profileKind, publicCollectibleId: body.publicCollectibleId, sourceIdentity: body.sourceIdentity, dataAsOf: body.dataAsOf, publicProfileSnapshotId: `ppfs_${contentSha256}`, contentSha256 });
  const profile = publicCollectibleProfileSchema.parse({ identity, displayName: body.displayName, imageUrl: body.imageUrl, category: body.category, aliases: body.aliases, searchText: body.searchText, valuationDisplay: body.valuationDisplay });
  const batchBody = { kind: "profile_batch", profile };
  const batchSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, batchBody);
  const batch = publicProfileSnapshotBatchSchema.parse({ publicProfileSnapshotId: identity.publicProfileSnapshotId, batchIndex: 0, recordCount: 1, byteCount: packCatalogCanonicalByteCount(batchBody), batchSha256, profile });
  const batchDescriptor = {
    publicProfileSnapshotId: batch.publicProfileSnapshotId,
    batchIndex: batch.batchIndex,
    recordCount: batch.recordCount,
    byteCount: batch.byteCount,
    batchSha256: batch.batchSha256,
  };
  return { profile, descriptor: publicProfileSnapshotDescriptorSchema.parse({ identity, batch: batchDescriptor, completionState: "complete" }), batch };
}

function lifecycle(availability: "available" | "unavailable" | "sold_out" | "unknown", retirement: "active" | "retired") {
  const canonicalState = ({ available: "active", unavailable: "disabled", unknown: "unknown" } as const)[availability as "available" | "unavailable" | "unknown"];
  return publicPackLifecycleSchema.parse({
    availability,
    retirement,
    availabilityEvidence: availability === "sold_out"
      ? { kind: "explicit_sold_out", sourceIdentity: "provider-state:42" }
      : { kind: "canonical_state", canonicalState, sourceIdentity: "provider-state:42" },
    retirementEvidence: retirement === "retired"
      ? { kind: "explicit_provider_retirement", evidenceIdentity: "provider-retirement:42" }
      : { kind: "not_retired" },
  });
}

async function makePackPayload(input: {
  id: string;
  title: string;
  contents: readonly { id: string; name: string; profileId: string; valuation: number; hash: string }[];
  lifecycle: ReturnType<typeof lifecycle>;
  evMinorUnits: number | null;
  previous?: { snapshotId: string; economicsSha256: string };
}): Promise<PublicPackSnapshotPayload> {
  const records = input.contents.map((item) => ({
    publicCollectibleId: item.id,
    collectibleProfileSnapshotId: item.profileId,
    displayName: item.name,
    imageUrl: `https://cdn.packscout.test/${item.id}.jpg`,
    category: { publicCategoryId: packCatalogFixtureIds.category, label: "Cards" },
    quantity: 1,
    probabilityMicros: 500_000,
    eligibleForChase: true,
    valuation: { status: "available" as const, amount: { currency: "USD", minorUnits: item.valuation }, valuationIdentity: item.hash, observedAt: DATA_AS_OF },
  })).sort((left, right) => compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId));
  const top = [...records].sort((left, right) =>
    right.valuation.amount.minorUnits - left.valuation.amount.minorUnits ||
    compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId)
  )[0]!;
  const topChase = { publicCollectibleId: top.publicCollectibleId, valuationIdentity: top.valuation.valuationIdentity, amount: top.valuation.amount };
  const price = { currency: "USD", minorUnits: 10_000 };
  const probabilityInputsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, records.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros })));
  const valuationsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, records.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation })));
  const evMethodIdentity = "weighted-value";
  const evPolicyIdentity = "packscout-ev-policy";
  const evInputsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { price, probabilityInputsSha256, valuationsSha256, evMethodIdentity, evPolicyIdentity });
  const ev = input.evMinorUnits === null
    ? { status: "unavailable" as const, reason: "NO_CALCULABLE_VALUE" as const, evaluatedAt: DATA_AS_OF, validUntil: "2026-09-03T19:00:00.000Z" }
    : { status: "available" as const, amount: { currency: "USD", minorUnits: input.evMinorUnits }, evaluatedAt: DATA_AS_OF, validUntil: "2026-09-03T19:00:00.000Z" };
  const economicsSha256 = input.previous?.economicsSha256 ?? await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { price, records, probabilityInputsSha256, valuationsSha256, topChase, evInputsSha256, ev });
  const canAct = input.lifecycle.availability === "available" && input.lifecycle.retirement === "active";
  const disabledReason = canAct ? null : input.lifecycle.retirement === "retired" ? "PACK_RETIRED" as const : "PACK_UNAVAILABLE" as const;
  const actions = [
    { actionId: "promotion", kind: "promotion" as const, label: "View offer", url: `https://provider.test/offers/${input.id}`, enabled: canAct, disabledReason },
    { actionId: "purchase", kind: "purchase" as const, label: "Buy pack", url: `https://provider.test/packs/${input.id}`, enabled: canAct, disabledReason },
  ];
  const base = {
    schemaVersion: PACK_CATALOG_V1,
    snapshotKind: input.previous ? "lifecycle_only" as const : "full" as const,
    providerId: packCatalogFixtureIds.providerId,
    publicRepackId: input.id,
    providerProfileSnapshotId: "",
    collectibleProfileSnapshotIds: records.map(({ collectibleProfileSnapshotId }) => collectibleProfileSnapshotId).sort(compareCanonicalStrings),
    dataAsOf: DATA_AS_OF,
    title: input.title,
    imageUrl: `https://cdn.packscout.test/${input.id}.jpg`,
    category: { publicCategoryId: packCatalogFixtureIds.category, label: "Cards" },
    price,
    lifecycle: input.lifecycle,
    contents: records,
    contentCount: records.length,
    probabilityTotalMicros: 1_000_000 as const,
    probabilityInputsSha256,
    valuationDependencyIdentities: records.map(({ valuation }) => valuation.valuationIdentity).sort(compareCanonicalStrings),
    valuationsSha256,
    topChase,
    evMethodIdentity,
    evPolicyIdentity,
    evInputsSha256,
    ev,
    economicsSha256,
    lifecycleFreeze: input.previous ? { previousSnapshotId: input.previous.snapshotId, retainedEconomicsSha256: economicsSha256, provenanceIdentity: "lifecycle-only:42" } : null,
    actions,
  };
  const summaryProjection = publicPackSummaryCore(base);
  const aliases = ["featured", "fixture"];
  return { ...base, summaryProjection, searchProjection: { publicRepackId: input.id, normalizedText: normalizePackCatalogSearchText([input.title, ...records.map(({ displayName }) => displayName), ...aliases].join(" ")), aliases, categoryIds: [packCatalogFixtureIds.category] } } as PublicPackSnapshotPayload;
}

export async function sealFixturePack(payloadInput: unknown, batchSize = 250) {
  z.number().int().min(1).max(250).parse(batchSize);
  const payload = normalizePublicPackSnapshotPayload(payloadInput);
  assertPublicPackCatalogBytes(payload);
  const probabilityInputsSha256 = await hashPackCatalogValue(
    PACK_SNAPSHOT_HASH_DOMAIN,
    payload.contents.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros })),
  );
  const valuationsSha256 = await hashPackCatalogValue(
    PACK_SNAPSHOT_HASH_DOMAIN,
    payload.contents.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation })),
  );
  const evInputsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, {
    price: payload.price,
    probabilityInputsSha256,
    valuationsSha256,
    evMethodIdentity: payload.evMethodIdentity,
    evPolicyIdentity: payload.evPolicyIdentity,
  });
  const economicsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, {
    price: payload.price,
    records: payload.contents,
    probabilityInputsSha256,
    valuationsSha256,
    topChase: payload.topChase,
    evInputsSha256,
    ev: payload.ev,
  });
  if (payload.probabilityInputsSha256 !== probabilityInputsSha256 ||
    payload.valuationsSha256 !== valuationsSha256 ||
    payload.evInputsSha256 !== evInputsSha256 ||
    payload.economicsSha256 !== economicsSha256) {
    throw new TypeError("Pack snapshot input evidence does not match its complete bytes.");
  }
  const { contents, ...header } = payload;
  const proofs: Array<{
    batchIndex: number;
    records: PublicPackSnapshotPayload["contents"];
    recordCount: number;
    byteCount: number;
    batchSha256: string;
  }> = [];
  for (let start = 0; start < contents.length; start += batchSize) {
    const records = contents.slice(start, start + batchSize);
    const batchIndex = proofs.length;
    const body = { kind: "contents_batch", providerId: payload.providerId, publicRepackId: payload.publicRepackId, batchIndex, records };
    proofs.push({ batchIndex, records, recordCount: records.length, byteCount: packCatalogCanonicalByteCount(body), batchSha256: await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, body) });
  }
  const contentSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, {
    kind: "complete_pack",
    header,
    batches: proofs.map(({ batchIndex, recordCount, byteCount, batchSha256 }) => ({ batchIndex, recordCount, byteCount, batchSha256 })),
  });
  const summarySha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, payload.summaryProjection);
  const identity = publicPackSnapshotIdentitySchema.parse({ providerId: payload.providerId, publicRepackId: payload.publicRepackId, publicPackSnapshotId: `pps_${contentSha256}`, contentSha256, summarySha256, dataAsOf: payload.dataAsOf, evMethodIdentity: payload.evMethodIdentity, evPolicyIdentity: payload.evPolicyIdentity });
  const batches = proofs.map((proof) => publicPackSnapshotBatchSchema.parse({ publicPackSnapshotId: identity.publicPackSnapshotId, ...proof }));
  const snapshot = await publicPackSnapshotSchema.parseAsync({ identity, payload });
  const descriptor = publicPackSnapshotDescriptorSchema.parse({
    identity,
    lifecycle: payload.lifecycle,
    contentCount: payload.contentCount,
    valuationDependencyCount: payload.valuationDependencyIdentities.length,
    probabilityInputsSha256: payload.probabilityInputsSha256,
    valuationsSha256: payload.valuationsSha256,
    evInputsSha256: payload.evInputsSha256,
    economicsSha256: payload.economicsSha256,
    batches: batches.map(({ publicPackSnapshotId, batchIndex, recordCount, byteCount, batchSha256 }) => ({ publicPackSnapshotId, batchIndex, recordCount, byteCount, batchSha256 })),
    completionState: "complete",
  });
  return { snapshot, descriptor, batches, canonicalBytes: packCatalogCanonicalJson(payload) };
}

function summary(head: ActivePackHead) {
  return { ...head.indexableSummary, publicPackSnapshotId: head.activeSnapshot.publicPackSnapshotId, contentSha256: head.activeSnapshot.contentSha256, headGeneration: head.generation };
}

export async function createPackCatalogV1Fixture(signingKey: Uint8Array) {
  const provider = await sealProviderProfile();
  const collectibles = await Promise.all([
    sealCollectibleProfile({ id: packCatalogFixtureIds.collectibleA, name: "Alpha Card", valuation: 30_000, hash: HASH_A }),
    sealCollectibleProfile({ id: packCatalogFixtureIds.collectibleB, name: "Beta Card", valuation: 20_000, hash: HASH_B }),
    sealCollectibleProfile({ id: packCatalogFixtureIds.collectibleC, name: "Gamma Card", valuation: 10_000, hash: HASH_C }),
  ]);
  const item = (index: number) => ({ id: packCatalogFixtureIds[`collectible${String.fromCharCode(65 + index)}` as "collectibleA"], name: collectibles[index]!.profile.displayName, profileId: collectibles[index]!.profile.identity.publicProfileSnapshotId, valuation: [30_000, 20_000, 10_000][index]!, hash: [HASH_A, HASH_B, HASH_C][index]! });
  const payloadA = await makePackPayload({ id: packCatalogFixtureIds.packA, title: "Alpha Pack", contents: [item(0), item(1)], lifecycle: lifecycle("available", "active"), evMinorUnits: 25_000 });
  const payloadB = await makePackPayload({ id: packCatalogFixtureIds.packB, title: "Beta Pack", contents: [item(1), item(2)], lifecycle: lifecycle("sold_out", "active"), evMinorUnits: null });
  payloadA.providerProfileSnapshotId = provider.profile.identity.publicProfileSnapshotId;
  payloadB.providerProfileSnapshotId = provider.profile.identity.publicProfileSnapshotId;
  const packA = await sealFixturePack(payloadA);
  const packB = await sealFixturePack(payloadB);
  const payloadAUpdate = await makePackPayload({ id: packCatalogFixtureIds.packA, title: "Alpha Pack", contents: [item(0), item(1)], lifecycle: lifecycle("sold_out", "active"), evMinorUnits: 25_000, previous: { snapshotId: packA.snapshot.identity.publicPackSnapshotId, economicsSha256: packA.snapshot.payload.economicsSha256 } });
  payloadAUpdate.providerProfileSnapshotId = provider.profile.identity.publicProfileSnapshotId;
  const packAUpdate = await sealFixturePack(payloadAUpdate);
  const head = (pack: typeof packA, sequence: string) => activePackHeadSchema.parseAsync({ providerId: pack.snapshot.identity.providerId, publicRepackId: pack.snapshot.identity.publicRepackId, generation: 1, publicationEpoch: 0, held: false, holdReason: null, latestAcceptedPackPublicationSequence: sequence, activeSnapshot: pack.snapshot.identity, previousSnapshot: null, indexableSummary: pack.snapshot.payload.summaryProjection, activatedAt: DATA_AS_OF });
  const heads = { packA: await head(packA, "1"), packB: await head(packB, "2") };
  const evidence = { providerId: packCatalogFixtureIds.providerId, publicRepackId: packCatalogFixtureIds.packA, packPublicationSequence: "1", providerChangeIdentity: "provider-change:1", sourceRevisionIdentity: "source-revision:1", sharedDependencies: [] };
  const buildRequest = packBuildRequestSchema.parse({ requestId: "60000000-0000-4000-8000-000000000001", schemaVersion: PACK_CATALOG_V1, providerId: packCatalogFixtureIds.providerId, publicRepackId: packCatalogFixtureIds.packA, packPublicationSequence: "1", desiredStateSha256: HASH_A, contentsSha256: HASH_B, probabilityInputsSha256: payloadA.probabilityInputsSha256, valuationInputsSha256: payloadA.valuationsSha256, evInputsSha256: payloadA.evInputsSha256, profilePrerequisiteMode: "initial_heads_required", requiredProfileSnapshotIds: [provider.profile.identity.publicProfileSnapshotId, ...payloadA.collectibleProfileSnapshotIds].sort(compareCanonicalStrings), expectedPublicationEpoch: 0, evidence, requestedAt: DATA_AS_OF });
  const intent = (intentId: string) => packActivationIntentSchema.parse({ intentId, idempotencyKey: `activate:${intentId}`, snapshot: packA.snapshot.identity, packPublicationSequence: "1", evidence, expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null }, operationDigest: HASH_C, createdAt: DATA_AS_OF, expiresAt: "2026-09-03T19:00:00.000Z" });
  const binding: PackCatalogCursorBinding = { operation: "listPublicPacks", filters: { availabilities: ["available", "sold_out"], retirements: ["active"] }, sort: "title", direction: "asc", pageSize: 1, publicPackSnapshotId: null };
  const cursor = await issuePackCatalogCursor({ binding, lastSortKey: "alpha pack", lastStableId: packCatalogFixtureIds.packA, issuedAt: DATA_AS_OF, signingKey });
  const firstPage = packCatalogListPublicPacksResultSchema.parse({ evaluatedAt: DATA_AS_OF, items: [summary(heads.packA)], nextCursor: cursor });
  const secondPage = packCatalogListPublicPacksResultSchema.parse({ evaluatedAt: "2026-09-03T18:01:00.000Z", items: [summary(heads.packB)], nextCursor: null });
  return {
    provider,
    collectibles,
    profileHeads: {
      provider: activeProviderProfileHeadSchema.parse({ providerId: packCatalogFixtureIds.providerId, generation: 1, activeProfileSnapshotId: provider.profile.identity.publicProfileSnapshotId, previousProfileSnapshotId: null, contentSha256: provider.profile.identity.contentSha256, activatedAt: DATA_AS_OF }),
      collectibles: collectibles.map(({ profile }) => activeCollectibleProfileHeadSchema.parse({ publicCollectibleId: profile.identity.profileKind === "collectible" ? profile.identity.publicCollectibleId : "", generation: 1, activeProfileSnapshotId: profile.identity.publicProfileSnapshotId, previousProfileSnapshotId: null, contentSha256: profile.identity.contentSha256, activatedAt: DATA_AS_OF })),
    },
    packs: { packA, packB, packAUpdate },
    heads,
    buildRequest,
    activationIntents: [intent("70000000-0000-4000-8000-000000000001"), intent("70000000-0000-4000-8000-000000000002")],
    lifecycleCases: (["available", "unavailable", "sold_out", "unknown"] as const).flatMap((availability) => (["active", "retired"] as const).map((retirement) => lifecycle(availability, retirement))),
    query: { binding, cursor, firstPage, secondPage },
    saved: { savedRepackIds: [packCatalogFixtureIds.packA, packCatalogFixtureIds.packB], savedCollectibleIds: [packCatalogFixtureIds.collectibleA] },
  };
}
