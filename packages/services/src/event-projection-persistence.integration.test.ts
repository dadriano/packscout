import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IngestionPersistenceRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import type {
  ProviderConfigurationIdentity,
  ProviderSourceIdentity,
  PullCandidate,
} from "./provider-adapter.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "./event-projection-service.ts";

const ids = {
  organization: "30000000-0000-4000-8000-000000000001",
  provider: "30000000-0000-4000-8000-000000000002",
  revision: "30000000-0000-4000-8000-000000000003",
  run: "30000000-0000-4000-8000-000000000004",
};
const source: ProviderSourceIdentity = {
  platform: "fixture",
  recordKind: "pull",
  recordIndex: 0,
  externalId: "pull-history-1",
  sourceTimestamp: "2026-08-06T10:00:00.000Z",
  collectedAt: "2026-08-06T10:01:00.000Z",
};
const configuration: ProviderConfigurationIdentity = {
  providerId: ids.provider,
  configurationRevisionId: ids.revision,
  platform: "fixture",
  adapterKey: "fixture-mapper-v1",
};

function candidate(amount: number): PullCandidate {
  return {
    candidateKind: "pull",
    source,
    relationships: [],
    dataQualityEvidence: [],
    packExternalId: "pack-late",
    assetExternalId: null,
    occurredAt: source.sourceTimestamp,
    value: { amount, currency: "usd" },
    valueSource: "provider_event",
    pseudonymizationInputs: [
      {
        role: "owner",
        namespace: "fixture-user",
        sourceIdentifier: "raw-user-must-not-persist-canonically",
      },
    ],
  };
}

test("event projections remain idempotent, preserve corrections, protect actors, and reconcile late packs", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: ids.organization,
      slug: "event-projection",
      name: "Event Projection",
    });
    await setup.createProviderSource({
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: "fixture",
      displayName: "Fixture",
    });
    await setup.createConfigRevision({
      id: ids.revision,
      organizationId: ids.organization,
      providerId: ids.provider,
      version: 1,
      adapterKey: "fixture-mapper-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:test",
    });
    await setup.createImportRun({
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      trigger: "scheduled",
    });
    const persistence = new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: new Uint8Array(32).fill(4),
    });
    const projector = new EventProjectionService(
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(5)),
    );

    const first = projector.project({
      configuration,
      source,
      candidates: [candidate(10)],
    });
    assert.equal(first.status, "accepted");
    if (first.status !== "accepted") return;
    const firstProjection = first.projections[0]!;
    const baseRecord = {
      recordKind: "pull" as const,
      recordIndex: 0,
      externalId: source.externalId,
      sourceTime: new Date(source.sourceTimestamp),
      collectedAt: new Date(source.collectedAt),
    };
    await persistence.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId: ids.run,
      pageNumber: 1,
      requestedCursor: null,
      nextCursor: "event-1",
      hasMore: true,
      payload: { page: 1 },
      records: [
        {
          ...baseRecord,
          payload: { value: 10, actor: "raw-user-must-not-persist-canonically" },
          projections: [firstProjection],
        },
      ],
      committedAt: new Date("2026-08-06T10:02:00.000Z"),
    });
    const current = await persistence.getCurrentProjection(ids.organization, {
      platformKey: "fixture",
      recordKind: "pull",
      externalId: source.externalId,
    });
    assert.ok(current);
    assert.equal(
      JSON.stringify(current).includes("raw-user-must-not-persist-canonically"),
      false,
    );
    assert.match(
      String((current.content.actorKeys as Record<string, string>).owner),
      /^actor:v1:/,
    );

    await persistence.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId: ids.run,
      pageNumber: 2,
      requestedCursor: "event-1",
      nextCursor: "event-2",
      hasMore: true,
      payload: { page: 2 },
      records: [
        {
          ...baseRecord,
          payload: { value: 10, actor: "raw-user-must-not-persist-canonically" },
          projections: [firstProjection],
        },
      ],
      committedAt: new Date("2026-08-06T10:03:00.000Z"),
    });
    assert.equal(
      (await persistence.listCanonicalRevisions(ids.organization, {
        platformKey: "fixture",
        recordKind: "pull",
        externalId: source.externalId,
      })).length,
      1,
    );

    await persistence.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId: ids.run,
      pageNumber: 3,
      requestedCursor: "event-2",
      nextCursor: "event-3",
      hasMore: true,
      payload: { page: 3 },
      records: [
        {
          recordKind: "catalog",
          recordIndex: 0,
          externalId: "pack-late",
          sourceTime: new Date("2026-08-06T10:04:00.000Z"),
          collectedAt: new Date("2026-08-06T10:04:30.000Z"),
          payload: { name: "Late Pack" },
          projections: [
            {
              platformKey: "fixture",
              recordKind: "pack",
              externalId: "pack-late",
              content: { name: "Late Pack" },
              sourceUpdatedAt: new Date("2026-08-06T10:04:00.000Z"),
              sourceCollectedAt: new Date("2026-08-06T10:04:30.000Z"),
            },
          ],
        },
      ],
      committedAt: new Date("2026-08-06T10:05:00.000Z"),
    });
    const relationship = await harness.database.canonical_relationships.findFirst({
      where: { target_external_id: "pack-late" },
      select: { target_entity_id: true },
    });
    assert.ok(relationship?.target_entity_id);
    assert.equal(
      await persistence.reconcileRelationships({
        organizationId: ids.organization,
        target: {
          platformKey: "fixture",
          recordKind: "pack",
          externalId: "pack-late",
        },
        resolvedAt: new Date("2026-08-06T10:06:00.000Z"),
      }),
      0,
    );

    const changed = projector.project({
      configuration,
      source,
      candidates: [candidate(11)],
    });
    assert.equal(changed.status, "accepted");
    if (changed.status !== "accepted") return;
    await persistence.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId: ids.run,
      pageNumber: 4,
      requestedCursor: "event-3",
      nextCursor: "event-head",
      hasMore: false,
      payload: { page: 4 },
      records: [
        {
          ...baseRecord,
          payload: { value: 11, actor: "raw-user-must-not-persist-canonically" },
          projections: changed.projections,
        },
      ],
      committedAt: new Date("2026-08-06T10:07:00.000Z"),
    });
    assert.equal(await harness.database.canonical_revisions.count(), 3);
    assert.equal(
      (await persistence.listCanonicalRevisions(ids.organization, {
        platformKey: "fixture",
        recordKind: "pull",
        externalId: source.externalId,
      })).length,
      2,
    );
  } finally {
    await harness.close();
  }
});
