import assert from "node:assert/strict";
import test from "node:test";
import type { CentralQueryClient } from "./central-database.ts";
import { CentralAdminProviderRepository } from
  "./central-admin-provider-repository.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const configVersionId = "00000000-0000-4000-8000-000000000021";
const now = new Date("2026-08-29T12:00:00.000Z");

function rootRow() {
  return {
    id: providerId,
    provider_key: "clutchpacks",
    display_name: "ClutchPacks",
    lifecycle: "active" as const,
    created_at: new Date("2026-08-20T00:00:00.000Z"),
    updated_at: new Date("2026-08-29T00:00:00.000Z"),
  };
}

function admissionRow(input: Readonly<{
  lifecycle?: "draft" | "active" | "disabled" | "archived";
  activeConfigVersionId?: string | null;
  expiresAt?: Date | null;
}> = {}) {
  const activeConfigVersionId = input.activeConfigVersionId === undefined
    ? configVersionId
    : input.activeConfigVersionId;
  return {
    id: providerId,
    provider_key: "clutchpacks",
    lifecycle: input.lifecycle ?? "active",
    active_config_version_id: activeConfigVersionId,
    active_config_version: activeConfigVersionId === null
      ? null
      : {
          id: activeConfigVersionId,
          version_number: 1n,
          adapter_key: "local-capture-clutchpacks-v1",
          configuration: { captureDirectory: "clutchpacks" },
          schedule_seconds: 300,
          expires_at: input.expiresAt ?? null,
        },
  };
}

test("central provider list and detail preserve the authoritative browser DTO inputs", async () => {
  const queries: unknown[] = [];
  const client = {
    providers: {
      async findMany(query: unknown) {
        queries.push(query);
        return [rootRow()];
      },
      async findUnique(query: unknown) {
        queries.push(query);
        return rootRow();
      },
    },
  } as unknown as CentralQueryClient;
  const repository = new CentralAdminProviderRepository(client);

  assert.deepEqual(await repository.listProviders(organizationId), [{
    id: providerId,
    provider: "clutchpacks",
    displayName: "ClutchPacks",
    state: "active",
    createdAt: rootRow().created_at,
    updatedAt: rootRow().updated_at,
  }]);
  assert.equal(
    (await repository.getProvider(organizationId, providerId))?.provider,
    "clutchpacks",
  );
  assert.deepEqual(
    (queries[0] as { where: unknown }).where,
    { organization_id: organizationId },
  );
  assert.deepEqual(
    (queries[1] as { where: unknown }).where,
    {
      id_organization_id: {
        id: providerId,
        organization_id: organizationId,
      },
    },
  );
});

test("central import admission binds organization, provider, active config, and expiry", async () => {
  let row: ReturnType<typeof admissionRow> | null = admissionRow();
  const client = {
    providers: {
      async findUnique() {
        return row;
      },
    },
  } as unknown as CentralQueryClient;
  const repository = new CentralAdminProviderRepository(client);
  const input = {
    organizationId,
    providerId,
    expectedConfigVersionId: configVersionId,
    now,
  };

  assert.deepEqual(await repository.resolveImportAdmission(input), {
    kind: "ready",
    providerId,
    providerKey: "clutchpacks",
    adapterKey: "local-capture-clutchpacks-v1",
    configVersionId,
    configVersionNumber: 1n,
    configuration: { captureDirectory: "clutchpacks" },
    configExpiresAt: null,
    scheduleSeconds: 300,
  });

  row = admissionRow({ lifecycle: "disabled" });
  assert.deepEqual(await repository.resolveImportAdmission(input), {
    kind: "source_unavailable",
  });

  row = admissionRow({ expiresAt: now });
  assert.deepEqual(await repository.resolveImportAdmission(input), {
    kind: "source_unavailable",
  });

  row = admissionRow({
    activeConfigVersionId: "00000000-0000-4000-8000-000000000099",
  });
  assert.deepEqual(await repository.resolveImportAdmission(input), {
    kind: "revision_conflict",
    activeConfigVersionId: "00000000-0000-4000-8000-000000000099",
  });

  row = null;
  assert.deepEqual(await repository.resolveImportAdmission(input), {
    kind: "not_found",
  });
});
