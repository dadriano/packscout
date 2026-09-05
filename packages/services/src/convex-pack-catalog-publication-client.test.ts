import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  PACK_CATALOG_OPERATION_PATHS,
  PACK_CATALOG_V1,
  PRODUCTION_AUTH_HEADER_NAMES,
  packCatalogCanonicalJson,
  packCatalogKeyAuthoritySha256,
  packCatalogReceiptDigest,
  packSnapshotHeaderFromPayload,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  type PackCatalogPublicationReceipt,
  type PackCatalogPublicationRequest,
  type ProductionPublicationPath,
} from "@packscout/contracts";
import { createPackCatalogV1Fixture } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import {
  ConvexPublicPackPublicationClient,
  ConvexPublicProfilePublicationClient,
  SignedConvexPackCatalogPublicationClient,
} from "./convex-pack-catalog-publication-client.ts";
import { PublicationClientError } from "./convex-publication-http-client.ts";

const KEY_ID = "pack-provider-alpha-v1";
const SECRET = new Uint8Array(32).fill(7);
const PROVIDER_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-03T18:00:00.000Z");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A fake store: verifies the request signature, answers with a signed receipt. */
function fakeStore(options: { tamper?: (receipt: Record<string, unknown>) => Record<string, unknown>; keepDigest?: boolean; error?: { status: number; code: string } } = {}) {
  const seen: Array<{ path: string; body: string }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = String(init?.body);
    const headers = new Headers(init?.headers);
    seen.push({ path: url.pathname, body });
    const expectedSignature = createHmac("sha256", SECRET).update(productionPublicationRequestSigningValue({
      method: "POST",
      path: url.pathname as ProductionPublicationPath,
      bodyDigest: sha256(body),
      timestamp: headers.get(PRODUCTION_AUTH_HEADER_NAMES.timestamp)!,
      nonce: headers.get(PRODUCTION_AUTH_HEADER_NAMES.nonce)!,
    })).digest("hex");
    assert.equal(headers.get(PRODUCTION_AUTH_HEADER_NAMES.signature), expectedSignature);
    assert.equal(headers.get(PRODUCTION_AUTH_HEADER_NAMES.contentSha256), sha256(body));
    if (options.error) {
      return new Response(JSON.stringify({ error: "refused", code: options.error.code }), { status: options.error.status, headers: { "content-type": "application/json" } });
    }
    const request = JSON.parse(body) as PackCatalogPublicationRequest;
    let receipt: Record<string, unknown> = {
      schemaVersion: PACK_CATALOG_V1, operationKind: request.operationKind, operationId: request.operationId,
      idempotencyKey: request.idempotencyKey, requestSha256: sha256(body),
      result: { outcome: "applied", state: "publishing", reasonCode: null },
      entity: { entityKind: "pack", publicRepackId: request.serviceIdentity.entity.entityKind === "pack" ? request.serviceIdentity.entity.publicRepackId : PROVIDER_ID },
      snapshotId: null, snapshotState: "staging", packHead: null, profileHead: null, statusOperation: null,
      completedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    if (options.tamper) receipt = options.tamper(receipt);
    if (options.keepDigest !== true) receipt = { ...receipt, receiptDigest: await packCatalogReceiptDigest(receipt) };
    const receiptDigest = await packCatalogReceiptDigest(receipt);
    const signature = createHmac("sha256", SECRET).update(productionPublicationReceiptSigningValue(receiptDigest)).digest("hex");
    return new Response(JSON.stringify({ ok: true, receipt, responseAuth: { signatureVersion: "v1", keyId: KEY_ID, receiptDigest, signature } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return { seen, fetch: fetchImplementation };
}

function client(store: ReturnType<typeof fakeStore>) {
  return new SignedConvexPackCatalogPublicationClient({
    baseUrl: "https://store.convex.test/",
    keyId: KEY_ID,
    secret: SECRET,
    fetch: store.fetch,
    now: () => NOW,
    nonce: () => "nonce0000000000000001",
  });
}

test("Atomic store and six-journey catalog contract: signed publication client", async (context) => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(17));
  const pack = fixture.packs.packA;
  const authority = { environment: "local" as const, organizationId: ORGANIZATION_ID, scope: { scopeKind: "provider" as const, providerId: PROVIDER_ID } };
  const operation = {
    operationId: "90000000-0000-4000-8000-000000000002",
    idempotencyKey: "start:1",
    serviceIdentity: {
      serviceIdentityId: "90000000-0000-4000-8000-000000000001",
      environment: "local" as const,
      organizationId: ORGANIZATION_ID,
      scope: authority.scope,
      entity: { entityKind: "pack" as const, publicRepackId: pack.snapshot.identity.publicRepackId },
      operations: ["activate_head", "finalize_snapshot", "read_receipt", "recover_pack", "stage_snapshot"] as const,
      issuedAt: "2026-09-03T17:59:00.000Z",
      expiresAt: "2026-09-03T18:20:00.000Z",
      authorizationSha256: await packCatalogKeyAuthoritySha256(KEY_ID, authority),
    },
    requestedAt: "2026-09-03T18:00:00.000Z",
  };
  const startBody = {
    descriptor: pack.descriptor,
    header: packSnapshotHeaderFromPayload(pack.snapshot.payload).header,
    packPublicationSequence: "1",
    evidence: { providerId: PROVIDER_ID, publicRepackId: pack.snapshot.identity.publicRepackId, packPublicationSequence: "1", providerChangeIdentity: "provider-change:1", sourceRevisionIdentity: "source-revision:1", sharedDependencies: [] },
  };

  await context.test("sends canonical bytes to the operation's path and returns the bound receipt", async () => {
    const store = fakeStore();
    const packs = new ConvexPublicPackPublicationClient(client(store));
    const receipt: PackCatalogPublicationReceipt = await packs.startPublicPackSnapshot({ ...operation, serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations] } }, startBody);
    assert.equal(receipt.operationId, operation.operationId);
    assert.equal(receipt.result.outcome, "applied");
    assert.equal(store.seen.length, 1);
    assert.equal(store.seen[0]!.path, PACK_CATALOG_OPERATION_PATHS.start_pack_snapshot);
    assert.equal(store.seen[0]!.body, packCatalogCanonicalJson(JSON.parse(store.seen[0]!.body)));
    assert.equal(receipt.requestSha256, sha256(store.seen[0]!.body));
    const profiles = new ConvexPublicProfilePublicationClient(client(store));
    const profileReceipt = await profiles.finalizePublicProfileSnapshot({
      ...operation,
      serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations], entity: { entityKind: "provider_profile", providerId: PROVIDER_ID } },
    }, { profile: fixture.provider.profile.identity });
    assert.equal(profileReceipt.operationKind, "finalize_profile_snapshot");
    assert.equal(store.seen[1]!.path, PACK_CATALOG_OPERATION_PATHS.finalize_profile_snapshot);
  });

  await context.test("an invalid request never reaches the network", async () => {
    const store = fakeStore();
    const packs = new ConvexPublicPackPublicationClient(client(store));
    await assert.rejects(
      () => packs.startPublicPackSnapshot({ ...operation, operationId: "not-a-uuid", serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations] } }, startBody),
      (error: unknown) => error instanceof PublicationClientError && error.code === "PUBLICATION_REQUEST_INVALID" && error.disposition === "terminal",
    );
    assert.equal(store.seen.length, 0);
  });

  await context.test("a receipt for a different operation or a forged digest is ambiguous, never accepted", async () => {
    const swapped = fakeStore({ tamper: (receipt) => ({ ...receipt, operationId: "90000000-0000-4000-8000-0000000000ff" }) });
    const packs = new ConvexPublicPackPublicationClient(client(swapped));
    await assert.rejects(
      () => packs.startPublicPackSnapshot({ ...operation, serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations] } }, startBody),
      (error: unknown) => error instanceof PublicationClientError && error.code === "PUBLICATION_RESPONSE_INVALID" && error.ambiguous,
    );
    const forged = fakeStore({ tamper: (receipt) => ({ ...receipt, receiptDigest: "0".repeat(64) }), keepDigest: true });
    await assert.rejects(
      () => new ConvexPublicPackPublicationClient(client(forged)).startPublicPackSnapshot({ ...operation, serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations] } }, startBody),
      (error: unknown) => error instanceof PublicationClientError && error.ambiguous,
    );
  });

  await context.test("store refusals surface their stable code and classification", async () => {
    const forbidden = fakeStore({ error: { status: 403, code: "PACK_CATALOG_AUTH_FORBIDDEN" } });
    await assert.rejects(
      () => new ConvexPublicPackPublicationClient(client(forbidden)).startPublicPackSnapshot({ ...operation, serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations] } }, startBody),
      (error: unknown) => error instanceof PublicationClientError && error.code === "PACK_CATALOG_AUTH_FORBIDDEN" && error.disposition === "terminal",
    );
    const internal = fakeStore({ error: { status: 500, code: "PACK_CATALOG_INTERNAL_ERROR" } });
    await assert.rejects(
      () => new ConvexPublicPackPublicationClient(client(internal)).startPublicPackSnapshot({ ...operation, serviceIdentity: { ...operation.serviceIdentity, operations: [...operation.serviceIdentity.operations] } }, startBody),
      (error: unknown) => error instanceof PublicationClientError && error.code === "PACK_CATALOG_INTERNAL_ERROR" && error.disposition === "retryable",
    );
  });
});
