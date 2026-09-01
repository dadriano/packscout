import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
} from "@packscout/contracts";
import type { ProviderPrismaClient } from "@packscout/database";
import {
  ProviderManualImportExecutor,
  ProviderManualImportPageSourceRouter,
  createProviderManualImportExecutor,
  providerManualImportRequestSettingsPolicy,
  type ProviderManualImportPageSource,
} from "./provider-manual-import-executor.ts";
import { ProviderCaptureSourceError } from
  "./provider-capture-source-contract.ts";
import { ProviderCaptureMixedPageSource } from "./provider-capture-mixed-page-source.ts";
import { CLUTCHPACKS_CAPTURE_ADAPTER_KEY } from "@packscout/services";

function source(
  adapterKey: string,
  marker: string,
  installedProviderKey = "clutchpacks",
): ProviderManualImportPageSource {
  return {
    supports(candidate, providerKey) {
      return candidate === adapterKey && providerKey === installedProviderKey;
    },
    nextPage() {
      return Promise.resolve({ marker });
    },
  };
}

function request(adapterKey: unknown, providerKey = "clutchpacks") {
  return {
    authority: {
      providerId: "11111111-1111-4111-8111-111111111111",
      providerKey,
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

test("request settings capability stays explicit and routes only one protected capture source", () => {
  const capture = new ProviderCaptureMixedPageSource({
    captureRoot: "/tmp/packscout-capture-capability-only",
    actorHmacKey: Buffer.alloc(32, 0x5a),
  });
  const live = source(DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION, "live");
  const router = new ProviderManualImportPageSourceRouter([capture, live]);
  assert.equal(router.requestSettingsPolicy(CLUTCHPACKS_CAPTURE_ADAPTER_KEY, "clutchpacks"), "unmanaged");
  assert.equal(router.requestSettingsPolicy(DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION, "clutchpacks"), "required");
  assert.equal(router.requestSettingsPolicy(CLUTCHPACKS_CAPTURE_ADAPTER_KEY, "courtyard"), "required");
  assert.equal(router.requestSettingsPolicy("missing", "clutchpacks"), "required");
  assert.equal(new ProviderManualImportPageSourceRouter([capture, capture])
    .requestSettingsPolicy(CLUTCHPACKS_CAPTURE_ADAPTER_KEY, "clutchpacks"), "required");
  assert.equal(providerManualImportRequestSettingsPolicy(source("unclassified", "custom"), "unclassified", "clutchpacks"), "required");
  const incorrectlyUnmanagedLive = { ...live, requestSettingsPolicy: () => "unmanaged" as const };
  assert.equal(providerManualImportRequestSettingsPolicy(incorrectlyUnmanagedLive,
    DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION, "clutchpacks"), "required");
});

test("manual import source router keeps ClutchPacks and Courtyard on exact independent tuples", async () => {
  const router = new ProviderManualImportPageSourceRouter([
    source(
      DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
      "clutchpacks",
      "clutchpacks",
    ),
    source(
      DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
      "courtyard",
      "courtyard",
    ),
  ]);
  assert.deepEqual(await router.nextPage(request(
    DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    "clutchpacks",
  )), { marker: "clutchpacks" });
  assert.deepEqual(await router.nextPage(request(
    DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
    "courtyard",
  )), { marker: "courtyard" });
  for (const [providerKey, adapterKey] of [
    ["courtyard", DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION],
    ["clutchpacks", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION],
    ["collector_crypt", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION],
    ["phygitals", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION],
  ] as const) {
    assert.equal(router.supports(adapterKey, providerKey), false);
    assert.throws(
      () => router.nextPage(request(adapterKey, providerKey)),
      (error: unknown) => error instanceof ProviderCaptureSourceError
        && error.code === "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
    );
  }
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
  const executor = createProviderManualImportExecutor({
    database: {} as ProviderPrismaClient,
    captureRoot: null,
    actorHmacKey: null,
    workerId: "fixture:live-worker",
    liveSource: source("live-v3", "live"),
  });
  assert.equal(executor instanceof ProviderManualImportExecutor, true);

  assert.throws(
    () => createProviderManualImportExecutor({
      database: {} as ProviderPrismaClient,
      captureRoot: null,
      actorHmacKey: null,
      workerId: "fixture:capture-worker",
    }),
    /Capture imports require a capture root/u,
  );
});
