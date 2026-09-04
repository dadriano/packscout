import {
  PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, providerPackBuildInputsSchema, publicPackSummaryCore,
  type ProviderPackBuildInputs, type PublicPackSnapshotPayload,
} from "@packscout/contracts";
import { createPackCatalogV1Fixture, sealFixturePack } from "@packscout/contracts/test-fixtures/pack-catalog-v1";

export const publicationHash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);

export function inputsFromPayload(payload: PublicPackSnapshotPayload): ProviderPackBuildInputs {
  return providerPackBuildInputsSchema.parse({
    providerId: payload.providerId, publicRepackId: payload.publicRepackId, sourceRevisionIdentity: `pack:${payload.publicRepackId}:1`,
    snapshotKind: payload.snapshotKind, dataAsOf: payload.dataAsOf, title: payload.title, imageUrl: payload.imageUrl,
    category: payload.category, price: payload.price, lifecycle: payload.lifecycle,
    providerProfileSnapshotId: payload.providerProfileSnapshotId, contents: payload.contents, contentsComplete: true,
    actions: payload.actions, aliases: payload.searchProjection.aliases, evMethodIdentity: payload.evMethodIdentity,
    evPolicyIdentity: payload.evPolicyIdentity, evInputsSha256: payload.evInputsSha256, ev: payload.ev, evFailure: null,
    expectedDependencies: [], observedDependencies: [], lifecycleProvenanceIdentity: null, lifecycleBaseline: null,
  });
}

export async function freshPublicationFixture(providerId?: string, packId?: string, evLifetimeMs = 3_600_000) {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  const payload = structuredClone(fixture.packs.packA.snapshot.payload);
  payload.providerId = providerId ?? payload.providerId;
  payload.publicRepackId = packId ?? payload.publicRepackId;
  payload.searchProjection.publicRepackId = payload.publicRepackId;
  payload.ev.evaluatedAt = new Date(Date.now() - 60_000).toISOString();
  payload.ev.validUntil = new Date(Date.now() + evLifetimeMs).toISOString();
  payload.economicsSha256 = await publicationHash({ price: payload.price, records: payload.contents,
    probabilityInputsSha256: payload.probabilityInputsSha256, valuationsSha256: payload.valuationsSha256,
    topChase: payload.topChase, evInputsSha256: payload.evInputsSha256, ev: payload.ev });
  payload.summaryProjection = publicPackSummaryCore(payload);
  const { snapshot, descriptor, batches } = await sealFixturePack(payload);
  return { inputs: inputsFromPayload(payload), built: { snapshot, descriptor, batches } };
}
