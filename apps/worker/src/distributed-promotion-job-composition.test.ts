import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  CentralPrismaClient,
  PinnedProviderReleaseInputs,
  ProviderPrismaClient,
} from "@packscout/database";
import type {
  DistributedProviderReleasePublicationTransport,
  SignedConvexCatalogManifestPublicationClient,
  VerifiedManifestGateProofSource,
} from "@packscout/services";
import {
  readManifestReconciliationJobAuthorityConfiguration,
  readProviderPublicationJobAuthorityConfiguration,
} from "./distributed-promotion-authority-config.ts";
import { DistributedPromotionJobRuntime } from
  "./distributed-promotion-job-runtime.ts";
import { createManifestReconciliationJobRuntime } from
  "./manifest-reconciliation-job-runtime-composition.ts";
import { createProviderPromotionJobRuntime } from
  "./provider-promotion-job-runtime-composition.ts";

const providerId = "00000000-0000-4000-8000-000000000501";
const providerSecret = Buffer.alloc(32, 5).toString("base64");
const manifestSecret = Buffer.alloc(32, 7).toString("base64");
const base = new Date("2026-09-01T23:00:00.000Z");
const logger = { log() {} };
const manualCommands = {
  async verify(input: { protectedCommandIdentity: string }) {
    return {
      state: "verified" as const,
      deliveryIdentity: input.protectedCommandIdentity,
    };
  },
};

function providerAuthority() {
  return readProviderPublicationJobAuthorityConfiguration({
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_PROMOTION_PROVIDER_ID: providerId,
    PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: "provider.alpha.v1",
    PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64: providerSecret,
    PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "provider-alpha-v1",
  });
}

function manifestAuthority() {
  return readManifestReconciliationJobAuthorityConfiguration({
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_PROMOTION_MANIFEST_KEY_ID: "manifest.v1",
    PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64: manifestSecret,
    PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION: "manifest-v1",
  });
}

test("provider and manifest runtime compositions expose only their own authority", async () => {
  const transport = {
    async sendExact() {
      throw new Error("inert transport");
    },
    async status() {
      throw new Error("inert transport");
    },
  } as DistributedProviderReleasePublicationTransport;
  const provider = createProviderPromotionJobRuntime({
    authority: providerAuthority(),
    provider: {} as ProviderPrismaClient,
    pin: {
      providerId,
      providerKey: "alpha",
      providerConfigVersionId:
        "00000000-0000-4000-8000-000000000502",
    } as PinnedProviderReleaseInputs,
    workerId: "provider-promotion:alpha",
    logger,
    manualCommands,
    loadPin: async () => ({
      providerId,
      providerKey: "alpha",
      providerConfigVersionId:
        "00000000-0000-4000-8000-000000000502",
    } as PinnedProviderReleaseInputs),
    transport,
    now: () => base,
  });
  assert.ok(provider.runtime instanceof DistributedPromotionJobRuntime);
  await assert.rejects(provider.immediateDelivery.request({
    authority: "provider_publication",
    cause: "canonical_settlement",
    scopeId: "00000000-0000-4000-8000-000000000599",
    sourceGeneration: 1n,
    sourceEvidenceDigest: "a".repeat(64),
    requestedAt: base,
  }), /scope is invalid/u);

  const proofs: VerifiedManifestGateProofSource = {
    async resolveTarget() {
      return { state: "blocked", failureCode: "TEST_ONLY" };
    },
    async resolveSignedState() {
      return { state: "blocked", failureCode: "TEST_ONLY" };
    },
  };
  const manifest = createManifestReconciliationJobRuntime({
    authority: manifestAuthority(),
    central: {} as CentralPrismaClient,
    proofs,
    currentManifestClient:
      {} as SignedConvexCatalogManifestPublicationClient,
    workerId: "manifest-reconciliation:central",
    logger,
    manualCommands,
    now: () => base,
  });
  assert.ok(manifest.runtime instanceof DistributedPromotionJobRuntime);
  await assert.rejects(manifest.immediateDelivery.request({
    authority: "manifest_reconciliation",
    cause: "provider_completion",
    scopeId: "caller-selected-provider-key",
    sourceGeneration: 1n,
    sourceEvidenceDigest: "b".repeat(64),
    requestedAt: base,
  }), /scope is invalid/u);
});

test("resident provider runtime reloads and revalidates bootstrap every invocation", async () => {
  const initialPin = {
    providerId,
    providerKey: "alpha",
    providerConfigVersionId: "00000000-0000-4000-8000-000000000502",
  } as PinnedProviderReleaseInputs;
  let loads = 0;
  const composed = createProviderPromotionJobRuntime({
    authority: providerAuthority(),
    provider: {} as ProviderPrismaClient,
    pin: initialPin,
    async loadPin() {
      loads += 1;
      return { ...initialPin, providerKey: "cross-provider" };
    },
    workerId: "provider-promotion:alpha",
    logger,
    manualCommands,
    transport: {
      async sendExact() { throw new Error("unexpected transport"); },
      async status() { throw new Error("unexpected transport"); },
    } as DistributedProviderReleasePublicationTransport,
    now: () => base,
  });

  assert.equal((await composed.runtime.runManual("command:1")).state, "failed");
  assert.equal((await composed.runtime.runManual("command:2")).state, "failed");
  assert.equal(loads, 2);
});

