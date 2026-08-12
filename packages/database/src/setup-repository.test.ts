import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistenceError } from "./persistence-error.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("Prisma setup fixtures preserve tenant scope and activation state", async () => {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  try {
    const organizationId = await setup.createOrganization({
      slug: "packscout",
      name: "PackScout",
    });
    const otherOrganizationId = await setup.createOrganization({
      slug: "other",
      name: "Other",
    });
    const providerId = await setup.createProviderSource({
      organizationId,
      platformKey: "fixture-provider",
      displayName: "Fixture Provider",
    });

    await assert.rejects(
      setup.createConfigRevision({
        organizationId: otherOrganizationId,
        providerId,
        version: 1,
        adapterKey: "fixture-v1",
        endpointUrl: "https://provider.example/feed",
        authMode: "none",
        createdByActorKey: "operator:fixture",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, "TENANT_SCOPE_VIOLATION");
        return true;
      },
    );

    const revisionId = await setup.createConfigRevision({
      organizationId,
      providerId,
      version: 1,
      adapterKey: "fixture-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "operator:fixture",
    });
    const checkpointInput = {
      organizationId,
      providerId,
      configRevisionId: revisionId,
    };
    assert.equal(await setup.getCursorCheckpoint(checkpointInput), undefined);

    const activatedAt = new Date();
    await assert.rejects(
      setup.activateConfiguration({
        organizationId,
        providerId,
        revisionId,
        actorKey: "operator:fixture",
        activatedAt,
        nextRunAt: new Date(activatedAt.getTime() + 60_000),
      }),
      (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, "CONFIG_REVISION_UNTESTED");
        return true;
      },
    );
    assert.equal(await setup.getCursorCheckpoint(checkpointInput), undefined);
    assert.equal(await harness.client.audit_events.count(), 0);

    await setup.recordSuccessfulConnectionTest({
      organizationId,
      providerId,
      revisionId,
      actorKey: "operator:fixture",
      testedAt: activatedAt,
      latencyMs: 42,
    });
    await setup.activateConfiguration({
      organizationId,
      providerId,
      revisionId,
      actorKey: "operator:fixture",
      activatedAt,
      nextRunAt: new Date(activatedAt.getTime() + 60_000),
    });
    assert.equal(await setup.getCursorCheckpoint(checkpointInput), null);
    assert.equal(
      await harness.client.audit_events.count({
        where: { organization_id: organizationId },
      }),
      1,
    );

    await assert.rejects(
      setup.createImportRun({
        organizationId,
        providerId,
        configRevisionId: revisionId,
        trigger: "manual",
      }),
      /requested actor key/,
    );
    const runId = await setup.createImportRun({
      organizationId,
      providerId,
      configRevisionId: revisionId,
      trigger: "manual",
      requestedByActorKey: "operator:fixture",
    });
    assert.equal(
      (await harness.client.import_runs.findUnique({ where: { id: runId } }))?.state,
      "queued",
    );
  } finally {
    await harness.close();
  }
});
