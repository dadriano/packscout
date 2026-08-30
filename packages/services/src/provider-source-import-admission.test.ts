import assert from "node:assert/strict";
import test from "node:test";
import {
  CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  providerSourceIntegrationCapability,
  ProviderSourceIntegrationCapabilityRegistry,
} from
  "./provider-source-integration-capability.ts";
import { ProviderSourceImportAdmissionService } from
  "./provider-source-import-admission.ts";
import { ProviderSourceImportRequestError } from
  "./provider-source-import-request-service.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const configVersionId = "00000000-0000-4000-8000-000000000021";
const runId = "00000000-0000-4000-8000-000000000030";
const now = new Date("2026-08-29T12:00:00.000Z");
const request = {
  actor: {
    operatorId: "00000000-0000-4000-8000-000000000001",
    organizationId,
    role: "data_operator" as const,
  },
  providerId,
  expectedSourceRevisionId: configVersionId,
};

function ready(adapterKey = CLUTCHPACKS_CAPTURE_ADAPTER_KEY) {
  return {
    kind: "ready" as const,
    providerId,
    providerKey: "clutchpacks",
    adapterKey,
    configVersionId,
    configVersionNumber: 1n,
    configuration: { captureDirectory: "clutchpacks" },
    configExpiresAt: null,
    scheduleSeconds: 300,
  };
}

function service(input: Readonly<{
  admission: ReturnType<typeof ready> | Readonly<{
    kind: "not_found" | "source_unavailable";
  }> | Readonly<{
    kind: "revision_conflict";
    activeConfigVersionId: string;
  }>;
  installed?: boolean;
  delegateCalls: { count: number };
}>) {
  return new ProviderSourceImportAdmissionService({
    providers: {
      async resolveImportAdmission(observed) {
        assert.deepEqual(observed, {
          organizationId,
          providerId,
          expectedConfigVersionId: configVersionId,
          now,
        });
        return input.admission;
      },
    },
    sourceIntegrations: new ProviderSourceIntegrationCapabilityRegistry(
      input.installed === false
        ? []
        : [providerSourceIntegrationCapability(
            "clutchpacks",
            CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
          )],
    ),
    delegate: {
      async requestManual(received) {
        input.delegateCalls.count += 1;
        assert.deepEqual(received, {
          ...request,
          authority: {
            providerKey: "clutchpacks",
            adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
            configVersionId,
            configVersionNumber: 1n,
            configuration: { captureDirectory: "clutchpacks" },
            configExpiresAt: null,
            scheduleSeconds: 300,
          },
        });
        return {
          run: {
            id: runId,
            organizationId,
            providerId,
            sourceInstanceId: providerId,
            sourceRevisionId: configVersionId,
            trigger: "manual" as const,
            state: "queued" as const,
            requestedCursorFingerprint: null,
            createdAt: now,
          },
          coalesced: false,
        };
      },
    },
    clock: { now: () => now },
  });
}

test("installed ClutchPacks admission delegates only after central ownership resolves", async () => {
  const delegateCalls = { count: 0 };
  const result = await service({
    admission: ready(),
    delegateCalls,
  }).requestManual(request);

  assert.equal(result.run.id, runId);
  assert.equal(delegateCalls.count, 1);
});

test("uninstalled provider integration fails before any provider-local mutation", async () => {
  const delegateCalls = { count: 0 };
  await assert.rejects(
    service({
      admission: ready(),
      installed: false,
      delegateCalls,
    }).requestManual(request),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSourceImportRequestError);
      assert.equal(error.code, "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE");
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(delegateCalls.count, 0);
});

test("central tenant, lifecycle, and revision failures also stop before mutation", async () => {
  for (const [admission, code] of [
    [{ kind: "not_found" as const }, "PROVIDER_NOT_FOUND"],
    [{ kind: "source_unavailable" as const }, "SOURCE_NOT_IMPORTABLE"],
    [{
      kind: "revision_conflict" as const,
      activeConfigVersionId:
        "00000000-0000-4000-8000-000000000099",
    }, "SOURCE_REVISION_CONFLICT"],
  ] as const) {
    const delegateCalls = { count: 0 };
    await assert.rejects(
      service({ admission, delegateCalls }).requestManual(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderSourceImportRequestError);
        assert.equal(error.code, code);
        return true;
      },
    );
    assert.equal(delegateCalls.count, 0);
  }
});