test("resident provider publication continues from its verified pin during a central outage", async () => {
  const initialPin = {
    providerId,
    providerKey: "alpha",
    providerConfigVersionId: "00000000-0000-4000-8000-000000000502",
  } as PinnedProviderReleaseInputs;
  const composed = createProviderPromotionJobRuntime({
    authority: providerAuthority(),
    provider: {
      $transaction() {
        throw Object.assign(new Error("provider boundary reached"), {
          code: "CACHED_PIN_REACHED",
        });
      },
    } as unknown as ProviderPrismaClient,
    pin: initialPin,
    async loadPin() {
      throw Object.assign(new Error("central is unavailable"), {
        code: "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE",
      });
    },
    workerId: "provider-promotion:alpha",
    logger,
    manualCommands,
    transport: {
      async sendExact() { throw new Error("unexpected transport"); },
      async status() { throw new Error("unexpected transport"); },
    } as DistributedProviderReleasePublicationTransport,
    now: () => base,
  });

  const result = await composed.runtime.runManual("command:outage");
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "CACHED_PIN_REACHED");
});

test("resident provider refuses an authoritative malformed bootstrap response", async () => {
  const initialPin = {
    providerId,
    providerKey: "alpha",
    providerConfigVersionId: "00000000-0000-4000-8000-000000000502",
  } as PinnedProviderReleaseInputs;
  const composed = createProviderPromotionJobRuntime({
    authority: providerAuthority(),
    provider: {
      $transaction() {
        throw Object.assign(new Error("must not reach provider"), {
          code: "PROVIDER_REACHED_UNEXPECTEDLY",
        });
      },
    } as unknown as ProviderPrismaClient,
    pin: initialPin,
    async loadPin() {
      throw Object.assign(new Error("invalid response"), {
        code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
      });
    },
    workerId: "provider-promotion:alpha",
    logger,
    manualCommands,
    transport: {
      async sendExact() { throw new Error("unexpected transport"); },
      async status() { throw new Error("unexpected transport"); },
    } as DistributedProviderReleasePublicationTransport,
    now: () => base,
  });

  const result = await composed.runtime.runManual("command:malformed");
  assert.equal(result.state, "failed");
  assert.equal(
    result.failureCode,
    "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
  );
});

test("split production compositions have no legacy composite or cross-role client", async () => {
  const [providerSource, manifestSource, providerMain, manifestMain, workerPackage]
    = await Promise.all([
    readFile(new URL(
      "./provider-promotion-job-runtime-composition.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "./manifest-reconciliation-job-runtime-composition.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("./provider-promotion-job-main.ts", import.meta.url),
      "utf8"),
    readFile(new URL("./manifest-reconciliation-job-main.ts", import.meta.url),
      "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const both = `${providerSource}\n${manifestSource}\n${providerMain}\n${manifestMain}`;
  assert.doesNotMatch(both,
    /production-worker-composition|PackscoutPrismaClient|PACKSCOUT_DATABASE_URL/u);
  assert.doesNotMatch(providerSource,
    /CentralPrismaClient|ManifestReconciliation|manifestClearCredential/u);
  assert.doesNotMatch(manifestSource,
    /ProviderPrismaClient|SignedConvexProviderRelease|providerCredentials/u);
  assert.doesNotMatch(both, /FIXED_PROVIDER|enabledPlatformKeys:\s*\[/u);
  assert.doesNotMatch(providerMain,
    /createCentralDatabaseLifecycle|VerifiedManifestGateProof/u);
  assert.doesNotMatch(manifestMain,
    /createProviderDatabaseLifecycle|ProviderPromotionBootstrap/u);
  const scripts = (JSON.parse(workerPackage) as {
    scripts: Record<string, string>;
  }).scripts;
  assert.equal(
    scripts["start:provider-promotion-job:production"],
    "NODE_ENV=production PACKSCOUT_PROMOTION_RUN_MODE=daemon tsx src/provider-promotion-job-main.ts",
  );
  assert.equal(
    scripts["start:manifest-reconciliation-job:production"],
    "NODE_ENV=production PACKSCOUT_PROMOTION_RUN_MODE=daemon tsx src/manifest-reconciliation-job-main.ts",
  );
  for (const role of ["provider-promotion", "manifest-reconciliation"]) {
    for (const mode of ["once", "manual", "continuation"]) {
      for (const scope of ["local", "production"]) {
        assert.ok(scripts[`run:${role}-job-${mode}:${scope}`]);
      }
    }
  }
});
