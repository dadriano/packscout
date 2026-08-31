import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaAdminProviderRuntimeRepository, PrismaProviderRuntimeRepository,
  type BoundedProviderDatabaseGateway, type ProviderPrismaClient,
} from "@packscout/database";
import { dataforrestClutchpacksDistributedSourceAdapterManifest } from "@packscout/contracts";
import { ProviderSourceImportRequestError } from "@packscout/services";
import { createRoutedProviderManualImportDelegate } from
  "./routed-provider-manual-import.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const configVersionId = "00000000-0000-4000-8000-000000000021";
const runId = "00000000-0000-4000-8000-000000000030";
const requestedAt = new Date("2026-08-29T12:00:00.000Z");

const request = {
  actor: {
    operatorId: "00000000-0000-4000-8000-000000000001",
    organizationId,
    role: "data_operator" as const,
  },
  providerId,
  expectedSourceRevisionId: configVersionId,
  authority: {
    providerKey: "clutchpacks",
    adapterKey: "local-capture-clutchpacks-v1",
    configVersionId,
    configVersionNumber: 1n,
    configuration: { captureDirectory: "clutchpacks" },
    configExpiresAt: null,
    scheduleSeconds: 300,
  },
};

test("routed manual delegate preserves the current run DTO over one provider route", async () => {
  let gatewayCalls = 0;
  const gateway = {
    async runWithAdminProviderDatabase(input: {
      organizationId: string;
      providerId: string;
    }) {
      gatewayCalls += 1;
      assert.deepEqual(input, { organizationId, providerId });
      return {
        state: "reachable" as const,
        providerId,
        observedAt: requestedAt.toISOString(),
        value: {
          kind: "created" as const,
          commandId: "00000000-0000-4000-8000-000000000031",
          correlationId: "00000000-0000-4000-8000-000000000032",
          run: {
            id: runId,
            trigger: "manual" as const,
            state: "queued" as const,
            requestedByOperatorId: request.actor.operatorId,
            configVersionId,
            configVersionNumber: 1n,
            workerFence: 0n,
            attemptNumber: 1,
            recoveryOfRunId: null,
            requestedCursorHash: null,
            finalCursorHash: null,
            reachedSourceHead: false,
            pageCount: 0,
            catalogCount: 0,
            pullCount: 0,
            marketEventCount: 0,
            acceptedCount: 0,
            duplicateCount: 0,
            quarantinedCount: 0,
            materialChangeCount: 0,
            failureCode: null,
            failureClass: null,
            requestedAt,
            startedAt: null,
            lastProgressAt: null,
            heartbeatAt: null,
            finishedAt: null,
          },
        },
      };
    },
  } as unknown as Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
  const delegate = createRoutedProviderManualImportDelegate({ gateway });

  assert.deepEqual(await delegate.requestManual(request), {
    run: {
      id: runId,
      organizationId,
      providerId,
      sourceInstanceId: providerId,
      sourceRevisionId: configVersionId,
      trigger: "manual",
      state: "queued",
      requestedCursorFingerprint: null,
      createdAt: requestedAt,
    },
    coalesced: false,
  });
  assert.equal(gatewayCalls, 1);
});

test("routed manual delegate exposes only a bounded unavailable failure", async () => {
  const gateway = {
    async runWithAdminProviderDatabase() {
      return {
        state: "unreachable" as const,
        providerId,
        failureCode: "database_unreachable" as const,
        observedAt: requestedAt.toISOString(),
        retryHint: "secret host must not escape",
      };
    },
  } as unknown as Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;

  await assert.rejects(
    createRoutedProviderManualImportDelegate({ gateway }).requestManual(request),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSourceImportRequestError);
      assert.equal(error.code, "PROVIDER_DATABASE_UNREACHABLE");
      assert.doesNotMatch(String(error), /secret host/u);
      return true;
    },
  );
});

test("routed queue uses the closed capture capability and never bootstraps live request settings", async (context) => {
  const queued: Array<Parameters<PrismaAdminProviderRuntimeRepository["requestRunNow"]>[0]> = [];
  context.mock.method(PrismaProviderRuntimeRepository.prototype, "synchronizeConfiguration", async () => ({
    kind: "updated", runtime: { generation: 2n },
  }));
  context.mock.method(PrismaAdminProviderRuntimeRepository.prototype, "requestRunNow", async (input: Parameters<PrismaAdminProviderRuntimeRepository["requestRunNow"]>[0]) => {
    queued.push(input);
    return { kind: "configuration_conflict" };
  });
  const gateway = {
    async runWithAdminProviderDatabase(_scope: unknown, operation: (database: ProviderPrismaClient) => Promise<unknown>) {
      return { state: "reachable", value: await operation({} as ProviderPrismaClient) };
    },
  } as unknown as Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  for (const [providerKey, adapterKey, policy] of [
    ["clutchpacks", request.authority.adapterKey, "unmanaged"],
    ["courtyard", request.authority.adapterKey, "required"],
    ["clutchpacks", dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion, "required"],
    ["clutchpacks", "unknown", "required"],
  ] as const) {
    await assert.rejects(createRoutedProviderManualImportDelegate({ gateway }).requestManual({
      ...request, authority: { ...request.authority, providerKey, adapterKey },
    }), (error: unknown) => error instanceof ProviderSourceImportRequestError && error.code === "SOURCE_REVISION_CONFLICT");
    assert.equal(queued.at(-1)?.requestSettingsPolicy, policy);
    assert.equal(Object.hasOwn(queued.at(-1)!, "requestSettingsDefault"), false);
  }
  assert.equal(queued.length, 4);
});
