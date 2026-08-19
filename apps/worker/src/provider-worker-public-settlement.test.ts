import assert from "node:assert/strict";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createProviderWorkerPublicSettlementReader } from "./provider-worker-public-settlement.ts";

const publicOrganizationId = "54000000-0000-4000-8000-000000000001";

test("worker composition binds settlement reads to the configured public organization", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: publicOrganizationId,
        slug: "public-organization",
        name: "Public Organization",
      },
    });
    const settlement = createProviderWorkerPublicSettlementReader({
      database: harness.client,
      publicOrganizationId: publicOrganizationId.toUpperCase(),
    });
    const checkpoint = await settlement.getCheckpoint();
    assert.equal(checkpoint.organizationId, publicOrganizationId);
    assert.equal(checkpoint.settledSequence, 0n);
    assert.equal(checkpoint.sourceHeadSequence, 0n);
  } finally {
    await harness.close();
  }
});
