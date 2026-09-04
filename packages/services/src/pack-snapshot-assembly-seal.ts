import {
  PACK_SNAPSHOT_BATCH_MAX_BYTES, PACK_SNAPSHOT_BATCH_MAX_ITEMS, PACK_SNAPSHOT_HASH_DOMAIN,
  assertPublicPackCatalogBytes, derivePublicPackSnapshotId, hashPackCatalogValue,
  normalizePublicPackSnapshotPayload, packCatalogCanonicalByteCount, packCatalogCanonicalJson, packSnapshotHeaderFromPayload,
  publicPackSnapshotBatchSchema, publicPackSnapshotDescriptorSchema, publicPackSnapshotIdentitySchema,
  publicPackSnapshotSchema, type PublicPackSnapshotBatch,
} from "@packscout/contracts";
import { packSnapshotAssemblyLimits as limits, requireAssembly } from "./pack-snapshot-assembly-types.ts";

const hash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);

/** Validates complete domain evidence and seals one fixed canonical partition.
 * The same verification also proves supplied lifecycle baselines. */
export async function sealPackAssembly(payloadInput: unknown) {
  const payload = normalizePublicPackSnapshotPayload(payloadInput);
  assertPublicPackCatalogBytes(payload);
  const { contents, ...header } = payload;
  const probabilityInputsSha256 = await hash(contents.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros })));
  const valuationsSha256 = await hash(contents.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation })));
  const evInputsSha256 = await hash({ price: payload.price, probabilityInputsSha256, valuationsSha256,
    evMethodIdentity: payload.evMethodIdentity, evPolicyIdentity: payload.evPolicyIdentity });
  const economicsSha256 = await hash({ price: payload.price, records: contents, probabilityInputsSha256,
    valuationsSha256, topChase: payload.topChase, evInputsSha256, ev: payload.ev });
  requireAssembly(payload.probabilityInputsSha256 === probabilityInputsSha256 && payload.valuationsSha256 === valuationsSha256 &&
    payload.evInputsSha256 === evInputsSha256 && payload.economicsSha256 === economicsSha256);
  // The public store derives dependency vectors from batches; canonical hashing still uses the complete header.
  requireAssembly(packCatalogCanonicalByteCount(packSnapshotHeaderFromPayload(payload).header) <= limits.maximumDocumentBytes);
  const canonicalBytes = packCatalogCanonicalJson(payload);
  requireAssembly(new TextEncoder().encode(canonicalBytes).byteLength <= limits.maximumSnapshotBytes);

  const proofs: Array<Omit<PublicPackSnapshotBatch, "publicPackSnapshotId">> = [];
  const body = (records: typeof contents, batchIndex: number) => ({ kind: "contents_batch",
    providerId: payload.providerId, publicRepackId: payload.publicRepackId, batchIndex, records });
  let records: typeof contents = [];
  let byteCount = packCatalogCanonicalByteCount(body([], 0));
  async function flush() {
    requireAssembly(proofs.length < limits.maximumBatches && records.length > 0);
    const batchIndex = proofs.length;
    proofs.push({ batchIndex, records, recordCount: records.length, byteCount, batchSha256: await hash(body(records, batchIndex)) });
    records = [];
    byteCount = packCatalogCanonicalByteCount(body([], proofs.length));
  }
  for (const row of contents) {
    const bytes = packCatalogCanonicalByteCount(row);
    if (records.length === PACK_SNAPSHOT_BATCH_MAX_ITEMS || (records.length > 0 && byteCount + bytes + 1 > PACK_SNAPSHOT_BATCH_MAX_BYTES)) await flush();
    requireAssembly(byteCount + bytes + (records.length ? 1 : 0) <= PACK_SNAPSHOT_BATCH_MAX_BYTES);
    byteCount += bytes + (records.length ? 1 : 0);
    records.push(row);
  }
  if (records.length) await flush();
  requireAssembly(packCatalogCanonicalByteCount(header) + proofs.reduce((total, proof) => total + proof.byteCount, 0) <= limits.maximumSnapshotBytes);
  const contentSha256 = await hash({ kind: "complete_pack", header,
    batches: proofs.map(({ batchIndex, recordCount, byteCount, batchSha256 }) => ({ batchIndex, recordCount, byteCount, batchSha256 })) });
  const identity = publicPackSnapshotIdentitySchema.parse({ providerId: payload.providerId, publicRepackId: payload.publicRepackId,
    publicPackSnapshotId: derivePublicPackSnapshotId(contentSha256), contentSha256,
    summarySha256: await hash(payload.summaryProjection), dataAsOf: payload.dataAsOf,
    evMethodIdentity: payload.evMethodIdentity, evPolicyIdentity: payload.evPolicyIdentity });
  const batches = proofs.map(proof => publicPackSnapshotBatchSchema.parse({ publicPackSnapshotId: identity.publicPackSnapshotId, ...proof }));
  const snapshot = await publicPackSnapshotSchema.parseAsync({ identity, payload });
  const descriptor = publicPackSnapshotDescriptorSchema.parse({ identity, lifecycle: payload.lifecycle,
    contentCount: payload.contentCount, valuationDependencyCount: payload.valuationDependencyIdentities.length,
    probabilityInputsSha256, valuationsSha256, evInputsSha256, economicsSha256, completionState: "complete",
    batches: batches.map(({ publicPackSnapshotId, batchIndex, recordCount, byteCount, batchSha256 }) => ({ publicPackSnapshotId, batchIndex, recordCount, byteCount, batchSha256 })),
  });
  requireAssembly(packCatalogCanonicalByteCount(descriptor) <= limits.maximumDocumentBytes &&
    packCatalogCanonicalByteCount(snapshot) <= limits.maximumSnapshotBytes);
  return { snapshot, descriptor, batches, canonicalBytes, payloadSha256: await hash(payload) };
}
