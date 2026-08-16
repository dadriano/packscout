import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  productionPublicationReceiptSigningValue,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";

export const PROVIDER_TEST_KEY_ID = "publisher-v1";
export const PROVIDER_TEST_KEY_SECRET =
  "packscout-test-publication-secret-000000000001";
export const PROVIDER_BETA_TEST_KEY_ID = "publisher-beta-v1";
export const PROVIDER_BETA_TEST_KEY_SECRET =
  "packscout-test-publication-secret-000000000002";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(
  value: string,
  secret = PROVIDER_TEST_KEY_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  )));
}

export async function providerBodyDigest(bodyJson: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(bodyJson),
  )));
}

export async function providerRequestDigest(body: unknown): Promise<string> {
  return await providerBodyDigest(canonicalJson(body));
}

export async function signedProviderInit(
  path: string,
  body: unknown,
  input: Readonly<{
    bodyJson?: string;
    keyId?: string;
    nonce?: string;
    secret?: string;
    signature?: string;
    timestamp?: string;
  }> = {},
): Promise<RequestInit> {
  const bodyJson = input.bodyJson ?? canonicalJson(body);
  const bodyDigest = await providerBodyDigest(bodyJson);
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? "nonce0000000000000001";
  const keyId = input.keyId ?? PROVIDER_TEST_KEY_ID;
  const signingValue = [
    "v1",
    "POST",
    path,
    bodyDigest,
    timestamp,
    nonce,
  ].join("\n");
  return {
    method: "POST",
    body: bodyJson,
    headers: {
      "content-type": "application/json",
      "x-packscout-signature-version": "v1",
      "x-packscout-key-id": keyId,
      "x-packscout-timestamp": timestamp,
      "x-packscout-nonce": nonce,
      "x-packscout-content-sha256": bodyDigest,
      "x-packscout-signature": input.signature ??
        await hmacHex(signingValue, input.secret),
    },
  };
}

export async function signedProviderBytesInit(
  path: string,
  bodyBytes: Uint8Array,
  input: Readonly<{
    keyId?: string;
    nonce: string;
    secret?: string;
    timestamp?: string;
  }>,
): Promise<RequestInit> {
  const bytes = new Uint8Array(bodyBytes.byteLength);
  bytes.set(bodyBytes);
  const bodyDigest = bytesToHex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer,
  )));
  const timestamp = input.timestamp ?? String(Date.now());
  const keyId = input.keyId ?? PROVIDER_TEST_KEY_ID;
  const signingValue = [
    "v1",
    "POST",
    path,
    bodyDigest,
    timestamp,
    input.nonce,
  ].join("\n");
  return {
    method: "POST",
    body: bytes.buffer,
    headers: {
      "content-type": "application/json",
      "x-packscout-signature-version": "v1",
      "x-packscout-key-id": keyId,
      "x-packscout-timestamp": timestamp,
      "x-packscout-nonce": input.nonce,
      "x-packscout-content-sha256": bodyDigest,
      "x-packscout-signature": await hmacHex(signingValue, input.secret),
    },
  };
}

export async function verifyProviderResponseSignature(input: {
  responseAuth: {
    receiptDigest: string;
    signature: string;
  };
}, secret = PROVIDER_TEST_KEY_SECRET): Promise<boolean> {
  return input.responseAuth.signature === await hmacHex(
    productionPublicationReceiptSigningValue(
      input.responseAuth.receiptDigest,
    ),
    secret,
  );
}

export async function buildProviderPublishPlan(
  input: Readonly<{
    checkpointSequence?: string;
    dataAsOf?: string;
    platformKey?: string;
    publicChangeSequence?: string;
    settledAt?: string;
    vendorDisplayName?: string;
  }> = {},
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const fixture = buildMockDataReleaseV2();
  const vendor = {
    ...fixture.vendors[0]!,
    displayName: input.vendorDisplayName ?? fixture.vendors[0]!.displayName,
  };
  const records = [vendor];
  const byteCount = providerCatalogReleaseBatchByteCount(records);
  const batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
    kind: "vendors",
    records,
  });
  const batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
    previousHash: EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
    batchIndex: 0,
    kind: "vendors",
    batchHash,
    recordCount: records.length,
    byteCount,
  });
  const entityHashes = {} as Record<
    ProviderCatalogReleaseBatchKindV1,
    string
  >;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await initializeProviderCatalogReleaseEntityHashV1(
      kind,
    );
  }
  entityHashes.vendors = await extendProviderCatalogReleaseEntityHashV1({
    previousHash: entityHashes.vendors,
    kind: "vendors",
    batchHash,
    recordCount: records.length,
    byteCount,
  });
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const publicAssetOrigins: string[] = [];
  const checkpointSequence = input.checkpointSequence ?? "20";
  const platformKey = input.platformKey ?? "alpha";
  const dataAsOf = input.dataAsOf ?? "2026-08-15T11:58:00.000Z";
  const sharedConfigurationEpoch = {
    configurationKey: "catalog.v1",
    revision: 1,
    publicChangeSequence: input.publicChangeSequence ?? "10",
    configurationHash: HASH_A,
  };
  const counts = {
    vendors: 1 as const,
    categories: 0,
    collectibles: 0,
    repacks: 0,
    repackChases: 0,
    searchShards: 0,
  };
  const identity = {
    platformKey,
    sharedConfigurationEpoch,
    dataAsOf,
    contentHash,
    publicAssetOrigins,
    governingHashes: {
      providerConfigurationHash: HASH_B,
      sharedCategoriesHash: HASH_C,
      identityMappingsHash: HASH_D,
      originSetHash:
        await recomputeProviderCatalogReleaseOriginSetHashV1(
          publicAssetOrigins,
        ),
      confidencePolicyHash: HASH_A,
    },
    entityHashes,
    counts,
    searchAlgorithmVersion: "repack_search_v2" as const,
    providerSearchIndexHash:
      await recomputeProviderCatalogSearchIndexHashV1([]),
    batchCount: 1,
    batchChainHash,
  };
  const providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(identity);
  const publicProviderReleaseId =
    await derivePublicProviderReleaseIdV1(identity);
  const plan = {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish" as const,
    ...identity,
    publicProviderReleaseId,
    providerReleaseFingerprint,
    providerCheckpoint: {
      settledSequence: checkpointSequence,
      settledAt: input.settledAt ?? "2026-08-15T12:00:00.000Z",
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      platformKey,
      checkpointSequence,
    ),
    observation: {
      sourceHeadSequence: checkpointSequence,
      lastSuccessfulObservationAt: "2026-08-15T11:59:00.000Z",
      staleAt: "2026-08-15T12:14:00.000Z",
      freshness: "fresh" as const,
    },
    batches: [{
      batchIndex: 0,
      kind: "vendors" as const,
      batchHash,
      byteCount,
      records,
    }],
  };
  return await verifyProviderCatalogReleasePlanV1(plan) as
    ProviderCatalogReleasePublishPlanV1;
}

export function providerReleaseProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderReleaseImmutableProofV1 {
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

export function emptyProviderHead(
  platformKey: string,
): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey,
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
}

export function providerReleaseContext(
  plan: ProviderCatalogReleasePublishPlanV1,
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1,
) {
  return {
    release: providerReleaseProof(plan),
    providerCheckpoint: plan.providerCheckpoint,
    sourceWatermark: plan.sourceWatermark,
    observation: plan.observation,
    expectedCompletedHead,
  };
}

export function providerOperationEnvelope(
  operationId: string,
) {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
  };
}
