import assert from "node:assert/strict";
import test from "node:test";
import type { CentralQueryClient } from "@packscout/database";
import {
  ProviderSourceImportRequestError,
  ProviderSourceIntegrationCapabilityRegistry,
} from "@packscout/services";
import { createAdminManualImportAdmissionRuntime } from
  "./import-operations-runtime.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const revisionId = "00000000-0000-4000-8000-000000000021";
const now = new Date("2026-08-29T12:00:00.000Z");

function central(): CentralQueryClient {
  return {
    providers: {
      async findUnique() {
        return {
          id: providerId,
          provider_key: "clutchpacks",
          lifecycle: "active",
          active_config_version_id: revisionId,
          active_config_version: {
            id: revisionId,
            version_number: 1n,
            adapter_key: "clutchpacks-capture-v1",
            expires_at: null,
          },
        };
      },
    },
  } as unknown as CentralQueryClient;
}

test("current-admin Run now runtime cannot reach provider writes for an uninstalled adapter", async () => {
  const providerWrites = { count: 0 };
  const manualImports = createAdminManualImportAdmissionRuntime({
    central: central(),
    sourceIntegrations: new ProviderSourceIntegrationCapabilityRegistry(),
    delegate: {
      async requestManual() {
        providerWrites.count += 1;
        throw new Error("Provider-local mutation must not be reached.");
      },
    },
    now: () => now,
  });

  await assert.rejects(
    manualImports.request({
      actor: {
        operatorId: "00000000-0000-4000-8000-000000000001",
        organizationId,
        role: "data_operator",
      },
      providerId,
      expectedSourceRevisionId: revisionId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSourceImportRequestError);
      assert.equal(error.code, "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE");
      return true;
    },
  );
  assert.equal(providerWrites.count, 0);
});
