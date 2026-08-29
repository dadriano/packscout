import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderSourceAdminCatalogRepository } from
  "./provider-source-admin-catalog-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("provider catalog reads clean V3 roots without legacy configuration revisions", async () => {
  const harness = await createMigratedTestDatabase();
  const organizationId = "71000000-0000-4000-8000-000000000001";
  const otherOrganizationId = "71000000-0000-4000-8000-000000000002";
  const providerId = "72000000-0000-4000-8000-000000000001";
  const otherProviderId = "72000000-0000-4000-8000-000000000002";
  const occurredAt = new Date("2026-08-28T04:15:00.000Z");
  try {
    await harness.client.organizations.createMany({
      data: [
        {
          id: organizationId,
          slug: "source-native-provider-catalog",
          name: "Source-native provider catalog",
        },
        {
          id: otherOrganizationId,
          slug: "other-source-native-provider-catalog",
          name: "Other source-native provider catalog",
        },
      ],
    });
    await harness.client.provider_sources.createMany({
      data: [
        {
          id: providerId,
          organization_id: organizationId,
          platform_key: "clutchpacks",
          display_name: "ClutchPacks",
          state: "draft",
          created_at: occurredAt,
          updated_at: occurredAt,
        },
        {
          id: otherProviderId,
          organization_id: otherOrganizationId,
          platform_key: "courtyard",
          display_name: "Courtyard",
          state: "active",
          created_at: occurredAt,
          updated_at: occurredAt,
        },
      ],
    });
    assert.equal(await harness.client.provider_config_revisions.count(), 0);

    const repository = new ProviderSourceAdminCatalogRepository(harness.client);
    assert.deepEqual(await repository.listProviders(organizationId), [{
      id: providerId,
      provider: "clutchpacks",
      displayName: "ClutchPacks",
      state: "draft",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }]);
    assert.deepEqual(
      await repository.getProvider(organizationId, providerId),
      {
        id: providerId,
        provider: "clutchpacks",
        displayName: "ClutchPacks",
        state: "draft",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    );
    assert.equal(
      await repository.getProvider(organizationId, otherProviderId),
      null,
    );
  } finally {
    await harness.close();
  }
});
