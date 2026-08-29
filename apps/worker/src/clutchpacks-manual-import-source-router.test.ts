import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPrismaClient } from "@packscout/database";
import {
  ClutchpacksManualImportExecutor,
  ProviderManualImportPageSourceRouter,
  createClutchpacksManualImportExecutor,
  type ProviderManualImportPageSource,
} from "./clutchpacks-manual-import-executor.ts";
import { ProviderCaptureSourceError } from
  "./provider-capture-source-contract.ts";

function source(adapterKey: string, marker: string): ProviderManualImportPageSource {
  return {
    supports(candidate, providerKey) {
      return candidate === adapterKey && providerKey === "clutchpacks";
    },
    nextPage() {
      return Promise.resolve({ marker });
    },
  };
}

function request(adapterKey: unknown) {
  return {
    authority: {
      providerId: "11111111-1111-4111-8111-111111111111",
      providerKey: "clutchpacks",
      configVersionId: "22222222-2222-4222-8222-222222222222",
      configVersionNumber: 1n,
      configuration: { adapterKey },
    },
    runId: "33333333-3333-4333-8333-333333333333",
    workerFence: 1n,
    pageNumber: 1,
    sourceCheckpoint: null,
    sourceCheckpointFingerprint: null,
    signal: new AbortController().signal,
  };
}

test("manual import source router dispatches exactly one installed adapter", async () => {
  const router = new ProviderManualImportPageSourceRouter([
    source("capture-v1", "capture"),
    source("live-v3", "live"),
  ]);
  assert.equal(router.supports("live-v3", "clutchpacks"), true);
  assert.deepEqual(await router.nextPage(request("live-v3")), {
    marker: "live",
  });
});

test("manual import source router fails closed for missing or duplicate authority", async () => {
  const duplicate = new ProviderManualImportPageSourceRouter([
    source("live-v3", "first"),
    source("live-v3", "second"),
  ]);
  assert.equal(duplicate.supports("live-v3", "clutchpacks"), false);
  assert.throws(
    () => duplicate.nextPage(request("live-v3")),
    (error: unknown) => error instanceof ProviderCaptureSourceError
      && error.code === "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
  );
  const missing = new ProviderManualImportPageSourceRouter([
    source("capture-v1", "capture"),
  ]);
  assert.throws(
    () => missing.nextPage(request(null)),
    (error: unknown) => error instanceof ProviderCaptureSourceError
      && error.code === "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
  );
});

test("live executor construction does not require capture-only configuration", () => {
  const executor = createClutchpacksManualImportExecutor({
    database: {} as ProviderPrismaClient,
    captureRoot: null,
    actorHmacKey: null,
    workerId: "fixture:live-worker",
    liveSource: source("live-v3", "live"),
  });
  assert.equal(executor instanceof ClutchpacksManualImportExecutor, true);

  assert.throws(
    () => createClutchpacksManualImportExecutor({
      database: {} as ProviderPrismaClient,
      captureRoot: null,
      actorHmacKey: null,
      workerId: "fixture:capture-worker",
    }),
    /Capture imports require a capture root/u,
  );
});
