import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PinnedProviderReleaseInputs } from "@packscout/database";
import {
  ProviderPromotionBootstrapService,
  readProviderPromotionBootstrapCredentials,
} from "./promotion-job-provider-bootstrap.ts";

const providerA = "a7000000-0000-4000-8000-000000000001";
const providerB = "17000000-0000-4000-8000-000000000002";
const token = Buffer.alloc(32, 7);
const tokenBase64 = token.toString("base64");
const tokenSha256 = createHash("sha256").update(token).digest("hex");

function pin(): PinnedProviderReleaseInputs {
  return {
    providerId: providerA,
    providerKey: "courtyard",
    providerConfigVersionId: "17000000-0000-4000-8000-000000000003",
    providerConfigExpiresAt: new Date("2026-09-01T13:00:00.000Z"),
    staleAfterSeconds: 900,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId: "17000000-0000-4000-8000-000000000004",
    catalogSchemaVersion: "catalog-v1",
    catalogContentHash: "1".repeat(64),
    catalogThroughChangeSequence: 41n,
    catalogCategories: [],
    catalogCollectibles: [],
    catalogAliases: [],
    catalogArtifactVerificationHash: "2".repeat(64),
    correlationEventSequence: 42n,
    correlationSnapshotHash: "3".repeat(64),
    categoryCorrelations: [{
      localCategoryId: "17000000-0000-4000-8000-000000000005",
      localEntityVersion: 8n,
      publicCategoryId: "17000000-0000-5000-8000-000000000006",
    }],
    collectibleCorrelations: [],
    publicProfileVersionId: "17000000-0000-4000-8000-000000000007",
    publicProfileHash: "4".repeat(64),
    publicProvider: {
      publicVendorId: "17000000-0000-5000-8000-000000000008",
      vendorKey: "courtyard",
      displayName: "Courtyard",
      logoUrl: null,
      websiteUrl: "https://courtyard.example",
      listingHosts: ["courtyard.example"],
      imageOrigins: [],
      referralParameters: [],
      publicPromo: null,
    },
  };
}

function credentials(value = JSON.stringify({ [providerA]: tokenSha256 })) {
  return readProviderPromotionBootstrapCredentials(value)!;
}

test("bootstrap credential configuration is provider-scoped and digest-only", () => {
  assert.equal(
    credentials().tokenSha256ByProviderId.get(providerA),
    tokenSha256,
  );
  assert.equal(readProviderPromotionBootstrapCredentials(undefined), null);
  for (const value of [
    "{}",
    JSON.stringify({ not_a_provider: tokenSha256 }),
    JSON.stringify({ [providerA]: "secret" }),
    JSON.stringify({
      [providerA]: tokenSha256,
      [providerA.toUpperCase()]: "a".repeat(64),
    }),
    JSON.stringify({
      [providerA]: tokenSha256,
      [providerB]: tokenSha256,
    }),
  ]) assert.throws(
    () => readProviderPromotionBootstrapCredentials(value),
    TypeError,
  );
});

test("bootstrap authorizes one provider before reading its central pin", async () => {
  let reads = 0;
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        reads += 1;
        return pin();
      },
    },
  });
  const result = await service.load({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
  });
  assert.equal(reads, 1);
  assert.deepEqual([
    result.pin.catalogThroughChangeSequence,
    result.pin.correlationEventSequence,
    result.pin.categoryCorrelations[0]?.localEntityVersion,
    result.pin.providerConfigExpiresAt,
  ], ["41", "42", "8", "2026-09-01T13:00:00.000Z"]);

  for (const attempt of [
    { providerId: providerB, bearerTokenBase64: tokenBase64 },
    { providerId: providerA, bearerTokenBase64: Buffer.alloc(32, 8).toString("base64") },
    { providerId: providerA, bearerTokenBase64: "not-base64" },
  ]) await assert.rejects(service.load(attempt), {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED",
    message: "Provider promotion bootstrap failed.",
  });
  assert.equal(reads, 1);
});

test("bootstrap rejects a repository response for another provider", async () => {
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        return { ...pin(), providerId: providerB };
      },
    },
  });
  await assert.rejects(service.load({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
  }), {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
  });
});
