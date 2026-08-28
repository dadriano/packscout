import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_OBSERVATION_CONTRACT_VERSION } from "@packscout/contracts";
import { ProviderSourceLifecycleRepository } from
  "./provider-source-lifecycle-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import {
  PrismaSourceRelationshipConfirmationBackfillRepository,
} from "./source-relationship-confirmation-backfill-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "57000000-0000-4000-8000-000000000001";
const clutchpacksProviderId = "57000000-0000-4000-8000-000000000010";
const unrelatedProviderId = "57000000-0000-4000-8000-000000000011";
const at = new Date(Math.floor(Date.now() / 1_000) * 1_000);

test("platform-scoped confirmation repair excludes unrelated provider revisions and aggregates proof", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.client);
    await setup.createOrganization({
      id: organizationId,
      slug: "clutch-canary-confirmations",
      name: "Clutch canary confirmations",
      createdAt: at,
    });
    await Promise.all([
      setup.createProviderSource({
        id: clutchpacksProviderId,
        organizationId,
        platformKey: "clutchpacks",
        displayName: "ClutchPacks",
        createdAt: at,
      }),
      setup.createProviderSource({
        id: unrelatedProviderId,
        organizationId,
        platformKey: "courtyard",
        displayName: "Unrelated provider",
        createdAt: at,
      }),
    ]);
    const lifecycle = new ProviderSourceLifecycleRepository(harness.client);
    const connection = await lifecycle.createConnectionProfileRevision({
      organizationId,
      sourceTypeKey: "dataforrest-events-v1",
      connectionTypeKey: "dataforrest-events-connection-v1",
      displayName: "Canary confirmation fixture",
      requestLimit: 1,
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      revisionNumber: 1,
      configurationCiphertext: new Uint8Array(32).fill(1),
      configurationNonce: new Uint8Array(12).fill(2),
      configurationAuthTag: new Uint8Array(16).fill(3),
      encryptionKeyVersion: 1,
      configurationFingerprint: "a".repeat(64),
      actorKey: "operator:canary-test",
      createdAt: at,
    });
    const createRevision = (
      providerId: string,
      revisionNumber: number,
      configurationHash: string,
    ) => lifecycle.createSourceInstanceRevision({
      organizationId,
      providerId,
      connectionProfileId: connection.profileId,
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      mapperKey: "canary-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: `canary-records-${revisionNumber}`,
      cursorCodecVersion: "dataforrest-cursor-v1",
      revisionNumber: 1,
      intervalSeconds: 60,
      configuration: { revisionNumber },
      configurationHash,
      recordIdScopes: ["pull-v1"],
      actorKey: "operator:canary-test",
      createdAt: at,
    });
    const [firstClutch, secondClutch, unrelated] = await Promise.all([
      createRevision(clutchpacksProviderId, 1, "b".repeat(64)),
      createRevision(clutchpacksProviderId, 2, "c".repeat(64)),
      createRevision(unrelatedProviderId, 3, "d".repeat(64)),
    ]);

    await harness.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "alter table public.source_relationship_confirmation_backfills disable trigger user",
      );
      try {
        for (const [sourceRevisionId, target] of [
          [firstClutch.sourceRevisionId, 2n],
          [secondClutch.sourceRevisionId, 3n],
        ] as const) {
          await transaction.source_relationship_confirmation_backfills.update({
            where: {
              organization_id_source_revision_id: {
                organization_id: organizationId,
                source_revision_id: sourceRevisionId,
              },
            },
            data: {
              target_semantic_set_count: target,
              confirmed_semantic_set_count: target,
            },
          });
        }
        await transaction.source_relationship_confirmation_backfills.update({
          where: {
            organization_id_source_revision_id: {
              organization_id: organizationId,
              source_revision_id: unrelated.sourceRevisionId,
            },
          },
          data: {
            phase: "pending",
            target_semantic_set_count: 1n,
            confirmed_semantic_set_count: 0n,
            started_at: null,
            completed_at: null,
          },
        });
      } finally {
        await transaction.$executeRawUnsafe(
          "alter table public.source_relationship_confirmation_backfills enable trigger user",
        );
      }
    });

    const scoped = new PrismaSourceRelationshipConfirmationBackfillRepository(
      harness.client,
      {
        organizationId,
        actorPseudonymKey: "canary-test-key",
        platformKeys: ["clutchpacks"],
        resolver: {
          resolvePullProjection() {
            throw new Error("A completed scoped checkpoint must not resolve.");
          },
        },
      },
    );
    const progress = await scoped.runToCompletion({ batchSize: 1 });
    const coverage = await scoped.loadCoverage();
    assert.equal(progress.phase, "complete");
    assert.deepEqual(coverage, {
      sourceRevisionCount: 2n,
      completeSourceRevisionCount: 2n,
      targetSemanticSetCount: 5n,
      confirmedSemanticSetCount: 5n,
      ready: true,
    });
    const unrelatedCheckpoint = await harness.client
      .source_relationship_confirmation_backfills.findUniqueOrThrow({
        where: {
          organization_id_source_revision_id: {
            organization_id: organizationId,
            source_revision_id: unrelated.sourceRevisionId,
          },
        },
      });
    assert.equal(unrelatedCheckpoint.phase, "pending");
    assert.equal(unrelatedCheckpoint.confirmed_semantic_set_count, 0n);
  } finally {
    await harness.close();
  }
});
