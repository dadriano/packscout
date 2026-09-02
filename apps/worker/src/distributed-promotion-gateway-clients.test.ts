import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderPromotionBootstrapGatewayClient,
} from "./distributed-promotion-gateway-clients.ts";

const providerId = "17000000-0000-4000-8000-000000000001";
const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: "https://promotion-gateway.example",
  bearerToken: new Uint8Array(32).fill(7),
  timeoutMilliseconds: 1_000,
  fetch,
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("provider bootstrap uses the provider-bound internal machine route", async () => {
  let observedUrl = "";
  let observedAuthorization = "";
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async (request, init) => {
      observedUrl = String(request);
      observedAuthorization = String(
        (init?.headers as Record<string, string>).authorization,
      );
      return jsonResponse({
        pin: {
          providerId,
          providerKey: "courtyard",
          providerConfigVersionId:
            "17000000-0000-4000-8000-000000000002",
          providerConfigExpiresAt: null,
          staleAfterSeconds: 900,
          centralSchemaVersion: "distributed-central-v1",
          catalogVersionId: "17000000-0000-4000-8000-000000000003",
          catalogSchemaVersion: "catalog-v1",
          catalogContentHash: "1".repeat(64),
          catalogThroughChangeSequence: "41",
          catalogCategories: [],
          catalogCollectibles: [],
          catalogAliases: [],
          catalogArtifactVerificationHash: "2".repeat(64),
          correlationEventSequence: "42",
          correlationSnapshotHash: "3".repeat(64),
          categoryCorrelations: [],
          collectibleCorrelations: [],
          publicProfileVersionId:
            "17000000-0000-4000-8000-000000000004",
          publicProfileHash: "4".repeat(64),
          publicProvider: {
            publicVendorId: "17000000-0000-5000-8000-000000000005",
            vendorKey: "courtyard",
            displayName: "Courtyard",
            logoUrl: null,
            websiteUrl: "https://courtyard.example",
            listingHosts: ["courtyard.example"],
            imageOrigins: [],
            referralParameters: [],
            publicPromo: null,
          },
        },
      });
    }) as typeof globalThis.fetch,
  ));
  const pin = await client.load(providerId);
  assert.equal(pin.providerId, providerId);
  assert.equal(pin.catalogThroughChangeSequence, 41n);
  assert.equal(
    observedUrl,
    "https://promotion-gateway.example/api/internal/promotion-jobs/provider-bootstrap",
  );
  assert.equal(
    observedAuthorization,
    `Bearer ${Buffer.from(new Uint8Array(32).fill(7)).toString("base64")}`,
  );
});

test("gateway refuses redirects and validates the complete response shape", async () => {
  let redirect: string | undefined;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async (_request, init) => {
      redirect = init?.redirect;
      return jsonResponse({ pin: { untrusted: true } });
    }) as typeof globalThis.fetch,
  ));
  await assert.rejects(client.load(providerId), {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
  });
  assert.equal(redirect, "error");
});

test("caller abort reaches the in-flight fetch without exposing its reason", async () => {
  let fetchSignal: AbortSignal | null = null;
  let fetchAborted = false;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    ((_request, init) => {
      fetchSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal!.addEventListener("abort", () => {
          fetchAborted = true;
          reject(new DOMException("secret caller reason", "AbortError"));
        }, { once: true });
      });
    }) as typeof globalThis.fetch,
  ));
  const controller = new AbortController();
  const pending = client.load(providerId, controller.signal);
  controller.abort(new Error("secret caller reason"));
  await assert.rejects(pending, {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED",
    message: "Distributed promotion gateway request was aborted.",
  });
  assert.ok(fetchSignal);
  assert.equal(fetchAborted, true);
});

test("gateway caps the streamed body before parsing JSON", async () => {
  const chunk = new Uint8Array(8 * 1_024 * 1_024 + 1);
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 })) as typeof globalThis.fetch,
  ));
  await assert.rejects(
    client.load(providerId),
    { code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID" },
  );
});
